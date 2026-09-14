# -*- coding: utf-8 -*-
"""BabelDOC 整本翻译路线：pdf2zh 官方后继的完整管线
（DocLayout-YOLO 版面 + 字符级重排 + Noto 字体子集 + 双语 dual/mono 输出）。

进度通过全局 _job_state 暴露，GET /translate_progress 轮询读取。
"""
from __future__ import annotations

import asyncio
import base64
import os
import shutil
import tempfile
import threading
from pathlib import Path

from babeldoc.assets.assets import get_doclayout_onnx_model_path
from babeldoc.docvision.doclayout import OnnxModel as DocLayoutOnnxModel
from babeldoc.format.pdf.high_level import async_translate
from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
from babeldoc.translator.translator import OpenAITranslator

import logging

logger = logging.getLogger(__name__)

_model = None


class RobustOpenAITranslator(OpenAITranslator):
    """模型偶发返回空 content（推理型模型/网络抖动）时自动重试，
    避免整段译文为空导致 ocr_workaround 白底页大面积空白。

    同时声明不支持 LLM 富文本模式（do_llm_translate 抛 NotImplementedError），
    使 BabelDOC 走稳定的逐段纯文本翻译，跳过要求模型输出 JSON 的路径——
    部分模型（推理型）对该路径返回空/非 JSON 内容，导致整页丢译文。
    """

    def do_llm_translate(self, text, rate_limit_params: dict = None):
        raise NotImplementedError

    def do_translate(self, text, rate_limit_params: dict = None) -> str:
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                result = super().do_translate(text, rate_limit_params)
                if result and result.strip():
                    return result
                last_err = RuntimeError("model returned empty content")
                logger.warning(
                    "empty translation (attempt %d/3) for %.40s...",
                    attempt + 1, text,
                )
            except Exception as err:  # noqa: BLE001
                last_err = err
                logger.warning("translate call failed (attempt %d/3): %s", attempt + 1, err)
        raise last_err if last_err else RuntimeError("translate failed")

# 当前翻译任务进度（单任务模型，新任务覆盖旧状态）
_job_lock = threading.Lock()
_job_state: dict = {"stage": "", "overall": 0.0, "done": False, "error": None}


def get_progress() -> dict:
    with _job_lock:
        return dict(_job_state)


def _set_progress(stage: str, overall: float, done: bool = False, error: str | None = None):
    with _job_lock:
        _job_state.update(stage=stage, overall=round(overall, 1), done=done, error=error)


def _parse_pages(pages: str | None) -> list[int] | None:
    """把 BabelDOC 页码选择（"1"、"1-3、5"，1-based）解析为 0-based 索引列表。"""
    if not pages:
        return None
    indices: list[int] = []
    for part in pages.replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo, _, hi = part.partition("-")
            try:
                a, b = int(lo), int(hi)
                indices.extend(range(a - 1, b))
            except ValueError:
                return None
        else:
            try:
                indices.append(int(part) - 1)
            except ValueError:
                return None
    return indices or None


def _doclayout() -> DocLayoutOnnxModel:
    global _model
    if _model is None:
        _model = DocLayoutOnnxModel(str(get_doclayout_onnx_model_path()))
    return _model


def _looks_scanned(pdf_bytes: bytes, max_pages: int = 3) -> bool:
    """页面主体是整页大图（扫描墨迹）→ 需要白底覆盖后再排印译文，
    否则译文会与原图墨迹叠印。有内嵌文字层的扫描件文字层再长也算扫描件。"""
    try:
        import fitz

        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            for pno in range(min(doc.page_count, max_pages)):
                page = doc[pno]
                area = abs(page.rect)
                if area <= 0:
                    continue
                for info in page.get_image_info():
                    r = fitz.Rect(info["bbox"])
                    if abs(r) > area * 0.6:
                        return True
        finally:
            doc.close()
    except Exception:
        pass
    return False


def translate_pdf(
    pdf_bytes: bytes,
    *,
    lang_in: str = "en",
    lang_out: str = "zh",
    base_url: str,
    api_key: str,
    model: str,
    target_lang_name: str | None = None,
    qps: int = 4,
    no_dual: bool = False,
    no_mono: bool = False,
    pages: str | None = None,
    ocr_workaround: bool | None = None,
    force_rebuild: bool = False,
    use_glossary: bool = True,
) -> dict:
    """跑完整 BabelDOC 管线，返回 {mono, dual} 的 PDF bytes（不存在则为 None）。

    pages: BabelDOC 页码选择（如 "1"、"1-3、5"），单页翻译用；None 为全部页。
    通过 async_translate 消费事件流，实时更新 _job_state 供前端轮询。
    本函数在线程池中执行（自带事件循环）。
    """
    _set_progress("prepare", 0)

    tmp = Path(tempfile.gettempdir()) / f"tr-babeldoc-{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    input_path = tmp / "input.pdf"
    input_path.write_bytes(pdf_bytes)
    translator = RobustOpenAITranslator(
        lang_in, lang_out, model, base_url=base_url, api_key=api_key,
    )
    config = TranslationConfig(
        translator=translator,
        input_file=input_path,
        lang_in=lang_in,
        lang_out=lang_out,
        doc_layout_model=_doclayout(),
        output_dir=tmp,
        pages=pages,
        no_dual=no_dual,
        no_mono=no_mono,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        qps=qps,
        use_rich_pbar=False,
        report_interval=60,
        # 跳过要求模型输出 JSON 的富文本翻译路径——部分模型（如推理型）会返回
        # 空/非 JSON 内容导致整段丢译文；逐段纯文本翻译更稳
        disable_rich_text_translate=True,
    )
    # 术语表：BabelDOC 原生支持（按其内部匹配逐段注入，只带命中词条）
    try:
        from babeldoc.glossary import Glossary, GlossaryEntry

        from . import glossary_store

        raw_entries = glossary_store.load_entries()
        if use_glossary and raw_entries:
            entries = [
                GlossaryEntry(str(e["source"]), str(e["target"]), e.get("targetLanguage"))
                for e in raw_entries
            ]
            config.glossaries = [Glossary("默认术语表", entries)]
    except Exception as err:  # noqa: BLE001
        logger.warning("glossary setup failed: %s", err)

    if target_lang_name:
        config.custom_system_prompt = (
            f"把内容翻译为{target_lang_name}，保持学术文档的严谨表达。"
        )
    # 扫描件（或调用方强制）：译文下方先铺白底矩形盖住原墨迹，避免叠印
    if ocr_workaround is None:
        ocr_workaround = _looks_scanned(pdf_bytes)
    config.ocr_workaround = ocr_workaround
    if ocr_workaround:
        # 扫描件先用 PP-OCRv6 重建干净文字层（替换 WPS 等旧 OCR 的损坏文本，
        # 如 De~ember / n-rnational），BabelDOC 翻译的是重建后的干净文本；
        # 只重建本次翻译涉及的页，结果按文档哈希缓存
        from .sandwich import rebuild_scanned_pdf

        _set_progress("ocr_rebuild", 2)
        pdf_bytes, rebuilt = rebuild_scanned_pdf(pdf_bytes, page_indices=_parse_pages(pages), force=force_rebuild)
        logger.info("scanned: rebuilt text layer for %d page(s)", max(rebuilt, 0))
        input_path.write_bytes(pdf_bytes)

    async def run():
        result_holder: dict = {}
        error_holder: dict = {}

        async def consume():
            async for event in async_translate(config):
                etype = event.get("type", "")
                if etype == "progress_update":
                    _set_progress(
                        str(event.get("stage", "")),
                        float(event.get("overall_progress", 0)),
                    )
                elif etype == "error":
                    error_holder["msg"] = str(event.get("error", "unknown error"))
                    return
                elif etype == "finish":
                    # finish 到达即代表译制 PDF 已写盘；进程池退出在 Windows
                    # 上经常挂起，因此不再等待生成器自然结束（见下方宽限逻辑）
                    result_holder["result"] = event.get("translate_result")
                    _set_progress("finish", 100)
                    return

        task = asyncio.ensure_future(consume())
        while True:
            if "result" in result_holder or "msg" in error_holder:
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=8)
                except Exception:
                    task.cancel()
                    try:
                        await task
                    except Exception:
                        pass
                break
            if task.done():
                break
            await asyncio.sleep(0.2)

        if "msg" in error_holder:
            raise RuntimeError(error_holder["msg"])
        result = result_holder.get("result")
        if result is None:
            raise RuntimeError("BabelDOC 未返回结果")
        _set_progress("finish", 100)
        return result

    try:
        result = asyncio.run(run())
    except Exception as err:
        _set_progress("error", 100, done=True, error=str(err))
        raise

    mono_bytes = (
        base64.b64encode(Path(result.mono_pdf_path).read_bytes()).decode()
        if result.mono_pdf_path else None
    )
    dual_bytes = (
        base64.b64encode(Path(result.dual_pdf_path).read_bytes()).decode()
        if result.dual_pdf_path else None
    )
    try:
        shutil.rmtree(tmp, ignore_errors=True)
    except OSError:
        pass
    return {
        "mono": mono_bytes,
        "dual": dual_bytes,
        "seconds": round(result.total_seconds, 1),
    }
