/**
 * 桌宠的出场位置计算与"空间不足则回避"判定。
 *
 * 抽成纯函数（不碰 DOM，除了可注入的元素矩形读取），
 * 这样这条规则可以脱离浏览器节流等环境因素单独验证。
 * 组件 WhalePet.tsx 只负责按结果播放动画。
 */

/** 逐帧素材表：n=帧数，w/h=统一画布尺寸，dw=显示宽度(px) */
export type Clip = { n: number; w: number; h: number; dw: number };

export const CLIPS: Record<string, Clip> = {
  rise: { n: 88, w: 480, h: 371, dw: 300 },
  sink: { n: 57, w: 480, h: 356, dw: 300 },
  slout: { n: 36, w: 189, h: 340, dw: 168 },
  slback: { n: 36, w: 187, h: 340, dw: 168 },
  expr: { n: 36, w: 420, h: 363, dw: 270 },
};

export type Box = { x: number; y: number; w: number; h: number };
export type Viewport = { w: number; h: number };

export type Plan =
  /** 从界面控件上沿探头（要求控件上方装得下整条素材） */
  | { kind: "element"; el: HTMLElement; dw: number; fx: number }
  /** 从窗口下沿升起 */
  | { kind: "bottom"; dw: number }
  /** 从窗口左右两侧探身 */
  | { kind: "side"; cls: string; flip: boolean; dw: number };

export type Weighted = { plan: Plan; weight: number };

/** 素材显示框（等比缩放） */
export function clipBox(clip: Clip, dw: number): { w: number; h: number } {
  return { w: dw, h: dw * (clip.h / clip.w) };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export type RectOf = (el: HTMLElement) => Box;

const domRect: RectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** 方案落位后的宠物框（纯计算，不触碰 DOM 布局） */
export function planBox(plan: Plan, vp: Viewport, rectOf: RectOf = domRect): Box {
  if (plan.kind === "element") {
    const r = rectOf(plan.el);
    const { w, h } = clipBox(CLIPS.rise, plan.dw);
    const x = Math.max(6, Math.min(r.x + r.w * plan.fx - w / 2, vp.w - w - 6));
    // 底边压在控件上沿下方 56px（那部分被控件挡住，形成"探头"效果）
    return { x, y: r.y + 56 - h, w, h };
  }
  if (plan.kind === "bottom") {
    const { w, h } = clipBox(CLIPS.rise, plan.dw);
    return { x: vp.w / 2 - w / 2, y: vp.h - h, w, h };
  }
  const { w, h } = clipBox(CLIPS.slout, plan.dw);
  const y = plan.cls.startsWith("at-credge") ? vp.h * 0.82 - h : vp.h * 0.88 - h;
  const onLeft = plan.cls === "at-vleft" || plan.cls === "at-credgeleft";
  const x = onLeft
    ? plan.cls === "at-vleft"
      ? 0
      : vp.w / 2 - 502 - w
    : plan.cls === "at-vright"
      ? vp.w - w
      : vp.w / 2 + 502;
  return { x, y, w, h };
}

/**
 * 空间不足则回避：把"落位后会压到可见页面"的方案剔除。
 * 页面框会先外扩 gapPad，避免"紧贴一条边"也被算作装得下。
 * 无页面（空状态）时全部保留。
 */
export function filterFree(
  plans: Weighted[],
  pages: Box[],
  gapPad: number,
  vp: Viewport,
  rectOf: RectOf = domRect,
): Weighted[] {
  if (pages.length === 0) return plans;
  const padded = pages.map((b) => ({
    x: b.x - gapPad,
    y: b.y - gapPad,
    w: b.w + gapPad * 2,
    h: b.h + gapPad * 2,
  }));
  return plans.filter((p) => {
    const box = planBox(p.plan, vp, rectOf);
    return !padded.some((pg) => overlaps(box, pg));
  });
}

/** 按权重随机挑一个方案 */
export function pickWeighted(plans: Weighted[], rnd: number = Math.random()): Plan {
  const total = plans.reduce((s, p) => s + p.weight, 0);
  let roll = rnd * total;
  for (const p of plans) {
    roll -= p.weight;
    if (roll <= 0) return p.plan;
  }
  return plans[plans.length - 1].plan;
}
