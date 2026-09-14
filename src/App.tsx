import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Languages } from "lucide-react";
import { Toolbar, type ViewMode } from "./components/Toolbar";
import { PdfViewer, type PdfViewerHandle, type TextSelection } from "./components/PdfViewer";
import { EmptyState } from "./components/EmptyState";
import { SettingsDialog } from "./components/SettingsDialog";
import { SelectionPopover } from "./components/SelectionPopover";
import { TranslationBar } from "./components/TranslationBar";
import { DualView, type JobState } from "./components/DualView";
import { ReadingView, type ReadingPage, type ReadingKind } from "./components/ReadingView";
import { loadDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from "./lib/pdf";
import { extractPageLayout, type PageLayout } from "./lib/layout";
import { ocrPageItems } from "./lib/ocr";
import {
  buildDualPdf,
  buildTranslatedPdf,
  loadFontBytes,
  savePdfBytes,
  type TranslationStore,
} from "./lib/render-pdf";
import { cacheGet, cacheKey, cacheSet } from "./lib/trans-cache";
import { dbg } from "./lib/debug-log";
import {
  llmChat,
  parseTermCandidates,
  termExtractionPrompt,
  loadTranslateConfig,
  providerLabel,
  runPool,
  saveTranslateConfig,
  translateBatch,
  translateText,
  type TranslateConfig,
} from "./lib/translate";
import {
  engineExtract,
  engineHealth,
  engineSynthesize,
  engineTranslateBabeldoc,
  engineTranslateProgress,
  glossaryActive,
  glossaryList,
  type EngineTranslation,
} from "./lib/engine";

/** BabelDOC 阶段名 → 中文文案 */
function stageLabel(stage: string, overall: number): string {
  const map: Record<string, string> = {
    prepare: "准备中",
    parse_pdf: "解析 PDF",
    detect_scanned: "检测扫描页",
    core_document_parse: "解析文档结构",
    document_il_parse: "版面分析（YOLO）",
    il_translate: "翻译中",
    llm_translate: "翻译中",
    apply_il_translator: "应用译文",
    parse_layout: "版面分析",
    compose: "合成译制 PDF",
    save_document: "保存译制 PDF",
    finish: "正在返回译制 PDF…",
  };
  const label = map[stage] ?? stage;
  return `BabelDOC · ${label} ${Math.round(overall)}%`;
}

/** 缩放档位（1 = 适应宽度） */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("tr-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 译文模式下的导出按钮（复用控制条按钮样式） */
function TranslationBarExports({
  onExportTranslated,
  onExportDual,
  canExportDual,
}: {
  onExportTranslated: () => void;
  onExportDual: () => void;
  canExportDual: boolean;
}) {
  const cls =
    "flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";
  return (
    <>
      <button type="button" className={cls} onClick={onExportTranslated}>
        导出译文 PDF
      </button>
      <button type="button" className={cls} onClick={onExportDual} disabled={!canExportDual}>
        导出双语对照
      </button>
    </>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const docTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);

  // 翻译相关状态
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [translateConfig, setTranslateConfig] = useState<TranslateConfig>(loadTranslateConfig);
  const configRef = useRef(translateConfig);
  useEffect(() => {
    configRef.current = translateConfig;
  }, [translateConfig]);

  // 双语对照与整本翻译管线
  const [viewMode, setViewMode] = useState<ViewMode>("source");
  const viewModeRef = useRef<ViewMode>("source");
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  const docBytesRef = useRef<Uint8Array | null>(null);
  const [forceRebuild, setForceRebuild] = useState(false);
  // 术语表：翻译前按文档全文取命中词条，注入提示词（BabelDOC 模式由引擎自行注入）
  const [useGlossary, setUseGlossary] = useState(
    () => localStorage.getItem("tr-use-glossary") !== "0",
  );
  const toggleUseGlossary = useCallback(() => {
    setUseGlossary((v) => {
      localStorage.setItem("tr-use-glossary", v ? "0" : "1");
      return !v;
    });
  }, []);
  // 锚定合成：译文保持原文段落位置（扫描件推荐）；关闭则用 BabelDOC 重排
  const [anchorLayout, setAnchorLayout] = useState(
    () => localStorage.getItem("tr-anchor-layout") !== "0",
  );
  const toggleAnchorLayout = useCallback(() => {
    setAnchorLayout((v) => {
      localStorage.setItem("tr-anchor-layout", v ? "0" : "1");
      return !v;
    });
  }, []);
  const toggleForceRebuild = useCallback(() => setForceRebuild((v) => !v), []);

  const layoutsRef = useRef<Map<number, PageLayout>>(new Map());
  const translationsRef = useRef<TranslationStore>(new Map());
  const translatedBytesRef = useRef<Uint8Array | null>(null);
  const [translatedDoc, setTranslatedDoc] = useState<PDFDocumentProxy | null>(null);
  const translatedTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const enginePagesRef = useRef<import("./lib/engine").EngineExtractResult | null>(null);
  const dualBytesRef = useRef<Uint8Array | null>(null);

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  const [translatedPages, setTranslatedPages] = useState(0);
  /** 译文版本号：每轮翻译完成后自增，用于让阅读视图刷新（译文存在 ref 中） */
  const [translatedVersion, setTranslatedVersion] = useState(0);
  // 阅读视图偏好（字号 / 是否逐段对照原文）
  const [readingFontSize, setReadingFontSize] = useState(
    () => Number(localStorage.getItem("tr-read-font") ?? 16),
  );
  const [readingOriginal, setReadingOriginal] = useState(
    () => localStorage.getItem("tr-read-original") === "1",
  );
  const [job, setJob] = useState<JobState | null>(null);
  const jobCancelRef = useRef(false);
  /** BabelDOC 运行期间轮询引擎进度（阶段文案 + 总进度条） */
  const pollBabeldocProgress = useCallback((signal: { stop: boolean }) => {
    const timer = window.setInterval(() => {
      if (signal.stop) {
        window.clearInterval(timer);
        return;
      }
      void engineTranslateProgress().then((p) => {
        if (signal.stop || !p || p.error) return;
        setJob({
          running: true,
          doneBlocks: Math.round(p.overall),
          totalBlocks: 100,
          phase: 'translate' as const,
          stageText: stageLabel(p.stage, p.overall),
        });
      });
    }, 1200);
    return () => {
      signal.stop = true;
      window.clearInterval(timer);
    };
  }, []);

  const [fontMissing, setFontMissing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [engineOnline, setEngineOnline] = useState(false);
  const engineRef = useRef(false);

  useEffect(() => {
    void engineHealth().then((ok) => {
      engineRef.current = ok;
      setEngineOnline(ok);
    });
  }, []);

  useEffect(() => {
    void loadFontBytes().then((bytes) => setFontMissing(bytes === null));
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<PdfViewerHandle>(null);
  const numPages = doc?.numPages ?? 0;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("tr-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = fileName ? `${fileName} - Transfer Reader` : "Transfer Reader";
  }, [fileName]);

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  const openFile = useCallback(async (file: File) => {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      setError("请选择 PDF 格式的文件");
      return;
    }
    setError(null);
    setLoading(true);
    setRenderError(null);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      // pdf.js 会 transfer 底层缓冲区，先留一份原始字节供译制 PDF 合成
      docBytesRef.current = data.slice();
      layoutsRef.current = new Map();
      translationsRef.current = new Map();
      translatedBytesRef.current = null;
      setTranslatedDoc(null);
      setTranslatedPages(0);
      setJob(null);
      setSelection(null);
      const task = loadDocument(data);
      const next = await task.promise;
      const old = docTaskRef.current;
      docTaskRef.current = task;
      setDoc(next);
      // 临时调试钩子（诊断版面识别用）
      (window as unknown as Record<string, unknown>).__trDebug = {
        getPage: (n: number) => next.getPage(n),
        extractPageLayout,
      };
      setFileName(file.name.replace(/\.pdf$/i, ""));
      setPage(1);
      setZoom(1);
      void old?.destroy();
    } catch (err) {
      console.error(err);
      setError("无法打开该 PDF 文件");
    } finally {
      setLoading(false);
    }
  }, []);

  const gotoPage = useCallback(
    (n: number) => {
      const clamped = Math.min(Math.max(n, 1), Math.max(numPages, 1));
      setPage(clamped);
      viewerRef.current?.scrollToPage(clamped);
    },
    [numPages],
  );

  const zoomIn = useCallback(() => {
    setZoom((z) => ZOOM_STEPS.find((s) => s > z + 1e-6) ?? z);
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? z);
  }, []);

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        openPicker();
        return;
      }
      if (!doc) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        gotoPage(page - 1);
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        gotoPage(page + 1);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomOut();
      } else if (mod && e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, page, gotoPage, zoomIn, zoomOut, openPicker]);

  const zoomPercent = Math.round(fitScale * zoom * 100);

  // 划词结果上报（滚动/取消选择时也会传 null）
  const handleTextSelection = useCallback((sel: TextSelection | null) => {
    setSelection(sel);
  }, []);

  const saveTranslateSettings = useCallback((next: TranslateConfig) => {
    setTranslateConfig(next);
    saveTranslateConfig(next);
  }, []);

  // ─── 整本翻译管线 ───────────────────────────────────────────

  /** 获取一页版面：OCR 开启时用 PP-OCR 重新识别，否则用内嵌文本层 */
  const getLayout = useCallback(
    async (pg: PDFPageProxy, pageNum: number): Promise<PageLayout> => {
      const cached = layoutsRef.current.get(pageNum);
      if (cached) return cached;
      let layout: PageLayout;
      if (forceRebuild) {
        setJob((j) => (j ? { ...j, phase: "ocr" } : j));
        const items = await ocrPageItems(pg);
        layout = await extractPageLayout(pg, { itemsOverride: items });
      } else {
        layout = await extractPageLayout(pg);
      }
      layoutsRef.current.set(pageNum, layout);
      return layout;
    },
    [forceRebuild],
  );

  const countTranslatedPages = useCallback(() => {
    let n = 0;
    for (const blocks of translationsRef.current.values()) {
      if (blocks.size > 0) n += 1;
    }
    return n;
  }, []);

  /** 批量翻译目标段落：8 段/批 + 4 路并发，缺失项逐段兜底重试 */
  const translateTargets = useCallback(
    async (targets: { page: number; id: number; text: string }[]) => {
      // 一页一次请求：模型能看到整页上下文，译法更一致、段落衔接更自然；
      // 页与页之间仍并发（见下方 runPool 的 limit）。超长页再按字符数切分。
      const PAGE_MAX_CHARS = 6000;
      const byPage = new Map<number, number[]>();
      targets.forEach((t, i) => {
        const list = byPage.get(t.page) ?? [];
        list.push(i);
        byPage.set(t.page, list);
      });
      const batches: number[][] = [];
      for (const [, idxs] of byPage) {
        let chars = 0;
        let cur: number[] = [];
        for (const i of idxs) {
          const len = targets[i].text.length;
          if (cur.length > 0 && chars + len > PAGE_MAX_CHARS) {
            batches.push(cur);
            cur = [];
            chars = 0;
          }
          cur.push(i);
          chars += len;
        }
        if (cur.length > 0) batches.push(cur);
      }
      // 术语表：只取全文命中的词条，生成提示词块（两条路径都注入；BabelDOC 由引擎注入）
      let glossaryBlock: string | undefined;
      const profile = configRef.current.profiles.find(
        (p) => p.id === configRef.current.activeId,
      );
      if (useGlossary && profile) {
        const entries = await glossaryActive(
          targets.map((t) => t.text).join("\n"),
          configRef.current.targetLang,
        );
        if (entries.length > 0) {
          glossaryBlock = [
            "## Glossary",
            "",
            "Always use the glossary's **Target Term** for any occurrence of its **Source Term**.",
            "Unlisted terms are translated naturally.",
            "",
            "| Source Term | Target Term |",
            "|-------------|-------------|",
            ...entries.map(([src, tgt]) => `| ${src} | ${tgt} |`),
          ].join("\n");
        }
      }
      const model = profile?.model ?? "";
      const providerId = configRef.current.activeId;
      let done = 0;
      await runPool(
        batches,
        6,
        async (batch) => {
          const texts = batch.map((i) => targets[i].text);
          const keys = texts.map((t) =>
            cacheKey(providerId, model, configRef.current.targetLang, t),
          );
          const results: (string | null)[] = keys.map((k) => cacheGet(k));
          const pending = texts
            .map((_t, k) => (results[k] === null ? k : -1))
            .filter((k) => k >= 0);
          if (pending.length > 0) {
            let fresh: (string | null)[] = [];
            try {
              fresh = await translateBatch(
                pending.map((k) => texts[k]),
                configRef.current,
                glossaryBlock,
              );
            } catch (err) {
              console.warn("批量翻译失败，降级为逐段", err);
              fresh = pending.map(() => null);
            }
            pending.forEach((k, idx) => {
              const value = fresh[idx];
              results[k] = value;
              if (value) cacheSet(keys[k], value);
            });
          }
          for (let k = 0; k < batch.length; k++) {
            if (results[k] === null) {
              try {
                results[k] = await translateText(texts[k], configRef.current, glossaryBlock);
                if (results[k]) cacheSet(keys[k], results[k] as string);
              } catch (err) {
                console.warn(`第 ${targets[batch[k]].page} 页段落翻译失败`, err);
              }
            }
          }
          for (let k = 0; k < batch.length; k++) {
            const t = targets[batch[k]];
            if (results[k] !== null) {
              const pageTrans = translationsRef.current.get(t.page) ?? new Map<number, string>();
              translationsRef.current.set(t.page, pageTrans);
              pageTrans.set(t.id, results[k] as string);
            }
            done += 1;
            setJob((j) => (j ? { ...j, doneBlocks: done } : j));
          }
          setTranslatedPages(countTranslatedPages());
          setTranslatedVersion((v) => v + 1);
        },
        () => jobCancelRef.current,
      );
    },
    [countTranslatedPages, useGlossary],
  );

  /** 提取整本文档的版面并汇总待翻译段落（引擎优先，本地管线降级） */
  const collectTargets = useCallback(async (): Promise<{ page: number; id: number; text: string }[] | null> => {
    const allTargets: { page: number; id: number; text: string }[] = [];
    if (engineRef.current && docBytesRef.current) {
      const result = await engineExtract(docBytesRef.current);
      enginePagesRef.current = result;
      for (const pg of result.pages) {
        for (const b of pg.blocks) {
          if (b.text.trim()) allTargets.push({ page: pg.pageNumber, id: b.index, text: b.text });
        }
      }
      return allTargets;
    }
    if (!doc) return null;
    for (let p = 1; p <= numPages; p++) {
      if (jobCancelRef.current) return null;
      const pg = await doc.getPage(p);
      const layout = await getLayout(pg, p);
      for (const b of layout.blocks) {
        if (!b.protectedOnly && b.translateText.trim()) {
          allTargets.push({ page: p, id: b.id, text: b.translateText });
        }
      }
    }
    return allTargets;
  }, [doc, numPages, getLayout]);

  /**
   * 术语自动抽取：引擎提取文档文本 → 模型给出候选术语对。
   * 只在内存中返回候选，由用户在设置里审阅后保存（不自动写入）。
   */
  const extractTerms = useCallback(async (): Promise<
    { source: string; target: string }[]
  > => {
    if (!docBytesRef.current) throw new Error("请先打开 PDF 文件。");
    const profile = configRef.current.profiles.find(
      (p) => p.id === configRef.current.activeId,
    );
    if (!profile || configRef.current.activeId === "mock") {
      throw new Error("术语抽取需要真实翻译供应商，请先在「翻译供应商」页配置。");
    }
    const extracted = await engineExtract(docBytesRef.current);
    const text = extracted.pages
      .flatMap((p) => p.blocks.map((b) => b.text))
      .filter((t) => t.trim())
      .join("\n")
      .slice(0, 8000);
    if (!text.trim()) throw new Error("文档没有可抽取的文本（可能是纯图片扫描件）。");

    const raw = await llmChat(
      [
        { role: "system", content: "你是严谨的文档术语抽取器，只输出 JSON。" },
        { role: "user", content: termExtractionPrompt(text, configRef.current.targetLang) },
      ],
      configRef.current,
    );
    const candidates = parseTermCandidates(raw);

    // 去重：排除已在术语表中的源词，并按文档中出现的频次排序
    const existing = new Set((await glossaryList()).map((e) => e.source.trim().toLowerCase()));
    const seen = new Set<string>();
    const scored = candidates
      .map((c) => {
        const key = c.source.trim().toLowerCase();
        const occurrences = text.toLowerCase().split(key).length - 1;
        return { ...c, key, occurrences };
      })
      .filter((c) => c.key && !existing.has(c.key) && !seen.has(c.key) && (seen.add(c.key), true))
      .sort((a, b) => b.occurrences - a.occurrences);
    return scored.map(({ source, target }) => ({ source, target }));
  }, []);

  /** 用当前缓存重新合成译制 PDF 并加载到右栏 */
  const rebuildPreview = useCallback(async () => {
    try {
      // 引擎路径：PyMuPDF redaction + htmlbox 合成
      if (engineRef.current && docBytesRef.current && translationsRef.current.size > 0) {
        const translations: EngineTranslation[] = [];
        for (const [pg, blocks] of translationsRef.current) {
          const pageData = enginePagesRef.current?.pages.find((p) => p.pageNumber === pg);
          if (!pageData) continue;
          for (const [block, text] of blocks) {
            const blk = pageData.blocks.find((b) => b.index === block);
            if (!blk) continue;
            translations.push({
              page: pg,
              block,
              bbox: blk.bbox,
              lines: blk.lines.map((l) => l.bbox),
              text,
            });
          }
        }
        if (translations.length > 0) {
          const bytes = await engineSynthesize(docBytesRef.current, translations);
          // pdf.js 会 transfer 缓冲区，留一份字节用于导出
          translatedBytesRef.current = bytes.slice();
          const task = loadDocument(bytes);
          const next = await task.promise;
          const oldTask = translatedTaskRef.current;
          translatedTaskRef.current = task;
          setTranslatedDoc(next);
          void oldTask?.destroy();
          setPreviewError(null);
          return;
        }
      }
      if (!docBytesRef.current) return;
      const bytes = await buildTranslatedPdf(docBytesRef.current, {
        layouts: layoutsRef.current,
        translations: translationsRef.current,
      });
      if (!bytes) {
        setFontMissing((await loadFontBytes()) === null);
        return;
      }
      // pdf.js 会 transfer 缓冲区，留一份字节用于导出
      translatedBytesRef.current = bytes.slice();
      const task = loadDocument(bytes);
      const next = await task.promise;
      const oldTask = translatedTaskRef.current;
    translatedTaskRef.current = task;
    setTranslatedDoc(next);
    void oldTask?.destroy();
    setPreviewError(null);
    } catch (err) {
      console.error("译制 PDF 合成失败", err);
      setPreviewError((err as Error).message ?? String(err));
    }
  }, []);

  /** 锚定合成：引擎提取版面 → 逐段翻译 → 引擎合成（译文保留原文段落位置） */
  const translateAnchored = useCallback(
    async (onlyPage?: number) => {
      dbg("anchored", "start", { onlyPage: onlyPage ?? null });
      if (!doc || !docBytesRef.current) {
        dbg("anchored", "abort: no doc/bytes");
        return;
      }
      const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
      if (translateConfig.activeId === "mock" || !profile) {
        setPreviewError("需要真实翻译后端，请在翻译设置中选择并配置供应商。");
        return;
      }
      try {
        setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: "layout" });
        dbg("anchored", "extracting via engine", { forceRebuild });
        const extracted = await engineExtract(docBytesRef.current, forceRebuild);
        dbg("anchored", "extract done", { pages: extracted.pages.length, modes: extracted.pages.map((p) => p.mode).join(",") });
        enginePagesRef.current = extracted;
        const pagesToDo = onlyPage
          ? extracted.pages.filter((p) => p.pageNumber === onlyPage)
          : extracted.pages;
        const targets = pagesToDo.flatMap((p) =>
          p.blocks
            .filter((b) => b.text.trim())
            .map((b) => ({ page: p.pageNumber, id: b.index, text: b.text })),
        );
        dbg("anchored", "translating targets", { count: targets.length });
        setJob({ running: true, doneBlocks: 0, totalBlocks: targets.length, phase: "translate" });
        await translateTargets(targets);
        dbg("anchored", "targets translated", { done: targets.length });
        // 汇总译文 → 引擎按原段落框合成
        const translations: EngineTranslation[] = [];
        for (const [pg, blocks] of translationsRef.current) {
          const pageData = extracted.pages.find((p) => p.pageNumber === pg);
          if (!pageData) continue;
          for (const [block, text] of blocks) {
            const blk = pageData.blocks.find((b) => b.index === block);
            if (!blk) continue;
            translations.push({
              page: pg,
              block,
              bbox: blk.bbox,
              lines: blk.lines.map((l) => l.bbox),
              text,
            });
          }
        }
        dbg("anchored", "synthesizing", { translations: translations.length });
        const mono = await engineSynthesize(docBytesRef.current, translations);
        dbg("anchored", "synthesized", { bytes: mono.length });
        translatedBytesRef.current = mono.slice();
        const task = loadDocument(mono);
        const next = await task.promise;
        const oldTask = translatedTaskRef.current;
        translatedTaskRef.current = task;
        setTranslatedDoc(next);
        void oldTask?.destroy();
        dualBytesRef.current = null;
        setTranslatedPages((n) => Math.max(n, onlyPage ?? numPages));
        setPreviewError(null);
        // 刚翻译完就把视图切到译文：用户翻译的目的通常是读译文（再点一下即可切回原文）
        if (viewModeRef.current === "source") setViewMode("target");
      } catch (err) {
        console.error(err);
        setPreviewError((err as Error).message ?? String(err));
      } finally {
        setJob(null);
      }
    },
    [doc, numPages, translateConfig, forceRebuild, translateTargets],
  );

  /**
   * 阅读视图数据：把识别出的块按阅读顺序整理成段落，并带上译文。
   * 只依赖版面识别 + 译文，不参与 PDF 合成——因此不受原段落框约束。
   */
  /** 估算各栏正文左边界：取出现次数最多的两个 x0（双栏页会有两个） */
  const bodyMargins = (xs: number[]): number[] => {
    const buckets = new Map<number, number>();
    for (const x of xs) {
      const key = Math.round(x / 4) * 4;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([k]) => k);
  };

  const classifyKind = (
    bold: boolean,
    x0: number,
    margins: number[],
    text: string,
    isProtected: boolean,
  ): ReadingKind => {
    if (isProtected) return "formula";
    if (bold) return "heading";
    const nearest = margins.reduce(
      (best, m) => (Math.abs(x0 - m) < Math.abs(x0 - best) ? m : best),
      margins[0] ?? 0,
    );
    // 相对最近栏边界缩进且不是长段落 → 视为引文/缩进块
    return x0 - nearest > 20 && text.length < 400 ? "quote" : "paragraph";
  };

  const readingPages: ReadingPage[] = useMemo(() => {
    void translatedVersion; // 依赖译文版本，翻译完成后重算
    const out: ReadingPage[] = [];
    const engine = enginePagesRef.current;
    const trans = translationsRef.current;

    if (engine) {
      for (const pg of engine.pages) {
        const raw = pg.blocks.filter(
          (b) => (b.text ?? "").trim() || b.lines.some((l) => (l.text ?? "").trim()),
        );
        if (raw.length === 0) continue;
        const margins = bodyMargins(raw.map((b) => b.bbox[0]));
        const pageTrans = trans.get(pg.pageNumber);
        out.push({
          page: pg.pageNumber,
          translated: (pageTrans?.size ?? 0) > 0,
          blocks: raw.map((b) => {
            const text = (b.text ?? "").trim();
            const original = text || b.lines.map((l) => l.text ?? "").join(" ");
            const kind = classifyKind(
              !!b.bold,
              b.bbox[0],
              margins,
              original,
              !text,
            );
            return {
              id: b.index,
              kind,
              original,
              translated: pageTrans?.get(b.index),
            };
          }),
        });
      }
      return out;
    }

    // 本地兜底管线：layoutsRef（PageLayout）
    for (const [page, layout] of layoutsRef.current) {
      const raw = layout.blocks;
      if (raw.length === 0) continue;
      const margins = bodyMargins(raw.map((b) => b.x0));
      const pageTrans = trans.get(page);
      out.push({
        page,
        translated: (pageTrans?.size ?? 0) > 0,
        blocks: raw.map((b) => {
          const original = b.protectedOnly ? b.displayText : b.translateText;
          const kind = classifyKind(
            b.size > layout.blocks[0].size * 1.08 && original.length < 80,
            b.x0,
            margins,
            original,
            b.protectedOnly,
          );
          return { id: b.id, kind, original, translated: pageTrans?.get(b.id) };
        }),
      });
    }
    out.sort((a, b) => a.page - b.page);
    return out;
  }, [translatedVersion]);

  const translateAll = useCallback(async () => {
    if (!doc || job?.running) return;
    jobCancelRef.current = false;
    // 引擎在线：整本翻译走 BabelDOC 完整管线（YOLO 版面 + 字符级重排）
    if (anchorLayout) {
      await translateAnchored();
      return;
    }
    if (engineRef.current && docBytesRef.current) {
      const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
      if (translateConfig.activeId === "mock" || !profile) {
        setPreviewError("BabelDOC 需要真实翻译后端，请在翻译设置中选择并配置供应商。");
        return;
      }
      setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: "layout" });
      const pollSignal = { stop: false };
      const stopPolling = pollBabeldocProgress(pollSignal);
      try {
        const result = await engineTranslateBabeldoc(
          docBytesRef.current,
          {
            baseUrl: profile.baseURL,
            apiKey: profile.apiKey,
            model: profile.model,
          },
          { targetLangName: translateConfig.targetLang, forceRebuild, useGlossary },
        );
        if (result.mono) {
          const monoBytes = base64ToBytes(result.mono);
          translatedBytesRef.current = monoBytes.slice();
          const task = loadDocument(monoBytes);
          const next = await task.promise;
          const oldTask = translatedTaskRef.current;
          translatedTaskRef.current = task;
          setTranslatedDoc(next);
          void oldTask?.destroy();
        }
        if (result.dual) {
          dualBytesRef.current = base64ToBytes(result.dual);
        }
        setTranslatedPages((n) => Math.max(n, numPages));
        setPreviewError(null);
        if (viewModeRef.current === "source") setViewMode("target");
      } catch (err) {
        console.error(err);
        setPreviewError((err as Error).message ?? String(err));
      } finally {
        stopPolling();
        setJob(null);
      }
      return;
    }
    setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: forceRebuild ? "ocr" : "layout" });
    const targets = await collectTargets();
    if (!targets || jobCancelRef.current) {
      setJob(null);
      return;
    }
    setJob({ running: true, doneBlocks: 0, totalBlocks: targets.length, phase: "translate" });
    await translateTargets(targets);
    setJob(null);
    await rebuildPreview();
  }, [doc, job, translateConfig, collectTargets, translateTargets, rebuildPreview]);

  /** 翻译指定页（默认当前页）。右键菜单会传入右键所在的页码。 */
  const translateCurrent = useCallback(async (targetPage?: number) => {
    dbg("translateCurrent", "invoked", { targetPage, currentPage: page, engine: engineRef.current, anchor: anchorLayout, hasBytes: !!docBytesRef.current });
    if (!doc || job?.running) {
      dbg("translateCurrent", "skipped", { noDoc: !doc, jobRunning: job?.running ?? false });
      return;
    }
    const pageNo = targetPage ?? page;
    if (pageNo < 1 || pageNo > numPages) {
      dbg("translateCurrent", "page out of range", { pageNo, numPages });
      return;
    }
    jobCancelRef.current = false;
    // 引擎在线：当前页也走 BabelDOC 完整管线（pages 参数只译本页），质量与整本一致
    if (anchorLayout) {
      dbg("translateCurrent", "route: anchored");
      await translateAnchored(pageNo);
      return;
    }
    if (engineRef.current && docBytesRef.current) {
      const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
      if (translateConfig.activeId === "mock" || !profile) {
        setPreviewError("BabelDOC 需要真实翻译后端，请在翻译设置中选择并配置供应商。");
        return;
      }
      setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: "layout" });
      const pollSignal = { stop: false };
      const stopPolling = pollBabeldocProgress(pollSignal);
      try {
        const result = await engineTranslateBabeldoc(
          docBytesRef.current,
          {
            baseUrl: profile.baseURL,
            apiKey: profile.apiKey,
            model: profile.model,
          },
          { targetLangName: translateConfig.targetLang, pages: String(pageNo), forceRebuild, useGlossary },
        );
        if (result.mono) {
          const monoBytes = base64ToBytes(result.mono);
          translatedBytesRef.current = monoBytes.slice();
          const task = loadDocument(monoBytes);
          const next = await task.promise;
          const oldTask = translatedTaskRef.current;
          translatedTaskRef.current = task;
          setTranslatedDoc(next);
          void oldTask?.destroy();
        }
        if (result.dual) {
          dualBytesRef.current = base64ToBytes(result.dual);
        }
        setTranslatedPages((n) => Math.max(n, pageNo));
        setPreviewError(null);
        if (viewModeRef.current === "source") setViewMode("target");
      } catch (err) {
        console.error(err);
        setPreviewError((err as Error).message ?? String(err));
      } finally {
        stopPolling();
        setJob(null);
      }
      return;
    }
    setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: forceRebuild ? "ocr" : "layout" });
    const pg = await doc.getPage(page);
    const layout = await getLayout(pg, page);
    const targets = layout.blocks
      .filter((b) => !b.protectedOnly && b.translateText.trim())
      .map((b) => ({ page, id: b.id, text: b.translateText }));
    setJob({ running: true, doneBlocks: 0, totalBlocks: targets.length, phase: "translate" });
    await translateTargets(targets);
    setJob(null);
    await rebuildPreview();
  }, [doc, job, page, translateConfig, getLayout, translateTargets, rebuildPreview]);

  const cancelJob = useCallback(() => {
    jobCancelRef.current = true;
  }, []);

  const exportTranslated = useCallback(async () => {
    const bytes = translatedBytesRef.current;
    if (!bytes) return;
    await savePdfBytes(bytes.slice(), `${fileName ?? "document"}_译文.pdf`);
  }, [fileName]);

  const exportDual = useCallback(async () => {
    // BabelDOC 已生成原生 dual（原/译交错），直接导出
    if (dualBytesRef.current) {
      await savePdfBytes(dualBytesRef.current.slice(), `${fileName ?? "document"}_双语对照.pdf`);
      return;
    }
    const bytes = translatedBytesRef.current;
    if (!bytes || !docBytesRef.current) return;
    const dual = await buildDualPdf(docBytesRef.current, bytes);
    await savePdfBytes(dual, `${fileName ?? "document"}_双语对照.pdf`);
  }, [fileName]);

  return (
    <div
      className="flex h-dvh flex-col bg-neutral-50 dark:bg-neutral-950"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) void openFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void openFile(file);
          e.target.value = "";
        }}
      />

      <Toolbar
        fileName={fileName}
        page={page}
        numPages={numPages}
        zoomPercent={zoomPercent}
        theme={theme}
        disabled={!doc}
        onOpenClick={openPicker}
        onPrevPage={() => gotoPage(page - 1)}
        onNextPage={() => gotoPage(page + 1)}
        onGotoPage={gotoPage}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={() => setZoom(1)}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {doc && viewMode !== "dual" && (
        <TranslationBar
          providerName={providerLabel(translateConfig)}
          engineOnline={engineOnline}
          useGlossary={useGlossary}
          onToggleUseGlossary={toggleUseGlossary}
          anchorLayout={anchorLayout}
          onToggleAnchorLayout={toggleAnchorLayout}
          forceRebuild={forceRebuild}
          onToggleForceRebuild={toggleForceRebuild}
          showAnchorLayout={viewMode !== "read"}
          job={job}
          onTranslateAll={() => void translateAll()}
          onCancel={cancelJob}
          onOpenSettings={() => setSettingsOpen(true)}
          translatedPages={translatedPages}
          numPages={numPages}
        >
          {viewMode === "target" && translationsRef.current.size > 0 && (
            <TranslationBarExports
              onExportTranslated={() => void exportTranslated()}
              onExportDual={() => void exportDual()}
              canExportDual={!!translatedBytesRef.current}
            />
          )}
        </TranslationBar>
      )}

      <main className="min-h-0 flex-1">
        {doc && viewMode === "read" ? (
          <ReadingView
            pages={readingPages}
            providerLabel={providerLabel(translateConfig)}
            fontSize={readingFontSize}
            onFontSizeChange={(d) => {
              setReadingFontSize((v) => {
                const next = Math.max(13, Math.min(22, v + d));
                localStorage.setItem("tr-read-font", String(next));
                return next;
              });
            }}
            showOriginal={readingOriginal}
            onToggleOriginal={() => {
              setReadingOriginal((v) => {
                localStorage.setItem("tr-read-original", v ? "0" : "1");
                return !v;
              });
            }}
            activePage={page}
            onActivePageChange={setPage}
          />
        ) : doc && viewMode === "target" ? (
          translatedDoc ? (
            <PdfViewer
              doc={translatedDoc}
              zoom={zoom}
              onPageChange={setPage}
              onFitScaleChange={setFitScale}
              onRenderError={(n, msg) => setRenderError(`第 ${n} 页渲染失败：${msg}`)}
              onTextSelection={handleTextSelection}
              onWheelZoom={(dir) => (dir > 0 ? zoomIn() : zoomOut())}
              onContextTranslatePage={(p) => void translateCurrent(p)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-50 px-8 text-center dark:bg-neutral-950">
              <Languages size={26} className="text-neutral-300 dark:text-neutral-600" />
              <p className="max-w-sm text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                还没有译文。先在下方翻译面板里点「翻译第 N 页」或工具栏的「翻译整份文档」，
                完成后这里会显示译制 PDF；也可以切到「对照」模式并排阅读。
              </p>
            </div>
          )
        ) : doc && viewMode === "dual" ? (
          <DualView
            doc={doc}
            translatedDoc={translatedDoc}
            job={job}
            translatedPages={translatedPages}
            hasTranslations={translationsRef.current.size > 0}
            fontMissing={fontMissing}
            previewError={previewError}
            currentPage={page}
            providerLabel={providerLabel(translateConfig)}
            onOpenSettings={() => setSettingsOpen(true)}
            engineOnline={engineOnline}
            forceRebuild={forceRebuild}
            onToggleForceRebuild={toggleForceRebuild}
            anchorLayout={anchorLayout}
            useGlossary={useGlossary}
            onToggleUseGlossary={toggleUseGlossary}
            zoom={zoom}
            onFitScaleChange={setFitScale}
            onWheelZoom={(dir) => (dir > 0 ? zoomIn() : zoomOut())}
            onRenderError={(n, msg) => setRenderError(`第 ${n} 页渲染失败：${msg}`)}
            onToggleAnchorLayout={toggleAnchorLayout}
            onPageChange={setPage}
            onStartAll={() => void translateAll()}
            onCancel={cancelJob}
            onTranslatePage={(p) => void translateCurrent(p)}
            onRefreshPreview={() => void rebuildPreview()}
            onExportTranslated={() => void exportTranslated()}
            onExportDual={() => void exportDual()}
          />
        ) : doc ? (
          <PdfViewer
            ref={viewerRef}
            doc={doc}
            zoom={zoom}
            onPageChange={setPage}
            onFitScaleChange={setFitScale}
            onRenderError={(n, msg) => setRenderError(`第 ${n} 页渲染失败：${msg}`)}
            onTextSelection={handleTextSelection}
            onWheelZoom={(dir) => (dir > 0 ? zoomIn() : zoomOut())}
            onContextTranslatePage={(p) => void translateCurrent(p)}
          />
        ) : (
          <EmptyState onOpenClick={openPicker} loading={loading} error={error} />
        )}
      </main>

      {selection && (
        <SelectionPopover
          text={selection.text}
          rect={selection.rect}
          config={translateConfig}
          onOpenSettings={() => setSettingsOpen(true)}
          onClose={() => setSelection(null)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        config={translateConfig}
        onSave={saveTranslateSettings}
        onExtractTerms={extractTerms}
        onClose={() => setSettingsOpen(false)}
      />

      {renderError && (
        <div className="flex shrink-0 items-center gap-2 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400">
          <span className="min-w-0 flex-1 truncate">{renderError}</span>
          <button
            type="button"
            onClick={() => setRenderError(null)}
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            关闭
          </button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/10">
          <span className="rounded-lg bg-white/90 px-4 py-2 text-sm font-medium text-blue-600 shadow dark:bg-neutral-900/90 dark:text-blue-400">
            松开以打开 PDF 文件
          </span>
        </div>
      )}
    </div>
  );
}
