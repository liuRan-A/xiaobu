/**
 * 小卜 · L3 木桌   src/scene/layers/L3Table.ts
 * ===========================================================================
 * 场景的舞台。它必须一眼读作"一张厚实的木桌"，而不是一块菱形色块。
 * 靠四件事做到：
 *
 *   ① 三个面（顶面受光 / 左face 半受光 / 右face 背光）—— 立体感来自明度差，
 *      不是来自描边。画轮廓线的桌子一定像 PPT 图形。
 *   ② 木纹：沿 u 轴的一组平行线（sliceLine），两种棕色交替、低对比。
 *   ③ 光池：从窗方向打进来的一片暖光，clip 在顶面内。这一层把"光"落到了实物上。
 *   ④ 接触影：桌下与桌面上器物落点各有一层软影。**没有影子，物体就是贴纸。**
 *
 * ★ 桌面是**网格上的正方形**（见 renderer/isometric.ts §二 与 worldLayout.ts），
 *   四顶点由"可信上下顶点 + 网格比例"导出。曾经照抄过一组实测值，
 *   但那是把画布裁切线当成了桌角，导致"卦盘探出桌面"——已修正。
 *   现在由 `npm run check:art`（门禁⑫）守着"半宽/半高 = ISO.ratio"。
 * ★ 静态层：烘焙进离屏缓存。
 * ===========================================================================
 */

import {
  BAND,
  TOKENS,
  alpha,
  mix,
  sliceLine,
  quadPath,
  type LayerStack,
  type Quad,
  type Vec2,
} from '@scene/renderer'
import { TABLE_APRON, TABLE_QUAD } from './worldLayout'

export const L3_ID = 'l3-table'

export function registerL3(stack: LayerStack): void {
  stack.add({
    id: L3_ID,
    band: BAND.TABLE,
    sortY: 0,
    static: true,
    draw: drawL3,
  })
}

function drawL3(ctx: CanvasRenderingContext2D): void {
  drawUnderShadow(ctx)
  drawApron(ctx) // 左右两个受光面（先画，之后顶面压住接缝）
  drawTopFace(ctx)
  drawLightPool(ctx)
  drawGrain(ctx)
  drawEdgeLight(ctx)
}

// ── 桌下接触影 ─────────────────────────────────────────────────────────────

function drawUnderShadow(ctx: CanvasRenderingContext2D): void {
  const cx = TABLE_QUAD.bottom.x
  const cy = TABLE_QUAD.bottom.y + TABLE_APRON

  // ★ 炭笔涂抹感：边缘用确定性相位抖动，不再是一圈光滑椭圆。
  //   两层叠加：外圈大而淡、内圈小而重，仍是软阴影的层次，但边缘有手绘的"毛边"。
  smudgeEllipse(ctx, cx, cy + 2, 168, 30, 0.1, 0)
  smudgeEllipse(ctx, cx, cy - 2, 118, 20, 0.14, 7)
}

/**
 * 画一圈"炭笔涂抹"的椭圆阴影：沿椭圆弧采样，每段半径加一个确定性抖动。
 *
 * ★ 为什么不能平滑椭圆 + 为什么不能用 random：
 *   ① 平滑椭圆是"机器画的影"，炭笔感来自边缘不齐；
 *   ② 用确定性相位（sin 叠加坐标哈希），同一椭圆永远同一条边 ——
 *      门禁 ⑭ 要求直画 ≡ 离屏缓存，random 会让两次烘焙抖动不同、门禁假红。
 *
 * @param jitter 抖动幅度（设计 px）。0 = 不抖动。
 * @param seed   相位种子，错开相邻两层影的抖动，避免"毛边"整齐地重叠。
 */
function smudgeEllipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  a: number,
  seed: number,
): void {
  const SEG = 28 // 采样段数：够密才圆润，够少才看得出"涂抹"
  ctx.beginPath()
  for (let i = 0; i <= SEG; i++) {
    const ang = (i / SEG) * Math.PI * 2
    // 确定性抖动：两个不同频率的正弦叠一个坐标哈希，形成"炭笔扫过"的不规则感
    const jx = Math.sin(ang * 3 + seed) * 2.2 + hashJitter(i, seed) * 2.2
    const jy = Math.cos(ang * 2 + seed * 1.7) * 1.6 + hashJitter(i + 31, seed) * 1.6
    const x = cx + (rx + jx) * Math.cos(ang)
    const y = cy + (ry + jy) * Math.sin(ang)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cCharcoalWarm, a)
  ctx.fill()
}

/** 整数 → [-0.5, 0.5] 的确定性抖动值（与 L10 的 hashNoise 同源思想，避免跨文件随机） */
function hashJitter(n: number, seed: number): number {
  let h = n * 374761393 + seed * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296 - 0.5
}

// ── 桌身（左右两个受光面） ────────────────────────────────────────────────

function drawApron(ctx: CanvasRenderingContext2D): void {
  const { left, right, bottom } = TABLE_QUAD

  // 左face：面向窗户 → 半受光，暖木色
  const lg = ctx.createLinearGradient(left.x, left.y, bottom.x, bottom.y + TABLE_APRON)
  lg.addColorStop(0, mix(TOKENS.cWoodLeft, '#ffffff', 0.1))
  lg.addColorStop(1, mix(TOKENS.cWoodLeft, TOKENS.cContactShadow, 0.28))
  ctx.beginPath()
  ctx.moveTo(left.x, left.y)
  ctx.lineTo(bottom.x, bottom.y)
  ctx.lineTo(bottom.x, bottom.y + TABLE_APRON)
  ctx.lineTo(left.x, left.y + TABLE_APRON)
  ctx.closePath()
  ctx.fillStyle = lg
  ctx.fill()

  // 右face：背光 → 明显压暗
  const rg = ctx.createLinearGradient(right.x, right.y, bottom.x, bottom.y + TABLE_APRON)
  rg.addColorStop(0, mix(TOKENS.cWoodRight, '#ffffff', 0.06))
  rg.addColorStop(1, mix(TOKENS.cWoodRight, TOKENS.cContactShadow, 0.34))
  ctx.beginPath()
  ctx.moveTo(right.x, right.y)
  ctx.lineTo(bottom.x, bottom.y)
  ctx.lineTo(bottom.x, bottom.y + TABLE_APRON)
  ctx.lineTo(right.x, right.y + TABLE_APRON)
  ctx.closePath()
  ctx.fillStyle = rg
  ctx.fill()

  // 桌身木纹：几条竖向短线（手绘弯曲），证明"这是木头不是塑料"
  ctx.strokeStyle = alpha(TOKENS.cWoodGrainB, 0.3)
  ctx.lineWidth = 1
  for (let i = 1; i < 5; i++) {
    const t = i / 5
    const a = lerp(left, bottom, t)
    handDrawnLine(ctx, { x: a.x, y: a.y + 5 }, { x: a.x, y: a.y + TABLE_APRON - 5 }, i)

    const b = lerp(right, bottom, t)
    handDrawnLine(ctx, { x: b.x, y: b.y + 5 }, { x: b.x, y: b.y + TABLE_APRON - 5 }, i + 5)
  }

  // 上下沿的暗线：把桌身"收"进轮廓里，避免边缘发虚
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.22)
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(left.x, left.y + TABLE_APRON)
  ctx.lineTo(bottom.x, bottom.y + TABLE_APRON)
  ctx.lineTo(right.x, right.y + TABLE_APRON)
  ctx.stroke()
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

// ── 顶面 ───────────────────────────────────────────────────────────────────

function drawTopFace(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, TABLE_QUAD.top.y, 0, TABLE_QUAD.bottom.y)
  g.addColorStop(0, mix(TOKENS.cWoodTop, '#ffffff', 0.12))
  g.addColorStop(0.5, TOKENS.cWoodTop)
  g.addColorStop(1, mix(TOKENS.cWoodTop, TOKENS.cContactShadow, 0.2))

  quadPath(ctx, TABLE_QUAD)
  ctx.fillStyle = g
  ctx.fill()
}

// ── 光池 ───────────────────────────────────────────────────────────────────

/** 窗光落在桌面上的一片暖光。clip 在顶面内，绝不溢出 —— 溢出就变成"雾"。 */
function drawLightPool(ctx: CanvasRenderingContext2D): void {
  withTableClip(ctx, TABLE_QUAD, () => {
    const g = ctx.createLinearGradient(20, TABLE_QUAD.top.y + 10, 320, TABLE_QUAD.bottom.y - 40)
    g.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.36))
    g.addColorStop(0.42, alpha(TOKENS.cWarmVeil, 0.15))
    g.addColorStop(1, alpha(TOKENS.cWarmVeil, 0))
    ctx.fillStyle = g
    ctx.fillRect(0, TABLE_QUAD.top.y, 390, TABLE_QUAD.bottom.y - TABLE_QUAD.top.y)

    // 桌面近处也要压一点暗，否则桌子和地面糊成一片
    const dg = ctx.createLinearGradient(0, TABLE_QUAD.bottom.y - 90, 0, TABLE_QUAD.bottom.y)
    dg.addColorStop(0, alpha(TOKENS.cContactShadow, 0))
    dg.addColorStop(1, alpha(TOKENS.cContactShadow, 0.16))
    ctx.fillStyle = dg
    ctx.fillRect(0, TABLE_QUAD.bottom.y - 90, 390, 90)
  })
}

// ── 木纹 ───────────────────────────────────────────────────────────────────

/**
 * 沿 u 轴（顶面左上 ↔ 右下方向）的一组平行线。
 * 用 sliceLine(q, t)：t=0 落在"上→左"边，t=1 落在"右→下"边。
 * 两种棕色交替 + 低对比 —— 木纹要"看得出来"但不该"抢眼"。
 */
function drawGrain(ctx: CanvasRenderingContext2D): void {
  withTableClip(ctx, TABLE_QUAD, () => {
    ctx.lineWidth = 1
    for (let i = 0; i < 11; i++) {
      const t = (i + 0.5) / 11
      const [a, b] = sliceLine(TABLE_QUAD, t)
      ctx.strokeStyle = alpha(i % 2 === 0 ? TOKENS.cWoodGrainA : TOKENS.cWoodGrainB, i % 3 === 0 ? 0.3 : 0.18)
      handDrawnLine(ctx, a, b, i)
    }

    // 靠右的一条更重的纹理：木头总有一处"结"
    const [ka, kb] = sliceLine(TABLE_QUAD, 0.87)
    ctx.strokeStyle = alpha(TOKENS.cWoodGrainB, 0.4)
    ctx.lineWidth = 1.6
    handDrawnLine(ctx, ka, kb, 11)
  })
}

/**
 * ★ 手绘线条（落日山丘 · 线条感试点）：把直线换成带轻微弯曲的二次曲线。
 *
 * 为什么是确定性相位而不是 Math.random：
 *   门禁⑭要求「直画路径 ≡ 离屏缓存路径」逐像素一致。静态层各烘焙一次，
 *   random 会让两次烘焙的木纹抖动不同 → 直画与缓存永远对不上 → 门禁假红。
 *   sin(i * 黄金比) 保证同一条线永远弯同一个方向同一幅度。
 *
 * 幅度刻意小（≤2.2 设计 px）：线条感要"手绘"不要"颤抖"，弯多了像地震波。
 */
function handDrawnLine(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2, seed: number): void {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  // 垂直于线段的方向，弯往这一侧
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const nx = -(b.y - a.y) / len
  const ny = (b.x - a.x) / len
  const bend = Math.sin(seed * 2.399963) * 2.2 // 黄金角相位：相邻线弯向自然错开
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.quadraticCurveTo(mx + nx * bend, my + ny * bend, b.x, b.y)
  ctx.stroke()
}

// ── 受光边 ─────────────────────────────────────────────────────────────────

/** 沿"上→左"边的一条暖亮线：窗光正好擦过这条棱。立体感最后一步。 */
function drawEdgeLight(ctx: CanvasRenderingContext2D): void {
  const { top, left, right } = TABLE_QUAD
  const g = ctx.createLinearGradient(top.x, top.y, left.x, left.y)
  g.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.75))
  g.addColorStop(1, alpha(TOKENS.cWarmVeil, 0.25))
  ctx.strokeStyle = g
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.moveTo(top.x, top.y)
  ctx.lineTo(left.x, left.y)
  ctx.stroke()

  // 背光边压暗，把桌子"推"向光里
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.2)
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(top.x, top.y)
  ctx.lineTo(right.x, right.y)
  ctx.stroke()
}

/**
 * ★ 把绘制"关"在桌面顶面内的作用域工具。
 *
 * 为什么不做成 `clipToTableTop(ctx)` + 手工 `restore()`：
 *   Canvas2D 的 clip 是**状态栈上的累积裁剪**，一旦漏掉 restore，**后面所有图层**
 *   都会被裁在这一小块区域里 —— 症状是"整屏只剩一个亮块"，而且排查时很难联想到
 *   几百行之前的某次 clip。这类 bug 一旦出现就是全屏级的，代价极高。
 *
 * 所以这里用回调把 save / clip / restore 收进一个函数，并用 try/finally 保证
 * **即使回调里抛异常也会 restore**（异常由 LayerStack 的逐层 try/catch 接住并隔离）。
 * 调用方想漏都漏不掉。
 */
export function withTableClip(
  ctx: CanvasRenderingContext2D,
  quad: Quad,
  draw: () => void,
): void {
  ctx.save()
  try {
    quadPath(ctx, quad)
    ctx.clip()
    draw()
  } finally {
    ctx.restore()
  }
}
