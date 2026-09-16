import { isTauri } from "./open-pdf";

/**
 * 用系统默认方式打开外部链接。
 * 桌面端走 Tauri 的 opener 插件（capabilities 里 opener:default 已含 allow-open-url），
 * 浏览器调试时退化为新标签页打开。
 */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch (err) {
      console.warn("打开外部链接失败，退回浏览器方式", err);
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
