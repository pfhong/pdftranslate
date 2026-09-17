/**
 * 鲸鱼桌宠的配置与状态。
 *
 * 桌宠是应用级装饰，挂载在壳层；设置页改配置要即时生效，
 * 所以用这个极小的订阅式 store（配置存在 localStorage，不往组件树里塞）。
 */

import { dbg } from "./debug-log";

const KEY = "tr-pet-whale";

/** 可展示区域：窗口底部升沉 / 窗口两侧滑动 / 界面控件上沿探头 */
export type PetZone = "bottom" | "side" | "element";

/** 出场频率（manual = 只在手动召唤时出现） */
export type PetFrequency = "quiet" | "normal" | "lively" | "manual";

export type PetConfig = {
  enabled: boolean;
  zones: PetZone[];
  frequency: PetFrequency;
  /** 空间不足时回避：窗口刚好只装得下 PDF 时不出场，免得压住正文 */
  avoidCrowded: boolean;
  /** 会说话：出场时的随机气泡，以及翻译完成后报一声 */
  talk: boolean;
  /** 偶尔把关注二维码带出来（抖音 / 公众号，随机一个） */
  recommend: boolean;
};

export const PET_ZONE_LABEL: Record<PetZone, string> = {
  bottom: "窗口底部",
  side: "窗口两侧",
  element: "界面控件上沿",
};

export const PET_FREQ_LABEL: Record<PetFrequency, string> = {
  quiet: "安静",
  normal: "适中",
  lively: "活跃",
  manual: "仅手动",
};

/** 各频率的随机间隔范围（秒）；manual 不参与定时 */
export const PET_FREQ_RANGE: Record<Exclude<PetFrequency, "manual">, [number, number]> = {
  quiet: [90, 200],
  normal: [45, 120],
  lively: [20, 55],
};

export const PET_FREQ_HINT: Record<PetFrequency, string> = {
  quiet: "约 1.5~3 分钟一次",
  normal: "约 45~120 秒一次",
  lively: "约 20~55 秒一次",
  manual: "不自动出现，只在「召唤一下」时出现",
};

export const DEFAULT_PET_CONFIG: PetConfig = {
  enabled: true,
  zones: ["bottom", "side", "element"],
  frequency: "normal",
  avoidCrowded: true,
  talk: true,
  recommend: true,
};

/** 关闭推荐关注气泡的说明（展示二维码时会一并告知关闭渠道） */
export const PET_QR_OPT_OUT = "不想看的话：设置 → 桌宠 → 关闭「偶尔展示推荐关注」";

/** 关注二维码：两张牌随机出一张；ask 是卖萌求关注的文案，每次随机挑一句。
 *  图片本身由 lib/qr-source.ts 提供（桌面端来自 Rust 内置）。 */
export const PET_QR = [
  {
    key: "douyin-qr.png",
    ask: ["可以关注我吗？我会努力更新的～", "顺手关注一下嘛，就当夸夸我 🥺", "关注我吧！我超好养的～"],
    sub: "抖音：小许先生。（或搜 32166587912）",
  },
  {
    key: "wechat-qr.jpg",
    ask: ["公众号也求个关注～", "关注一下公众号好不好嘛 🥺", "扫码关注我，我就不打扰你读书啦～"],
    sub: "微信公众号 · 扫码关注",
  },
];

/** 翻译完成时要说的话 */
const DONE_QUOTES = ["搞定啦！", "翻译好了～", "搞定啦，去「译文」看看？"];

/** 素材目录（public/pet-whale，随构建一起打包） */
export const PET_BASE = "/pet-whale/";

function sanitize(raw: unknown): PetConfig {
  const obj = (raw ?? {}) as Partial<PetConfig>;
  const zones = Array.isArray(obj.zones)
    ? obj.zones.filter((z): z is PetZone => z === "bottom" || z === "side" || z === "element")
    : DEFAULT_PET_CONFIG.zones;
  const frequency =
    obj.frequency === "quiet" || obj.frequency === "normal" || obj.frequency === "lively" || obj.frequency === "manual"
      ? obj.frequency
      : DEFAULT_PET_CONFIG.frequency;
  return {
    enabled: obj.enabled !== false,
    // 区域全不选等于永远不出现，视为配置无效，回退默认
    zones: zones.length > 0 ? zones : DEFAULT_PET_CONFIG.zones,
    frequency,
    avoidCrowded: obj.avoidCrowded !== false,
    talk: obj.talk !== false,
    recommend: obj.recommend !== false,
  };
}

function load(): PetConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PET_CONFIG, zones: [...DEFAULT_PET_CONFIG.zones] };
    // 旧版本只存了 "0"/"1"（开关），迁移一下
    if (raw === "0") return { ...DEFAULT_PET_CONFIG, enabled: false, zones: [...DEFAULT_PET_CONFIG.zones] };
    if (raw === "1") return { ...DEFAULT_PET_CONFIG, zones: [...DEFAULT_PET_CONFIG.zones] };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PET_CONFIG, zones: [...DEFAULT_PET_CONFIG.zones] };
  }
}

let config: PetConfig = load();
const configSubs = new Set<(c: PetConfig) => void>();
const triggerSubs = new Set<() => void>();

export function getPetConfig(): PetConfig {
  return config;
}

export function setPetConfig(patch: Partial<PetConfig>): void {
  config = sanitize({ ...config, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* 存储不可用时仅本次生效 */
  }
  for (const fn of configSubs) fn(config);
}

export function subscribePetConfig(fn: (c: PetConfig) => void): () => void {
  configSubs.add(fn);
  return () => configSubs.delete(fn);
}

/** 立刻让它出场一次（设置页的「召唤一下」） */
export function triggerPet(): void {
  // 排查"召唤没反应"：subscribers 为 0 说明桌宠组件没挂载
  // （总开关关闭，或窗口宽度不足 700px 时组件直接不渲染）
  dbg("pet", "召唤一下", { subscribers: triggerSubs.size, enabled: config.enabled });
  for (const fn of triggerSubs) fn();
}

export function subscribePetTrigger(fn: () => void): () => void {
  triggerSubs.add(fn);
  return () => triggerSubs.delete(fn);
}

// ── 让它"说句话"（应用事件用，比如翻译完成） ──────────────────

const saySubs = new Set<(text: string) => void>();

/** 让桌宠说一句话；「会说话」关掉时静默忽略 */
export function petSay(text: string): void {
  if (!config.talk || !config.enabled) return;
  const msg = text.trim();
  if (!msg) return;
  for (const fn of saySubs) fn(msg);
}

/** 翻译完成时报一声（文案从这里挑，调用方不用关心措辞） */
export function petAnnounceDone(): void {
  petSay(DONE_QUOTES[Math.floor(Math.random() * DONE_QUOTES.length)]);
}

export function subscribePetSay(fn: (text: string) => void): () => void {
  saySubs.add(fn);
  return () => saySubs.delete(fn);
}
