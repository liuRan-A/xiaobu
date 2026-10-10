/**
 * 小卜 · L9 暖光强化与暗角   src/scene/layers/L9Grade.ts
 * ===========================================================================
 * 调色的最后一笔，两件事：
 *
 *   ① 暖光晕：把"光从哪来"再强调一次 —— 窗口一处强的、壁灯一处弱的。
 *      光的方向必须与 L1 的窗、L3 的受光边、所有接触影的朝向完全一致。
 *      这是整张画面唯一一处"可以被一眼看穿的不一致"，必须对齐。
 *   ② 暗角：四角压暗，把视线收进桌面中心。
 *      没有暗角，画面会"散"；暗角过重，会变"廉价滤镜"。
 *      0.26 是在 390×844 上试出来的边界值。
 *
 * ★★ 与 L8 同属**天气模块唯一允许写入的地方**（门禁 ⑥）★★
 *   天气可以调暗角的浓度与暖光的色温；但绝不允许影响六爻与解卦。
 * ===========================================================================
 */

import { BAND, DESIGN_H, DESIGN_W, TOKENS, alpha, type LayerStack } from '@scene/renderer'
import { LAMP_PX, WINDOW_PX } from './worldLayout'

export const L9_ID = 'l9-grade'

/**
 * 天气可调的三个量。默认值 = 春 · 黄昏（= 内置配置的默认季节）。
 * M2 由 weatherProvider 写入；每个都有 clamp，防止远端配置把画面调坏。
 */
const grade = {
  /** 暗角浓度 */
  vignette: 0.26,
  /** 暖光晕强度倍率 */
  bloom: 1,
  /** 暖光色温（天气写入口会把它挪向偏冷/偏暖） */
  bloomTint: TOKENS.cWarmVeil as string,
}

export function registerL9(stack: LayerStack): void {
  stack.add({
    id: L9_ID,
    band: BAND.VIGNETTE,
    sortY: 0,
    static: true,
    draw: drawL9,
  })
}

/** 天气写入口：只改浓度 / 色温，不改任何几何 */
export function setGrade(
  next: Partial<{ vignette: number; bloom: number; bloomTint: string }>,
  stack: LayerStack,
): void {
  if (next.vignette !== undefined) {
    grade.vignette = Math.max(0.14, Math.min(0.36, next.vignette))
  }
  if (next.bloom !== undefined) {
    grade.bloom = Math.max(0.75, Math.min(1.25, next.bloom))
  }
  if (next.bloomTint) grade.bloomTint = next.bloomTint
  stack.invalidateCache('GRADE')
}

export function getGrade(): Readonly<typeof grade> {
  return grade
}

function drawL9(ctx: CanvasRenderingContext2D): void {
  drawBloom(ctx)
  drawVignette(ctx)
}

function drawBloom(ctx: CanvasRenderingContext2D): void {
  // ① 窗口方向：主光
  const wx = WINDOW_PX.x + WINDOW_PX.w / 2
  const wy = WINDOW_PX.y + WINDOW_PX.h / 2
  radial(ctx, wx, wy, 40, 360, [
    [0, alpha(grade.bloomTint, 0.2 * grade.bloom)],
    [0.45, alpha(grade.bloomTint, 0.08 * grade.bloom)],
    [1, alpha(grade.bloomTint, 0)],
  ])

  // ② 壁灯方向：副光（弱一档，避免右侧死黑）
  radial(ctx, LAMP_PX.x, LAMP_PX.y + 10, 10, LAMP_PX.r * 7, [
    [0, alpha(TOKENS.cAmberGlow, 0.14 * grade.bloom)],
    [1, alpha(TOKENS.cAmberGlow, 0)],
  ])
}

/**
 * 暗角。
 * 用一个大半径的径向渐变，中心略偏向桌面（y ≈ 470）而不是画布几何中心 ——
 * 这样"该亮的地方"（桌子）正好落在渐变最亮的区域，视线自然被收进去。
 */
function drawVignette(ctx: CanvasRenderingContext2D): void {
  const cx = DESIGN_W / 2
  const cy = 470
  const g = ctx.createRadialGradient(cx, cy, 120, cx, cy, 580)
  g.addColorStop(0, alpha(TOKENS.cVignette, 0))
  g.addColorStop(0.58, alpha(TOKENS.cVignette, grade.vignette * 0.12))
  g.addColorStop(0.82, alpha(TOKENS.cVignette, grade.vignette * 0.55))
  g.addColorStop(1, alpha(TOKENS.cVignette, grade.vignette))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H)

  // 底部再压一道，把"地面往远处延伸"的错觉收住，画面才有边框感
  const bg = ctx.createLinearGradient(0, DESIGN_H - 170, 0, DESIGN_H)
  bg.addColorStop(0, alpha(TOKENS.cVignette, 0))
  bg.addColorStop(1, alpha(TOKENS.cVignette, grade.vignette * 0.5))
  ctx.fillStyle = bg
  ctx.fillRect(0, DESIGN_H - 170, DESIGN_W, 170)
}

/** 径向渐变填充（三个调用点共用，省掉重复的 createRadialGradient 样板） */
function radial(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r0: number,
  r1: number,
  stops: ReadonlyArray<readonly [number, string]>,
): void {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1)
  for (const [pos, color] of stops) g.addColorStop(pos, color)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r1, 0, Math.PI * 2)
  ctx.fill()
}
