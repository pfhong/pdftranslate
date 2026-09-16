/**
 * 统一的 PDF 打开入口。
 *
 * 桌面端（Tauri）走系统对话框拿真实路径，再用 fs 插件读字节——有路径才能写进
 * 「打开历史记录」，下次直接重开；浏览器里没有路径，降级为 <input type=file>。
 */

export type PickedFile = {
  /** 桌面端为绝对路径；浏览器里为 null（无法再次打开） */
  path: string | null;
  /** 含 .pdf 后缀的文件名 */
  name: string;
  bytes: Uint8Array;
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 去掉 .pdf 后缀，用于界面展示 */
export function displayName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "");
}

/** 从完整路径里取文件名（Windows / POSIX 分隔符都处理） */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function isPdfName(name: string): boolean {
  return /\.pdf$/i.test(name);
}

/**
 * 弹出选择框，返回选中的 PDF 字节。
 * 用户取消返回空数组；单个文件读取失败会被跳过并收集在 errors 里。
 */
export async function pickPdfFiles(): Promise<{
  files: PickedFile[];
  errors: string[];
}> {
  if (isTauri()) return pickViaTauri();
  return pickViaInput();
}

async function pickViaTauri(): Promise<{ files: PickedFile[]; errors: string[] }> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!picked) return { files: [], errors: [] };
  const paths = Array.isArray(picked) ? picked : [picked];
  const files: PickedFile[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      const file = await readPdfByPath(path);
      files.push(file);
    } catch (err) {
      errors.push(`无法读取 ${baseName(path)}：${(err as Error).message ?? String(err)}`);
    }
  }
  return { files, errors };
}

/** 按绝对路径读取 PDF（历史记录重开、拖拽后补读都用它） */
export async function readPdfByPath(path: string): Promise<PickedFile> {
  const { readFile } = await import("@tauri-apps/plugin-fs");
  const bytes = await readFile(path);
  return { path, name: baseName(path), bytes };
}

function pickViaInput(): Promise<{ files: PickedFile[]; errors: string[] }> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = true;
    input.style.display = "none";
    // 浏览器只在用户手势内才会真的弹框，所以 click 必须在任何 await 之前同步触发
    const cleanup = () => input.remove();
    input.addEventListener("change", () => {
      const list = Array.from(input.files ?? []);
      cleanup();
      void Promise.all(
        list.map(async (f): Promise<PickedFile | null> => {
          if (!isPdfName(f.name)) return null;
          const bytes = new Uint8Array(await f.arrayBuffer());
          return { path: null, name: f.name, bytes };
        }),
      ).then((all) => {
        const files = all.filter((f): f is PickedFile => f !== null);
        resolve({
          files,
          errors: files.length === list.length ? [] : ["已跳过非 PDF 文件"],
        });
      });
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 拖拽进来的 File 对象：能读字节，但没有路径 */
export async function pdfFromDroppedFile(file: File): Promise<PickedFile | null> {
  if (!isPdfName(file.name)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { path: null, name: file.name, bytes };
}
