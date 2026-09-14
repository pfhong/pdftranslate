import { useEffect, useState } from "react";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { GlossaryEditor } from "./GlossaryEditor";
import { LocalModelCard } from "./LocalModelCard";
import type { GlossaryEntryDto } from "../lib/engine";
import {
  MOCK_PROVIDER_ID,
  providerLabel,
  translateText,
  type ProviderProfile,
  type TranslateConfig,
} from "../lib/translate";
import { targetLangOptions } from "../lib/translate";

type Props = {
  open: boolean;
  config: TranslateConfig;
  onSave: (config: TranslateConfig) => void;
  onClose: () => void;
  onExtractTerms?: () => Promise<GlossaryEntryDto[]>;
};

const fieldClass =
  "h-8 w-full rounded-md border border-neutral-200 bg-transparent px-2 text-xs outline-none transition-colors focus:border-blue-500 dark:border-neutral-700";

export function SettingsDialog({ open, config, onSave, onClose, onExtractTerms }: Props) {
  const [draft, setDraft] = useState<TranslateConfig>(config);
  const [editingId, setEditingId] = useState<string>(config.activeId);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [tab, setTab] = useState<"provider" | "glossary">("provider");
  const [switchHint, setSwitchHint] = useState<string | null>(null);

  /** 切换当前使用的供应商：立即保存生效（不必再点保存按钮） */
  const activateProvider = (id: string, label: string) => {
    const next = { ...draft, activeId: id };
    setDraft(next);
    onSave(next);
    setSwitchHint(`已切换到「${label}」（已保存）`);
    window.setTimeout(() => setSwitchHint(null), 2500);
  };

  useEffect(() => {
    if (open) {
      setDraft(config);
      setEditingId(config.activeId === "mock" ? config.profiles[0]?.id ?? "" : config.activeId);
      setTestResult(null);
    }
  }, [open, config]);

  if (!open) return null;

  const editing = draft.profiles.find((p) => p.id === editingId) ?? null;

  const updateProfile = (id: string, patch: Partial<ProviderProfile>) =>
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  const addCustom = () => {
    const id = `custom-${Date.now().toString(36)}`;
    setDraft((d) => ({
      ...d,
      profiles: [
        ...d.profiles,
        { id, label: `自定义 ${d.profiles.length}`, baseURL: "", apiKey: "", model: "" },
      ],
    }));
    setEditingId(id);
    setTestResult(null);
  };

  const removeProfile = (id: string) => {
    setDraft((d) => ({
      ...d,
      profiles: d.profiles.filter((p) => p.id !== id),
      activeId: d.activeId === id ? d.profiles.find((p) => p.id !== id)?.id ?? "mock" : d.activeId,
    }));
    setEditingId((cur) => (cur === id ? draft.profiles[0]?.id ?? "" : cur));
  };

  const runTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await translateText("Hello, world. This is a connection test.", {
        ...draft,
        activeId: editing.id,
      });
      setTestResult({ ok: true, message: result });
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message ?? String(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`flex h-[480px] max-w-[95vw] flex-col rounded-xl bg-white shadow-2xl dark:bg-neutral-900 ${
          tab === "glossary" ? "w-[760px]" : "w-[620px]"
        }`}
      >
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-neutral-200 px-3 dark:border-neutral-800">
          {(["provider", "glossary"] as const).map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`whitespace-nowrap rounded-md px-3 py-1 text-xs transition-colors ${
                tab === id
                  ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                  : "text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {id === "provider" ? "翻译供应商" : "术语表"}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1">
        {/* 左侧：供应商列表（仅供应商页显示；术语表页整宽编辑） */}
        <div className={`w-56 shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-800 ${tab === "provider" ? "flex" : "hidden"}`}>
          <div className={`min-h-0 flex-1 overflow-y-auto px-2 ${tab === "provider" ? "" : "hidden"}`}>
            <button
              type="button"
              onClick={() => activateProvider(MOCK_PROVIDER_ID, "模拟后端")}
              className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                draft.activeId === MOCK_PROVIDER_ID
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">模拟后端</div>
                <div className="truncate text-[10px] text-neutral-400">离线验证链路</div>
              </div>
              {draft.activeId === MOCK_PROVIDER_ID && <Check size={13} />}
            </button>
            {draft.profiles.map((p) => (
              <div
                key={p.id}
                className={`mb-1 flex items-center rounded-md px-2 py-1.5 transition-colors ${
                  draft.activeId === p.id
                    ? "bg-blue-50 dark:bg-blue-950/50"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                } ${editingId === p.id ? "ring-1 ring-blue-400" : ""}`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setEditingId(p.id);
                    setTestResult(null);
                  }}
                >
                  <div className="truncate text-xs font-medium text-neutral-700 dark:text-neutral-200">
                    {p.label}
                  </div>
                  <div className="truncate text-[10px] text-neutral-400">{p.model || "未配置模型"}</div>
                </button>
                <div className="flex items-center">
                  {draft.activeId === p.id ? (
                    <Check size={13} className="text-blue-600 dark:text-blue-400" />
                  ) : (
                    <button
                      type="button"
                      title="设为当前使用（立即生效并保存）"
                      onClick={() => activateProvider(p.id, p.label)}
                      className="rounded px-1 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700"
                    >
                      使用
                    </button>
                  )}
                  {!p.preset && (
                    <button
                      type="button"
                      title="删除"
                      onClick={() => removeProfile(p.id)}
                      className="rounded p-0.5 text-neutral-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className={`shrink-0 p-2 ${tab === "provider" ? "" : "hidden"}`}>
            <button
              type="button"
              onClick={addCustom}
              className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-neutral-300 text-xs text-neutral-500 transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-neutral-700"
            >
              <Plus size={13} />
              添加自定义供应商
            </button>
          </div>
        </div>

        {/* 右侧：编辑区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {tab === "glossary" ? (
            <GlossaryEditor onExtractTerms={onExtractTerms} />
          ) : (
          <>
          <div className="flex h-11 shrink-0 items-center px-4">
            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-100">
              {editing ? `编辑 · ${editing.label}` : "翻译设置"}
            </span>
            <div className="flex-1" />
            <span className="text-[10px] text-neutral-400">当前使用：{providerLabel(draft)}</span>
            {switchHint && (
              <span className="ml-2 rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700 dark:bg-green-950/40 dark:text-green-400">
                {switchHint}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-2 flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <X size={15} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {editing ? (
              <div className="flex flex-col gap-3">
                {editing.id === "local" && <LocalModelCard />}
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">名称</span>
                  <input
                    value={editing.label}
                    onChange={(e) => updateProfile(editing.id, { label: e.target.value })}
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    接口地址（OpenAI 兼容）
                  </span>
                  <input
                    value={editing.baseURL}
                    onChange={(e) => updateProfile(editing.id, { baseURL: e.target.value })}
                    placeholder="https://api.deepseek.com/v1"
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">API Key</span>
                  <input
                    type="password"
                    value={editing.apiKey}
                    onChange={(e) => updateProfile(editing.id, { apiKey: e.target.value })}
                    placeholder="sk-..."
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">模型</span>
                  <input
                    value={editing.model}
                    onChange={(e) => updateProfile(editing.id, { model: e.target.value })}
                    placeholder="deepseek-chat"
                    className={fieldClass}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    目标语言（内置为本地模型原生支持的语言，也可自行添加）
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={draft.targetLang}
                      onChange={(e) => setDraft((d) => ({ ...d, targetLang: e.target.value }))}
                      className={fieldClass}
                    >
                      {targetLangOptions(draft).map((l) => (
                        <option key={l} value={l}>
                          {l}
                          {(draft.customLangs ?? []).includes(l) ? "（自定义）" : ""}
                        </option>
                      ))}
                      {!targetLangOptions(draft).includes(draft.targetLang) && (
                        <option value={draft.targetLang}>{draft.targetLang}（当前）</option>
                      )}
                    </select>
                    <button
                      type="button"
                      title="添加语言"
                      onClick={() => {
                        const name = window.prompt("输入要添加的目标语言名称（如：泰语、瑞典语）");
                        const lang = (name ?? "").trim();
                        if (!lang) return;
                        setDraft((d) => ({
                          ...d,
                          customLangs: [...(d.customLangs ?? []), lang],
                          targetLang: lang,
                        }));
                      }}
                      className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      <Plus size={12} /> 添加
                    </button>
                    {(draft.customLangs ?? []).includes(draft.targetLang) && (
                      <button
                        type="button"
                        title="从自定义列表中移除当前选中的语言"
                        onClick={() =>
                          setDraft((d) => {
                            const customLangs = (d.customLangs ?? []).filter(
                              (l) => l !== d.targetLang,
                            );
                            return {
                              ...d,
                              customLangs,
                              targetLang: customLangs[customLangs.length - 1] ?? "简体中文",
                            };
                          })
                        }
                        className="flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-neutral-200 px-2 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        <X size={12} /> 移除
                      </button>
                    )}
                  </div>
                </label>

                {testResult && (
                  <p
                    className={`rounded-md p-2 text-xs leading-relaxed ${
                      testResult.ok
                        ? "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400"
                        : "bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400"
                    }`}
                  >
                    {testResult.ok ? `连接正常：${testResult.message}` : testResult.message}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void runTest()}
                    disabled={testing}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-neutral-200 px-3 text-xs text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    {testing && <Loader2 size={12} className="animate-spin" />}
                    测试连接
                  </button>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => {
                      onSave(draft);
                      onClose();
                    }}
                    className="h-8 shrink-0 whitespace-nowrap rounded-md bg-blue-600 px-4 text-xs font-medium text-white transition-colors hover:bg-blue-500"
                  >
                    保存当前供应商
                  </button>
                </div>

                <p className="text-[11px] leading-relaxed text-neutral-400">
                  左侧点「使用」即可切换当前供应商（<span className="text-neutral-500">立即生效并保存</span>）；
                  这里的字段修改需点「保存当前供应商」。
                  所有 OpenAI 兼容服务均可接入；本地模型（Ollama / vLLM / LM Studio）填本地地址即可。
                </p>
              </div>
            ) : (
              <p className="text-xs text-neutral-400">请选择或添加一个供应商。</p>
            )}
          </div>
          </>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
