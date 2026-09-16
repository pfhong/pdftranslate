/**
 * 关注二维码的取源与信任判定。
 *
 * 两条路径：
 *  - 桌面端（Tauri）：由 Rust 侧提供 data URI（图片与校验信息都在二进制里）。
 *  - 浏览器调试：退回 public/ 下的静态图片 + JS 侧指纹校验（isTauri 不成立时）。
 *
 * 任一环节校验不过，trusted 为 false，调用方就不应展示二维码（宁可少一个关注）。
 */
import { isTauri } from "./open-pdf";
import { dbg } from "./debug-log";
import { PET_QR } from "./pet";
import { verifyQrAssets } from "./qr-integrity";

export type QrCard = {
  /** 素材文件名，用来和 PET_QR 的文案对应 */
  key: string;
  /** 可直接用于 img.src（data URI 或 URL） */
  src: string;
  ask: string[];
  sub: string;
};

export type QrSource = {
  cards: QrCard[];
  /** 是否通过指纹校验 */
  trusted: boolean;
  /** 二维码来自哪里：Rust 内置 / 浏览器静态资源 */
  via: "rust" | "js";
  message?: string;
};

function decorate(srcByKey: Map<string, string>): QrCard[] {
  return PET_QR.filter((q) => srcByKey.has(q.key)).map((q) => ({
    key: q.key,
    src: srcByKey.get(q.key) as string,
    ask: q.ask,
    sub: q.sub,
  }));
}

/** 桌面端：从 Rust 取（含 Rust 侧指纹校验） */
async function loadFromRust(): Promise<QrSource> {
  const { invoke } = await import("@tauri-apps/api/core");
  const assets = await invoke<{ key: string; mime: string; sha256: string; data_uri: string }[]>("qr_assets");
  const map = new Map(assets.map((a) => [a.key, a.data_uri]));
  const cards = decorate(map);
  const trusted = cards.length === PET_QR.length;
  if (!trusted) dbg("qr-source", "Rust 返回的二维码不完整", { got: cards.length, want: PET_QR.length });
  return {
    cards,
    trusted,
    via: "rust",
    message: trusted ? "二维码来自应用内置" : "内置二维码不完整，已停止展示",
  };
}

/** 浏览器调试：静态文件 + JS 侧校验 */
async function loadFromFiles(): Promise<QrSource> {
  const check = await verifyQrAssets();
  const map = new Map(PET_QR.map((q) => [q.key, `/about/${q.key}`]));
  return {
    cards: decorate(map),
    trusted: check.ok,
    via: "js",
    message: check.ok
      ? "二维码已就绪"
      : check.unsupported
        ? "当前环境无法校验二维码，已停止展示"
        : "⚠ 二维码未能通过内置校验，已停止展示（可能被替换）",
  };
}

let cached: Promise<QrSource> | null = null;

/** 取二维码（进程内缓存一次） */
export function qrSource(): Promise<QrSource> {
  if (cached) return cached;
  cached = (async () => {
    if (isTauri()) {
      try {
        return await loadFromRust();
      } catch (err) {
        // 命令不可用（老版本、bridge 出错）时退回静态资源路径：至少不比改造前更差
        dbg("qr-source", "从 Rust 取二维码失败，回退静态资源", { error: (err as Error).message });
      }
    }
    return loadFromFiles();
  })();
  return cached;
}
