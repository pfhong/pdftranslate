import type { PDFPageProxy } from "./pdf";

/**
 * 版面识别模块（移植自 pdfMathTranslate/pdf2zh 的解析启发式）：
 * - 公式/代码保护：LaTeX 字体名正则 + Unicode 数学字符类别 + 上下标字号比（< 0.79）
 * - 段落切分：OCR 页几何规则（垂直间隙 > 0.8 倍行高、首行缩进、水平无重叠、连字符续行）
 * - 分栏：item 级横向投影找留白带（双栏学术 PDF 必需，否则左右栏同基线行会合并成一行，
 *   导致涂白横跨两栏、阅读顺序交错）
 * - 页眉/页脚：与正文有显著垂直间隙的顶部/底部粗行，单独成块
 * - 公式以 {vN} 占位符内嵌进译文文本，与 pdf2zh 的占位符协议一致
 */

/** 单个文本片段（pdf.js textContent item 的几何化表示，页面坐标系：左上原点） */
export type SpanItem = {
  str: string;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  fontName: string;
  /** 公式/代码片段（按字体或字符集判定） */
  formula: boolean;
};

export type FormulaUnit = { type: "formula"; text: string; placeholder: string };
export type TextUnit = { type: "text"; text: string } | FormulaUnit;

export type TextLine = {
  items: SpanItem[];
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  baseline: number;
  size: number;
};

export type TextBlock = {
  id: number;
  lines: TextLine[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 段落主字号（行字号中位数） */
  size: number;
  /** 原文是否折行（决定译文可否重排，对应 pdf2zh 的 brk） */
  brk: boolean;
  /** 送翻译的文本：正文 + {vN} 公式占位符 */
  translateText: string;
  /** 供展示的原文 */
  displayText: string;
  units: TextUnit[];
  /** 整段均为公式/代码，无需翻译 */
  protectedOnly: boolean;
};

export type PageLayout = {
  pageNumber: number;
  width: number;
  height: number;
  blocks: TextBlock[];
};

/**
 * LaTeX/等宽/符号类字体名正则（来自 pdf2zh converter.py 的 vflag）。
 * 注意：不含 "Ital"——普通文档的斜体是强调而非公式，误判会让整段保留原文；
 * 数学斜体变量的保护依赖字符集与上下标字号比判据（阶段三引入版面模型后再加强）。
 */
const FORMULA_FONT_RE =
  /(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|Mono|Code|Sym|Math)/i;

/** CJK 字符（用于判断是否补空格） */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 剥离字体子集前缀（如 ABCDEF+CMMI10 → CMMI10）后按正则判定 */
export function isFormulaFont(fontName: string): boolean {
  const name = fontName.split("+").pop() ?? fontName;
  return FORMULA_FONT_RE.test(name);
}

/** 数学/修饰字符、希腊字母、解析失败的 (cid:N) */
export function isFormulaText(text: string): boolean {
  if (/\(cid:\d+\)/.test(text)) return true;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x370 && code < 0x400) return true;
    if (code < 0x80) continue;
    if (/\p{Lm}|\p{Mn}|\p{Sk}|\p{Sm}/u.test(ch)) return true;
  }
  return false;
}

function formulaRatio(text: string): number {
  if (!text) return 0;
  let hit = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    if (isFormulaText(ch)) hit += 1;
  }
  return total === 0 ? 0 : hit / total;
}

function joinWithSpace(a: string, b: string, gap: number, size: number): string {
  if (gap <= size * 0.25) return a + b;
  if (CJK_RE.test(a.slice(-1)) || CJK_RE.test(b.slice(0, 1))) return a + b;
  return `${a} `;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 按基线聚类成行（y 容差 0.45×字号），行内按 x 排序拼接；结果按页面自上而下排序 */
function clusterLines(items: SpanItem[]): TextLine[] {
  const sorted = [...items].sort((p, q) => p.baseline - q.baseline || p.x0 - q.x0);  const lines: TextLine[] = [];
  let bucket: SpanItem[] = [];
  let bucketBase = NaN;
  const flushLine = () => {
    if (bucket.length === 0) return;
    bucket.sort((p, q) => p.x0 - q.x0);
    // OCR 隐字层去重：文本相同且 x 区间高度重叠的相邻片段只保留一个
    const deduped: SpanItem[] = [];
    for (const it of bucket) {
      const prevD = deduped[deduped.length - 1];
      if (
        prevD &&
        prevD.str.trim() === it.str.trim() &&
        Math.min(prevD.x1, it.x1) - Math.max(prevD.x0, it.x0) >
          0.6 * Math.min(prevD.x1 - prevD.x0, it.x1 - it.x0)
      ) {
        continue;
      }
      deduped.push(it);
    }
    // 行内大间隙二次切分：OCR 常把页眉与正文首行、双栏同行合并成一个文本行，
    // 相邻片段横向间隙超过阈值（页眉与正文间的空档）时拆开；正常词间空格不受影响
    const segs: SpanItem[][] = [];
    let seg: SpanItem[] = [];
    for (const it of deduped) {
      const prevS = seg[seg.length - 1];
      if (prevS && it.x0 - prevS.x1 > Math.max(2.5 * it.size, 14)) {
        segs.push(seg);
        seg = [it];
      } else {
        seg.push(it);
      }
    }
    segs.push(seg);
    for (const segItems of segs) {
      if (segItems.length === 0) continue;
      const size = median(segItems.map((it2) => it2.size)) || 10;
      let text = "";
      let prev: SpanItem | null = null;
      for (const it of segItems) {
        text = prev ? joinWithSpace(text, it.str, it.x0 - prev.x1, size) + it.str : it.str;
        prev = it;
      }
      lines.push({
        items: segItems,
        text,
        x0: Math.min(...segItems.map((it2) => it2.x0)),
        x1: Math.max(...segItems.map((it2) => it2.x1)),
        y0: Math.min(...segItems.map((it2) => it2.baseline - it2.size * 0.85)),
        y1: Math.max(...segItems.map((it2) => it2.baseline + it2.size * 0.3)),
        baseline: segItems[0].baseline,
        size,
      });
    }
    bucket = [];
  };
  for (const it of sorted) {
    if (bucket.length === 0) {
      bucketBase = it.baseline;
      bucket.push(it);
    } else if (Math.abs(it.baseline - bucketBase) <= Math.max(1.5, it.size * 0.45)) {
      bucket.push(it);
    } else {
      flushLine();
      bucketBase = it.baseline;
      bucket = [it];
    }
  }
  flushLine();
  return lines;
}

/** 行 → 段落 → 块（含公式占位与抗噪 bbox），输入行需属于同一栏 */
function buildBlocksFromLines(inputLines: TextLine[]): TextBlock[] {
  if (inputLines.length === 0) return [];
  const lines = [...inputLines];

  // 行内公式标注：字体 / 字符集 / 上下标字号比 0.79
  for (const line of lines) {
    for (const it of line.items) {
      it.formula =
        isFormulaFont(it.fontName) ||
        formulaRatio(it.str) >= 0.6 ||
        it.size < line.size * 0.79;
    }
  }

  // 段落聚类（pdf2zh ocr.py 的几何规则）：按基线自上而下（左上原点：基线小 = 靠上）
  lines.sort((p, q) => p.baseline - q.baseline);
  const chunks: TextLine[][] = [];
  let chunk: TextLine[] = [];
  let chunkLeft = 0;
  for (const line of lines) {
    if (chunk.length === 0) {
      chunk = [line];
      chunkLeft = line.x0;
      continue;
    }
    const prev = chunk[chunk.length - 1];
    const lineHeight = Math.max(prev.size, line.size);
    const vGap = line.y0 - prev.y1;
    const noOverlap = line.x0 >= prev.x1 - 1 || line.x1 <= prev.x0 + 1;
    const indent = line.x0 > chunkLeft + lineHeight * 0.8;
    const hyphen = prev.text.endsWith("-") && /^[a-z]/.test(line.text);
    if (!hyphen && (vGap > lineHeight * 0.8 || noOverlap || indent)) {
      chunks.push(chunk);
      chunk = [line];
      chunkLeft = line.x0;
    } else {
      chunk.push(line);
      chunkLeft = Math.min(chunkLeft, line.x0);
    }
  }
  if (chunk.length > 0) chunks.push(chunk);

  return chunks.map((chunkLines) => buildBlock(chunkLines));
}

function buildBlock(chunkLines: TextLine[]): TextBlock {
  const units: TextUnit[] = [];
  let textBuf = "";
  let formulaBuf = "";
  let prev: SpanItem | null = null;
  let vCount = 0;
  const flushText = () => {
    if (textBuf.trim()) units.push({ type: "text", text: textBuf });
    textBuf = "";
  };
  const flushFormula = () => {
    if (formulaBuf.trim()) {
      vCount += 1;
      units.push({ type: "formula", text: formulaBuf, placeholder: `{v${vCount}}` });
    }
    formulaBuf = "";
  };
  for (const line of chunkLines) {
    for (const it of line.items) {
      const gap = prev ? it.x0 - prev.x1 : 0;
      const space = prev ? joinWithSpace("", it.str, gap, line.size).length > 0 : false;
      if (it.formula) {
        flushText();
        if (space && formulaBuf && !/\s$/.test(formulaBuf)) formulaBuf += " ";
        formulaBuf += it.str;
      } else if (formulaBuf) {
        // 括号/短标点并入公式组（对应 pdf2zh 的括号配对）
        const t = it.str.trim();
        if (t.length <= 2 && !t.includes("$") && /^[\p{P}\p{S}]+$/u.test(t)) {
          formulaBuf += (space && !/\s$/.test(formulaBuf) ? " " : "") + it.str;
        } else {
          flushFormula();
          if (space && textBuf && !/\s$/.test(textBuf)) textBuf += " ";
          textBuf += it.str;
        }
      } else {
        if (space && textBuf && !/\s$/.test(textBuf)) textBuf += " ";
        textBuf += it.str;
      }
      prev = it;
    }
  }
  flushText();
  flushFormula();

  let translateText = "";
  units.forEach((u, i) => {
    const piece = u.type === "text" ? u.text : u.placeholder;
    if (i > 0) {
      const before = translateText.slice(-1);
      const after = piece.slice(0, 1);
      const bothLatin =
        /[\w\)\]]/.test(before) && /[\w\{\(\[]/.test(after) && !CJK_RE.test(before) && !CJK_RE.test(after);
      if (bothLatin) translateText += " ";
    }
    translateText += piece;
  });

  const allSizes = chunkLines.map((l) => l.size);
  // bbox 抗噪：y 由首末基线 + 中位字号决定（避免单行 OCR 抖动撑大框），
  // x 左界取中位数（正文左边）、右界取 90 分位（容忍右缘噪声）
  const medSize = median(allSizes);
  const xs0 = chunkLines.map((l) => l.x0).sort((a, b) => a - b);
  const xs1 = chunkLines.map((l) => l.x1).sort((a, b) => a - b);
  const x0 = xs0[Math.floor(xs0.length / 2)];
  const x1 = xs1[Math.min(xs1.length - 1, Math.floor(xs1.length * 0.9))];
  const y0 = chunkLines[0].baseline - medSize * 0.95;
  const y1 = chunkLines[chunkLines.length - 1].baseline + medSize * 0.3;
  const textUnits = units.filter((u) => u.type === "text");
  return {
    id: 0,
    lines: chunkLines,
    x0,
    y0,
    x1,
    y1,
    size: medSize,
    brk: chunkLines.length > 1,
    translateText: translateText.trim(),
    displayText: chunkLines.map((l) => l.text).join(" ").replace(/(\w)- (\w)/g, "$1$2"),
    units,
    protectedOnly: textUnits.length === 0,
  };
}

/**
 * 分栏：行级横向投影做"谷底探测"——找中央区域覆盖行数最少的 x。
 * 页眉等横跨分栏线的行只贡献 1 行覆盖（tol 按行数比例放大），不再阻挡分栏。
 */
function findColumnCut(lines: TextLine[], pageWidth: number): number | null {
  const W = Math.max(8, Math.round(pageWidth));
  const cover = new Uint16Array(W + 1);
  for (const l of lines) {
    const lo = Math.max(0, Math.min(W, Math.round(l.x0)));
    const hi = Math.max(0, Math.min(W, Math.round(l.x1)));
    for (let x = lo; x <= hi; x++) cover[x] += 1;
  }
  const tol = Math.max(1, Math.floor(lines.length * 0.08));
  const lo = Math.round(W * 0.18);
  const hi = Math.round(W * 0.82);
  // 平滑：窗口内取最大值，腐蚀孤立噪声尖刺
  const win = Math.max(2, Math.round(W * 0.01));
  const smooth = new Uint16Array(W + 1);
  for (let x = lo; x <= hi; x++) {
    let m = 0;
    for (let k = Math.max(0, x - win); k <= Math.min(W, x + win); k++) {
      m = Math.max(m, cover[k]);
    }
    smooth[x] = m;
  }
  let minX = -1;
  let minVal = Infinity;
  for (let x = lo; x <= hi; x++) {
    if (smooth[x] < minVal) {
      minVal = smooth[x];
      minX = x;
    }
  }
  if (minX < 0) return null;
  const probe = Math.max(4, Math.round(W * 0.04));
  const leftVal = smooth[Math.max(lo, minX - probe)];
  const rightVal = smooth[Math.min(hi, minX + probe)];
  const valleyOk = minVal <= tol;
  const sidesOk = Math.min(leftVal, rightVal) >= Math.max(3, lines.length * 0.3);
  return valleyOk && sidesOk ? minX : null;
}

/**
 * 把行分入各栏（递归支持三栏）；横跨切割线的行（页眉/页脚类）单独返回。
 * 跨栏行不再污染栏内识别，也不再有整页宽的合并块。
 */
function splitColumns(
  lines: TextLine[],
  pageWidth: number,
  depth: number,
): { columns: TextLine[][]; crossed: TextLine[] } {
  if (lines.length === 0) return { columns: [], crossed: [] };
  if (depth >= 2) return { columns: [lines], crossed: [] };
  const cut = findColumnCut(lines, pageWidth);
  if (cut === null) return { columns: [lines], crossed: [] };
  const half = Math.max(2, Math.round(pageWidth * 0.01));
  const crossed: TextLine[] = [];
  const rest: TextLine[] = [];
  for (const l of lines) {
    if (l.x0 < cut - half && l.x1 > cut + half) crossed.push(l);
    else rest.push(l);
  }
  if (rest.length === 0) return { columns: [lines], crossed: [] };
  const leftLines = rest.filter((l) => l.x1 <= cut + half);
  const rightLines = rest.filter((l) => l.x0 >= cut - half);
  const leftCols = splitColumns(leftLines, pageWidth, depth + 1);
  const rightCols = splitColumns(rightLines, pageWidth, depth + 1);
  return {
    columns: [...leftCols.columns, ...rightCols.columns].filter((c) => c.length > 0),
    crossed: [...crossed, ...leftCols.crossed, ...rightCols.crossed],
  };
}

/** 提取并识别一页的版面结构；itemsOverride 提供时跳过文本层（OCR 路径） */
export async function extractPageLayout(
  page: PDFPageProxy,
  opts?: { itemsOverride?: SpanItem[] },
): Promise<PageLayout> {
  const vp = page.getViewport({ scale: 1 });
  const pageHeight = vp.height;

  // 1. item → 几何片段（OCR 路径直接使用传入的片段）
  let items: SpanItem[] = opts?.itemsOverride ?? [];
  if (!opts?.itemsOverride) {
    const content = await page.getTextContent({ disableNormalization: true });
    for (const raw of content.items) {
      if (!("str" in raw)) continue;
      const it = raw as { str: string; transform: number[]; width: number; height: number; fontName?: string };
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      items.push({
        str: it.str,
        x0: e,
        x1: e + it.width,
        baseline: pageHeight - f,
        size,
        fontName: it.fontName ?? "",
        formula: false,
      });
    }
  }
  if (items.length === 0) {
    return { pageNumber: page.pageNumber, width: vp.width, height: pageHeight, blocks: [] };
  }

  // 2. 粗分行 → 行级谷底分栏；横跨切割线的行（页眉/页脚）单独成块
  //    页眉不再并入正文首段，也不会把块撑成整页宽
  const rough = clusterLines(items);
  const { columns, crossed } = splitColumns(rough, vp.width, 0);

  // 3. 识别顺序：横跨行（页眉/页脚）→ 各栏自上而下
  const blocks: TextBlock[] = [];
  if (crossed.length > 0) blocks.push(...buildBlocksFromLines(crossed));
  for (const col of columns) blocks.push(...buildBlocksFromLines(col));
  blocks.forEach((b, i) => (b.id = i));

  return {
    pageNumber: page.pageNumber,
    width: vp.width,
    height: pageHeight,
    blocks,
  };
}
