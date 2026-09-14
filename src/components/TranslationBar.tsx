import type { ReactNode } from "react";
import { Check, Loader2, Settings, Sparkles, Square } from "lucide-react";
import { providerLabel as noop } from "../lib/translate";
import type { JobState } from "./DualView";

void noop;

type Props = {
  providerName: string;
  engineOnline: boolean;
  useGlossary: boolean;
  onToggleUseGlossary: () => void;
  anchorLayout: boolean;
  onToggleAnchorLayout: () => void;
  forceRebuild: boolean;
  onToggleForceRebuild: () => void;
  /** 阅读模式不涉及 PDF 合成，隐藏「保版式」 */
  showAnchorLayout?: boolean;
  job: JobState | null;
  onTranslateAll: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  translatedPages: number;
  numPages: number;
  /** 模式特有控件（页码同步 / 导出 / 字号等） */
  children?: ReactNode;
};

function Toggle({
  on,
  onClick,
  label,
  title,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] transition-colors ${
        on
          ? "text-blue-700 dark:text-blue-300"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
      }`}
    >
      <span
        className={`flex h-3 w-3 items-center justify-center rounded-sm border ${
          on
            ? "border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500"
            : "border-neutral-300 dark:border-neutral-600"
        }`}
      >
        {on && <Check size={9} strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
}

function BarButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {icon}
      {children}
    </button>
  );
}

/**
 * 翻译控制条：所有阅读模式共用（原文 / 对照 / 译文 / 阅读）。
 * 供应商、引擎状态、流水线开关、翻译动作、进度与"已翻译"计数都在这一行，
 * 因此工具栏不再需要单独的翻译下拉。
 */
export function TranslationBar({
  providerName,
  engineOnline,
  useGlossary,
  onToggleUseGlossary,
  anchorLayout,
  onToggleAnchorLayout,
  forceRebuild,
  onToggleForceRebuild,
  showAnchorLayout = true,
  job,
  onTranslateAll,
  onCancel,
  onOpenSettings,
  translatedPages,
  numPages,
  children,
}: Props) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-200 bg-white/80 px-3 dark:border-neutral-800 dark:bg-neutral-900/80">
      <button
        type="button"
        title="翻译设置（供应商 / 术语表）"
        onClick={onOpenSettings}
        className="flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
      >
        <Sparkles size={13} className="text-blue-600 dark:text-blue-400" />
        {providerName}
        <Settings size={11} className="text-neutral-400" />
      </button>

      <span
        title={engineOnline ? "Python 引擎在线（版面/OCR/合成）" : "引擎离线，使用本地兜底管线"}
        className="flex shrink-0 items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${engineOnline ? "bg-green-500" : "bg-neutral-400"}`} />
        {engineOnline ? "引擎在线" : "本地管线"}
      </span>

      <div className="mx-0.5 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />

      <Toggle
        on={useGlossary}
        onClick={onToggleUseGlossary}
        label="术语表"
        title="启用术语表：按文档命中的词条强制统一译法"
      />
      {showAnchorLayout && (
        <Toggle
          on={anchorLayout}
          onClick={onToggleAnchorLayout}
          label="保版式"
          title="译文锚定在原文段落位置（保留原版式）；关闭则用 BabelDOC 重排"
        />
      )}
      <Toggle
        on={forceRebuild}
        onClick={onToggleForceRebuild}
        label="重识别"
        title="用自有 PP-OCRv6 校正文字（版面坐标仍用 PDF 原始文字层）"
      />

      <div className="mx-0.5 h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-700" />

      {job?.running ? (
        <>
          <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400">
            <Loader2 size={12} className="animate-spin" />
            {job.stageText ??
              (job.phase === "layout"
                ? "正在识别版面…"
                : job.phase === "ocr"
                  ? "正在 OCR 识别…"
                  : `翻译中 · 段落 ${job.doneBlocks}/${job.totalBlocks}`)}
          </span>
          <BarButton onClick={onCancel} icon={<Square size={10} />}>
            停止
          </BarButton>
        </>
      ) : (
        <>
          <BarButton
            onClick={onTranslateAll}
            disabled={numPages === 0}
            icon={<Sparkles size={11} />}
          >
            翻译整份文档
          </BarButton>
        </>
      )}

      {children}

      <div className="flex-1" />

      <span className="shrink-0 text-[11px] text-neutral-400">
        已翻译 {translatedPages}/{numPages || "–"} 页
      </span>
    </div>
  );
}
