import { useEffect, useState } from "react";
import { Eye, Sparkles } from "lucide-react";
import { qrSource, type QrSource } from "../lib/qr-source";
import {
  PET_FREQ_HINT,
  PET_FREQ_LABEL,
  PET_ZONE_LABEL,
  getPetConfig,
  setPetConfig,
  triggerPet,
  type PetFrequency,
  type PetZone,
} from "../lib/pet";

const ZONES: PetZone[] = ["bottom", "side", "element"];
const FREQS: PetFrequency[] = ["quiet", "normal", "lively", "manual"];

/**
 * 桌宠配置：总开关、出场频率、可展示区域、空间不足时回避。
 * 改完即时生效（配置通过 lib/pet.ts 的订阅广播给桌宠组件）。
 */
export function PetSettings() {
  const [cfg, setCfg] = useState(getPetConfig);
  const [qr, setQr] = useState<QrSource | null>(null);

  // 打开面板时取一次二维码来源与校验结论，让作者能立刻看出"为什么二维码不出现"
  useEffect(() => {
    void qrSource().then(setQr);
  }, []);

  const patch = (next: Partial<typeof cfg>) => {
    setPetConfig(next);
    setCfg(getPetConfig());
  };

  const toggleZone = (zone: PetZone) => {
    const has = cfg.zones.includes(zone);
    const zones = has ? cfg.zones.filter((z) => z !== zone) : [...cfg.zones, zone];
    patch({ zones });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4" style={{ scrollbarWidth: "thin" }}>
      <div className="flex items-start gap-2">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-sky-500" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-100">鲸鱼桌宠</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            从窗口边缘探头的小家伙，点它会有反应。只浮在上层、隐藏时完全不响应鼠标。
          </p>
        </div>
      </div>

      {/* 总开关 */}
      <label className="mt-3 flex cursor-pointer items-center gap-2 rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-200">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 accent-blue-600"
        />
        <span className="font-medium">显示桌宠</span>
        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
          关闭后彻底不出现（也不加载动画素材）
        </span>
      </label>

      <div className={cfg.enabled ? "" : "pointer-events-none opacity-40"}>
        {/* 出场频率 */}
        <h4 className="mt-4 mb-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200">出场频率</h4>
        <div className="flex flex-wrap gap-1.5">
          {FREQS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => patch({ frequency: f })}
              className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                cfg.frequency === f
                  ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                  : "border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              {PET_FREQ_LABEL[f]}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">{PET_FREQ_HINT[cfg.frequency]}</p>

        {/* 可展示区域 */}
        <h4 className="mt-4 mb-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200">可展示区域</h4>
        <div className="flex flex-col gap-1">
          {ZONES.map((z) => (
            <label
              key={z}
              className="flex cursor-pointer items-center gap-2 text-[11px] text-neutral-600 dark:text-neutral-300"
            >
              <input
                type="checkbox"
                checked={cfg.zones.includes(z)}
                onChange={() => toggleZone(z)}
                className="h-3 w-3 accent-blue-600"
              />
              {PET_ZONE_LABEL[z]}
              <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                {z === "bottom" ? "从窗口下沿升起再沉下" : z === "side" ? "从窗口左右两侧探身" : "从界面卡片上沿冒出（如空状态的「最近打开」）"}
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          至少选一个；都不选时视为恢复默认（三种全开）。
        </p>

        {/* 说话与推荐关注 */}
        <h4 className="mt-4 mb-1.5 text-xs font-medium text-neutral-700 dark:text-neutral-200">说话与推荐</h4>
        <label className="flex cursor-pointer items-start gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={cfg.talk}
            onChange={(e) => patch({ talk: e.target.checked })}
            className="mt-0.5 h-3 w-3 accent-blue-600"
          />
          <span>
            随机说话
            <span className="mt-0.5 block text-[10px] text-neutral-400 dark:text-neutral-500">
              出场时偶尔冒一句，翻译完成后也会报一声「搞定啦！」；关掉则全程安静
            </span>
          </span>
        </label>
        <label className="mt-1.5 flex cursor-pointer items-start gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={cfg.recommend}
            onChange={(e) => patch({ recommend: e.target.checked })}
            className="mt-0.5 h-3 w-3 accent-blue-600"
          />
          <span>
            偶尔展示推荐关注
            <span className="mt-0.5 block text-[10px] text-neutral-400 dark:text-neutral-500">
              随机把抖音或公众号二维码带出来（约四次出场一次），停留 8 秒方便扫码
            </span>
            {qr && (
              <span
                className={`mt-0.5 block text-[10px] ${
                  qr.trusted ? "text-neutral-400 dark:text-neutral-500" : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {qr.message}
              </span>
            )}
          </span>
        </label>

        {/* 空间不足时回避 */}
        <h4 className="mt-4 mb-1.5 flex items-center gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-200">
          <Eye size={12} className="text-neutral-400" />
          空间不足时自动回避
        </h4>
        <label className="flex cursor-pointer items-start gap-2 text-[11px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={cfg.avoidCrowded}
            onChange={(e) => patch({ avoidCrowded: e.target.checked })}
            className="mt-0.5 h-3 w-3 accent-blue-600"
          />
          <span>
            窗口刚好只装得下 PDF（页面两侧没有余量）时，这一轮直接不出场，免得压住正文
            <span className="mt-0.5 block text-[10px] text-neutral-400 dark:text-neutral-500">
              关闭后它可能在正文上方短暂出现几秒——所有出场位置都会与可见页面做重合判断，
              只有完全不压到页面才会出现。提示条与页面之间的空隙也会算进去。
            </span>
          </span>
        </label>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={triggerPet}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            召唤一下
          </button>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
            手动召唤不受频率、区域与回避限制
          </span>
        </div>
      </div>
    </div>
  );
}
