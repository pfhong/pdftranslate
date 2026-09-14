import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Plus, Save, Sparkles, Trash2, Upload } from "lucide-react";
import {
  glossaryExportCsv,
  glossaryImportCsv,
  glossaryList,
  glossarySave,
  type GlossaryEntryDto,
} from "../lib/engine";
import { cacheClear, cacheSize } from "../lib/trans-cache";

const inputClass =
  "h-7 w-full rounded border border-neutral-200 bg-transparent px-2 text-xs outline-none transition-colors focus:border-blue-500 dark:border-neutral-700";

/**
 * 术语表编辑：源词 → 目标译法（可选限定目标语言）。
 * 支持 CSV 导入导出（与 BabelDOC 的 glossary.csv 格式一致）。
 */
export function GlossaryEditor({ onExtractTerms }: { onExtractTerms?: () => Promise<GlossaryEntryDto[]> }) {
  const [entries, setEntries] = useState<GlossaryEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [cacheCount, setCacheCount] = useState(0);
  const [extracting, setExtracting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        setEntries(await glossaryList());
      } catch (err) {
        setStatus((err as Error).message);
      } finally {
        setLoading(false);
        setCacheCount(cacheSize());
      }
    })();
  }, []);

  const update = (idx: number, patch: Partial<GlossaryEntryDto>) =>
    setEntries((list) => list.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  const save = async () => {
    setStatus(null);
    try {
      const count = await glossarySave(entries);
      setEntries(await glossaryList());
      setStatus(`已保存 ${count} 条术语`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  const importCsv = async (file: File, mode: "merge" | "replace") => {
    setStatus(null);
    try {
      const text = await file.text();
      const count = await glossaryImportCsv(text, mode);
      setEntries(await glossaryList());
      setStatus(`导入完成，共 ${count} 条术语`);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  /** 从当前文档自动抽取候选术语（仅加入表格，保存后才生效） */
  const extractFromDoc = async () => {
    if (!onExtractTerms) return;
    setStatus(null);
    setExtracting(true);
    try {
      const candidates = await onExtractTerms();
      if (candidates.length === 0) {
        setStatus("未抽取到新术语（可能都已在术语表中）。");
        return;
      }
      setEntries((list) => [
        ...list,
        ...candidates.map((c) => ({ source: c.source, target: c.target })),
      ]);
      setStatus(
        `已抽取 ${candidates.length} 个候选，按文档频次排序。请审阅/修改后点「保存术语表」生效。`,
      );
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setExtracting(false);
    }
  };

  const exportCsv = async () => {
    try {
      const csv = await glossaryExportCsv();
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "glossary.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <span className="shrink-0 text-xs font-medium text-neutral-600 dark:text-neutral-300">词条</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">
          命中词条会强制统一译法（不区分大小写；留空语言表示适用所有目标语言）
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void extractFromDoc()}
          disabled={!onExtractTerms || extracting}
          title="让模型从当前打开的文档中抽取候选术语，结果进入下表供你审阅"
          className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-blue-200 px-2 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-900 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          {extracting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {extracting ? "抽取中…" : "从当前文档抽取"}
        </button>
        <button
          type="button"
          onClick={() => setEntries((l) => [...l, { source: "", target: "" }])}
          className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Plus size={12} /> 添加词条
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {loading ? (
          <p className="flex items-center gap-2 text-xs text-neutral-400">
            <Loader2 size={12} className="animate-spin" /> 正在读取…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-neutral-400">
            还没有词条。可点「添加词条」手工维护，或导入 CSV（列：source,target,target_language）。
          </p>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] text-neutral-400">
                <th className="w-[38%] pb-1 font-normal">源词（原文）</th>
                <th className="w-[38%] pb-1 font-normal">目标译法</th>
                <th className="w-[18%] pb-1 font-normal">限定语言</th>
                <th className="w-[6%]" />
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td className="pr-2 pb-1">
                    <input
                      value={e.source}
                      onChange={(ev) => update(i, { source: ev.target.value })}
                      className={inputClass}
                      placeholder="qubit"
                    />
                  </td>
                  <td className="pr-2 pb-1">
                    <input
                      value={e.target}
                      onChange={(ev) => update(i, { target: ev.target.value })}
                      className={inputClass}
                      placeholder="量子比特"
                    />
                  </td>
                  <td className="pr-2 pb-1">
                    <input
                      value={e.targetLanguage ?? ""}
                      onChange={(ev) => update(i, { targetLanguage: ev.target.value })}
                      className={inputClass}
                      placeholder="（可选）zh"
                    />
                  </td>
                  <td className="pb-1 text-right">
                    <button
                      type="button"
                      title="删除"
                      onClick={() => setEntries((l) => l.filter((_, k) => k !== i))}
                      className="rounded p-1 text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="shrink-0 px-4 pb-3">
        {status && <p className="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400">{status}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void save()}
            className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500"
          >
            <Save size={12} /> 保存术语表
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-200 px-3 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Upload size={12} /> 导入 CSV（合并）
          </button>
          <button
            type="button"
            onClick={() => void exportCsv()}
            className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-neutral-200 px-3 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Download size={12} /> 导出 CSV
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setCacheCount(cacheClear())}
            title="清除已缓存的译文（下次翻译会重新请求）"
            className="h-8 shrink-0 whitespace-nowrap rounded-md border border-neutral-200 px-3 text-xs text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            清除译文缓存（{cacheCount}）
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            if (f) void importCsv(f, "merge");
            ev.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
