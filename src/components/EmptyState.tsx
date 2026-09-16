import { Clock, FolderOpen, Loader2, Settings, X } from "lucide-react";
import { formatRelativeTime, type RecentFile } from "../lib/recent-files";

type Props = {
  onOpenClick: () => void;
  loading: boolean;
  error: string | null;
  /** 打开历史记录（空状态下的主要入口） */
  recents: RecentFile[];
  onOpenRecent: (entry: RecentFile) => void;
  onForgetRecent: (path: string) => void;
  onOpenSettings: () => void;
};

/** 相对路径里的父目录，用于区分同名文件 */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : "";
}

export function EmptyState({
  onOpenClick,
  loading,
  error,
  recents,
  onOpenRecent,
  onForgetRecent,
  onOpenSettings,
}: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8">
      <img src="/logo.svg" alt="" className="h-16 w-16 select-none" draggable={false} />
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
      <p className="text-center text-xs text-neutral-400 dark:text-neutral-500">
        或将 PDF 拖入窗口 · 快捷键 Ctrl+O · 支持一次选中多个文件
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <Settings size={13} />
        设置（翻译供应商 / 术语表 / 关于）
      </button>
      {error && <p className="max-w-md text-center text-sm text-red-500">{error}</p>}

      {recents.length > 0 && (
        // data-pet=top：鲸鱼桌宠从这张卡片上沿探头（这里上方留白足够；PDF 区域不参与锚定）
        <div className="w-full max-w-md" data-pet="top">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
            <Clock size={11} />
            最近打开
          </div>
          <ul className="overflow-hidden rounded-lg border border-neutral-200 bg-white/70 dark:border-neutral-800 dark:bg-neutral-900/50">
            {recents.slice(0, 6).map((f) => (
              <li
                key={f.path}
                className="group flex items-center gap-1 border-b border-neutral-100 px-1 last:border-b-0 dark:border-neutral-800/70"
              >
                <button
                  type="button"
                  title={f.path}
                  disabled={loading}
                  onClick={() => onOpenRecent(f)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left transition-colors hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-neutral-800"
                >
                  <FolderOpen size={13} className="shrink-0 text-neutral-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-neutral-700 dark:text-neutral-200">
                      {f.name}
                      {f.page && f.page > 1 && (
                        <span className="ml-1.5 text-[10px] text-blue-500">第 {f.page} 页</span>
                      )}
                    </span>
                    <span className="block truncate text-[10px] text-neutral-400 dark:text-neutral-500">
                      {parentDir(f.path)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                    {formatRelativeTime(f.openedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  title="从历史记录中移除"
                  onClick={() => onForgetRecent(f.path)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-100 hover:text-red-500 focus:opacity-100 dark:text-neutral-600 dark:hover:bg-neutral-800"
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
