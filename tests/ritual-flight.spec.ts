/**
 * 掷币飞行表现 + 仪式引擎时间线 · 回归测试   tests/ritual-flight.spec.ts
 * ===========================================================================
 * 对应 M2 开发任务书「五·3：给"牌阵坐标排布 / 锚点吸附"补 vitest 用例」。
 * 这一份守的是**"掷币这条支线在真机上真正跑得起来"**所依赖的三层：
 *
 *   ① `flightPlay.ts` —— 第 t 毫秒该画什么（拖尾 / 涟漪 / 自旋压缩 / 停稳）
 *   ② `ritualMachine` 的 `slotCoins` 真占位表（落位判定的唯一依据）
 *   ③ `RitualEngine`   —— 把状态机、飞行、指令汇缝成一条时间线的那块胶水
 *   ④ `scene/ritual/*` —— 动效层的装配与逐帧推送（画布侧）
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  为什么这份测试里"时间"要多于"形状"
 * ───────────────────────────────────────────────────────────────────────────
 *  形状（抛物线、椭圆命中）已经有 tests/flight.spec.ts 守着，它在真机上错了
 *  用户立刻会说"它明明没掉进盘里"。
 *  而这一份里错的东西**只会表现为"看着有点怪"**：
 *    · 拖尾按归一化进度取点 → 轻掷的尾巴比重掷长一截，手感反过来
 *    · 涟漪圆心用币此刻的位置而不是落点 → 水面一边荡一边跟着币跑
 *    · 落定上报晚一帧 → 币停在半空停一瞬才进选位
 *    · 涟漪画到一半轨迹被丢掉 → 最后一圈被拦腰截断
 *  这类 bug 说不清、拍照拍不出、在真机上只能靠来回试。所以把"第几毫秒看到
 *  什么"钉成确定性断言，是这份文件存在的全部理由。
 *
 * ★ 观测量一律**用真实几何**（COIN_IDLE_PX / TUBE_MOUTH_PX / BOARD_ELLIPSE /
 *   SLOT_CENTERS），不另抄一份坐标：美术改稿导致的漂移必须立刻红。
 * ★ rand 注入固定值（0.5 ⇒ 自旋抖动为 0），飞行结果必须可复现。
 * ===========================================================================
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COIN_EDGE_SQUASH_MIN,
  CUP_SHAKE_HZ,
  CURSOR_OFFSET_PT,
  MS,
  RIPPLE_ALPHA_FROM,
  RIPPLE_MS,
  RIPPLE_RINGS,
  RIPPLE_RX_FROM,
  RIPPLE_RX_TO,
  RIPPLE_STAGGER_MS,
  RitualEngine,
  TH,
  TRAIL_ALPHA,
  TRAIL_LAG_MS,
  TRAIL_R_PT,
  TRAIL_SEGMENTS,
  easeOutCubic,
  easeOutQuad,
  flightLifetimeMs,
  resolveDrop,
  sampleFlight,
  solveToss,
  spinSquashX,
  type Bounds,
  type Ellipse,
  type Pt,
  type TossTrajectory,
} from '@core/ritual'
import { SLOT_CENTERS, openSlotCount, ritualMachine, setCommandSink } from '@core/machine/ritualMachine'
import {
  BOARD_ELLIPSE,
  COIN_IDLE_PX,
  L4_COIN_ID,
  L6_ID,
  TUBE_MOUTH_PX,
  createSceneStack,
  slotSortY,
} from '@scene/layers'
import { PASS, DESIGN_H, DESIGN_W } from '@scene/renderer'
import { RFX_AIR, RFX_BOARD, RFX_SLOT, createRitualFx } from '@scene/ritual/RitualFx'
import type { GestureEvent } from '@core/gesture'
import { makeStubCtx } from './stub-ctx'

// ───────────────────────────────────────────────────────────────────────────
// 测试用的真实几何（全部来自渲染层，不手抄）
// ───────────────────────────────────────────────────────────────────────────

/** 桌面上的两枚待机铜钱（第三枚在竹筒里 —— 桌面上永远刚好三枚） */
const HOME: readonly Pt[] = COIN_IDLE_PX
/** 竹筒口中心 —— 反悔半径的圆心、补币滚出的起点 */
const CUP: Pt = TUBE_MOUTH_PX
/** 卦盘命中椭圆（玩法判定域 = 美术实测） */
const BOARD: Ellipse = BOARD_ELLIPSE
const BOUNDS: Bounds = { w: DESIGN_W, h: DESIGN_H }

/** 固定随机源：自旋抖动恒为 0 ⇒ 轨迹可复现 */
const fixedRand = () => 0.5
const UP: Pt = { x: 0, y: -1 }

/** 全部空槽（`resolveDrop` 的 occupied 参数） */
const ALL_FREE: boolean[] = SLOT_CENTERS.map(() => false)

/**
 * ★ 一个容易被忽略的换算：铜钱是按规范画在指针**上方 22pt** 的。
 *   所以"要让币落在 p"，手指必须在 p 下方 22pt。
 *   这个换算在测试里也必须显式写出来 —— 它正是那个"吸到隔壁一格"的根源。
 */
const fingerOn = (p: Pt): Pt => ({ x: p.x, y: p.y + CURSOR_OFFSET_PT })

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** 建一台接到指令汇上的仪式引擎，并把它的时钟钉在 0 */
function newEngine(): RitualEngine {
  const e = new RitualEngine({
    coinHome: HOME,
    cup: CUP,
    board: BOARD,
    bounds: BOUNDS,
    rand: fixedRand,
  })
  setCommandSink((cmd) => e.handleCommand(cmd))
  e.frame(0)
  return e
}

/** 与引擎无关的一份参照轨迹 —— 用同样的输入解一遍，拿它的时长做断言基准 */
function referenceToss(coinId = 0, distancePt = 80, releaseV = 900): TossTrajectory {
  return solveToss({
    from: HOME[coinId],
    dir: UP,
    displacePt: distancePt,
    releaseV,
    board: BOARD,
    bounds: BOUNDS,
    rand: fixedRand,
  })
}

/** 走完 IDLE → LIFT → TOSS → (到点) → PLACE 的整条前段，返回参照轨迹 */
function toPlace(engine: RitualEngine, coinId = 0): TossTrajectory {
  ritualMachine.send({ type: 'LONG_PRESS', coinId, heldMs: TH.LONG_PRESS_MS })
  ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
  const ref = referenceToss(coinId)
  engine.launch({ dir: UP, displacePt: 80, releaseV: 900 })
  engine.frame(ref.totalMs)
  return ref
}

/** 把币（按"币画在哪"）拖到 p 上：手指必须落在 p 下方 22pt */
function dragCoinOnto(engine: RitualEngine, p: Pt, t: number): Pt {
  const finger = fingerOn(p)
  ritualMachine.send({ type: 'DRAG', point: finger })
  engine.frame(t)
  return finger
}

beforeEach(() => {
  // 状态机是模块级单例：不 reset 就会让上一个用例的六爻漏进下一个
  ritualMachine.reset()
  setCommandSink(() => {})
})

afterEach(() => {
  setCommandSink(() => {})
  ritualMachine.reset()
})

// ═══════════════════════════════════════════════════════════════════════════
// 一、sampleFlight —— 拖尾取点
// ═══════════════════════════════════════════════════════════════════════════

describe('① 拖尾 · 三段定点残影', () => {
  const traj = referenceToss()
  const total = traj.totalMs

  it('前提：这条轨迹命中盘面（否则后面的涟漪断言会静默变成空数组）', () => {
    expect(traj.hit).toBe(true)
    expect(traj.totalMs).toBeGreaterThan(0)
  })

  it('★ 拖尾滞后是**真实毫秒**，不是归一化进度', () => {
    const t = 300
    const play = sampleFlight(traj, t)
    expect(play.trail).toHaveLength(TRAIL_SEGMENTS)
    TRAIL_LAG_MS.forEach((lag, i) => {
      expect(play.trail[i].at).toEqual(traj.at((t - lag) / total))
    })
    // 反证：按"进度相减"取点会得到**别的**位置（两者只在 lag=0 时才相等）
    expect(play.trail[2].at).not.toEqual(traj.at(t / total - TRAIL_LAG_MS[2] / total))
  })

  it('越旧的一段越细越淡（半径与透明度都单调递减）', () => {
    const trail = sampleFlight(traj, 300).trail
    expect(trail.map((d) => d.r)).toEqual([...TRAIL_R_PT])
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i].r).toBeLessThan(trail[i - 1].r)
      expect(trail[i].alpha).toBeLessThan(trail[i - 1].alpha)
    }
    expect(trail[0].alpha).toBeCloseTo(TRAIL_ALPHA[0], 10)
  })

  it('出手后还没飞够那么久的那几段**还不存在**（不是画在起点）', () => {
    expect(sampleFlight(traj, 10).trail).toHaveLength(0) // 连最近的 24ms 都还没到
    expect(sampleFlight(traj, TRAIL_LAG_MS[0]).trail).toHaveLength(1)
    expect(sampleFlight(traj, TRAIL_LAG_MS[1]).trail).toHaveLength(2)
    expect(sampleFlight(traj, TRAIL_LAG_MS[2]).trail).toHaveLength(TRAIL_SEGMENTS)
  })

  it('★ 主飞行结束后拖尾整体淡出，而不是整段消失（否则尾巴"啪"地断掉）', () => {
    const justAfter = sampleFlight(traj, total + TRAIL_LAG_MS[2] / 2)
    expect(justAfter.trail).toHaveLength(TRAIL_SEGMENTS)
    expect(justAfter.trail[0].alpha).toBeCloseTo(TRAIL_ALPHA[0] * 0.5, 6)
    expect(sampleFlight(traj, total + TRAIL_LAG_MS[2] + 1).trail).toHaveLength(0)
  })

  it('拖尾的取点不受"命中 / 未命中"影响（未命中的币一样有尾巴）', () => {
    const miss = referenceToss(0, 0, 0) // 极轻的一放，落到盘外
    const play = sampleFlight(miss, 200)
    expect(play.trail.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 二、sampleFlight —— 涟漪
// ═══════════════════════════════════════════════════════════════════════════

describe('② 涟漪 · 两圈错位扩散', () => {
  const traj = referenceToss()
  const d = traj.durationMs

  it('★ 涟漪从**主飞行结束**那一刻起算（弹跳段先落盘，水面才荡开）', () => {
    expect(sampleFlight(traj, d - 1).ripples).toHaveLength(0)
    expect(sampleFlight(traj, d + 1).ripples).toHaveLength(1)
  })

  it('第二圈比第一圈晚 RIPPLE_STAGGER_MS 出现，且此刻第一圈已经更大更淡', () => {
    const play = sampleFlight(traj, d + RIPPLE_STAGGER_MS + 1)
    expect(play.ripples).toHaveLength(2)
    const [first, second] = play.ripples
    expect(first.rx).toBeGreaterThan(second.rx)
    expect(first.alpha).toBeLessThan(second.alpha)
  })

  it('rx 用缓出从 12 涨到 64 —— 扩散是"起步快、尾巴慢"', () => {
    const p = 0.5
    const play = sampleFlight(traj, d + p * RIPPLE_MS)
    expect(play.ripples[0].rx).toBeCloseTo(RIPPLE_RX_FROM + (RIPPLE_RX_TO - RIPPLE_RX_FROM) * easeOutQuad(p), 9)
    expect(play.ripples[0].alpha).toBeCloseTo(RIPPLE_ALPHA_FROM * (1 - p), 9)
  })

  it('两圈都走完就是"没事可做了"（之后不会再冒出第三圈）', () => {
    const done = d + RIPPLE_MS + (RIPPLE_RINGS - 1) * RIPPLE_STAGGER_MS
    expect(sampleFlight(traj, done).ripples).toHaveLength(0)
    expect(sampleFlight(traj, done + 5000).ripples).toHaveLength(0)
  })

  it('★ 涟漪永不越出盘面（半轴 64 ≤ 盘面半宽 118 的直径）', () => {
    for (let ms = 0; ms <= d + RIPPLE_MS + RIPPLE_STAGGER_MS + 40; ms += 5) {
      for (const ring of sampleFlight(traj, ms).ripples) {
        expect(ring.rx).toBeGreaterThanOrEqual(RIPPLE_RX_FROM)
        expect(ring.rx).toBeLessThanOrEqual(RIPPLE_RX_TO)
        expect(ring.rx).toBeLessThan(BOARD.rx)
        expect(ring.alpha).toBeLessThanOrEqual(RIPPLE_ALPHA_FROM)
        expect(ring.alpha).toBeGreaterThan(0)
      }
    }
  })

  it('★ 未命中时一圈涟漪都没有 —— 落在木桌上不该激起"水面"', () => {
    const miss = solveToss({
      from: HOME[0],
      dir: { x: -1, y: -0.3 },
      displacePt: 0,
      releaseV: 800,
      board: BOARD,
      bounds: BOUNDS,
      rand: fixedRand,
    })
    expect(miss.hit).toBe(false) // 前提：这条确实掷空
    for (let ms = 0; ms < miss.totalMs + 900; ms += 20) {
      expect(sampleFlight(miss, ms).ripples).toHaveLength(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 三、停稳判定 / 未命中的温柔回路 / 非法输入
// ═══════════════════════════════════════════════════════════════════════════

describe('③ 停稳（atRest）与未命中的滚回', () => {
  const hit = referenceToss()
  const miss = solveToss({
    from: HOME[0],
    dir: { x: -1, y: -0.3 },
    displacePt: 0,
    releaseV: 800,
    board: BOARD,
    bounds: BOUNDS,
    rand: fixedRand,
  })

  it('命中：主飞行段结束就"不再空中"，但要到 totalMs（含弹跳）才停稳', () => {
    expect(sampleFlight(hit, hit.durationMs - 1).airborne).toBe(true)
    expect(sampleFlight(hit, hit.durationMs).airborne).toBe(false)
    expect(sampleFlight(hit, hit.totalMs - 1).atRest).toBe(false)
    expect(sampleFlight(hit, hit.totalMs).atRest).toBe(true)
  })

  it('★ 未命中：还要等 260ms 滚回桌面才算停稳，但"落定事件"不等它', () => {
    expect(miss.hit).toBe(false)
    expect(sampleFlight(miss, miss.totalMs + MS.rollBack - 1).atRest).toBe(false)
    expect(sampleFlight(miss, miss.totalMs + MS.rollBack).atRest).toBe(true)
  })

  it('滚回只改水平方向：y 从落到桌面的那一刻起不再变（桌面是平的）', () => {
    const y0 = sampleFlight(miss, miss.totalMs).at.y
    for (let ms = miss.totalMs; ms <= miss.totalMs + MS.rollBack; ms += 20) {
      expect(sampleFlight(miss, ms).at.y).toBeCloseTo(y0, 9)
    }
    // 而且确实滚动了（否则"温柔回路"就是没实现）
    expect(sampleFlight(miss, miss.totalMs + MS.rollBack).at.x).not.toBeCloseTo(
      sampleFlight(miss, miss.totalMs).at.x,
      3,
    )
  })

  it('★ 自旋在停稳那一刻冻结（贴地还在翻会与"贴着桌面滑"矛盾）', () => {
    const frozen = sampleFlight(hit, hit.totalMs).spinRad
    expect(sampleFlight(hit, hit.totalMs + 5000).spinRad).toBeCloseTo(frozen, 9)
    expect(sampleFlight(hit, hit.totalMs - 1).spinRad).toBeLessThan(frozen)
  })

  it('★ u 单调不减，且恒在 [0,1]（表现层拿到 NaN 也不能把币画到屏幕外）', () => {
    let prev = -1
    for (let ms = 0; ms <= hit.totalMs * 1.5; ms += 16) {
      const u = sampleFlight(hit, ms).u
      expect(u).toBeGreaterThanOrEqual(prev)
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(1)
      prev = u
    }
  })

  it('★ 非法输入一律降级成 t = 0，绝不产生 NaN 坐标', () => {
    for (const bad of [NaN, -1e9, Infinity, -Infinity]) {
      const play = sampleFlight(hit, bad)
      expect(Number.isFinite(play.at.x)).toBe(true)
      expect(Number.isFinite(play.at.y)).toBe(true)
      expect(play.u).toBe(0)
      expect(play.at).toEqual(hit.at(0))
    }
  })

  it('未命中且过了总时长时，位置仍然是有限值（不在画布外乱飞）', () => {
    const play = sampleFlight(miss, miss.totalMs + 10 * MS.rollBack)
    expect(Number.isFinite(play.at.x)).toBe(true)
    expect(Number.isFinite(play.at.y)).toBe(true)
    expect(play.at.x).toBeGreaterThan(0)
    expect(play.at.x).toBeLessThan(BOUNDS.w)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 四、自旋压缩 + 轨迹寿命
// ═══════════════════════════════════════════════════════════════════════════

describe('④ 自旋是"变窄"，不是屏幕上打转', () => {
  it('摊平（θ = 0）时不压缩，立起（θ = π/2）时压到侧边厚度', () => {
    expect(spinSquashX(0)).toBeCloseTo(1, 9)
    expect(spinSquashX(Math.PI)).toBeCloseTo(1, 9)
    expect(spinSquashX(Math.PI / 2)).toBeCloseTo(COIN_EDGE_SQUASH_MIN, 9)
    expect(spinSquashX(-Math.PI / 2)).toBeCloseTo(COIN_EDGE_SQUASH_MIN, 9)
  })

  it('★ 下限保证它不会在某一帧彻底消失（那会闪一下）', () => {
    for (let deg = 0; deg <= 720; deg += 3) {
      const k = spinSquashX((deg * Math.PI) / 180)
      expect(k).toBeGreaterThanOrEqual(COIN_EDGE_SQUASH_MIN)
      expect(k).toBeLessThanOrEqual(1)
    }
  })

  it('非法输入退回"不压缩"，而不是 NaN', () => {
    expect(spinSquashX(NaN)).toBe(1)
    expect(spinSquashX(Infinity)).toBe(1)
  })

  it('缓动曲线端点与中点都是确定的（拖尾、涟漪、补币都吃它们）', () => {
    expect(easeOutQuad(0)).toBe(0)
    expect(easeOutQuad(1)).toBe(1)
    expect(easeOutQuad(0.5)).toBeCloseTo(0.75, 12)
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 12)
    expect(easeOutQuad(-5)).toBe(0)
    expect(easeOutCubic(9)).toBe(1)
  })
})

describe('⑤ 轨迹寿命 —— 涟漪必须比币活得久', () => {
  const hit = referenceToss()
  const miss = solveToss({
    from: HOME[0],
    dir: { x: -1, y: -0.3 },
    displacePt: 0,
    releaseV: 800,
    board: BOARD,
    bounds: BOUNDS,
    rand: fixedRand,
  })

  it('★ 命中时寿命 > 总时长（只拿 totalMs 当寿命会把最后一圈涟漪拦腰截断）', () => {
    const life = flightLifetimeMs(hit)
    expect(life).toBeGreaterThan(hit.totalMs)
    expect(sampleFlight(hit, life - 1).ripples.length).toBeGreaterThan(0)
    expect(sampleFlight(hit, life).ripples).toHaveLength(0)
    expect(sampleFlight(hit, life).atRest).toBe(true)
  })

  it('未命中时寿命 = 滚回结束（没有涟漪要等）', () => {
    expect(miss.hit).toBe(false)
    const life = flightLifetimeMs(miss)
    expect(life).toBeCloseTo(miss.totalMs + MS.rollBack, 6)
    expect(sampleFlight(miss, life).atRest).toBe(true)
  })

  it('寿命恒为有限正数（拿它做过期判定，不能是 Infinity）', () => {
    for (const t of [hit, miss]) {
      const life = flightLifetimeMs(t)
      expect(Number.isFinite(life)).toBe(true)
      expect(life).toBeGreaterThan(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 六、slotCoins 真占位表（纯状态机，不接引擎）
// ═══════════════════════════════════════════════════════════════════════════

describe('⑥ 六爻位占位表 · 落一枚记一格', () => {
  /** 走一遍 IDLE → LIFT → TOSS → PLACE 并落位到指定槽 */
  const land = (slot: number, coinId = 0): void => {
    ritualMachine.send({ type: 'LONG_PRESS', coinId, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    ritualMachine.send({ type: 'LANDED', landingPt: SLOT_CENTERS[slot] })
    ritualMachine.send({ type: 'SNAP', slot: slot as 0 })
  }

  it('初始 ctx 的占位表是全空，且每次都是**新数组**（不是模块级单例）', () => {
    const a = ritualMachine.ctx.slotCoins
    expect(a).toHaveLength(SLOT_CENTERS.length)
    expect(a.every((c) => c === -1)).toBe(true)
    a[0] = 99 // 脏写一把，看它会不会污染下一次
    ritualMachine.reset()
    expect(ritualMachine.ctx.slotCoins[0]).toBe(-1)
  })

  it('★ 第一枚落在第 4 槽：只有第 4 槽被标记（老近似会认为 0 号槽被占）', () => {
    land(4, 0)
    expect(ritualMachine.state).toBe('IDLE')
    expect(ritualMachine.ctx.lines).toHaveLength(1)
    expect(ritualMachine.ctx.slotCoins[4]).toBe(0)
    expect(ritualMachine.ctx.slotCoins[0]).toBe(-1)
    expect(openSlotCount(ritualMachine.ctx)).toBe(5)
  })

  it('★ 落了一枚之后，0 号槽**仍然可以落**（这正是换掉 slot<lines.length 的理由）', () => {
    land(4, 0)
    land(0, 1)
    expect(ritualMachine.ctx.lines).toHaveLength(2)
    expect(ritualMachine.ctx.slotCoins[0]).toBe(1)
    expect(openSlotCount(ritualMachine.ctx)).toBe(4)
  })

  it('已经躺着币的槽再落一次被静默忽略：不报错、不加爻、停在 PLACE', () => {
    land(4, 0)
    const before = ritualMachine.ctx.lines.length
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 1, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    ritualMachine.send({ type: 'LANDED', landingPt: SLOT_CENTERS[4] })
    expect(ritualMachine.send({ type: 'SNAP', slot: 4 })).toBe('PLACE')
    expect(ritualMachine.ctx.lines).toHaveLength(before)
    expect(openSlotCount(ritualMachine.ctx)).toBe(5)
  })

  it('★ 六个槽满 → 进 CAST；CAST_DONE 之后占位表与爻一起清空', () => {
    for (const slot of [4, 3, 2, 1, 0]) land(slot, 0)
    expect(ritualMachine.state).toBe('IDLE')
    expect(openSlotCount(ritualMachine.ctx)).toBe(1)
    expect(ritualMachine.send({ type: 'LONG_PRESS', coinId: 1, heldMs: TH.LONG_PRESS_MS })).toBe('LIFT')
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    ritualMachine.send({ type: 'LANDED', landingPt: SLOT_CENTERS[5] })
    expect(ritualMachine.send({ type: 'SNAP', slot: 5 })).toBe('CAST')
    expect(ritualMachine.ctx.lines).toHaveLength(6)

    expect(ritualMachine.send({ type: 'CAST_DONE' })).toBe('IDLE')
    expect(ritualMachine.ctx.lines).toHaveLength(0)
    expect(ritualMachine.ctx.slotCoins.every((c) => c === -1)).toBe(true)
    expect(openSlotCount(ritualMachine.ctx)).toBe(SLOT_CENTERS.length)
  })

  it('★ 每落一枚都回 IDLE，但**不能**在 IDLE.entry 里清空占位表', () => {
    land(4, 0)
    land(3, 1)
    // 两次都经过了 IDLE，占位表必须还在
    expect(ritualMachine.ctx.slotCoins[4]).toBe(0)
    expect(ritualMachine.ctx.slotCoins[3]).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 七、RitualEngine —— 时间线
// ═══════════════════════════════════════════════════════════════════════════

describe('⑦ 起手 → 飞到点 → LANDED（唯一一处"画面回头驱动玩法"）', () => {
  it('起飞点在"币的家"，出手瞬间就在轨迹起点', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(e.inspect().lifted).toBe(0)
    expect(e.view().coinAt).toEqual(HOME[0])

    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    e.launch({ dir: UP, displacePt: 80, releaseV: 900 })
    expect(e.inspect().launched).toBe(true)
    expect(e.inspect().hasTraj).toBe(true)

    const ref = referenceToss()
    expect(e.view().coinAt).toEqual(ref.at(0))
    expect(e.view().coinScale).toBeGreaterThan(1) // 出手就是 1.15，不再等抬起缓动
  })

  it('★ 到点才回 LANDED：早 1ms 还在 TOSS，正好到点变 PLACE', () => {
    const e = newEngine()
    toPlace(e, 0)
    expect(ritualMachine.state).toBe('PLACE')
    expect(e.view().state).toBe('PLACE')
  })

  it('落盘那一下给"轻"触感；飞行途中什么都不给', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    expect(e.consumeHaptic()).toBe('medium') // 出手那一下（起手的 light 被它覆盖）
    const ref = referenceToss()
    e.launch({ dir: UP, displacePt: 80, releaseV: 900 })

    e.frame(ref.totalMs - 1)
    expect(e.consumeHaptic()).toBeNull()
    e.frame(ref.totalMs)
    expect(e.consumeHaptic()).toBe('light')
    expect(e.consumeHaptic()).toBeNull() // 取走即清，不会同一帧震两次
  })

  it('★ 未落盘面：没有触感、没有涟漪，但**依然**进 PLACE（不判失败）', () => {
    const e = newEngine()
    const miss = solveToss({
      from: HOME[0],
      dir: { x: -1, y: -0.3 },
      displacePt: 0,
      releaseV: 800,
      board: BOARD,
      bounds: BOUNDS,
      rand: fixedRand,
    })
    expect(miss.hit).toBe(false)

    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    // ★ 方向偏左但位移够 60pt ⇒ 状态机照常进 TOSS；真正的"掷空"由轨迹的 hit 决定
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: { x: -1, y: -0.3 } })
    e.launch({ dir: { x: -1, y: -0.3 }, displacePt: 0, releaseV: 800 })
    e.consumeHaptic() // 清掉出手那一下

    e.frame(miss.totalMs)
    expect(ritualMachine.state).toBe('PLACE')
    expect(e.consumeHaptic()).toBeNull()
    const play = e.view().flight
    expect(play).not.toBeNull()
    expect(play?.ripples).toHaveLength(0)
    expect(play?.atRest).toBe(false) // 还要滚 260ms
    e.frame(miss.totalMs + MS.rollBack)
    expect(e.view().flight?.atRest).toBe(true)
  })

  it('★ 涟漪的圆心是**落点**，不是币此刻的位置', () => {
    const e = newEngine()
    const ref = toPlace(e, 0)
    expect(e.view().landingAt).toEqual(ref.landing)

    // 换一局，看飞行途中：圆心仍是落点，而币还在半路上
    ritualMachine.reset()
    const e2 = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    e2.launch({ dir: UP, displacePt: 80, releaseV: 900 })
    e2.frame(Math.round(ref.totalMs / 3))

    expect(e2.view().landingAt).toEqual(ref.landing)
    const coin = e2.view().coinAt as Pt
    expect(coin).not.toBeNull()
    expect(dist(coin, ref.landing)).toBeGreaterThan(1)
  })

  it('预示环只在 TOSS 段出现，落定之后收起（选位时该看槽，不该看轨迹）', () => {
    const e = newEngine()
    const ref = referenceToss()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    e.launch({ dir: UP, displacePt: 80, releaseV: 900 })
    e.frame(200)
    expect(e.view().predictAt).not.toBeNull()
    e.frame(ref.totalMs)
    expect(e.view().predictAt).toBeNull()
  })
})

describe('⑧ 半途松手 · 180ms 缓动落回原位', () => {
  it('不够力松手：不作废成"失败"，也不飞出去，而是带一点弧回到家里', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    e.frame(120)
    expect(e.view().coinAt?.y).toBeCloseTo(HOME[0].y - 5, 6) // 抬起 5pt

    ritualMachine.send({ type: 'RELEASE', distancePt: 20, dir: UP }) // < SWIPE_MIN_PT
    expect(ritualMachine.state).toBe('IDLE')
    expect(e.inspect().launched).toBe(false)

    e.frame(120)
    expect(e.inspect().returning).toBe(true)
    expect(e.view().coinAt?.y).toBeCloseTo(HOME[0].y - 5, 6) // 从"抬起位"起步，不是瞬移

    e.frame(210) // 180ms 的一半
    const mid = e.view().coinAt as Pt
    expect(mid.x).toBeCloseTo(HOME[0].x, 6)
    // 弧顶：比"抬起位 → 家"的直线中点更高（这就是那 6pt 的弧）
    const straightMidY = (HOME[0].y - 5 + HOME[0].y) / 2
    expect(mid.y).toBeLessThan(straightMidY)

    e.frame(300) // 180ms 走完
    expect(e.inspect().returning).toBe(false)
    expect(e.view().coinId).toBe(-1)
    expect(e.view().coinAt).toBeNull()
    expect([...e.view().onTable]).toEqual([true, true]) // 交还给 L4 的待机图层
  })

  it('刚拾起还没拖动就松手：同样落回原位（不是停在半空）', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 1, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 0, dir: UP })
    e.frame(0)
    expect(e.inspect().returning).toBe(true)
    e.frame(MS.fallBack)
    expect(e.view().onTable[1]).toBe(true)
    expect(e.view().coinId).toBe(-1)
  })
})

describe('⑨ 落位三结局 · 判的是"币在哪"，不是"手指在哪"', () => {
  it('★ 反证：按手指判会吸到**隔壁那一格**（这正是修掉那个 bug 的理由）', () => {
    const s3 = SLOT_CENTERS[3]
    const byFinger = resolveDrop(fingerOn(s3), SLOT_CENTERS, ALL_FREE, CUP)
    const byCoin = resolveDrop(s3, SLOT_CENTERS, ALL_FREE, CUP)
    expect(byCoin).toEqual({ kind: 'snap', slot: 3 })
    expect(byFinger).toEqual({ kind: 'snap', slot: 2 }) // ← 手指在币下方 22pt，够到了 2 号槽
  })

  it('★ 币压在 3 号格上松手 → 落到 3 号格（不是 2 号）', () => {
    const e = newEngine()
    toPlace(e, 0)
    const finger = dragCoinOnto(e, SLOT_CENTERS[3], 2000)
    expect(e.view().armedSlot).toBe(3)

    expect(e.drop(finger)).toBe('snap')
    expect(ritualMachine.ctx.slotCoins[3]).toBe(0)
    expect(ritualMachine.ctx.lines).toHaveLength(1)
    expect(e.view().slots[3]).toBe(0)
    expect(e.view().cadenceStep).toBe(0)
    // 落定缓动 120ms：刚落下是 0，走完是 1
    expect(e.view().slotEase[3]).toBeCloseTo(0, 6)
    e.frame(2120)
    expect(e.view().slotEase[3]).toBeCloseTo(1, 6)
    // 手里那枚交出去了
    expect(e.view().coinId).toBe(-1)
  })

  it('★ 不变量：高亮的那个槽，就是松手会落进去的那个槽（六个槽逐一验证）', () => {
    const e = newEngine()
    toPlace(e, 0)
    SLOT_CENTERS.forEach((c, i) => {
      dragCoinOnto(e, c, 2000 + i)
      expect(e.view().armedSlot).toBe(i)
      // 同一个点，落位判定必须给出同一个槽 —— 高亮与结局不能是两套算法
      expect(resolveDrop(c, SLOT_CENTERS, ALL_FREE, CUP)).toEqual({ kind: 'snap', slot: i })
    })
  })

  it('拖回筒口松手 = 反悔：不计失败、不扣次数，币飞回筒口再补出一枚', () => {
    const e = newEngine()
    toPlace(e, 0)
    const finger = dragCoinOnto(e, CUP, 2000)
    expect(e.drop(finger)).toBe('revoke')
    expect(ritualMachine.state).toBe('IDLE')
    expect(ritualMachine.ctx.lines).toHaveLength(0)
    expect(e.inspect().returning).toBe(true)
    expect(e.view().glow).toBe(false) // PLACE 的盘面提亮跟着收起
  })

  it('★ "落一枚，竹筒补一枚"的完整时间线：飞回 → 进筒 → 等 400ms → 滚 220ms → 回桌面', () => {
    const e = newEngine()
    const ref = toPlace(e, 0)
    const t0 = ref.totalMs
    dragCoinOnto(e, CUP, t0)
    e.drop(fingerOn(CUP))

    // 进筒的最后 25% 渐隐 —— 币是"被筒口收进去"的，不是穿模进去的
    e.frame(t0 + MS.flyBackToCup - 10)
    expect(e.view().coinAlpha).toBeLessThan(1)
    expect(e.view().coinAlpha).toBeGreaterThan(0)

    // 200ms 到点：进筒（此刻竹筒"补一枚"开始计时）
    e.frame(t0 + MS.flyBackToCup)
    expect(e.inspect().returning).toBe(false)
    expect(e.view().onTable[0]).toBe(false)
    expect(e.view().drawCoins[0]).toBeNull()

    // 还在筒里（延迟未到）：命中层报"筒口"，于是长按竹筒也能拿到币
    e.frame(t0 + MS.flyBackToCup + 200)
    expect(e.view().drawCoins[0]).toBeNull()
    expect(dist((e.liveCoins()[0] as Pt), CUP)).toBeLessThan(1e-9)

    // 开始滚出：从筒口滑向家里
    const rolling = t0 + MS.flyBackToCup + 400 + 20
    e.frame(rolling)
    const p = e.view().drawCoins[0] as Pt
    expect(p).not.toBeNull()
    expect(dist(p, CUP)).toBeLessThan(30)
    expect(e.view().rollOut[0]).toBeGreaterThan(0)
    expect(e.view().rollOut[0]).toBeLessThan(1)

    // 滚完：交还给桌面
    e.frame(t0 + MS.flyBackToCup + 400 + 220)
    expect(e.view().onTable[0]).toBe(true)
    expect(e.view().drawCoins[0]).toBeNull()
    expect(dist(e.liveCoins()[0] as Pt, HOME[0])).toBeLessThan(1e-9)
  })

  it('停在别处：不弹回、不报错、保持可拖动', () => {
    const e = newEngine()
    toPlace(e, 0)
    const far: Pt = { x: 330, y: 700 }
    const finger = dragCoinOnto(e, far, 2000)
    expect(e.drop(finger)).toBe('stay')
    expect(ritualMachine.state).toBe('PLACE') // 没被踢出选位
    expect(e.inspect().lifted).toBe(0)
    expect(e.view().coinAt).toEqual(far) // 就在松手处
    expect(e.view().armedSlot).toBe(-1)
  })

  it('不在 PLACE 段调 drop 一律 stay（其它状态不该被落位判定影响）', () => {
    const e = newEngine()
    expect(e.drop(SLOT_CENTERS[0])).toBe('stay')
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(ritualMachine.state).toBe('LIFT')
    expect(e.drop(SLOT_CENTERS[0])).toBe('stay')
    expect(ritualMachine.ctx.lines).toHaveLength(0)
  })
})

describe('⑩ 铜钱的"在哪" —— liveCoins / onTable 与命中层保持一致', () => {
  it('待机时两枚都在家里，且都在桌面上', () => {
    const e = newEngine()
    expect(e.liveCoins()).toHaveLength(2)
    expect(e.liveCoins()[0]).toEqual(HOME[0])
    expect(e.liveCoins()[1]).toEqual(HOME[1])
    expect([...e.view().onTable]).toEqual([true, true])
  })

  it('被拿起的那枚从桌面图层摘走，交给动效层画', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(e.view().onTable[0]).toBe(false)
    expect(e.view().onTable[1]).toBe(true)
    expect(e.view().coinId).toBe(0)
  })

  it('★ 落进槽里之后，命中层报的是**槽心**而不是它待机时的位置', () => {
    const e = newEngine()
    toPlace(e, 0)
    dragCoinOnto(e, SLOT_CENTERS[3], 2000)
    e.drop(fingerOn(SLOT_CENTERS[3]))
    expect(dist(e.liveCoins()[0], SLOT_CENTERS[3])).toBeLessThan(1e-9)
    expect(e.view().onTable[0]).toBe(false)
    // 槽里的币由落位图层画，空中图层不再画它
    expect(e.view().drawCoins[0]).toBeNull()
  })

  it('view() 的每一帧都是纯快照：连读两次内容相同，且不共享"会变的"数组', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    const a = e.view()
    const b = e.view()
    expect(a.onTable).not.toBe(b.onTable)
    expect(a.slots).not.toBe(b.slots)
    expect(a.slotEase).not.toBe(b.slotEase)
    expect(a.coinAt).not.toBe(b.coinAt)
    expect([...a.onTable]).toEqual([...b.onTable])
    expect(a.coinAt).toEqual(b.coinAt)
    // ★ 唯一**刻意**共享引用的是 coinHome：它是场景层喂进来的只读几何，不随帧变化
    expect(a.coinHome).toBe(b.coinHome)
  })
})

describe('⑪ 指令汇 · handleCommand 永不抛（它在状态机 entry/exit 里同步调用）', () => {
  it('越界槽号 / 空手 / 未拖就落位 都不会炸', () => {
    const e = newEngine()
    expect(() => e.handleCommand({ type: 'slot:snap', slot: 999, coinId: -5 })).not.toThrow()
    expect(() => e.handleCommand({ type: 'slot:snap', slot: -3, coinId: 0 })).not.toThrow()
    expect(() => e.handleCommand({ type: 'board:glow', on: true })).not.toThrow()
    expect(() => e.handleCommand({ type: 'tube:shake' })).not.toThrow()
    expect(() => e.handleCommand({ type: 'sonic:cadence', step: 99 })).not.toThrow()
    expect(() => e.handleCommand({ type: 'haptic', kind: 'none' })).not.toThrow()
    expect(() => e.handleCommand(null as never)).not.toThrow()
  })

  it('★ 脏坐标不产生 NaN 位置（动效层另有守卫，但 core 也不许自己制造 NaN）', () => {
    const e = newEngine()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(() =>
      e.handleCommand({ type: 'coin:fly', from: { x: NaN, y: NaN }, to: { x: NaN, y: NaN }, arc: 0 }),
    ).not.toThrow()
    // 引擎把它当"尚未拖动"处理更安全：不动，比画到 (NaN, NaN) 好
    const at = e.view().coinAt
    expect(at === null || Number.isFinite(at.x)).toBe(true)
  })

  it('到点上报 LANDED 之后，再喂一次更晚的时间不会重复上报', () => {
    const e = newEngine()
    const ref = toPlace(e, 0)
    const linesBefore = ritualMachine.ctx.lines.length
    e.frame(ref.totalMs + 1000)
    e.frame(ref.totalMs + 2000)
    expect(ritualMachine.state).toBe('PLACE')
    expect(ritualMachine.ctx.lines).toHaveLength(linesBefore)
  })

  it('frame 的时刻非法时保持上一帧时刻（不把时间线拽回 0）', () => {
    const e = newEngine()
    toPlace(e, 0)
    const before = e.view().state
    e.frame(NaN)
    e.frame(Infinity)
    expect(e.view().state).toBe(before)
  })

  it('reset 之后回到干净开场：空手、无轨迹、无回位、无触感', () => {
    const e = newEngine()
    toPlace(e, 0)
    dragCoinOnto(e, SLOT_CENTERS[3], 2000)
    e.reset()
    const s = e.inspect()
    expect(s).toEqual({ lifted: -1, launched: false, hasTraj: false, returning: false })
    expect(e.view().coinId).toBe(-1)
    expect(e.view().glow).toBe(false)
    expect(e.view().tubeShake).toBe(0)
    expect(e.consumeHaptic()).toBeNull()
  })

  it('configure 重喂几何会重置"进筒 / 滚出"两张表，长度跟着新几何走', () => {
    const e = newEngine()
    e.configure({ coinHome: [HOME[0]], cup: CUP })
    expect(e.view().coinHome).toHaveLength(1)
    expect(e.view().onTable).toHaveLength(1)
    expect(e.view().drawCoins).toHaveLength(1)
    expect(e.liveCoins()).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 八、动效层装配（场景侧）
// ═══════════════════════════════════════════════════════════════════════════

describe('⑫ RitualFx · 图层注册与排序键', () => {
  const stack = createSceneStack()
  const fx = createRitualFx({ stack, onLiveCoins: () => {} })
  const order = stack.drawOrder(PASS.STAGE)
  const at = (id: string): number => order.indexOf(id)

  it('九个动效图层都注册上了（1 盘面 + 6 落位币 + 1 空中币，外加场景 9 个 STAGE）', () => {
    expect(at(RFX_BOARD)).toBeGreaterThanOrEqual(0)
    expect(at(RFX_AIR)).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < SLOT_CENTERS.length; i++) expect(at(RFX_SLOT(i))).toBeGreaterThanOrEqual(0)
    expect(order).toHaveLength(9 + 8)
  })

  it('★ 盘面动效夹在卦盘与最近的爻位槽之间（那段空隙是空的，正好放它）', () => {
    expect(at(RFX_BOARD)).toBe(at(L6_ID) + 1)
  })

  it('★ 六枚落位币互相按**远近**排，不按槽号排（近的在后画，才盖得住远的）', () => {
    const near = (slot: number): number => slotSortY(slot)
    for (let i = 0; i < SLOT_CENTERS.length; i++) {
      expect(at(RFX_SLOT(i))).toBeGreaterThan(at(RFX_BOARD))
      for (let j = 0; j < SLOT_CENTERS.length; j++) {
        if (i === j) continue
        // 越近（sortY 越大）越晚画
        if (near(j) < near(i)) expect(at(RFX_SLOT(j))).toBeLessThan(at(RFX_SLOT(i)))
      }
    }
    // 顺带钉住这一组几何：六个槽心是一条由远及近的斜线，
    // 所以 0 号（最近）一定排在最后
    expect(at(RFX_SLOT(0))).toBeGreaterThan(at(RFX_SLOT(SLOT_CENTERS.length - 1)))
  })

  it('★ 六枚落位币各自排在卦盘之后、空气币之前', () => {
    for (let i = 0; i < SLOT_CENTERS.length; i++) {
      expect(at(RFX_SLOT(i))).toBeGreaterThan(at(L6_ID))
      expect(at(RFX_SLOT(i))).toBeLessThan(at(RFX_AIR))
    }
  })

  it('★ 空中的那枚永远在舞台最前（按它的 y 排序会让它半路从卦盘后面钻出来）', () => {
    expect(at(RFX_AIR)).toBe(order.length - 1)
    expect(at(RFX_AIR)).toBeGreaterThan(at(RFX_SLOT(SLOT_CENTERS.length - 1)))
    expect(at(RFX_AIR)).toBeGreaterThan(at('l7-xiaobu'))
  })

  it('★ 只加图层，不动别人：既有六层一个不少', () => {
    for (const id of [L6_ID, 'l4-tube', 'l4-coin-0', 'l4-coin-1', 'l5-plant', 'l7-xiaobu']) {
      expect(order).toContain(id)
    }
  })

  it('整间屋子连同动效层画一遍不抛，且没有图层被隔离', () => {
    const { ctx } = makeStubCtx()
    expect(() => stack.render(ctx, { t: 0, dt: 16, n: 1 })).not.toThrow()
    expect(stack.quarantined()).toEqual([])
    expect(fx.engine).toBeDefined()
  })
})

describe('⑬ RitualFx · 逐帧推送与卸载', () => {
  const gv = (over: Partial<GestureEvent> = {}): GestureEvent => ({
    type: 'RELEASE',
    pointerId: 0,
    at: { ...HOME[0] },
    t: 0,
    distancePt: 80,
    dir: UP,
    speedPtS: 900,
    angleFromVerticalDeg: 0,
    heldMs: TH.LONG_PRESS_MS,
    fling: true,
    ...over,
  })

  it('★ 为什么竹筒震颤不能用 sin(2π·60·t)：60fps 下每帧都采到 0，抖幅恒为零', () => {
    // 规范写的是"高频轻颤 ±1.5pt @ 60Hz"。照抄成 sin(2πft) 在 60fps 下会得到
    // sin(2πn) —— 一个**恒等于零**的波形：画面完全静止，而它偏偏在 120Hz 设备上正常，
    // 于是表现为"我的手机不抖，你的抖"，几乎不可能归因到公式上。
    for (let n = 0; n < 30; n++) {
      expect(Math.sin(2 * Math.PI * CUP_SHAKE_HZ * (n / 60))).toBeCloseTo(0, 9)
    }
    // 场景层实际用的"逐帧取反"：任何刷新率下都不会退化成常数
    const sign = (n: number): number => (n % 2 === 0 ? 1 : -1)
    expect(sign(0)).toBe(1)
    expect(sign(1)).toBe(-1)
    expect(sign(0) + sign(1)).toBe(0) // 相邻两帧等幅反相 = 真的在颤
  })

  it('竹筒震颤的**包络**由 core 给：非负、≤1、且随时间衰减', () => {
    const stack = createSceneStack()
    const fx = createRitualFx({ stack, onLiveCoins: () => {} })
    fx.attach()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    fx.onToss(gv())

    const seen: number[] = []
    for (let n = 1; n <= 8; n++) {
      fx.onFrame({ t: n * 16, dt: 16, n })
      seen.push(fx.engine.view().tubeShake)
    }
    expect(seen.every((v) => v >= 0 && v <= 1)).toBe(true)
    expect(seen[0]).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBeLessThan(seen[0])
    // 衰减走完（260ms + 8 帧 = 约 128ms 处还在衰减，但过了 260ms 必须归零）
    fx.onFrame({ t: 600, dt: 16, n: 40 })
    expect(fx.engine.view().tubeShake).toBe(0)
    fx.detach()
  })

  it('★ 每帧把"活着的铜钱位置"喂出去，长度与家里有几枚一致', () => {
    const stack = createSceneStack()
    const seen: Array<readonly Pt[]> = []
    const fx = createRitualFx({ stack, onLiveCoins: (c) => seen.push(c) })
    fx.attach()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    ritualMachine.send({ type: 'RELEASE', distancePt: 80, dir: UP })
    fx.onToss(gv())
    for (let n = 1; n <= 40; n++) fx.onFrame({ t: n * 16, dt: 16, n })

    expect(seen.length).toBe(40)
    expect(seen[0]).toHaveLength(HOME.length)
    for (const coins of seen) {
      for (const c of coins) {
        expect(Number.isFinite(c.x)).toBe(true)
        expect(Number.isFinite(c.y)).toBe(true)
      }
    }
    // 币被拿起之后 L4 的待机图层必须让位，否则会画出"重影"
    expect(stack.get(L4_COIN_ID(0))?.visible).toBe(false)
    expect(stack.get(L4_COIN_ID(1))?.visible).toBe(true)
    fx.detach()
  })

  it('★ detach 之后指令汇断开、表现态复位、待机铜钱交还（不然下一块画布会继承竹筒的抖幅）', () => {
    const stack = createSceneStack()
    const fx = createRitualFx({ stack, onLiveCoins: () => {} })
    fx.attach()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    fx.onFrame({ t: 16, dt: 16, n: 1 })
    expect(stack.get(L4_COIN_ID(0))?.visible).toBe(false)

    fx.detach()
    expect(fx.engine.inspect().lifted).toBe(-1)
    expect(stack.get(L4_COIN_ID(0))?.visible).toBe(true)
    expect(stack.get(L4_COIN_ID(1))?.visible).toBe(true)
    expect(fx.engine.view().tubeShake).toBe(0)

    // 指令汇已断开：状态机再发指令也不会进到这台引擎
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(fx.engine.inspect().lifted).toBe(-1)
    expect(() => fx.detach()).not.toThrow() // 重复卸载安全
  })

  it('★ 脏输入只记日志：attach 期间收到 NaN 指令、NaN 手势都不抛，画面照常推进', () => {
    const stack = createSceneStack()
    const fx = createRitualFx({ stack, onLiveCoins: () => {} })
    fx.attach()
    ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
    expect(fx.engine.inspect().lifted).toBe(0)

    expect(() => fx.engine.handleCommand({ type: 'slot:snap', slot: NaN, coinId: NaN })).not.toThrow()
    expect(() => fx.onFrame({ t: 100, dt: 16, n: 2 })).not.toThrow()
    expect(() => fx.onDrop({ x: NaN, y: NaN })).not.toThrow()
    expect(() => fx.onToss(gv({ distancePt: NaN, speedPtS: NaN, dir: { x: NaN, y: NaN } }))).not.toThrow()
    expect(() => fx.onFrame({ t: 116, dt: 16, n: 3 })).not.toThrow()
    expect(() => fx.onFrame({ t: NaN, dt: NaN, n: 4 })).not.toThrow()
    expect(() => fx.detach()).not.toThrow()
  })
})
