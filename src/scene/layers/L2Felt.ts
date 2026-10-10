/**
 * 小卜 · L2 毛毡地毯与地板   src/scene/layers/L2Felt.ts
 * ===========================================================================
 * 一块椭圆毛毡。它承担两个视觉任务：
 *   ① 把"地"和"桌"之间那段空白填住，场景才显得**紧凑**
 *   ② 用绒点与同心环制造 **柔软感** —— 这是"微缩模型"与"扁平色块"的分水岭
 *
 * ★ 绒点必须用**确定性伪随机**（种子 LCG）预生成。
 *   用 Math.random() 的话每帧位置都变，画面会持续闪 —— 这是做纹理最常见的翻车点。
 * ★ 静态层：烘焙进离屏缓存。
 * ===========================================================================
 */

import { BAND, TOKENS, alpha, mix, type LayerStack } from '@scene/renderer'
import { FELT } from './worldLayout'

export const L2_ID = 'l2-felt'

export function registerL2(stack: LayerStack): void {
  stack.add({
    id: L2_ID,
    band: BAND.FELT,
    sortY: 0,
    static: true,
    draw: drawL2,
  })
}

/** 确定性伪随机（线性同余）。种子写死 = 每次启动的绒点分布完全一致。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Tuft {
  x: number
  y: number
  r: number
  a: number
}

/** 绒点：模块加载时算一次，之后每帧复用同一份坐标 */
const TUFTS: readonly Tuft[] = (() => {
  const rnd = lcg(20261009)
  return Array.from({ length: FELT.tufts }, () => {
    const ang = rnd() * Math.PI * 2
    // sqrt 让点在大圆内**均匀**分布，而不是全挤在圆心
    const dist = Math.sqrt(rnd()) * 0.93
    return {
      x: FELT.cx + Math.cos(ang) * FELT.rx * dist,
      y: FELT.cy + Math.sin(ang) * FELT.ry * dist,
      r: 1.0 + rnd() * 1.5,
      a: 0.26 + rnd() * 0.4,
    }
  })
})()

function drawL2(ctx: CanvasRenderingContext2D): void {
  const { cx, cy, rx, ry } = FELT

  // ① 落地阴影：外扩一圈、极低对比 —— 毛毡是"厚"的，边缘不能是硬切
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy + 6, rx * 1.035, ry * 1.06, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.12)
  ctx.filter = 'none'
  ctx.fill()
  ctx.restore()

  // ② 主体：上亮下暗的竖向渐变，模拟从窗方向来的光
  const g = ctx.createLinearGradient(0, cy - ry, 0, cy + ry)
  g.addColorStop(0, mix(TOKENS.cFelt, '#ffffff', 0.16))
  g.addColorStop(0.52, TOKENS.cFelt)
  g.addColorStop(1, mix(TOKENS.cFelt, TOKENS.cContactShadow, 0.16))
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // ③ 同心环：三层，越往里越淡 —— 读作"被踩出来的圈"
  const ringScales = [0.8, 0.58, 0.36]
  ringScales.forEach((s, i) => {
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx * s, ry * s, 0, 0, Math.PI * 2)
    ctx.strokeStyle = alpha(TOKENS.cFeltRing, 0.4 - i * 0.07)
    ctx.lineWidth = 1.4
    ctx.stroke()
  })

  // ④ 绒点：这是"毛绒感"的全部来源。少了它，就是一块干净的椭圆色 ——正是要避免的。
  ctx.fillStyle = alpha(TOKENS.cFeltTuft, 0.75)
  for (const t of TUFTS) {
    ctx.beginPath()
    ctx.globalAlpha = t.a
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // ⑤ 边缘一圈细描边：把毛毡从地板上"抬"起来一点
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.strokeStyle = alpha(TOKENS.cFeltRing, 0.55)
  ctx.lineWidth = 1.5
  ctx.stroke()
}
