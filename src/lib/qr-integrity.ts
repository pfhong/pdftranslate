/**
 * 关注二维码的完整性校验：素材与预先记录的指纹对不上就不展示（默认拒绝）。
 *
 * 指纹记在 src/qr-integrity.json，构建时由 scripts/verify-qr.mjs 再比对一遍。
 */
import { dbg } from "./debug-log";
import manifest from "../qr-integrity.json";

export type QrAssetMap = Record<string, string>;

export type QrVerifyResult = {
  ok: boolean;
  /** 通过校验的资源 */
  passed: string[];
  /** 指纹不符的资源 */
  mismatched: string[];
  /** 读取失败（网络/文件缺失）的资源 */
  failed: string[];
  /** 环境不支持校验（如没有 WebCrypto）：此时按"不通过"处理 */
  unsupported?: boolean;
};

const DEFAULT_ASSETS: QrAssetMap = manifest.assets;

async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 校验二维码素材；assets 可显式传入（便于测试或临时白名单）。
 * 任何一个资源读取失败或指纹不符都算不通过。
 */
export async function verifyQrAssets(assets: QrAssetMap = DEFAULT_ASSETS): Promise<QrVerifyResult> {
  const passed: string[] = [];
  const mismatched: string[] = [];
  const failed: string[] = [];

  for (const [url, expected] of Object.entries(assets)) {
    try {
      // no-store：避免拿到缓存的旧图而误判
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        failed.push(url);
        continue;
      }
      const bytes = await res.arrayBuffer();
      const actual = await sha256Hex(bytes);
      if (actual === null) {
        dbg("qr-integrity", "环境不支持 WebCrypto，无法校验二维码，按不通过处理", { url });
        return { ok: false, passed, mismatched, failed, unsupported: true };
      }
      if (actual === expected) passed.push(url);
      else {
        mismatched.push(url);
        dbg("qr-integrity", "二维码素材指纹不符，已拒绝展示", { url, expected, actual });
      }
    } catch (err) {
      failed.push(url);
      dbg("qr-integrity", "二维码素材读取失败", { url, error: (err as Error).message });
    }
  }

  const ok = Object.keys(assets).length > 0 && mismatched.length === 0 && failed.length === 0;
  if (!ok) dbg("qr-integrity", "二维码校验未通过", { passed, mismatched, failed });
  return { ok, passed, mismatched, failed };
}
