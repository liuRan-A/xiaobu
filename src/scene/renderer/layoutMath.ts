/**
 * 小卜 · 布局与适配算术   src/scene/renderer/layoutMath.ts
 * ===========================================================================
 * ★ 这个文件的存在，是为了让"均分失效"这一类坑**不可能再发生**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 病因（在 Ardot 画布上实测过一次，见 skill: ardot-canvas-pitfalls §三）
 * ───────────────────────────────────────────────────────────────────────────
 * 一行里放 N 张卡、全部声明"占满剩余空间"时，排版引擎本来会均分。
 * 但只要中间插进来一个"按内容撑开"的元素（箭头、图标、定长文字），
 * 均分就会失效：前几张被压窄、最后一个吃掉多余宽度、整行还差一点没到右边界。
 *
 * 根因是"两种尺寸策略混排"：一个说"你看着分"，另一个说"我就要这么宽"。
 * 引擎不知道该听谁的，于是各让一步 —— 结果谁也说不准。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 本工程的硬规则（Canvas 与 DOM 一体适用）
 * ───────────────────────────────────────────────────────────────────────────
 *   一行的几何必须**先算后画**：先算容器内宽，再算每一段的确定像素宽，
 *   最后校验 Σ段宽 + Σ间距 恰好等于内宽。差 0.5px 也要在代码里看出来，
 *   而不是悄悄挤压。
 *
 *   · Canvas 侧：禁止在 draw 里用相对比例分配（如 `w * 0.32`）；
 *     一律走 distributeEvenly() 拿确定数值。
 *   · DOM 侧：横向 flex 行里，只要混了 `width:auto` 的元素，
 *     其余元素就必须给确定 `flex: 0 0 <px>`，不许写 `flex: 1`。
 *     （对照检查项已写进 ci/gates 与 README 的自检清单。）
 * ===========================================================================
 */

import { DESIGN_W, DESIGN_H } from './isometric'

/** 横向排布结果：每一段确定宽度 + 每段起点 x + 总占用宽度 */
export interface RowLayout {
  /** 每一段的宽度，长度 = count */
  widths: number[]
  /** 每一段的起点 x（相对于容器左内边），长度 = count */
  xs: number[]
  /** Σ段宽 + Σ间距 —— 调用方拿它跟内宽比对，应当完全相等 */
  used: number
  /** 内宽 − used。非 0 说明算式有问题，调用方应当警告（而不是硬画） */
  slack: number
}

/**
 * ★ 显式均分：把 `totalW` 分给 `count` 段，段间留 `gap`。
 *   余数用**前若干段各 +1px**吃掉（而不是全塞给最后一段），
 *   这样 3 张卡分 1000px 得到 [334, 333, 333] 而不是 [333, 333, 334] ——
 *   视觉上更接近"真的均分"，也避免了"最后一张总是偏胖"的观感。
 *
 * @param totalW 容器**内宽**（已扣掉 padding）
 * @param count  段数（≥ 1）
 * @param gap    段间距（count − 1 个）
 */
export function distributeEvenly(totalW: number, count: number, gap: number): RowLayout {
  if (!Number.isFinite(totalW) || count < 1) {
    return { widths: [], xs: [], used: 0, slack: totalW || 0 }
  }

  const inner = totalW - gap * (count - 1)
  // 内宽不够放：等分到 0 并如实报告 slack，由调用方决定降级（通常是不画）
  if (inner <= 0) {
    const widths = new Array<number>(count).fill(0)
    const xs = widths.map((_, i) => i * (0 + gap))
    return { widths, xs, used: gap * (count - 1), slack: totalW - gap * (count - 1) }
  }

  const base = Math.floor(inner / count)
  const rest = Math.round(inner - base * count) // 0 .. count−1
  const widths = Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0))

  const xs: number[] = []
  let cursor = 0
  for (const w of widths) {
    xs.push(cursor)
    cursor += w + gap
  }

  const used = widths.reduce((a, b) => a + b, 0) + gap * (count - 1)
  return { widths, xs, used, slack: totalW - used }
}

/**
 * 定宽列 + 剩余区：左侧 label 固定宽，右侧剩下的均分给 count 段。
 * 用于"元素名 + 四态列"这一类矩阵（差异矩阵的屏幕版就是这个形状）。
 */
export function labelPlusEven(
  totalW: number,
  labelW: number,
  count: number,
  gap: number,
): { labelW: number; columns: RowLayout } {
  const inner = totalW - labelW - gap
  return { labelW, columns: distributeEvenly(inner, count, gap) }
}

/**
 * 校验式：把"应当成立"写成断言，让算式错误在开发期就炸出来。
 * ★ 生产环境不抛异常、不弹 UI（门禁 ⑨），只返回 false 让调用方降级 —— 
 *   布局差了 0.5px 不是用户需要知道的事。
 */
export function layoutIsExact(l: RowLayout, tolerance = 0.01): boolean {
  return Math.abs(l.slack) <= tolerance
}

// ───────────────────────────────────────────────────────────────────────────
// 画布适配（等比铺满 + 居中留边）
// ───────────────────────────────────────────────────────────────────────────

export interface FitBox {
  /** 等比缩放系数：设计坐标 → CSS 像素 */
  scale: number
  /** 设计坐标系原点在 CSS 像素里的偏移 */
  offX: number
  offY: number
  /** 画布 CSS 尺寸 */
  cssW: number
  cssH: number
  /** 画布物理像素尺寸（已乘 DPR） */
  bufW: number
  bufH: number
  dpr: number
}

/**
 * 计算画布的适配盒。
 * ★ 等比 + 居中留边，而不是拉伸 —— 拉伸会让等距菱形变形，2:1 直接不成立，
 *   整个"微缩模型"的透视就崩了。留边部分由奶油底色填满（视觉上仍是"小屋"）。
 * ★ DPR 上限 2：高分屏再往上堆只会烧内存与填充率，对观感几乎无增益。
 */
export function computeFit(
  cssW: number,
  cssH: number,
  devicePixelRatio: number,
  dprCap = 2,
): FitBox {
  const w = cssW > 0 ? cssW : DESIGN_W
  const h = cssH > 0 ? cssH : DESIGN_H
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), dprCap)
  const scale = Math.min(w / DESIGN_W, h / DESIGN_H)

  return {
    scale,
    offX: (w - DESIGN_W * scale) / 2,
    offY: (h - DESIGN_H * scale) / 2,
    cssW: w,
    cssH: h,
    bufW: Math.max(1, Math.floor(w * dpr)),
    bufH: Math.max(1, Math.floor(h * dpr)),
    dpr,
  }
}

/** 屏幕（CSS）坐标 → 设计坐标。M2 的手势命中判定从这里进。 */
export function screenToDesign(px: number, py: number, fit: FitBox): { x: number; y: number } {
  if (fit.scale <= 0) return { x: 0, y: 0 }
  return { x: (px - fit.offX) / fit.scale, y: (py - fit.offY) / fit.scale }
}

/** 设计坐标 → 屏幕（CSS）坐标 */
export function designToScreen(x: number, y: number, fit: FitBox): { x: number; y: number } {
  return { x: x * fit.scale + fit.offX, y: y * fit.scale + fit.offY }
}
