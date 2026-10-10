/**
 * 小卜 · L7 小卜（白色猫形灵兽）   src/scene/layers/L7Xiaobu.ts
 * ===========================================================================
 * 它是这个产品唯一的"人"。三条表演原则：
 *
 *   ① 它**不抢戏**。位置固定在桌面左缘之外，尺寸克制（约 40 × 78 px）。
 *      待机时只有呼吸（缩放 1.00 ↔ 1.02）与偶尔的视线偏移 —— 全场没有一个字。
 *   ② 它**始终面向卦盘**。因为它是"陪着你看"的角色，不是装饰品。
 *   ③ M2 的视线跟随（偏移 ≤ ±6pt）与第 4 态"退半步"都作用在同一套局部坐标上，
 *      所以这里把原点定在**脚底中心**，所有形状都用负 y 向上描述 ——
 *      以后加"抬头""转头""后退"都只是改 transform，不用重画身体。
 *
 * ★ 动态层（不 static）：呼吸吃 frame.t。
 *   注册时按脚底 y 排序，于是它自然排在木桌之后 —— 站在桌前的层次就对了。
 * ===========================================================================
 */

import { BAND, TOKENS, alpha, mix, type Frame, type LayerStack, type Vec2 } from '@scene/renderer'
import { SORT, XIAOBU_PX } from './worldLayout'

export const L7_ID = 'l7-xiaobu'

/**
 * 小卜的可见性与位置（阶段 B · 双形态生命周期）。
 *
 * ★ 模块级变量 + setter（与 setTubeShake / setTimepieces 同一模式）：
 *   小卜化为悬浮球（DOM 层）时画布侧隐藏；被"拖出小屋"时位置跟手。
 *   默认值 = 美术稿站位，"没人喂"时一切如常 —— 降级路径天然成立。
 * ★ 位置是**设计坐标**（390×844 画布上的脚底中心），由拖拽层换算后喂入。
 */
let xiaobuVisible = true
let xiaobuPos: Vec2 = { x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY }

/** 小卜当前脚底位置（设计坐标）。拖拽层与命中判定共用这一份真相 */
export function xiaobuAt(): Readonly<Vec2> {
  return xiaobuPos
}

/** 小卜画布侧是否可见（悬浮球形态时 false） */
export function xiaobuVisibleNow(): boolean {
  return xiaobuVisible
}

export function setXiaobuVisible(v: boolean): void {
  xiaobuVisible = v
}

/** 把小卜放回美术稿站位（回屋动画的落点） */
export function resetXiaobuPos(): void {
  xiaobuPos = { x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY }
}

/** 拖拽中每帧喂入脚底位置（设计坐标）。不做 clamp —— 越界由调用方决定语义（化球） */
export function setXiaobuPos(p: Vec2): void {
  xiaobuPos = { x: p.x, y: p.y }
}

export function registerL7(stack: LayerStack): void {
  stack.add({
    id: L7_ID,
    band: BAND.XIAOBU,
    sortY: SORT.xiaobu,
    z: 0,
    draw: drawL7,
  })
}

function drawL7(ctx: CanvasRenderingContext2D, frame: Frame): void {
  // ★ 悬浮球形态：画布侧完全不画（球由 DOM 层画），省一整个图层的开销
  if (!xiaobuVisible) return

  // 呼吸围绕**当前位置**：拖拽中也在呼吸，而不是僵住
  const cx = xiaobuPos.x
  const baseY = xiaobuPos.y

  // 呼吸：周期约 3.1s，幅度刻意只到 2%（"起伏在 1.00 ↔ 1.02 之间"）
  const phase = frame.t / 1550
  const bob = Math.sin(phase) * 1.1
  const squash = 1 + Math.sin(phase) * 0.012

  // ① 影子先画，且不跟着呼吸动 —— 身体起伏但影子不变，才像"站在地上"
  ctx.beginPath()
  ctx.ellipse(cx + 2, baseY + 3, 17, 5.2, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.24)
  ctx.fill()

  ctx.save()
  ctx.translate(cx, baseY + bob)
  ctx.scale(1 / squash, squash) // 呼吸是"竖向拉长"，横向略收，体积守恒

  drawTail(ctx)
  drawBody(ctx)
  drawHead(ctx)

  ctx.restore()
}

// 以下全部使用「脚底中心为原点、向上为负 y」的局部坐标

function drawTail(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath()
  ctx.moveTo(-12, -8)
  ctx.quadraticCurveTo(-30, -14, -30, -30)
  ctx.quadraticCurveTo(-30, -36, -25, -34)
  ctx.quadraticCurveTo(-24, -20, -9, -2)
  ctx.closePath()
  ctx.fillStyle = TOKENS.cCatShade
  ctx.fill()
  ctx.strokeStyle = alpha(TOKENS.cCatLine, 0.18)
  ctx.lineWidth = 0.8
  ctx.stroke()
}

function drawBody(ctx: CanvasRenderingContext2D): void {
  // 坐姿：一个偏下的主体椭圆
  const g = ctx.createLinearGradient(-16, -34, 16, 0)
  g.addColorStop(0, mix(TOKENS.cCat, '#ffffff', 0.35)) // 左受光
  g.addColorStop(0.55, TOKENS.cCat)
  g.addColorStop(1, TOKENS.cCatShade)
  ctx.beginPath()
  ctx.ellipse(0, -17, 15.5, 17, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // 前爪：两条小小的弧，读作"坐着"
  ctx.beginPath()
  ctx.ellipse(-6, -3, 4.6, 3, 0, 0, Math.PI * 2)
  ctx.ellipse(6, -3, 4.6, 3, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cCatShade, 0.85)
  ctx.fill()
}

function drawHead(ctx: CanvasRenderingContext2D): void {
  const hx = 1
  const hy = -46
  const r = 15.5

  // 耳：先画耳再画头，耳的根部会被头盖住 —— 否则会出现"贴上去的三角"。
  // 坐标是**局部绝对坐标**（原点在脚底中心，向上为负），不是相对头心。
  drawEar(ctx, { x: -12, y: -52 }, { x: -7, y: -70 }, { x: 2, y: -58 })
  drawEar(ctx, { x: 3, y: -58 }, { x: 10, y: -71 }, { x: 16, y: -51 })

  // 头
  const g = ctx.createRadialGradient(hx - 6, hy - 7, 1, hx, hy, r * 1.25)
  g.addColorStop(0, mix(TOKENS.cCat, '#ffffff', 0.5))
  g.addColorStop(0.62, TOKENS.cCat)
  g.addColorStop(1, TOKENS.cCatShade)
  ctx.beginPath()
  ctx.arc(hx, hy, r, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // 眼睛：两个竖椭圆 + 一点高光。高光是"活"的关键。
  for (const ex of [hx - 6, hx + 7]) {
    ctx.beginPath()
    ctx.ellipse(ex, hy + 1, 2.7, 3.4, 0, 0, Math.PI * 2)
    ctx.fillStyle = TOKENS.cCatLine
    ctx.fill()

    ctx.beginPath()
    ctx.arc(ex - 0.9, hy - 0.5, 0.95, 0, Math.PI * 2)
    ctx.fillStyle = alpha('#ffffff', 0.9)
    ctx.fill()
  }

  // 腮红
  ctx.beginPath()
  ctx.ellipse(hx - 10.5, hy + 5.5, 3.8, 2.3, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cCatEar, 0.5)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(hx + 11, hy + 5.5, 3.8, 2.3, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cCatEar, 0.5)
  ctx.fill()

  // 鼻：一个小三角
  ctx.beginPath()
  ctx.moveTo(hx, hy + 4.5)
  ctx.lineTo(hx - 2, hy + 6.6)
  ctx.lineTo(hx + 2, hy + 6.6)
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cCatEar, 0.8)
  ctx.fill()
}

/**
 * 一只耳朵：外耳 cCat + 内耳 cCatEar。
 * 三个点按"耳根外侧 → 耳尖 → 耳根内侧"给，用直线画成小三角 ——
 * 圆角化的猫耳在这个尺寸下读不出差别，反而容易画歪。
 */
function drawEar(ctx: CanvasRenderingContext2D, outer: Vec2, apex: Vec2, inner: Vec2): void {
  ctx.beginPath()
  ctx.moveTo(outer.x, outer.y)
  ctx.lineTo(apex.x, apex.y)
  ctx.lineTo(inner.x, inner.y)
  ctx.closePath()
  ctx.fillStyle = TOKENS.cCat
  ctx.fill()
  ctx.strokeStyle = alpha(TOKENS.cCatLine, 0.16)
  ctx.lineWidth = 0.8
  ctx.stroke()

  // 内耳：把外耳向三角形重心收缩一圈
  const gx = (outer.x + apex.x + inner.x) / 3
  const gy = (outer.y + apex.y + inner.y) / 3
  const k = 0.52
  const s = (p: Vec2): Vec2 => ({ x: gx + (p.x - gx) * k, y: gy + (p.y - gy) * k })
  const o = s(outer)
  const a = s(apex)
  const i = s(inner)

  ctx.beginPath()
  ctx.moveTo(o.x, o.y)
  ctx.lineTo(a.x, a.y)
  ctx.lineTo(i.x, i.y)
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cCatEar, 0.7)
  ctx.fill()
}
