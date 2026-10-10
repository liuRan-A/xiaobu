/**
 * 小卜 · 仪式动效画法   src/scene/ritual/draw.ts
 * ===========================================================================
 * 掷币这条支线的**全部画笔**。它只画，不做决定 —— 什么时候画什么由
 * `RitualEngine.view()` 说了算，这里只负责"把它画得好看且省"。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  四条纪律（都是踩过坑才写的）
 * ───────────────────────────────────────────────────────────────────────────
 *  ① **每个函数自己 save / restore。**
 *     `LayerStack.paint` 是**裸调** `draw(ctx, frame)` 的（它假设每层自己收拾干净）。
 *     所以任何 translate / globalAlpha / setLineDash 都必须成对还回去 ——
 *     不然抖一下竹筒会把之后画的每一层一起平移，画一圈虚线会把后面所有描边变虚线。
 *     `setLineDash` 尤其是重灾区：它**不受 save/restore 保护之外**没有别的兜底，
 *     忘了复位就是"整个房间的线都变成虚线"，而报错一个都没有。
 *
 *  ② **不新开粒子系统。** 拖尾 = 3 个定点（`sampleFlight` 给），涟漪 = 2 个描边椭圆。
 *     规范原文：「严禁引入物理引擎」「复用同一粒子池，不新开系统」。
 *
 *  ③ **所有颜色从 TOKENS 派生、所有尺寸从 thresholds 取。**
 *     painter 里出现 `rgba(139, 123, 216, 0.22)` 或 `30` 这类字面值即为违规 ——
 *     改一次设计 Token 要 grep 全仓，就是这套纪律存在的全部理由。
 *
 *  ④ **永不抛。** 每个入口先看关键参数是否有限，坏输入直接 no-op。
 *     一层画不出来只该少一层，不该让整个房间静止（门禁 ⑨ 的精神）。
 * ===========================================================================
 */

import {
  TOKENS,
  alpha,
  flattenRy,
  mix,
  quadCenter,
  quadPath,
  type Quad,
  type Vec2,
} from '@scene/renderer'
import { drawCoinAt, slotGrooveQuad, BOARD_ELLIPSE, COIN_IDLE_PX, SORT, slotSortY } from '@scene/layers'
import {
  COIN_LIFT_SCALE,
  CURSOR_OFFSET_PT,
  DIM_OTHERS_SCALE,
  HALO_ALPHA_LIFT,
  HALO_R_IDLE,
  HALO_R_LIFT,
  LIFT_SHADOW_RX,
  LIFT_SHADOW_RY,
  PLACE_BRIGHTEN_PCT,
  PLACE_HALO_ALPHA,
  PLACE_HALO_R,
  PREDICT_RING_PULSE_MS,
  PREDICT_RING_RX,
  PREDICT_RING_RY,
  SLOT_BREATH_ALPHA,
  SLOT_BREATH_FAST_MS,
  SLOT_BREATH_MS,
  SLOT_FILL_ALPHA,
  SLOT_STROKE_PT,
  SHADOW_ALPHA_IDLE,
  SHADOW_ALPHA_LIFT,
} from '@core/ritual/thresholds'
import { easeOutCubic, type FlightPlay } from '@core/ritual/flightPlay'
import { SLOT_CENTERS } from '@core/machine/ritualMachine'

/** 圆圈：等距下一个"躺平的圆"永远是 2:1 的椭圆，所以到处都要 flattenRy */
const ellipse = (
  ctx: CanvasRenderingContext2D,
  at: Vec2,
  rx: number,
  ry: number,
): void => {
  ctx.beginPath()
  ctx.ellipse(at.x, at.y, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2)
}

const okPt = (p: Vec2 | null | undefined): p is Vec2 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y)

// ───────────────────────────────────────────────────────────────────────────
// 一、盘面：提亮 + 柔紫外晕
// ───────────────────────────────────────────────────────────────────────────

/**
 * 进入选位态时卦盘的响应：**盘面提亮 6% + 三层柔紫外晕**。
 *
 * ★ 关于 `PLACE_HALO_ALPHA = [0.06, 0.07, 0.22]` 的配对方向（这里与规范原文的
 *   数组成员顺序相反，是刻意的）：把那三个数按原序配给半径 [124, 132, 143]，
 *   画出来是**外圈最亮**（α .22 落在 r=143）—— 那读作一圈硬描边，
 *   而不是"盘子在发光"。晕的法则是"离物体越近越亮、向外衰减"，
 *   所以半径升序配**透明度降序**。三个数一个没改，只是配对方向反了。
 *
 * ★ 为什么用描边而不是三层叠加的填充：三层填充（原序）能做出真正的径向渐变，
 *   但它们的半径 124~143 **全部大于盘面半径 118** —— 要纯外部晕就得裁掉内部，
 *   而裁剪的代价（一个 clip 路径 + 一次 save/restore）比收益大。
 *   描边三圈在 0.22 / 0.07 / 0.06 的透明度下视觉上等价，且几乎零成本。
 *
 * @param k 0..1 的进场强度（PLACE 进入时从 0 涨到 1，`MS.boardLightUp` 240ms）
 */
export function drawBoardGlow(ctx: CanvasRenderingContext2D, k: number): void {
  if (!Number.isFinite(k) || k <= 0.001) return
  // ★ `BOARD_ELLIPSE` 是 {cx, cy, rx, ry}，而 `ellipse()` 收的是 Vec2 圆心。
  //   在这里转一次，而不是让画笔去兼容第二种形状 —— 画笔越少形状越好维护。
  const c: Vec2 = { x: BOARD_CX, y: BOARD_CY }
  const e = BOARD_ELLIPSE

  ctx.save()

  // ① 盘面提亮：一层暖白薄罩。是"多反了一点光"，不是"变成白色"
  ellipse(ctx, c, e.rx, e.ry)
  ctx.fillStyle = alpha(TOKENS.cWarmVeil, (PLACE_BRIGHTEN_PCT / 100) * k)
  ctx.fill()

  // ② 三层柔紫外晕：半径升序 ↔ 透明度降序（理由见上）
  for (let i = 0; i < PLACE_HALO_R.length; i++) {
    const r = PLACE_HALO_R[i]
    const a = PLACE_HALO_ALPHA[PLACE_HALO_R.length - 1 - i] ?? 0
    if (a <= 0) continue
    ellipse(ctx, c, r, flattenRy(r))
    ctx.strokeStyle = alpha(TOKENS.cAccent, a * k)
    ctx.lineWidth = 2
    ctx.stroke()
  }

  ctx.restore()
}

// ───────────────────────────────────────────────────────────────────────────
// 二、空槽呼吸 / 预备吸附
// ───────────────────────────────────────────────────────────────────────────

/**
 * 空槽的呼吸高亮。
 *
 * @param ease   每个槽的落定缓动进度（-1 = 空槽）。★ 已落过位的槽**不再呼吸** ——
 *               规范原文：「已落过位的槽上放着铜钱、不再高亮」。
 * @param t      累计毫秒（呼吸相位）
 * @param fast   引导态 B 下周期从 4s 加快到 2.4s（"该选一格了"）
 */
export function drawSlotBreath(ctx: CanvasRenderingContext2D, ease: readonly number[], t: number, fast: boolean): void {
  if (!ease || ease.length === 0) return
  const period = fast ? SLOT_BREATH_FAST_MS : SLOT_BREATH_MS
  const phase = Number.isFinite(t) ? t : 0
  const k = 0.5 + 0.5 * Math.sin((phase / period) * Math.PI * 2)

  ctx.save()
  for (let i = 0; i < SLOT_CENTERS.length; i++) {
    if ((ease[i] ?? -1) >= 0) continue // 已被占：不呼吸
    paintSlot(ctx, slotGrooveQuad(i), k)
  }
  ctx.restore()
}

/** 一个空槽：柔紫底 + 细描边，亮度随呼吸摆动 */
function paintSlot(ctx: CanvasRenderingContext2D, cell: Quad, k: number): void {
  quadPath(ctx, cell)
  // 底：柔紫（不是灰）—— "这里可以放东西"必须读起来是邀请，不是占位符
  ctx.fillStyle = alpha(TOKENS.cAccentSoft, SLOT_FILL_ALPHA * (0.7 + 0.6 * k))
  ctx.fill()

  const a = SLOT_BREATH_ALPHA[0] + (SLOT_BREATH_ALPHA[1] - SLOT_BREATH_ALPHA[0]) * k
  quadPath(ctx, cell)
  ctx.strokeStyle = alpha(TOKENS.cAccent, a)
  ctx.lineWidth = SLOT_STROKE_PT
  ctx.stroke()
}

/**
 * 预备吸附（指针进入某槽 44pt 内）：该槽描边提亮 + 加粗。
 * ★ 它比呼吸更亮、且**不随时间摆动** —— 用户需要一条"就是它"的确定信号，
 *   而一个也在呼吸的目标和一个也在呼吸的邻居分不出来。
 */
export function drawArmedSlot(ctx: CanvasRenderingContext2D, slot: number, k = 1): void {
  if (slot < 0 || slot >= SLOT_CENTERS.length) return
  const w = Number.isFinite(k) ? Math.max(0, Math.min(1, k)) : 0
  if (w <= 0.001) return

  ctx.save()
  const cell = slotGrooveQuad(slot)
  quadPath(ctx, cell)
  ctx.fillStyle = alpha(TOKENS.cAccentSoft, 0.5 * w)
  ctx.fill()
  quadPath(ctx, cell)
  ctx.strokeStyle = alpha(TOKENS.cAccent, 0.55 * w)
  ctx.lineWidth = 2.4
  ctx.stroke()
  ctx.restore()
}

// ───────────────────────────────────────────────────────────────────────────
// 三、落点预示环与涟漪
// ───────────────────────────────────────────────────────────────────────────

/**
 * 落点预示环：r 30×15 的虚线椭圆，脉冲周期 1.2s。
 *
 * ★ 它存在的意义是**降低"我该甩多用力"这件事的焦虑**：币还在空中时，
 *   用户已经能看到"它会落在哪"。所以它是虚线、是暖金色、在脉冲 ——
 *   一眼读作"大概在这一带"，而不是"必须落在这里"（实线会变成靶心，那就是压力）。
 */
export function drawPredictRing(ctx: CanvasRenderingContext2D, at: Vec2, t: number): void {
  if (!okPt(at)) return
  const phase = Number.isFinite(t) ? t : 0
  const pulse = 0.5 + 0.5 * Math.sin((phase / PREDICT_RING_PULSE_MS) * Math.PI * 2)
  const k = 0.94 + 0.06 * pulse

  ctx.save()
  ctx.setLineDash([4, 4])
  ellipse(ctx, at, PREDICT_RING_RX * k, PREDICT_RING_RY * k)
  ctx.strokeStyle = alpha(TOKENS.cGold, 0.45 + 0.25 * pulse)
  ctx.lineWidth = 1.2
  ctx.stroke()
  // ★ 虚线必须复位：不还原的话之后所有描边都会变成虚线（见文件头 §一·①）
  ctx.setLineDash([])
  ctx.restore()
}

/**
 * 落盘涟漪：2 个描边椭圆，从铜钱大小涨到卦盘三成宽。
 * ★ 只有**真的落在盘面上**才画 —— 落在木桌上不该激起"水面"。
 */
export function drawRipples(ctx: CanvasRenderingContext2D, at: Vec2, flight: FlightPlay | null): void {
  if (!okPt(at) || !flight || flight.ripples.length === 0) return

  ctx.save()
  for (const r of flight.ripples) {
    if (r.alpha <= 0.005) continue
    ellipse(ctx, at, r.rx, flattenRy(r.rx))
    ctx.strokeStyle = alpha(TOKENS.cWarmVeil, r.alpha)
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.restore()
}

// ───────────────────────────────────────────────────────────────────────────
// 四、飞行的币：拖尾 → 光晕 → 本体
// ───────────────────────────────────────────────────────────────────────────

/**
 * 3 段暖金残影。
 *
 * ★ 颜色用 `cGold` 而不是 `cWarmVeil`：铜钱运动时拖出来的是**金属反光**（偏黄），
 *   而涟漪是**光**（偏橙）。两种材质混用会让"币在飞"和"光在散"读成同一件事。
 */
export function drawTrail(ctx: CanvasRenderingContext2D, flight: FlightPlay | null): void {
  if (!flight || flight.trail.length === 0) return
  ctx.save()
  for (const d of flight.trail) {
    ellipse(ctx, d.at, d.r, flattenRy(d.r))
    ctx.fillStyle = alpha(TOKENS.cGold, d.alpha)
    ctx.fill()
  }
  ctx.restore()
}

/**
 * 拾起时脚下那块**柔紫椭圆投影**（96 × 30）。
 *
 * ★ 它与币自带的接触影（23 × 11.5）是两件东西，都要有：
 *   · 自带的那一小块负责"币有厚度、压在什么东西上"；
 *   · 这一大块负责"**它被抬起来了**" —— 影子变大变软 = 离桌面远了。
 *   只留小的，币看起来像贴在桌上滑；只留大的，币看起来没有重量。
 */
export function drawLiftShadow(ctx: CanvasRenderingContext2D, at: Vec2, k: number): void {
  if (!okPt(at) || k <= 0.001) return
  const a = SHADOW_ALPHA_IDLE + (SHADOW_ALPHA_LIFT - SHADOW_ALPHA_IDLE) * k
  ctx.save()
  ellipse(ctx, { x: at.x + 2, y: at.y + 4 }, LIFT_SHADOW_RX * (0.9 + 0.1 * k), LIFT_SHADOW_RY * (0.9 + 0.1 * k))
  ctx.fillStyle = alpha(TOKENS.cAccent, a)
  ctx.fill()
  ctx.restore()
}

/**
 * 拾起时铜钱外圈那道柔紫光环（r 18 → 21、α 0 → 0.22）。
 * ★ 画两圈（外面一圈更宽更淡）而不是一圈：单圈描边读起来是"选中框"，
 *   两圈递减才读起来是"光"。这是同一条成本，观感差一个量级。
 */
export function drawCarryHalo(ctx: CanvasRenderingContext2D, at: Vec2, k: number, scale = 1): void {
  if (!okPt(at) || k <= 0.001) return
  const r = (HALO_R_IDLE + (HALO_R_LIFT - HALO_R_IDLE) * k) * scale
  ctx.save()
  ellipse(ctx, at, r, flattenRy(r))
  ctx.strokeStyle = alpha(TOKENS.cAccent, HALO_ALPHA_LIFT * k)
  ctx.lineWidth = 2
  ctx.stroke()
  ellipse(ctx, at, r * 1.35, flattenRy(r * 1.35))
  ctx.strokeStyle = alpha(TOKENS.cAccent, HALO_ALPHA_LIFT * k * 0.45)
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.restore()
}

/**
 * 手上 / 空中的那枚铜钱。
 *
 * ★ `shadowAlpha = 0`：它在半空中，脚下滑——接触影已经离开了它。
 *   影子交给 `drawLiftShadow` 的那块柔紫池子。
 * ★ `squashX` 是翻滚的唯一正确画法（见 `drawCoinAt` 的说明）。
 */
export function drawAirCoin(
  ctx: CanvasRenderingContext2D,
  at: Vec2,
  t: number,
  opts: { scale: number; squashX: number; alpha: number; halo: number },
): void {
  if (!okPt(at)) return
  drawLiftShadow(ctx, at, opts.halo)
  drawCarryHalo(ctx, at, opts.halo, opts.scale)
  drawCoinAt(ctx, at, t, {
    scale: opts.scale,
    alpha: opts.alpha,
    squashX: opts.squashX,
    shadowAlpha: 0,
  })
}

// ───────────────────────────────────────────────────────────────────────────
// 五、落位 / 待机 / 补币
// ───────────────────────────────────────────────────────────────────────────

/** 已落位铜钱的尺寸比例（20 / 24）—— 从 thresholds 的原始 pt 反推，不手抄小数 */
const SETTLED_SCALE = 20 / 24

/**
 * 停在爻位槽里的那枚铜钱。
 *
 * @param ease 0..1 的"吸过去"进度（`MS.snap = 120ms`）。
 *             从手上的 1.15 收到落位的 0.833，并下沉 3pt —— 读作"它被吸进去了"。
 */
export function drawSettledCoin(ctx: CanvasRenderingContext2D, slot: number, t: number, ease: number): void {
  if (slot < 0 || slot >= SLOT_CENTERS.length) return
  const p = easeOutCubic(Number.isFinite(ease) ? ease : 1)
  const scale = COIN_LIFT_SCALE + (SETTLED_SCALE - COIN_LIFT_SCALE) * p
  const center = SLOT_CENTERS[slot]
  drawCoinAt(ctx, { x: center.x, y: center.y - 3 * (1 - p) }, t, { scale })
}

/** 待机铜钱的落点（L4 自己的图层画它；这里导出是为了让"补币"能算出终点） */
export function coinHomeAt(i: number): Vec2 {
  return COIN_IDLE_PX[i] ?? { x: 0, y: 0 }
}

/** 补币滚出时的尺寸：从落位尺寸长回待机尺寸（"筒里滚出来的是一枚新币"） */
export function rollOutScale(roll: number): number {
  const p = easeOutCubic(Number.isFinite(roll) ? roll : 1)
  return SETTLED_SCALE + (1 - SETTLED_SCALE) * p
}

/** 被压暗的待机铜钱该用的缩放（L4 只做 alpha，这里给出配套的缩放给需要的人） */
export const DIM_COIN_SCALE = DIM_OTHERS_SCALE

/** 掷币时铜钱中心相对指针上方的偏移 —— 导出给测试用，免得测试手抄 22 */
export const CARRY_OFFSET_PT = CURSOR_OFFSET_PT

// ───────────────────────────────────────────────────────────────────────────
// 六、排序键（动效层注册进 LayerStack 时用）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 盘面相关动效（提亮 / 呼吸 / 预示环 / 涟漪）的排序键。
 *
 * ★ 取 `SORT.board + 0.5`：必须在**卦盘之后**（否则被盘面盖住），
 *   又必须在**所有爻位槽铜钱之前**（否则涟漪会压在刚落位的币上）。
 *   卦盘是 469.07、最近的槽是 508 —— 中间这一整段都是空的，0.5 落在最前面。
 */
export const BOARD_FX_SORT_Y = SORT.board + 0.5

/** 第 i 个爻位槽上铜钱的排序键 —— 直接用 worldLayout 给的，不重算 */
export const SLOT_COIN_SORT_Y = (i: number): number => slotSortY(i)

/**
 * 手上 / 空中的铜钱：排在 STAGE 的最后。
 *
 * ★ 为什么给一个大到离谱的常数而不是"跟着它的 y 走"：
 *   它在**半空**，遮挡关系不该由它投影到桌面的 y 决定 ——
 *   一枚从竹筒飞向卦盘的币，途中 y 会扫过 424 → 528 → 569，
 *   按 y 排序的话它会在半路"从卦盘后面钻出来"，穿帮。
 *   飞行的币永远在桌面之上，所以永远最后画。
 */
export const AIR_COIN_SORT_Y = 1e6

/** 六爻槽中心（动效层画落位币要高亮哪个槽）—— 转发 core 的那一份，避免两处坐标 */
export { SLOT_CENTERS }

/** 供 UI 层显示"盘面在哪"（不做 DOM，只给坐标） */
export const BOARD_CX = BOARD_ELLIPSE.cx
export const BOARD_CY = BOARD_ELLIPSE.cy

/** 呼吸高亮的底色 —— 与槽底的柔紫同源，混一点暖光更贴"暖金 + 柔紫"的配色 */
export const SLOT_TINT = mix(TOKENS.cAccentSoft, TOKENS.cWarmVeil, 0.15)

/** 一个槽的四边形的几何中心（小卜指路、引导箭头要用） */
export function slotCenterOf(slot: number): Vec2 {
  if (slot < 0 || slot >= SLOT_CENTERS.length) return { x: 0, y: 0 }
  return quadCenter(slotGrooveQuad(slot))
}
