/**
 * 小卜 · L8 暖色薄纱   src/scene/layers/L8Veil.ts
 * ===========================================================================
 * 一整屏、opacity 0.085 的暖黄罩层。
 *
 * 它的作用只有一句话：**把"色块拼贴"统一成"一张照片"。**
 * 单独看每个图层的颜色都对，但拼在一起总会各自为政；罩一层同色系的暖纱之后，
 * 所有颜色被拉到同一个色温上，"塑料感"就消失了。这是最便宜、最有效的一招。
 *
 * ★★ 这一层与 L9 是**天气模块唯一允许写入的地方**（架构文档 §8.3.6 / 门禁 ⑥）★★
 *   天气只改这里的浓淡与色温 —— 也就是"粒子"与"滤镜"。
 *   它绝不允许影响六爻与 AI 解卦。两者的数据结构不共享任何字段。
 *   LayerStack 的 isWeatherWritable() 与 ci/gates/02-weather-oneway.mjs 双向守住这条线。
 *
 * ★ 静态层：烘焙进离屏缓存。M2 接入天气后，改浓淡只需 invalidateCache(['GRADE'])。
 * ===========================================================================
 */

import { BAND, DESIGN_H, DESIGN_W, TOKENS, alpha, type LayerStack } from '@scene/renderer'

export const L8_ID = 'l8-warm-veil'

/**
 * 薄纱浓度。这是**唯一允许被天气调的量**（多云 0.11 / 晴 0.085 / 雨 0.13 / 雪 0.10）。
 * M2 由 weatherProvider 通过 setVeilOpacity() 写入，不直接改本文件的常量。
 */
let veilOpacity = 0.085

export function registerL8(stack: LayerStack): void {
  stack.add({
    id: L8_ID,
    band: BAND.VEIL,
    sortY: 0,
    static: true,
    draw: drawL8,
  })
}

/** 天气写入口 —— 只改浓度，立即失效 GRADE 缓存让下一帧重烘焙 */
export function setVeilOpacity(opacity: number, stack: LayerStack): void {
  const next = Math.max(0.04, Math.min(0.18, opacity)) // clamp：再高就"发黄"，再低就散了
  if (Math.abs(next - veilOpacity) < 1e-4) return
  veilOpacity = next
  stack.invalidateCache('GRADE')
}

export function getVeilOpacity(): number {
  return veilOpacity
}

function drawL8(ctx: CanvasRenderingContext2D): void {
  // 用一个极淡的竖向渐变，而不是纯色满涂：
  // 上方稍浓（靠近窗）、下方稍淡，罩层才不会把画面"压平"。
  const g = ctx.createLinearGradient(0, 0, 0, DESIGN_H)
  g.addColorStop(0, alpha(TOKENS.cWarmVeil, veilOpacity * 1.18))
  g.addColorStop(0.55, alpha(TOKENS.cWarmVeil, veilOpacity))
  g.addColorStop(1, alpha(TOKENS.cWarmVeil, veilOpacity * 0.82))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H)
}
