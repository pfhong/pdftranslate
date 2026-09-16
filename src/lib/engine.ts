/**
 * Python 引擎客户端：本地 FastAPI 服务（engine/）。
 * 引擎负责版面提取（PyMuPDF / PP-OCRv6）与译制 PDF 合成（redaction + htmlbox）；
 * 不可用时前端自动降级为本地 ONNX 管线。
 */

const ENGINE_URL_KEY = "tr-engine-url";

export function getEngineUrl(): string {
  return localStorage.getItem(ENGINE_URL_KEY) ?? "http://127.0.0.1:8765";
}

export function setEngineUrl(url: string): void {
  localStorage.setItem(ENGINE_URL_KEY, url);
}

export type EngineBlock = {
  index: number;
  bbox: [number, number, number, number];
  lines: { bbox: [number, number, number, number]; text: string }[];
  text: string;
  size: number;
  /** 粗体块（多为标题） */
  bold?: boolean;
  x0?: number;
};

export type EnginePage = {
  pageNumber: number;
  width: number;
  height: number;
  mode: "text" | "ocr";
  blocks: EngineBlock[];
};

export type EngineExtractResult = { pages: EnginePage[]; ocrAvailable: boolean };

export type EngineHealth = {
  online: boolean;
  version?: string;
  /** 引擎源码指纹：与磁盘上的 engine/*.py 不符说明跑的是旧进程 */
  build?: string;
  /** 引擎自己比对出的结论：进程内的代码比磁盘上的旧，需要重启引擎 */
  stale?: boolean;
};

/**
 * 引擎健康检查。除了"在不在线"还要带回 version/build/stale：
 * 引擎是常驻进程，把指纹与新旧比对显示出来，
 * 才看得出自己连的是不是磁盘上这份代码。
 */
export async function engineHealth(): Promise<EngineHealth> {
  try {
    const r = await fetch(`${getEngineUrl()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) {
      lastHealth = { online: false };
      return lastHealth;
    }
    const info = (await r.json().catch(() => ({}))) as {
      version?: string;
      build?: string;
      stale?: boolean;
    };
    lastHealth = {
      online: true,
      version: info.version,
      build: info.build,
      stale: info.stale,
    };
    return lastHealth;
  } catch {
    lastHealth = { online: false };
    return lastHealth;
  }
}

// ── 引擎按需启动 ──────────────────────────────────────────────
// 引擎不随应用启动而常驻：真正要用之前调 engineEnsure()，没起就拉起来。
// 结果通过订阅广播给界面（状态栏的引擎指示灯据此刷新）。

type EngineSubscriber = (health: EngineHealth) => void;
const engineSubscribers = new Set<EngineSubscriber>();

/** 最近一次探到的引擎状态：翻译缓存的键要用它，见 engineBuildTag() */
let lastHealth: EngineHealth = { online: false };

/**
 * 当前引擎的源码指纹（离线时为空串）。
 *
 * 翻译结果缓存必须带上它：引擎行为变了（比如修好了"选西班牙语却译成中文"），
 * 旧指纹下缓存的中文译文就会被继续命中，用户看到的还是老结果。
 * 带上指纹后引擎一更新，缓存自然全部失效。
 */
export function engineBuildTag(): string {
  return lastHealth.online ? (lastHealth.build ?? "") : "";
}

/** 订阅引擎健康变化，返回取消订阅函数 */
export function subscribeEngine(fn: EngineSubscriber): () => void {
  engineSubscribers.add(fn);
  return () => engineSubscribers.delete(fn);
}

function publishEngine(health: EngineHealth): void {
  lastHealth = health;
  for (const fn of engineSubscribers) fn(health);
}

/**
 * 确保引擎可用：已在线直接返回；否则请 Rust 侧拉起再复检。
 * 所有要用引擎的动作（翻译、术语抽取、本地模型）动手前都应先 await 它，
 * 拿到返回值再决定走引擎还是本地兜底——不能只看订阅来的状态，那是上一轮的。
 */
export async function engineEnsure(): Promise<EngineHealth> {
  const current = await engineHealth();
  if (current.online) {
    publishEngine(current);
    return current;
  }
  const { isTauri } = await import("./open-pdf");
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<boolean>("ensure_engine");
    } catch (err) {
      console.warn("拉起翻译引擎失败", err);
    }
  }
  const after = await engineHealth();
  publishEngine(after);
  return after;
}

export async function engineExtract(
  pdf: Uint8Array,
  forceOcr = false,
): Promise<EngineExtractResult> {
  const url = `${getEngineUrl()}/extract${forceOcr ? "?force_ocr=true" : ""}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body: pdf as BlobPart,
  });
  if (!r.ok) throw new Error(`引擎版面提取失败（HTTP ${r.status}）`);
  return (await r.json()) as EngineExtractResult;
}

export type EngineTranslation = {
  page: number;
  block: number;
  bbox: [number, number, number, number];
  lines: number[][];
  text: string;
};

export async function engineSynthesize(
  pdf: Uint8Array,
  translations: EngineTranslation[],
): Promise<Uint8Array> {
  const r = await fetch(`${getEngineUrl()}/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdf: toBase64(pdf), translations }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`引擎合成失败（HTTP ${r.status}）${body ? `：${body.slice(0, 200)}` : ""}`);
  }
  return new Uint8Array(await r.arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** BabelDOC 整本翻译结果 */
export type BabeldocResult = {
  mono: string | null;
  dual: string | null;
  seconds: number;
};

/** 当前 BabelDOC 任务进度 */
export type BabeldocProgress = {
  stage: string;
  overall: number;
  done: boolean;
  error: string | null;
};

export async function engineTranslateProgress(): Promise<BabeldocProgress | null> {
  try {
    const r = await fetch(`${getEngineUrl()}/translate_progress`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return null;
    return (await r.json()) as BabeldocProgress;
  } catch {
    return null;
  }
}

/** 整本翻译：BabelDOC 完整管线（YOLO 版面 + 字符级重排），需提供 OpenAI 兼容配置 */
export async function engineTranslateBabeldoc(
  pdf: Uint8Array,
  config: { baseUrl: string; apiKey: string; model: string },
  options?: {
    langIn?: string;
    langOut?: string;
    targetLangName?: string;
    pages?: string;
    forceRebuild?: boolean;
    useGlossary?: boolean;
  },
): Promise<BabeldocResult> {
  const r = await fetch(`${getEngineUrl()}/translate_babeldoc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pdf: toBase64(pdf),
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      langIn: options?.langIn ?? "en",
      langOut: options?.langOut ?? "zh",
      targetLangName: options?.targetLangName,
      pages: options?.pages,
      forceRebuild: options?.forceRebuild ?? false,
      useGlossary: options?.useGlossary ?? true,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`BabelDOC 翻译失败（HTTP ${r.status}）${body ? `：${body.slice(0, 200)}` : ""}`);
  }
  return (await r.json()) as BabeldocResult;
}


// ------------------------------------------------------------------ 术语表

export type GlossaryEntryDto = { source: string; target: string; targetLanguage?: string };

export async function glossaryList(): Promise<GlossaryEntryDto[]> {
  const r = await fetch(`${getEngineUrl()}/glossary`);
  if (!r.ok) throw new Error(`读取术语表失败（HTTP ${r.status}）`);
  return ((await r.json()) as { entries: GlossaryEntryDto[] }).entries ?? [];
}

export async function glossarySave(entries: GlossaryEntryDto[]): Promise<number> {
  const r = await fetch(`${getEngineUrl()}/glossary`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!r.ok) throw new Error(`保存术语表失败（HTTP ${r.status}）`);
  return ((await r.json()) as { count: number }).count ?? 0;
}

/** 返回文本中命中的术语（用于按批注入提示词） */
export async function glossaryActive(
  text: string,
  targetLang: string,
): Promise<[string, string][]> {
  try {
    const r = await fetch(`${getEngineUrl()}/glossary/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, targetLang }),
    });
    if (!r.ok) return [];
    return ((await r.json()) as { entries: [string, string][] }).entries ?? [];
  } catch {
    return [];
  }
}

export async function glossaryImportCsv(csv: string, mode: "merge" | "replace"): Promise<number> {
  const r = await fetch(`${getEngineUrl()}/glossary/import?mode=${mode}`, {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: csv,
  });
  if (!r.ok) throw new Error(`导入失败（HTTP ${r.status}）`);
  return ((await r.json()) as { count: number }).count ?? 0;
}

export async function glossaryExportCsv(): Promise<string> {
  const r = await fetch(`${getEngineUrl()}/glossary/export`);
  if (!r.ok) throw new Error(`导出失败（HTTP ${r.status}）`);
  return await r.text();
}


// ------------------------------------------------------------- 本地模型

export type LocalModelStatus = {
  running: boolean;
  ready: boolean;
  /** 就绪的模型是否由本引擎拉起；false 表示复用了外部实例（停不掉它） */
  owned?: boolean;
  /** 实际在用的推理设备（如 "Vulkan0: NVIDIA GeForce RTX 2060 SUPER (...)"），纯 CPU 时为 "CPU" */
  device?: string;
  /** 该 llama-server 能用的 GPU 设备（CPU-only 构建为空数组） */
  gpuDevices?: string[];
  /** 卸载到显卡的层数，0 = 纯 CPU */
  gpuLayers?: number;
  /** 当前 exe 用不了显卡、但发现了可用的 GPU 版时，这里给出它的路径 */
  suggestedServerPath?: string | null;
  pid?: number | null;
  port: number;
  model: string | null;
  modelPath: string | null;
  serverPath: string | null;
  error: string | null;
};

export async function localModelStatus(): Promise<LocalModelStatus | null> {
  try {
    const r = await fetch(`${getEngineUrl()}/local_model/status`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return (await r.json()) as LocalModelStatus;
  } catch {
    return null;
  }
}

export async function localModelStart(
  modelPath: string,
  serverPath?: string,
  /** 卸载层数：不传=自动（有 GPU 就全卸载）；0=强制纯 CPU */
  gpuLayers?: number,
): Promise<LocalModelStatus> {
  const r = await fetch(`${getEngineUrl()}/local_model/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelPath, serverPath, gpuLayers }),
  });
  const body = (await r.json()) as LocalModelStatus & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `启动失败（HTTP ${r.status}）`);
  return body;
}

export async function localModelStop(): Promise<LocalModelStatus | null> {
  try {
    const r = await fetch(`${getEngineUrl()}/local_model/stop`, { method: "POST" });
    if (!r.ok) return null;
    return (await r.json()) as LocalModelStatus;
  } catch {
    return null;
  }
}
