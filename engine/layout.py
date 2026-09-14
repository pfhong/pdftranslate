# -*- coding: utf-8 -*-
"""版面识别：文本层提取（PyMuPDF）与 OCR 路径（PP-OCRv6），输出统一的段落块结构。

管线与前端 layout.ts 一致：
  行列表 → 分栏（行级投影谷底探测，横跨栏线的行=页眉/页脚单独成组）
        → 栏内按 y 重叠聚类成行 → 段落规则切分（垂直间隙/缩进/连字符）
"""
from __future__ import annotations

import re
from pathlib import Path

import fitz
import numpy as np

from .ppocr import PpOcr

_ocr_engine: PpOcr | None = None


def get_ocr() -> PpOcr | None:
    """懒加载 PP-OCRv6；模型文件缺失时返回 None（调用方降级为文本层）。"""
    global _ocr_engine
    if _ocr_engine is None:
        base = Path(__file__).resolve().parent
        det = base / "models" / "ppocrv6_small_det.onnx"
        rec = base / "models" / "ppocrv6_small_rec.onnx"
        dic = base / "assets" / "ppocrv6_dict.txt"
        if not (det.exists() and rec.exists() and dic.exists()):
            return None
        _ocr_engine = PpOcr(det, rec, dic)
    return _ocr_engine


_FORMULA_CHARS = set("=+-−±×÷≤≥≠≈∝∑∏∫√∞∂∇∈∉⊂⊆∪∩→←↔≪≫⟨⟩|^_\/")
_GREEK = "Ͱ-Ͽᴀ-ᵿ"


def _looks_like_formula(text: str) -> bool:
    """判断块是否主要是公式/数学表达（这类内容翻译会破坏语义，应保留原样）。

    判据：非字母数字符号占比高，或含希腊字母/数学算符且词数很少。
    """
    t = text.strip()
    if not t:
        return False
    if len(t) > 120:  # 长段落多半是正文，即使含数学符号
        return False
    symbols = sum(1 for c in t if c in _FORMULA_CHARS)
    greek = sum(1 for c in t if "Ͱ" <= c <= "Ͽ")
    digits = sum(1 for c in t if c.isdigit())
    letters = sum(1 for c in t if c.isalpha())
    words = len(t.split())
    if letters == 0:
        return True  # 纯符号/数字（如 "99.63% ± 0.12%"）
    # 含数学算符的短式（如 "E = mc2"、"x + y = z"）
    math_ops = "=+−±×÷≤≥≠≈∝∑∏∫√∞∂∇→⟨⟩"
    if any(c in t for c in math_ops) and words <= 6 and letters <= 12:
        return True
    # 符号+希腊+数字 占比不低于字母数，且词数很少
    if words <= 12 and (symbols + greek + digits) >= letters:
        return True
    return False


def _graphic_regions(page: "fitz.Page") -> list[tuple[float, float, float, float]]:
    """识别页面上的图表区域（密集矢量图形 / 大位图），用于保护图表内部文字。

    规则：高度>=5pt 且面积>=60pt² 的绘制元素按 y 邻近聚类（间隔<30pt 归为同一图），
    元素数 >=3 的簇视为图表；同时把面积 >=8000pt² 的整块位图计入。
    """
    rects: list[fitz.Rect] = []
    try:
        for d in page.get_drawings():
            r = d["rect"]
            # 块状元素（box/填充）与细长线条（边框/连线）都算图形组成部分
            bulky = r.height >= 5 and abs(r.get_area()) >= 60
            stroke = max(r.width, r.height) >= 30 and min(r.width, r.height) >= 0.5
            if bulky or stroke:
                rects.append(r)
    except Exception:  # noqa: BLE001
        pass
    try:
        for info in page.get_image_info():
            r = fitz.Rect(info["bbox"])
            if abs(r.get_area()) >= 8000:
                rects.append(r)
    except Exception:  # noqa: BLE001
        pass
    if not rects:
        return []

    rects.sort(key=lambda r: r.y0)
    clusters: list[list[fitz.Rect]] = [[rects[0]]]
    for r in rects[1:]:
        cur = clusters[-1]
        if r.y0 <= max(x.y1 for x in cur) + 30:
            cur.append(r)
        else:
            clusters.append([r])

    out: list[tuple[float, float, float, float]] = []
    for cur in clusters:
        if len(cur) < 3:
            continue  # 少量线条（表格线/下划线/页眉横线）不算图表
        # 外扩 12pt：图形周边的坐标轴标签/单位标注属于图表内容
        out.append((
            min(r.x0 for r in cur) - 12, min(r.y0 for r in cur) - 12,
            max(r.x1 for r in cur) + 12, max(r.y1 for r in cur) + 12,
        ))
    return out


def _filter_graphic_lines(
    lines: list[dict],
    regions: list[tuple[float, float, float, float]],
    x_bounds: tuple[float, float] | None = None,
) -> list[dict]:
    """剔除图表区域内的文字行（坐标轴标签、示意图注记等）。

    - 图形横跨该栏 60% 以上宽度时：该栏在此 y 带内的文字全部视为图表内容
      （图形的标注常排在图形框外侧，逐个按 bbox 判定会漏）
    - 否则只剔除落在图形框内的文字
    """
    if not regions:
        return lines
    out: list[dict] = []
    for l in lines:
        cy = (l["y0"] + l["y1"]) / 2
        cx = (l["x0"] + l["x1"]) / 2
        protect = False
        for x0, y0, x1, y1 in regions:
            if not (y0 - 6 <= cy <= y1 + 6):
                continue
            if x_bounds:
                # 「图形横跨本栏」才按整带保护；先确认图形确实落在本栏内
                # （否则相邻栏的图会误伤本栏正文）
                overlap = min(x1, x_bounds[1]) - max(x0, x_bounds[0])
                if overlap >= 0.5 * (x1 - x0) and (x1 - x0) >= 0.6 * (
                    x_bounds[1] - x_bounds[0]
                ):
                    protect = True
                    break
            if x0 <= cx <= x1:
                protect = True
                break
        if not protect:
            out.append(l)
    return out


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    vals = sorted(values)
    return vals[len(vals) // 2]


# --------------------------------------------------------------------- 分栏

def _find_column_cut(lines: list[dict], page_width: float) -> float | None:
    """找栏间切割线：以"跨越该位置的行数"最少处为准。

    用覆盖行数会失效——页眉横跨栏间会抬高该处覆盖，而某些短行的行尾会形成
    更深的"假谷底"（实测被选到 241pt，导致左栏段落框被夹窄、右端原文残留）。
    栏间的本质特征是"几乎没有行跨越"，据此判定更稳。
    """
    w = max(8, round(page_width))
    straddle = [0] * (w + 1)
    for line in lines:
        # 整页宽的元素（标题/摘要/页眉）本来就会横跨栏间，不参与统计；
        # 真正不该跨越切割线的是"栏内行"
        if (line["x1"] - line["x0"]) >= 0.55 * page_width:
            continue
        lo = max(0, int(line["x0"]) + 1)
        hi = min(w, int(line["x1"]) - 1)
        for x in range(lo, hi + 1):
            straddle[x] += 1

    x_lo, x_hi = round(w * 0.15), round(w * 0.85)
    # 平滑：窗口内取最小值，找"整体都少跨越"的区域
    win = max(2, round(w * 0.012))
    smoothed = {
        x: min(straddle[max(0, x - win):min(w, x + win) + 1]) for x in range(x_lo, x_hi + 1)
    }
    threshold = max(1, round(len(lines) * 0.06))
    # 按跨越数升序逐个验证候选：左侧/右侧需各有足够的行（按行中心归属）
    for x in sorted(smoothed, key=lambda k: (smoothed[k], abs(k - w / 2))):
        if smoothed[x] > threshold:
            break
        left = sum(1 for l in lines if (l["x0"] + l["x1"]) / 2 < x)
        right = len(lines) - left
        if left >= 3 and right >= 3:
            return float(x)
    return None


def _split_columns(
    lines: list[dict],
    page_width: float,
    depth: int = 0,
    lo: float = 0.0,
    hi: float | None = None,
) -> tuple[list[tuple[list[dict], tuple[float, float]]], list[dict]]:
    """返回 (各栏 [行列表, x 边界], 横跨栏线的行=页眉/页脚)。递归支持三栏。

    x 边界按**栏切割线**收敛（而非行框极值）——OCR 行框常有外扩，
    若用极值会让相邻栏在边界处 x 区间重叠，导致译文叠印。
    """
    hi = page_width if hi is None else hi
    if not lines or depth >= 2:
        return ([(lines, (lo, hi))] if lines else []), []
    cut = _find_column_cut(lines, page_width)
    if cut is None:
        return [(lines, (lo, hi))], []
    half = max(2.0, page_width * 0.01)
    # "横跨行"（页眉/居中标题）需**明显**伸出切割线两侧（各 >= 6% 页宽）；
    # 用很小的容差会把"行尾略微越过栏间"的正文行误判为横跨元素，
    # 于是同一段落的行被拆到两个分组，产出互相交叠的块（实测重叠达 43pt）
    margin = max(8.0, page_width * 0.06)
    crossed = [l for l in lines if l["x0"] < cut - margin and l["x1"] > cut + margin]
    rest = [l for l in lines if l not in crossed]
    if not rest:
        return [(lines, (lo, hi))], crossed
    left = [l for l in rest if (l["x0"] + l["x1"]) / 2 < cut]
    right = [l for l in rest if (l["x0"] + l["x1"]) / 2 >= cut]
    if not left or not right:
        return [(lines, (lo, hi))], crossed
    left_cols, left_cross = _split_columns(left, page_width, depth + 1, lo, cut)
    right_cols, right_cross = _split_columns(right, page_width, depth + 1, cut, hi)
    return left_cols + right_cols, crossed + left_cross + right_cross


# ------------------------------------------------------------- 行聚类与合并

def _cluster_rows(lines: list[dict]) -> list[list[dict]]:
    """按 y 区间重叠度聚类成行（重叠 > 较小行高的 50%），行内按 x。"""
    rows: list[list[dict]] = []  # 每项 [y0, y1, lines]
    for line in sorted(lines, key=lambda l: l["y0"]):
        h = line["y1"] - line["y0"]
        for row in rows:
            overlap = min(line["y1"], row[1]) - max(line["y0"], row[0])
            if overlap > 0.5 * min(h, row[1] - row[0]):
                row[2].append(line)
                row[0] = min(row[0], line["y0"])
                row[1] = max(row[1], line["y1"])
                break
        else:
            rows.append([line["y0"], line["y1"], [line]])
    rows.sort(key=lambda r: r[0])
    return [items for _, _, items in rows]


# 页边页码形如 "86 Discrimination ..."（数字 + 空格 + 正文），
# 而列表/决议序号是 "2. All States ..."（数字 + 点），不能用同一规则剥离
_PAGE_NUM_RE = re.compile(r"^\s*(\d{1,4})[ 	]+(?=[A-Za-z一-鿿])")


def _strip_band_page_number(text: str, y0: float, y1: float, page_h: float) -> str:
    """剥离**页眉/页脚带**内行首的页边页码（如 "86 Discrimination and ..."）。

    仅在页面上下 12% 范围内生效：正文里的编号（如 "3384 (XXX), Declaration ..."
    这类决议号）属于内容，必须保留。
    """
    if page_h <= 0:
        return text
    in_band = y0 < page_h * 0.08 or y1 > page_h * 0.92
    if not in_band:
        return text
    m = _PAGE_NUM_RE.match(text)
    if not m:
        return text
    rest = text[m.end():].strip()
    return rest if len(rest) > 15 else text


def _clean_text(text: str) -> str:
    """清理 OCR 边缘杂符（扫描噪声常被识别成 _ | ~ 等）。"""
    t = text.strip()
    t = t.strip("_|~^`\/ ")
    t = " ".join(t.split())
    # 行内断词合并："co-op- eration" → "co-operation"（旧文本层常把连字符断词拆开）
    t = re.sub(r"(\w)- (\w)", r"", t)
    return t


def _merge_row(lines: list[dict], page_h: float = 0.0) -> list[dict]:
    """同一行的多个片段合并为若干行。

    间隙 > 0.25 字号补空格；间隙超过 max(2.5×字号, 14pt) 视为**不同栏位内容**
    （典型：页边页码与正文首行被识别成一条基线上的片段），切分成独立行，
    避免页码被并入正文段落一起翻译。
    """
    items = sorted(lines, key=lambda l: l["x0"])
    size = _median([l["size"] for l in items]) or 10.0
    split_gap = max(2.5 * size, 14.0)

    segments: list[list[dict]] = []
    seg: list[dict] = []
    for it in items:
        prev = seg[-1] if seg else None
        if prev and it["x0"] - prev["x1"] > split_gap:
            segments.append(seg)
            seg = [it]
        else:
            seg.append(it)
    if seg:
        segments.append(seg)

    out: list[dict] = []
    for seg_items in segments:
        text = ""
        prev = None
        for it in seg_items:
            if prev and it["x0"] - prev["x1"] > size * 0.25:
                text += " "
            text += it["text"]
            prev = it
        text = _clean_text(text)
        if page_h > 0 and seg_items:
            text = _strip_band_page_number(
                text,
                min(l["y0"] for l in seg_items),
                max(l["y1"] for l in seg_items),
                page_h,
            )
        if not text:
            continue
        out.append({
            "x0": min(l["x0"] for l in seg_items),
            "x1": max(l["x1"] for l in seg_items),
            "y0": min(l["y0"] for l in seg_items),
            "y1": max(l["y1"] for l in seg_items),
            "text": text,
            "size": size,
            # 样式从来源片段继承（文本层路径有 bold/italic；OCR 路径为 False）
            "bold": any(l.get("bold") for l in seg_items),
            "italic": any(l.get("italic") for l in seg_items),
        })
    return out


# --------------------------------------------------------------------- 段落

def _chunk_lines(rows: list[dict]) -> list[list[dict]]:
    """行 → 段落：垂直间隙 > 0.8 行高 / 首行缩进 / 连字符续行合并。"""
    chunks: list[list[dict]] = []
    cur: list[dict] = []
    cur_left = 0.0
    bare_num = re.compile(r"^\d{1,4}[.\-]?$")

    for row in rows:
        # 裸数字行（页边页码等）：独立成段，避免与正文首行粘连后一起翻译
        if bare_num.match(row["text"].strip()):
            if cur:
                chunks.append(cur)
                cur = []
            chunks.append([row])
            continue
        if not cur:
            cur = [row]
            cur_left = row["x0"]
            continue
        prev = cur[-1]
        line_h = max(prev["size"], row["size"])
        v_gap = row["y0"] - prev["y1"]
        # 标题（粗体）常为居中排版，行首参差是正常的，不按缩进断段
        indent = row["x0"] > cur_left + line_h * 0.8 and not prev.get("bold")
        hyphen = prev["text"].endswith("-") and row["text"][:1].islower()
        # 结构变化断段：粗体切换（标题↔正文）或字号明显不同。
        # 注意不用斜体：正文档里斜体短语会交替出现，会导致段落被切碎
        style_break = (
            bool(row.get("bold")) != bool(prev.get("bold"))
            or abs(row["size"] - prev["size"]) > 0.15 * prev["size"]
        )
        if style_break and not hyphen:
            chunks.append(cur)
            cur = [row]
            cur_left = row["x0"]
            continue
        if not hyphen and (v_gap > line_h * 0.8 or indent):
            chunks.append(cur)
            cur = [row]
            cur_left = row["x0"]
        else:
            cur.append(row)
            cur_left = min(cur_left, row["x0"])
    if cur:
        chunks.append(cur)
    return chunks


def _refine_text_with_ocr(text_lines: list[dict], ocr_lines: list[dict]) -> tuple[list[dict], int]:
    """文字层提供几何，OCR 提供更可靠的文本（"重识别"模式的核心）。

    为什么不用 OCR 的坐标：实测 PP-OCR 在这类扫描件上会漏检文字片段
    （某行只识别出 "2400th"，"plenary meeting" 整段丢失），一旦用它替换坐标，
    未覆盖的原文就会裸露在译制页上；而 PDF 自带文字层的坐标是完整精确的。
    因此只做文本校正，且要求 OCR 行与该行高度重叠、且识别文本长度合理
    （>= 60% 原长度），避免用残缺片段覆盖完整原文。

    返回 (校正后的行, 替换条数)。
    """
    if not ocr_lines:
        return text_lines, 0
    out: list[dict] = []
    replaced = 0
    for tl in text_lines:
        area = max(1.0, (tl["x1"] - tl["x0"]) * (tl["y1"] - tl["y0"]))
        best = None
        best_ratio = 0.0
        for ol in ocr_lines:
            ox = min(tl["x1"], ol["x1"]) - max(tl["x0"], ol["x0"])
            oy = min(tl["y1"], ol["y1"]) - max(tl["y0"], ol["y0"])
            if ox > 0 and oy > 0:
                ratio = (ox * oy) / area
                if ratio > best_ratio:
                    best_ratio, best = ratio, ol
        item = dict(tl)
        if best is not None and best_ratio >= 0.6:
            original = str(tl["text"]).strip()
            candidate = str(best["text"]).strip()
            if candidate and len(candidate) >= 0.6 * len(original):
                item["text"] = candidate
                replaced += 1
        out.append(item)
    return out, replaced


def _blocks_from_chunks(
    chunks: list[list[dict]], x_bounds: tuple[float, float] | None = None
) -> list[dict]:
    blocks = []
    for idx, chunk in enumerate(chunks):
        xs0 = sorted(line["x0"] for line in chunk)
        xs1 = sorted(line["x1"] for line in chunk)
        size = _median([line["size"] for line in chunk])
        x0 = xs0[len(xs0) // 2]
        x1 = xs1[min(len(xs1) - 1, int(len(xs1) * 0.9))]
        if x_bounds is not None:
            x0 = max(x0, x_bounds[0])
            x1 = min(x1, x_bounds[1])
        text = " ".join(l["text"] for l in chunk)
        # 纯数字块（页边页码等）无需翻译：留空文本使其跳过翻译与合成，保留原文
        if len(chunk) == 1 and re.fullmatch(r"\d{1,4}[.\-]?", text.strip()):
            text = ""
        # 公式/数学表达块：翻译会破坏语义，保留原样（对应 pdf2zh 的公式保护思路）
        elif _looks_like_formula(text):
            text = ""
        blocks.append({
            "index": idx,
            "bbox": [x0, chunk[0]["y0"], x1, chunk[-1]["y1"]],
            "lines": [
                {"bbox": [l["x0"], l["y0"], l["x1"], l["y1"]], "text": l["text"]}
                for l in chunk
            ],
            "text": text,
            "size": round(size, 2),
            # 标题多为粗体；引文块相对正文左边界缩进
            "bold": any(bool(l.get("bold")) for l in chunk),
            "x0": round(x0, 2),
        })
    return blocks


def _column_blocks(
    col_lines: list[dict], x_bounds: tuple[float, float], page_h: float = 0.0
) -> list[dict]:
    """单栏：行聚类 → 段落切分 → 块。"""
    # 页眉/页脚带内的行（如居中/靠边的页眉）不与正文首行/末行合并：
    # 它们与正文的行距往往只有 2~3pt，按行距规则会被误并为一段
    top_band: list[dict] = []
    bottom_band: list[dict] = []
    body: list[dict] = []
    for ln in col_lines:
        if page_h > 0 and ln["y1"] <= page_h * 0.08:
            top_band.append(ln)
        elif page_h > 0 and ln["y0"] >= page_h * 0.92:
            bottom_band.append(ln)
        else:
            body.append(ln)

    def to_lines(group: list[dict]) -> list[dict]:
        rows = _cluster_rows(group)
        merged = [ln for r in rows for ln in _merge_row(r, page_h)]
        merged.sort(key=lambda l: (l["y0"], l["x0"]))
        return merged

    blocks: list[dict] = []
    if top_band:
        blocks.extend(_blocks_from_chunks(_chunk_lines(to_lines(top_band)), x_bounds))
    if body:
        blocks.extend(_blocks_from_chunks(_chunk_lines(to_lines(body)), x_bounds))
    if bottom_band:
        blocks.extend(_blocks_from_chunks(_chunk_lines(to_lines(bottom_band)), x_bounds))
    return blocks


# --------------------------------------------------------------------- 入口

def _text_lines(page: "fitz.Page") -> list[dict]:
    d = page.get_text("dict")
    lines: list[dict] = []
    for block in d.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = "".join(s.get("text", "") for s in spans).strip()
            if not text:
                continue
            bbox = line["bbox"]
            sizes = [s.get("size", 10.0) for s in spans]
            # 字形样式：flags 位 16=粗体、2=斜体（fitz span flags）
            # 旋转文本（竖排水印/侧栏）不参与正文版面：方向向量非水平即跳过
            direction = line.get("dir", (1, 0))
            if abs(direction[1]) > 0.1:
                continue
            bold = sum(1 for s in spans if s.get("flags", 0) & 16) * 2 > len(spans)
            italic = sum(1 for s in spans if s.get("flags", 0) & 2) * 2 > len(spans)
            lines.append({
                "x0": bbox[0], "y0": bbox[1], "x1": bbox[2], "y1": bbox[3],
                "text": _clean_text(text),
                "size": _median(sizes) or 10.0,
                "bold": bold,
                "italic": italic,
            })
    return lines


def _ocr_lines(page: "fitz.Page", ocr: PpOcr, dpi: int = 220) -> list[dict]:
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    bgr = img[:, :, :3][:, :, ::-1]
    sx = page.rect.width / pix.width
    sy = page.rect.height / pix.height
    lines = []
    for item in ocr.lines(bgr):
        x0, y0, x1, y1 = item["box"]
        lines.append({
            "x0": x0 * sx, "y0": y0 * sy, "x1": x1 * sx, "y1": y1 * sy,
            "text": item["text"],
            "size": (y1 - y0) * sy * 0.8,
        })
    return lines


def extract_pages(pdf_bytes: bytes, force_ocr: bool = False) -> dict:
    """提取整本文档的段落块。文本层为空/极短的页自动走 OCR（模型可用时）。"""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    ocr = get_ocr()
    pages = []
    for pno in range(doc.page_count):
        page = doc[pno]
        raw_text = page.get_text().strip()
        if len(raw_text) < 20 and ocr is not None:
            # 无文字层的纯扫描页：只能用 OCR 的坐标与文本
            lines = _ocr_lines(page, ocr)
            mode = "ocr"
        else:
            lines = _text_lines(page)
            mode = "text"
            if force_ocr and ocr is not None:
                # 有文字层：几何用文字层，文本用我们的 OCR 校正（"重识别"）
                lines, _ = _refine_text_with_ocr(lines, _ocr_lines(page, ocr))
        # 图表内部文字（坐标轴标签、示意图注记）不参与翻译与改版：
        # 翻译它们没有意义，且涂盖会破坏图形
        regions = _graphic_regions(page)
        columns, crossed = _split_columns(lines, page.rect.width)
        blocks: list[dict] = []
        if crossed:
            rows = _cluster_rows(crossed)
            merged = [ln for r in rows for ln in _merge_row(r, page.rect.height)]
            merged.sort(key=lambda l: (l["y0"], l["x0"]))
            blocks.extend(_blocks_from_chunks(_chunk_lines(merged)))
        for col_lines, col_bounds in columns:
            col_lines = _filter_graphic_lines(col_lines, regions, col_bounds)
            blocks.extend(_column_blocks(col_lines, col_bounds, page.rect.height))
        for i, b in enumerate(blocks):
            b["index"] = i
        pages.append({
            "pageNumber": pno + 1,
            "width": round(page.rect.width, 2),
            "height": round(page.rect.height, 2),
            "mode": mode,
            "blocks": blocks,
        })
    return {"pages": pages, "ocrAvailable": ocr is not None}
