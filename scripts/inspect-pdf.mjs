// 诊断脚本：用与阅读器相同的 pdf.js 解析指定 PDF，输出结构与告警
// 用法: node scripts/inspect-pdf.mjs <path>
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: node scripts/inspect-pdf.mjs <pdf-path>");
  process.exit(1);
}

const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map(String).join(" "));
  origWarn(...args);
};

const data = new Uint8Array(fs.readFileSync(path));
try {
  const doc = await getDocument({ data }).promise;
  console.log("=== loaded OK, numPages:", doc.numPages);
  const meta = await doc.getMetadata().catch((e) => ({ error: String(e) }));
  console.log("=== metadata:", JSON.stringify(meta.info?.Title ?? "", ), "encrypted:", !!meta.error || doc.isPureXfa ? "(check)" : "no");
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    console.log(
      `page ${i}: ${Math.round(vp.width)}x${Math.round(vp.height)} rotate=${page.rotate}`,
    );
    const tc = await page.getTextContent();
    console.log(`  textItems=${tc.items.length}`);
    try {
      const ol = await page.getOperatorList();
      let images = 0;
      for (const fn of ol.fnArray) {
        if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintImageMaskXObject) images++;
      }
      console.log(`  ops=${ol.fnArray.length} imageOps=${images}`);
    } catch (e) {
      console.log(`  getOperatorList FAILED: ${e.name}: ${e.message}`);
    }
  }
} catch (e) {
  console.log("=== getDocument FAILED:", e.name, e.message);
}
console.log("=== warnings captured:", warnings.length);
for (const w of warnings.slice(0, 15)) origWarn("  [warn]", w);
