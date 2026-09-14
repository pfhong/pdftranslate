// 使用 legacy 构建：它内置了 getOrInsertComputed 等 ES 新提案方法的 polyfill。
// modern 构建假定内核原生支持这些方法，Chrome 等新内核正常，
// 但 WebView2（Tauri 桌面端）会因缺少该方法导致渲染崩溃。
import {
  GlobalWorkerOptions,
  getDocument,
  TextLayer,
} from "pdfjs-dist/legacy/build/pdf.mjs";
// 由 Vite 在构建时解析出 worker 脚本的资源地址
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * 加载 PDF 文档。
 * wasmUrl（JBIG2/JPEG2000 扫描件解码）、standardFontDataUrl（标准字体）、
 * cMapUrl（CJK 编码）由 vite.config.ts 的 pdfjsAssets 插件以固定路径提供。
 */
export function loadDocument(data: Uint8Array) {
  return getDocument({
    data,
    wasmUrl: "/wasm/",
    standardFontDataUrl: "/standard_fonts/",
    cMapUrl: "/cmaps/",
    cMapPacked: true,
  });
}

export { getDocument, TextLayer };
export type {
  PDFDocumentProxy,
  PDFPageProxy,
  PDFDocumentLoadingTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
