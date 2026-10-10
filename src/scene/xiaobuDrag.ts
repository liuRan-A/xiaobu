/**
 * 小卜 · 拖拽判定   src/scene/xiaobuDrag.ts
 * ===========================================================================
 * 「屋内实体 ⇄ 悬浮球」形态切换的**纯判定逻辑**，零副作用、零 DOM、零 canvas ——
 * Scene.vue 的指针搬运层只在三个时机问它三句话：
 *
 *   · 按下时：`hitXiaobu(p)` —— 这一下是不是按在小卜身上
 *   · 拖动时：`followDrag(p)` —— 脚底该跟到哪（设计坐标原样放行）
 *   · 松手时：`dropOutcome(start, p)` —— 回桌边，还是化成悬浮球
 *
 * ★ 为什么不进引擎：小卜的双形态是 **UI 层生命周期**，不参与任何流程状态 ——
 *   引擎的 roomMachine / ritualMachine 对此一无所知（core 不认识小卜）。
 *   放 Scene 层的独立模块，既不污染"Scene 只搬运"的契约，也能在 node 里单测。
 *
 * ★ 阈值都取设计 pt：40pt ≈ 一根手指的自然拖动距离，
 *   小于它视作"没拖动"（点一下），不触发形态切换。
 * ===========================================================================
 */

import type { Vec2 } from '@scene/renderer'
import { XIAOBU_PX } from './layers/worldLayout'

/** 小卜的触摸半径（设计 pt）。它约 40×78，圆心在身体中部，r=30 覆盖得住 */
const XIAOBU_TOUCH_R_PT = 30

/** 拖动判定阈值：位移超过它才算"拖了"（否则是点一下） */
export const XIAOBU_DRAG_THRESHOLD_PT = 6

/** 松手时离原位超过这个距离 → 化悬浮球；否则弹回桌边 */
export const XIAOBU_ORB_DISTANCE_PT = 40

/** 按下的点是否落在小卜身上（设计坐标） */
export function hitXiaobu(p: Vec2, at: Vec2 = { x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY }): boolean {
  // 命中范围以"身体中部"为圆心：脚底往上 24pt
  const cy = at.y - 24
  return dist(p, { x: at.x, y: cy }) <= XIAOBU_TOUCH_R_PT
}

/** 拖动跟手：直接返回设计坐标（越界语义由 dropOutcome 决定，不在拖动中打断） */
export function followDrag(p: Vec2): Vec2 {
  return { x: p.x, y: p.y }
}

/** 松手的结局 */
export type XiaobuDrop = 'back' | 'orb'

/**
 * 松手判定。
 * @param start 按下时的设计坐标
 * @param at    松手时的设计坐标
 * @returns 'back' 弹回桌边（没拖动 / 拖了又拖回来了）；'orb' 化成悬浮球
 */
export function dropOutcome(start: Vec2, at: Vec2): XiaobuDrop {
  if (dist(start, at) < XIAOBU_ORB_DISTANCE_PT) return 'back'
  return 'orb'
}

/** 拖没拖动（区分"点一下"与"拖拽"，两边的语义完全不同） */
export function isDrag(start: Vec2, at: Vec2): boolean {
  return dist(start, at) >= XIAOBU_DRAG_THRESHOLD_PT
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
