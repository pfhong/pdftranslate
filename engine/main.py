# -*- coding: utf-8 -*-
"""Transfer Reader 翻译引擎：本地 HTTP 服务（FastAPI）。

端点：
  GET  /health     健康检查与能力信息
  POST /extract    PDF bytes → 版面段落块（文本层 / PP-OCRv6 自动选择）
  POST /synthesize JSON {pdf_b64, translations} → 译制 PDF bytes

启动：python -m uvicorn engine.main:app --host 127.0.0.1 --port 8765
"""
from __future__ import annotations

import base64
import logging
import re
from pathlib import Path

import fitz
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import BUILD, __version__, compute_build
from . import glossary_store
from . import parent_watch
from .layout import extract_pages, get_ocr
from .synthesize import synthesize

logger = logging.getLogger(__name__)

app = FastAPI(title="Transfer Reader Engine", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _stop_local_model() -> None:
    from .local_model import local_model

    local_model.stop()


# 由桌面应用拉起时（带 TR_PARENT_PID）启用父进程守望：应用一退出就一起退出，
# 顺带关掉本地模型（llama-server 是引擎的子进程，不管它会留下孤儿）。
# 手动启动不带该变量，守望不启用——那是开发者自己的进程，应用不该插手。
parent_watch.start_from_env(on_exit=_stop_local_model)


@app.get("/health")
def health() -> dict:
    ocr = get_ocr()
    # 进程内指纹 vs 磁盘指纹：不一致说明这个常驻进程跑的是旧代码（应用重启不会
    # 重拉已占用端口的旧实例，前端据此提示用户重启引擎）
    on_disk = compute_build()
    return {
        "ok": True,
        "engine": "python",
        "version": __version__,
        "build": BUILD,
        "buildOnDisk": on_disk,
        "stale": on_disk != BUILD,
        "ocr": ocr is not None,
    }


@app.post("/extract")
async def extract(request: Request, force_ocr: bool = False) -> JSONResponse:
    pdf_bytes = await request.body()
    if not pdf_bytes:
        return JSONResponse({"error": "empty body"}, status_code=400)
    try:
        result = extract_pages(pdf_bytes, force_ocr=force_ocr)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"error": f"{type(err).__name__}: {err}"}, status_code=500)
    # 留存最后一轮产物，便于核查实际输出
    try:
        import base64 as _b64
        import tempfile as _tmp
        from pathlib import Path as _Path

        keep = _Path(_tmp.gettempdir()) / "tr-engine-last"
        keep.mkdir(parents=True, exist_ok=True)
        for key in ("mono", "dual"):
            if result.get(key):
                (keep / f"{key}.pdf").write_bytes(_b64.b64decode(result[key]))
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse(result)


@app.post("/synthesize")
async def synthesize_endpoint(request: Request) -> Response:
    payload = await request.json()
    try:
        pdf_bytes = base64.b64decode(payload["pdf"])
        translations = payload.get("translations", [])
        if not pdf_bytes:
            return JSONResponse({"error": "empty pdf"}, status_code=400)
        out = synthesize(
            pdf_bytes,
            translations,
            font_path=payload.get("fontPath"),
        )
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"error": f"{type(err).__name__}: {err}"}, status_code=500)
    return Response(content=out, media_type="application/pdf")


@app.get("/translate_progress")
def translate_progress() -> dict:
    """当前 BabelDOC 翻译任务进度（前端轮询）。"""
    from .babeldoc_route import get_progress

    return get_progress()


@app.post("/translate_babeldoc")
async def translate_babeldoc(request: Request) -> JSONResponse:
    """整本翻译：BabelDOC 完整管线（YOLO 版面 + 字符级重排），返回 mono/dual PDF。

    翻译是长任务且为同步代码，放到线程池执行，避免阻塞事件循环
    （否则 /health 也会无响应）。
    """
    import asyncio
    import traceback

    payload = await request.json()
    try:
        from .babeldoc_route import translate_pdf

        pdf_bytes = base64.b64decode(payload["pdf"])
        if not pdf_bytes:
            return JSONResponse({"error": "empty pdf"}, status_code=400)
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: translate_pdf(
                pdf_bytes,
                lang_in=payload.get("langIn", "en"),
                lang_out=payload.get("langOut", "zh"),
                base_url=payload["baseUrl"],
                api_key=payload["apiKey"],
                model=payload["model"],
                target_lang_name=payload.get("targetLangName"),
                no_dual=payload.get("noDual", False),
                no_mono=payload.get("noMono", False),
                pages=payload.get("pages"),
                qps=int(payload.get("qps", 4)),
                ocr_workaround=payload.get("ocrWorkaround"),
                force_rebuild=payload.get("forceRebuild", False),
                use_glossary=payload.get("useGlossary", True),
            ),
        )
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        return JSONResponse(
            {"error": f"{type(err).__name__}: {err}"},
            status_code=500,
        )
    # 留存最后一轮产物，便于核查实际输出
    try:
        import base64 as _b64
        import tempfile as _tmp
        from pathlib import Path as _Path

        keep = _Path(_tmp.gettempdir()) / "tr-engine-last"
        keep.mkdir(parents=True, exist_ok=True)
        for key in ("mono", "dual"):
            if result.get(key):
                (keep / f"{key}.pdf").write_bytes(_b64.b64decode(result[key]))
    except Exception:  # noqa: BLE001
        pass
    return JSONResponse(result)


# ----------------------------------------------------------------- 术语表

@app.get("/glossary")
def glossary_get() -> dict:
    entries = glossary_store.load_entries()
    return {"entries": entries, "count": len(entries)}


@app.put("/glossary")
async def glossary_put(request: Request) -> dict:
    payload = await request.json()
    entries = payload.get("entries", [])
    if not isinstance(entries, list):
        return JSONResponse({"error": "entries must be a list"}, status_code=400)
    return {"count": glossary_store.save_entries(entries)}


@app.post("/glossary/active")
async def glossary_active(request: Request) -> dict:
    """返回给定文本中命中的术语（前端按批注入提示词）。"""
    payload = await request.json()
    text = payload.get("text", "")
    target_lang = payload.get("targetLang")
    entries = glossary_store.active_entries(text, target_lang)
    return {"entries": entries, "count": len(entries)}


@app.post("/glossary/import")
async def glossary_import(request: Request) -> dict:
    """导入 CSV（source,target[,target_language]）；mode=replace|merge。"""
    body = (await request.body()).decode("utf-8-sig", errors="ignore")
    mode = request.query_params.get("mode", "merge")
    incoming = glossary_store.parse_csv(body)
    if mode == "replace":
        return {"count": glossary_store.save_entries(incoming)}
    merged = glossary_store.load_entries() + incoming
    return {"count": glossary_store.save_entries(merged)}


@app.get("/glossary/export")
def glossary_export() -> Response:
    return Response(
        content=glossary_store.to_csv(glossary_store.load_entries()),
        media_type="text/csv; charset=utf-8",
    )


# --------------------------------------------------------- 本地模型（离线）

@app.get("/local_model/status")
def local_model_status() -> dict:
    from .local_model import local_model

    return local_model.status()


@app.post("/local_model/start")
async def local_model_start(request: Request) -> JSONResponse:
    """启动本地 llama.cpp 服务：只需提供模型文件（.gguf）路径。"""
    import asyncio
    import traceback

    from .local_model import local_model

    payload = await request.json()
    model_path = str(payload.get("modelPath") or "").strip()
    if not model_path:
        return JSONResponse({"error": "缺少模型文件路径"}, status_code=400)
    # 只传调用方明确给的值，其余用 local_model 里的默认值——
    # 上下文/线程/并发槽位是按实测选的，别在这里写死把它们覆盖掉
    # （曾因这里写死 -c 2048 配 4 槽，每槽只剩 512，长段落会被截断）
    kwargs: dict = {}
    for key, cast in (("port", int), ("ctx", int), ("threads", int), ("timeout", float)):
        if payload.get(key) is not None:
            kwargs[key] = cast(payload[key])
    # gpuLayers: 不传 = 自动（有 GPU 设备就全部卸载）；0 = 强制纯 CPU
    if payload.get("gpuLayers") is not None:
        kwargs["gpu_layers"] = int(payload["gpuLayers"])
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: local_model.start(
                model_path,
                server_path=(payload.get("serverPath") or None),
                **kwargs,
            ),
        )
    except Exception as err:  # noqa: BLE001
        traceback.print_exc()
        return JSONResponse({"error": f"{type(err).__name__}: {err}"}, status_code=500)
    return JSONResponse(result)


@app.post("/local_model/stop")
async def local_model_stop() -> JSONResponse:
    from .local_model import local_model

    return JSONResponse(local_model.stop())


def _extract_glossary_from_system(system_text: str) -> list[tuple[str, str]]:
    """从系统提示词里的术语表格中提取（源词, 目标词）。"""
    pairs: list[tuple[str, str]] = []
    for line in (system_text or "").splitlines():
        line = line.strip()
        if not line.startswith("| ") or "Source Term" in line or "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) >= 2 and cells[0] and cells[1]:
            pairs.append((cells[0], cells[1]))
    return pairs


# 目标语言只出现在系统提示词里：OpenAI 协议本身没有"目标语言"这个字段，
# 所以前端把语言写进了提示词文案（见 src/lib/translate.ts 的 systemPrompt /
# batchSystemPrompt）。两边的措辞是一份约定，改文案必须同步改这里。
_TARGET_LANG_PATTERNS = (
    re.compile(r"把用户给出的内容翻译为(.+?)[。\n]"),
    re.compile(r"请将每段翻译为(.+?)[。\n]"),
    re.compile(r"翻译为(.+?)[。\n]"),
)


def _extract_target_lang(system_text: str) -> str | None:
    """从系统提示词里解析目标语言；解析不出返回 None 由调用方兜底。"""
    for pattern in _TARGET_LANG_PATTERNS:
        matched = pattern.search(system_text or "")
        if matched:
            lang = matched.group(1).strip()
            if lang:
                return lang
    return None


@app.post("/local/v1/chat/completions")
async def local_chat_completions(request: Request) -> JSONResponse:
    """OpenAI 兼容代理：前端与既有管线无需改动即可使用本地模型。

    适配点：
    - 把 OpenAI 风格消息转成 Hy-MT 官方提示词模板；
    - 识别批量协议（<1><2>…）：逐个翻译再按编号回填，避免小模型批量出错；
    - 系统提示词中的术语表转为"术语对照"注入。
    """
    import asyncio
    import re

    from .local_model import local_model

    payload = await request.json()
    messages = payload.get("messages") or []
    system_text = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
    user_text = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
    if not isinstance(user_text, str) or not user_text.strip():
        return JSONResponse({"error": "empty user message"}, status_code=400)
    if not local_model.status()["ready"]:
        return JSONResponse({"error": "本地模型未就绪，请先在翻译设置中启动它。"}, status_code=409)

    # 语言来源优先级：显式字段（若有客户端会发）→ 系统提示词里的文案 → 兜底。
    # 只认字段会让本地模型永远译成中文，只认提示词则在文案变动后静默失效，
    # 所以两条都留着，并且解析失败时记一条日志，别让回归变成哑巴错误。
    target_lang = payload.get("targetLang") or _extract_target_lang(str(system_text))
    if not target_lang:
        logger.warning("无法从系统提示词解析目标语言，回退为简体中文：%r", str(system_text)[:120])
        target_lang = "简体中文"
    glossary = _extract_glossary_from_system(str(system_text))

    # 批量协议：<1>段一 <2>段二 …
    segs = re.findall(r"<(\d+)>([\s\S]*?)(?=<\d+>|$)", user_text)
    loop = asyncio.get_running_loop()

    # 同时在飞的生成不超过 llama-server 的槽位数（信号量挂在引擎单例上）
    def run(text: str) -> str:
        with local_model.slots:
            return local_model.translate(text, str(target_lang), glossary)

    def run_batch(items: list[tuple[str, str]]) -> str:
        """逐段翻译并按编号回填；段与段之间并发。

        小模型单段串行时一页要 ~20 秒，4 路并发后约 9 秒（实测 2.3 倍）——
        瓶颈是内存带宽而不是线程数，多序列才喂得饱它。
        """
        from concurrent.futures import ThreadPoolExecutor

        from .local_model import PARALLEL_SLOTS

        with ThreadPoolExecutor(max_workers=min(PARALLEL_SLOTS, len(items))) as pool:
            outs = list(pool.map(lambda it: run(it[1].strip()), items))
        return "\n".join(f"<{idx}>{out}" for (idx, _), out in zip(items, outs))

    try:
        if segs:
            content = await loop.run_in_executor(None, run_batch, segs)
        else:
            content = await loop.run_in_executor(None, run, user_text)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"error": f"{type(err).__name__}: {err}"}, status_code=500)

    return JSONResponse({
        "id": "local", "object": "chat.completion", "created": 0,
        "model": (local_model.status().get("model") or "local"),
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    })


@app.get("/local/v1/models")
def local_models() -> dict:
    from .local_model import local_model

    name = local_model.status().get("model") or "local-model"
    return {"object": "list", "data": [{"id": name, "object": "model", "owned_by": "local"}]}


@app.post("/debug/log")
async def debug_log(request: Request) -> dict:
    """接收前端调试日志（右键翻译链路排查），追加写入临时文件。"""
    import tempfile
    from datetime import datetime

    try:
        payload = await request.json()
        lines = payload.get("lines", [])
        log_file = Path(tempfile.gettempdir()) / "tr-frontend-debug.log"
        with log_file.open("a", encoding="utf-8") as f:
            for line in lines:
                f.write(str(line) + "\n")
        return {"ok": True, "count": len(lines)}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": str(err)}
