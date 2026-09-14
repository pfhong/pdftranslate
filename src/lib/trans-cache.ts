/**
 * 翻译结果缓存：同一段落重复翻译时直接复用，避免重复付费与等待。
 * 键包含供应商/模型/目标语言，按 LRU 上限淘汰，持久化到 localStorage。
 */

const STORAGE_KEY = "tr-trans-cache";
const MAX_ENTRIES = 800;

type CacheMap = Record<string, string>;

let mem: CacheMap | null = null;
let order: string[] = [];

function load(): CacheMap {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { entries?: CacheMap; order?: string[] }) : null;
    mem = parsed?.entries ?? {};
    order = parsed?.order ?? Object.keys(mem);
  } catch {
    mem = {};
    order = [];
  }
  return mem;
}

function persist(): void {
  if (!mem) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: mem, order }));
  } catch {
    // 存储超限：清掉一半再试一次
    order = order.slice(Math.floor(order.length / 2));
    const trimmed: CacheMap = {};
    for (const k of order) if (mem[k] !== undefined) trimmed[k] = mem[k];
    mem = trimmed;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: mem, order }));
    } catch {
      /* 放弃持久化，仅用内存缓存 */
    }
  }
}

/** 稳定的短哈希（FNV-1a），用于压缩缓存键长度 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(provider: string, model: string, targetLang: string, text: string): string {
  return `${provider}|${model}|${targetLang}|${text.length}|${hash(text)}`;
}

export function cacheGet(key: string): string | null {
  const m = load();
  const hit = m[key];
  if (hit === undefined) return null;
  // LRU：命中后置后
  order = order.filter((k) => k !== key);
  order.push(key);
  return hit;
}

export function cacheSet(key: string, value: string): void {
  const m = load();
  if (m[key] === undefined) {
    order.push(key);
    if (order.length > MAX_ENTRIES) {
      const drop = order.splice(0, order.length - MAX_ENTRIES);
      for (const k of drop) delete m[k];
    }
  }
  m[key] = value;
  persist();
}

export function cacheClear(): number {
  const size = Object.keys(load()).length;
  mem = {};
  order = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return size;
}

export function cacheSize(): number {
  return Object.keys(load()).length;
}
