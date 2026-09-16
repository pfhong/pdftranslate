import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { TextLayer, type PDFDocumentProxy, type PDFPageProxy } from "../lib/pdf";
import { dbg } from "../lib/debug-log";

/** 首屏上下留白（同时参与滚动定位计算） */
const TOP_PAD = 24;
/** 页与页之间的间距 */
const PAGE_GAP = 24;
/** 页面两侧留白，参与适应宽度计算 */
const SIDE_PAD = 40;
/** 距离视口多远时开始预渲染（像素） */
const RENDER_MARGIN = 1000;

export type PdfViewerHandle = {
  scrollToPage: (page: number) => void;
};

/** 划词选区（视口坐标） */
export type TextSelection = {
  text: string;
  page: number;
  rect: { x: number; y: number; width: number; height: number };
};

type Size = { w: number; h: number };

type Props = {
  doc: PDFDocumentProxy;
  zoom: number;
  /** 首次布局完成后跳到这一页（历史记录续读用），只生效一次 */
  initialPage?: number;
  onPageChange: (page: number) => void;
  onFitScaleChange: (scale: number) => void;
  onRenderError: (page: number, message: string) => void;
  onTextSelection?: (selection: TextSelection | null) => void;
  /** Ctrl+滚轮缩放：dir = 1 放大 / -1 缩小 */
  onWheelZoom?: (dir: 1 | -1) => void;
  /** 右键「翻译此页」：返回当前右键所在页码 */
  onContextTranslatePage?: (page: number) => void;
  onContextTranslateAll?: () => void;
  ref?: Ref<PdfViewerHandle>;
};

/** 连续滚动 + 按需渲染的 PDF 视图 */
export function PdfViewer({
  doc,
  zoom,
  initialPage,
  onPageChange,
  onFitScaleChange,
  onRenderError,
  onTextSelection,
  onWheelZoom,
  onContextTranslatePage,
  onContextTranslateAll,
  ref,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [base, setBase] = useState<Size | null>(null);
  /** 已渲染页面的原始尺寸（scale=1），未渲染的页面以第一页尺寸估算 */
  const dimsRef = useRef<Map<number, Size>>(new Map());
  const scaleRef = useRef(0);

  // Ctrl+滚轮缩放：需非 passive 原生监听才能 preventDefault（否则触发浏览器整页缩放）
  const wheelZoomRef = useRef(onWheelZoom);
  wheelZoomRef.current = onWheelZoom;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey || !wheelZoomRef.current) return;
      e.preventDefault();
      wheelZoomRef.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // 缩放时保持视口中心附近的锚点，避免画面跳变
  const lastViewRef = useRef<{ scale: number; scrollHeight: number } | null>(null);
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !base || scaleRef.current <= 0) {
      lastViewRef.current = null;
      return;
    }
    const prev = lastViewRef.current;
    lastViewRef.current = { scale: scaleRef.current, scrollHeight: el.scrollHeight };
    if (!prev || prev.scale === scaleRef.current || prev.scrollHeight === 0) return;
    const ratio = el.scrollHeight / prev.scrollHeight;
    if (Math.abs(ratio - 1) < 0.001) return;
    el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
  }, [base, zoom, containerWidth]);

  // 监听容器宽度（轻微防抖，避免拖拽窗口时频繁重排）
  // 页签切换时容器会变成 display:none（clientWidth 0），此时忽略测量：
  // 否则 scale 归零会让所有页画布卸载，切回来要整页重绘、白屏闪一下
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer = 0;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const width = el.clientWidth;
        if (width > 0) setContainerWidth(width);
      }, 120);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // 文档切换时取第一页的原始尺寸作为布局基准，并回到顶部
  useEffect(() => {
    let cancelled = false;
    setBase(null);
    dimsRef.current.clear();
    containerRef.current?.scrollTo({ top: 0 });
    void doc.getPage(1).then((p) => {
      if (cancelled) return;
      const v = p.getViewport({ scale: 1 });
      setBase({ w: v.width, h: v.height });
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const fitScale =
    base && containerWidth > SIDE_PAD * 2
      ? (containerWidth - SIDE_PAD * 2) / base.w
      : 0;
  const scale = fitScale * zoom;
  scaleRef.current = scale;

  useEffect(() => {
    if (fitScale > 0) onFitScaleChange(fitScale);
  }, [fitScale, onFitScaleChange]);

  // 滚动时根据位置计算当前页（rAF 节流）；滚动同时清掉划词浮层
  const rafRef = useRef(0);
  const onScroll = useCallback(() => {
    onTextSelection?.(null);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const el = containerRef.current;
      if (!el || !base) return;
      const center = el.scrollTop + el.clientHeight * 0.4;
      let acc = TOP_PAD;
      for (let n = 1; n <= doc.numPages; n++) {
        const h = (dimsRef.current.get(n) ?? base).h * scaleRef.current + PAGE_GAP;
        if (center < acc + h) {
          onPageChange(n);
          return;
        }
        acc += h;
      }
    });
  }, [doc, base, onPageChange, onTextSelection]);

  const handleRendered = useCallback((n: number, size: Size) => {
    dimsRef.current.set(n, size);
  }, []);

  const scrollToPage = useCallback(
    (n: number, smooth = true) => {
      const el = containerRef.current;
      if (!el || !base) return;
      let top = TOP_PAD;
      for (let i = 1; i < n; i++) {
        top += (dimsRef.current.get(i) ?? base).h * scaleRef.current + PAGE_GAP;
      }
      el.scrollTo({ top: Math.max(0, top - 8), behavior: smooth ? "smooth" : "auto" });
    },
    [base],
  );
  useImperativeHandle(ref, () => ({ scrollToPage }), [scrollToPage]);

  // 首屏定位（历史记录续读）：必须等 scale 真正算出来再滚。
  // 容器宽度要等 ResizeObserver（120ms 防抖）才有值，在那之前 scale 为 0、
  // 页面容器还没有可滚动高度，此时滚动会被钳制成 0，而"只滚一次"的标记已经置位。
  const initialScrolledRef = useRef(false);
  useEffect(() => {
    if (initialScrolledRef.current || !base || scale <= 0 || !initialPage || initialPage <= 1) return;
    initialScrolledRef.current = true;
    scrollToPage(initialPage, false);
  }, [base, scale, initialPage, scrollToPage]);

  // 划词：选区落在本视图的页面内时上报（视口坐标）
  // 页面右键菜单（翻译此页 / 复制页码）
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    page: number;
    onPage: boolean;
  } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    const close = (e: Event) => {
      // 菜单内的 mousedown 不能关菜单：按钮若在 mousedown 阶段被卸载，随后的 click 就不会到达 onClick
      if (ctxMenuRef.current?.contains(e.target as Node | null)) return;
      setCtxMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      dbg("ctx", "contextmenu event", { target: (e.target as HTMLElement).tagName, clientX: e.clientX, clientY: e.clientY });
      if (!containerRef.current?.contains(e.target as HTMLElement)) {
        dbg("ctx", "menu skipped: outside container");
        return;
      }
      // 选中文本时让出默认菜单（复制）
      const selCollapsed = window.getSelection()?.isCollapsed ?? true;
      if (!selCollapsed) {
        dbg("ctx", "menu skipped: text selected");
        return;
      }
      e.preventDefault();
      const pageEl = (e.target as HTMLElement).closest("[data-page]") as HTMLElement | null;
      const onPage = !!pageEl;
      dbg("ctx", "menu opened", { page: pageEl?.dataset.page ?? "?", onPage });
      setCtxMenu({
        x: Math.min(e.clientX, window.innerWidth - 190),
        y: Math.min(e.clientY, window.innerHeight - 150),
        page: Number(pageEl?.dataset.page ?? 0),
        onPage,
      });
    },
    [],
  );

  const handleMouseUp = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!onTextSelection) return;
      if (e.button !== 0) return;
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? "";
      if (!sel || sel.isCollapsed || !text) {
        onTextSelection(null);
        return;
      }
      const anchor = sel.anchorNode;
      const el = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      const pageEl = el?.closest("[data-page]") as HTMLElement | null;
      if (!pageEl || !containerRef.current?.contains(pageEl)) {
        onTextSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) {
        onTextSelection(null);
        return;
      }
      onTextSelection({
        text,
        page: Number(pageEl.dataset.page ?? 0),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    },
    [onTextSelection],
  );

  const pages = Array.from({ length: doc.numPages }, (_, i) => i + 1);

  return (
    <div
      ref={containerRef}
      onScroll={() => { setCtxMenu(null); onScroll(); }}
      onMouseUp={handleMouseUp}
      onContextMenu={handleContextMenu}
      className="h-full overflow-y-auto bg-neutral-200/70 dark:bg-neutral-900"
      style={{ scrollbarGutter: "stable" }}
    >
      {base && scale > 0 && (
        <div
          className="mx-auto flex w-fit flex-col items-center"
          style={{ paddingTop: TOP_PAD, paddingBottom: TOP_PAD }}
        >
          {pages.map((n) => (
            <PageCanvas
              key={n}
              doc={doc}
              pageNumber={n}
              scale={scale}
              estimate={base}
              onRendered={handleRendered}
              onRenderError={onRenderError}
            />
          ))}
        </div>
      )}

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {ctxMenu.onPage ? (
            onContextTranslatePage && (
              <button
                type="button"
                className="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                onClick={() => {
                  dbg("ctx", "translate page item clicked", { page: ctxMenu.page });
                  onContextTranslatePage(ctxMenu.page);
                  setCtxMenu(null);
                }}
              >
                🌐 翻译第 {ctxMenu.page} 页
              </button>
            )
          ) : (
            onContextTranslateAll && (
              <button
                type="button"
                className="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                onClick={() => {
                  dbg("ctx", "translate all clicked");
                  onContextTranslateAll();
                  setCtxMenu(null);
                }}
              >
                🌐 翻译整份文档
              </button>
            )
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
            onClick={() => {
              void navigator.clipboard.writeText(String(ctxMenu.page));
              setCtxMenu(null);
            }}
          >
            📋 复制页码
          </button>
        </div>
      )}
    </div>
  );
}

/** 单页画布：接近视口时才真正渲染，缩放变化时防抖重绘 */
function PageCanvas({
  doc,
  pageNumber,
  scale,
  estimate,
  onRendered,
  onRenderError,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  estimate: Size;
  onRendered: (n: number, size: Size) => void;
  onRenderError: (page: number, message: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const taskRef = useRef<{ cancel: () => void } | null>(null);
  const [near, setNear] = useState(false);
  /** 已渲染页面的原始尺寸（scale=1） */
  const [size, setSize] = useState<Size | null>(null);
  const [pageProxy, setPageProxy] = useState<PDFPageProxy | null>(null);
  /** 实际用于渲染的缩放（对连续缩放操作做防抖） */
  const [renderScale, setRenderScale] = useState(0);

  // 接近视口时标记为需要渲染
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: `${RENDER_MARGIN}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // 缩放防抖：已渲染过的页面延迟重绘，未渲染的立即渲染
  useEffect(() => {
    const delay = size ? 150 : 0;
    const t = window.setTimeout(() => setRenderScale(scale), delay);
    return () => window.clearTimeout(t);
  }, [scale, size]);

  useEffect(() => {
    if (!near || renderScale <= 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const page: PDFPageProxy = await doc.getPage(pageNumber);
        if (cancelled) return;
        setPageProxy(page);
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: renderScale * dpr });
        const css = page.getViewport({ scale: renderScale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        taskRef.current?.cancel();
        const task = page.render({ canvas, viewport });
        taskRef.current = task;
        await task.promise;
        if (cancelled) return;
        const raw = { w: css.width / renderScale, h: css.height / renderScale };
        setSize(raw);
        onRendered(pageNumber, raw);
      } catch (err) {
        const name = (err as { name?: string }).name;
        if (name !== "RenderingCancelledException" && name !== "AbortException") {
          console.error(`渲染第 ${pageNumber} 页失败`, err);
          onRenderError(pageNumber, (err as Error).message ?? String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      taskRef.current?.cancel();
    };
  }, [near, renderScale, doc, pageNumber, onRendered, onRenderError]);

  // 文本选择层：供划词复制/翻译（渲染失败只影响选择，不影响阅读）
  useEffect(() => {
    const el = textLayerRef.current;
    if (!el || !pageProxy || !near || renderScale <= 0) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    void (async () => {
      try {
        const viewport = pageProxy.getViewport({ scale: renderScale });
        el.replaceChildren();
        el.style.setProperty("--scale-factor", String(renderScale));
        layer = new TextLayer({
          textContentSource: pageProxy.streamTextContent({ disableNormalization: true }),
          container: el,
          viewport,
        });
        await layer.render();
        if (cancelled) layer.cancel();
      } catch (err) {
        console.warn(`第 ${pageNumber} 页文本层构建失败`, err);
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
      el.replaceChildren();
    };
  }, [pageProxy, near, renderScale, pageNumber]);

  const w = Math.floor((size?.w ?? estimate.w) * scale);
  const h = Math.floor((size?.h ?? estimate.h) * scale);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      className="relative mb-6 flex items-center justify-center overflow-hidden rounded-sm bg-white shadow-md ring-1 ring-black/5 dark:bg-neutral-800 dark:ring-white/10"
      style={{ width: w, height: h }}
    >
      <canvas ref={canvasRef} className="h-full w-full" />
      <div ref={textLayerRef} className="textLayer" />
    </div>
  );
}
