/**
 * 本地模型（离线翻译）的公共部分：路径持久化 + 按需拉起。
 *
 * 本地模型是引擎托管的 llama-server 子进程。选了「本地模型（离线）」这个供应商，
 * 光有引擎还不够——模型本身也得在跑，否则引擎会直接回 409「本地模型未就绪」。
 * 所以翻译前要检查的是"引擎 + 模型"两件事，这里负责后半件。
 */
import {
  getEngineUrl,
  localModelStart,
  localModelStatus,
  type LocalModelStatus,
} from "./engine";

const PATHS_KEY = "tr-local-model-paths";

export type LocalModelPaths = {
  /** 用户只需选模型文件；llama-server 由项目自带（engine/bin、engine/bin-vulkan） */
  modelPath: string;
  /** 有 GPU 后端时是否卸载到显卡（默认开；显存不够可关掉） */
  useGpu?: boolean;
};

/** 卡片与翻译路径共用同一份路径配置 */
export function loadLocalModelPaths(): LocalModelPaths {
  try {
    const raw = localStorage.getItem(PATHS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<LocalModelPaths>;
      return { modelPath: p.modelPath ?? "", useGpu: p.useGpu !== false };
    }
  } catch {
    /* 存储损坏时按未配置处理 */
  }
  return { modelPath: "", useGpu: true };
}

export function saveLocalModelPaths(paths: LocalModelPaths): void {
  try {
    localStorage.setItem(PATHS_KEY, JSON.stringify(paths));
  } catch {
    /* 忽略存储错误 */
  }
}

/**
 * 这个供应商是不是走引擎托管的本地模型。
 * 认的是地址而不是 id——用户自定义一个指向同一地址的供应商也应当算。
 */
export function isLocalModelProvider(baseURL: string): boolean {
  const url = (baseURL ?? "").trim().replace(/\/+$/, "").toLowerCase();
  if (!url) return false;
  return url === `${getEngineUrl().replace(/\/+$/, "").toLowerCase()}/local/v1`;
}

export type EnsureLocalModelResult = {
  ok: boolean;
  /** 失败时给用户看的原因 */
  message?: string;
  status?: LocalModelStatus | null;
};

/**
 * 确保本地模型可用：没起就按已保存的路径拉起来（首次要加载模型，约 10–30 秒）。
 * 已在加载/已就绪时会很快返回。
 */
export async function ensureLocalModel(): Promise<EnsureLocalModelResult> {
  const current = await localModelStatus();
  if (current?.ready) return { ok: true, status: current };

  const paths = loadLocalModelPaths();
  if (!paths.modelPath) {
    return {
      ok: false,
      message:
        "本地模型还没配置模型文件。打开翻译设置 →「本地模型（离线）」→ 选择模型文件（*.gguf）后重试。",
    };
  }
  try {
    // 不传 serverPath：引擎从自带的运行时里挑（有显卡就用 GPU 版）
    // useGpu=false 时显式传 0 强制 CPU
    const started = await localModelStart(
      paths.modelPath,
      undefined,
      paths.useGpu === false ? 0 : undefined,
    );
    if (started?.ready) return { ok: true, status: started };
    return {
      ok: false,
      message: started?.error ?? "本地模型启动失败，请查看翻译设置里的状态。",
      status: started ?? null,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message ?? String(err) };
  }
}
