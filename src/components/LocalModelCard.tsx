import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, FolderOpen, Loader2, Play, Square } from "lucide-react";
import {
  loadLocalModelPaths,
  saveLocalModelPaths,
  type LocalModelPaths,
} from "../lib/local-model";
import { openExternal } from "../lib/open-external";
import {
  engineEnsure,
  localModelStart,
  localModelStatus,
  localModelStop,
  type LocalModelStatus,
} from "../lib/engine";

type Paths = LocalModelPaths;

/**
 * 模型下载地址（写进界面的一切都已核实可访问；HF 直链返回的 content-length
 * 与本机在用的那份文件一致：1133080448 字节 ≈ 1.1GB）。
 * 本项目不分发模型文件，请使用者自行下载。
 */
const MODEL_DOWNLOADS = {
  scopePage: "https://www.modelscope.cn/models/Tencent-Hunyuan/Hy-MT2-1.8B-GGUF",
  scopeFile:
    "https://www.modelscope.cn/models/Tencent-Hunyuan/Hy-MT2-1.8B-GGUF/resolve/master/Hy-MT2-1.8B-Q4_K_M.gguf",
  hfPage: "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF",
  hfFile: "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/main/Hy-MT2-1.8B-Q4_K_M.gguf",
  project: "https://github.com/Tencent-Hunyuan/Hy-MT2",
};

/** 下载链接的统一样式 */
function DownloadLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(url)}
      className="text-left text-[11px] text-blue-600 hover:underline dark:text-blue-400"
    >
      {children}
    </button>
  );
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
  const [paths, setPaths] = useState<Paths>(loadLocalModelPaths);
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
    // 与"翻译时按需拉起"共用同一份配置
    saveLocalModelPaths(next);
  };

  /** cfg 可显式传入：切换后端时状态还没更新，不能读旧的 paths */
  const start = async (cfg: Paths = paths) => {
    if (!cfg.modelPath) {
      setMessage("请先选择模型文件（.gguf）");
      return;
    }
    setBusy(true);
    setMessage("正在加载模型（首次通常需要数十秒）…");
    try {
      // 本地模型由引擎托管：先把引擎拉起来（引擎不常驻），再让它加载模型
      const engine = await engineEnsure();
      if (!engine.online) throw new Error("翻译引擎未能启动，无法加载本地模型。");
      // 关掉「使用显卡」就显式传 0 强制 CPU，否则交给引擎自动决定
      const st = await localModelStart(
        cfg.modelPath,
        undefined,
        cfg.useGpu === false ? 0 : undefined,
      );
      setStatus(st);
      setMessage(
        st.gpuLayers
          ? `已就绪：${st.model ?? ""}（显卡推理，端口 ${st.port}）`
          : `已就绪：${st.model ?? ""}（CPU 推理，端口 ${st.port}）`,
      );
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

  /**
   * 切换 CPU / 显卡：卸载层数是 llama-server 的启动参数，光改设置不生效，
   * 必须重启进程。这里一次点完（改设置 → 停 → 用新设置起），不让用户去点停止再启动。
   */
  const switchBackend = async (next: Paths) => {
    persist(next);
    if (!ready && !status?.running) return; // 没在跑就不用重启，下次启动自然生效
    setBusy(true);
    try {
      await stop();
      await start(next);
    } finally {
      setBusy(false);
    }
  };

  const ready = status?.ready ?? false;
  /** 就绪但不是本引擎拉的（如另一个应用占了同一端口）——"停止"按钮对它无效 */
  const owned = status?.owned ?? false;

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
          {ready
            ? `就绪 · ${status?.gpuLayers ? "GPU" : "CPU"} · 端口 ${status?.port}${owned ? "" : "（外部实例）"}`
            : status?.running
              ? "启动中"
              : "未启动"}
        </span>
        <div className="flex-1" />
        {ready && status?.device && (
          <span
            className="truncate text-[10px] text-neutral-400 dark:text-neutral-500"
            title={status.device}
          >
            {status.device}
          </span>
        )}
        {busy ? (
          <span className="flex items-center gap-1 text-[11px] text-neutral-500">
            <Loader2 size={12} className="animate-spin" /> 处理中…
          </span>
        ) : ready && !owned ? (
          <span
            title="这个 llama-server 不是本引擎拉起的（例如另一个应用先占用了同一端口），请到对应应用里停止它"
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
          >
            <Cpu size={11} /> 复用中
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
        {/* 没有本地模型时去哪下：只给下载入口，本项目不分发模型文件 */}
        <div className="mt-2 rounded-md bg-neutral-50 px-2.5 py-2 dark:bg-neutral-800/50">
          <div className="text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
            还没有本地模型？
          </div>
          <div className="mt-1 flex flex-col gap-0.5">
            <span className="text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              · 国内推荐：
              <DownloadLink url={MODEL_DOWNLOADS.scopePage}>ModelScope</DownloadLink>
              上的 <span className="text-neutral-600 dark:text-neutral-300">Hy-MT2-1.8B-GGUF</span>
              （腾讯混元翻译，33 种语言）
            </span>
            <span className="text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              · 或 HuggingFace：
              <DownloadLink url={MODEL_DOWNLOADS.hfPage}>tencent/Hy-MT2-1.8B-GGUF</DownloadLink>
            </span>
            <span className="text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              · 直接下载：
              <DownloadLink url={MODEL_DOWNLOADS.hfFile}>Q4_K_M（约 1.1GB）</DownloadLink>
              {" / "}
              <DownloadLink url={MODEL_DOWNLOADS.scopeFile}>ModelScope 同款</DownloadLink>
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            下载完在下面「模型文件路径」里选它即可；同一仓库还有 Q6_K / Q8_0，体积更大、精度更高，
            机器吃得住可以选。<DownloadLink url={MODEL_DOWNLOADS.project}>模型说明与许可</DownloadLink>
            见官方仓库（模型由使用者自行下载，本项目不再分发）。
          </p>
        </div>

        {/* 推理后端：带 CUDA/Vulkan 后端的 llama-server 才能用显卡 */}
        <label
          className="flex cursor-pointer items-center gap-1.5 pl-1 text-[11px] text-neutral-600 dark:text-neutral-300"
          title="切换会重新加载模型（CPU/显卡是 llama-server 的启动参数，改完必须重启进程）；显存不够时可关掉"
        >
          <input
            type="checkbox"
            checked={paths.useGpu !== false}
            disabled={busy}
            onChange={(e) => void switchBackend({ ...paths, useGpu: e.target.checked })}
            className="h-3 w-3 accent-blue-600"
          />
          使用显卡（需带 CUDA/Vulkan 后端的 llama-server，实测约 2.5 倍提速）
        </label>
        {ready && status?.gpuLayers ? (
          <p className="pl-1 text-[10px] text-green-600 dark:text-green-400">
            已卸载 {status.gpuLayers} 层到显卡推理（{status.device?.split(":")[0]}）
          </p>
        ) : ready ? (
          <p className="pl-1 text-[10px] text-amber-600 dark:text-amber-400">
            {paths.useGpu === false
              ? "已按设置强制使用 CPU 推理"
              : "未检测到可用的显卡后端，使用 CPU 推理（引擎自带 Vulkan 版，需要显卡驱动支持 Vulkan）"}
          </p>
        ) : (
          <p className="pl-1 text-[10px] text-neutral-400 dark:text-neutral-500">
            llama-server 由引擎自带（有显卡自动用 GPU 版）；这里只需要选模型文件
          </p>
        )}
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
