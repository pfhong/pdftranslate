import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Languages,
  RefreshCw,
  XCircle,
} from "lucide-react";
import type { PDFDocumentProxy } from "../lib/pdf";
import { PdfViewer, type PdfViewerHandle } from "./PdfViewer";
import { TranslationBar } from "./TranslationBar";

export type JobState = {
  running: boolean;
  doneBlocks: number;
  totalBlocks: number;
  phase: "layout" | "ocr" | "translate";
  /** 引擎 BabelDOC 管线的实时阶段描述（优先显示） */
  stageText?: string;
};

type Props = {
  doc: PDFDocumentProxy;
  translatedDoc: PDFDocumentProxy | null;
  job: JobState | null;
  translatedPages: number;
  hasTranslations: boolean;
  fontMissing: boolean;
  previewError: string | null;
  currentPage: number;
  providerLabel: string;
  onOpenSettings: () => void;
  onTranslatePage: (page: number) => void;
  engineOnline: boolean;
  forceRebuild: boolean;
  onToggleForceRebuild: () => void;
  anchorLayout: boolean;
  onToggleAnchorLayout: () => void;
  zoom: number;
  onFitScaleChange: (scale: number) => void;
  onWheelZoom: (dir: 1 | -1) => void;
  onRenderError: (page: number, message: string) => void;
  useGlossary: boolean;
  onToggleUseGlossary: () => void;
  onPageChange: (page: number) => void;
  onStartAll: () => void;
  onCancel: () => void;
  onRefreshPreview: () => void;
  onExportTranslated: () => void;
  onExportDual: () => void;
};

function ControlButton({
  onClick,
  disabled,
  icon,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 items-center gap-1 rounded-md border border-neutral-200 px-2 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 disabled:pointer-events-none disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {icon}
      {children}
    </button>
  );
}

export function DualView({
  doc,
  translatedDoc,
  job,
  translatedPages,
  hasTranslations,
  fontMissing,
  previewError,
  currentPage,
  providerLabel,
  onOpenSettings,
  onTranslatePage,
  engineOnline,
  forceRebuild,
  onToggleForceRebuild,
  anchorLayout,
  onToggleAnchorLayout,
  zoom,
  onFitScaleChange,
  onWheelZoom,
  onRenderError,
  useGlossary,
  onToggleUseGlossary,
  onPageChange,
  onStartAll,
  onCancel,
  onRefreshPreview,
  onExportTranslated,
  onExportDual,
}: Props) {
  const rightRef = useRef<PdfViewerHandle>(null);
  const [sync, setSync] = useState(true);

  // 页级同步：左栏翻页/滚动时右栏跟随（单向）
  useEffect(() => {
    if (sync && translatedDoc) rightRef.current?.scrollToPage(currentPage);
  }, [currentPage, sync, translatedDoc]);

  const handleLeftPageChange = useCallback(
    (page: number) => {
      onPageChange(page);
    },
    [onPageChange],
  );

  return (
    <div className="flex h-full flex-col">
      <TranslationBar
        providerName={providerLabel}
        engineOnline={engineOnline}
        useGlossary={useGlossary}
        onToggleUseGlossary={onToggleUseGlossary}
        anchorLayout={anchorLayout}
        onToggleAnchorLayout={onToggleAnchorLayout}
        forceRebuild={forceRebuild}
        onToggleForceRebuild={onToggleForceRebuild}
        job={job}
        onTranslateAll={onStartAll}
        onCancel={onCancel}
        onOpenSettings={onOpenSettings}
        translatedPages={translatedPages}
        numPages={doc.numPages}
      >
        <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          <input
            type="checkbox"
            checked={sync}
            onChange={(e) => setSync(e.target.checked)}
            className="h-3 w-3 accent-blue-600"
          />
          页码同步
        </label>
        {hasTranslations && (
          <ControlButton onClick={onExportTranslated} icon={<Download size={11} />}>
            导出译文 PDF
          </ControlButton>
        )}
        {hasTranslations && translatedDoc && (
          <ControlButton onClick={onExportDual} icon={<Download size={11} />}>
            导出双语对照
          </ControlButton>
        )}
        {hasTranslations && !job?.running && (
          <ControlButton onClick={onRefreshPreview} icon={<RefreshCw size={11} />}>
            刷新预览
          </ControlButton>
        )}
      </TranslationBar>

      {/* 左右分栏 */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <PdfViewer
            doc={doc}
            zoom={zoom}
            onPageChange={handleLeftPageChange}
            onFitScaleChange={onFitScaleChange}
            onRenderError={onRenderError}
            onWheelZoom={onWheelZoom}
            onContextTranslatePage={onTranslatePage}
          />
        </div>
        <div className="w-px shrink-0 bg-neutral-300 dark:bg-neutral-700" />
        <div className="relative min-w-0 flex-1">
          {translatedDoc ? (
            <PdfViewer
              ref={rightRef}
              doc={translatedDoc}
              zoom={zoom}
              onPageChange={() => {}}
              onFitScaleChange={() => {}}
              onRenderError={onRenderError}
              onWheelZoom={onWheelZoom}
              onContextTranslatePage={onTranslatePage}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-neutral-50 px-8 text-center dark:bg-neutral-950">
              {fontMissing ? (
                <>
                  <XCircle size={28} className="text-red-400" />
                  <p className="text-sm text-neutral-600 dark:text-neutral-300">
                    未找到中文排印字体（fonts/zh.ttf 或系统黑体），无法合成译制 PDF。
                  </p>
                </>
              ) : previewError ? (
                <>
                  <XCircle size={28} className="text-red-400" />
                  <p className="max-w-md text-sm leading-relaxed text-red-500">{previewError}</p>
                </>
              ) : (
                <>
                  <Languages size={28} className="text-neutral-300 dark:text-neutral-600" />
                  <p className="max-w-xs text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {job?.running
                      ? job.stageText
                        ? job.stageText
                        : job.phase === "layout"
                          ? "正在识别版面结构，稍后开始翻译…"
                          : job.phase === "ocr"
                            ? "正在用 PP-OCR 识别页面文字与坐标…"
                            : `翻译进行中（段落 ${job.doneBlocks}/${job.totalBlocks}），完成后将自动生成译制 PDF。`
                      : hasTranslations
                        ? "译文已就绪，点击上方「刷新预览」生成译制 PDF。"
                        : "点击上方「翻译整份文档」，或在页面上右键选择「翻译此页」。原文页将按段落替换为译文，公式与图表保持原样。"}
                  </p>
                  {job?.running && job.phase === "translate" && (
                    <div className="h-1 w-48 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{
                          width: `${(job.doneBlocks / Math.max(job.totalBlocks, 1)) * 100}%`,
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
