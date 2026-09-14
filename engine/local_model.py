# -*- coding: utf-8 -*-
"""本地大模型（离线翻译）：以子进程方式运行 llama.cpp 的 llama-server。

支持任意 GGUF 模型；针对翻译专用模型（如腾讯混元 Hy-MT2-1.8B）使用其官方
提示词模板与采样参数（参考 OcrTransDesktop/translator.py 的已验证配置）。

调用方只提供两个本地路径：模型文件（.gguf）与 llama-server 可执行文件；
未指定可执行文件时会在若干常见位置自动查找。
"""
from __future__ import annotations

import logging
import subprocess
import sys
import time
from pathlib import Path

import requests

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8818

# 混元 Hy-MT 系列的官方模板（无 system 提示词）
BOS = "<｜hy_begin▁of▁sentence｜>"
USER_TAG = "<｜hy_User｜>"
ASSISTANT_TAG = "<｜hy_Assistant｜>"


def _creation_flags() -> int:
    return 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


def find_server_exe(explicit: str | None = None) -> Path | None:
    """定位 llama-server：显式路径优先，其次常见位置。"""
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    here = Path(__file__).resolve().parent
    candidates += [
        here / "bin" / "llama-server.exe",
        here / "bin" / "llama-server",
        Path("E:/core/tools/tongming/OcrTransDesktop/bin/llama-server.exe"),
        Path.home() / "llama.cpp" / "llama-server.exe",
    ]
    for c in candidates:
        try:
            if c.is_file():
                return c
        except OSError:
            continue
    return None


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
        self.port = DEFAULT_PORT
        self.model_path: Path | None = None
        self.server_path: Path | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------- 生命周期

    def is_ready(self) -> bool:
        try:
            return (
                self.proc is not None
                and self.proc.poll() is None
                and requests.get(f"http://127.0.0.1:{self.port}/health", timeout=1).status_code == 200
            )
        except requests.RequestException:
            return False

    def start(
        self,
        model_path: str,
        server_path: str | None = None,
        port: int = DEFAULT_PORT,
        ctx: int = 2048,
        threads: int = 4,
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
        self.stop()
        self.proc = subprocess.Popen(
            [
                str(exe), "-m", str(model),
                "--port", str(port), "-c", str(ctx), "-t", str(threads),
                "--no-webui", "--threads-http", "2",
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
                    logger.info("local model ready: %s (port %d)", model.name, port)
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
        return {
            "running": self.proc is not None and self.proc.poll() is None,
            "ready": ready,
            "pid": self.proc.pid if self.proc is not None else None,
            "port": self.port,
            "model": self.model_path.name if self.model_path else None,
            "modelPath": str(self.model_path) if self.model_path else None,
            "serverPath": str(self.server_path) if self.server_path else None,
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
