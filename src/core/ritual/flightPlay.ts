/**
 * 小卜 · 飞行取点与残留   src/core/ritual/flightPlay.ts
 * ===========================================================================
 * `flight.ts` 回答"这条抛物线长什么样、落在哪"；本文件回答**"第 t 毫秒该画什么"**。
 *
 * 两者分开是有理由的：前者是物理，后者是表现。
 *   · 物理只错一次 —— 落点偏了，用户立刻说"它明明没掉进盘里"。
 *   · 表现每帧都在错 —— 拖尾不动、涟漪不散、落地后尾巴糊成一坨、
 *     自旋画成了"屏幕上打转"。这类 bug 在真机上"看着有点怪"却说不清哪里怪，最难查。
 * 所以把表现也做成**纯函数**：给同一条轨迹与同一个 t，永远得到同一帧。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 拖尾为什么是"3 个定点"而不是粒子系统
 * ───────────────────────────────────────────────────────────────────────────
 * 规范原文（交互动效 Brief §3③）：「**严禁引入物理引擎**（Box2D / Matter.js /
 * Rapier 均禁止）…… 拖尾 = 3 段残影，1 次绘制 × 3 个 alpha」。
 *
 * 所以这里没有粒子池、没有随机数、没有寿命数组 —— 只有固定的三组常数
 * （滞后 24/48/72 ms、α .18/.12/.07、r 9/4.5/2.4），每帧从轨迹上取三个**确定**的点。
 * 每帧的分配量 = 一个长度 ≤3 的数组，零 GC 压力。
 *
 * ★ 这条纪律的收益不只是省内存：定点采样让"拖尾长什么样"**可以被断言**，
 *   而粒子系统只能靠眼睛看。见 tests/ritual-flight.spec.ts §二。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ★ 一个曾经写错的地方：拖尾的滞后要用"真实毫秒"，不是"归一化进度"
 * ───────────────────────────────────────────────────────────────────────────
 * `flight.ts` 把**时长**钳到 [550, 900] ms，但**形状**是按物理时间算的 ——
 * 也就是说归一化进度 u 与真实经过的毫秒之间，有一个随力度变化的系数。
 *
 * 拖尾滞后（24/48/72 ms）在感知上是"残影拖了多长"，它对应的是**真实时间**，
 * 所以取点必须是 `traj.at((elapsedMs − lagMs) / totalMs)`，
 * 而**不是** `traj.at(u − 常数)`。后者会让轻掷的尾巴比重掷长 1.6 倍，手感完全反了。
 * ===========================================================================
 */

import {
  COIN_EDGE_SQUASH_MIN,
  MS,
  RIPPLE_ALPHA_FROM,
  RIPPLE_MS,
  RIPPLE_RINGS,
  RIPPLE_RX_FROM,
  RIPPLE_RX_TO,
  RIPPLE_STAGGER_MS,
  TRAIL_ALPHA,
  TRAIL_LAG_MS,
  TRAIL_R_PT,
  TRAIL_SEGMENTS,
} from './thresholds'
import { rollBackTo, type Pt, type TossTrajectory } from './flight'

/** 一段残影 */
export interface TrailDot {
  at: Pt
  /** 半径（pt）—— 越旧越细 */
  r: number
  alpha: number
}

/** 一圈涟漪 */
export interface RippleRing {
  /** 横向半轴（pt）。纵向半轴由 `flattenRy()` 给（2:1） */
  rx: number
  alpha: number
}

/** 某一时刻的飞行表现 */
export interface FlightPlay {
  /** 归一化进度 0..1（1 = 主飞行 + 弹跳都走完） */
  u: number
  /** 铜钱此刻的位置 */
  at: Pt
  /** 累计自旋角（弧度）。★ 落稳后冻结，不再转 */
  spinRad: number
  /** 还在主弧线上（尚未落地） */
  airborne: boolean
  /** 已经彻底停住（命中 = 主飞行 + 弹跳走完；未命中还要等滚回桌面） */
  atRest: boolean
  /** 3 段残影（可能少于 3 段 —— 出手后头 72ms 内只够画已有的那几段） */
  trail: TrailDot[]
  /** 0–2 圈涟漪，按"先扩散的那圈在前"的顺序 */
  ripples: RippleRing[]
}

/** 缓出（快 → 慢）。涟漪扩散、补币滚出用它：物体的速度应当单调递减 */
export function easeOutQuad(p: number): number {
  const t = clamp01(p)
  return 1 - (1 - t) * (1 - t)
}

/** 缓出更快一档 —— 吸附落定用它：起手就慢会显得"没吸住" */
export function easeOutCubic(p: number): number {
  const t = clamp01(p)
  const k = 1 - t
  return 1 - k * k * k
}

/**
 * 自旋角 → 横向压缩比例。
 *
 * ★ 一枚翻滚的铜钱在 2:1 等距下是"变窄"，不是在屏幕上打转。
 *   用 `|cos θ|` 压缩横向半径：θ=0 摊平（宽 1），θ=π/2 立起（只剩一条侧边）。
 *   下限 `COIN_EDGE_SQUASH_MIN` 保证它不会在某一帧彻底消失（那会闪一下）。
 */
export function spinSquashX(spinRad: number): number {
  const th = Number.isFinite(spinRad) ? spinRad : 0
  const c = Math.abs(Math.cos(th))
  return COIN_EDGE_SQUASH_MIN + (1 - COIN_EDGE_SQUASH_MIN) * c
}

/**
 * 取一帧。
 *
 * @param traj      `solveToss()` 解出的轨迹
 * @param elapsedMs 自"出手"起经过的毫秒（只增不减；重掷时调用方换一条新轨迹）
 *
 * ★ 未落盘（miss）时的"滚回桌面"也在这里 —— 规范 §3③ 的温柔回路：
 *   「掷出但未落盘面 → 260ms 滚回桌面。**无音效、无触感、不提示**」。
 *   所以 `atRest` 要等到滚完才为真，而"落定"（LANDED 事件）不等它 ——
 *   早 260ms 进选位，用户不会觉得"卡了一下"。
 */
export function sampleFlight(traj: TossTrajectory, elapsedMs: number): FlightPlay {
  // ★ 入口防护：非有限输入一律当 0。不挡的话 u = NaN，
  //   而 `traj.at()` 内部的 clamp 用 Math.min/max 也救不回 NaN —— 币会被画到 (NaN, NaN)。
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const total = Math.max(1, traj.totalMs)
  const u = Math.min(1, ms / total)

  // ── 位置：主飞行 / 弹跳走 traj.at；未命中且已过总时长 → 滚回桌面 ───────────
  let at = traj.at(u)
  if (!traj.hit && ms > total) {
    const to = rollBackTo(traj)
    const p = easeOutCubic((ms - total) / MS.rollBack)
    at = { x: at.x + (to.x - at.x) * p, y: at.y }
  }

  // ★ 自旋在"停稳"那一刻冻结：滚回桌面的币已经贴地，还在翻会与"贴着桌面滑"矛盾
  const spinMs = Math.min(ms, total)

  // ── 拖尾：按真实毫秒回溯；出手后不足 72ms 时，长的那两段还不存在 ──────────
  const fade = ms <= total ? 1 : Math.max(0, 1 - (ms - total) / (TRAIL_LAG_MS[TRAIL_SEGMENTS - 1] ?? 1))
  const trail: TrailDot[] = []
  if (fade > 0.01) {
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const lag = TRAIL_LAG_MS[i] ?? 0
      const back = ms - lag
      if (back < 0) continue
      const a = (TRAIL_ALPHA[i] ?? 0) * fade
      if (a <= 0.01) continue
      trail.push({ at: traj.at(back / total), r: TRAIL_R_PT[i] ?? 0, alpha: a })
    }
  }

  // ── 涟漪：只有真的落盘才有（落在木桌上不该激起"水面"）────────────────────
  const ripples: RippleRing[] = []
  if (traj.hit) {
    for (let k = 0; k < RIPPLE_RINGS; k++) {
      const p = (ms - traj.durationMs - k * RIPPLE_STAGGER_MS) / RIPPLE_MS
      if (p < 0 || p >= 1) continue
      ripples.push({
        rx: RIPPLE_RX_FROM + (RIPPLE_RX_TO - RIPPLE_RX_FROM) * easeOutQuad(p),
        alpha: RIPPLE_ALPHA_FROM * (1 - p),
      })
    }
  }

  return {
    u,
    at,
    spinRad: (traj.spinDps * (Math.PI / 180) * spinMs) / 1000,
    airborne: ms < traj.durationMs,
    atRest: traj.hit ? ms >= traj.totalMs : ms >= total + MS.rollBack,
    trail,
    ripples,
  }
}

/**
 * 这条轨迹"完全没事可做"还要多久（ms）—— 调用方据此决定何时能丢掉它。
 *
 * ★ 涟漪比币活得久：币停在盘上之后，水面还要荡 RIPPLE_MS + 一圈的错位。
 *   拿总时长直接当寿命的话，最后一圈涟漪会被**拦腰截断**（消散到一半突然不见）。
 */
export function flightLifetimeMs(traj: TossTrajectory): number {
  const settle = traj.hit ? traj.totalMs : traj.totalMs + MS.rollBack
  const ripples = traj.hit ? traj.durationMs + RIPPLE_MS + (RIPPLE_RINGS - 1) * RIPPLE_STAGGER_MS : 0
  return Math.max(settle, ripples)
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
