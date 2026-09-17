import { useEffect, useRef } from "react";
import {
  PET_BASE,
  PET_FREQ_RANGE,
  PET_QR_OPT_OUT,
  getPetConfig,
  subscribePetConfig,
  subscribePetSay,
  subscribePetTrigger,
  type PetConfig,
  type PetZone,
} from "../lib/pet";
import { qrSource, type QrSource } from "../lib/qr-source";
import { dbg } from "../lib/debug-log";
import {
  CLIPS,
  clipBox,
  filterFree,
  pickWeighted,
  type Box,
  type Plan,
  type Weighted,
} from "../lib/pet-layout";

/**
 * 鲸鱼桌宠（移植自个人站 xu.moan.ltd 的 whale-pet.js v2.2）。
 *
 * 相对原版做的调整，都是为了"不影响阅读 PDF"：
 * - 只锚定窗口边缘与界面控件上沿，**不锚定 PDF 页面**（锚定页面会盖住正文）
 * - 层级压在弹窗之下（z-40：高于工具栏与页面，低于设置弹窗的 z-50）
 * - 容器 pointer-events:none，只有本体可点，正文的滚动/划词完全不受影响
 * - 可配置：可展示区域、出场频率、空间不足时回避（见 lib/pet.ts）
 * - 气泡文案换成与阅读/翻译相关
 */

const QUOTES = [
  "代码改变生活。",
  "只做有趣的事。",
  "这本慢慢读。",
  "离线也能翻译哦。",
  "老许的碎碎念，碎碎平安。",
  "这页翻过去啦？",
  "别戳啦，痒！",
  "加油鲸！",
];

const CFG = {
  firstDelay: [8, 16] as [number, number],
  credgeMinViewport: 1360,
  fpsBottom: 20,
  fpsSink: 13,
  fpsSide: 13,
  fpsExpr: 13,
  sideHoldMs: 1600,
  bottomHoldMs: 500,
  /** 带关注码时停留久一点：够时间看清文案并扫码 */
  qrHoldMs: 8000,
  exprHoldMs: 600,
  minViewport: 700,
  zFloat: 40,
  /** 手动召唤时的层级：高于设置弹窗（z-50），让用户立刻看得到 */
  zManual: 60,
  zBehind: 1,
  /** 回避判定：与页面之间留出的最小间隙（px），免得"压着一条边"也算装得下 */
  gapPad: 8,
};

/** 顶缘锚点：只挑应用自己的控件（空状态卡片），绝不碰 PDF 页面 */
const TOP_SELS = '[data-pet="top"]';
const WAVE_AT = 46;

/** 视口内可见的 PDF 页面区域（"空间不足则回避"的输入，依赖 DOM 所以放在组件侧） */
function pageBoxes(): Box[] {
  const out: Box[] = [];
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const w = Math.min(window.innerWidth, r.right) - x;
    const h = Math.min(window.innerHeight, r.bottom) - y;
    if (w > 0 && h > 0) out.push({ x, y, w, h });
  });
  return out;
}

const PET_CSS = `
.wp-stage{position:fixed;inset:0;pointer-events:none;}
.wp-pet{position:fixed;pointer-events:none;cursor:pointer;
  opacity:0;transition:opacity .3s ease;will-change:opacity;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;}
.wp-pet.on{opacity:1;pointer-events:auto;}
.wp-pet.at-bottom{left:50%;bottom:0;}
.wp-pet.at-vright{right:0;bottom:12vh;}
.wp-pet.at-vleft{left:0;bottom:12vh;}
.wp-pet.at-credgeright{left:calc(50% + 502px);bottom:18vh;}
.wp-pet.at-credgeleft{right:calc(50% + 502px);bottom:18vh;}
.wp-pet.flip .wp-img{transform:scaleX(-1);}
.wp-behind{position:relative;z-index:2 !important;}
.wp-img{display:block;height:auto;filter:drop-shadow(0 4px 14px rgba(30,40,60,.18));}
.wp-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;
  transform:translateX(-50%);opacity:0;transition:opacity .3s ease;
  background:#fff;color:#3f3f46;border:1px solid #e4e4e7;border-radius:10px;
  font-size:13px;line-height:1.6;letter-spacing:.5px;
  padding:6px 12px;white-space:nowrap;pointer-events:none;
  box-shadow:0 6px 18px rgba(46,42,36,.14);}
.dark .wp-bubble{background:#262626;color:#e5e5e5;border-color:#404040;}
.wp-bubble::after{content:"";position:absolute;top:100%;left:50%;margin-left:-6px;
  border:6px solid transparent;border-top-color:#fff;}
.dark .wp-bubble::after{border-top-color:#262626;}
.wp-bubble.on{opacity:1;}
.wp-bubble.qr{display:flex;flex-direction:column;align-items:center;gap:3px;
  padding:9px 12px;white-space:normal;width:208px;text-align:center;}
.wp-bubble-qr{width:118px;height:118px;border-radius:6px;object-fit:contain;}
.wp-bubble-ask,.wp-bubble-sub,.wp-bubble-opt{display:none;line-height:1.5;}
.wp-bubble.qr .wp-bubble-ask{display:block;font-size:12px;font-weight:500;color:#e11d48;}
.dark .wp-bubble.qr .wp-bubble-ask{color:#fb7185;}
.wp-bubble.qr .wp-bubble-sub{display:block;font-size:11px;}
.wp-bubble.qr .wp-bubble-opt{display:block;margin-top:3px;font-size:10px;opacity:.65;letter-spacing:0;}
.at-vright .wp-bubble,.at-credgeright .wp-bubble,.at-sideR .wp-bubble{bottom:auto;top:4px;
  left:auto;right:calc(100% + 10px);transform:none;}
.at-vright .wp-bubble::after,.at-credgeright .wp-bubble::after,.at-sideR .wp-bubble::after{top:18px;left:100%;
  margin:0;border-top-color:transparent;border-left-color:#fff;}
.dark .at-vright .wp-bubble::after,.dark .at-credgeright .wp-bubble::after,.dark .at-sideR .wp-bubble::after{
  border-left-color:#262626;}
.at-vleft .wp-bubble,.at-credgeleft .wp-bubble,.at-sideL .wp-bubble{bottom:auto;top:4px;
  left:calc(100% + 10px);right:auto;transform:none;}
.at-vleft .wp-bubble::after,.at-credgeleft .wp-bubble::after,.at-sideL .wp-bubble::after{top:18px;left:auto;right:100%;
  margin:0;border-top-color:transparent;border-right-color:#fff;}
.dark .at-vleft .wp-bubble::after,.dark .at-credgeleft .wp-bubble::after,.dark .at-sideL .wp-bubble::after{
  border-right-color:#262626;}
`;

function pad(i: number): string {
  return (i < 10 ? "00" : i < 100 ? "0" : "") + i;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function WhalePet() {
  const stageRef = useRef<HTMLDivElement>(null);
  const petRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleTextRef = useRef<HTMLSpanElement>(null);
  const bubbleQrRef = useRef<HTMLImageElement>(null);
  const bubbleAskRef = useRef<HTMLSpanElement>(null);
  const bubbleSubRef = useRef<HTMLSpanElement>(null);
  const bubbleOptRef = useRef<HTMLSpanElement>(null);
  const cfgRef = useRef<PetConfig>(getPetConfig());

  useEffect(() => subscribePetConfig((c) => (cfgRef.current = c)), []);

  useEffect(() => {
    // 系统偏好「减少动态效果」时不做逐帧动画，也不再自动出场；
    // 但手动召唤与翻译完成播报仍然可用（静态姿势），避免桌宠"一声不响地失效"。
    const reducedMotion = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const stage = stageRef.current;
    const pet = petRef.current;
    const img = imgRef.current;
    const bubble = bubbleRef.current;
    const bubbleText = bubbleTextRef.current;
    const bubbleQr = bubbleQrRef.current;
    const bubbleAsk = bubbleAskRef.current;
    const bubbleSub = bubbleSubRef.current;
    const bubbleOpt = bubbleOptRef.current;
    if (!stage || !pet || !img || !bubble || !bubbleText || !bubbleQr || !bubbleAsk || !bubbleSub || !bubbleOpt)
      return;

    dbg("pet", "mounted", {
      reducedMotion,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      hidden: document.hidden,
      enabled: cfgRef.current.enabled,
    });

    /**
     * 二维码取源：默认"未就绪"（不展示），加载并通过校验后才允许展示。
     * 桌面端由 Rust 提供内置图片并校验。
     */
    let qr: QrSource | null = null;
    void qrSource().then((s) => {
      qr = s;
    });

    let runId = 0;
    let lastClick = 0;
    let curPos = "at-bottom";
    let anchor: { el: HTMLElement; fx: number; dw: number } | null = null;
    let alive = true;
    let timer = 0;
    let warnedHidden = false;
    /**
     * 出场进行中的标记：不存布尔，存"忙到什么时刻"。
     * WebView2 在某些状态下会把页面计时器钳到分钟级，用 setTimeout 实现的
     * 看门狗会被一起冻住，布尔锁一旦挂起就永久锁死——之后自动+手动出场
     * 全部静默失效（"桌宠不能用"）。改成截止时间后，锁靠查时间自然过期，
     * 不依赖任何定时器。
     */
    let busyUntil = 0;
    const isBusy = () => Date.now() < busyUntil;

    const sleep = (ms: number, id: number) =>
      new Promise<boolean>((resolve) => {
        window.setTimeout(() => resolve(id === runId && alive), ms);
      });

    const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    /* 帧预热：不阻塞首屏（PDF 解析优先），分批延后加载 */
    const preload = () => {
      const names = Object.keys(CLIPS);
      let ni = 0;
      const step = () => {
        if (!alive || ni >= names.length) return;
        const clip = CLIPS[names[ni]];
        let i = 0;
        const next = () => {
          if (!alive || i >= clip.n) {
            ni += 1;
            window.setTimeout(step, 60);
            return;
          }
          const pre = new Image();
          pre.src = `${PET_BASE}${names[ni]}-${pad(i)}.webp`;
          i += 1;
          window.setTimeout(next, 8);
        };
        next();
      };
      step();
    };

    /* 顶缘锚定：锚点元素滚动时跟随 */
    const applyAnchor = () => {
      if (!anchor || !anchor.el.isConnected) return;
      const r = anchor.el.getBoundingClientRect();
      const { w: imgW, h: imgH } = clipBox(CLIPS.rise, anchor.dw);
      let x = r.left + r.width * anchor.fx - imgW / 2;
      x = Math.max(6, Math.min(x, window.innerWidth - imgW - 6));
      pet.style.left = `${Math.round(x)}px`;
      pet.style.top = `${Math.round(r.top + 56 - imgH)}px`;
      pet.style.right = "auto";
      pet.style.bottom = "auto";
      pet.style.marginLeft = "0";
    };

    const onScroll = () => {
      if (!anchor || !isBusy()) return;
      applyAnchor();
    };

    const setPosClass = (cls: string, flip = false) => {
      curPos = cls;
      pet.className = `wp-pet ${cls}${flip ? " flip" : ""}${pet.classList.contains("on") ? " on" : ""}`;
      pet.style.marginLeft = cls === "at-bottom" ? `${-(CLIPS.rise.dw / 2)}px` : "";
    };

    const clearInlinePos = () => {
      pet.style.left = pet.style.top = pet.style.right = pet.style.bottom = "";
    };

    const fpsOf = (name: string) =>
      name === "rise" ? CFG.fpsBottom : name === "sink" ? CFG.fpsSink : name === "expr" ? CFG.fpsExpr : CFG.fpsSide;

    /** 静态模式（减少动态效果）下各片段展示的姿势：rise 取完全升起的帧，其余取末帧 */
    const staticFrameOf = (name: string) => {
      const n = CLIPS[name].n;
      if (name === "rise") return Math.floor(n * 0.85);
      if (name === "sink" || name === "slout" || name === "slback") return n - 1;
      return 0;
    };

    /**
     * 播放一段逐帧动画。
     *
     * 关键点：按"真实经过时间"决定当前帧，而不是"每 tick 前进一帧"。
     * 窗口被遮挡/最小化时浏览器会把定时器节流到 ~1 秒，若按 tick 前进，
     * 一段 4 秒的动画会被拉成几分钟，期间 busy 一直不释放、桌宠也就卡住不动。
     * 改成按时间取帧后，被节流时表现为跳帧，总时长仍然是 4 秒左右。
     */
    const play = (name: string, id: number, onFrame?: (i: number) => void) =>
      new Promise<boolean>((resolve) => {
        const clip = CLIPS[name];
        img.style.width = `${clip.dw}px`;
        if (reducedMotion) {
          // 静态姿势替代逐帧动画；rise 仍要触发"到顶说话"的回调
          img.src = `${PET_BASE}${name}-${pad(staticFrameOf(name))}.webp`;
          if (name === "rise") onFrame?.(WAVE_AT);
          window.setTimeout(() => resolve(id === runId && alive), 600);
          return;
        }
        const per = 1000 / fpsOf(name);
        const t0 = performance.now();
        let shown = -1;
        const tick = () => {
          if (id !== runId || !alive) return resolve(false);
          const i = Math.min(clip.n - 1, Math.floor((performance.now() - t0) / per));
          if (i !== shown) {
            img.src = `${PET_BASE}${name}-${pad(i)}.webp`;
            // 跳过的帧也回调一遍，保证 WAVE_AT 这类"第几帧触发"的逻辑不会漏
            for (let k = shown + 1; k <= i; k++) onFrame?.(k);
            shown = i;
          }
          if (i >= clip.n - 1) return resolve(true);
          window.setTimeout(tick, per);
        };
        tick();
      });

    /** 本次出场是否带了关注码：带了就多停一会儿，让人有时间扫 */
    let qrShown = false;
    /** 待播报的消息（事件驱动，如"翻译完成"） */
    let pendingSay: string | null = null;

    const showBubble = (text: string) => {
      bubble.classList.remove("qr");
      bubbleQr.style.display = "none";
      bubbleText.textContent = text;
      bubble.classList.add("on");
      window.setTimeout(() => bubble.classList.remove("on"), 2600);
    };

    /** 带关注二维码的气泡：卖萌求关注 + 说明怎么关掉 */
    const showQrBubble = () => {
      const pool = qr?.cards ?? [];
      if (pool.length === 0) return;
      const card = pool[Math.floor(Math.random() * pool.length)];
      qrShown = true;
      bubble.classList.add("qr");
      bubbleQr.src = card.src;
      bubbleQr.style.display = "block";
      bubbleText.textContent = "";
      bubbleAsk.textContent = pick(card.ask);
      bubbleSub.textContent = card.sub;
      bubbleOpt.textContent = PET_QR_OPT_OUT;
      bubble.classList.add("on");
    };

    const hideBubble = () => bubble.classList.remove("on");

    /**
     * 出场时"说不说话"的决策，三段流程共用：
     * 有待播报的消息（翻译完成等）优先；否则按开关随机说话或亮关注码。
     */
    const maybeSpeak = () => {
      if (pendingSay) {
        const msg = pendingSay;
        pendingSay = null;
        showBubble(msg);
        return;
      }
      const cfg = cfgRef.current;
      // 只有校验通过的素材才展示（见 lib/qr-source.ts）
      if (cfg.recommend && qr?.trusted && (qr.cards?.length ?? 0) > 0 && Math.random() < 0.25) {
        showQrBubble();
        return;
      }
      if (cfg.talk && Math.random() < 0.55) showBubble(pick(QUOTES));
    };

    /* ---------- 候选出场方案 ---------- */

    /** 顶缘锚点候选（要求上方装得下整条素材，否则会顶出屏幕只剩半张脸） */
    const elementPlans = (): Plan[] => {
      const vh = window.innerHeight;
      const out: Plan[] = [];
      document.querySelectorAll<HTMLElement>(TOP_SELS).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 240 || r.height < 60) return;
        if (r.top > vh * 0.85 || r.bottom < 80) return;
        const dw = Math.max(220, Math.min(300, r.width * 0.42));
        if (r.top + 56 - clipBox(CLIPS.rise, dw).h < 0) return;
        out.push({ kind: "element", el, dw, fx: rand(0.15, 0.85) });
      });
      return out;
    };

    const sidePlans = (): Plan[] => {
      const room = window.innerWidth >= CFG.credgeMinViewport;
      return [
        { kind: "side", cls: room ? "at-credgeleft" : "at-vleft", flip: true, dw: CLIPS.slout.dw },
        { kind: "side", cls: room ? "at-credgeright" : "at-vright", flip: false, dw: CLIPS.slout.dw },
      ];
    };

    const buildPlans = (zones: PetZone[], force: boolean): Weighted[] => {
      if (force) return [{ plan: { kind: "bottom", dw: CLIPS.rise.dw }, weight: 1 }];
      const out: Weighted[] = [];
      if (zones.includes("element")) for (const p of elementPlans()) out.push({ plan: p, weight: 3 });
      if (zones.includes("bottom")) out.push({ plan: { kind: "bottom", dw: CLIPS.rise.dw }, weight: 2 });
      if (zones.includes("side")) for (const p of sidePlans()) out.push({ plan: p, weight: 1 });
      return out;
    };

    /* ---------- 出场流程 ---------- */

    const hide = () => {
      runId += 1;
      busyUntil = 0;
      stage.style.zIndex = String(CFG.zFloat);
      anchor?.el.classList.remove("wp-behind");
      anchor = null;
      hideBubble();
      pet.classList.remove("on");
      window.setTimeout(() => {
        if (!isBusy()) clearInlinePos();
      }, 350);
    };

    const visitBottom = (id: number) => {
      anchor = null;
      setPosClass("at-bottom");
      img.style.width = `${CLIPS.rise.dw}px`;
      img.src = `${PET_BASE}rise-${pad(0)}.webp`;
      void pet.offsetWidth; // 强制重排，让 opacity 过渡生效
      pet.classList.add("on");
      return sleep(320, id).then((ok) => (ok ? play("rise", id, (i) => {
        if (i === WAVE_AT) maybeSpeak();
      }) : false))
        .then((ok) => (ok ? sleep(qrShown ? CFG.qrHoldMs : CFG.bottomHoldMs, id) : false))
        .then((ok) => {
          if (!ok) return false;
          hideBubble();
          return play("sink", id);
        });
    };

    const visitSide = (id: number, cls: string, flip: boolean) => {
      anchor = null;
      setPosClass(cls, flip);
      img.style.width = `${CLIPS.slout.dw}px`;
      img.src = `${PET_BASE}slout-${pad(0)}.webp`;
      void pet.offsetWidth;
      pet.classList.add("on");
      return sleep(320, id).then((ok) => (ok ? play("slout", id) : false))
        .then((ok) => {
          if (!ok) return false;
          maybeSpeak();
          return sleep(qrShown ? CFG.qrHoldMs : CFG.sideHoldMs, id);
        })
        .then((ok) => {
          if (!ok) return false;
          hideBubble();
          return play("slback", id);
        });
    };

    const visitElement = (id: number, plan: Extract<Plan, { kind: "element" }>) => {
      stage.style.zIndex = String(CFG.zBehind);
      plan.el.classList.add("wp-behind");
      anchor = { el: plan.el, fx: plan.fx, dw: plan.dw };
      setPosClass("at-bottom");
      img.style.width = `${plan.dw}px`;
      applyAnchor();
      pet.classList.add("on");
      return sleep(320, id)
        .then((ok) => (ok ? play("rise", id, (i) => { if (i === WAVE_AT) maybeSpeak(); }) : false))
        .then((ok) => (ok ? sleep(qrShown ? CFG.qrHoldMs : CFG.bottomHoldMs, id) : false))
        .then((ok) => {
          if (!ok) return false;
          hideBubble();
          return play("sink", id);
        });
    };

    const runPlan = (id: number, plan: Plan) => {
      if (plan.kind === "element") return visitElement(id, plan);
      if (plan.kind === "bottom") return visitBottom(id);
      return visitSide(id, plan.cls, plan.flip);
    };

    /** force = 手动召唤：忽略频率、区域与回避限制 */
    const show = (force = false) => {
      if (isBusy() || !alive) {
        dbg("pet", "show 跳过（正忙/未挂载）", { force, busy: isBusy(), alive });
        return;
      }
      if (!force && document.hidden) return;
      if (!force && reducedMotion) return; // 减少动态效果：不自动出场
      const cfg = cfgRef.current;
      let plans = buildPlans(cfg.zones, force);
      if (!force && cfg.avoidCrowded) {
        // 空间不足则回避：与可见页面重合的方案全部剔除（见 lib/pet-layout.ts）
        plans = filterFree(plans, pageBoxes(), CFG.gapPad, {
          w: window.innerWidth,
          h: window.innerHeight,
        });
      }
      if (plans.length === 0) {
        dbg("pet", "本轮无可用位置（回避可见页面）", { force, pages: pageBoxes().length });
        return; // 这一轮静默跳过
      }
      // 忙碌锁带 25 秒截止（最长正常出场 ≈17 秒 + 余量）：即使页面计时器被
      // 系统节流冻住整条流程，锁也会到点自动过期，绝不会永久卡死
      busyUntil = Date.now() + 25000;
      // 手动召唤多半是在设置面板里点的，而面板是 z-50：这一轮抬到面板之上，
      // 否则点了看不到它（出场结束 hide() 会把层级还原）
      if (force) stage.style.zIndex = String(CFG.zManual);
      qrShown = false;
      const id = ++runId;
      const chosen = pickWeighted(plans);
      const settle = (_ok: boolean, err?: unknown) => {
        if (id !== runId) return; // 已被新一轮接管，锁归新一轮负责
        if (err !== undefined) dbg("pet", "出场流程异常", { error: String(err) });
        busyUntil = 0;
        hide();
      };
      try {
        void Promise.resolve(runPlan(id, chosen)).then(
          (ok) => settle(ok),
          (err) => settle(false, err),
        );
      } catch (err) {
        settle(false, err);
      }
    };

    const onClick = () => {
      dbg("pet", "被点了一下", { curPos });
      const now = Date.now();
      if (now - lastClick < 1200) return;
      lastClick = now;
      const id = ++runId;
      busyUntil = Date.now() + 15000;
      if (curPos === "at-bottom") {
        showBubble(pick(QUOTES));
        pet.classList.add("on");
        void play("expr", id)
          .then((ok) => (ok ? sleep(CFG.exprHoldMs, id) : false))
          .then((ok) => {
            if (id !== runId) return;
            busyUntil = 0;
            if (ok) hide();
          });
        return;
      }
      // 侧缘/顶缘时被戳：害羞缩回去
      showBubble(pick(QUOTES));
      void sleep(500, id)
        .then((ok) => (ok ? play("slback", id) : false))
        .then((ok) => {
          if (id !== runId) return;
          busyUntil = 0;
          if (ok) hide();
        });
    };

    const schedule = (first: boolean) => {
      const cfg = cfgRef.current;
      const range =
        cfg.frequency === "manual"
          ? ([15, 15] as [number, number]) // 仅手动：留个心跳，用来感知配置变化
          : first
            ? CFG.firstDelay
            : PET_FREQ_RANGE[cfg.frequency];
      timer = window.setTimeout(() => {
        if (!alive) return;
        if (cfgRef.current.frequency !== "manual") {
          if (document.hidden) {
            // 页面隐藏时不出场；只在前两条里留痕，别刷爆环形缓冲
            if (!warnedHidden) {
              dbg("pet", "页面隐藏，自动出场暂停", { hidden: document.hidden });
              warnedHidden = true;
            }
          } else {
            warnedHidden = false;
            show();
          }
        }
        schedule(false);
      }, rand(range[0], range[1]) * 1000);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isBusy()) hide();
    };

    pet.addEventListener("click", onClick);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    stage.style.zIndex = String(CFG.zFloat);
    preload();
    schedule(true);

    let manual = 0;
    const unsubscribeTrigger = subscribePetTrigger(() => {
      window.clearTimeout(manual);
      manual = window.setTimeout(() => show(true), 0);
    });
    const unsubscribeSay = subscribePetSay((text) => {
      // 已经在场就直接说；否则叫出来说（事件播报与手动召唤一样，不受频率/回避限制）
      if (isBusy()) {
        showBubble(text);
        return;
      }
      pendingSay = text;
      window.clearTimeout(manual);
      manual = window.setTimeout(() => show(true), 0);
    });

    return () => {
      alive = false;
      runId += 1;
      window.clearTimeout(timer);
      window.clearTimeout(manual);
      unsubscribeTrigger();
      unsubscribeSay();
      pet.removeEventListener("click", onClick);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("keydown", onKey);
      anchor?.el.classList.remove("wp-behind");
    };
  }, []);

  // 窄屏直接不挂载：桌宠在窗口太小时只会碍事
  if (typeof window !== "undefined" && window.innerWidth < CFG.minViewport) return null;

  return (
    <>
      <style>{PET_CSS}</style>
      <div ref={stageRef} className="wp-stage" aria-hidden="true">
        <div ref={petRef} className="wp-pet at-bottom">
          <img ref={imgRef} className="wp-img" alt="" draggable={false} />
          <div ref={bubbleRef} className="wp-bubble">
            <img ref={bubbleQrRef} className="wp-bubble-qr" alt="" style={{ display: "none" }} draggable={false} />
            <span ref={bubbleTextRef} />
            <span ref={bubbleAskRef} className="wp-bubble-ask" />
            <span ref={bubbleSubRef} className="wp-bubble-sub" />
            <span ref={bubbleOptRef} className="wp-bubble-opt" />
          </div>
        </div>
      </div>
    </>
  );
}
