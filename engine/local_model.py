# -*- coding: utf-8 -*-
"""本地大模型（离线翻译）：以子进程方式运行 llama.cpp 的 llama-server。

支持任意 GGUF 模型；针对翻译专用模型（如腾讯混元 Hy-MT2-1.8B）使用其官方
提示词模板与采样参数（参考 OcrTransDesktop/translator.py 的已验证配置）。

调用方只提供两个本地路径：模型文件（.gguf）与 llama-server 可执行文件；
未指定可执行文件时会在若干常见位置自动查找。
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8818

# 并发槽位（llama-server 的 --parallel）。
# 小模型推理是内存带宽受限的：把一页的段落串行喂给它，吞吐只有 ~16 tok/s；
# 4 个槽 + 4 路并发请求能到 ~37 tok/s（实测单页 20s → 9s），因为多序列
# 才把内存带宽吃满。改成单槽串行只会更慢。
PARALLEL_SLOTS = 4

# 每槽 2048 上下文 × 4 槽；段落提示词最多 3000 字符，绰绰有余
DEFAULT_CTX = 2048 * PARALLEL_SLOTS


# 全量卸载到显卡。1.8B Q4 + 8k 上下文在 8GB 显存上绰绰有余
GPU_LAYERS_ALL = 99

# llama.cpp 的 --list-devices 会打印 "  Vulkan0: NVIDIA GeForce RTX 2060 SUPER (...)"
_DEVICE_RE = re.compile(r"^\s*((?:CUDA|Vulkan|Metal|SYCL|HIP|OpenCL|RPC)\d*):\s*(.+?)\s*$", re.M)


def probe_gpu_devices(exe: Path) -> list[str]:
    """列出这个 llama-server 能用的 GPU 设备。

    CPU-only 构建会返回空列表（`--list-devices` 显示 "(none)"），
    带 CUDA/Vulkan 后端的构建会列出显卡——据此决定要不要传 -ngl 做层卸载。
    """
    try:
        out = subprocess.run(
            [str(exe), "--list-devices"],
            capture_output=True, text=True, timeout=30,
            creationflags=_creation_flags(),
        )
    except (OSError, subprocess.SubprocessError) as err:
        logger.warning("探测 llama-server 设备失败：%s", err)
        return []
    return [f"{m.group(1)}: {m.group(2)}" for m in _DEVICE_RE.finditer(out.stdout or "")]


def default_threads() -> int:
    """默认线程数。

    实测（8 物理核 / 16 逻辑核）：单流时 -t 4 最快（18.3 tok/s），-t 12 反而掉到
    11.3 tok/s——带宽吃满后加线程只增加争抢；但配上 --parallel 4 后 -t 8 总体更好
    （单页 9.1s / 6 页 48s vs -t 4 的 11.1s / 59s）。所以取"逻辑核数一半"并夹在 4~8。
    """
    logical = os.cpu_count() or 4
    return max(4, min(8, logical // 2))

# 混元 Hy-MT 系列的官方模板（无 system 提示词）
BOS = "<｜hy_begin▁of▁sentence｜>"
USER_TAG = "<｜hy_User｜>"
ASSISTANT_TAG = "<｜hy_Assistant｜>"


def _creation_flags() -> int:
    return 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


def _backend_variants(exe: Path) -> list[Path]:
    """同一个 llama.cpp 分发里常见的后端目录（bin / bin-vulkan / bin-cuda …）。

    大家常把 CPU 版和 GPU 版解压成兄弟目录，这里把它们也纳入候选：
    机器上有显卡就自动用上 GPU 版，不用手动改配置。
    """
    parent = exe.parent
    out: list[Path] = []
    for tag in ("bin-vulkan", "bin-cuda", "bin-rocm", "bin-sycl", "bin-metal", "bin-gpu",
                "vulkan", "cuda"):
        for root in (parent.parent / tag, parent / tag):
            cand = root / exe.name
            try:
                if cand.is_file():
                    out.append(cand)
            except OSError:
                continue
    return out


def find_server_exe(explicit: str | None = None) -> Path | None:
    """定位 llama-server，并在候选里优先挑「能认出显卡」的那个。

    显式指定就按用户说的用（不自作主张换后端）；没指定时在常见位置里找，
    并把带 GPU 后端的兄弟目录一并纳入——这样机器有显卡时会自动切到 GPU 后端。
    """
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    here = Path(__file__).resolve().parent
    # 引擎自带运行时优先（engine/bin 与 engine/bin-vulkan，见其中的 README）；
    # 不再硬编码别的项目目录——那种依赖会让本项目在别处直接失效
    candidates += [
        here / "bin" / "llama-server.exe",
        here / "bin" / "llama-server",
    ]
    existing: list[Path] = []
    for c in candidates:
        try:
            if c.is_file():
                existing.append(c)
        except OSError:
            continue
    if not existing:
        return None
    if explicit:
        return existing[0]

    expanded = list(existing)
    for exe in existing:
        expanded += _backend_variants(exe)
    # 引擎目录下的后端变体也纳入候选（比如把 GPU 版解压成 engine/bin-vulkan/）——
    # 即使 engine/bin/ 还不存在也要能找到
    expanded += _backend_variants(here / "bin" / "llama-server.exe")
    for exe in expanded:
        if probe_gpu_devices(exe):
            if exe != existing[0]:
                logger.info("自动选用带 GPU 后端的 llama-server：%s", exe)
            return exe
    return existing[0]


_ECHO_PREFIXES = ("请严格使用以下术语对照", "术语对照（务必遵守）", "将以下文本翻译为", "只输出译文")


def _strip_instruction_echo(text: str) -> str:
    """小模型偶发把指令里的术语表当成待译文本输出，这里做防御性清理。"""
    lines = [ln for ln in text.splitlines() if not ln.strip().startswith(_ECHO_PREFIXES)]
    cleaned = "\n".join(lines).strip()
    return cleaned or text.strip()


def build_prompt(text: str, target_lang: str, glossary: list[tuple[str, str]] | None = None) -> str:
    """按官方模板构造提示词；术语表以"术语对照"形式并入指令。"""
    clipped = text[:3000]
    head = ""
    if glossary:
        pairs = "；".join(f"{src} → {tgt}" for src, tgt in glossary[:40])
        head = f"术语对照（务必遵守）：{pairs}。\n"
    instruction = f"{head}将以下文本翻译为{target_lang}，只输出译文，不要额外解释。\n\n"
    return f"{BOS}{USER_TAG}{instruction}{clipped}{ASSISTANT_TAG}"


class LocalModel:
    """llama-server 子进程管理 + 推理调用（单实例）。"""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        # 同时在飞的生成不超过槽位数：多出来的在这里排队，
        # 免得把 llama-server 塞成一堆互相拖慢的等待序列
        self.slots = threading.Semaphore(PARALLEL_SLOTS)
        self.gpu_devices: list[str] = []
        self.gpu_layers = 0
        self.suggested_server: str | None = None
        self.port = DEFAULT_PORT
        self.model_path: Path | None = None
        self.server_path: Path | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------- 生命周期

    def is_ready(self) -> bool:
        """端口上有健康的 llama-server 就算就绪。

        不要求"必须是自己拉起的"：同一个模型可能已经被别的实例跑起来了
        （同门的 OcrTransDesktop 用的也是 8818 与同一份 Hy-MT2），
        这时如实报就绪并直接复用，比谎报未就绪、再往同一个端口塞第二份
        2GB 模型要合理。自己拉的那个若已退出，顺手清掉记录。
        """
        if self.proc is not None and self.proc.poll() is not None:
            self.proc = None
        try:
            return requests.get(
                f"http://127.0.0.1:{self.port}/health", timeout=1
            ).status_code == 200
        except requests.RequestException:
            return False

    def owns_running_server(self) -> bool:
        """当前就绪的模型是不是本进程拉起的（决定能不能由我们停掉）"""
        return self.proc is not None and self.proc.poll() is None

    def start(
        self,
        model_path: str,
        server_path: str | None = None,
        port: int = DEFAULT_PORT,
        ctx: int = DEFAULT_CTX,
        threads: int | None = None,
        parallel: int = PARALLEL_SLOTS,
        gpu_layers: int | None = None,
        timeout: float = 300.0,
    ) -> dict:
        model = Path(model_path)
        if not model.is_file():
            raise FileNotFoundError(f"未找到模型文件：{model_path}")
        exe = find_server_exe(server_path)
        if exe is None:
            raise FileNotFoundError(
                "未找到 llama-server 可执行文件，请在选择模型后一并指定它的路径。"
            )

        self.port = port
        self.model_path = model
        self.server_path = exe
        self.last_error = None
        threads = threads or default_threads()

        # 后端与层卸载：默认"有 GPU 设备就全部卸载"，用户可显式传 0 强制 CPU
        self.gpu_devices = probe_gpu_devices(exe)
        self.gpu_layers = (
            gpu_layers if gpu_layers is not None
            else (GPU_LAYERS_ALL if self.gpu_devices else 0)
        )
        # 当前这个 exe 用不了显卡时，看看别处有没有能用的（自带 bin-vulkan / ~/llama.cpp），
        # 有就在状态里报出来，界面上给个一键切换——不偷偷替用户改路径
        self.suggested_server: str | None = None
        if not self.gpu_devices:
            for cand in _backend_variants(exe) + _backend_variants(Path(__file__).resolve().parent / "bin" / "llama-server.exe"):
                if cand != exe and probe_gpu_devices(cand):
                    self.suggested_server = str(cand)
                    break
        # 端口上已有健康的 llama-server 就直接用：同一端口塞第二份 2GB 模型
        # 只会互相抢连接。此时不认领它（owned=false），退出时也不会去杀它。
        if self.is_ready() and not self.owns_running_server():
            logger.info("端口 %d 已有可用的 llama-server，复用而不重复加载模型", port)
            return self.status()
        self.stop()
        self.proc = subprocess.Popen(
            [
                str(exe), "-m", str(model),
                "--port", str(port), "-c", str(ctx), "-t", str(threads),
                "--parallel", str(parallel),
                *(["-ngl", str(self.gpu_layers)] if self.gpu_layers else []),
                "--no-webui", "--threads-http", str(max(2, parallel)),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=_creation_flags(),
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                # 常见于显存不够：全量卸载起不来。自动退回纯 CPU 再试一次，
                # 并把原因留在状态里，而不是直接失败让用户自己猜。
                if self.gpu_layers:
                    logger.warning("GPU 卸载启动失败（显存不足？），回退到 CPU 重试")
                    return self._restart_cpu_only(model, exe, port, ctx, threads, parallel, timeout)
                self.last_error = "llama-server 进程异常退出（模型文件损坏或与该构建不兼容）"
                raise RuntimeError(self.last_error)
            try:
                if requests.get(f"http://127.0.0.1:{port}/health", timeout=2).status_code == 200:
                    logger.info("local model ready: %s (port %d)", model.name, port)
                    return self.status()
            except requests.RequestException:
                pass
            time.sleep(0.5)
        self.stop()
        self.last_error = "llama-server 启动超时（模型较大时可适当放宽等待时间）"
        raise TimeoutError(self.last_error)

    def _restart_cpu_only(
        self,
        model: Path,
        exe: Path,
        port: int,
        ctx: int,
        threads: int,
        parallel: int,
        timeout: float,
    ) -> dict:
        """GPU 卸载起不来时退回纯 CPU 重试（显存不够是最常见原因）。"""
        gpu_note = "GPU 卸载启动失败，已回退到 CPU"
        self.gpu_layers = 0
        self.last_error = None
        self.stop()
        self.proc = subprocess.Popen(
            [
                str(exe), "-m", str(model),
                "--port", str(port), "-c", str(ctx), "-t", str(threads),
                "--parallel", str(parallel),
                "--no-webui", "--threads-http", str(max(2, parallel)),
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=_creation_flags(),
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                self.last_error = "llama-server 进程异常退出（模型文件损坏或与该构建不兼容）"
                raise RuntimeError(self.last_error)
            try:
                if requests.get(f"http://127.0.0.1:{port}/health", timeout=2).status_code == 200:
                    logger.warning(gpu_note)
                    self.last_error = gpu_note
                    return self.status()
            except requests.RequestException:
                pass
            time.sleep(0.5)
        self.stop()
        self.last_error = "llama-server 启动超时（模型较大时可适当放宽等待时间）"
        raise TimeoutError(self.last_error)

    def stop(self) -> dict:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None
        return self.status()

    def status(self) -> dict:
        ready = self.is_ready()
        owned = self.owns_running_server()
        return {
            "running": owned,
            "ready": ready,
            # 就绪但不是我们拉起的 → 复用了外部实例，"停止"按钮管不了它
            "owned": owned,
            "pid": self.proc.pid if self.proc is not None else None,
            "port": self.port,
            "model": self.model_path.name if self.model_path else None,
            "modelPath": str(self.model_path) if self.model_path else None,
            "serverPath": str(self.server_path) if self.server_path else None,
            # 推理后端：设备列表 + 实际卸载的层数（0 = 纯 CPU）
            "gpuDevices": list(getattr(self, "gpu_devices", []) or []),
            "gpuLayers": int(getattr(self, "gpu_layers", 0) or 0),
            "device": (self.gpu_devices[0] if getattr(self, "gpu_devices", None) and self.gpu_layers
                       else "CPU"),
            # 当前 exe 不支持显卡、但发现了别的 GPU 版时给出建议路径（界面一键切换用）
            "suggestedServerPath": getattr(self, "suggested_server", None),
            "error": self.last_error,
        }

    # --------------------------------------------------------------- 推理

    def translate(
        self,
        text: str,
        target_lang: str,
        glossary: list[tuple[str, str]] | None = None,
        timeout: float = 600.0,
    ) -> str:
        if not self.is_ready():
            raise RuntimeError("本地模型未就绪，请先启动。")
        resp = requests.post(
            f"http://127.0.0.1:{self.port}/completion",
            json={
                "prompt": build_prompt(text, target_lang, glossary),
                "n_predict": 1024,
                "temperature": 0.7,
                "top_p": 0.6,
                "top_k": 20,
                "repeat_penalty": 1.05,
                "seed": 42,
                "cache_prompt": True,
                "stream": False,
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        return _strip_instruction_echo(str(resp.json().get("content", "")))


local_model = LocalModel()
