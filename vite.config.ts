import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error type error without @types/node package
import process from "node:process";

const host = process.env.TAURI_DEV_HOST;

const ROOT = fileURLToPath(new URL(".", import.meta.url));

/** pdf.js 运行时需要的静态资源目录（位于 pdfjs-dist 包内） */
const PDFJS_ASSET_DIRS = ["wasm", "standard_fonts", "cmaps"];

/** ORT wasm 加载器（OCR 推理用），以固定路径伺服避免 Vite 对 public 模块的限制 */
const ORT_DIST = path.resolve(ROOT, "node_modules/onnxruntime-web/dist");
const ORT_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

/** 译制 PDF 使用的中文排印字体：优先项目 fonts/ 目录（可放开源字体），回退系统黑体 */
const FONT_SOURCES = [
  path.resolve(ROOT, "fonts", "zh.ttf"),
  "C:\\Windows\\Fonts\\simhei.ttf",
];

/**
 * 以固定路径提供 pdf.js 的运行时资源：
 * - /wasm/             JBIG2、JPEG2000 等图像解码器（扫描件必需）
 * - /standard_fonts/   未嵌入字体时的标准字体替换
 * - /cmaps/            CJK 等编码的 CMap
 * 开发环境走中间件，构建时拷贝进 dist。
 */
function pdfjsAssets(): Plugin {
  const mimeOf = (name: string): string => {
    if (name.endsWith(".wasm")) return "application/wasm";
    if (name.endsWith(".mjs") || name.endsWith(".js")) return "text/javascript";
    return "application/octet-stream";
  };
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      for (const dir of PDFJS_ASSET_DIRS) {
        server.middlewares.use(`/${dir}`, (req, res, next) => {
          const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
          // basename 防目录穿越，只允许直接命中包内文件
          const file = path.resolve(ROOT, "node_modules/pdfjs-dist", dir, path.basename(name));
          if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            next();
            return;
          }
          res.setHeader("Content-Type", mimeOf(name));
          fs.createReadStream(file).pipe(res);
        });
      }
      server.middlewares.use("/ort", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
        if (!ORT_FILES.includes(name)) {
          next();
          return;
        }
        res.setHeader("Content-Type", mimeOf(name));
        fs.createReadStream(path.resolve(ORT_DIST, name)).pipe(res);
      });
      server.middlewares.use("/fonts", (req, res, next) => {
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\//, "");
        const source = FONT_SOURCES.find((p) => {
          try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
          } catch {
            return false;
          }
        });
        if (name !== "zh.ttf" || !source) {
          next();
          return;
        }
        res.setHeader("Content-Type", "font/ttf");
        fs.createReadStream(source).pipe(res);
      });
    },
    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        fs.cpSync(
          path.resolve(ROOT, "node_modules/pdfjs-dist", dir),
          path.resolve(ROOT, "dist", dir),
          { recursive: true },
        );
      }
      // 中文字体随构建拷贝进产物，供译制 PDF 排印使用
      const fontSource = FONT_SOURCES.find((p) => {
        try {
          return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
      if (fontSource) {
        fs.mkdirSync(path.resolve(ROOT, "dist/fonts"), { recursive: true });
        fs.copyFileSync(fontSource, path.resolve(ROOT, "dist/fonts/zh.ttf"));
      }
      // ORT wasm 加载器拷进产物
      fs.mkdirSync(path.resolve(ROOT, "dist/ort"), { recursive: true });
      for (const f of ORT_FILES) {
        fs.copyFileSync(path.resolve(ORT_DIST, f), path.resolve(ROOT, "dist/ort", f));
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), pdfjsAssets()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
