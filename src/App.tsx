import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { EmptyState } from "./components/EmptyState";
import { WhalePet } from "./components/WhalePet";
import { SettingsDialog } from "./components/SettingsDialog";
import { TabStrip, type TabItem } from "./components/TabStrip";
import {
  DocWorkspace,
  type ReaderPrefs,
  type RecentsApi,
  type WorkspaceSession,
} from "./components/DocWorkspace";
import { loadDocument, type PDFDocumentProxy } from "./lib/pdf";
import {
  engineEnsure,
  engineExtract,
  engineHealth,
  glossaryList,
  subscribeEngine,
  type EngineHealth,
} from "./lib/engine";
import {
  llmChat,
  activeTargetLang,
  loadTranslateConfig,
  parseTermCandidates,
  saveTranslateConfig,
  targetLangOptions,
  termExtractionPrompt,
  withCustomLang,
  withTargetLang,
  type TranslateConfig,
} from "./lib/translate";
import type { TargetLangApi } from "./components/TargetLangSelect";
import { ensureLocalModel, isLocalModelProvider } from "./lib/local-model";
import { getPetConfig, subscribePetConfig } from "./lib/pet";
import {
  displayName,
  pdfFromDroppedFile,
  pickPdfFiles,
  readPdfByPath,
  type PickedFile,
} from "./lib/open-pdf";
import {
  clearRecentFiles,
  forgetRecentFile,
  loadRecentFiles,
  rememberRecentFile,
  updateRecentPage,
  type RecentFile,
} from "./lib/recent-files";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const saved = localStorage.getItem("tr-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readPrefs(): ReaderPrefs {
  return {
    forceRebuild: false,
    anchorLayout: localStorage.getItem("tr-anchor-layout") !== "0",
    useGlossary: localStorage.getItem("tr-use-glossary") !== "0",
    readingFontSize: Number(localStorage.getItem("tr-read-font") ?? 16),
    readingOriginal: localStorage.getItem("tr-read-original") === "1",
  };
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Windows 路径大小写不敏感，判重用同一套规则 */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().replace(/[\\/]+$/, "").toLowerCase() === b.trim().replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 应用壳层：负责"有哪些文档打开着"、打开与关闭、打开历史记录，以及跨文档共享的偏好。
 * 每个文档的实际状态都在 DocWorkspace 里，切页签只是把它藏起来而不卸载。
 */
export default function App() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [prefs, setPrefs] = useState<ReaderPrefs>(readPrefs);
  const [translateConfig, setTranslateConfig] = useState<TranslateConfig>(loadTranslateConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [engine, setEngine] = useState<EngineHealth>({ online: false });
  const [fontMissing, setFontMissing] = useState(false);

  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState<Record<string, { running: boolean; translated: boolean }>>({});
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [petOn, setPetOn] = useState(() => getPetConfig().enabled);
  const [recents, setRecents] = useState<RecentFile[]>(loadRecentFiles);

  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  /** 术语抽取需要"当前文档"的字节，从激活会话取 */
  const activeBytesRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    activeBytesRef.current = sessions.find((s) => s.id === activeId)?.bytes ?? null;
  }, [sessions, activeId]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  // 桌宠开关在设置里改，这里订阅后即时生效
  useEffect(() => subscribePetConfig((c) => setPetOn(c.enabled)), []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("tr-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = activeSession ? `${activeSession.name} - Transfer Reader` : "Transfer Reader";
  }, [activeSession]);

  // 引擎由 Rust 侧在启动时拉起，就绪要几秒，所以启动后重试若干次
  // 引擎按需启动：启动时只探一次（可能是"另一个实例已经在跑"）。
  // 之后谁要用引擎，谁先 engineEnsure()，结果通过订阅广播回来刷新这里。
  useEffect(() => {
    const unsubscribe = subscribeEngine(setEngine);
    void engineHealth().then(setEngine);
    return unsubscribe;
  }, []);

  useEffect(() => {
    void import("./lib/render-pdf").then(({ loadFontBytes }) =>
      loadFontBytes().then((bytes) => setFontMissing(bytes === null)),
    );
  }, []);

  const updatePrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      if (patch.anchorLayout !== undefined) {
        localStorage.setItem("tr-anchor-layout", patch.anchorLayout ? "1" : "0");
      }
      if (patch.useGlossary !== undefined) {
        localStorage.setItem("tr-use-glossary", patch.useGlossary ? "1" : "0");
      }
      if (patch.readingFontSize !== undefined) {
        localStorage.setItem("tr-read-font", String(patch.readingFontSize));
      }
      if (patch.readingOriginal !== undefined) {
        localStorage.setItem("tr-read-original", patch.readingOriginal ? "1" : "0");
      }
      return next;
    });
  }, []);

  const saveTranslateSettings = useCallback((next: TranslateConfig) => {
    // 配置级 targetLang 只作"最近用的语言"镜像：保存时与当前供应商的语言对齐，
    // 这样任何旁路读到它的地方（日志、术语抽取）都不会和实际翻译用的语言不一致
    const normalized: TranslateConfig = { ...next, targetLang: activeTargetLang(next) };
    setTranslateConfig(normalized);
    saveTranslateConfig(normalized);
  }, []);

  const changeTargetLang = useCallback(
    (lang: string) => {
      setTranslateConfig((prev) => {
        const next = withTargetLang(prev, lang);
        saveTranslateConfig(next);
        return next;
      });
    },
    [],
  );

  const addTargetLang = useCallback(
    (lang: string) => {
      setTranslateConfig((prev) => {
        const next = withTargetLang(withCustomLang(prev, lang), lang);
        saveTranslateConfig(next);
        return next;
      });
    },
    [],
  );

  /** 打开一批已读入内存的 PDF，每个文件一个页签 */
  const openPicked = useCallback(
    async (
      picked: PickedFile[],
      opts?: { page?: number; remember?: boolean; errors?: string[] },
    ) => {
      if (picked.length === 0 && !opts?.errors?.length) return;
      setLoading(true);
      const errors = [...(opts?.errors ?? [])];
      try {
        for (let i = 0; i < picked.length; i++) {
          const file = picked[i];
          const resumePage = i === 0 ? (opts?.page ?? 1) : 1;
          // 同一路径已在页签里 → 直接切过去，不重复打开
          const opened = sessionsRef.current.find((s) => samePath(s.path, file.path));
          if (opened) {
            setActiveId(opened.id);
            continue;
          }
          try {
            // pdf.js 会 transfer 底层缓冲区，先留一份原始字节供译制 PDF 合成
            const kept = file.bytes.slice();
            const task = loadDocument(file.bytes);
            const doc: PDFDocumentProxy = await task.promise;
            const name = displayName(file.name);
            const session: WorkspaceSession = {
              id: newId(),
              name,
              path: file.path,
              bytes: kept,
              doc,
              task,
              initialPage: resumePage,
            };
            setSessions((prev) => [...prev, session]);
            setActiveId(session.id);
            if (file.path && opts?.remember !== false) {
              setRecents(rememberRecentFile({ path: file.path, name, page: resumePage }));
            }
          } catch (err) {
            console.error(err);
            errors.push(`无法打开 ${file.name}`);
          }
        }
      } finally {
        setLoading(false);
        // 打开成功就顺手清掉上一次的失败提示，失败的则合并展示
        setOpenError(errors.length > 0 ? errors.join("；") : null);
      }
    },
    [],
  );

  const openPicker = useCallback(async () => {
    try {
      const { files, errors } = await pickPdfFiles();
      await openPicked(files, { errors });
    } catch (err) {
      console.error(err);
      setOpenError(`打开失败：${(err as Error).message ?? String(err)}`);
    }
  }, [openPicked]);

  /** 从历史记录重开：文件可能已被移动或删除，这里要给出可读的提示 */
  const openRecent = useCallback(
    async (entry: RecentFile) => {
      setOpenError(null);
      const already = sessionsRef.current.find((s) => samePath(s.path, entry.path));
      if (already) {
        setActiveId(already.id);
        return;
      }
      setLoading(true);
      try {
        const file = await readPdfByPath(entry.path);
        await openPicked([file], { page: entry.page ?? 1 });
      } catch (err) {
        console.error(err);
        setOpenError(`无法打开 ${entry.name}，文件可能已被移动或删除：${(err as Error).message ?? String(err)}`);
      } finally {
        setLoading(false);
      }
    },
    [openPicked],
  );

  const closeSession = useCallback((id: string) => {
    const list = sessionsRef.current;
    const idx = list.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const target = list[idx];
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => {
      if (cur !== id) return cur;
      const neighbour = list[idx + 1] ?? list[idx - 1];
      return neighbour?.id ?? null;
    });
    setTabStatus((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // 等 React 卸载该工作区之后再释放 pdf.js 资源，避免销毁与渲染竞争
    window.setTimeout(() => void target.task.destroy(), 0);
  }, []);

  const cycleTab = useCallback((dir: 1 | -1) => {
    const list = sessionsRef.current;
    if (list.length < 2) return;
    const idx = list.findIndex((s) => s.id === activeId);
    const next = list[(idx + dir + list.length) % list.length];
    setActiveId(next.id);
  }, [activeId]);

  // 全局快捷键：打开、关闭页签、切换页签
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        void openPicker();
      } else if (key === "w") {
        if (!activeId) return;
        e.preventDefault();
        closeSession(activeId);
      } else if (e.key === "Tab") {
        if (sessionsRef.current.length < 2) return;
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeId, closeSession, cycleTab, openPicker]);

  const handleStatus = useCallback(
    (id: string, status: { running: boolean; translated: boolean }) => {
      setTabStatus((prev) => {
        const cur = prev[id];
        if (cur && cur.running === status.running && cur.translated === status.translated) {
          return prev;
        }
        return { ...prev, [id]: status };
      });
    },
    [],
  );

  // 阅读进度写回历史记录：滚动很频繁，所以攒一会儿再落盘
  const pageRef = useRef(new Map<string, number>());
  const progressTimerRef = useRef(0);
  const handlePage = useCallback((id: string, page: number) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session?.path) return;
    pageRef.current.set(session.path, page);
    window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      let latest: RecentFile[] | null = null;
      for (const [path, p] of pageRef.current) {
        latest = updateRecentPage(path, p) ?? latest;
      }
      pageRef.current.clear();
      if (latest) setRecents(latest);
    }, 1500);
  }, []);

  const tabs: TabItem[] = sessions.map((s) => ({
    id: s.id,
    name: s.name,
    running: tabStatus[s.id]?.running ?? false,
    translated: tabStatus[s.id]?.translated ?? false,
  }));

  const recentsApi: RecentsApi = {
    list: recents,
    onOpen: (entry) => void openRecent(entry),
    onForget: (path) => setRecents(forgetRecentFile(path)),
    onClear: () => setRecents(clearRecentFiles()),
  };

  const targetLangApi: TargetLangApi = {
    value: activeTargetLang(translateConfig),
    options: targetLangOptions(translateConfig),
    onChange: changeTargetLang,
    onAdd: addTargetLang,
  };

  /** 术语自动抽取：引擎提取文本 → 模型给出候选，仅供设置页审阅 */
  const extractTerms = useCallback(async (): Promise<{ source: string; target: string }[]> => {
    const bytes = activeBytesRef.current;
    if (!bytes) throw new Error("请先打开 PDF 文件。");
    const profile = translateConfig.profiles.find((p) => p.id === translateConfig.activeId);
    if (!profile || translateConfig.activeId === "mock") {
      throw new Error("术语抽取需要真实翻译供应商，请先在「翻译供应商」页配置。");
    }
    // 抽取靠引擎的版面识别，没起就先拉起（引擎不常驻）；
    // 供应商是本地模型时，模型本身也得在跑，否则一样的 409
    const engine = await engineEnsure();
    if (engine.online && isLocalModelProvider(profile.baseURL)) {
      const model = await ensureLocalModel();
      if (!model.ok) throw new Error(model.message ?? "本地模型未能启动。");
    }
    const extracted = await engineExtract(bytes);
    const text = extracted.pages
      .flatMap((p) => p.blocks.map((b) => b.text))
      .filter((t) => t.trim())
      .join("\n")
      .slice(0, 8000);
    if (!text.trim()) throw new Error("文档没有可抽取的文本（可能是纯图片扫描件）。");

    const raw = await llmChat(
      [
        { role: "system", content: "你是严谨的文档术语抽取器，只输出 JSON。" },
        { role: "user", content: termExtractionPrompt(text, activeTargetLang(translateConfig)) },
      ],
      translateConfig,
    );
    const candidates = parseTermCandidates(raw);

    // 去重：排除已在术语表中的源词，并按文档中出现的频次排序
    const existing = new Set((await glossaryList()).map((e) => e.source.trim().toLowerCase()));
    const seen = new Set<string>();
    return candidates
      .map((c) => {
        const key = c.source.trim().toLowerCase();
        const occurrences = text.toLowerCase().split(key).length - 1;
        return { ...c, key, occurrences };
      })
      .filter((c) => c.key && !existing.has(c.key) && !seen.has(c.key) && (seen.add(c.key), true))
      .sort((a, b) => b.occurrences - a.occurrences)
      .map(({ source, target }) => ({ source, target }));
  }, [translateConfig]);

  return (
    <div
      className="flex h-dvh flex-col bg-neutral-50 dark:bg-neutral-950"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length === 0) return;
        void (async () => {
          const picked: PickedFile[] = [];
          for (const f of files) {
            const one = await pdfFromDroppedFile(f);
            if (one) picked.push(one);
          }
          await openPicked(picked, {
            errors: picked.length === 0 ? ["请拖入 PDF 格式的文件"] : [],
          });
        })();
      }}
    >
      {sessions.length === 0 ? (
        <main className="min-h-0 flex-1">
          <EmptyState
            onOpenClick={() => void openPicker()}
            loading={loading}
            error={openError}
            recents={recents}
            onOpenRecent={(entry) => void openRecent(entry)}
            onForgetRecent={(path) => setRecents(forgetRecentFile(path))}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </main>
      ) : (
        <>
          <TabStrip
            tabs={tabs}
            activeId={activeId ?? ""}
            onSelect={setActiveId}
            onClose={closeSession}
            onOpenFiles={() => void openPicker()}
          />
          {/* 每个文档都保持挂载，只把非激活的藏起来：译文、版面缓存、滚动位置都留着 */}
          {sessions.map((s) => (
            <div
              key={s.id}
              className={s.id === activeId ? "flex min-h-0 flex-1 flex-col" : "hidden"}
            >
              <DocWorkspace
                session={s}
                active={s.id === activeId}
                prefs={prefs}
                onPrefsChange={updatePrefs}
                translateConfig={translateConfig}
                targetLang={targetLangApi}
                onOpenSettings={() => setSettingsOpen(true)}
                engine={engine}
                fontMissing={fontMissing}
                theme={theme}
                onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                onOpenFiles={() => void openPicker()}
                recents={recentsApi}
                onStatus={handleStatus}
                onPage={handlePage}
              />
            </div>
          ))}
        </>
      )}

      {loading && sessions.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-neutral-900/85 px-3 py-1.5 text-xs text-white shadow-lg">
            <Loader2 size={12} className="animate-spin" />
            正在打开…
          </span>
        </div>
      )}

      {openError && sessions.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/60 dark:text-red-400">
          <span className="min-w-0 flex-1 truncate">{openError}</span>
          <button
            type="button"
            onClick={() => setOpenError(null)}
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-red-100 dark:hover:bg-red-900/40"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        config={translateConfig}
        onSave={saveTranslateSettings}
        onExtractTerms={extractTerms}
        onClose={() => setSettingsOpen(false)}
      />

      {petOn && <WhalePet />}

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/10">
          <span className="rounded-lg bg-white/90 px-4 py-2 text-sm font-medium text-blue-600 shadow dark:bg-neutral-900/90 dark:text-blue-400">
            松开以打开 PDF 文件
          </span>
        </div>
      )}
    </div>
  );
}
