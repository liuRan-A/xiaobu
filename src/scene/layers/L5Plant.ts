/**
 * 小卜 · L5 窗边小盆栽   src/scene/layers/L5Plant.ts
 * ===========================================================================
 * 布景，不是玩法物件 —— 没有网格语义，直接按像素画。
 * 作用有三个：把桌面的右后角"收住"、给画面一个非黄色的绿色锚点、
 * 以及最重要的：**让房间看起来有人住**。
 * ★ 静态：形状不随时间变。但会呼吸的叶子留在 M2 的动效层做，别混进来。
 * ===========================================================================
 */

import { BAND, TOKENS, alpha, mix, type LayerStack } from '@scene/renderer'
import { PLANT_PX, SORT } from './worldLayout'

export const L5_ID = 'l5-plant'

export function registerL5(stack: LayerStack): void {
  stack.add({
    id: L5_ID,
    band: BAND.PLANT,
    sortY: SORT.plant,
    z: 0,
    draw: drawL5,
  })
}

/** 五片叶子的姿态：角度（弧度，以正上方为 0）、长度、弯曲 */
const LEAVES = [
  { a: -0.62, len: 26, w: 6.5 },
  { a: -0.26, len: 33, w: 7.5 },
  { a: 0.04, len: 30, w: 7 },
  { a: 0.34, len: 25, w: 6.5 },
  { a: 0.66, len: 20, w: 5.5 },
] as const

function drawL5(ctx: CanvasRenderingContext2D): void {
  const { cx, baseY, potW, potH } = PLANT_PX

  // ① 落桌接触影
  ctx.beginPath()
  ctx.ellipse(cx + 3, baseY + 2, potW * 0.56, 8, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.24)
  ctx.fill()

  // ② 叶片（先画叶，再画盆口把叶根压住 —— 顺序反了会看到"插上去的叶子"）
  for (const leaf of LEAVES) {
    const baseX = cx + Math.sin(leaf.a) * 2
    const baseYY = baseY - potH + 2
    const tipX = baseX + Math.sin(leaf.a) * leaf.len
    const tipY = baseYY - Math.cos(leaf.a) * leaf.len

    const g = ctx.createLinearGradient(baseX, baseYY, tipX, tipY)
    g.addColorStop(0, TOKENS.cLeafDeep)
    g.addColorStop(1, mix(TOKENS.cLeaf, '#ffffff', 0.18))

    ctx.beginPath()
    ctx.moveTo(baseX, baseYY)
    // 两段二次曲线拼一片柳叶：左边去、右边回
    ctx.quadraticCurveTo(
      baseX + Math.sin(leaf.a) * leaf.len * 0.5 - leaf.w,
      baseYY - Math.cos(leaf.a) * leaf.len * 0.5,
      tipX,
      tipY,
    )
    ctx.quadraticCurveTo(
      baseX + Math.sin(leaf.a) * leaf.len * 0.5 + leaf.w,
      baseYY - Math.cos(leaf.a) * leaf.len * 0.5,
      baseX,
      baseYY,
    )
    ctx.closePath()
    ctx.fillStyle = g
    ctx.fill()

    // 叶脉：一条极淡的中线，让叶子不是一块色块
    ctx.beginPath()
    ctx.moveTo(baseX, baseYY)
    ctx.lineTo(tipX, tipY)
    ctx.strokeStyle = alpha(TOKENS.cLeafDeep, 0.45)
    ctx.lineWidth = 0.7
    ctx.stroke()
  }

  // ③ 花盆：下窄上宽的梯形
  const topW = potW
  const botW = potW * 0.68
  const topY = baseY - potH
  ctx.beginPath()
  ctx.moveTo(cx - topW / 2, topY)
  ctx.lineTo(cx + topW / 2, topY)
  ctx.lineTo(cx + botW / 2, baseY)
  ctx.lineTo(cx - botW / 2, baseY)
  ctx.closePath()
  const pg = ctx.createLinearGradient(cx - topW / 2, 0, cx + topW / 2, 0)
  pg.addColorStop(0, mix(TOKENS.cPot, '#ffffff', 0.22)) // 左受光
  pg.addColorStop(0.55, TOKENS.cPot)
  pg.addColorStop(1, TOKENS.cPotDeep)
  ctx.fillStyle = pg
  ctx.fill()

  // 盆口：一圈略宽的外沿
  ctx.beginPath()
  ctx.rect(cx - topW / 2 - 2, topY - 5, topW + 4, 6)
  ctx.fillStyle = mix(TOKENS.cPot, '#ffffff', 0.1)
  ctx.fill()
  // 盆口内壁：一点深色，读作"里面有土"
  ctx.beginPath()
  ctx.rect(cx - topW / 2 + 1, topY - 4.5, topW - 2, 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.4)
  ctx.fill()

  // 盆底一条接触暗线，把它"放"在桌上
  ctx.beginPath()
  ctx.rect(cx - botW / 2, baseY - 2.5, botW, 2.5)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.22)
  ctx.fill()
}
