#!/usr/bin/env node
/**
 * 打一个 Windows 绿色版（免安装）分发包。
 *
 * 绿色版的关键在于引擎：Tauri 的 exe 只带前端，Python 引擎是独立进程。
 * 所以这里把引擎源码、llama.cpp 运行时、OCR 模型，以及**一份嵌入式 Python + 依赖**
 * 一起打进包内，做到解压即用（不需要用户自己装 Python）。
 *
 * 用法：
 *   node scripts/make-portable.mjs            # 依赖已缓存时很快
 *   node scripts/make-portable.mjs --clean    # 重新下载/安装依赖
 *
 * 前置：先 `pnpm tauri build`（本脚本会用它的产物，不自己构建 Rust）
 * 产物：release/TransferReader-<version>-portable-win64.zip
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const PY_VER = "3.12.10";
const PY_TAG = "python312";
const BSDTAR = "C:/Windows/System32/tar.exe";
const releaseDir = join(root, "release");
const cacheDir = join(releaseDir, ".cache");
const stageDir = join(releaseDir, `TransferReader-${version}-portable-win64`);
const zipPath = join(releaseDir, `TransferReader-${version}-portable-win64.zip`);
const clean = process.argv.includes("--clean");

/**
 * 运行引擎所需的包。
 * 注意：不在 requirements 里的 requests 也要装（local_model 用它，以前靠 rapidocr 间接带入）；
 * rapidocr 代码里没用到，绿色版不装（省 ~40MB）。BabelDOC 属于可选高级管线，也不装，
 * 使用说明里给了按需安装的命令。
 */
const PY_DEPS = ["fastapi", "uvicorn", "pymupdf", "onnxruntime", "numpy", "opencv-python-headless", "requests"];

const log = (...a) => console.log("·", ...a);
const die = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
function du(p) {
  const st = statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    total += du(join(p, e.name));
  }
  return total;
}
const fmt = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) die(`${cmd} 执行失败（退出码 ${r.status}）`);
}

// ── 1. 前置检查 ────────────────────────────────────────────────
const exe = join(root, "src-tauri", "target", "release", "transfer-reader.exe");
if (!existsSync(exe)) die("没找到 transfer-reader.exe，请先跑 pnpm tauri build");
// 判据：生产版会把前端资源嵌进 exe，资产清单是明文（/index.html、/assets/…）；
// 用 cargo build --release 直接编出来的"开发版"没有内嵌资源，webview 会去连
// devUrl 的 localhost:1420，打出来的绿色版打开就是"连接被拒"。这里挡一道。
{
  const buf = readFileSync(exe);
  if (!buf.includes("/index.html") || !buf.includes("/assets/")) {
    die(
      "这个 exe 没有内嵌前端资源（像是开发模式构建），绿色版会打不开页面。" +
        "请先跑 pnpm tauri build（不要用 cargo build --release 代替）",
    );
  }
}

if (!existsSync(join(root, "engine", "main.py"))) die("没找到 engine/，请在项目根目录运行");
if (!existsSync(BSDTAR)) die(`没找到 bsdtar（${BSDTAR}），无法打包 zip`);

log(`开始打包绿色版 v${version}`);
if (clean) rmSync(cacheDir, { recursive: true, force: true });
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

// ── 2. 主程序 + 引擎源码（含自带运行时与 OCR 模型） ──────────────
log("拷贝主程序与引擎源码…");
cpSync(exe, join(stageDir, "transfer-reader.exe"));
const engineRoot = join(stageDir, "engine_root");
cpSync(join(root, "engine"), join(engineRoot, "engine"), {
  recursive: true,
  filter: (src) => {
    const rel = relative(join(root, "engine"), src);
    if (!rel) return true;
    // 本地数据（术语表）、字节码、虚拟环境不进包
    if (rel.startsWith("data")) return false;
    if (rel.includes("__pycache__")) return false;
    if (rel.endsWith(".pyc")) return false;
    if (rel.startsWith(".venv")) return false;
    return true;
  },
});
cpSync(join(root, "README.md"), join(stageDir, "README.md"));

// ── 3. 嵌入式 Python ──────────────────────────────────────────
const pyDir = join(engineRoot, "python");
const pyZip = join(cacheDir, `python-${PY_VER}-embed-amd64.zip`);
if (!existsSync(pyZip)) {
  log(`下载嵌入式 Python ${PY_VER}…`);
  run("curl", ["-sSL", "-o", pyZip, `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`]);
}
mkdirSync(pyDir, { recursive: true });
log("解压 Python…");
run(BSDTAR, ["-xf", pyZip, "-C", pyDir]);

// ._pth：让内嵌解释器找到站点包、以及 engine_root（cwd 之外再兜一层）
const pth = join(pyDir, `${PY_TAG}._pth`);
writeFileSync(
  pth,
  [
    `${PY_TAG}.zip`,
    ".",
    "Lib\\site-packages",
    "..", // engine_root：保证 `-m uvicorn engine.main:app` 能找到 engine 包
    "import site",
    "",
  ].join("\r\n"),
  "utf8",
);

// ── 4. 依赖（缓存复用，避免每次重新下载 300MB） ────────────────
const sitePackages = join(pyDir, "Lib", "site-packages");
const depsCache = join(cacheDir, "py-deps");
if (!existsSync(depsCache) || clean) {
  log("安装引擎依赖（首次约 300MB，之后走缓存）…");
  rmSync(depsCache, { recursive: true, force: true });
  mkdirSync(depsCache, { recursive: true });
  run(process.env.PYTHON ?? "python", ["-m", "pip", "install", "--quiet", "--target", depsCache, ...PY_DEPS]);
}
log("把依赖放进包内…");
cpSync(depsCache, sitePackages, { recursive: true });

// ── 5. 使用说明 ───────────────────────────────────────────────
writeFileSync(
  join(stageDir, "使用说明.txt"),
  `Transfer Reader ${version} · Windows 绿色版（免安装）
=========================================================

一、怎么用
  双击 transfer-reader.exe 即可。解压到任意目录都能跑，不写注册表、不需要管理员权限。
  建议整个文件夹一起拷走，别只拷 exe —— 引擎、运行时和 OCR 模型都在 engine_root 里。

二、目录里都是什么
  transfer-reader.exe              主程序（界面已内嵌，单文件即可启动）
  engine_root/engine/              Python 翻译 / OCR 引擎
  engine_root/engine/bin/          自带 llama.cpp 运行时（CPU 版）
  engine_root/engine/bin-vulkan/   自带 llama.cpp 运行时（Vulkan 版，有显卡自动优先用）
  engine_root/engine/models/       PP-OCR 模型（扫描件识别）
  engine_root/python/              嵌入式 Python + 引擎依赖 ← “绿色”就绿在这里，无需另装 Python

三、翻译怎么配
  1) 在线翻译：设置 → 翻译供应商 → 填自己的 API Key（DeepSeek / OpenAI / 智谱 / Moonshot…）
  2) 完全离线：
     设置 → 翻译供应商 → 本地模型（离线）→ 卡片里有模型下载入口
     下载 Hy-MT2-1.8B 的 .gguf（约 1.1GB）后选中它，点「启动模型」。
     有显卡会自动用 GPU，也可用「使用显卡」开关强制 CPU。
     模型文件不随本包分发，需要自行下载。

四、可选能力
  · 扫描件识别：已内置模型，开箱可用（翻译控制条上的「重识别」用自有 PP-OCR 校正文字）。
  · 整本翻译（BabelDOC 管线，关闭「保版式」时走这条）：包内未装，需要联网补装：
      engine_root\\python\\python.exe -m pip install babeldoc
    体积较大，按需安装；不装也能用「保版式」的整本翻译。

五、隐私与许可
  · 全程本地运行：API Key、术语表、阅读记录等都存在本机，引擎只监听 127.0.0.1。
  · 第三方组件与许可见 README.md 或应用内「设置 → 关于」；
    llama.cpp 运行时随包分发，遵循其 MIT 许可（engine/bin/LICENSE）。
`,
  "utf8",
);

// ── 6. 打包 zip ──────────────────────────────────────────────
log("压缩…");
rmSync(zipPath, { force: true });
run(BSDTAR, ["-a", "-cf", zipPath, "-C", releaseDir, `TransferReader-${version}-portable-win64`]);

// ── 7. 报告 ──────────────────────────────────────────────────
const folderBytes = du(stageDir);
console.log("");
log(`文件夹：${relative(root, stageDir)}  ${fmt(folderBytes)}`);
log(`压缩包：${relative(root, zipPath)}  ${fmt(du(zipPath))}`);
const sha = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
console.log(`  SHA-256 ${sha}`);
console.log("\n可以直接把这个 zip 发给别人，解压双击即可运行。");
