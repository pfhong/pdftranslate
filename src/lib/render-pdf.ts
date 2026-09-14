/**
 * 译制 PDF 合成（移植 pdf2zh 的"涂白 + 回排"思路到 pdf-lib）：
 * 排印策略为**块级锚定**——不追求逐行原位还原，优先保证大致布局与语序：
 * - 原页整页保留（公式、图表天然不动）
 * - 已翻译段落：整块涂白，译文从块顶按**自然行距**（1.4×字号）向下排印，
 *   两端对齐、保留首行缩进；译文过长时逐级缩字号（下限 60%）
 * - 公式/代码段整块保留原样
 * - 另提供"双语交错页"导出（pdf2zh dual 模式：原页/译页交替）
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { PageLayout } from "./layout";

/** 自然行距 */
const LINE_HEIGHT = 1.4;
/** 译文超高时的最小字号比例 */
const MIN_SIZE_RATIO = 0.6;
/** 允许译文溢出块高的倍数（超出即触发缩字号，避免压到下一块） */
const OVERFLOW_ALLOWANCE = 1.1;

export type PageTranslations = Map<number, string>;
export type TranslationStore = Map<number, PageTranslations>;

type Font = PDFFont;

let cachedFontBytes: ArrayBuffer | null = null;

/** 加载中文排印字体（由 vite 插件提供 /fonts/zh.ttf） */
export async function loadFontBytes(): Promise<ArrayBuffer | null> {
  if (cachedFontBytes) return cachedFontBytes;
  try {
    const res = await fetch("/fonts/zh.ttf");
    if (!res.ok) return null;
    cachedFontBytes = await res.arrayBuffer();
    return cachedFontBytes;
  } catch {
    return null;
  }
}

/** 段落折行：首行宽度可不同于其余行（首行缩进），行尾标点不悬挂到下一行行首 */
function wrapParagraph(
  text: string,
  font: Font,
  size: number,
  firstWidth: number,
  restWidth: number,
): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const ch of text) {
    const maxW = lines.length === 0 ? firstWidth : restWidth;
    const next = cur + ch;
    if (cur && next.length > 1 && font.widthOfTextAtSize(next, size) > maxW) {
      if (/^[，。；：、！？）》”’\]]/.test(ch) && cur.length > 1) {
        // 标点不出现在行首：并入当前行（允许轻微超宽）
        lines.push(next);
        cur = "";
      } else {
        lines.push(cur);
        cur = ch === " " ? "" : ch;
      }
    } else {
      cur = next;
    }
  }
  if (cur.trim()) lines.push(cur);
  return lines;
}

/** 画一行：两端对齐（CJK 逐字、拉丁按词分配多余间隙），末行/单行左对齐 */
function drawLine(
  page: PDFPage,
  text: string,
  font: Font,
  size: number,
  x0: number,
  x1: number,
  yPdf: number,
  justify: boolean,
): void {
  const natural = font.widthOfTextAtSize(text, size);
  const target = x1 - x0;
  if (!justify || natural >= target) {
    page.drawText(text, { x: x0, y: yPdf, size, font });
    return;
  }
  const tokens =
    text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]+|\s+/g) ??
    [text];
  const extra = (target - natural) / Math.max(tokens.length - 1, 1);
  let x = x0;
  tokens.forEach((tk, i) => {
    page.drawText(tk, { x, y: yPdf, size, font });
    x += font.widthOfTextAtSize(tk, size);
    if (i < tokens.length - 1) x += extra;
  });
}

export type BuildInput = {
  layouts: Map<number, PageLayout>;
  translations: TranslationStore;
};

/**
 * 合成译制 PDF。无中文字体或无任何译文时返回 null。
 * 旋转页暂不替换（保留原样）。
 */
export async function buildTranslatedPdf(
  srcBytes: Uint8Array | ArrayBuffer,
  input: BuildInput,
): Promise<Uint8Array | null> {
  const fontBytes = await loadFontBytes();
  if (!fontBytes) return null;
  let hasAny = false;
  for (const t of input.translations.values()) if (t.size > 0) hasAny = true;
  if (!hasAny) return null;

  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  out.registerFontkit(fontkit);
  let font;
  try {
    font = await out.embedFont(fontBytes, { subset: true });
  } catch {
    font = await out.embedFont(fontBytes, { subset: false });
  }
  const f: Font = font;

  const pageCount = src.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const pageNum = i + 1;
    const [copied] = await out.copyPages(src, [i]);
    out.addPage(copied);
    const layout = input.layouts.get(pageNum);
    const trans = input.translations.get(pageNum);
    if (!layout || !trans || trans.size === 0) continue;

    const page = out.getPage(i);
    if (page.getRotation().angle % 360 !== 0) continue;
    const { height: pageHeight } = page.getSize();
    const white = rgb(1, 1, 1);

    // 第一遍：对有译文的段落双重涂白——先整块 bbox，再逐行行盒补充。
    // 抗噪 bbox 用分位数收缩过边界，离群行必须靠行盒覆盖，否则原文残影透出
    const pageJobs: { block: (typeof layout.blocks)[number]; translated: string }[] = [];
    for (const block of layout.blocks) {
      const translated = trans.get(block.id);
      if (!translated || block.protectedOnly) continue;
      const pad = 1.5;
      page.drawRectangle({
        x: block.x0 - pad,
        y: pageHeight - (block.y1 + pad),
        width: block.x1 - block.x0 + pad * 2,
        height: block.y1 - block.y0 + pad * 2,
        color: white,
      });
      for (const line of block.lines) {
        page.drawRectangle({
          x: line.x0 - 1,
          y: pageHeight - (line.baseline + line.size * 0.35 + 1),
          width: line.x1 - line.x0 + 2,
          height: line.size * 1.25 + 2,
          color: white,
        });
      }
      pageJobs.push({ block, translated });
    }

    // 第二遍：绘制译文（块级锚定：从块顶向下排，行距自适应原块行距，
    // 使译文块高度 ≈ 原块高度；保留首行缩进，两端对齐）
    for (const { block, translated } of pageJobs) {
      const origSize = block.size;
      const firstBase = block.lines[0].baseline;
      const lastBase = block.lines[block.lines.length - 1].baseline;
      const origLines = block.lines.length;
      const restWidth = block.x1 - block.x0;
      const indent = block.lines[0].x0 - block.x0;
      const hasIndent = indent > origSize * 0.5;
      const firstWidth = Math.max(restWidth - (hasIndent ? indent : 0), restWidth * 0.4);
      const blockHeight = block.y1 - block.y0;

      // 行距系数跟随原块实际行距（钳制在 1.05~1.6 倍字号）
      let pitchFactor = LINE_HEIGHT;
      if (origLines > 1) {
        const origPitch = (lastBase - firstBase) / (origLines - 1);
        pitchFactor = Math.min(Math.max(origPitch / origSize, 1.05), 1.6);
      }

      let size = origSize;
      let wrapped = wrapParagraph(translated, f, size, firstWidth, restWidth);
      while (
        wrapped.length * size * pitchFactor > blockHeight * OVERFLOW_ALLOWANCE &&
        size > origSize * MIN_SIZE_RATIO
      ) {
        size *= 0.9;
        wrapped = wrapParagraph(translated, f, size, firstWidth, restWidth);
      }

      wrapped.forEach((line, idx) => {
        const baseline = firstBase + idx * size * pitchFactor;
        const x0 = idx === 0 && hasIndent ? block.lines[0].x0 : block.x0;
        drawLine(
          page,
          line,
          f,
          size,
          x0,
          block.x1,
          pageHeight - baseline,
          idx < wrapped.length - 1,
        );
      });
    }
  }
  return out.save();
}

/** 双语交错页：原页 / 译页交替组成单文件（pdf2zh dual 形态） */
export async function buildDualPdf(
  originalBytes: Uint8Array | ArrayBuffer,
  translatedBytes: Uint8Array,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  const trans = await PDFDocument.load(translatedBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const count = Math.min(src.getPageCount(), trans.getPageCount());
  for (let i = 0; i < count; i++) {
    const [original] = await out.copyPages(src, [i]);
    const [translated] = await out.copyPages(trans, [i]);
    out.addPage(original);
    out.addPage(translated);
  }
  return out.save();
}

/** 保存/下载 PDF 字节：Tauri 走保存对话框写文件，浏览器走下载 */
export async function savePdfBytes(bytes: Uint8Array, suggestedName: string): Promise<boolean> {
  const isTauri = "__TAURI_INTERNALS__" in window;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return false;
    await writeFile(path, bytes);
    return true;
  }
  const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
