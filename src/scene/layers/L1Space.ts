/**
 * 小卜 · L1 空间   src/scene/layers/L1Space.ts
 * ===========================================================================
 * 墙 / 暖窗 / 壁灯 / 地板。
 *
 * ★ 这一层定义了整个房间的**唯一光源**：窗户。后面所有东西的受光方向、
 *   暖光池、接触影的朝向，都从"光从窗户来"推导。光源一旦不统一，
 *   微缩模型立刻散架成拼贴画 —— 这是动森感最容易被破坏的地方。
 *
 * ★ 静态层（static: true）：整层烘焙进离屏缓存，每帧只 blit 一次。
 *   墙面渐变 + 窗 + 灯 + 地板缝，每帧重画一次是纯浪费，这里省下的是帧预算的大头。
 * ===========================================================================
 */

import {
  BAND,
  DESIGN_H,
  DESIGN_W,
  TOKENS,
  alpha,
  mix,
  quadCenter,
  quadOf,
  quadPath,
  type LayerStack,
} from '@scene/renderer'
import {
  FLOOR_SHEEN_UNITS,
  FLOOR_Z,
  LAMP_PX,
  WALL_BASE_Y,
  WINDOW_PX,
  WINDOW_SPLIT,
} from './worldLayout'

export const L1_ID = 'l1-space'

/** 注册到渲染栈（BACKDROP 趟，band 顺序固定） */
export function registerL1(stack: LayerStack): void {
  stack.add({
    id: L1_ID,
    band: BAND.SPACE,
    // BACKDROP 趟按 band 排序，sortY 不参与决策；给 0 只为满足类型
    sortY: 0,
    static: true,
    draw: drawL1,
  })
}

function drawL1(ctx: CanvasRenderingContext2D): void {
  drawWall(ctx)
  drawFloor(ctx)
  drawWindowGlow(ctx)
  drawWindow(ctx)
  drawLamp(ctx)
}

// ── 墙 ─────────────────────────────────────────────────────────────────────

function drawWall(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, WALL_BASE_Y)
  g.addColorStop(0, mix(TOKENS.cWall, TOKENS.cCream, 0.35)) // 上方更亮（靠近窗光）
  g.addColorStop(0.68, TOKENS.cWall)
  g.addColorStop(1, TOKENS.cWallDeep)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, DESIGN_W, WALL_BASE_Y)

  // 踢脚线：让"墙在哪结束、地从哪开始"有清楚的交代，而不是一条硬切边
  ctx.fillStyle = TOKENS.cBaseboard
  ctx.fillRect(0, WALL_BASE_Y - 9, DESIGN_W, 9)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.16)
  ctx.fillRect(0, WALL_BASE_Y, DESIGN_W, 1.5)
}

// ── 地板 ───────────────────────────────────────────────────────────────────

function drawFloor(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, WALL_BASE_Y, 0, WALL_BASE_Y + 300)
  g.addColorStop(0, TOKENS.cFloorDeep) // 远处（靠墙）稍暗
  g.addColorStop(0.45, TOKENS.cFloor)
  g.addColorStop(1, mix(TOKENS.cFloor, TOKENS.cWarmVeil, 0.18)) // 近处被暖光带一点
  ctx.fillStyle = g
  ctx.fillRect(0, WALL_BASE_Y, DESIGN_W, DESIGN_H - WALL_BASE_Y)

  // ★ 等距光毯：以世界原点为中心的一片极淡菱形亮。
  //   它是"地板是一个平面"的视觉依据 —— 只靠横向渐变，地板会读成一条色带。
  //   用 project() 算而不是写死坐标：美术改稿后它会跟着重新校准。
  const sh = quadOf(0, 0, FLOOR_SHEEN_UNITS, FLOOR_SHEEN_UNITS, FLOOR_Z)
  const sg = ctx.createRadialGradient(sh.top.x, quadCenter(sh).y, 20, sh.top.x, quadCenter(sh).y, 250)
  sg.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.2))
  sg.addColorStop(0.6, alpha(TOKENS.cWarmVeil, 0.07))
  sg.addColorStop(1, alpha(TOKENS.cWarmVeil, 0))
  quadPath(ctx, sh)
  ctx.fillStyle = sg
  ctx.fill()

  // 地板缝：两条横向的淡线，用极低的对比度 —— 只为"有地板"这个信息，不抢戏。
  // ★ 位置必须**相对 WALL_BASE_Y**，不能写死 356 / 412：墙脚线一动，
  //   写死的线就会跑到墙上去（曾经就是这样，出图才发现）。
  ctx.fillStyle = alpha(TOKENS.cFloorSeam, 0.42)
  ctx.fillRect(0, WALL_BASE_Y + 108, DESIGN_W, 1.2)
  ctx.fillStyle = alpha(TOKENS.cFloorSeam, 0.3)
  ctx.fillRect(0, WALL_BASE_Y + 164, DESIGN_W, 1.2)
}

// ── 窗 ─────────────────────────────────────────────────────────────────────

/** 窗口外溢的暖光。它同时解释了"为什么桌面左上角亮"。 */
function drawWindowGlow(ctx: CanvasRenderingContext2D): void {
  const cx = WINDOW_PX.x + WINDOW_PX.w / 2
  const cy = WINDOW_PX.y + WINDOW_PX.h / 2
  const r = WINDOW_PX.w * 1.55

  const g = ctx.createRadialGradient(cx, cy, WINDOW_PX.w * 0.22, cx, cy, r)
  g.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.5))
  g.addColorStop(0.45, alpha(TOKENS.cWarmVeil, 0.2))
  g.addColorStop(1, alpha(TOKENS.cWarmVeil, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  // 地板上的一小片窗光 —— 把光源和地面连起来，空间才"通"
  const pg = ctx.createLinearGradient(cx, WALL_BASE_Y, cx + 60, WALL_BASE_Y + 120)
  pg.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.3))
  pg.addColorStop(1, alpha(TOKENS.cWarmVeil, 0))
  ctx.fillStyle = pg
  ctx.beginPath()
  ctx.moveTo(WINDOW_PX.x + 8, WALL_BASE_Y)
  ctx.lineTo(WINDOW_PX.x + WINDOW_PX.w - 8, WALL_BASE_Y)
  ctx.lineTo(WINDOW_PX.x + WINDOW_PX.w + 54, WALL_BASE_Y + 128)
  ctx.lineTo(WINDOW_PX.x - 18, WALL_BASE_Y + 128)
  ctx.closePath()
  ctx.fill()
}

function drawWindow(ctx: CanvasRenderingContext2D): void {
  const { x, y, w, h } = WINDOW_PX
  const f = 8 // 窗框厚度

  // 外框（比内框厚一圈，做出"嵌进墙里"的厚度）
  roundRect(ctx, x - f, y - f, w + f * 2, h + f * 2, 6)
  ctx.fillStyle = TOKENS.cWindowFrame
  ctx.fill()

  // 玻璃：上段黄昏天（桃色沉入黄昏紫），下段落日带 —— 分界处不留缝，让光"往下沉"
  const splitY = y + h * WINDOW_SPLIT
  const g = ctx.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, mix(TOKENS.cDusk, '#ffffff', 0.42)) // 窗顶透一点黄昏紫（落日后天空本来就是紫的）
  g.addColorStop(0.3, mix(TOKENS.cDusk, TOKENS.cWindowSky, 0.55))
  g.addColorStop(WINDOW_SPLIT - 0.02, TOKENS.cWindowSky)
  g.addColorStop(WINDOW_SPLIT + 0.02, TOKENS.cWindowSun)
  g.addColorStop(1, mix(TOKENS.cWindowSun, TOKENS.cLamp, 0.35))
  ctx.fillStyle = g
  ctx.fillRect(x, y, w, h)

  // 太阳：落日带里一个极淡的圆，是"黄昏"最直接的一笔
  const sunG = ctx.createRadialGradient(x + w * 0.62, splitY + h * 0.14, 1, x + w * 0.62, splitY + h * 0.14, 34)
  sunG.addColorStop(0, alpha('#ffffff', 0.55))
  sunG.addColorStop(1, alpha('#ffffff', 0))
  ctx.fillStyle = sunG
  ctx.fillRect(x, y + h * 0.5, w, h * 0.5)

  // ★ 落日山丘：窗外两笔弧形远山剪影（与牌背远山同源同色，手绘线条感的落点）。
  //   先 clip 到玻璃矩形内，山只出现在窗里 —— 窗即画框。
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  const hillBase = y + h * 0.9
  // 远山（更淡、更高）
  ctx.beginPath()
  ctx.moveTo(x, hillBase)
  ctx.quadraticCurveTo(x + w * 0.28, y + h * 0.68, x + w * 0.52, hillBase - 2)
  ctx.quadraticCurveTo(x + w * 0.78, y + h * 0.78, x + w, y + h * 0.72)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cDusk, 0.4)
  ctx.fill()
  // 近山（更深、更低，压住远山脚）
  ctx.beginPath()
  ctx.moveTo(x, y + h)
  ctx.lineTo(x, y + h * 0.86)
  ctx.quadraticCurveTo(x + w * 0.4, y + h * 0.76, x + w * 0.7, y + h * 0.88)
  ctx.quadraticCurveTo(x + w * 0.88, y + h * 0.93, x + w, y + h * 0.9)
  ctx.lineTo(x + w, y + h)
  ctx.closePath()
  ctx.fillStyle = alpha(TOKENS.cDuskHill, 0.55)
  ctx.fill()
  ctx.restore()

  // 窗棂：一竖一横。定宽矩形 —— 线不能靠 stroke（细描边在缩放后会糊）
  ctx.fillStyle = TOKENS.cWindowFrame
  ctx.fillRect(x + w / 2 - 3, y, 6, h)
  ctx.fillRect(x, splitY - 3, w, 6)

  // 窗台
  ctx.fillStyle = TOKENS.cWindowSill
  ctx.fillRect(x - f - 4, y + h + f, w + f * 2 + 8, 7)
  ctx.fillStyle = alpha(TOKENS.cContactShadow, 0.14)
  ctx.fillRect(x - f - 4, y + h + f + 7, w + f * 2 + 8, 2)
}

// ── 壁灯 ───────────────────────────────────────────────────────────────────

function drawLamp(ctx: CanvasRenderingContext2D): void {
  const { x, y, r } = LAMP_PX

  // 灯罩外溢的暖光（右侧不致死黑的原因）
  const g = ctx.createRadialGradient(x, y + 10, 2, x, y + 10, r * 4.2)
  g.addColorStop(0, alpha(TOKENS.cWarmVeil, 0.42))
  g.addColorStop(1, alpha(TOKENS.cWarmVeil, 0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y + 10, r * 4.2, 0, Math.PI * 2)
  ctx.fill()

  // 支架
  ctx.fillStyle = alpha(TOKENS.cLamp, 0.85)
  ctx.fillRect(x - 1.5, y - 22, 3, 22)

  // 灯罩：一个倒梯形
  ctx.beginPath()
  ctx.moveTo(x - r, y + 6)
  ctx.lineTo(x + r, y + 6)
  ctx.lineTo(x + r * 0.52, y - 8)
  ctx.lineTo(x - r * 0.52, y - 8)
  ctx.closePath()
  const sg = ctx.createLinearGradient(x - r, 0, x + r, 0)
  sg.addColorStop(0, mix(TOKENS.cLamp, '#ffffff', 0.25))
  sg.addColorStop(1, mix(TOKENS.cLamp, TOKENS.cContactShadow, 0.3))
  ctx.fillStyle = sg
  ctx.fill()

  // 灯口的一点亮
  ctx.fillStyle = alpha(TOKENS.cWindowSky, 0.9)
  roundRect(ctx, x - r * 0.5, y + 3, r, 3.5, 2)
  ctx.fill()
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 圆角矩形路径。Canvas 的 roundRect 在旧 WebView 上缺失，这里自备一份。 */
export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

/** 圆角矩形，但只有上两个角是圆的（竹筒口、花盆口用） */
export function roundRectTop(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}
