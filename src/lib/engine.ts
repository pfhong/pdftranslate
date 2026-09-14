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

export async function engineHealth(): Promise<boolean> {
  try {
    const r = await fetch(`${getEngineUrl()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
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
): Promise<LocalModelStatus> {
  const r = await fetch(`${getEngineUrl()}/local_model/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelPath, serverPath }),
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
