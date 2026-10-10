/**
 * 小卜 · L4 竹筒与铜钱   src/scene/layers/L4Props.ts
 * ===========================================================================
 * 仪式的两件道具。它们承担全片最重的"材质说服力"：
 *
 *   · 竹筒：圆柱 → 必须有**横向明度渐变**（左受光 / 右背光）；
 *          三道红箍 + 一个深色筒口，才有"能装东西"的体积感。
 *   · 铜钱：躺平的一枚圆 → 外观是 **2:1 的椭圆**（等距投影的直接结果）；
 *          方孔在等距下投影成**菱形**，不是正方形；金属感靠"外沿暗 + 上缘一道亮弧"。
 *
 * ★ 三者都注册为 **STAGE** 里的独立渲染项，各自带自己的 sortY。
 *   于是它们与卦盘、小卜之间由"影子排序"自动决定前后 —— 不需要人工指定层级。
 * ★ 铜钱位置从美术实测像素反推（worldLayout），代码里不手抄小数。
 * ===========================================================================
 */

import {
  BAND,
  TOKENS,
  alpha,
  flattenRy,
  mix,
  quadPath,
  stylizedDiamond,
  type LayerStack,
  type Vec2,
} from '@scene/renderer'
import { DIM_OTHERS_ALPHA } from '@core/ritual/thresholds'
import type { TexSource } from '@services/tex'
import {
  COIN_IDLE_PX,
  COIN_RADIUS,
  COINS_IDLE,
  DECK_PX,
  HOURGLASS_PX,
  SORT,
  TABLE_Z,
  TEA_TABLE_PX,
  TUBE_BARREL_H_PX,
  TUBE_PX,
  tubeFootPx,
} from './worldLayout'
import type { MemoryKind } from '@core/memory/memoryAnchor'

export const L4_TUBE_ID = 'l4-tube'
export const L4_COIN_ID = (i: number): string => `l4-coin-${i}`

/** 竹筒口椭圆的半高（等距下是 2:1） */
const TUBE_MOUTH_RY = 6

/**
 * 竹筒的震颤偏移（设计 pt）。
 *
 * ★ 为什么要一个模块级可变值，而不是把竹筒改成"每帧重建的渲染项"：
 *   竹筒的排序键（`SORT.tube`）是**固定**的 —— 它不会因为抖 1.5pt 就换前后关系。
 *   为了抖一下而让它每帧重排，代价远大于收益（一次可变的 translate 而已）。
 *
 * ★ 只有 L4 自己写它（`setTubeShake`），动画层每帧喂进去。
 *   默认 0，所以"没人喂"时竹筒静止 —— 降级路径天然成立。
 */
let tubeShakeDx = 0
let tubeShakeDy = 0

/** 由动效层每帧写入竹筒的震颤偏移。★ 单位是设计 pt，不是角度 */
export function setTubeShake(dx: number, dy = 0): void {
  tubeShakeDx = Number.isFinite(dx) ? dx : 0
  tubeShakeDy = Number.isFinite(dy) ? dy : 0
}

/**
 * 待机铜钱是否整体压暗（拾起一枚时另两枚压到 82%）。
 * ★ 被拾起的那一枚此刻是**隐藏**的（由空中的那层画），所以这里不需要知道是哪一枚 ——
 *   留在桌面上的每一枚都该暗下去。少一个参数，就少一处"传错了但看不出来"。
 */
let coinsDimmed = false
export function setCoinDim(on: boolean): void {
  coinsDimmed = on
}

/** 当前待机铜钱的透明度 —— 供测试与调试读取 */
export function coinIdleAlpha(): number {
  return coinsDimmed ? DIM_OTHERS_ALPHA : 1
}

export function registerL4(stack: LayerStack): void {
  // 竹筒：按它在桌面上的影子排序
  stack.add({
    id: L4_TUBE_ID,
    band: BAND.PROPS,
    sortY: SORT.tube,
    z: 0,
    draw: (ctx) => drawTube(ctx),
  })

  // 待机的两枚铜钱
  COINS_IDLE.forEach((_coin, i) => {
    stack.add({
      id: L4_COIN_ID(i),
      band: BAND.PROPS,
      sortY: SORT.coins[i],
      z: 0,
      draw: (ctx, frame) => {
        if (!coinsDimmed) {
          drawCoin(ctx, COIN_IDLE_PX[i], frame.t, i)
          return
        }
        // ★ globalAlpha 要自己 save/restore —— 见 drawTube 里同一处的说明：
        //   LayerStack.paint 是裸调 draw 的，不还原会把之后所有图层一起压暗。
        ctx.save()
        ctx.globalAlpha = DIM_OTHERS_ALPHA
        drawCoin(ctx, COIN_IDLE_PX[i], frame.t, i)
        ctx.restore()
      },
    })
  })
}

// ── 竹筒 ───────────────────────────────────────────────────────────────────

function drawTube(ctx: CanvasRenderingContext2D): void {
  const { x, w } = TUBE_PX
  const cx = x + w / 2
  const foot = tubeFootPx()

  // ★ 震颤：整筒一起平移（含它的接触影）。只抖筒身、影子钉住不做，是因为
  //   1.5pt 的幅度下"影子跟不跟"根本看不出来，而两套坐标会多一处出错的地方。
  // ★ translate 必须自己 save/restore：LayerStack.paint 是**裸调** draw 的
  //   （它假设每个图层的 draw 自己收拾干净）。不还原的话，抖一下竹筒
  //   会把之后画的每一层（卦盘、铜钱、小卜）一起平移 —— 整个房间跟着晃。
  const shaking = tubeShakeDx !== 0 || tubeShakeDy !== 0
  if (shaking) {
    ctx.save()
    ctx.translate(tubeShakeDx, tubeShakeDy)
  }

  // ① 落桌接触影：筒是立着的，影子要"贴"在底部而不是绕一圈
  ctx.beginPath()
  ctx.ellipse(foot.x + 3, foot.y + 3, w * 0.62, w * 0.24, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.22)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(foot.x + 1, foot.y + 1, w * 0.5, w * 0.18, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.18)
  ctx.fill()

  const top = foot.y - TUBE_BARREL_H_PX

  // ② 筒身：横向渐变 = 圆柱。左受光、右背光，中间给一道最亮的高光柱。
  const g = ctx.createLinearGradient(x, 0, x + w, 0)
  g.addColorStop(0, mix(TOKENS.cBambooDeep, TOKENS.cContactShadow, 0.25))
  g.addColorStop(0.18, mix(TOKENS.cBamboo, '#ffffff', 0.22)) // 高光柱
  g.addColorStop(0.5, TOKENS.cBamboo)
  g.addColorStop(1, meetDark())
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.moveTo(x, top)
  ctx.lineTo(x + w, top)
  ctx.lineTo(x + w, foot.y)
  ctx.ellipse(cx, foot.y, w / 2, TUBE_MOUTH_RY, 0, 0, Math.PI)
  ctx.closePath()
  ctx.fill()

  // ③ 竹节：两道极淡的横向弧，说明它是"竹"不是"陶"
  ctx.strokeStyle = alpha(TOKENS.cBambooDeep, 0.5)
  ctx.lineWidth = 1
  for (const dy of [16, 30]) {
    ctx.beginPath()
    ctx.ellipse(cx, top + dy, w / 2, TUBE_MOUTH_RY * 0.8, 0, 0, Math.PI)
    ctx.stroke()
  }

  // ④ 三道红箍
  const bandYs = [top + 11, top + 21, top + 32]
  for (const by of bandYs) {
    ctx.beginPath()
    ctx.rect(x - 1, by, w + 2, 4)
    ctx.fillStyle = TOKENS.cBambooBand
    ctx.fill()
    // 箍的上沿留一条亮线，红箍才有"捆上去"的厚度
    ctx.beginPath()
    ctx.rect(x - 1, by, w + 2, 1.1)
    ctx.fillStyle = alpha(TOKENS.cCoinRim, 0.4)
    ctx.fill()
  }

  // ⑤ 筒口：深色内壁 + 一圈外沿。内壁要够黑，才读得出"里面能装东西"。
  ctx.beginPath()
  ctx.ellipse(cx, top, w / 2, TUBE_MOUTH_RY, 0, 0, Math.PI * 2)
  ctx.fillStyle = TOKENS.cBambooMouth
  ctx.fill()

  ctx.beginPath()
  ctx.ellipse(cx, top, w / 2 - 3.5, TUBE_MOUTH_RY - 1.6, 0, 0, Math.PI * 2)
  ctx.fillStyle = mix(TOKENS.cBambooMouth, TOKENS.cCharcoalWarm, 0.6)
  ctx.fill()

  // 口沿高光：光从左上来
  ctx.beginPath()
  ctx.ellipse(cx, top, w / 2, TUBE_MOUTH_RY, 0, Math.PI * 1.06, Math.PI * 1.94)
  ctx.strokeStyle = alpha(TOKENS.cCoinRim, 0.55)
  ctx.lineWidth = 1.6
  ctx.stroke()

  if (shaking) ctx.restore()
}

/** 筒身右侧背光色 —— 与高光柱对称，避免渐变端点过硬 */
function meetDark(): string {
  return mix(TOKENS.cBambooDeep, TOKENS.cContactShadow, 0.42)
}

// ── 铜钱 ───────────────────────────────────────────────────────────────────

/**
 * 一枚躺平的铜钱。
 * @param px    落点（设计像素）
 * @param t     累计时间 —— 用于待机时的暖金呼吸反光
 * @param index 第几枚（让两枚的呼吸相位错开，画面才"活"）
 * @param shadowAlpha 接触影的不透明度。★ 传 0 = 不画影。
 *        被拾起 / 在空中的币**不能**带接触影 —— 它在半空，影子已经离开了它；
 *        那时候脚下那块柔紫椭圆才是它该有的影（见 `drawLiftShadow`）。
 */
function drawCoin(
  ctx: CanvasRenderingContext2D,
  px: Vec2,
  t: number,
  index: number,
  shadowAlpha = 0.26,
): void {
  const r = COIN_RADIUS
  const ry = flattenRy(r) // 2:1 —— 等距投影下躺平的圆就该是这个比例
  const phase = t / 1600 + index * 1.7
  // 呼吸幅度刻意做得极小：是"金属在暖光下微微发亮"，不是"在闪"
  const breathe = 0.86 + Math.sin(phase) * 0.14

  // ① 接触影
  if (shadowAlpha > 0) {
    ctx.beginPath()
    ctx.ellipse(px.x + 1.5, px.y + 2, r * 1.05, ry * 1.05, 0, 0, Math.PI * 2)
    ctx.fillStyle = alpha(TOKENS.cContactShadow, shadowAlpha)
    ctx.fill()
  }

  // ② 币面：黄铜，左上受光
  const g = ctx.createLinearGradient(px.x - r, px.y - ry, px.x + r, px.y + ry)
  g.addColorStop(0, mix(TOKENS.cCoinFace2, '#ffffff', 0.3 * breathe))
  g.addColorStop(0.55, TOKENS.cCoinFace)
  g.addColorStop(1, mix(TOKENS.cCoinFace, TOKENS.cContactShadow, 0.34))
  ctx.beginPath()
  ctx.ellipse(px.x, px.y, r, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // ③ 打磨过的方孔：正方形在等距下投影成菱形（2:1），画成正方形会立刻"露馅"
  const hole = stylizedDiamond(px.x, px.y, r * 0.34, r * 0.17)
  quadPath(ctx, hole)
  ctx.fillStyle = TOKENS.cCoinHole
  ctx.fill()

  // 孔壁的一半亮边：说明这个孔是"透"的、有厚度
  ctx.beginPath()
  ctx.moveTo(hole.left.x, hole.left.y)
  ctx.lineTo(hole.bottom.x, hole.bottom.y)
  ctx.strokeStyle = alpha(TOKENS.cCoinRim, 0.5)
  ctx.lineWidth = 1
  ctx.stroke()

  // ④ 外沿：一道暗圈把币从桌面上"抠"出来
  ctx.beginPath()
  ctx.ellipse(px.x, px.y, r, ry, 0, 0, Math.PI * 2)
  ctx.strokeStyle = alpha(TOKENS.cCoinEdge, 0.75)
  ctx.lineWidth = 1.2
  ctx.stroke()

  // ⑤ 金属高光：上缘一道短亮弧。整枚币的"金属感"全押在这 1.8px 上。
  ctx.beginPath()
  ctx.ellipse(px.x, px.y, r - 1.2, ry - 0.8, 0, Math.PI * 1.05, Math.PI * 1.85)
  ctx.strokeStyle = alpha(TOKENS.cCoinRim, 0.6 * breathe)
  ctx.lineWidth = 1.8
  ctx.stroke()

  // ⑥ 内圈线：古钱的"郭"
  ctx.beginPath()
  ctx.ellipse(px.x, px.y, r * 0.78, ry * 0.78, 0, 0, Math.PI * 2)
  ctx.strokeStyle = alpha(TOKENS.cCoinEdge, 0.28)
  ctx.lineWidth = 0.9
  ctx.stroke()
}

/**
 * 供 M2 复用：在任意落点画一枚铜钱，可指定缩放 / 透明度 / 横向压缩。
 *
 * @param opts.squashX 横向压缩比例（1 = 摊平）。★ 这是"翻滚"的正确画法：
 *        一枚翻转中的铜钱在 2:1 等距下是**变窄**（立起来时只剩一条侧边），
 *        用 `ctx.rotate()` 画出来是俯视视角里的一只转盘，完全穿帮。
 *        压缩整枚币（含影、方孔、外沿）才自洽 —— 所以用 ctx.scale 而不是
 *        改半径参数：改半径只会把币画扁，方孔还是方的。
 * @param opts.shadowAlpha 接触影不透明度；**被拾起 / 在空中的币传 0**。
 */
export function drawCoinAt(
  ctx: CanvasRenderingContext2D,
  px: Vec2,
  t: number,
  opts: { scale?: number; alpha?: number; spin?: number; squashX?: number; shadowAlpha?: number } = {},
): void {
  ctx.save()
  ctx.globalAlpha = opts.alpha ?? 1
  ctx.translate(px.x, px.y)
  ctx.scale(opts.scale ?? 1, opts.scale ?? 1)
  if (opts.spin) ctx.rotate(opts.spin)
  // ★ 压缩放在 rotate 之后：先转再压，等价于"看着它绕水平轴翻"。
  //   顺序反了会变成"绕竖直轴转"，两种翻滚的观感完全不同。
  if (opts.squashX !== undefined) ctx.scale(opts.squashX, 1)
  drawCoin(ctx, { x: 0, y: 0 }, t, 0, opts.shadowAlpha ?? 0.26)
  ctx.restore()
}

/** 供场景层复用：把"待机铜钱的接触影"单独画一次（压暗/抬起时影子要跟着变） */
export function drawCoinShadow(
  ctx: CanvasRenderingContext2D,
  px: Vec2,
  alphaOf: number,
  scale = 1,
): void {
  const r = COIN_RADIUS * scale
  const ry = flattenRy(r)
  ctx.beginPath()
  ctx.ellipse(px.x + 1.5, px.y + 2, r * 1.05, ry * 1.05, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, alphaOf)
  ctx.fill()
}

/** 供 M2 复用：竹筒被落盘震动时调用（这里只导出常量，动画在 M2 的动效层做） */
export const TUBE_METRICS = Object.freeze({
  barrelHeight: TUBE_BARREL_H_PX,
  mouthRy: TUBE_MOUTH_RY,
  z: TABLE_Z,
})

// ───────────────────────────────────────────────────────────────────────────
// 角落茶几（M3 第二步 · 程序化骨架，牌堆的承载物）
// ───────────────────────────────────────────────────────────────────────────

export const L4_TEA_TABLE_ID = 'l4-tea-table'

/**
 * 注册角落茶几。
 *
 * ★ 它是**承载物/布景**，不是玩法物件：用 `BAND.TABLE` 进 BACKDROP，
 *   画在木桌之后、所有 STAGE 道具（竹筒/铜钱/牌堆）之前。牌堆就铺在它顶面上。
 *
 * ★ 静态：形状不随时间变，烘焙进离屏缓存（同木桌/地毯/盆栽）。
 */
export function registerTeaTable(stack: LayerStack): void {
  stack.add({
    id: L4_TEA_TABLE_ID,
    band: BAND.TABLE,
    sortY: 0,
    static: true,
    draw: drawTeaTable,
  })
}

/** 茶几尺寸（供牌堆定位对齐，牌堆中心 = 茶几桌面中心） */
export const TEA_TABLE_METRICS = Object.freeze({
  cx: TEA_TABLE_PX.cx,
  baseY: TEA_TABLE_PX.baseY,
  topW: TEA_TABLE_PX.topW,
  topH: TEA_TABLE_PX.topH,
  legH: TEA_TABLE_PX.legH,
})

function drawTeaTable(ctx: CanvasRenderingContext2D): void {
  const { cx, baseY, topW, topH, legH } = TEA_TABLE_PX

  // ① 落地接触影：比中央木桌小、更柔（角落的小几，影子轻）
  ctx.beginPath()
  ctx.ellipse(cx + 2, baseY + 2, topW * 0.62, topH * 0.8, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.16)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(cx, baseY, topW * 0.5, topH * 0.62, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.1)
  ctx.fill()

  // ② 桌腿：一根细柱（小圆几是"单柱"结构，不是四腿）
  const legTopY = baseY - legH
  ctx.beginPath()
  ctx.moveTo(cx - 4, legTopY)
  ctx.lineTo(cx + 4, legTopY)
  ctx.lineTo(cx + 6, baseY)
  ctx.lineTo(cx - 6, baseY)
  ctx.closePath()
  const legG = ctx.createLinearGradient(cx - 6, 0, cx + 6, 0)
  legG.addColorStop(0, mix(TOKENS.cWoodLeft, '#ffffff', 0.08))
  legG.addColorStop(1, mix(TOKENS.cWoodRight, TOKENS.cContactShadow, 0.2))
  ctx.fillStyle = legG
  ctx.fill()

  // ③ 桌面：小圆几的椭圆面（等距 2:1），木色，左受光右背光
  const g = ctx.createLinearGradient(cx - topW / 2, 0, cx + topW / 2, 0)
  g.addColorStop(0, mix(TOKENS.cWoodTop, '#ffffff', 0.14))
  g.addColorStop(0.5, TOKENS.cWoodTop)
  g.addColorStop(1, mix(TOKENS.cWoodTop, TOKENS.cContactShadow, 0.22))
  ctx.beginPath()
  ctx.ellipse(cx, baseY - legH, topW / 2, topH, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // ④ 桌面受光边：左上缘一条暖亮线（窗光擦过）
  ctx.beginPath()
  ctx.ellipse(cx, baseY - legH, topW / 2, topH, 0, Math.PI * 1.02, Math.PI * 1.9)
  ctx.strokeStyle = alpha(TOKENS.cWarmVeil, 0.55)
  ctx.lineWidth = 1.4
  ctx.stroke()

  // ⑤ 桌面一道极淡木纹（小几也要"是木头"）
  ctx.beginPath()
  ctx.ellipse(cx, baseY - legH, topW / 2 - 5, topH - 3, 0, 0, Math.PI * 2)
  ctx.strokeStyle = alpha(TOKENS.cWoodGrainB, 0.22)
  ctx.lineWidth = 1
  ctx.stroke()

  // ⑥ 桌腿底部接触暗线，把它"放"在地上
  ctx.beginPath()
  ctx.rect(cx - 6, baseY - 2, 12, 2.5)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.24)
  ctx.fill()
}

// ───────────────────────────────────────────────────────────────────────────
// 塔罗牌堆（M3 混合渲染 · 程序化骨架）
// ───────────────────────────────────────────────────────────────────────────

export const L4_DECK_ID = 'l4-deck'

/**
 * 注册牌堆渲染项。
 *
 * ★ 这是"程序化占位"：贴图未就绪时顶面画黄昏落日 + 奶油白月牙星点（落日山丘 × 玄学稿）；
 *   卡背贴图就绪后走 `drawDeckTop` 的 drawImage 分支，
 *   几何、接触影、叠牌厚度、命中判定**全部不动**。
 *
 * ★ 牌堆是"一叠牌"不是"一张牌"：底部要画出 2–3 层的厚度错位，才有"能翻"的体积感。
 */
export function registerDeck(stack: LayerStack): void {
  stack.add({
    id: L4_DECK_ID,
    band: BAND.PROPS,
    sortY: SORT.deck,
    z: 0,
    draw: (ctx, frame) => drawDeck(ctx, frame.t),
  })
}

/**
 * 卡背贴图（模块级可变状态，同 setTubeShake / setCoinDim 模式）。
 *
 * ★ 由 Scene.vue 在浏览器侧加载 `@assets/tarot/back.webp`（TexLoader 有界 LRU），
 *   就绪后喂进来；node 冒烟 / jsdom 测试里没人喂 → 保持 null → 程序化占位。
 *   降级契约：贴图缺失不是错误，是**正常路径之一**。
 */
let deckBackTex: TexSource | null = null

/** 喂入卡背贴图（null = 回落程序化占位）。供场景挂载层调用，别处禁用。 */
export function setDeckBackTex(src: TexSource | null): void {
  deckBackTex = src
}

/** 供测试 / 诊断断言当前是否走贴图路径 */
export function deckBackTexReady(): boolean {
  return deckBackTex !== null
}

/** 牌堆尺寸（供命中层 `setDeck` 对齐可点半径与绘制一致） */
export const DECK_METRICS = Object.freeze({
  w: DECK_PX.w,
  h: DECK_PX.h,
  cx: DECK_PX.cx,
  baseY: DECK_PX.baseY,
})

function drawDeck(ctx: CanvasRenderingContext2D, t: number): void {
  const { cx, baseY, w, h } = DECK_PX
  // 牌的圆角（玩具盒微缩感，圆角稍大）
  const radius = 6

  // ① 接触影：一叠牌压在茶几上，影子略大于牌面，向右下偏
  ctx.beginPath()
  ctx.ellipse(cx + 3, baseY + 3, w * 0.72, h * 0.30, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.22)
  ctx.fill()

  // ② 叠牌厚度：下面几张牌往右下错位，形成"一叠"的体积感
  const stackDepth = 3
  const deckGap = 3
  for (let i = stackDepth; i >= 1; i -= 1) {
    const ox = i * deckGap * 0.4
    const oy = i * deckGap * 0.6
    // 每层牌的侧边（厚度）—— 用深色描一圈下边缘
    ctx.beginPath()
    roundRectPath(ctx, cx + ox - w / 2, baseY + oy - h, w, h, radius)
    ctx.fillStyle = alpha(TOKENS.cInk, 0.12)
    ctx.fill()
  }

  // ③ 顶面：卡背（贴图就绪走 drawImage，否则程序化黄昏落日占位）
  const breathe = 0.94 + Math.sin(t / 2000) * 0.06
  drawDeckTop(ctx, cx, baseY - h, w, h, radius, breathe, t)
}

/**
 * 画卡背顶面。★ 贴图接入点：`deckBackTex` 就绪时走 `ctx.drawImage`（圆角裁剪），
 * 否则画程序化黄昏落日花纹（零贴图降级路径，两者视觉同稿）。
 *
 * ★ 视觉基调（落日山丘 × 玄学）：黄昏落日三段渐变底 + 奶油白月牙星点 + 远山剪影。
 *   余晖粉橘沉入黄昏紫，月牙用两段圆弧交错（咬合圆同渐变取色，零色差），
 *   底部两笔弧形山丘提供手绘线条感，避免任何复杂符号。
 */
export function drawDeckTop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  breathe: number,
  t: number,
): void {
  // ── 贴图路径：WebP 就绪 → 圆角裁剪 drawImage，几何/热区不受影响 ──
  if (deckBackTex !== null) {
    ctx.save()
    try {
      ctx.beginPath()
      roundRectPath(ctx, x, y, w, h, radius)
      ctx.clip()
      ctx.drawImage(deckBackTex as CanvasImageSource, x, y, w, h)
    } finally {
      ctx.restore()
    }
    return
  }

  // ── 程序化路径（零贴图降级，与贴图同稿）──
  // 卡背底：黄昏落日三段渐变（落日余晖粉橘 → 黄昏紫 → 背光深紫）
  // —— 落日之后的天空本来就是紫的，一张牌背同时承载「落日山丘」与「玄学星月」
  const g = ctx.createLinearGradient(x, y, x, y + h)
  g.addColorStop(0, mix(TOKENS.cDuskRose, '#ffffff', 0.1))
  g.addColorStop(0.42, TOKENS.cDuskRose)
  g.addColorStop(0.72, TOKENS.cDusk)
  g.addColorStop(1, TOKENS.cDuskDeep)
  ctx.beginPath()
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = g
  ctx.fill()

  // 底部远山剪影：两段交错的弧形山丘（落日山丘的"线条感"来源，极简两笔）
  const hy = y + h - h * 0.16
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, hy + 2)
  ctx.quadraticCurveTo(x + w * 0.3, hy - h * 0.1, x + w * 0.55, hy + 1)
  ctx.quadraticCurveTo(x + w * 0.8, hy + h * 0.06, x + w, hy - 2)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cDuskHill, 0.85 * breathe)
  ctx.fill()

  // 卡背内框：一圈奶油白细线（手绘描边的"线条感"，压住渐变不让它飘）
  ctx.beginPath()
  roundRectPath(ctx, x + 3, y + 3, w - 6, h - 6, radius - 2)
  ctx.strokeStyle = alpha(TOKENS.cCream, 0.72 * breathe)
  ctx.lineWidth = 1
  ctx.stroke()

  // 中央星月花纹：奶油白月牙 + 三颗星点（圆弧交错，不用复杂符号）
  const cx = x + w / 2
  const cy = y + h * 0.44

  // 月牙：两段圆弧交错 —— 一轮奶油白圆，再用**同一坐标系的渐变**圆"咬"掉一块。
  // ★ 咬合圆必须用与底色完全相同的渐变填充（渐变按画布坐标取色），
  //   这样咬口处颜色与底色逐像素一致，不会出现补丁色差。
  const bite = ctx.createLinearGradient(x, y, x, y + h)
  bite.addColorStop(0, mix(TOKENS.cDuskRose, '#ffffff', 0.1))
  bite.addColorStop(0.42, TOKENS.cDuskRose)
  bite.addColorStop(0.72, TOKENS.cDusk)
  bite.addColorStop(1, TOKENS.cDuskDeep)
  ctx.beginPath()
  ctx.arc(cx - 2, cy - 4, 8, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cCream, 0.94 * breathe)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx + 2, cy - 6, 7, 0, Math.PI * 2)
  ctx.fillStyle = bite
  ctx.fill()

  // 三颗星点（奶油白，相位错开，让牌面"活"一点但仍是极简）
  const stars = [
    { dx: -14, dy: -12, r: 1.6, ph: 0 },
    { dx: 14, dy: -10, r: 1.3, ph: 1.2 },
    { dx: -8, dy: 14, r: 1.4, ph: 2.4 },
  ]
  for (const s of stars) {
    const tw = 0.62 + 0.38 * Math.sin(t * 0.004 + s.ph)
    ctx.beginPath()
    ctx.arc(cx + s.dx, cy + s.dy, s.r, 0, Math.PI * 2)
    ctx.fillStyle = alpha(TOKENS.cCream, tw * breathe)
    ctx.fill()
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 单张牌面（M3 混合渲染 · 贴图位）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 牌面贴图表（key = cardsIndex 的牌 id）。
 *
 * ★ 与 `deckBackTex` 同一个模式，但这里有多张 —— 用 Map 而非单变量。
 *   由场景层在浏览器侧加载主包样张（`@services/tex/tarotPath` 的 URL），
 *   就绪后喂进来；node 冒烟 / jsdom 测试里没人喂 → 空表 → 走程序化占位。
 * ★ 未就绪**不是错误**，是降级路径之一：牌面照常画得出，只是没有花纹。
 */
const cardFaceTex = new Map<string, TexSource>()

/** 喂入某张牌的牌面贴图（null = 撤下该牌面，回落程序化占位）。供场景挂载层调用。 */
export function setCardFaceTex(id: string, src: TexSource | null): void {
  if (src === null || src === undefined) cardFaceTex.delete(id)
  else cardFaceTex.set(id, src)
}

/** 该牌面贴图是否已就绪（供测试 / 诊断断言走了贴图路径） */
export function cardFaceTexReady(id: string): boolean {
  return cardFaceTex.has(id)
}

/** 清空全部牌面贴图（测试复位用） */
export function clearCardFaceTex(): void {
  cardFaceTex.clear()
}

/**
 * 画一张牌面。★ 贴图就绪 → 圆角裁剪 drawImage；未就绪 → 程序化占位（奶油白卡 + 淡月牙）。
 *
 * ※ 目前场景里还没有"逐张摊开牌面"的渲染项，本函数先就位（连同贴图位），
 *   待牌阵摊牌视图接入时直接调用 —— 贴图管线不必等到那时才验证。
 */
export function drawCardFace(
  ctx: CanvasRenderingContext2D,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const tex = cardFaceTex.get(id)
  if (tex !== undefined) {
    ctx.save()
    try {
      ctx.beginPath()
      roundRectPath(ctx, x, y, w, h, radius)
      ctx.clip()
      ctx.drawImage(tex as CanvasImageSource, x, y, w, h)
    } finally {
      ctx.restore()
    }
    return
  }

  // ── 程序化占位（零贴图降级，与牌面同尺寸同圆角）──
  ctx.beginPath()
  roundRectPath(ctx, x, y, w, h, radius)
  ctx.fillStyle = TOKENS.cCream
  ctx.fill()

  ctx.beginPath()
  roundRectPath(ctx, x + 2, y + 2, Math.max(0, w - 4), Math.max(0, h - 4), Math.max(0, radius - 1))
  ctx.strokeStyle = alpha(TOKENS.cDuskRose, 0.5)
  ctx.lineWidth = 1
  ctx.stroke()

  // 中央一枚淡月牙（呼应卡背的玄学稿，但更轻）
  const cx = x + w / 2
  const cy = y + h * 0.42
  const r = Math.min(w, h) * 0.14
  ctx.beginPath()
  ctx.arc(cx - 1, cy - 2, r, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cDusk, 0.5)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx + 2, cy - 3, r * 0.86, 0, Math.PI * 2)
  ctx.fillStyle = TOKENS.cCream
  ctx.fill()
}

/** 圆角矩形路径（Canvas 没有内建 roundRect 时的手写实现，兼容旧运行时） */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

// ───────────────────────────────────────────────────────────────────────────
// 沙漏摆件（M3 第三步 · 程序化骨架，倒计时的可视化）
// ───────────────────────────────────────────────────────────────────────────

export const L4_TIMEPIECE_ID = 'l4-timepiece'

/**
 * 当前要画的沙漏位置（设计 px）。
 * ★ 沙漏是**动态**的：倒计时设定几个就画几个，位置 = 倒计时的 `at`（锚点）。
 *   所以这里不用固定坐标，而是模块级可变列表 —— 由场景层每帧喂进来
 *   （类似 `setCoinDim` / `setTubeShake` 的模式），渲染时遍历画沙漏。
 */
let timepieceAt: readonly Vec2[] = []

/** 场景层每帧写入沙漏位置（来自引擎的 countdownOrnaments） */
export function setTimepieces(at: readonly Vec2[]): void {
  timepieceAt = at
}

/** 当前沙漏数量（供测试读取） */
export function timepieceCount(): number {
  return timepieceAt.length
}

/**
 * 注册沙漏渲染项。
 *
 * ★ 沙漏是倒计时的"实物化身"，画在 STAGE 趟（有高度，按底座 y 排序）。
 *   ★ 沙流走**程序化粒子**（不是逐帧位图）—— 这是 OOM 红线的要求：
 *     逐帧位图一个沙漏就是几十张图，多个沙漏直接吃爆内存。
 */
export function registerTimepiece(stack: LayerStack): void {
  stack.add({
    id: L4_TIMEPIECE_ID,
    band: BAND.PROPS,
    sortY: 0,
    z: 0,
    draw: (ctx, frame) => drawTimepieces(ctx, frame.t),
  })
}

function drawTimepieces(ctx: CanvasRenderingContext2D, t: number): void {
  for (const at of timepieceAt) {
    drawHourglass(ctx, at.x, at.y, t)
  }
}

/**
 * 画一个沙漏，底座中心在 (x, y)。
 * 结构（自下而上）：落地影 → 木质上下盖 → 玻璃双球 → 中腰 → 程序化沙流。
 */
function drawHourglass(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const { w, h, waist } = HOURGLASS_PX
  const cx = x
  const baseY = y
  const topY = baseY - h

  // ① 落地接触影：竖长摆件，影子小
  ctx.beginPath()
  ctx.ellipse(cx + 2, baseY + 2, w * 0.6, w * 0.2, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.2)
  ctx.fill()

  // ② 木质上下盖（深木色，把玻璃"夹"住）
  const capH = 5
  ctx.fillStyle = mix(TOKENS.cWoodRight, TOKENS.cCharcoalWarm, 0.18)
  ctx.beginPath()
  ctx.rect(cx - w / 2, topY, w, capH)
  ctx.fill()
  ctx.beginPath()
  ctx.rect(cx - w / 2, baseY - capH, w, capH)
  ctx.fill()

  // ③ 玻璃双球（上球 + 下球，中间细腰）
  const ballTop = topY + capH
  const ballBottom = baseY - capH
  const midY = (ballTop + ballBottom) / 2

  // 上球（倒三角：从宽口收窄到腰）
  const upperPath = new Path2D()
  upperPath.moveTo(cx - w / 2, ballTop)
  upperPath.lineTo(cx + w / 2, ballTop)
  upperPath.lineTo(cx + waist / 2, midY)
  upperPath.lineTo(cx - waist / 2, midY)
  upperPath.closePath()

  // 下球（正三角：从腰张开到宽底）
  const lowerPath = new Path2D()
  lowerPath.moveTo(cx - waist / 2, midY)
  lowerPath.lineTo(cx + waist / 2, midY)
  lowerPath.lineTo(cx + w / 2, ballBottom)
  lowerPath.lineTo(cx - w / 2, ballBottom)
  lowerPath.closePath()

  // 玻璃填充：半透明暖色（不是纯透明，要有"装着沙"的质感）
  const glassFill = alpha(TOKENS.cWarmVeil, 0.35)
  ctx.fillStyle = glassFill
  ctx.fill(upperPath)
  ctx.fill(lowerPath)

  // 玻璃描边：一圈淡金边
  ctx.strokeStyle = alpha(TOKENS.cGold, 0.5)
  ctx.lineWidth = 1
  ctx.stroke(upperPath)
  ctx.stroke(lowerPath)

  // ④ 程序化沙流：下球底部的沙堆 + 中腰的一线细沙
  //   沙堆：下球底部的一个"沙坡"（上平下弧），用量随 t 缓慢呼吸
  const sandLevel = 0.55 + 0.08 * Math.sin(t / 1800)
  const sandTopY = ballBottom - (ballBottom - midY) * sandLevel
  ctx.beginPath()
  ctx.moveTo(cx - w / 2 + 3, ballBottom - 2)
  ctx.lineTo(cx + w / 2 - 3, ballBottom - 2)
  ctx.lineTo(cx + w / 2 - 6, sandTopY)
  ctx.lineTo(cx - w / 2 + 6, sandTopY)
  ctx.closePath()
  ctx.fillStyle = TOKENS.cAmberGlow
  ctx.fill()

  //   细沙线：中腰到沙堆顶的一线（沙正从上面漏下来）
  ctx.beginPath()
  ctx.moveTo(cx, midY)
  ctx.lineTo(cx, sandTopY + 2)
  ctx.strokeStyle = alpha(TOKENS.cAmberGlow, 0.7)
  ctx.lineWidth = 1.2
  ctx.stroke()

  // ⑤ 玻璃高光：左上一条亮弧，说明是"玻璃"不是"塑料"
  ctx.beginPath()
  ctx.arc(cx - w * 0.2, ballTop + (midY - ballTop) * 0.4, w * 0.5, Math.PI * 1.1, Math.PI * 1.6)
  ctx.strokeStyle = alpha('#ffffff', 0.5)
  ctx.lineWidth = 1.4
  ctx.stroke()
}

// ───────────────────────────────────────────────────────────────────────────
// 记忆锚点摆件（共创摆件链路 UI · 程序化画 8 件，零贴图）
// ───────────────────────────────────────────────────────────────────────────

export const L4_MEMORY_ID = 'l4-memory'

/**
 * 已放置摆件的渲染视图。
 * ★ 与命中层 HitCircle 的区别：hitTest 只需要 id+at，画法还需要 kind 才能选画法分支。
 *   命中层不传 kind 是因为 hitTest 永远对所有物件一视同仁（"点到了哪件"），而画法必须
 *   知道是"绿植还是石头"。所以这里单独定义视图，由 Scene.vue 从 engine.memoryAnchors
 *   投影过来（engine 持有 MemoryItem，含 kind）。
 */
export interface MemoryItemView {
  id: string
  kind: MemoryKind
  at: Vec2
}

/** 已放置摆件（由 Scene.vue 每帧从 engine.memoryAnchors 同步进来） */
let memoryItems: readonly MemoryItemView[] = []

/** 手指上待放置的摆件（拖拽中）。★ 由 Scene.vue 在 MEMORY_PLACE 态接管 pointer 时写入 */
let pendingMemory: { kind: MemoryKind; at: Vec2 } | null = null

/** 场景层每帧写入已放置摆件（来自 engine.memoryAnchors） */
export function setMemoryItems(items: readonly MemoryItemView[]): void {
  memoryItems = items
}

/** 场景层每帧/每次手势事件时写入"手指上的摆件"。null = 没在拖 */
export function setPendingMemory(p: { kind: MemoryKind; at: Vec2 } | null): void {
  pendingMemory = p
}

/** 供测试 / 诊断断言当前已渲染的摆件数 */
export function memoryItemCount(): number {
  return memoryItems.length
}

/**
 * 注册摆件渲染项。
 *
 * ★ 摆件是 STAGE 物件（有高度，落在锚点上），与竹筒/铜钱/沙漏同趟。
 *   sortY 不固定（取决于摆件落在哪），用 at.y 作 sortY 让影子排序自动决定前后关系 ——
 *   与铜钱一致（铜钱也是动态位置，sortY = 落点 y）。
 */
export function registerMemoryItem(stack: LayerStack): void {
  stack.add({
    id: L4_MEMORY_ID,
    band: BAND.PROPS,
    sortY: 0,
    z: 0,
    draw: (ctx, frame) => drawMemoryItems(ctx, frame.t),
  })
}

function drawMemoryItems(ctx: CanvasRenderingContext2D, t: number): void {
  // ① 已放置摆件：按 at.y 排序（影子排序），逐件画
  const sorted = [...memoryItems].sort((a, b) => a.at.y - b.at.y)
  for (const it of sorted) {
    drawMemoryItem(ctx, it.kind, it.at, t, 1)
  }
  // ② 手指上的待放置摆件：半透明 + 呼吸高亮，提示"松手就放这儿"
  if (pendingMemory) {
    ctx.save()
    const breathe = 0.7 + 0.3 * Math.sin(t / 300)
    ctx.globalAlpha = breathe
    drawMemoryItem(ctx, pendingMemory.kind, pendingMemory.at, t, breathe)
    ctx.restore()
  }
}

/**
 * 画一件摆件。
 *
 * ★ 8 件全部用 Canvas 原生 API，零贴图 —— 与竹筒/铜钱/沙漏的风格一致，
 *   保证门禁⑭（双路径渲染冒烟：直画 ≡ 离屏缓存逐像素一致）能过。
 * ★ 尺寸约 14×18pt（小东西，比竹筒小、比铜钱大），每件都带轻接触影。
 * ★ 颜色一律从 TOKENS 取，禁 Math.random；呼吸相位用 t / 1600（与铜钱同步）。
 *
 * 8 件按 kind 分支画法：
 *   plant / stone / lantern / shell / bell / candle / seed / ticket
 */
function drawMemoryItem(
  ctx: CanvasRenderingContext2D,
  kind: MemoryKind,
  at: Vec2,
  t: number,
  alphaVal = 1,
): void {
  ctx.save()
  ctx.globalAlpha = alphaVal
  const cx = at.x
  const cy = at.y

  // ① 接触影（所有摆件共用）—— 比"脚下"略偏右下，柔椭圆
  ctx.beginPath()
  ctx.ellipse(cx + 1, cy + 5, 9, 3, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.22)
  ctx.fill()

  switch (kind) {
    case 'plant':
      drawPlant(ctx, cx, cy, t)
      break
    case 'stone':
      drawStone(ctx, cx, cy, t)
      break
    case 'lantern':
      drawLantern(ctx, cx, cy, t)
      break
    case 'shell':
      drawShell(ctx, cx, cy, t)
      break
    case 'bell':
      drawBell(ctx, cx, cy, t)
      break
    case 'candle':
      drawCandle(ctx, cx, cy, t)
      break
    case 'seed':
      drawSeed(ctx, cx, cy, t)
      break
    case 'ticket':
      drawTicket(ctx, cx, cy, t)
      break
  }
  ctx.restore()
}

// ── 绿植 ────────────────────────────────────────────────────────────────────
function drawPlant(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
  // 小陶盆 + 两片叶子
  // 盆身：梯形（上宽下窄），暖陶土色
  const w = 10
  const topY = cy - 2
  const botY = cy + 6
  ctx.beginPath()
  ctx.moveTo(cx - w / 2, topY)
  ctx.lineTo(cx + w / 2, topY)
  ctx.lineTo(cx + w / 2 - 1, botY)
  ctx.lineTo(cx - w / 2 + 1, botY)
  ctx.closePath()
  const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
  g.addColorStop(0, mix(TOKENS.cWoodLeft, '#ffffff', 0.08))
  g.addColorStop(1, mix(TOKENS.cWoodRight, TOKENS.cContactShadow, 0.2))
  ctx.fillStyle = g
  ctx.fill()

  // 盆口（一道暗线）
  ctx.beginPath()
  ctx.ellipse(cx, topY, w / 2, 1.6, 0, 0, Math.PI * 2)
  ctx.fillStyle = mix(TOKENS.cCharcoalWarm, TOKENS.cWoodLeft, 0.4)
  ctx.fill()

  // 两片叶子（左右各一片，从盆里探出）—— 暖绿，左受光
  const sway = Math.sin(t / 1600) * 0.6
  ctx.strokeStyle = mix(TOKENS.cMatcha, '#ffffff', 0.18)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  // 左叶
  ctx.beginPath()
  ctx.moveTo(cx - 2, topY)
  ctx.quadraticCurveTo(cx - 7, topY - 5, cx - 8 + sway, topY - 9)
  ctx.stroke()
  // 右叶
  ctx.beginPath()
  ctx.moveTo(cx + 2, topY)
  ctx.quadraticCurveTo(cx + 7, topY - 5, cx + 8 - sway, topY - 9)
  ctx.stroke()
  // 叶子高光
  ctx.strokeStyle = alpha('#ffffff', 0.32)
  ctx.lineWidth = 0.8
  ctx.beginPath()
  ctx.moveTo(cx - 4, topY - 3)
  ctx.lineTo(cx - 7 + sway, topY - 7)
  ctx.stroke()
}

// ── 鹅卵石 ──────────────────────────────────────────────────────────────────
function drawStone(ctx: CanvasRenderingContext2D, cx: number, cy: number, _t: number): void {
  // 一块椭圆石头，灰青色，左上受光
  const rx = 7
  const ry = 4
  const g = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry)
  g.addColorStop(0, mix(TOKENS.cCharcoalWarm, '#ffffff', 0.18))
  g.addColorStop(0.5, TOKENS.cCharcoalWarm)
  g.addColorStop(1, mix(TOKENS.cCharcoalWarm, TOKENS.cContactShadow, 0.3))
  ctx.beginPath()
  ctx.ellipse(cx, cy + 1, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()
  // 顶面高光弧
  ctx.beginPath()
  ctx.ellipse(cx, cy + 1, rx - 1.5, ry - 1, 0, Math.PI * 1.05, Math.PI * 1.85)
  ctx.strokeStyle = alpha('#ffffff', 0.42)
  ctx.lineWidth = 1.2
  ctx.stroke()
  // 一道纹理（石头上的纹路，让它不只是个椭圆）
  ctx.beginPath()
  ctx.ellipse(cx - 2, cy + 1, 3, 1.5, 0.3, 0, Math.PI * 2)
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.4)
  ctx.lineWidth = 0.7
  ctx.stroke()
}

// ── 小灯 ────────────────────────────────────────────────────────────────────
function drawLantern(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
  // 框架 + 半透明灯罩 + 暖光呼吸
  const w = 8
  const h = 12
  const topY = cy - 8
  const botY = topY + h

  // 灯罩：半透暖色玻璃
  const breathe = 0.7 + 0.3 * Math.sin(t / 1600)
  ctx.beginPath()
  ctx.rect(cx - w / 2, topY, w, h)
  ctx.fillStyle = alpha(TOKENS.cWarmVeil, 0.4 * breathe)
  ctx.fill()

  // 罩内暖光（核心，呼吸）
  ctx.beginPath()
  ctx.ellipse(cx, topY + h / 2, w / 3, h / 3, 0, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cAmberGlow, 0.7 * breathe)
  ctx.fill()

  // 顶帽 + 底座（深木色，把罩"夹"住）
  ctx.fillStyle = mix(TOKENS.cWoodRight, TOKENS.cCharcoalWarm, 0.18)
  ctx.beginPath()
  ctx.rect(cx - w / 2 - 1, topY - 2, w + 2, 2.5)
  ctx.fill()
  ctx.beginPath()
  ctx.rect(cx - w / 2 - 1, botY, w + 2, 2)
  ctx.fill()

  // 顶环（挂绳点）
  ctx.beginPath()
  ctx.arc(cx, topY - 3, 1.2, 0, Math.PI * 2)
  ctx.fillStyle = TOKENS.cGold
  ctx.fill()

  // 罩外框（极淡金边）
  ctx.beginPath()
  ctx.rect(cx - w / 2, topY, w, h)
  ctx.strokeStyle = alpha(TOKENS.cGold, 0.4)
  ctx.lineWidth = 0.8
  ctx.stroke()
}

// ── 贝壳 ────────────────────────────────────────────────────────────────────
function drawShell(ctx: CanvasRenderingContext2D, cx: number, cy: number, _t: number): void {
  // 螺旋弧 + 几道放射纹
  const rx = 7
  const ry = 6
  // 底色：奶白渐变
  const g = ctx.createRadialGradient(cx - 2, cy - 1, 1, cx, cy, rx)
  g.addColorStop(0, alpha(TOKENS.cCream, 1))
  g.addColorStop(1, mix(TOKENS.cCream, TOKENS.cDuskRose, 0.3))
  ctx.beginPath()
  ctx.ellipse(cx, cy + 1, rx, ry, 0, Math.PI, Math.PI * 2)
  ctx.lineTo(cx, cy + 1)
  ctx.closePath()
  ctx.fillStyle = g
  ctx.fill()

  // 放射纹（5 条弧线从底心散出）
  ctx.strokeStyle = alpha(TOKENS.cDuskRose, 0.5)
  ctx.lineWidth = 0.7
  for (let i = -2; i <= 2; i += 1) {
    const angle = Math.PI + (i / 2) * 0.7
    const ex = cx + Math.cos(angle) * rx * 0.85
    const ey = cy + 1 + Math.sin(angle) * ry * 0.85
    ctx.beginPath()
    ctx.moveTo(cx, cy + 1)
    ctx.quadraticCurveTo((cx + ex) / 2, cy - 1, ex, ey)
    ctx.stroke()
  }

  // 顶口（一道暗弧，让它"开口")
  ctx.beginPath()
  ctx.moveTo(cx - rx, cy + 1)
  ctx.quadraticCurveTo(cx, cy + 4, cx + rx, cy + 1)
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.5)
  ctx.lineWidth = 1
  ctx.stroke()
}

// ── 铜铃 ────────────────────────────────────────────────────────────────────
function drawBell(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
  // 钟形（梯形上窄下宽）+ 顶环 + 一道高光
  const w = 9
  const topY = cy - 7
  const botY = cy + 4

  // 钟身
  const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
  g.addColorStop(0, mix(TOKENS.cGold, '#ffffff', 0.22))
  g.addColorStop(0.5, TOKENS.cGold)
  g.addColorStop(1, mix(TOKENS.cGold, TOKENS.cContactShadow, 0.3))
  ctx.beginPath()
  ctx.moveTo(cx - w / 4, topY)
  ctx.lineTo(cx + w / 4, topY)
  ctx.lineTo(cx + w / 2, botY)
  ctx.lineTo(cx - w / 2, botY)
  ctx.closePath()
  ctx.fillStyle = g
  ctx.fill()

  // 底沿（暗线）
  ctx.beginPath()
  ctx.rect(cx - w / 2 - 0.5, botY, w + 1, 1.5)
  ctx.fillStyle = mix(TOKENS.cCharcoalWarm, TOKENS.cGold, 0.3)
  ctx.fill()

  // 顶环（挂绳点）
  ctx.beginPath()
  ctx.arc(cx, topY - 2, 1.5, 0, Math.PI * 2)
  ctx.strokeStyle = TOKENS.cGold
  ctx.lineWidth = 0.9
  ctx.stroke()

  // 高光弧（左上）
  ctx.beginPath()
  ctx.moveTo(cx - w / 4 + 1, topY + 1)
  ctx.lineTo(cx - w / 2 + 1.5, botY - 1)
  ctx.strokeStyle = alpha('#ffffff', 0.5)
  ctx.lineWidth = 1.1
  ctx.stroke()

  // 铃舌（极小一颗，呼吸）
  const sway = Math.sin(t / 1200) * 0.4
  ctx.beginPath()
  ctx.arc(cx + sway, botY + 2, 1, 0, Math.PI * 2)
  ctx.fillStyle = mix(TOKENS.cCharcoalWarm, TOKENS.cGold, 0.5)
  ctx.fill()
}

// ── 蜡烛 ────────────────────────────────────────────────────────────────────
function drawCandle(ctx: CanvasRenderingContext2D, cx: number, cy: number, t: number): void {
  // 烛身（暖白）+ 火苗（呼吸 + 暖光晕）
  const w = 4
  const h = 9
  const topY = cy - 6

  // 烛身
  const g = ctx.createLinearGradient(cx - w / 2, 0, cx + w / 2, 0)
  g.addColorStop(0, mix(TOKENS.cCream, '#ffffff', 0.18))
  g.addColorStop(0.5, TOKENS.cCream)
  g.addColorStop(1, mix(TOKENS.cCream, TOKENS.cContactShadow, 0.25))
  ctx.beginPath()
  ctx.rect(cx - w / 2, topY, w, h)
  ctx.fillStyle = g
  ctx.fill()

  // 顶面椭圆（"蜡烛顶"）
  ctx.beginPath()
  ctx.ellipse(cx, topY, w / 2, 1, 0, 0, Math.PI * 2)
  ctx.fillStyle = mix(TOKENS.cCream, TOKENS.cContactShadow, 0.2)
  ctx.fill()

  // 烛芯（一根细线）
  ctx.beginPath()
  ctx.moveTo(cx, topY)
  ctx.lineTo(cx, topY - 2)
  ctx.strokeStyle = TOKENS.cCharcoalWarm
  ctx.lineWidth = 0.6
  ctx.stroke()

  // 火苗（暖橙，呼吸 + 微抖）
  const flick = 0.85 + 0.15 * Math.sin(t / 200)
  const fy = topY - 3 - flick
  ctx.beginPath()
  ctx.moveTo(cx, fy)
  ctx.quadraticCurveTo(cx - 1.5, fy + 1.5, cx, fy + 3)
  ctx.quadraticCurveTo(cx + 1.5, fy + 1.5, cx, fy)
  ctx.fillStyle = alpha(TOKENS.cAmberGlow, flick)
  ctx.fill()

  // 暖光晕（火苗周围的发光圆）
  ctx.beginPath()
  ctx.arc(cx, fy + 1, 4, 0, Math.PI * 2)
  ctx.fillStyle = alpha(TOKENS.cAmberGlow, 0.2 * flick)
  ctx.fill()
}

// ── 一粒种子 ─────────────────────────────────────────────────────────────────
function drawSeed(ctx: CanvasRenderingContext2D, cx: number, cy: number, _t: number): void {
  // 椭圆 + 一道亮线（"发芽线"，让它不只是椭圆）
  const rx = 4
  const ry = 6
  const g = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry)
  g.addColorStop(0, mix(TOKENS.cWoodTop, '#ffffff', 0.18))
  g.addColorStop(0.5, TOKENS.cWoodTop)
  g.addColorStop(1, mix(TOKENS.cWoodRight, TOKENS.cContactShadow, 0.3))
  ctx.beginPath()
  ctx.ellipse(cx, cy + 1, rx, ry, 0.2, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // 一道高光线（沿着长轴）
  ctx.beginPath()
  ctx.moveTo(cx - 1, cy - ry + 2)
  ctx.quadraticCurveTo(cx - 2, cy + 1, cx - 0.5, cy + ry - 2)
  ctx.strokeStyle = alpha('#ffffff', 0.45)
  ctx.lineWidth = 0.8
  ctx.stroke()
}

// ── 褪色的船票 ──────────────────────────────────────────────────────────────
function drawTicket(ctx: CanvasRenderingContext2D, cx: number, cy: number, _t: number): void {
  // 长方形 + 一道折痕 + 暗角（"褪色"感）
  const w = 14
  const h = 6
  const topY = cy - 3
  const leftX = cx - w / 2

  // 票面（褪色黄）
  const g = ctx.createLinearGradient(0, topY, 0, topY + h)
  g.addColorStop(0, mix(TOKENS.cCream, TOKENS.cDuskRose, 0.2))
  g.addColorStop(1, mix(TOKENS.cCream, TOKENS.cContactShadow, 0.25))
  ctx.beginPath()
  ctx.rect(leftX, topY, w, h)
  ctx.fillStyle = g
  ctx.fill()

  // 折痕（中线，"对折过的痕迹"）
  ctx.beginPath()
  ctx.moveTo(cx, topY + 0.5)
  ctx.lineTo(cx, topY + h - 0.5)
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.35)
  ctx.lineWidth = 0.6
  ctx.stroke()

  // 两端的票根虚线（半圆缺口示意）
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.4)
  ctx.setLineDash([1.2, 1.2])
  ctx.beginPath()
  ctx.moveTo(leftX, topY + 1)
  ctx.lineTo(leftX, topY + h - 1)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(leftX + w, topY + 1)
  ctx.lineTo(leftX + w, topY + h - 1)
  ctx.stroke()
  ctx.setLineDash([])

  // 暗角（"褪色"的边缘发暗）
  ctx.beginPath()
  ctx.rect(leftX, topY, w, h)
  ctx.strokeStyle = alpha(TOKENS.cContactShadow, 0.3)
  ctx.lineWidth = 0.5
  ctx.stroke()
}
