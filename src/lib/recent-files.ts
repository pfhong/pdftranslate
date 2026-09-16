/**
 * 打开历史记录：只用本地 localStorage 保存，条目极少（≤12），无需引擎参与。
 *
 * 只有带真实路径的打开（桌面端系统对话框）才记录——没有路径就没法再次打开，
 * 记下来只会变成一条点不动的死条目。
 */

const KEY = "tr-recent-files";
const MAX = 12;

export type RecentFile = {
  /** 绝对路径 */
  path: string;
  /** 展示用文件名（已去掉 .pdf） */
  name: string;
  /** 最近一次打开时间戳 */
  openedAt: number;
  /** 上次读到的页码，重开时回到这里 */
  page?: number;
};

/** Windows 路径大小写不敏感，去重时统一小写比较 */
function pathKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").toLowerCase();
}

function isRecentFile(v: unknown): v is RecentFile {
  const e = v as Partial<RecentFile> | null;
  return !!e && typeof e.path === "string" && e.path.length > 0 && typeof e.name === "string";
}

export function loadRecentFiles(): RecentFile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isRecentFile)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: RecentFile[]): RecentFile[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 存储不可用时静默降级为内存态 */
  }
  return list;
}

/** 记录一次打开：已存在则提到最前，超出上限的尾部丢弃 */
export function rememberRecentFile(entry: {
  path: string;
  name: string;
  page?: number;
}): RecentFile[] {
  const key = pathKey(entry.path);
  const list = loadRecentFiles();
  const prev = list.find((e) => pathKey(e.path) === key);
  const rest = list.filter((e) => pathKey(e.path) !== key);
  const next: RecentFile = {
    path: entry.path,
    name: entry.name,
    openedAt: Date.now(),
    page: entry.page ?? prev?.page,
  };
  return save([next, ...rest].slice(0, MAX));
}

/** 更新阅读进度（不改变排序；页码没变时返回 null，调用方据此避免无谓重渲染） */
export function updateRecentPage(path: string, page: number): RecentFile[] | null {
  const key = pathKey(path);
  const list = loadRecentFiles();
  let changed = false;
  const next = list.map((e) => {
    if (pathKey(e.path) !== key || e.page === page) return e;
    changed = true;
    return { ...e, page };
  });
  return changed ? save(next) : null;
}

export function forgetRecentFile(path: string): RecentFile[] {
  const key = pathKey(path);
  return save(loadRecentFiles().filter((e) => pathKey(e.path) !== key));
}

export function clearRecentFiles(): RecentFile[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
  return [];
}

/** 「刚刚 / 3 分钟前 / 昨天 09:12 / 9月12日」这类相对时间，用于历史列表 */
export function formatRelativeTime(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (ts >= startOfToday.getTime() - 86_400_000) return `昨天 ${hm}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日`;
}
