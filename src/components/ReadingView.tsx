import { useState } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";

/** 阅读视图的段落种类（来自版面识别） */
export type ReadingKind = "heading" | "paragraph" | "quote" | "formula";

export type ReadingBlock = {
  /** 在页面中的块序号（用于回填译文） */
  id: number;
  kind: ReadingKind;
  original: string;
  translated?: string;
};

export type ReadingPage = {
  page: number;
  blocks: ReadingBlock[];
  /** 该页是否已翻译 */
  translated: boolean;
};

type Props = {
  pages: ReadingPage[];
  providerLabel: string;
  fontSize: number;
  onFontSizeChange: (delta: number) => void;
  showOriginal: boolean;
  onToggleOriginal: () => void;
  activePage: number;
  onActivePageChange: (page: number) => void;
};

function kindClass(kind: ReadingKind): string {
  switch (kind) {
    case "heading":
      return "text-lg font-semibold text-neutral-900 dark:text-neutral-50";
    case "quote":
      return "border-l-2 border-neutral-300 pl-4 text-neutral-700 dark:border-neutral-600 dark:text-neutral-300";
    case "formula":
      return "font-mono text-sm text-neutral-600 dark:text-neutral-400";
    default:
      return "text-neutral-800 dark:text-neutral-200";
  }
}

/**
 * 阅读视图：只关心"读懂内容"，不还原原版式——
 * 译文按正常排版流式呈现（自然行距、段间距、引文缩进、标题加粗），
 * 因此不受原段落框宽度/高度限制，没有缩字、压叠、裁切问题。
 */
export function ReadingView({
  pages,
  providerLabel,
  fontSize,
  onFontSizeChange,
  showOriginal,
  onToggleOriginal,
  activePage,
  onActivePageChange,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());


  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const base = Math.max(13, Math.min(22, fontSize));

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      {/* 控制条 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white/80 px-3 dark:border-neutral-800 dark:bg-neutral-900/80">
        <BookOpen size={14} className="text-blue-600 dark:text-blue-400" />
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">阅读视图</span>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          {providerLabel}
        </span>

        <div className="mx-1 flex items-center gap-0.5">
          <button
            type="button"
            title="缩小字号"
            onClick={() => onFontSizeChange(-1)}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Minus size={12} />
          </button>
          <span className="w-8 text-center text-[11px] tabular-nums text-neutral-500">{base}px</span>
          <button
            type="button"
            title="放大字号"
            onClick={() => onFontSizeChange(1)}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Plus size={12} />
          </button>
        </div>

        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={showOriginal}
            onChange={onToggleOriginal}
            className="h-3 w-3 accent-blue-600"
          />
          逐段对照原文
        </label>

        <div className="flex-1" />

      </div>

      {/* 正文 */}
      <div className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }}>
        <div className="mx-auto max-w-3xl px-8 py-8" style={{ fontSize: base, lineHeight: 1.9 }}>
          {pages.length === 0 && (
            <p className="text-center text-sm text-neutral-400">
              还没有可阅读的内容。先翻译（工具栏「翻译整份文档」或上方按钮），识别并翻译后将在此按阅读版式呈现。
            </p>
          )}

          {pages.map((page) => (
            <section key={page.page} className="mb-10">
              <div className="mb-4 flex items-center gap-2 text-[11px] text-neutral-400">
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
                第 {page.page} 页{page.translated ? "" : " · 未翻译"}
                <span className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
              </div>

              {page.blocks.map((block) => {
                const key = `${page.page}-${block.id}`;
                const body = block.translated ?? block.original;
                const isOpen = expanded.has(key) || showOriginal;
                if (!body.trim() && !block.original.trim()) return null;
                return (
                  <div
                    key={key}
                    onClick={() => toggle(key)}
                    className={`${
                      block.kind === "heading" ? "mt-6 mb-2" : block.kind === "quote" ? "my-4" : "mb-4"
                    } cursor-pointer rounded transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900`}
                    title={block.translated ? "点击查看/隐藏原文" : "尚未翻译"}
                  >
                    <p className={kindClass(block.kind)} style={{ textAlign: "justify" }}>
                      {body}
                      {block.kind === "formula" && (
                        <span className="ml-2 text-[10px] text-neutral-400">（公式，原样保留）</span>
                      )}
                    </p>
                    {isOpen && block.translated && (
                      <p
                        className="mt-1 border-l-2 border-neutral-200 pl-3 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
                        style={{ fontSize: Math.max(11, base - 3), lineHeight: 1.6 }}
                      >
                        {block.original}
                      </p>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>

      {/* 页码导航 */}
      {pages.length > 1 && (
        <div className="flex h-9 shrink-0 items-center justify-center gap-2 border-t border-neutral-200 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => onActivePageChange(Math.max(1, activePage - 1))}
            disabled={activePage <= 1}
            className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          >
            <ChevronLeft size={12} /> 上一页
          </button>
          <span className="text-[11px] text-neutral-400">
            {activePage} / {pages.length}
          </span>
          <button
            type="button"
            onClick={() => onActivePageChange(Math.min(pages.length, activePage + 1))}
            disabled={activePage >= pages.length}
            className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:hover:bg-neutral-800"
          >
            下一页 <ChevronRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
