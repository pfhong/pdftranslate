#!/usr/bin/env node
/**
 * 关注二维码的构建期一致性校验。
 *
 * 同一张二维码在项目里有四处"身份"，任何一处对不上都可能是被换过或忘了同步：
 *   1. public/about/            浏览器调试用的静态副本（也是应用资源）
 *   2. src-tauri/assets/qr/     编译进 Rust 二进制的副本（桌面端实际使用的来源）
 *   3. src/qr-integrity.json    JS 侧运行时校验用的指纹
 *   4. src-tauri/src/lib.rs     二维码内嵌表里的指纹常量（Rust 侧校验的权威）
 *
 * 用法：
 *   node scripts/verify-qr.mjs            # 校验（build 前自动执行）
 *   node scripts/verify-qr.mjs --update   # 以 public/ 的图片为准，重算并写回 3 与 4
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "src", "qr-integrity.json");
const libRsPath = join(root, "src-tauri", "src", "lib.rs");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const assets = manifest.assets ?? {};
const update = process.argv.includes("--update");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const pubPath = (url) => join(root, "public", url.replace(/^\//, ""));
const rustPath = (url) => join(root, "src-tauri", "assets", "qr", url.replace(/^\/about\//, ""));

/** 从 lib.rs 的 QR_ASSETS 表里抽出 (文件名, 指纹) */
function rustConstants() {
  if (!existsSync(libRsPath)) return new Map();
  const src = readFileSync(libRsPath, "utf8");
  const table = src.slice(src.indexOf("const QR_ASSETS"), src.indexOf("fn sha256_hex"));
  const out = new Map();
  for (const m of table.matchAll(/"([^"]+\.(?:png|jpg))",\s*"[^"]+",\s*"([0-9a-f]{64})"/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

let bad = 0;
const nextAssets = {};
const rust = rustConstants();

for (const [url, expected] of Object.entries(assets)) {
  const key = url.replace(/^\/about\//, "");
  const problems = [];
  for (const [label, file] of [
    ["public 副本", pubPath(url)],
    ["Rust 内置副本", rustPath(url)],
  ]) {
    if (!existsSync(file)) {
      problems.push(`缺少${label}：${file.replace(root, ".")}`);
      continue;
    }
    const actual = sha256(readFileSync(file));
    if (label === "public 副本") nextAssets[url] = actual;
    if (actual !== expected) problems.push(`${label}指纹不符（实际 ${actual.slice(0, 16)}…）`);
  }
  const rustHash = rust.get(key);
  if (rust.size > 0 && !rustHash) problems.push("lib.rs 的内嵌表里没有它");
  else if (rustHash && rustHash !== expected) problems.push(`lib.rs 指纹常量不符（${rustHash.slice(0, 16)}…）`);

  if (problems.length === 0) {
    console.log(`✓ ${url}  ${expected.slice(0, 16)}…  （public / Rust 副本 / JS 指纹 / Rust 常量 一致）`);
    continue;
  }
  if (update) {
    // 以 public/ 的图片为准：重算指纹、覆盖 Rust 副本、改写 JS 与 Rust 常量
    const fresh = sha256(readFileSync(pubPath(url)));
    writeFileSync(rustPath(url), readFileSync(pubPath(url)));
    if (rustHash) {
      const src = readFileSync(libRsPath, "utf8").replace(rustHash, fresh);
      writeFileSync(libRsPath, src, "utf8");
    }
    nextAssets[url] = fresh;
    console.log(`↻ ${url}  已按 public 副本同步：${expected.slice(0, 16)}… → ${fresh.slice(0, 16)}…`);
    console.log("   注意：lib.rs 已改写，需要重新编译应用（pnpm tauri build）才会生效");
    continue;
  }
  console.error(`✗ ${url}`);
  for (const p of problems) console.error(`    ${p}`);
  bad += 1;
}

if (bad === 0 && update) {
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, assets: nextAssets }, null, 2)}\n`, "utf8");
  console.log("已写回 src/qr-integrity.json");
  process.exit(0);
}

if (bad > 0) {
  console.error(`\n二维码校验失败（${bad} 项）。确认无误后跑：node scripts/verify-qr.mjs --update`);
  process.exit(1);
}
console.log("\n二维码素材校验通过。");
