/**
 * 小卜 · L6 卦盘与六爻位槽   src/scene/layers/L6Board.ts
 * ===========================================================================
 * 卦盘是这张桌子上唯一的"仪器"，它必须由两件事撑住可信度：
 *
 *   ① 它是**一块架在桌面上的木板**，不是画在桌上的图案
 *      → 一块偏移的软影 + 一圈侧沿厚度 + 盘面比桌面稍深稍冷的木色
 *   ② 六个爻位槽是**刻出来的凹槽**，不是六个色块
 *      → 槽内压暗 + 上沿一道暗线（凹陷的上壁）+ 下沿一道亮线（凹陷的下唇）
 *
 * ★ 遮挡排序的关键（LayerStack 的招牌特例）：
 *   卦盘是"平躺的平面"，它的排序键取**四顶点里最靠上的那个**（platformSortY），
 *   而不是中心。这样六个槽（y ∈ [508, 549]）和落在槽里的铜钱一律排在盘之后，
 *   也就是"画在盘面上"。用中心排序的话，靠后的槽会被盘面盖掉。
 *
 * ★ 六爻位槽的世界坐标由 worldLayout 统一给（沿 +u 每 1 单位一个），
 *   这里只负责把它们画出来 —— 位置算术不在这层，避免"两个地方各算一遍"。
 * ===========================================================================
 */

import {
  BAND,
  TOKENS,
  alpha,
  mix,
  quadCenter,
  quadOf,
  quadPath,
  type LayerStack,
  type Quad,
  type Vec2,
} from '@scene/renderer'
import { BOARD, SLOT_COUNT, SLOT_V, SORT, TABLE_Z, slotU } from './worldLayout'

export const L6_ID = 'l6-board'

/** 槽比格子略小一圈，槽与槽之间留出"刻痕间距"，否则连成一整条 */
const SLOT_FIT = 0.78

export function registerL6(stack: LayerStack): void {
  stack.add({
    id: L6_ID,
    band: BAND.BOARD,
    // ★ 平台取最远角
    sortY: SORT.board,
    z: 0,
    draw: drawL6,
  })
}

function drawL6(ctx: CanvasRenderingContext2D): void {
  const q = boardQuadOf()

  drawBoardShadow(ctx, q)
  drawBoardSlab(ctx, q) // 侧沿厚度（在盘面之下）
  drawBoardFace(ctx, q)
  drawSlots(ctx)
  drawBoardRim(ctx, q)
}

/** 取卦盘四顶点（worldLayout 已算好，这里只做一次转发便于阅读） */
function boardQuadOf(): Quad {
  return quadOf(BOARD.u, BOARD.v, BOARD.w, BOARD.d, BOARD.z)
}

/**
 * 供动效层复用：第 i 个爻位槽的**凹槽四边形**（与 `drawGroove` 画的是同一个）。
 *
 * ★ 必须导出而不是让动效层自己 `quadOf(...)` 一遍：槽呼吸高亮、预备吸附描边
 *   都要**精确落在**凹槽上。两处各算一次的话，SLOT_FIT 或 SLOT_V 一改，
 *   高亮就会偏出槽外 —— 而那种偏差只有几个像素，肉眼看不出，只会觉得"有点脏"。
 */
export function slotGrooveQuad(i: number): Quad {
  return quadOf(slotU(i), SLOT_V, SLOT_FIT, SLOT_FIT, TABLE_Z)
}

// ── 盘中影 ─────────────────────────────────────────────────────────────────

function drawBoardShadow(ctx: CanvasRenderingContext2D, q: Quad): void {
  const off = 7
  const shifted: Quad = {
    top: { x: q.top.x + off, y: q.top.y + off * 1.4 },
    right: { x: q.right.x + off, y: q.right.y + off * 1.4 },
    bottom: { x: q.bottom.x + off, y: q.bottom.y + off * 1.4 },
    left: { x: q.left.x + off, y: q.left.y + off * 1.4 },
  }
  quadPath(ctx, shifted)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.2)
  ctx.fill()
}

// ── 盘身侧沿 ───────────────────────────────────────────────────────────────

/** 沿"左→下→右"两条边向下挤出 5px 的厚度。5px 很小，但少了它就是一块贴纸。 */
function drawBoardSlab(ctx: CanvasRenderingContext2D, q: Quad): void {
  const d = 5
  ctx.beginPath()
  ctx.moveTo(q.left.x, q.left.y)
  ctx.lineTo(q.bottom.x, q.bottom.y)
  ctx.lineTo(q.right.x, q.right.y)
  ctx.lineTo(q.right.x, q.right.y + d)
  ctx.lineTo(q.bottom.x, q.bottom.y + d)
  ctx.lineTo(q.left.x, q.left.y + d)
  ctx.closePath()
  ctx.fillStyle = mix(TOKENS.cWoodRight, TOKENS.cContactShadow, 0.35)
  ctx.fill()
  // 侧沿顶部的亮线 = 盘面的厚度高光
  ctx.beginPath()
  ctx.moveTo(q.left.x, q.left.y)
  ctx.lineTo(q.bottom.x, q.bottom.y)
  ctx.lineTo(q.right.x, q.right.y)
  ctx.strokeStyle = alpha(TOKENS.cWarmVeil, 0.35)
  ctx.lineWidth = 1
  ctx.stroke()
}

// ── 盘面 ───────────────────────────────────────────────────────────────────

function drawBoardFace(ctx: CanvasRenderingContext2D, q: Quad): void {
  const g = ctx.createLinearGradient(q.top.x, q.top.y, q.bottom.x, q.bottom.y)
  g.addColorStop(0, mix(TOKENS.cWoodTop, TOKENS.cWoodGrainA, 0.35))
  g.addColorStop(0.55, mix(TOKENS.cWoodTop, TOKENS.cWoodGrainA, 0.48))
  g.addColorStop(1, mix(TOKENS.cWoodTop, TOKENS.cContactShadow, 0.3))
  quadPath(ctx, q)
  ctx.fillStyle = g
  ctx.fill()
}

/** 盘边框：外一圈重、内一圈（缩 0.88）细 —— 古盘的"郭"与"内框" */
function drawBoardRim(ctx: CanvasRenderingContext2D, q: Quad): void {
  quadPath(ctx, q)
  ctx.strokeStyle = alpha(TOKENS.cWoodGrainB, 0.7)
  ctx.lineWidth = 1.8
  ctx.stroke()

  const inner = scaleQuad(q, 0.88)
  quadPath(ctx, inner)
  ctx.strokeStyle = alpha(TOKENS.cWarmVeil, 0.28)
  ctx.lineWidth = 1
  ctx.stroke()
}

// ── 六个爻位槽 ─────────────────────────────────────────────────────────────

function drawSlots(ctx: CanvasRenderingContext2D): void {
  for (let i = 0; i < SLOT_COUNT; i++) {
    drawGroove(ctx, slotGrooveQuad(i))
  }
}

/**
 * 一个凹槽：底色压暗 + 上沿暗线 + 下沿亮线。
 * 三条线的明暗方向必须和"光从左上来"一致 ——
 * 光从左上来 ⇒ 凹槽的上壁背光（暗），下唇受光（亮）。
 * 反过来画就变成"凸起的按钮"，整个盘面的层次立刻错。
 */
function drawGroove(ctx: CanvasRenderingContext2D, cell: Quad): void {
  quadPath(ctx, cell)
  ctx.fillStyle = alpha(TOKENS.cWoodGrainB, 0.34)
  ctx.fill()

  const c = quadCenter(cell)
  const upL = midPoint(cell.top, cell.left)
  const upR = midPoint(cell.top, cell.right)
  const dnL = midPoint(cell.bottom, cell.left)
  const dnR = midPoint(cell.bottom, cell.right)

  // 上壁：暗
  ctx.beginPath()
  ctx.moveTo(upL.x, upL.y)
  ctx.lineTo(upR.x, upR.y)
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.4)
  ctx.lineWidth = 1.4
  ctx.stroke()

  // 下唇：亮
  ctx.beginPath()
  ctx.moveTo(dnL.x, dnL.y)
  ctx.lineTo(dnR.x, dnR.y)
  ctx.strokeStyle = alpha(TOKENS.cWarmVeil, 0.42)
  ctx.lineWidth = 1.2
  ctx.stroke()

  // 槽心：一点点更深的底，读作"这里能放下东西"
  ctx.beginPath()
  ctx.ellipse(c.x, c.y + 0.5, cell.right.x - c.x - 3, 2.2, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.2)
  ctx.fill()
}

// ── 几何小工具 ─────────────────────────────────────────────────────────────

function midPoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 以中心为原点等比缩放一个四边形（画内框、内圈用它） */
function scaleQuad(q: Quad, k: number): Quad {
  const c = quadCenter(q)
  const s = (p: Vec2): Vec2 => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k })
  return { top: s(q.top), right: s(q.right), bottom: s(q.bottom), left: s(q.left) }
}
