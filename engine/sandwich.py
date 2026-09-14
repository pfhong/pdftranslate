# -*- coding: utf-8 -*-
"""扫描页文字层重建（sandwich PDF）：

WPS 等工具内嵌的旧 OCR 文字层常有断词损坏（De~ember / n-rnational），
直接翻译会输出夹杂乱码的译文。本模块用引擎自带的 PP-OCRv6 重新识别页面，
生成「原页位图 + 干净隐形文字层」的新 PDF 供 BabelDOC 翻译：
  - 隐形文字（render_mode=3）位置与真实墨迹对齐
  - BabelDOC 翻译的是干净的 PP-OCR 文本，ocr_workaround 白底再覆盖墨迹
"""
from __future__ import annotations

import hashlib

import fitz

from . import BUILD
from .layout import get_ocr

# 重建结果缓存：同一文档同一页范围只 OCR 一次（键：版本 + 文档哈希 + 页索引 + dpi）
_rebuild_cache: dict[str, bytes] = {}
_REBUILD_CACHE_MAX = 4
# 重建算法版本：修改识别/覆盖逻辑时递增，使旧缓存自动失效
_CACHE_VERSION = BUILD


def _fit_fontsize(text: str, fontsize: float, max_width: float) -> float:
    """缩小字号使文本不超过行框宽度（隐形层仅供翻译，精度要求不高）。"""
    if not text or max_width <= 0:
        return max(fontsize, 1.0)
    width = fitz.get_text_length(text, fontname="helv", fontsize=fontsize)
    if width <= max_width:
        return fontsize
    return max(fontsize * max_width / width, 1.0)


def rebuild_scanned_pdf(
    pdf_bytes: bytes,
    dpi: int = 220,
    page_indices: list[int] | None = None,
    force: bool = False,
) -> tuple[bytes, int]:
    """对指定页（None=全部页）重建文字层，其余页原样保留。

    返回 (新 PDF bytes, 重建页数)。结果按文档哈希缓存，重复翻译不再重跑 OCR。
    """
    key = (
        f"{_CACHE_VERSION}:"
        + hashlib.sha1(pdf_bytes).hexdigest()[:16]
        + f":{dpi}:{sorted(page_indices) if page_indices else 'all'}"
    )
    if not force and key in _rebuild_cache:
        return _rebuild_cache[key], -1

    ocr = get_ocr()
    if ocr is None:
        return pdf_bytes, 0

    src = fitz.open(stream=pdf_bytes, filetype="pdf")
    out = fitz.open()
    targets = set(page_indices) if page_indices is not None else set(range(src.page_count))
    rebuilt = 0
    total_lines = 0

    for pno in range(src.page_count):
        page = src[pno]
        if pno not in targets:
            out.insert_pdf(src, from_page=pno, to_page=pno)
            continue
        pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
        img_bytes = pix.tobytes("jpeg", jpg_quality=88)
        sx = page.rect.width / pix.width
        sy = page.rect.height / pix.height

        new_page = out.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, stream=img_bytes)

        # PP-OCRv6 识别（引擎 layout 模块复用同一 OCR 实例）
        import numpy as np

        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        bgr = img[:, :, :3][:, :, ::-1]
        # 密集小字页面：提高检测分辨率（默认 736 短边会漏检）
        lines = ocr.lines(bgr, det_side=1600)

        # 跨行连字符合并：行尾 "-" + 次行小写开头 → 去连字符拼接，
        # 并合并外接框（De- cember → December）
        merged: list[dict] = []
        for item in lines:
            prev = merged[-1] if merged else None
            if (
                prev
                and prev["text"].endswith("-")
                and item["text"][:1].islower()
            ):
                prev["text"] = prev["text"][:-1] + item["text"]
                px0, py0, px1, py1 = prev["box"]
                x0, y0, x1, y1 = item["box"]
                prev["box"] = (min(px0, x0), min(py0, y0), max(px1, x1), max(py1, y1))
            else:
                merged.append(item)

        total_lines += len(merged)
        for item in merged:
            x0, y0, x1, y1 = item["box"]
            x0, y0 = x0 * sx, y0 * sy
            x1, y1 = x1 * sx, y1 * sy
            h = y1 - y0
            if h <= 1 or x1 <= x0:
                continue
            fontsize = h * 0.72
            fontsize = _fit_fontsize(item["text"], fontsize, x1 - x0)
            # 基线对齐：y ≈ 行底 - 22% 行高（隐形文字，仅位置语义）
            new_page.insert_text(
                fitz.Point(x0, y1 - h * 0.22),
                item["text"],
                fontname="helv",
                fontsize=fontsize,
                render_mode=3,  # 不可见
            )
        rebuilt += 1

    data = out.tobytes(garbage=3, deflate=True)
    out.close()
    src.close()
    # 缓存上限控制，避免长会话内存膨胀
    if len(_rebuild_cache) >= _REBUILD_CACHE_MAX:
        _rebuild_cache.pop(next(iter(_rebuild_cache)))
    _rebuild_cache[key] = data
    import logging
    logging.getLogger(__name__).info(
        "sandwich rebuild: %d page(s), %d lines, %d bytes", rebuilt, total_lines, len(data)
    )
    return data, rebuilt
