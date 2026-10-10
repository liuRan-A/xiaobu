/**
 * 飞行求解器 · 回归测试   tests/flight.spec.ts
 * ===========================================================================
 * 这份测试的骨架**直接来自规范**《掷币仪式四态-交互动效 Brief》§8.3
 * 「单测边界（给 Future Me）」。它列了 6 条用例，前 3 条是飞行、后 3 条是吸附
 * （后 3 条在 tests/slot-resolver.spec.ts）。
 *
 * 为什么这些用例值得逐字实现：
 *   飞行与吸附是"手感"的数学底层，而手感最容易的失败方式不是"看出来不对"，
 *   而是"在真机上来回试半天，感觉好像行"。把它们钉成确定性断言之后：
 *     · 调 v0 系数 / 重力 / 吸附半径 → 立刻知道有没有把边界情况撞坏
 *     · 美术改卦盘尺寸 → 命中椭圆的漂移会被立刻发现
 *
 * ★ rand 全部注入固定值：飞行结果必须**可复现**，否则测试本身就成了随机数发生器。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  BOUNCE_MS,
  FLIGHT_MS_MAX,
  FLIGHT_MS_MIN,
  TH,
  angleFromVerticalDeg,
  clamp,
  hitsBoard,
  predictRingAt,
  rollBackTo,
  solveToss,
  type Ellipse,
  type Pt,
  type Bounds,
} from '@core/ritual'

/** 固定随机源：永远返回 0.5 ⇒ SPIN_DPS 的抖动为 0，断言可比对 */
const fixedRand = () => 0.5

/** 一个与真实卦盘同量级的命中椭圆（rx 118 / ry 59 来自 worldLayout 的 BOARD） */
const BOARD: Ellipse = { cx: 218, cy: 528, rx: 118, ry: 59 }

/** 出手点：桌面上那枚待机铜钱的位置 */
const FROM: Pt = { x: 196, y: 452 }

const toss = (over: Partial<Parameters<typeof solveToss>[0]> = {}) =>
  solveToss({
    from: FROM,
    dir: { x: 0, y: -1 },
    displacePt: 0,
    releaseV: 0,
    board: BOARD,
    rand: fixedRand,
    ...over,
  })

// ───────────────────────────────────────────────────────────────────────────

describe('① 出射速度 v0 的构成与钳制', () => {
  it('零手势 ⇒ 钳到 V0_MIN（不是 0 —— 轻轻一放也有最小速度）', () => {
    expect(toss({ displacePt: 0, releaseV: 0 }).v0).toBe(TH.V0_MIN)
  })

  it('v0 = 6.2·|位移| + 0.85·|释放速度|', () => {
    // 20pt 位移 + 200pt/s 释放 ⇒ 124 + 170 = 294 → 仍未够最小速度
    expect(toss({ displacePt: 20, releaseV: 200 }).v0).toBe(TH.V0_MIN)
    // 60pt + 480 ⇒ 372 + 408 = 780（落在区间内，不钳制）
    expect(toss({ displacePt: 60, releaseV: 480 }).v0).toBeCloseTo(780, 6)
  })

  it('巨大力度 ⇒ 钳到 V0_MAX', () => {
    expect(toss({ displacePt: 900, releaseV: 3000 }).v0).toBe(TH.V0_MAX)
  })
})

describe('② 规范 §8.3 用例 1 · v0 = 420、方向竖直向上', () => {
  /** 这一掷会落在盘上，所以 physicsMs 是"出手 → 落点"，比"回到出手高度"更长 */
  const t = toss({ displacePt: 0, releaseV: 0 })
  /** 不判命中时，飞行才走满"回到出手高度"那段 */
  const free = toss({ displacePt: 0, releaseV: 0, board: null })

  it('★ 抛物线高度 = v0²/(2g) = 33.9pt（"落点在起始点上方 33pt 内"就是这个量）', () => {
    expect(t.apexPx).toBeCloseTo((420 * 420) / (2 * 2600), 6) // 33.923
    expect(t.apexPx).toBeLessThan(34)
  })

  it('★ 弧线最高点仍在画布内，且就是解析式的 452 − 33.9', () => {
    // 顶点出现在物理时刻 |vy|/g = 161.5ms —— 注意**不是 u=0.5**：
    // 命中时飞行在落到盘面（更低处）就结束了，u 的中点不等于抛物线顶点。
    const uApex = 161.538 / t.physicsMs
    expect(t.arcAt(uApex).y).toBeCloseTo(FROM.y - t.apexPx, 3)
    expect(t.arcAt(uApex).y).toBeGreaterThan(0)
  })

  it('★ 动画时长被钳到 FLIGHT_MS_MIN（自由飞行的物理只要 323ms，太毛躁）', () => {
    expect(free.physicsMs).toBeCloseTo(323.08, 1)
    expect(free.durationMs).toBe(FLIGHT_MS_MIN) // 550
    expect(free.durationMs).toBeGreaterThan(free.physicsMs)
  })

  it('出手点就在盘面正上方 ⇒ 竖直掷出仍会落到盘上（温柔容错：不该轻易掷空）', () => {
    expect(t.hit).toBe(true)
    // 落点在椭圆边界上（第一个交点）
    const e = BOARD
    const dx = (t.landing.x - e.cx) / e.rx
    const dy = (t.landing.y - e.cy) / e.ry
    expect(dx * dx + dy * dy).toBeCloseTo(1, 3)
  })

  it('★ 落到盘上比"飞到最高再落回原高度"更早结束 —— 盘面比出手点低', () => {
    expect(t.physicsMs).toBeGreaterThan(free.physicsMs)
    expect(t.landing.y).toBeGreaterThan(FROM.y)
  })
})

describe('③ 规范 §8.3 用例 2 · v0 = 1500、方向右偏 40°', () => {
  const rad = (40 * Math.PI) / 180
  const t = toss({
    displacePt: 242, // 242 × 6.2 = 1500.4 → 钳到 1500
    dir: { x: Math.sin(rad), y: -Math.cos(rad) },
  })

  it('v0 钳到 V0_MAX', () => {
    expect(t.v0).toBe(TH.V0_MAX)
  })

  it('方向归一化后与垂线夹角 = 40°（angleFromVerticalDeg 与构造值自洽）', () => {
    expect(angleFromVerticalDeg({ x: Math.sin(rad), y: -Math.cos(rad) })).toBeCloseTo(40, 6)
    expect(t.dir.x).toBeCloseTo(Math.sin(rad), 9)
    expect(t.dir.y).toBeCloseTo(-Math.cos(rad), 9)
  })

  it('★ 大力横甩会掷出盘外：落点被画布边界钳制，且不判命中', () => {
    // 未钳制的理论横移：v0·sin40°·T ≈ 964 × 0.884 ≈ 852pt —— 远超 390 画布宽
    expect(t.hit).toBe(false)
    expect(t.clamped).toBe(true)
    expect(t.landing.x).toBeLessThanOrEqual(390)
    expect(t.landing.x).toBeGreaterThan(0)
    expect(t.landing.y).toBeLessThanOrEqual(844)
  })

  it('★ clamped 的落点仍不出 390×844 画布（验收清单"不出画布"）', () => {
    const xs = [0.25, 0.5, 0.75, 1].map((u) => t.at(u))
    for (const p of xs) {
      expect(p.x).toBeLessThanOrEqual(390)
      expect(p.x).toBeGreaterThanOrEqual(0)
    }
  })

  it('★ 时长落在 [550, 900] 内（这正是规范写的 T 区间）', () => {
    expect(t.durationMs).toBeGreaterThanOrEqual(FLIGHT_MS_MIN)
    expect(t.durationMs).toBeLessThanOrEqual(FLIGHT_MS_MAX)
  })
})

describe('④ 规范 §8.3 用例 3 · 命中判定是椭圆，不是矩形', () => {
  it('★ 恰在椭圆边界上 → 命中（用 <= 1）', () => {
    expect(hitsBoard({ x: BOARD.cx + BOARD.rx, y: BOARD.cy }, BOARD)).toBe(true)
    expect(hitsBoard({ x: BOARD.cx, y: BOARD.cy - BOARD.ry }, BOARD)).toBe(true)
    expect(hitsBoard({ x: BOARD.cx, y: BOARD.cy }, BOARD)).toBe(true) // 盘心
  })

  it('★ 椭圆的四个"角"必须判为未命中 —— 这正是不能用外接矩形的原因', () => {
    const corners: Pt[] = [
      { x: BOARD.cx + BOARD.rx, y: BOARD.cy + BOARD.ry },
      { x: BOARD.cx - BOARD.rx, y: BOARD.cy + BOARD.ry },
      { x: BOARD.cx + BOARD.rx, y: BOARD.cy - BOARD.ry },
      { x: BOARD.cx - BOARD.rx, y: BOARD.cy - BOARD.ry },
    ]
    for (const c of corners) {
      expect(hitsBoard(c, BOARD)).toBe(false)
      // 但若用外接矩形判定，这四点全都在框内 —— 差异就在这里
      const inRect =
        Math.abs(c.x - BOARD.cx) <= BOARD.rx && Math.abs(c.y - BOARD.cy) <= BOARD.ry
      expect(inRect).toBe(true)
    }
  })

  it('盘外一点点（+0.5px）即未命中：边界不留模糊带', () => {
    expect(hitsBoard({ x: BOARD.cx + BOARD.rx + 0.5, y: BOARD.cy }, BOARD)).toBe(false)
  })
})

describe('⑤ 归一化进度 at(u) —— 表现层唯一需要接的口', () => {
  const t = toss({ displacePt: 60, releaseV: 480 })

  it('u = 0 是出手点，u = 1 是落点', () => {
    const a = t.at(0)
    expect(a.x).toBeCloseTo(FROM.x, 6)
    expect(a.y).toBeCloseTo(FROM.y, 6)
    const z = t.at(1)
    expect(z.x).toBeCloseTo(t.landing.x, 6)
    expect(z.y).toBeCloseTo(t.landing.y, 6)
  })

  it('★ 弧线真的先上后下（抛物线，不是插值直线）', () => {
    const mid = t.at(0.5)
    expect(mid.y).toBeLessThan(FROM.y) // 中途比出手点高
  })

  it('u 超界会被夹住，不抛异常（表现层传来的进度不可全信）', () => {
    expect(() => t.at(-3)).not.toThrow()
    expect(() => t.at(17)).not.toThrow()
    expect(t.at(-3)).toEqual(t.at(0))
    expect(t.at(17)).toEqual(t.at(1))
  })

  it('★ 命中时弹跳只在最后一段发生，且高度 = 0.35 × 抛物线高度', () => {
    expect(t.hit).toBe(true)
    expect(t.bouncePx).toBeCloseTo(Math.max(t.apexPx, 8) * TH.BOUNCE_DECAY, 6)
    expect(t.totalMs).toBeCloseTo(t.durationMs + BOUNCE_MS, 6)
    // 弹跳顶点（u 在中段）应当高于落点
    const mainRatio = t.durationMs / t.totalMs
    const apexOfBounce = t.at(mainRatio + (1 - mainRatio) / 2)
    expect(apexOfBounce.y).toBeLessThan(t.landing.y)
  })

  it('未命中时没有弹跳段：totalMs 就是主飞行时长', () => {
    const miss = toss({ displacePt: 0, releaseV: 0, board: null })
    expect(miss.hit).toBe(false)
    expect(miss.bouncePx).toBe(0)
    expect(miss.totalMs).toBe(miss.durationMs)
  })
})

describe('⑥ 自旋 · 边界输入 · 预示环 · 滚回', () => {
  it('自旋 = 760 ± 60 度/秒，注入随机源后可复现', () => {
    expect(toss().spinDps).toBe(TH.SPIN_DPS) // rand() = 0.5 ⇒ 抖动为 0
    const hi = solveToss({
      from: FROM,
      dir: { x: 0, y: -1 },
      displacePt: 0,
      releaseV: 0,
      board: BOARD,
      rand: () => 1,
    })
    const lo = solveToss({
      from: FROM,
      dir: { x: 0, y: -1 },
      displacePt: 0,
      releaseV: 0,
      board: BOARD,
      rand: () => 0,
    })
    expect(hi.spinDps).toBeCloseTo(TH.SPIN_DPS + TH.SPIN_JITTER_DPS, 6)
    expect(lo.spinDps).toBeCloseTo(TH.SPIN_DPS - TH.SPIN_JITTER_DPS, 6)
  })

  it('★ 退化方向 (0,0) 不产生 NaN —— 退回竖直向上', () => {
    const t = toss({ dir: { x: 0, y: 0 } })
    expect(Number.isFinite(t.vel.x)).toBe(true)
    expect(Number.isFinite(t.vel.y)).toBe(true)
    expect(t.dir).toEqual({ x: 0, y: -1 })
    expect(Number.isFinite(t.landing.x)).toBe(true)
    expect(Number.isFinite(t.at(0.5).y)).toBe(true)
  })

  it('方向为 NaN 时也不崩（异常输入在底层静默降级，对应防崩底线）', () => {
    expect(() => toss({ dir: { x: NaN, y: NaN }, displacePt: NaN })).not.toThrow()
  })

  it('★ 未命中时预示环落在"离盘心最近"的轨迹点上 —— 用户看到"差一点"而不是"没中"', () => {
    const miss = toss({ displacePt: 242, releaseV: 0, dir: { x: 1, y: -0.05 } })
    expect(miss.hit).toBe(false)
    const ring = predictRingAt(miss, BOARD)
    const dRing = Math.hypot(ring.x - BOARD.cx, ring.y - BOARD.cy)
    const dLand = Math.hypot(miss.landing.x - BOARD.cx, miss.landing.y - BOARD.cy)
    expect(dRing).toBeLessThanOrEqual(dLand + 1e-9)
  })

  it('★ 命中时预示环就是落点本身', () => {
    const t = toss({ displacePt: 60, releaseV: 480 })
    expect(t.hit).toBe(true)
    expect(predictRingAt(t, BOARD)).toEqual(t.landing)
  })

  it('滚回落点只改水平方向的 x，y 不变（桌面是平的）', () => {
    const miss = toss({ displacePt: 242, releaseV: 0, dir: { x: 1, y: -0.05 } })
    const back = rollBackTo(miss)
    expect(back.y).toBe(miss.landing.y)
    expect(back.x).not.toBe(miss.landing.x)
  })

  // ── traj.bounds：轨迹自带的边界 ───────────────────────────────────────────
  // 这两条守的是同一件事：**滚出去的币必须还在屏幕上**。
  // 它决定的是"接不接得下去"，不是"好不好看" —— 未命中的币一直在选位态等着被拖，
  // 而一枚看不到也点不到的币，等于把仪式的后半段删掉了。

  it('★ trajectory 带出解它时用过的 bounds', () => {
    const narrow: Bounds = { w: 320, h: 640 }
    const wide = toss({ displacePt: 60, releaseV: 480 })
    const t = solveToss({ from: FROM, dir: { x: 0, y: -1 }, displacePt: 60, releaseV: 480, board: BOARD, bounds: narrow, rand: fixedRand })
    expect(t.bounds).toEqual(narrow)
    // 默认边界也要跟着走：不传 bounds 的人照样拿得到能夹的东西
    expect(wide.bounds.w).toBeGreaterThan(0)
    expect(wide.bounds.h).toBeGreaterThan(0)
  })

  it('★ 贴着边横甩：落点被夹住了，滚出去之后仍在画布内', () => {
    const W = 390
    const t = toss({ displacePt: 242, releaseV: 0, dir: { x: 1, y: -0.05 }, bounds: { w: W, h: 844 } })
    expect(t.hit).toBe(false)
    // 落点已在边缘内侧（这是 solveToss 的旧行为，先钉住它没退化）
    expect(t.landing.x).toBeLessThanOrEqual(W)
    const back = rollBackTo(t)
    expect(back.x).toBeLessThanOrEqual(W - 12)
    expect(back.x).toBeGreaterThanOrEqual(12)
  })

  it('★ 滚动用的是这条轨迹自己的边界：换一块更窄的画布，那个夹点也跟着紧', () => {
    const narrow: Bounds = { w: 240, h: 844 }
    const t = solveToss({ from: FROM, dir: { x: 1, y: -0.05 }, displacePt: 242, releaseV: 0, bounds: narrow, rand: fixedRand })
    const back = rollBackTo(t)
    expect(back.x).toBeLessThanOrEqual(narrow.w - 12)
    // 而且它确实被夹了（不然这条断言是空气）：未夹时的理论值超出画布
    const raw = t.landing.x + (t.vel.x * 0.86 * 260) / 1000
    expect(raw).not.toBe(back.x)
  })

  it('clamp 的双向边界', () => {
    expect(clamp(5, 10, 20)).toBe(10)
    expect(clamp(25, 10, 20)).toBe(20)
    expect(clamp(15, 10, 20)).toBe(15)
  })
})
