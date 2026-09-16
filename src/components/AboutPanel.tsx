import { useEffect, useState } from "react";
import { ExternalLink, Heart, Info } from "lucide-react";
import { openExternal } from "../lib/open-external";
import { qrSource, type QrCard, type QrSource } from "../lib/qr-source";

/** 版本号与 package.json / tauri.conf.json 保持一致 */
const VERSION = "0.1.0";

/** 本项目 */
const PROJECT_URL = "https://github.com/pfhong/pdftranslate";

/** 作者个人主页 */
const HOMEPAGE_URL = "https://xu.moan.ltd";

type Credit = {
  name: string;
  license: string;
  url: string;
  note: string;
};

/**
 * 开源致谢：这些都是本项目实际用到（或移植了实现思路）的项目，
 * 许可与地址均按各自仓库/安装包里的信息填写。
 */
const CREDITS: Credit[] = [
  {
    name: "PDFMathTranslate (pdf2zh)",
    license: "AGPL-3.0",
    url: "https://github.com/PDFMathTranslate/PDFMathTranslate",
    note: "版面识别启发式（分栏检测、页眉页脚分离、公式与代码保护、按基线聚行切段）移植自该项目",
  },
  {
    name: "BabelDOC",
    license: "AGPL-3.0",
    url: "https://github.com/funstory-ai/BabelDOC",
    note: "「翻译整份文档」的完整管线（DocLayout-YOLO 版面 + 字符级重排 + 字体子集）由它提供",
  },
  {
    name: "PyMuPDF (fitz)",
    license: "AGPL-3.0",
    url: "https://github.com/pymupdf/PyMuPDF",
    note: "引擎侧的文本提取、原文遮挡（redaction）与译制 PDF 合成",
  },
  {
    name: "RapidOCR / PP-OCRv6",
    license: "Apache-2.0",
    url: "https://github.com/RapidAI/RapidOCR",
    note: "扫描件文字与坐标识别（「重识别」与无文本层时使用）",
  },
  {
    name: "pdf.js",
    license: "Apache-2.0",
    url: "https://github.com/mozilla/pdf.js",
    note: "前端 PDF 解析与渲染",
  },
  {
    name: "llama.cpp",
    license: "MIT",
    url: "https://github.com/ggml-org/llama.cpp",
    note: "本地离线翻译的推理服务（自带 CPU / Vulkan 运行时，见 engine/bin）",
  },
  {
    name: "Tauri / React",
    license: "MIT / Apache-2.0",
    url: "https://github.com/tauri-apps/tauri",
    note: "桌面外壳与前端框架",
  },
];

function CreditRow({ item }: { item: Credit }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800/60">
      <button
        type="button"
        onClick={() => void openExternal(item.url)}
        className="flex items-center gap-1 text-left text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
      >
        {item.name}
        <ExternalLink size={10} className="shrink-0 opacity-60" />
      </button>
      <span className="text-[10px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        <span className="mr-1 rounded bg-neutral-100 px-1 py-px text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          {item.license}
        </span>
        {item.note}
      </span>
    </li>
  );
}

/** 设置里的「关于」：项目地址、开源致谢、关注作者 */
export function AboutPanel() {
  // 二维码统一走可信来源（桌面端来自 Rust 内置）
  const [qr, setQr] = useState<QrSource | null>(null);
  useEffect(() => {
    void qrSource().then(setQr);
  }, []);
  const card = (key: string): QrCard | undefined => qr?.cards.find((c) => c.key === key);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "thin" }}>
      {/* 项目 */}
      <div className="flex items-start gap-2">
        <Info size={14} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
            Transfer Reader <span className="text-xs font-normal text-neutral-400">v{VERSION}</span>
          </h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            简洁、美观、轻量的 PDF 阅读器 · 为翻译而生。本地引擎 + 多供应商翻译，可完全离线使用。
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5">
            <button
              type="button"
              onClick={() => void openExternal(PROJECT_URL)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              title="项目源码"
            >
              {PROJECT_URL.replace(/^https?:\/\//, "")}
              <ExternalLink size={10} className="opacity-60" />
            </button>
            <button
              type="button"
              onClick={() => void openExternal(HOMEPAGE_URL)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
              title="作者的个人主页"
            >
              {HOMEPAGE_URL.replace(/^https?:\/\//, "")}
              <ExternalLink size={10} className="opacity-60" />
            </button>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            欢迎提 issue 与 PR；使用中遇到问题，附上复现步骤会更快定位。
          </p>
        </div>
      </div>

      {/* 开源致谢 */}
      <h4 className="mt-4 mb-1 text-xs font-medium text-neutral-700 dark:text-neutral-200">
        开源致谢
      </h4>
      <p className="mb-1 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        本项目站在这些开源工作的肩上。下列组件按各自许可使用，许可与出处均可点开核对；
        其中 AGPL-3.0 的项目（PDFMathTranslate、BabelDOC、PyMuPDF）若再分发，请一并遵守其许可条款。
      </p>
      <ul className="-mx-2 flex flex-col">
        {CREDITS.map((item) => (
          <CreditRow key={item.name} item={item} />
        ))}
      </ul>
      <p className="mt-1 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        翻译所用的模型（如 Hy-MT2）由使用者自行提供，按其自身许可使用；本项目不再分发模型文件。
      </p>

      {/* 关注作者 */}
      <h4 className="mt-4 flex items-center gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-200">
        <Heart size={12} className="text-rose-500" />
        关注作者
      </h4>
      <p className="mt-0.5 mb-2 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        这个工具如果帮到了你，欢迎扫码关注一下，你的关注是这个项目继续做下去的动力。谢谢 🙏
      </p>
      <div className="flex flex-wrap items-start gap-5">
        <figure className="flex flex-col items-center gap-1">
          {card("douyin-qr.png") ? (
            <img
              src={card("douyin-qr.png")?.src}
              alt="抖音二维码：小许先生。"
              className="h-36 w-36 rounded-lg border border-neutral-200 dark:border-neutral-700"
              draggable={false}
            />
          ) : (
            <div className="flex h-36 w-36 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-[10px] text-neutral-400 dark:border-neutral-700">
              {qr ? "二维码未通过校验" : "二维码加载中…"}
            </div>
          )}
          <figcaption className="text-center text-[10px] leading-tight text-neutral-500 dark:text-neutral-400">
            抖音：<span className="font-medium text-neutral-700 dark:text-neutral-200">小许先生。</span>
            <br />
            抖音号 32166587912
          </figcaption>
        </figure>
        <figure className="flex flex-col items-center gap-1">
          {card("wechat-qr.jpg") ? (
            <img
              src={card("wechat-qr.jpg")?.src}
              alt="微信公众号二维码"
              className="h-36 w-36 rounded-lg border border-neutral-200 dark:border-neutral-700"
              draggable={false}
            />
          ) : (
            <div className="flex h-36 w-36 items-center justify-center rounded-lg border border-dashed border-neutral-300 text-[10px] text-neutral-400 dark:border-neutral-700">
              {qr ? "二维码未通过校验" : "二维码加载中…"}
            </div>
          )}
          <figcaption className="text-center text-[10px] leading-tight text-neutral-500 dark:text-neutral-400">
            微信公众号
            <br />
            <span className="text-neutral-400 dark:text-neutral-500">扫码关注</span>
          </figcaption>
        </figure>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        也可以在抖音 App 里搜索「小许先生。」或抖音号 32166587912 找到我。
      </p>
    </div>
  );
}
