/**
 * 翻译服务抽象：统一翻译入口 + 多供应商管理。
 * - "mock"：离线模拟后端，无需配置即可打通链路
 * - OpenAI 兼容供应商（DeepSeek / OpenAI / Moonshot / GLM / 硅基流动 / Ollama 等）：
 *   内置预设 + 支持自定义添加，后续本地模型走同样协议即可接入
 */

export type ProviderProfile = {
  id: string;
  /** 显示名 */
  label: string;
  /** OpenAI 兼容接口地址 */
  baseURL: string;
  apiKey: string;
  model: string;
  /** 内置预设不可删除 */
  preset?: boolean;
};

/** 离线模拟后端（内置） */
export const MOCK_PROVIDER_ID = "mock";

export const PRESET_PROVIDERS: ProviderProfile[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-flash",
    preset: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    preset: true,
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    apiKey: "",
    model: "moonshot-v1-8k",
    preset: true,
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    apiKey: "",
    model: "glm-4-flash",
    preset: true,
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseURL: "https://api.siliconflow.cn/v1",
    apiKey: "",
    model: "deepseek-ai/DeepSeek-V3",
    preset: true,
  },
  {
    id: "local",
    label: "本地模型（离线）",
    // 由本机引擎代理到 llama.cpp，遵守 Hy-MT 官方提示词模板，无需联网
    baseURL: "http://127.0.0.1:8765/local/v1",
    apiKey: "local",
    model: "hy-mt2-1.8b",
    preset: true,
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    model: "qwen2.5:7b",
    preset: true,
  },
];

export type TranslateConfig = {
  /** 可用供应商（含内置预设与自定义） */
  profiles: ProviderProfile[];
  /** 当前生效的供应商 id（mock 或某 profile.id） */
  activeId: string;
  /** 目标语言描述（如“简体中文”） */
  targetLang: string;
  /** 用户自行添加的语言（内置清单之外） */
  customLangs?: string[];
};

export const DEFAULT_CONFIG: TranslateConfig = {
  profiles: PRESET_PROVIDERS,
  activeId: "deepseek",
  targetLang: "简体中文",
};

const STORAGE_KEY = "tr-translate-config";

export function loadTranslateConfig(): TranslateConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw) as Partial<TranslateConfig>;
    // 存储的供应商列表完整优先（含用户填写的 apiKey）——
    // 不能用内置预设覆盖，否则每次启动都会把密钥冲掉
    const profiles = (parsed.profiles ?? []).map((p) =>
      // 旧默认模型一次性迁移：deepseek-chat → deepseek-flash
      p.id === "deepseek" && p.model === "deepseek-chat"
        ? { ...p, model: "deepseek-flash" }
        : p,
    );
    if (profiles.length > 0) {
      // 补齐后来新增的内置预设（如本地模型）
      const ids = new Set(profiles.map((p) => p.id));
      for (const preset of PRESET_PROVIDERS) {
        if (!ids.has(preset.id)) profiles.push({ ...preset });
      }
    }
    return {
      profiles:
        profiles.length > 0 ? profiles : structuredClone(DEFAULT_CONFIG.profiles),
      activeId: parsed.activeId ?? DEFAULT_CONFIG.activeId,
      targetLang: parsed.targetLang ?? DEFAULT_CONFIG.targetLang,
      customLangs: parsed.customLangs ?? [],
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveTranslateConfig(config: TranslateConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** 生成自定义供应商的临时 id */
export function newProviderId(): string {
  return `custom-${Date.now().toString(36)}`;
}

export function providerLabel(config: TranslateConfig): string {
  if (config.activeId === MOCK_PROVIDER_ID) return "模拟后端";
  return config.profiles.find((p) => p.id === config.activeId)?.label ?? "未配置";
}

function systemPrompt(targetLang: string): string {
  return [
    `你是专业的 PDF 文档翻译引擎，把用户给出的内容翻译为${targetLang}。`,
    "要求：准确、简洁，符合学术与技术文档的表达习惯，专有名词首次出现时可括注原文。",
    "只输出译文本身，不要任何解释或引号。",
  ].join("\n");
}

async function translateViaOpenAI(
  text: string,
  profile: ProviderProfile,
  targetLang: string,
  glossaryBlock?: string,
): Promise<string> {
  if (!profile.baseURL || !profile.apiKey) {
    throw new Error(`「${profile.label}」尚未配置 API 地址或密钥，请打开翻译设置。`);
  }
  const url = `${profile.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: glossaryBlock ? `${systemPrompt(targetLang)}

${glossaryBlock}` : systemPrompt(targetLang),
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${profile.label} 请求失败（HTTP ${response.status}）${body ? `：${body.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("翻译服务返回内容为空或格式异常");
  }
  return content.trim();
}

/** 通用对话调用（OpenAI 兼容）：供术语抽取等非翻译任务使用 */
export async function llmChat(
  messages: { role: "system" | "user"; content: string }[],
  config: TranslateConfig,
  temperature = 0.1,
): Promise<string> {
  const profile = config.profiles.find((p) => p.id === config.activeId);
  if (!profile || !profile.baseURL || !profile.apiKey) {
    throw new Error("请先在翻译设置中配置可用供应商（术语抽取需要调用模型）。");
  }
  const url = `${profile.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({ model: profile.model, temperature, messages }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${profile.label} 请求失败（HTTP ${response.status}）${body ? `：${body.slice(0, 160)}` : ""}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("模型返回内容为空或格式异常");
  }
  return content.trim();
}

/** 术语抽取提示词：要求模型只输出 JSON 数组 */
export function termExtractionPrompt(text: string, targetLang: string): string {
  return [
    "你是文档术语抽取器。从下面的文档内容中抽取关键术语（专有名词、缩略语、领域概念），",
    `并给出它们在「${targetLang}」中的标准译法。`,
    "",
    "要求：",
    '1. 只输出 JSON 数组，不要解释、不要代码围栏： [{"source": "...", "target": "..."}]',
    "2. 抽取 15~40 个，优先高频、专业性强、且译法容易不一致的术语",
    "3. source 保留文档中的原样写法（大小写、连字符、空格）",
    "4. 人名、机构名保留原文作为 target；不要收录常见虚词",
    "",
    "文档内容：",
    text,
  ].join("\n");
}

/** 解析模型返回的术语 JSON（容忍代码围栏、前后噪声、行式 "a → b" 回退） */
export function parseTermCandidates(raw: string): { source: string; target: string }[] {
  const out: { source: string; target: string }[] = [];
  const cleaned = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && typeof item === "object") {
            const rec = item as Record<string, unknown>;
            const source = String(rec.source ?? rec.term ?? rec.原文 ?? "").trim();
            const target = String(rec.target ?? rec.translation ?? rec.译文 ?? "").trim();
            if (source && target) out.push({ source, target });
          }
        }
      }
    } catch {
      /* 落到行式解析 */
    }
  }
  if (out.length === 0) {
    for (const line of cleaned.split("\n")) {
      const m = line.match(/^\s*[-*\d.]*\s*(.+?)\s*(?:→|->|=>|:|：|	)\s*(.+?)\s*$/);
      if (m) {
        const source = m[1].replace(/^["'`]|["'`]$/g, "").trim();
        const target = m[2].replace(/^["'`]|["'`]$/g, "").trim();
        if (source && target && source.length < 60) out.push({ source, target });
      }
    }
  }
  return out;
}

/**
 * 目标语言：内置 Hy-MT2 官方支持的候选（本地模型原生覆盖），
 * 用户可自行添加其他语言（云端 API 同样可用）。
 */
export const BUILTIN_TARGET_LANGS = [
  "简体中文", "英语", "法语", "葡萄牙语", "西班牙语", "日语", "土耳其语", "俄语",
  "阿拉伯语", "韩语", "泰语", "意大利语", "德语", "越南语", "马来语", "印尼语",
  "菲律宾语", "印地语", "繁体中文", "波兰语", "捷克语", "荷兰语", "高棉语", "缅甸语",
  "波斯语", "古吉拉特语", "乌尔都语", "泰卢固语", "马拉地语", "希伯来语", "孟加拉语",
  "泰米尔语", "乌克兰语", "藏语", "哈萨克语", "蒙古语", "维吾尔语", "粤语",
] as const;

const CUSTOM_LANGS_KEY = "tr-custom-langs";

export function loadCustomLangs(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_LANGS_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return arr.filter((x) => typeof x === "string" && x.trim());
  } catch {
    return [];
  }
}

export function saveCustomLangs(langs: string[]): void {
  localStorage.setItem(CUSTOM_LANGS_KEY, JSON.stringify(langs.filter((x) => x.trim())));
}

/** 合并内置 + 自定义（去重、保序：内置在前） */
export function targetLangOptions(config: TranslateConfig): string[] {
  const custom = (config.customLangs ?? []).filter((l) => !BUILTIN_TARGET_LANGS.includes(l as never));
  return [...BUILTIN_TARGET_LANGS, ...custom];
}

/** 翻译入口：按当前配置分发（单段；批量翻译用 translateBatch） */
export async function translateText(
  text: string,
  config: TranslateConfig,
  glossaryBlock?: string,
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (config.activeId === MOCK_PROVIDER_ID) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return `【模拟译文】${trimmed}`;
  }
  const profile = config.profiles.find((p) => p.id === config.activeId);
  if (!profile) throw new Error("当前翻译供应商不存在，请打开翻译设置。");
  return translateViaOpenAI(trimmed, profile, config.targetLang, glossaryBlock);
}

function batchSystemPrompt(targetLang: string): string {
  return [
    `你是专业的 PDF 文档翻译引擎。用户会用 <1><2>… 编号给出若干段文本，请将每段翻译为${targetLang}。`,
    "要求：",
    "1. 输出必须严格按相同编号逐段给出，每段以 <编号> 开头，例如 <1>译文内容",
    "2. 段落数量与顺序必须与输入完全一致，不得合并、拆分或遗漏",
    "3. 译文准确、简洁，符合学术与技术文档的表达习惯",
    "4. 只输出带编号的译文，不要任何解释",
  ].join("\n");
}

/**
 * 批量翻译：把若干段打包进一次请求（<1>..<n> 编号协议），
 * 返回与输入对齐的结果数组，失败/缺失项为 null（由调用方逐段兜底重试）。
 * 相比逐段请求，单次往返摊薄网络与排队开销，是整本翻译提速的关键。
 */
export async function translateBatch(
  texts: string[],
  config: TranslateConfig,
  glossaryBlock?: string,
): Promise<(string | null)[]> {
  if (config.activeId === MOCK_PROVIDER_ID) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return texts.map((t) => `【模拟译文】${t}`);
  }
  const profile = config.profiles.find((p) => p.id === config.activeId);
  if (!profile) throw new Error("当前翻译供应商不存在，请打开翻译设置。");
  if (!profile.baseURL || !profile.apiKey) {
    throw new Error(`「${profile.label}」尚未配置 API 地址或密钥，请打开翻译设置。`);
  }
  const numbered = texts.map((t, i) => `<${i + 1}>${t.trim()}`).join("\n");
  const url = `${profile.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${profile.apiKey}`,
    },
    body: JSON.stringify({
      model: profile.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: glossaryBlock
            ? `${batchSystemPrompt(config.targetLang)}

${glossaryBlock}`
            : batchSystemPrompt(config.targetLang),
        },
        { role: "user", content: numbered },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${profile.label} 请求失败（HTTP ${response.status}）${body ? `：${body.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("翻译服务返回内容为空或格式异常");
  }
  const results: (string | null)[] = new Array(texts.length).fill(null);
  const re = /<(\d+)>([\s\S]*?)(?=<\d+>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const idx = Number.parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < texts.length && results[idx] === null && m[2].trim()) {
      results[idx] = m[2].trim();
    }
  }
  return results;
}

/** 把段落索引切分成请求批次：限制段数与总字符数，避免单次请求过大 */
export function chunkIndices(lengths: number[], maxBlocks = 8, maxChars = 1800): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let chars = 0;
  lengths.forEach((len, idx) => {
    if (cur.length >= maxBlocks || (cur.length > 0 && chars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(idx);
    chars += len;
  });
  if (cur.length > 0) batches.push(cur);
  return batches;
}

/** 简单并发池：按顺序消费任务，最多 limit 路同时执行 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  isCancelled?: () => boolean,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (isCancelled?.()) return;
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
