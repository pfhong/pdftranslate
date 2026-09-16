import { useEffect, useRef, useState } from "react";
import { FolderOpen, History, Trash2 } from "lucide-react";
import { formatRelativeTime, type RecentFile } from "../lib/recent-files";

type Props = {
  list: RecentFile[];
  onOpen: (entry: RecentFile) => void;
  onForget: (path: string) => void;
  onClear: () => void;
};

/** 相对路径里的父目录，用于在列表里区分同名文件 */
function parentDir(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : "";
}

/** 工具栏上的「打开历史记录」下拉 */
export function RecentFilesMenu({ list, onOpen, onForget, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      // 面板内的按下不关面板：否则按钮会在 click 之前被卸载（右键菜单踩过这个坑）
      if (wrapRef.current?.contains(e.target as Node | null)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        title="打开历史记录"
        onClick={() => setOpen((v) => !v)}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors ${
          open
            ? "bg-neutral-200/70 text-neutral-900 dark:bg-neutral-700/60 dark:text-white"
            : "text-neutral-600 hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-700/60 dark:hover:text-white"
        }`}
      >
        <History size={16} />
      </button>

      {open && (
        <div
          className="absolute top-full right-0 z-50 mt-1 w-80 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="flex items-center justify-between border-b border-neutral-100 px-3 py-1.5 dark:border-neutral-800">
            <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
              打开历史记录
            </span>
            {list.length > 0 && (
              <button
                type="button"
                onClick={onClear}
                className="rounded px-1.5 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800"
              >
                清空
              </button>
            )}
          </div>

          {list.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs leading-relaxed text-neutral-400 dark:text-neutral-500">
              还没有打开记录。
              <br />
              用「打开 PDF 文件」打开过的文件会出现在这里，方便再次打开。
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1" style={{ scrollbarWidth: "thin" }}>
              {list.map((f) => (
                <li key={f.path} className="group flex items-center gap-1 px-1">
                  <button
                    type="button"
                    title={f.path}
                    onClick={() => {
                      setOpen(false);
                      onOpen(f);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <FolderOpen size={13} className="shrink-0 text-neutral-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-neutral-700 dark:text-neutral-200">
                        {f.name}
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
                    onClick={() => onForget(f.path)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-100 hover:text-red-500 focus:opacity-100 dark:text-neutral-600 dark:hover:bg-neutral-800"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
