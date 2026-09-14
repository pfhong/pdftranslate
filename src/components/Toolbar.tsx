import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Moon,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

type Props = {
  fileName: string | null;
  page: number;
  numPages: number;
  zoomPercent: number;
  theme: "light" | "dark";
  disabled: boolean;
  onOpenClick: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onGotoPage: (page: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleTheme: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
};

/** 阅读模式：原文 / 原文+译文对照 / 仅译文 */
export type ViewMode = "source" | "dual" | "target" | "read";

function IconButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700/60 dark:hover:text-white"
    >
      {children}
    </button>
  );
}

export function Toolbar({
  fileName,
  page,
  numPages,
  zoomPercent,
  theme,
  disabled,
  onOpenClick,
  onPrevPage,
  onNextPage,
  onGotoPage,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onToggleTheme,
  viewMode,
  onViewModeChange,
}: Props) {
  const [pageInput, setPageInput] = useState(String(page));
  useEffect(() => setPageInput(String(page)), [page]);

  const commitPage = () => {
    const n = Number.parseInt(pageInput, 10);
    if (Number.isNaN(n)) {
      setPageInput(String(page));
      return;
    }
    onGotoPage(n);
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white/80 px-3 backdrop-blur dark:border-neutral-800 dark:bg-neutral-900/80">
      {/* 左侧：文件名 */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <img src="/logo.svg" alt="" className="h-6 w-6 shrink-0" draggable={false} />
        <span className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
          {fileName ?? "Transfer Reader"}
        </span>
      </div>

      {/* 中间：页码导航 */}
      <div className="flex items-center gap-1">
        <IconButton title="上一页 (←)" onClick={onPrevPage} disabled={disabled || page <= 1}>
          <ChevronLeft size={16} />
        </IconButton>
        <div className="flex items-center gap-1.5 text-xs text-neutral-600 tabular-nums dark:text-neutral-300">
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
            onFocus={(e) => e.target.select()}
            onBlur={commitPage}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            disabled={disabled}
            className="h-7 w-11 rounded-md border border-neutral-200 bg-transparent text-center text-xs outline-none transition-colors focus:border-blue-500 disabled:opacity-40 dark:border-neutral-700"
          />
          <span>/ {numPages > 0 ? numPages : "–"}</span>
        </div>
        <IconButton
          title="下一页 (→)"
          onClick={onNextPage}
          disabled={disabled || page >= numPages}
        >
          <ChevronRight size={16} />
        </IconButton>
      </div>

      {/* 右侧：缩放 / 打开 / 主题 */}
      <div className="flex flex-1 items-center justify-end gap-1">
        <IconButton title="缩小 (Ctrl+-)" onClick={onZoomOut} disabled={disabled}>
          <ZoomOut size={16} />
        </IconButton>
        <button
          type="button"
          title="重置缩放 · 适应宽度 (Ctrl+0)"
          onClick={onZoomReset}
          disabled={disabled}
          className="h-8 w-12 rounded-md text-xs text-neutral-600 tabular-nums transition-colors hover:bg-neutral-200/70 hover:text-neutral-900 disabled:pointer-events-none disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700/60 dark:hover:text-white"
        >
          {zoomPercent}%
        </button>
        <IconButton title="放大 (Ctrl+=)" onClick={onZoomIn} disabled={disabled}>
          <ZoomIn size={16} />
        </IconButton>
        <div
          className="flex h-8 items-center gap-0.5 rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-800"
          role="group"
          aria-label="阅读模式"
        >
          {(
            [
              { id: "source", label: "原文", tip: "仅显示原始 PDF" },
              { id: "dual", label: "对照", tip: "左原文 · 右译文并排" },
              { id: "target", label: "译文", tip: "仅显示译制 PDF" },
              { id: "read", label: "阅读", tip: "按阅读版式呈现译文（不还原原版式，排版更舒适）" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.tip}
              onClick={() => onViewModeChange(m.id)}
              disabled={disabled}
              className={`flex h-7 items-center gap-1 rounded px-2 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40 ${
                viewMode === m.id
                  ? "bg-white font-medium text-blue-700 shadow-sm dark:bg-neutral-700 dark:text-blue-300"
                  : "text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {m.id === "dual" && <BookOpenText size={12} />}
              {m.label}
            </button>
          ))}
        </div>
        <IconButton title="打开文件 (Ctrl+O)" onClick={onOpenClick}>
          <FolderOpen size={16} />
        </IconButton>
        <IconButton
          title={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>
      </div>
    </header>
  );
}
