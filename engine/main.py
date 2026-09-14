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

import fitz
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from . import BUILD, __version__
from . import glossary_store
from .layout import extract_pages, get_ocr
from .synthesize import synthesize

app = FastAPI(title="Transfer Reader Engine", version=__version__)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    ocr = get_ocr()
    return {
        "ok": True,
        "engine": "python",
        "version": __version__,
        "build": BUILD,
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
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: local_model.start(
                model_path,
                server_path=(payload.get("serverPath") or None),
                port=int(payload.get("port", 8818)),
                ctx=int(payload.get("ctx", 2048)),
                threads=int(payload.get("threads", 4)),
                timeout=float(payload.get("timeout", 300)),
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

    target_lang = payload.get("targetLang") or "简体中文"
    glossary = _extract_glossary_from_system(str(system_text))

    # 批量协议：<1>段一 <2>段二 …
    segs = re.findall(r"<(\d+)>([\s\S]*?)(?=<\d+>|$)", user_text)
    loop = asyncio.get_running_loop()

    def run(text: str) -> str:
        return local_model.translate(text, str(target_lang), glossary)

    try:
        if segs:
            parts: list[str] = []
            for idx, seg in segs:
                out = await loop.run_in_executor(None, run, seg.strip())
                parts.append(f"<{idx}>{out}")
            content = "\n".join(parts)
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
