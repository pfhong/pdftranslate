import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, Settings, Sparkles, X } from "lucide-react";
import { providerLabel, translateText, type TranslateConfig } from "../lib/translate";

type Props = {
  text: string;
  /** 选区在视口中的位置（用于把浮层放到选区附近） */
  rect: { x: number; y: number; width: number; height: number };
  config: TranslateConfig;
  onOpenSettings: () => void;
  onClose: () => void;
};

const WIDTH = 360;

/**
 * 划词翻译浮层：贴着选区显示的小卡片，替代原来占据整个右侧的翻译面板。
 * 自动避让视口边缘；点击外部 / ESC / 滚动（由调用方清空选区）即关闭。
 */
export function SelectionPopover({ text, rect, config, onOpenSettings, onClose }: Props) {
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setResult("");
    setError(null);
    setCopied(false);
  }, [text]);

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延后绑定，避免触发本次划词的 mouseup 立即关闭
    const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = useCallback(async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await translateText(text, config));
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [text, config, busy]);

  const left = Math.min(Math.max(rect.x + rect.width / 2 - WIDTH / 2, 8), window.innerWidth - WIDTH - 8);
  const below = rect.y + rect.height + 8;
  const top = below + 220 > window.innerHeight ? Math.max(8, rect.y - 232) : below;

  return (
    <div
      ref={cardRef}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-2.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left, top, width: WIDTH }}
    >
      <div className="flex items-center gap-1.5">
        <Sparkles size={12} className="shrink-0 text-blue-600 dark:text-blue-400" />
        <span className="shrink-0 text-[10px] text-neutral-400">{providerLabel(config)}</span>
        <div className="flex-1" />
        <button
          type="button"
          title="翻译设置"
          onClick={onOpenSettings}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >
          <Settings size={12} />
        </button>
        <button
          type="button"
          title="关闭"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
        >
          <X size={12} />
        </button>
      </div>

      <p className="max-h-16 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        {text}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="flex h-6 items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-2 text-[11px] font-medium text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          翻译
        </button>
        {result && (
          <button
            type="button"
            title="复制译文"
            onClick={() => {
              void navigator.clipboard.writeText(result);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
          >
            {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
          </button>
        )}
      </div>

      {error && <p className="text-[11px] text-red-500">{error}</p>}
      {result && (
        <p className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-2 text-xs leading-relaxed text-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-100">
          {result}
        </p>
      )}
    </div>
  );
}
