import { Loader2, Plus, X } from "lucide-react";

export type TabItem = {
  id: string;
  name: string;
  /** 该文档正在翻译 */
  running: boolean;
  /** 该文档已有译文 */
  translated: boolean;
};

type Props = {
  tabs: TabItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onOpenFiles: () => void;
};

/**
 * 已打开文档的页签条。只在不止一个文档时显示——单文档时它是纯噪音。
 * 切换页签不卸载文档（见 DocWorkspace），所以翻译进度和滚动位置都会留着。
 */
export function TabStrip({ tabs, activeId, onSelect, onClose, onOpenFiles }: Props) {
  if (tabs.length <= 1) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 border-b border-neutral-200 bg-neutral-100/80 px-2 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto"
        style={{ scrollbarWidth: "thin" }}
        role="tablist"
        aria-label="已打开的文档"
      >
        {tabs.map((t) => {
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={isActive}
              title={t.name}
              onClick={() => onSelect(t.id)}
              onAuxClick={(e) => {
                // 中键关闭，和浏览器一致
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(t.id);
                }
              }}
              className={`group flex max-w-[220px] min-w-[110px] shrink-0 cursor-pointer items-center gap-1.5 self-end rounded-t-md border border-b-0 px-2.5 py-1.5 text-xs transition-colors ${
                isActive
                  ? "border-neutral-200 bg-white text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                  : "border-transparent text-neutral-500 hover:bg-neutral-200/60 dark:text-neutral-400 dark:hover:bg-neutral-800/60"
              }`}
            >
              {t.running ? (
                <Loader2 size={11} className="shrink-0 animate-spin text-blue-500" />
              ) : (
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    t.translated ? "bg-emerald-500" : "bg-neutral-300 dark:bg-neutral-600"
                  }`}
                  title={t.translated ? "已有译文" : "尚未翻译"}
                />
              )}
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              <button
                type="button"
                title="关闭该文档 (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-neutral-300/70 hover:text-neutral-700 focus:opacity-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        title="再打开一个 PDF (Ctrl+O)"
        onClick={onOpenFiles}
        className="flex h-7 w-7 shrink-0 items-center justify-center self-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
