import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, FolderOpen, Loader2, Play, Square } from "lucide-react";
import {
  localModelStart,
  localModelStatus,
  localModelStop,
  type LocalModelStatus,
} from "../lib/engine";

const PATHS_KEY = "tr-local-model-paths";

type Paths = { modelPath: string; serverPath: string };

function loadPaths(): Paths {
  try {
    const raw = localStorage.getItem(PATHS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Paths>;
      return { modelPath: p.modelPath ?? "", serverPath: p.serverPath ?? "" };
    }
  } catch {
    /* ignore */
  }
  return { modelPath: "", serverPath: "" };
}

/** 通过 Tauri 文件对话框选文件；浏览器调试模式下退化为手动输入路径 */
async function pickFile(filterName: string, extensions: string[]): Promise<string | null> {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, filters: [{ name: filterName, extensions }] });
  return typeof picked === "string" ? picked : null;
}

/**
 * 本地模型（离线翻译）：选择 GGUF 模型文件与 llama-server 可执行文件，
 * 由本机引擎拉起 llama.cpp 服务，之后即可离线翻译。
 */
export function LocalModelCard() {
  const [paths, setPaths] = useState<Paths>(loadPaths);
  const [status, setStatus] = useState<LocalModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const polling = useRef(0);

  const refresh = useCallback(async () => {
    const st = await localModelStatus();
    setStatus(st);
    return st;
  }, []);

  useEffect(() => {
    void refresh();
    return () => window.clearInterval(polling.current);
  }, [refresh]);

  const persist = (next: Paths) => {
    setPaths(next);
    localStorage.setItem(PATHS_KEY, JSON.stringify(next));
  };

  const start = async () => {
    if (!paths.modelPath) {
      setMessage("请先选择模型文件（.gguf）");
      return;
    }
    setBusy(true);
    setMessage("正在加载模型（首次通常需要数十秒）…");
    try {
      const st = await localModelStart(paths.modelPath, paths.serverPath || undefined);
      setStatus(st);
      setMessage(`已就绪：${st.model ?? ""}（端口 ${st.port}）`);
      window.clearInterval(polling.current);
      polling.current = window.setInterval(() => void refresh(), 5000);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await localModelStop());
      setMessage("已停止");
      window.clearInterval(polling.current);
    } finally {
      setBusy(false);
    }
  };

  const ready = status?.ready ?? false;

  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-700">
      <div className="mb-2 flex items-center gap-2">
        <Cpu size={14} className="text-neutral-500" />
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
          本地模型（离线翻译）
        </span>
        <span
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
            ready
              ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
              : status?.running
                ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                : "bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${ready ? "bg-green-500" : "bg-neutral-400"}`} />
          {ready ? `就绪 · 端口 ${status?.port}` : status?.running ? "启动中" : "未启动"}
        </span>
        <div className="flex-1" />
        {busy ? (
          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
            <Loader2 size={12} className="animate-spin" /> 处理中…
          </span>
        ) : ready ? (
          <button
            type="button"
            onClick={() => void stop()}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Square size={11} /> 停止
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void start()}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            <Play size={11} /> 启动模型
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            value={paths.modelPath}
            onChange={(e) => persist({ ...paths, modelPath: e.target.value })}
            placeholder="模型文件路径（*.gguf，如 Hy-MT2-1.8B-Q4_K_M.gguf）"
            className="h-7 min-w-0 flex-1 rounded border border-neutral-200 bg-transparent px-2 text-xs outline-none focus:border-blue-500 dark:border-neutral-700"
          />
          <button
            type="button"
            onClick={async () => {
              const p = await pickFile("GGUF 模型", ["gguf"]);
              if (p) persist({ ...paths, modelPath: p });
            }}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <FolderOpen size={11} /> 选择模型
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={paths.serverPath}
            onChange={(e) => persist({ ...paths, serverPath: e.target.value })}
            placeholder="llama-server 路径（可留空，自动在常见位置查找）"
            className="h-7 min-w-0 flex-1 rounded border border-neutral-200 bg-transparent px-2 text-xs outline-none focus:border-blue-500 dark:border-neutral-700"
          />
          <button
            type="button"
            onClick={async () => {
              const p = await pickFile("llama-server", ["exe"]);
              if (p) persist({ ...paths, serverPath: p });
            }}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <FolderOpen size={11} /> 选择 llama-server
          </button>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
        启动后在「翻译供应商」里把当前供应商切到「本地模型（离线）」即可全程离线翻译；
        模型加载后常驻内存（约 2GB，与模型大小相关），用完可点「停止」释放。
      </p>
      {message && <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">{message}</p>}
      {status?.error && <p className="mt-1 text-[11px] text-red-500">{status.error}</p>}
    </div>
  );
}
