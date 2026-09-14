/**
 * 自有 OCR：PP-OCR（PaddleOCR）系列 ONNX 模型 + onnxruntime-web，在 WebView 内推理。
 * 用途：内嵌文本层缺失或质量差的扫描页——渲染页面位图 → DBNet 检测行框 →
 * CTC 识别文本 → 生成与文本层同构的 SpanItem，喂给版面识别管线。
 *
 * 模型为 PP-OCR 官方转换（v4，中英文，来自 @gutenye/ocr-models），管线与模型版本
 * 解耦：后续 PP-OCRv5/v6 的 ONNX 文件可直接替换 public/models/ 下同名文件。
 * ORT 的 wasm 资源已本地化到 /ort/，离线可用。
 */
import Ocr from "@gutenye/ocr-browser";
import * as ort from "onnxruntime-web";
import type { PDFPageProxy } from "./pdf";
import type { SpanItem } from "./layout";

ort.env.wasm.wasmPaths = "/ort/";

type OcrLine = { text?: string; box?: number[][] };
type OcrInstance = { detect: (imageUrl: string) => Promise<OcrLine[]> };

let instancePromise: Promise<OcrInstance> | null = null;

async function getOcr(): Promise<OcrInstance> {
  if (!instancePromise) {
    instancePromise = (Ocr.create({
      models: {
        detectionPath: "/models/ch_PP-OCRv4_det_infer.onnx",
        recognitionPath: "/models/ch_PP-OCRv4_rec_infer.onnx",
        dictionaryPath: "/models/ppocr_keys_v1.txt",
      },
    }) as Promise<OcrInstance>).catch((err) => {
      instancePromise = null;
      throw err;
    });
  }
  return instancePromise;
}

/** 渲染页面位图并用 PP-OCR 识别，返回行级片段（页面坐标系，scale=1） */
export async function ocrPageItems(page: PDFPageProxy, scale = 2): Promise<SpanItem[]> {
  const ocr = await getOcr();
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  // 白底：透明底会干扰检测模型
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/png");

  const lines = (await ocr.detect(dataUrl)) as OcrLine[];

  // 检测模型输入是 960 上限、32 对齐的缩放帧，框坐标需要映射回位图尺寸
  const det = detFrameSize(canvas.width, canvas.height);
  const rx = canvas.width / det.width;
  const ry = canvas.height / det.height;

  const items: SpanItem[] = [];
  for (const line of lines) {
    const text = (line.text ?? "").trim();
    if (!text || !Array.isArray(line.box) || line.box.length < 3) continue;
    const xs = line.box.map((p) => p[0] * rx);
    const ys = line.box.map((p) => p[1] * ry);
    const x0 = Math.min(...xs) / scale;
    const x1 = Math.max(...xs) / scale;
    const top = Math.min(...ys) / scale;
    const bottom = Math.max(...ys) / scale;
    const h = bottom - top;
    if (h <= 2 || x1 <= x0) continue;
    items.push({
      str: text,
      x0,
      x1,
      baseline: bottom - h * 0.22,
      size: h * 0.78,
      fontName: "",
      formula: false,
    });
  }
  return items;
}

/** 复刻 @gutenye/ocr-common 的检测输入尺寸：960 长边上限 + 32 对齐 */
function detFrameSize(width: number, height: number, maxSize = 960) {
  let w = width;
  let h = height;
  if (Math.max(w, h) > maxSize) {
    const ratio = w > h ? maxSize / w : maxSize / h;
    w *= ratio;
    h *= ratio;
  }
  return {
    width: Math.max(Math.ceil(w / 32) * 32, 32),
    height: Math.max(Math.ceil(h / 32) * 32, 32),
  };
}
