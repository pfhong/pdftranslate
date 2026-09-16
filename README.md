# Transfer Reader

简洁、美观、轻量的 PDF 阅读器，为后续「PDF 阅读 + 翻译」能力而生。

项目地址：<https://github.com/pfhong/pdftranslate>

## 技术栈

- **Tauri 2**：Rust 桌面外壳，安装包仅 ~10MB，内存占用远低于 Electron
- **React 19 + TypeScript + Vite**：前端框架与构建工具
- **pdf.js（legacy 构建）**：PDF 解析与渲染；legacy 版内置 ES 新方法 polyfill，兼容 Tauri 的 WebView2 内核（modern 版依赖 `Map.getOrInsertComputed` 会导致桌面端渲染崩溃）
- **Tailwind CSS 4**：样式

## 功能（第一阶段：阅读器）

- 打开本地 PDF：文件选择 / 拖拽入窗口 / `Ctrl+O`，支持一次选中多个文件
- **多文档页签**：同时打开多份 PDF，页签切换保留各自的译文、版面缓存与滚动位置
  （`Ctrl+W` 关闭、`Ctrl+Tab` 切换）；后台仍在跑的翻译任务只写回自己那份文档
- **打开历史记录**：记住打开过的文件（路径 + 上次读到第几页），空状态与工具栏
  都能直接重开；文件被移动或删除时给出可读提示，条目可单删或清空
- 连续滚动阅读，页面按需渲染，大文件也能流畅打开
- 适应宽度缩放 + 分级缩放（`Ctrl+=` / `Ctrl+-` / `Ctrl+0`）
- 页码跳转、方向键 / PageUp / PageDown 翻页
- 亮色 / 暗色主题切换，默认跟随系统
- **鲸鱼桌宠**：每隔一会儿从窗口边缘或空状态卡片上沿探头，点它会有反应；仅在窗口 ≥700px
  且未开启"减少动态效果"时出现。设置里有独立「桌宠」页：总开关、出场频率（安静/适中/活跃/仅手动）、
  可展示区域（窗口底部/两侧/控件上沿）、**空间不足时自动回避**（窗口刚好只装得下 PDF 时这一轮
  不出现，免得压住正文）、**随机说话**（出场气泡，翻译完成后还会报一声「搞定啦！」）、
  **偶尔展示推荐关注**（随机带出抖音/公众号二维码，停 8 秒方便扫码）
- **设置面板**（工具栏齿轮 / 空状态入口）：翻译供应商、术语表、关于。
  「关于」里写有本项目地址、开源致谢（含各自许可与出处链接）与作者联系方式
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
  Ollama（本地）预设，支持添加任意 OpenAI 兼容供应商；本地模型走同一协议接入。
  目标语言**挂在供应商上**（本地模型与在线 API 支持的语言不同），主界面翻译控制条上
  可直接下拉切换，不用进设置；每个供应商各自记住自己的语言
- **Python 翻译引擎（推荐开启）**：`engine/` 目录的本地 FastAPI 服务（PyMuPDF + PP-OCRv6），
  提供 redaction 真删除原文、TextWriter 排印（字体共享子集化，单页合成 <1s、
  产物约 5MB）的高质量合成；
  启动：`python -m uvicorn engine.main:app --port 8765`（或 `engine/start.bat`），
  未启动时自动降级为内置 WASM 管线
- **BabelDOC 整本翻译（引擎在线时）**：接入 pdf2zh 官方后继 BabelDOC 的完整管线——
  DocLayout-YOLO 版面分析 + 字符级重排 + Noto 字体子集，「翻译整份文档」
  一键产出译文版（mono）与原/译交错对照版（dual）
- **离线模拟后端**：无需 API 即可验证完整翻译链路

## 引擎生命周期

引擎（`engine/`，Python FastAPI）**不随应用常驻**，归属规则是「谁拉起谁负责」：

- **按需启动**：应用启动时不拉引擎；真正要用时（翻译 / 术语抽取 / 启动本地模型）前端调
  Rust 的 `ensure_engine`——没在跑才拉起并等它就绪，已经有引擎在跑就直接复用，
  不去动别人的进程（另一个应用实例、或开发者手动启动的那个）。
- **随应用退出**：应用拉起引擎时用 `TR_PARENT_PID` 告知自己的进程号，引擎侧
  （`engine/parent_watch.py`）起守护线程盯着父进程，父进程消失就自行退出，
  并顺手关掉它托管的 llama-server。所以即使应用被强杀（任务管理器结束进程）
  也不会留下孤儿引擎。手动 `engine/start.bat` 启动不带该变量，守望不启用。
- **新旧可见**：`/health` 同时返回进程内指纹与磁盘指纹，控制条上直接显示指纹；
  两者不一致说明这个常驻进程跑的是旧代码，指示灯会变琥珀色「引擎待重启」。
- **本地模型并发推理**：llama-server 以 `--parallel 4 -c 8192 -t 8` 启动，引擎把一页的
  段落并发喂进去（同时在飞不超过槽位数）。小模型推理是内存带宽受限的，实测同样 8 段
  从 20~28 秒降到 9~13 秒（约 2.3 倍）；单纯加线程反而更慢（-t 12 掉到 11 tok/s）。
- **推理后端自动切换（CPU / GPU）**：引擎启动前用 `--list-devices` 探测所选 llama-server
  能用的设备——带 CUDA/Vulkan 后端的构建会列出显卡，于是自动加 `-ngl 99` 把层卸载到显存；
  纯 CPU 构建则原样跑。实测同一台机器（RTX 2060 SUPER / Vulkan）8 段 2.2s，
  是 CPU 的 2.9 倍。显存不足导致启动失败时自动回退 CPU 并把原因写进状态。
  llama-server 由项目自带（`engine/bin` 与 `engine/bin-vulkan` 等后端变体），
  在自带运行时里优先挑能认出显卡的那个。卡片上显示实际设备与已卸载层数；
  「使用显卡」开关可直接切换 CPU/显卡——卸载层数是 llama-server 的启动参数，
  所以切换会重新加载模型（约 10~15 秒），不需要去点停止再启动。
  **使用者只需要选模型文件（.gguf）**——设置里那张卡片直接给了模型下载入口
  （ModelScope / HuggingFace 的 `tencent/Hy-MT2-1.8B-GGUF`，以及 Q4_K_M 直链约 1.1GB），
  本项目不分发模型文件

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

### 绿色版（免安装）

```bash
pnpm tauri build          # 先出生产版 exe（必须用 CLI；cargo build 编出来的是开发版）
node scripts/make-portable.mjs
```

产出 `release/TransferReader-<版本>-portable-win64.zip`（约 230MB）。包里除了 exe，还带：

- `engine_root/engine/` 引擎源码 + 自带 llama.cpp 运行时（CPU / Vulkan）+ PP-OCR 模型
- `engine_root/python/` **嵌入式 Python + 引擎依赖** —— 这就是"绿色"的部分：目标机器不需要装 Python

应用拉起引擎时会优先用包内的 `engine_root/python/python.exe`（没有才回退系统的 python / py）。
依赖只装引擎运行必需的（`fastapi/uvicorn/pymupdf/onnxruntime/numpy/opencv-python-headless/requests`）；
`rapidocr` 代码里没用到故未装，BabelDOC 属可选高级管线，使用说明里给了按需安装命令。

## 目录结构

```
├── src/                  # 前端源码
│   ├── components/       # Toolbar / TabStrip / PdfViewer / DocWorkspace / EmptyState / SettingsDialog
│   ├── lib/pdf.ts        # pdf.js（legacy 构建）配置与导出
│   ├── lib/open-pdf.ts   # 统一打开入口：桌面端系统对话框取路径，浏览器降级 input
│   ├── lib/recent-files.ts # 打开历史记录（localStorage，含阅读进度续读）
│   ├── lib/local-model.ts # 本地模型：路径配置 + 按需拉起（含后端判定）
│   ├── lib/layout.ts     # 版面识别：段落切分、公式保护、阅读顺序
│   ├── lib/translate.ts  # 翻译服务抽象与后端配置
│   ├── styles/           # 全局样式（Tailwind 入口）
│   ├── App.tsx           # 壳层：页签管理、打开/历史、跨文档共享偏好
│   └── components/DocWorkspace.tsx # 单文档工作区：阅读与翻译状态都在这里
├── engine/               # Python 本地引擎（FastAPI）
│   ├── bin/              # 自带 llama.cpp 运行时（CPU 版，MIT，见其中 README）
│   └── bin-vulkan/       # 自带 llama.cpp 运行时（Vulkan 版，有显卡时自动优先使用）
├── src-tauri/            # Tauri/Rust 外壳
├── scripts/              # PDF 诊断工具（inspect-pdf.mjs）
└── public/               # 静态资源（logo 等）
```

> 本地模型所需的 llama-server 由本项目自带（`engine/bin`、`engine/bin-vulkan`），
> 不依赖任何外部项目目录；模型文件（.gguf）较大，仍由使用者自行放置并在设置里选择。

## Roadmap

- [x] 阶段一：简洁美观的 PDF 阅读器
- [x] 阶段二：API 翻译接入（多供应商）+ 双语对照视图 + 导出
- [ ] 阶段三：本地模型接入、译文排版精修、扫描件多栏识别增强

## 开源致谢

本项目站在这些开源工作的肩上。许可与出处都可自行核对；应用内「设置 → 关于」里也有同一份清单。

| 项目 | 许可 | 在本项目中的角色 |
|---|---|---|
| [PDFMathTranslate (pdf2zh)](https://github.com/PDFMathTranslate/PDFMathTranslate) | AGPL-3.0 | 版面识别启发式移植自该项目：分栏检测、页眉/页脚分离、公式与代码保护、按基线聚行切段 |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC) | AGPL-3.0 | 「翻译整份文档」的完整管线：DocLayout-YOLO 版面分析 + 字符级重排 + 字体子集 |
| [PyMuPDF (fitz)](https://github.com/pymupdf/PyMuPDF) | AGPL-3.0 | 引擎侧文本提取、原文遮挡（redaction）、译制 PDF 合成 |
| [RapidOCR](https://github.com/RapidAI/RapidOCR) / PP-OCRv6 | Apache-2.0 | 扫描件文字与坐标识别（「重识别」与无文本层时使用） |
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | 前端 PDF 解析与渲染（legacy 构建） |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | 本地离线翻译的推理服务（自带 CPU / Vulkan 运行时，见 `engine/bin`） |
| [Tauri](https://github.com/tauri-apps/tauri) / [React](https://github.com/facebook/react) | MIT / Apache-2.0 | 桌面外壳与前端框架 |

需要注意：PDFMathTranslate、BabelDOC、PyMuPDF 采用 **AGPL-3.0**。个人自用无妨；若对外分发本应用，
移植与依赖所涉及的部分需一并遵守其许可条款（提供对应源码）。

翻译所用的模型（如 Hy-MT2）由使用者自行提供，按其自身许可使用；本项目不再分发模型文件。
