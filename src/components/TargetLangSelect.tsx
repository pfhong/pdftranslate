import { ChevronDown, Plus } from "lucide-react";

/** 主界面目标语言下拉所需的数据与回调（壳层 → 工作区 → 控制条逐层透传） */
export type TargetLangApi = {
  /** 当前供应商的目标语言 */
  value: string;
  /** 可选语言（内置 + 用户自定义） */
  options: string[];
  onChange: (lang: string) => void;
  /** 新增一个自定义语言并立即选中 */
  onAdd: (lang: string) => void;
};

/**
 * 目标语言下拉：改的是「当前供应商」自己的语言。
 * 语言属性属于供应商（本地模型与在线 API 支持的语言不同），所以放在供应商名旁边。
 */
export function TargetLangSelect({ value, options, onChange, onAdd }: TargetLangApi) {
  const list = options.includes(value) ? options : [...options, value];

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <span className="relative flex items-center">
        <select
          aria-label="目标语言"
          title="该供应商的翻译目标语言（每个供应商各自记住自己的语言）"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 cursor-pointer appearance-none rounded-md border border-neutral-200 bg-transparent py-0 pr-5 pl-2 text-[11px] text-neutral-700 outline-none transition-colors hover:bg-neutral-100 focus:border-blue-500 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
        >
          {list.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <ChevronDown
          size={11}
          className="pointer-events-none absolute right-1 text-neutral-400"
        />
      </span>
      <button
        type="button"
        title="添加目标语言"
        onClick={() => {
          const name = window.prompt("输入要添加的目标语言名称（如：泰语、瑞典语）");
          const lang = (name ?? "").trim();
          if (lang) onAdd(lang);
        }}
        className="flex h-6 w-5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        <Plus size={11} />
      </button>
    </span>
  );
}
