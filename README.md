# Transfer Reader

简洁、美观、轻量的 PDF 阅读器，为后续「PDF 阅读 + 翻译」能力而生。

## 技术栈

- **Tauri 2**：Rust 桌面外壳，安装包仅 ~10MB，内存占用远低于 Electron
- **React 19 + TypeScript + Vite**：前端框架与构建工具
- **pdf.js（legacy 构建）**：PDF 解析与渲染；legacy 版内置 ES 新方法 polyfill，兼容 Tauri 的 WebView2 内核（modern 版依赖 `Map.getOrInsertComputed` 会导致桌面端渲染崩溃）
- **Tailwind CSS 4**：样式

## 功能（第一阶段：阅读器）

- 打开本地 PDF：文件选择 / 拖拽入窗口 / `Ctrl+O`
- 连续滚动阅读，页面按需渲染，大文件也能流畅打开
- 适应宽度缩放 + 分级缩放（`Ctrl+=` / `Ctrl+-` / `Ctrl+0`）
- 页码跳转、方向键 / PageUp / PageDown 翻页
- 亮色 / 暗色主题切换，默认跟随系统
- HiDPI 高分屏渲染适配

## 功能（第二阶段：翻译）

- **划词翻译**：页面文本可直接选中（含扫描件 OCR 文本层），选区旁弹出翻译按钮
- **双语对照视图**：左原文、右译文并排阅读，页码同步；译文按识别的段落
  原位替换（行级涂白 + 中文排印 + 两端对齐），公式与图表保持原样
- **整页/整本翻译**：移植 [PDFMathTranslate (pdf2zh)](https://github.com/Byaidu/PDFMathTranslate)
  的解析启发式——分栏检测（横向投影谷底探测）、页眉/页脚分离、OCR 重复文本去重、
  按基线聚类成行、按几何规则切分段落、公式与代码保护
  （LaTeX 字体正则 + Unicode 数学字符集 + 上下标字号比）
- **导出**：纯译文 PDF / 双语对照 PDF（原页与译页交错的单文件，pdf2zh dual 形态）
- **多翻译供应商**：默认 DeepSeek（deepseek-flash），内置 OpenAI / Moonshot / 智谱 / 硅基流动 /
  Ollama（本地）预设，支持添加任意 OpenAI 兼容供应商；本地模型走同一协议接入
- **Python 翻译引擎（推荐开启）**：`engine/` 目录的本地 FastAPI 服务（PyMuPDF + PP-OCRv6），
  提供 redaction 真删除原文、TextWriter 排印（字体共享子集化，单页合成 <1s、
  产物约 5MB）的高质量合成；
  启动：`python -m uvicorn engine.main:app --port 8765`（或 `engine/start.bat`），
  未启动时自动降级为内置 WASM 管线
- **BabelDOC 整本翻译（引擎在线时）**：接入 pdf2zh 官方后继 BabelDOC 的完整管线——
  DocLayout-YOLO 版面分析 + 字符级重排 + Noto 字体子集，「翻译整份文档」
  一键产出译文版（mono）与原/译交错对照版（dual）
- **离线模拟后端**：无需 API 即可验证完整翻译链路

## 开发

```bash
pnpm install
pnpm tauri dev
```

仅调试前端（浏览器模式）：

```bash
pnpm dev
```

## 打包

```bash
pnpm tauri build
```

产物位于 `src-tauri/target/release/bundle/`。

## 目录结构

```
├── src/                  # 前端源码
│   ├── components/       # Toolbar / PdfViewer / EmptyState / TranslatePanel / SettingsDialog
│   ├── lib/pdf.ts        # pdf.js（legacy 构建）配置与导出
│   ├── lib/layout.ts     # 版面识别：段落切分、公式保护、阅读顺序
│   ├── lib/translate.ts  # 翻译服务抽象与后端配置
│   ├── styles/           # 全局样式（Tailwind 入口）
│   └── App.tsx           # 应用状态与布局
├── src-tauri/            # Tauri/Rust 外壳
├── scripts/              # PDF 诊断工具（inspect-pdf.mjs）
└── public/               # 静态资源（logo 等）
```

## Roadmap

- [x] 阶段一：简洁美观的 PDF 阅读器
- [x] 阶段二：API 翻译接入（多供应商）+ 双语对照视图 + 导出
- [ ] 阶段三：本地模型接入、译文排版精修、扫描件多栏识别增强
