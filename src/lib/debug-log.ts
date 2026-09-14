/**
 * 调试日志：写入 localStorage 环形缓冲，并在控制台输出。
 * 用于桌面版排查"右键翻译未触发"类问题——日志可通过
 * localStorage.getItem("tr-debug-log") 读取。
 */
const KEY = "tr-debug-log";
const MAX = 200;

export function dbg(scope: string, message: string, extra?: unknown): void {
  const line = `${new Date().toISOString().slice(11, 23)} [${scope}] ${message}${
    extra !== undefined ? " | " + safeJson(extra) : ""
  }`;
  console.log("%c[dbg]", "color:#f59e0b", line);
  try {
    const raw = localStorage.getItem(KEY);
    const log: string[] = raw ? JSON.parse(raw) : [];
    log.push(line);
    localStorage.setItem(KEY, JSON.stringify(log.slice(-MAX)));
  } catch {
    /* 忽略存储错误 */
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function readDebugLog(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function clearDebugLog(): void {
  localStorage.removeItem(KEY);
}
