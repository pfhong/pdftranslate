import { FolderOpen, Loader2 } from "lucide-react";

type Props = {
  onOpenClick: () => void;
  loading: boolean;
  error: string | null;
};

export function EmptyState({ onOpenClick, loading, error }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
      <img src="/logo.svg" alt="" className="h-20 w-20 select-none" draggable={false} />
      <div className="text-center">
        <h1 className="text-xl font-semibold text-neutral-800 dark:text-neutral-100">
          Transfer Reader
        </h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          简洁、美观、轻量的 PDF 阅读器 · 为翻译而生
        </p>
      </div>
      <button
        type="button"
        onClick={onOpenClick}
        disabled={loading}
        className="flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:pointer-events-none disabled:opacity-60"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <FolderOpen size={16} />}
        {loading ? "正在打开…" : "打开 PDF 文件"}
      </button>
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        或将 PDF 拖入窗口 · 快捷键 Ctrl+O
      </p>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
