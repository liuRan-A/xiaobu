/**
 * 小卜 · 飞行求解器   src/core/ritual/flight.ts
 * ===========================================================================
 * 掷币的轨迹、命中、弹跳 —— **全部是解析式的纯函数**。
 *
 * 规范原文（交互动效 Brief §3③）：
 *   「**严禁引入物理引擎**（Box2D / Matter.js / Rapier 均禁止）。本产品只需要
 *    "一条看起来对的抛物线 + 一次弹跳"，一个 20 行的公式就够；引入引擎会带来
 *    包体、GC 抖动与低端机 OOM 三重代价。」
 *
 * 所以这里没有积分、没有刚体、没有碰撞器。只有：
 *
 *     p(t) = p₀ + v₀·dir·t + ½·g·t²        g = 2600 pt/s²，方向 (0, +1)
 *     v₀   = clamp(6.2·|Δs| + 0.85·|v_release|, 420, 1500) pt/s
 *     弹跳 = 高度 × 0.35，只弹一次，180ms
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 本文件最核心的一个设计决定：形状交给物理，时长交给人手
 * ───────────────────────────────────────────────────────────────────────────
 * 纯物理算出来的飞行时间是不可控的：
 *   · 最小力度竖直掷出 → 落到盘面只要 ~360ms（像被烫了一下，毛躁）
 *   · 大力横甩         → ~884ms（刚好，但纯属巧合）
 *   · 而"落点在哪"又完全由物理决定（抛物线必须真的穿过卦盘椭圆）
 *
 * 如果只用物理时间，手感就会随力度抖动；如果只用固定时长，弧线就会和落点脱节
 * （"看着落在盘上，判定说没中"）。
 *
 * 所以拆成两条时间轴：
 *   · `physicsMs` —— 抛物线上从出手到落点/回高度的那一段。**决定落点在哪**
 *   · `durationMs` = clamp(physicsMs, 550, 900) —— 动画真正播多久
 *   · 取点走**归一化进度** `at(u)`：u=0 是出手，u=1 是落定。
 *     内部把 u 线性映射回物理时间，于是**弧线形状 100% 保持**，只是整体快慢变了。
 *
 * 这就是规范 §3③ 那句「T ∈ [550,900]ms 由手势速度决定」的准确含义 ——
 * 它约束的是**时长**，不是轨迹。而"由手势速度决定"通过 physicsMs 天然成立。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 命中判定为什么是椭圆而不是矩形
 * ───────────────────────────────────────────────────────────────────────────
 * 卦盘在等距投影下是一个**扁椭圆**（2:1）。用外接矩形判定的话，四个角上
 * 明明落在桌面上的位置会被误判为"落盘了"，用户会觉得"它明明没掉进盘里"。
 * 规范 §10 验收清单里专门有一条：「卦盘命中判定是椭圆，不是矩形（四角应判为未命中）」。
 *
 * 求交用**数值求根**（粗扫 + 二分）而不是解析四次方程：抛物线与一般椭圆联立是
 * 四次方程，虽有 Ferrari 解法但数值脆弱、代码难读。而隐函数 f(t) 在本问题的
 * 取值区间上单调性良好，粗扫 4ms + 二分 24 次能稳定收敛到 1e-4ms，且完全不引入依赖。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 可测性
 * ───────────────────────────────────────────────────────────────────────────
 * 零依赖（不碰 DOM / Vue / Canvas），`rand` 由调用方注入 ⇒
 * tests/flight.spec.ts 能在 node 里对规范 §8.3 的每条用例做**确定性**断言。
 * ===========================================================================
 */

import {
  BOUNCE_DECAY,
  BOUNCE_MS,
  FLIGHT_MS_MAX,
  FLIGHT_MS_MIN,
  TH,
} from './thresholds'

export interface Pt {
  x: number
  y: number
}

/** 椭圆（屏幕空间）。卦盘的命中区、涟漪的形状都用它。 */
export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/** 画布边界。默认值与 renderer 的 DESIGN_W/H 一致；scene 调用时显式传入，避免两处各写一份。 */
export interface Bounds {
  w: number
  h: number
}

const DEFAULT_BOUNDS: Bounds = { w: 390, h: 844 }

/** 落点钳制时预留的边距（pt）—— 让铜钱不会半个身子出屏 */
const EDGE_MARGIN = 12

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v

export const hypot = (p: Pt): number => Math.sqrt(p.x * p.x + p.y * p.y)

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * 方向向量与垂线的夹角（度）。0 = 正上方。
 * 用于「快甩」手势判定：与垂线夹角 > RELEASE_ANGLE_MAX(40°) 的横向甩动不算"掷"，
 * 避免用户横着划一下就把币丢出去。
 */
export function angleFromVerticalDeg(dir: Pt): number {
  const m = hypot(dir)
  if (m < 1e-9) return 0
  // 屏幕坐标 y 向下，所以"上"是 (0,-1)。
  const c = clamp(-dir.y / m, -1, 1)
  return (Math.acos(c) * 180) / Math.PI
}

// ───────────────────────────────────────────────────────────────────────────
// 命中判定
// ───────────────────────────────────────────────────────────────────────────

/**
 * 点是否落在椭圆内。
 * ★ 用 `<= 1`：**恰在边界上算命中**（规范 §8.3 用例 3）。
 */
export function hitsBoard(p: Pt, e: Ellipse): boolean {
  return ellipseF(p, e) <= 0
}

/** 隐函数 f(t) = 椭圆方程左边 − 1。< 0 即在椭圆内。数值求根与命中判定共用它。 */
function ellipseF(p: Pt, e: Ellipse): number {
  const dx = (p.x - e.cx) / e.rx
  const dy = (p.y - e.cy) / e.ry
  return dx * dx + dy * dy - 1
}

/** 椭圆在给定 x 上的上下边界 y（涟漪、预示环、测试都用得上） */
export function ellipseSpanAtY(e: Ellipse, y: number): { x0: number; x1: number } | null {
  const dy = (y - e.cy) / e.ry
  const k = 1 - dy * dy
  if (k < 0) return null
  const half = e.rx * Math.sqrt(k)
  return { x0: e.cx - half, x1: e.cx + half }
}

// ───────────────────────────────────────────────────────────────────────────
// 求解
// ───────────────────────────────────────────────────────────────────────────

export interface TossInput {
  /** 出手点（屏幕 pt）—— 即铜钱当前所在位置 */
  from: Pt
  /** 手势释放方向（未归一化；屏幕坐标，向上为 −y）。退化输入退回竖直向上 */
  dir: Pt
  /** 手势位移量（pt）。参与力度计算 */
  displacePt: number
  /** 释放速度（pt/s）。参与力度计算 */
  releaseV: number
  /** 卦盘命中椭圆。传 null 表示这一掷不判定命中 */
  board?: Ellipse | null
  /** 画布边界 */
  bounds?: Bounds
  /** 随机源（0..1）。测试注入固定值以保证可复现 */
  rand?: () => number
}

export interface TossTrajectory {
  /** 出射速度（pt/s），已钳制到 [V0_MIN, V0_MAX] */
  v0: number
  /** 归一化后的方向 */
  dir: Pt
  /** 出射速度分量（pt/s）。vel.y < 0 表示向上飞 */
  vel: Pt
  /** 抛物线高度（pt）。规范 §8.3 用例 1 的"落点在起始点上方 33pt 内"就是这个值 */
  apexPx: number
  /** 物理飞行时间（ms）：出手 → 落点（命中）或回到出手高度（未命中）。决定落点在哪 */
  physicsMs: number
  /** 动画时长（ms）：clamp(physicsMs, 550, 900)。决定播多久 */
  durationMs: number
  /** 总时长：命中时 = durationMs + BOUNCE_MS */
  totalMs: number
  /** 自旋角速度（度/秒），= SPIN_DPS ± SPIN_JITTER_DPS，落定后由表现层衰减到 0 */
  spinDps: number
  /** 落点（屏幕 pt） */
  landing: Pt
  /** 是否落在卦盘上 */
  hit: boolean
  /** 落点是否被画布边界钳制过（只有未命中时可能发生） */
  clamped: boolean
  /** 弹跳高度（pt）。未命中时为 0 */
  bouncePx: number
  /**
   * 解这条轨迹时用的画布边界。
   *
   * ★ 把它带出来，是因为"未命中 → 滚回桌面"也要守住同一条底线：
   *   **绝不把币滚到画布外面去**。落点本身已经被钳住了，但滚动是
   *   `landing + vx · t` —— 一次贴边的横甩（落点 x = 378）会算出 x ≈ 713，
   *   币滑出屏幕；而它此时正处于"选位"态，用户要用手把它拖进爻位槽 ——
   *   **一个看不见也点不到的币，就是一个走不下去的仪式**。
   *   所以 `rollBackTo()` 拿它把自己夹回桌面。
   */
  bounds: Bounds
  /**
   * 完整落定过程取点。**u ∈ [0,1] 是归一化进度**：0 出手，1 落定。
   * 命中时 u 超过主飞行占比后进入 180ms 弹跳段。
   * 拖尾（取 u−Δ）、涟漪（取 u=1）、吸附起点（取 u=1）都吃它。
   */
  at(u: number): Pt
  /** 只取主飞行弧线（不含弹跳）。预示环的"轨迹最近点"扫描用它 */
  arcAt(u: number): Pt
}

/**
 * 解一次掷币飞行。
 *
 * 落点的确定顺序（这条顺序就是"命中"的语义）：
 *   ① 抛物线是否穿过卦盘椭圆 → 穿过 ⇒ 落点 = **第一个**交点，hit = true
 *   ② 没穿过 ⇒ 落点 = 抛物线回到出手高度的位置；**超出画布就横向压缩整条轨迹**，
 *      让它落在边缘内侧（hit = false）
 *
 * ②对应规范里的温柔回路：「掷出但未落盘面 → 260ms 滚回桌面。**无音效、无触感、不提示**」。
 *
 * ★ 关于②的"横向压缩"：只把落点钳住是不够的 —— 未钳制的落点可能在 x≈852，
 *   轨迹会先飞出屏幕再瞬移回边缘，看起来像穿墙。
 *   所以把整条轨迹的横向位移按比例压到钳制后的落点上：**弧线形状（y）完全不变**，
 *   x 单调地走去新落点，路径始终在画布内。
 */
export function solveToss(input: TossInput): TossTrajectory {
  const {
    from,
    dir,
    displacePt,
    releaseV,
    board = null,
    bounds = DEFAULT_BOUNDS,
    rand = Math.random,
  } = input

  // ── 方向：归一化；退化输入退回"竖直向上"，绝不产生 NaN 方向 ────────────
  const mag = hypot(dir)
  const n: Pt = mag < 1e-9 ? { x: 0, y: -1 } : { x: dir.x / mag, y: dir.y / mag }

  // ── 出射速度：位移与释放速度共同决定，双向钳制 ──────────────────────────
  const v0 = clamp(
    TH.V0_K_DISPLACE * Math.abs(displacePt) + TH.V0_K_RELEASE * Math.abs(releaseV),
    TH.V0_MIN,
    TH.V0_MAX,
  )
  const vel: Pt = { x: n.x * v0, y: n.y * v0 }

  // ── 抛物线高度与"回到出手高度"的时间 ────────────────────────────────────
  // 只有 vel.y < 0（向上）才有高度；往下丢就直接落，不摆弧线。
  const vyUp = Math.min(0, vel.y)
  const apexPx = (vyUp * vyUp) / (2 * TH.GRAVITY)
  const backToStartMs = vyUp === 0 ? 0 : (2 * -vyUp * 1000) / TH.GRAVITY

  /** 解析式取点：t 单位 ms */
  const pointAtMs = (tMs: number): Pt => {
    const t = tMs / 1000
    return {
      x: from.x + vel.x * t,
      y: from.y + vel.y * t + 0.5 * TH.GRAVITY * t * t,
    }
  }

  // ── ① 求与卦盘椭圆的**第一个**交点（粗扫 + 二分）─────────────────────────
  let hit = false
  let physicsMs = backToStartMs
  let landing: Pt = pointAtMs(backToStartMs)

  if (board) {
    if (ellipseF(from, board) <= 0) {
      // 出手点已在盘内（不该发生，但兜住）：不飞行，就地落定
      hit = true
      physicsMs = 0
      landing = { x: from.x, y: from.y }
    } else {
      // 扫到"回到出手高度"之后一段 —— 因为盘中区域可能在出手高度**之下**
      const scanEnd = Math.max(FLIGHT_MS_MAX * 2, backToStartMs * 1.5, 600)
      const step = 4
      let prevT = 0
      for (let t = step; t <= scanEnd; t += step) {
        if (ellipseF(pointAtMs(t), board) <= 0) {
          let lo = prevT
          let hi = t
          for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2
            if (ellipseF(pointAtMs(mid), board) <= 0) hi = mid
            else lo = mid
          }
          hit = true
          physicsMs = hi
          break
        }
        prevT = t
      }
    }
  }

  let clamped = false
  /**
   * ★ 横向压缩比。只钳落点是不够的 —— 大力横甩时未钳制的落点在 x≈852，
   *   轨迹会**先飞出屏幕再瞬移回边缘**，看起来像穿墙。
   *   所以把整条轨迹的横向位移按比例压到钳制后的落点上：
   *   弧线形状（y）完全不变，x 单调地走去新落点，路径始终在画布内。
   */
  let xScale = 1
  if (hit) {
    landing = pointAtMs(physicsMs)
  } else {
    // ── ② 未落盘：回到出手高度；超出画布就压回边缘内侧 ────────────────────
    const raw = pointAtMs(backToStartMs)
    let targetX = raw.x
    let targetY = raw.y
    if (targetX < EDGE_MARGIN) {
      targetX = EDGE_MARGIN
      clamped = true
    } else if (targetX > bounds.w - EDGE_MARGIN) {
      targetX = bounds.w - EDGE_MARGIN
      clamped = true
    }
    if (targetY > bounds.h - EDGE_MARGIN) {
      targetY = bounds.h - EDGE_MARGIN
      clamped = true
    }
    landing = { x: targetX, y: targetY }

    const dxRaw = raw.x - from.x
    if (clamped && Math.abs(dxRaw) > 1e-6) {
      xScale = (targetX - from.x) / dxRaw
    }
  }

  // ── 自旋与弹跳 ──────────────────────────────────────────────────────────
  const spinDps = TH.SPIN_DPS + (rand() * 2 - 1) * TH.SPIN_JITTER_DPS

  // 弹跳高度按抛物线高度算；高度极小（几乎是平推）时给一个可见的下限
  const bouncePx = hit ? Math.max(apexPx, 8) * BOUNCE_DECAY : 0

  // ── 两条时间轴：物理定落点，钳制定时长 ──────────────────────────────────
  const durationMs = clamp(physicsMs, FLIGHT_MS_MIN, FLIGHT_MS_MAX)
  const totalMs = hit ? durationMs + BOUNCE_MS : durationMs
  /** 主飞行段在归一化进度中的占比 */
  const mainRatio = durationMs / totalMs
  /** 物理时长为零（就地落定）时退化处理，避免除零 */
  const phys = physicsMs > 0 ? physicsMs : 1

  const arcAt = (u: number): Pt => {
    const p = pointAtMs(clamp(u, 0, 1) * phys)
    return xScale === 1 ? p : { x: from.x + (p.x - from.x) * xScale, y: p.y }
  }

  const at = (u: number): Pt => {
    const uu = clamp(u, 0, 1)
    if (!hit || uu <= mainRatio) {
      const p = pointAtMs((uu / mainRatio) * phys)
      return xScale === 1 ? p : { x: from.x + (p.x - from.x) * xScale, y: p.y }
    }
    // 弹跳段：一条 180ms 的小抛物线，水平继续滑一点点（视觉上"擦出去了"）
    const s = (uu - mainRatio) / (1 - mainRatio)
    return {
      x: lerp(landing.x, landing.x + vel.x * xScale * 0.06, s),
      y: landing.y - 4 * bouncePx * s * (1 - s),
    }
  }

  return {
    v0,
    dir: n,
    vel,
    apexPx,
    physicsMs,
    durationMs,
    totalMs,
    spinDps,
    landing,
    hit,
    clamped,
    bouncePx,
    bounds,
    arcAt,
    at,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 落点预示环的推测位置（规范 §3③：轨迹与盘面椭圆的最近交点）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 预示环画在哪：
 *   · 轨迹穿过盘面 → 交点（就是落点本身）
 *   · 没穿过       → 取整条轨迹上**离盘心最近**的那个点
 *
 * ★ 第二条是刻意的设计：没掷中时预示环落在"最接近盘的位置"，
 *   用户看到的是"差一点"，而不是"没中" —— 与"温柔容错"是同一条原则。
 */
export function predictRingAt(
  traj: TossTrajectory,
  board: Ellipse | null,
  samples = 64,
): Pt {
  if (traj.hit || !board) return traj.landing

  let best = traj.landing
  let bestD = Infinity
  for (let i = 0; i <= samples; i++) {
    const p = traj.arcAt(i / samples)
    const d = Math.hypot(p.x - board.cx, p.y - board.cy)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/**
 * 未落盘时铜钱"滚回桌面"的终点：从落点水平滑一小段并停住。
 * 摩擦 0.86 只作用在水平方向 —— 桌面是平的，不做二次下坠。
 */
export function rollBackTo(traj: TossTrajectory, friction = 0.86, ms = 260): Pt {
  const vx = traj.vel.x * friction
  const raw = traj.landing.x + (vx * ms) / 1000
  // ★ 用解这条轨迹时的边界把自己夹回桌面 —— 理由见 TossTrajectory.bounds 的说明。
  //   这里取 traj.bounds 而不是默认边界：调用方未必知道这条轨迹当初是在哪块
  //   画布上解的，夹到一块不同的画布上就等于没夹。
  if (!(raw >= EDGE_MARGIN && raw <= traj.bounds.w - EDGE_MARGIN)) {
    return { x: clamp(raw, EDGE_MARGIN, traj.bounds.w - EDGE_MARGIN), y: traj.landing.y }
  }
  return { x: raw, y: traj.landing.y }
}
