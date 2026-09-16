import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Languages } from "lucide-react";
import { Toolbar, type ViewMode } from "./Toolbar";
import { PdfViewer, type PdfViewerHandle, type TextSelection } from "./PdfViewer";
import { SelectionPopover } from "./SelectionPopover";
import { TranslationBar } from "./TranslationBar";
import { DualView, type JobState } from "./DualView";
import { ReadingView, type ReadingPage, type ReadingKind } from "./ReadingView";
import type { RecentFile } from "../lib/recent-files";
import {
  loadDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "../lib/pdf";
import { extractPageLayout, type PageLayout } from "../lib/layout";
import { ocrPageItems } from "../lib/ocr";
import {
  buildDualPdf,
  buildTranslatedPdf,
  loadFontBytes,
  savePdfBytes,
  type TranslationStore,
} from "../lib/render-pdf";
import { cacheGet, cacheKey, cacheSet } from "../lib/trans-cache";
import { dbg } from "../lib/debug-log";
import {
  providerLabel,
  runPool,
  translateBatch,
  translateText,
  activeTargetLang,
  type TranslateConfig,
} from "../lib/translate";
import type { TargetLangApi } from "./TargetLangSelect";
import { ensureLocalModel, isLocalModelProvider } from "../lib/local-model";
import { petAnnounceDone } from "../lib/pet";
import type { EngineHealth } from "../lib/engine";
import {
  engineBuildTag,
  engineEnsure,
  engineExtract,
  engineSynthesize,
  engineTranslateBabeldoc,
  engineTranslateProgress,
  glossaryActive,
  type EngineExtractResult,
  type EngineTranslation,
} from "../lib/engine";

/** 全局阅读偏好（跨文档共享，存在 localStorage） */
export type ReaderPrefs = {
  /** 重新用 PP-OCR 识别（忽略内嵌文本层） */
  forceRebuild: boolean;
  /** 译文锚定原文段落框（扫描件推荐） */
  anchorLayout: boolean;
  /** 翻译时注入术语表 */
  useGlossary: boolean;
  readingFontSize: number;
  readingOriginal: boolean;
};

/** 历史记录菜单需要的回调与数据（壳层 → 工作区 → 工具栏逐层透传） */
export type RecentsApi = {
  list: RecentFile[];
  onOpen: (entry: RecentFile) => void;
  onForget: (path: string) => void;
  onClear: () => void;
};

/** 打开中的一个文档：字节与解析结果由壳层持有，工作区只读 */
export type WorkspaceSession = {
  id: string;
  /** 展示名（已去掉 .pdf） */
  name: string;
  /** 桌面端为绝对路径，浏览器里为 null */
  path: string | null;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  /** 主文档的加载任务，关闭页签时由壳层销毁 */
  task: PDFDocumentLoadingTask;
  /** 打开时定位到的页码（历史记录续读） */
  initialPage?: number;
};

type Props = {
  session: WorkspaceSession;
  /** 是否为当前可见页签；非激活时仍保持挂载以保留翻译状态与滚动位置 */
  active: boolean;
  prefs: ReaderPrefs;
  onPrefsChange: (patch: Partial<ReaderPrefs>) => void;
  translateConfig: TranslateConfig;
  /** 当前供应商的目标语言下拉（各阅读模式的控制条共用） */
  targetLang: TargetLangApi;
  onOpenSettings: () => void;
  /** 引擎健康信息：在线状态、源码指纹、是否比源码旧 */
  engine: EngineHealth;
  fontMissing: boolean;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenFiles: () => void;
  recents: RecentsApi;
  onStatus: (id: string, status: { running: boolean; translated: boolean }) => void;
  onPage: (id: string, page: number) => void;
};

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
  return `BabelDOC · ${map[stage] ?? stage} ${Math.round(overall)}%`;
}

/** 缩放档位（1 = 适应宽度） */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

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

/**
 * 单文档工作区：一个文档的全部阅读/翻译状态都在这里，
 * 页签切换时组件不卸载（由壳层用 CSS 隐藏），因此译文、版面缓存、滚动位置都得以保留，
 * 后台仍在跑的翻译任务也只会写回自己这一份 ref，不会串到别的文档。
 */
export function DocWorkspace({
  session,
  active,
  prefs,
  onPrefsChange,
  translateConfig,
  targetLang,
  onOpenSettings,
  engine,
  fontMissing,
  theme,
  onToggleTheme,
  onOpenFiles,
  recents,
  onStatus,
  onPage,
}: Props) {
  const { id, name: fileName, doc, bytes } = session;
  const initialPage = session.initialPage ?? 1;

  const [page, setPage] = useState(initialPage > 0 ? initialPage : 1);
  const [zoom, setZoom] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("source");
  const viewModeRef = useRef<ViewMode>("source");
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // 译文与翻译管线状态
  const [translatedDoc, setTranslatedDoc] = useState<PDFDocumentProxy | null>(null);
  const [translatedPages, setTranslatedPages] = useState(0);
  const [translatedVersion, setTranslatedVersion] = useState(0);
  const [job, setJob] = useState<JobState | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  /** 字体缺失由壳层启动时探测，合成失败时这里再确认一次 */
  const [fontMissingLocal, setFontMissingLocal] = useState(fontMissing);
  const jobCancelRef = useRef(false);

  const docBytesRef = useRef<Uint8Array | null>(bytes);
  const layoutsRef = useRef<Map<number, PageLayout>>(new Map());
  const translationsRef = useRef<TranslationStore>(new Map());
  const translatedBytesRef = useRef<Uint8Array | null>(null);
  const translatedTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const enginePagesRef = useRef<EngineExtractResult | null>(null);
  const dualBytesRef = useRef<Uint8Array | null>(null);
  const viewerRef = useRef<PdfViewerHandle>(null);

  const numPages = doc.numPages;

  // 引擎在线状态与翻译配置在回调里被读取，用 ref 保证取到最新值
  const engineRef = useRef(engine.online);
  useEffect(() => {
    engineRef.current = engine.online;
  }, [engine.online]);
  const configRef = useRef(translateConfig);
  useEffect(() => {
    configRef.current = translateConfig;
  }, [translateConfig]);
  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  const onPageRef = useRef(onPage);
  useEffect(() => {
    onPageRef.current = onPage;
  }, [onPage]);

  // 页签角标：只上报"是否在翻译/是否有译文"这类低频变化
  useEffect(() => {
    onStatus(id, { running: !!job?.running, translated: translatedPages > 0 });
  }, [id, job?.running, translatedPages, onStatus]);

  // 卸载（关闭页签）时停掉还在跑的翻译任务并释放本文档占用的 pdf.js 资源
  useEffect(() => {
    return () => {
      jobCancelRef.current = true;
      void translatedTaskRef.current?.destroy();
      translatedTaskRef.current = null;
    };
  }, []);

  // 切走时收起划词浮层：它的位置是按视口算的，藏着再回来会指到错的地方
  useEffect(() => {
    if (!active) setSelection(null);
  }, [active]);

  // 译制 PDF 就绪 = 这一轮翻译真的完成了，让桌宠报一声（受「随机说话」开关控制）
  const announcedRef = useRef<PDFDocumentProxy | null>(null);
  useEffect(() => {
    if (!translatedDoc || translatedDoc === announcedRef.current) return;
    announcedRef.current = translatedDoc;
    petAnnounceDone();
  }, [translatedDoc]);

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

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
          phase: "translate" as const,
          stageText: stageLabel(p.stage, p.overall),
        });
      });
    }, 1200);
    return () => {
      signal.stop = true;
      window.clearInterval(timer);
    };
  }, []);

  const handlePageChange = useCallback(
    (n: number) => {
      setPage(n);
      onPageRef.current(id, n);
    },
    [id],
  );

  const gotoPage = useCallback(
    (n: number) => {
      const clamped = Math.min(Math.max(n, 1), Math.max(numPages, 1));
      setPage(clamped);
      onPageRef.current(id, clamped);
      viewerRef.current?.scrollToPage(clamped);
    },
    [id, numPages],
  );

  const zoomIn = useCallback(() => {
    setZoom((z) => ZOOM_STEPS.find((s) => s > z + 1e-6) ?? z);
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? z);
  }, []);

  // 全局快捷键：只由当前激活的文档响应，避免多文档重复处理
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
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
  }, [active, page, gotoPage, zoomIn, zoomOut]);

  const zoomPercent = Math.round(fitScale * zoom * 100);

  const handleTextSelection = useCallback((sel: TextSelection | null) => {
    setSelection(sel);
  }, []);

  // ─── 翻译管线 ───────────────────────────────────────────────

  /** 获取一页版面：OCR 开启时用 PP-OCR 重新识别，否则用内嵌文本层 */
  const getLayout = useCallback(
    async (pg: PDFPageProxy, pageNum: number): Promise<PageLayout> => {
      const cached = layoutsRef.current.get(pageNum);
      if (cached) return cached;
      let layout: PageLayout;
      if (prefsRef.current.forceRebuild) {
        setJob((j) => (j ? { ...j, phase: "ocr" } : j));
        const items = await ocrPageItems(pg);
        layout = await extractPageLayout(pg, { itemsOverride: items });
      } else {
        layout = await extractPageLayout(pg);
      }
      layoutsRef.current.set(pageNum, layout);
      return layout;
    },
    [],
  );

  const countTranslatedPages = useCallback(() => {
    let n = 0;
    for (const blocks of translationsRef.current.values()) {
      if (blocks.size > 0) n += 1;
    }
    return n;
  }, []);

  /** 批量翻译目标段落：按页分批 + 并发，缺失项逐段兜底重试 */
  const translateTargets = useCallback(
    async (targets: { page: number; id: number; text: string }[]) => {
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
      // 术语表：只取全文命中的词条，生成提示词块（BabelDOC 由引擎注入）
      let glossaryBlock: string | undefined;
      const profile = configRef.current.profiles.find(
        (p) => p.id === configRef.current.activeId,
      );
      if (prefsRef.current.useGlossary && profile) {
        const entries = await glossaryActive(
          targets.map((t) => t.text).join("\n"),
          activeTargetLang(configRef.current),
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
      // 引擎指纹进键：引擎行为变了缓存整体作废，不会拿旧引擎的结果糊弄人
      const engineBuild = engineBuildTag();
      let done = 0;
      let translated = 0;
      let firstError: string | null = null;
      await runPool(
        batches,
        6,
        async (batch) => {
          const texts = batch.map((i) => targets[i].text);
          const keys = texts.map((t) =>
            cacheKey(providerId, model, activeTargetLang(configRef.current), engineBuild, t),
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
              firstError ??= (err as Error).message ?? String(err);
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
                firstError ??= (err as Error).message ?? String(err);
              }
            }
          }
          for (let k = 0; k < batch.length; k++) {
            const t = targets[batch[k]];
            if (results[k] !== null) {
              const pageTrans = translationsRef.current.get(t.page) ?? new Map<number, string>();
              translationsRef.current.set(t.page, pageTrans);
              pageTrans.set(t.id, results[k] as string);
              translated += 1;
            }
            done += 1;
            setJob((j) => (j ? { ...j, doneBlocks: done } : j));
          }
          setTranslatedPages(countTranslatedPages());
          setTranslatedVersion((v) => v + 1);
        },
        () => jobCancelRef.current,
      );
      // 一段都没成功就别装作没事：把真实原因摆到界面上
      // （典型情况是本地模型没启动、或供应商没配好）
      if (targets.length > 0 && translated === 0 && !jobCancelRef.current) {
        const reason = firstError ? `：${firstError}` : "";
        setPreviewError(`翻译失败，${targets.length} 个段落都没有返回译文${reason}`);
        setRenderError(`翻译失败${reason}`);
      }
      return translated;
    },
    [countTranslatedPages],
  );

  /** 提取整本文档的版面并汇总待翻译段落（引擎优先，本地管线降级） */
  const collectTargets = useCallback(async (): Promise<
    { page: number; id: number; text: string }[] | null
  > => {
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
          const mono = await engineSynthesize(docBytesRef.current, translations);
          translatedBytesRef.current = mono.slice();
          const task = loadDocument(mono);
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
      const built = await buildTranslatedPdf(docBytesRef.current, {
        layouts: layoutsRef.current,
        translations: translationsRef.current,
      });
      if (!built) {
        setFontMissingLocal((await loadFontBytes()) === null);
        return;
      }
      translatedBytesRef.current = built.slice();
      const task = loadDocument(built);
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
      if (!docBytesRef.current) {
        dbg("anchored", "abort: no bytes");
        return;
      }
      const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
      if (translateConfig.activeId === "mock" || !profile) {
        setPreviewError("需要真实翻译后端，请在翻译设置中选择并配置供应商。");
        return;
      }
      try {
        setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: "layout" });
        dbg("anchored", "extracting via engine", { forceRebuild: prefs.forceRebuild });
        const extracted = await engineExtract(docBytesRef.current, prefs.forceRebuild);
        dbg("anchored", "extract done", { pages: extracted.pages.length });
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
    [numPages, translateConfig, prefs.forceRebuild, translateTargets],
  );

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
    return x0 - nearest > 20 && text.length < 400 ? "quote" : "paragraph";
  };

  /**
   * 阅读视图数据：把识别出的块按阅读顺序整理成段落，并带上译文。
   * 只依赖版面识别 + 译文，不参与 PDF 合成——因此不受原段落框约束。
   */
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
            return {
              id: b.index,
              kind: classifyKind(!!b.bold, b.bbox[0], margins, original, !text),
              original,
              translated: pageTrans?.get(b.index),
            };
          }),
        });
      }
      return out;
    }

    // 本地兜底管线：layoutsRef（PageLayout）
    for (const [pageNo, layout] of layoutsRef.current) {
      const raw = layout.blocks;
      if (raw.length === 0) continue;
      const margins = bodyMargins(raw.map((b) => b.x0));
      const pageTrans = trans.get(pageNo);
      out.push({
        page: pageNo,
        translated: (pageTrans?.size ?? 0) > 0,
        blocks: raw.map((b) => {
          const original = b.protectedOnly ? b.displayText : b.translateText;
          return {
            id: b.id,
            kind: classifyKind(
              b.size > layout.blocks[0].size * 1.08 && original.length < 80,
              b.x0,
              margins,
              original,
              b.protectedOnly,
            ),
            original,
            translated: pageTrans?.get(b.id),
          };
        }),
      });
    }
    out.sort((a, b) => a.page - b.page);
    return out;
  }, [translatedVersion]);

  /**
   * 翻译前的就绪检查，两件事都要满足：
   * 1) 引擎不常驻——没起就在这里拉起来（应用启动时不预启动）；
   * 2) 选了「本地模型（离线）」这个供应商时，模型本身也得在跑——引擎托管着 llama-server，
   *    光有引擎它会直接回 409「本地模型未就绪」，所以这里一并把它拉起来。
   *
   * 三种结果：ready 走引擎；engine-offline 退回本地兜底管线；
   * model-failed 直接停手（用户就是选了本地模型，静默降级反而更糟），原因已经提示出去了。
   */
  const ensureEngine = useCallback(async (): Promise<
    "ready" | "engine-offline" | "model-failed"
  > => {
    let online = engineRef.current;
    if (!online) {
      setJob({
        running: true,
        doneBlocks: 0,
        totalBlocks: 0,
        phase: "layout",
        stageText: "正在启动翻译引擎…",
      });
      const health = await engineEnsure();
      engineRef.current = health.online;
      online = health.online;
    }

    if (online) {
      const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
      if (profile && isLocalModelProvider(profile.baseURL)) {
        setJob((j) => (j ? { ...j, stageText: "正在加载本地模型（首次约 10–30 秒）…" } : j));
        const model = await ensureLocalModel();
        if (!model.ok) {
          const message = model.message ?? "本地模型未能启动。";
          setPreviewError(message);
          setRenderError(`翻译失败：${message}`);
          setJob(null);
          return "model-failed";
        }
      }
      return "ready";
    }
    return "engine-offline";
  }, [translateConfig]);

  const translateAll = useCallback(async () => {
    if (job?.running) return;
    jobCancelRef.current = false;
    const ready = await ensureEngine();
    if (ready === "model-failed") return;
    // 引擎在线：整本翻译走 BabelDOC 完整管线（YOLO 版面 + 字符级重排）
    if (prefs.anchorLayout) {
      await translateAnchored();
      return;
    }
    if (ready === "ready" && docBytesRef.current) {
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
          { baseUrl: profile.baseURL, apiKey: profile.apiKey, model: profile.model },
          {
            targetLangName: activeTargetLang(translateConfig),
            forceRebuild: prefs.forceRebuild,
            useGlossary: prefs.useGlossary,
          },
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
        if (result.dual) dualBytesRef.current = base64ToBytes(result.dual);
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
    setJob({ running: true, doneBlocks: 0, totalBlocks: 0, phase: prefs.forceRebuild ? "ocr" : "layout" });
    const targets = await collectTargets();
    if (!targets || jobCancelRef.current) {
      setJob(null);
      return;
    }
    setJob({ running: true, doneBlocks: 0, totalBlocks: targets.length, phase: "translate" });
    await translateTargets(targets);
    setJob(null);
    await rebuildPreview();
  }, [
    job,
    numPages,
    translateConfig,
    prefs.anchorLayout,
    prefs.forceRebuild,
    prefs.useGlossary,
    collectTargets,
    translateTargets,
    rebuildPreview,
    translateAnchored,
    pollBabeldocProgress,
    ensureEngine,
  ]);

  /** 翻译指定页（默认当前页）。右键菜单会传入右键所在的页码。 */
  const translateCurrent = useCallback(
    async (targetPage?: number) => {
      dbg("translateCurrent", "invoked", {
        targetPage,
        currentPage: page,
        engine: engineRef.current,
        anchor: prefs.anchorLayout,
        hasBytes: !!docBytesRef.current,
      });
      if (job?.running) {
        dbg("translateCurrent", "skipped: job running");
        return;
      }
      const pageNo = targetPage ?? page;
      if (pageNo < 1 || pageNo > numPages) {
        dbg("translateCurrent", "page out of range", { pageNo, numPages });
        return;
      }
      jobCancelRef.current = false;
      const ready = await ensureEngine();
      if (ready === "model-failed") return;
      // 引擎在线：当前页也走完整管线（pages 参数只译本页），质量与整本一致
      if (prefs.anchorLayout) {
        dbg("translateCurrent", "route: anchored");
        await translateAnchored(pageNo);
        return;
      }
      if (ready === "ready" && docBytesRef.current) {
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
            { baseUrl: profile.baseURL, apiKey: profile.apiKey, model: profile.model },
            {
              targetLangName: activeTargetLang(translateConfig),
              pages: String(pageNo),
              forceRebuild: prefs.forceRebuild,
              useGlossary: prefs.useGlossary,
            },
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
          if (result.dual) dualBytesRef.current = base64ToBytes(result.dual);
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
      setJob({
        running: true,
        doneBlocks: 0,
        totalBlocks: 0,
        phase: prefs.forceRebuild ? "ocr" : "layout",
      });
      const pg = await doc.getPage(pageNo);
      const layout = await getLayout(pg, pageNo);
      const targets = layout.blocks
        .filter((b) => !b.protectedOnly && b.translateText.trim())
        .map((b) => ({ page: pageNo, id: b.id, text: b.translateText }));
      setJob({ running: true, doneBlocks: 0, totalBlocks: targets.length, phase: "translate" });
      await translateTargets(targets);
      setJob(null);
      await rebuildPreview();
    },
    [
      job,
      page,
      numPages,
      doc,
      translateConfig,
      prefs.anchorLayout,
      prefs.forceRebuild,
      prefs.useGlossary,
      getLayout,
      translateTargets,
      rebuildPreview,
      translateAnchored,
      pollBabeldocProgress,
      ensureEngine,
    ],
  );

  const cancelJob = useCallback(() => {
    jobCancelRef.current = true;
  }, []);

  const exportTranslated = useCallback(async () => {
    const out = translatedBytesRef.current;
    if (!out) return;
    await savePdfBytes(out.slice(), `${fileName ?? "document"}_译文.pdf`);
  }, [fileName]);

  const exportDual = useCallback(async () => {
    // BabelDOC 已生成原生 dual（原/译交错），直接导出
    if (dualBytesRef.current) {
      await savePdfBytes(dualBytesRef.current.slice(), `${fileName ?? "document"}_双语对照.pdf`);
      return;
    }
    const mono = translatedBytesRef.current;
    if (!mono || !docBytesRef.current) return;
    const dual = await buildDualPdf(docBytesRef.current, mono);
    await savePdfBytes(dual, `${fileName ?? "document"}_双语对照.pdf`);
  }, [fileName]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar
        fileName={fileName}
        page={page}
        numPages={numPages}
        zoomPercent={zoomPercent}
        theme={theme}
        disabled={false}
        onOpenClick={onOpenFiles}
        onPrevPage={() => gotoPage(page - 1)}
        onNextPage={() => gotoPage(page + 1)}
        onGotoPage={gotoPage}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={() => setZoom(1)}
        onToggleTheme={onToggleTheme}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        recents={recents}
        onOpenSettings={onOpenSettings}
      />

      {viewMode !== "dual" && (
        <TranslationBar
          providerName={providerLabel(translateConfig)}
          targetLang={targetLang}
          engine={engine}
          useGlossary={prefs.useGlossary}
          onToggleUseGlossary={() => onPrefsChange({ useGlossary: !prefs.useGlossary })}
          anchorLayout={prefs.anchorLayout}
          onToggleAnchorLayout={() => onPrefsChange({ anchorLayout: !prefs.anchorLayout })}
          forceRebuild={prefs.forceRebuild}
          onToggleForceRebuild={() => onPrefsChange({ forceRebuild: !prefs.forceRebuild })}
          showAnchorLayout={viewMode !== "read"}
          job={job}
          onTranslateAll={() => void translateAll()}
          onCancel={cancelJob}
          onOpenSettings={onOpenSettings}
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
        {viewMode === "read" ? (
          <ReadingView
            pages={readingPages}
            providerLabel={providerLabel(translateConfig)}
            fontSize={prefs.readingFontSize}
            onFontSizeChange={(d) => {
              const next = Math.max(13, Math.min(22, prefs.readingFontSize + d));
              onPrefsChange({ readingFontSize: next });
            }}
            showOriginal={prefs.readingOriginal}
            onToggleOriginal={() => onPrefsChange({ readingOriginal: !prefs.readingOriginal })}
            activePage={page}
            onActivePageChange={setPage}
          />
        ) : viewMode === "target" ? (
          translatedDoc ? (
            <PdfViewer
              doc={translatedDoc}
              zoom={zoom}
              onPageChange={handlePageChange}
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
        ) : viewMode === "dual" ? (
          <DualView
            doc={doc}
            translatedDoc={translatedDoc}
            job={job}
            translatedPages={translatedPages}
            hasTranslations={translationsRef.current.size > 0}
            fontMissing={fontMissingLocal}
            previewError={previewError}
            currentPage={page}
            providerLabel={providerLabel(translateConfig)}
            targetLang={targetLang}
            onOpenSettings={onOpenSettings}
            engine={engine}
            forceRebuild={prefs.forceRebuild}
            onToggleForceRebuild={() => onPrefsChange({ forceRebuild: !prefs.forceRebuild })}
            anchorLayout={prefs.anchorLayout}
            useGlossary={prefs.useGlossary}
            onToggleUseGlossary={() => onPrefsChange({ useGlossary: !prefs.useGlossary })}
            zoom={zoom}
            onFitScaleChange={setFitScale}
            onWheelZoom={(dir) => (dir > 0 ? zoomIn() : zoomOut())}
            onRenderError={(n, msg) => setRenderError(`第 ${n} 页渲染失败：${msg}`)}
            onToggleAnchorLayout={() => onPrefsChange({ anchorLayout: !prefs.anchorLayout })}
            onPageChange={handlePageChange}
            onStartAll={() => void translateAll()}
            onCancel={cancelJob}
            onTranslateAll={() => void translateAll()}
            onTranslatePage={(p) => void translateCurrent(p)}
            onRefreshPreview={() => void rebuildPreview()}
            onExportTranslated={() => void exportTranslated()}
            onExportDual={() => void exportDual()}
          />
        ) : (
          <PdfViewer
            ref={viewerRef}
            doc={doc}
            zoom={zoom}
            initialPage={initialPage}
            onPageChange={handlePageChange}
            onFitScaleChange={setFitScale}
            onRenderError={(n, msg) => setRenderError(`第 ${n} 页渲染失败：${msg}`)}
            onTextSelection={handleTextSelection}
            onWheelZoom={(dir) => (dir > 0 ? zoomIn() : zoomOut())}
            onContextTranslatePage={(p) => void translateCurrent(p)}
          />
        )}
      </main>

      {selection && (
        <SelectionPopover
          text={selection.text}
          rect={selection.rect}
          config={translateConfig}
          onOpenSettings={onOpenSettings}
          onClose={() => setSelection(null)}
        />
      )}

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
    </div>
  );
}
