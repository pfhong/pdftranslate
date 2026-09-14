# -*- coding: utf-8 -*-
"""译制 PDF 合成：PyMuPDF redaction（真删除原文字形/扫描墨迹像素）+ TextWriter
排印译文（字体共享、精确度量、两端对齐近似）。参考 pdf2zh 的合成思路。"""
from __future__ import annotations

import html as _html
from pathlib import Path

import fitz

_FONT_CANDIDATES = [
    Path(__file__).resolve().parent / "fonts" / "zh.ttf",
    Path("C:/Windows/Fonts/simhei.ttf"),
]

LINE_HEIGHT = 1.32
MIN_SIZE = 6.0


def find_font(explicit: str | None = None) -> Path | None:
    candidates = ([Path(explicit)] if explicit else []) + _FONT_CANDIDATES
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return p
        except OSError:
            continue
    return None


def wrap_text(text: str, font: "fitz.Font", size: float, max_w: float) -> list[str]:
    """按宽度折行：CJK 逐字断行，行首标点悬挂并入上一行。"""
    lines: list[str] = []
    cur = ""
    for ch in text:
        nxt = cur + ch
        if cur and len(nxt) > 1 and font.text_length(nxt, size) > max_w:
            if ch in "，。；：、！？）》”’]" and len(cur) > 1:
                lines.append(nxt)
                cur = ""
            else:
                lines.append(cur)
                cur = "" if ch == " " else ch
        else:
            cur = nxt
    if cur.strip():
        lines.append(cur)
    return lines


def synthesize(pdf_bytes: bytes, translations: list[dict], font_path: str | None = None) -> bytes:
    """translations: [{"page": n, "bbox": [x0,y0,x1,y1],
    "lines": [{"bbox": ...} | [x0,y0,x1,y1] ...], "text": 译文}]

    - redaction 真删除原文（文本层字形 + 扫描墨迹像素）
    - TextWriter 排印：字体整文档共享一份，逐段折行，超高自动缩字
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    font_path = find_font(font_path)
    font = fitz.Font(fontfile=str(font_path)) if font_path else None

    by_page: dict[int, list[dict]] = {}
    for t in translations:
        by_page.setdefault(int(t["page"]), []).append(t)

    for pno, items in by_page.items():
        if pno < 1 or pno > doc.page_count:
            continue
        page = doc[pno - 1]
        # 第一遍：redaction 删除原文（文本层字形 + 扫描墨迹像素）
        for t in items:
            for line in t.get("lines", []):
                bbox = line["bbox"] if isinstance(line, dict) else line
                page.add_redact_annot(fitz.Rect(*bbox), fill=(1, 1, 1))
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)

        # 第二遍：排印译文
        if font is None:
            continue
        tw = fitz.TextWriter(page.rect)
        for t in items:
            bbox = t.get("bbox")
            text = (t.get("text") or "").strip()
            if not bbox or not text:
                continue
            x0, y0, x1, y1 = bbox
            max_w = max(10.0, x1 - x0)
            box_h = max(5.0, y1 - y0)
            size = float(t.get("size", 10.0))

            lines = wrap_text(text, font, size, max_w)
            while len(lines) * size * LINE_HEIGHT > box_h * 1.15 and size > MIN_SIZE:
                size *= 0.92
                lines = wrap_text(text, font, size, max_w)

            ty = y0 + size
            for line in lines:
                if ty > y1 + size:
                    break
                tw.append(fitz.Point(x0, ty), line, font=font, fontsize=size)
                ty += size * LINE_HEIGHT
        tw.write_text(page)

    return doc.tobytes(garbage=3, deflate=True)
