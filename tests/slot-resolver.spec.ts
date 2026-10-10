/**
 * 爻位吸附求解器 · 回归测试   tests/slot-resolver.spec.ts
 * ===========================================================================
 * 骨架来自规范《掷币仪式四态-交互动效 Brief》§8.3 的用例 4–6，
 * 外加 §3④「等距轴上的吸附判定」与 §5「引导态 C / D」的边界。
 *
 * 为什么这一幕最该有测试：
 *   六个爻位槽沿等距轴排开，**相邻槽心只差约 15pt**，而单个槽的视觉尺寸只有
 *   约 73 × 10pt。也就是说"槽很细、但可点区域要做 44pt"——两者差 3 倍多。
 *   这是"手感"与"数学"的交界处：写错了在真机上极难定位（用户只会说"它老是
 *   吸到隔壁那格"），但在这里它是一个可以钉死的坐标断言。
 *
 * ★ 这里用的六个槽心取自 worldLayout.slotCentersPx() 的真实值 ——
 *   也就是**渲染用的那个坐标**，不是另抄一份。几何漂移会被立刻发现。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  SLOT_TIE_EPS_PT,
  SLOT_VISUAL_PT,
  TH,
  emptySlots,
  nearestEmptyCenter,
  nearestEmptySlot,
  resolveDrop,
  resolveSlot,
  type Pt,
} from '@core/ritual'
import { slotCentersPx } from '@scene/layers'

const CENTERS: Pt[] = slotCentersPx()
const CUP: Pt = { x: 124, y: 424 } // 竹筒底心（美术实测）

const ALL_EMPTY = [false, false, false, false, false, false]

/**
 * ★ 相邻槽心的真实间距。
 *
 * 规范 §3④ 写的是"相邻槽心只差约 **15pt**"，但按美术实测标定出来的等距网格，
 * 单步位移是 (gw, −gh) = (16.52, −8.24) ⇒ 实距 **18.46pt**。
 * 规范的 15pt 是目测值（连它同一段写的"73 × 10pt 视觉尺寸"也与 6 槽共 110.8pt
 * 的总跨度矛盾）。**以实测网格为准**，并把真实值钉在这里：
 * 以后美术改稿导致间距漂移，这条会立刻红。
 */
const STEP_PT = 18.460985889166388

/**
 * 与槽轴**垂直**的方向（单位向量）。
 *
 * ★ 这是一个很容易踩的坑：槽沿等距轴排开，轴方向是 (16.52, −8.24)。
 *   如果按"竖直向下偏移 44pt"来构造边界用例，那个点其实离**相邻槽**只有 39.5pt
 *   —— 因为槽轴是斜的，竖直方向根本不垂直于它。
 *   验证吸附边界必须沿垂直方向走，否则测的是"斜着够到隔壁槽"。
 */
const PERP: Pt = { x: 8.24 / STEP_PT, y: 16.52 / STEP_PT }

/** 从第 i 个槽心沿垂直方向偏出 d pt */
const offPerp = (i: number, d: number): Pt => ({
  x: CENTERS[i].x + PERP.x * d,
  y: CENTERS[i].y + PERP.y * d,
})

describe('① 前提：这批坐标本身是"细槽"', () => {
  it('★ 六个槽心两两相邻 18.46pt（规范写的"约 15pt"是目测值，实测网格为准）', () => {
    for (let i = 1; i < CENTERS.length; i++) {
      const d = Math.hypot(CENTERS[i].x - CENTERS[i - 1].x, CENTERS[i].y - CENTERS[i - 1].y)
      expect(d).toBeCloseTo(STEP_PT, 9)
    }
  })

  it('★ 槽的视觉宽度（73）远大于相邻间距（18.5）⇒ 矩形热区必然互相重叠', () => {
    expect(SLOT_VISUAL_PT.w).toBeGreaterThan(STEP_PT * 3)
    // 一个 44pt 的矩形热区会同时盖住相邻的槽 —— 命中率反而崩掉
    const half = TH.PRESELECT_PT / 2
    const covered = CENTERS.filter(
      (c) => Math.abs(c.x - CENTERS[2].x) <= half && Math.abs(c.y - CENTERS[2].y) <= half,
    ).length
    expect(covered).toBeGreaterThanOrEqual(2)
  })
})

describe('② 规范 §8.3 用例 4 · 指针在六个槽心正中', () => {
  it('★ 每个槽心都精确返回自己，距离 0，且既 armed 也 snapped', () => {
    CENTERS.forEach((c, i) => {
      const r = resolveSlot(c, CENTERS, { occupied: ALL_EMPTY })
      expect(r.index).toBe(i)
      expect(r.distance).toBeCloseTo(0, 9)
      expect(r.armed).toBe(true)
      expect(r.snapped).toBe(true)
    })
  })
})

describe('③ 规范 §8.3 用例 5 · 指针在两个相邻槽的中点上', () => {
  const mid: Pt = {
    x: (CENTERS[0].x + CENTERS[1].x) / 2,
    y: (CENTERS[0].y + CENTERS[1].y) / 2,
  }

  it('★ 到两个槽等距（STEP/2 ≈ 9.23pt）', () => {
    const d0 = Math.hypot(mid.x - CENTERS[0].x, mid.y - CENTERS[0].y)
    const d1 = Math.hypot(mid.x - CENTERS[1].x, mid.y - CENTERS[1].y)
    expect(d0).toBeCloseTo(d1, 9)
    expect(d0).toBeCloseTo(STEP_PT / 2, 6)
  })

  it('★ 只返回一个确定的槽（并列取下标更小者），绝不摇摆', () => {
    const r = resolveSlot(mid, CENTERS, { occupied: ALL_EMPTY })
    expect(r.index).toBe(0)
    // ★ 确定性不是靠"浮点刚好这样"，而是靠 SLOT_TIE_EPS_PT 这条容差：
    //   反复调用结果必须一致（手感上不能"抖"）。用一个略偏的点也验一遍，
    //   确保容差没有把"真的更近"也一起吞掉。
    for (let i = 0; i < 8; i++) {
      expect(resolveSlot(mid, CENTERS, { occupied: ALL_EMPTY }).index).toBe(0)
    }
    const nudgedHalfOfEps: Pt = { x: mid.x + SLOT_TIE_EPS_PT / 4, y: mid.y }
    expect(resolveSlot(nudgedHalfOfEps, CENTERS, { occupied: ALL_EMPTY }).index).toBe(0)
    // 超出容差就该换槽 —— 容差不能变成"永远偏向小下标"
    const nudgedWellPast: Pt = { x: mid.x + SLOT_TIE_EPS_PT * 1000, y: mid.y }
    expect(resolveSlot(nudgedWellPast, CENTERS, { occupied: ALL_EMPTY }).index).toBe(1)
  })

  it('稍微偏一点就换到更近的那个（不是死板地永远取小的）', () => {
    const near1: Pt = { x: CENTERS[1].x - 1, y: CENTERS[1].y }
    expect(resolveSlot(near1, CENTERS, { occupied: ALL_EMPTY }).index).toBe(1)
  })
})

describe('④ 规范 §8.3 用例 6 · 44pt 边界', () => {
  it('★ 沿垂直方向距所有槽 44.1pt → 不触发预备吸附', () => {
    const p = offPerp(2, 44.1)
    const r = resolveSlot(p, CENTERS, { occupied: ALL_EMPTY })
    expect(r.distance).toBeGreaterThan(TH.PRESELECT_PT)
    expect(r.armed).toBe(false)
    expect(r.snapped).toBe(false)
    // 顺带验一下"为什么必须沿垂直方向测"：竖直偏 44.1pt 反而离相邻槽只有 39.5pt
    const naive = resolveSlot({ x: CENTERS[2].x, y: CENTERS[2].y + 44.1 }, CENTERS, {
      occupied: ALL_EMPTY,
    })
    expect(naive.distance).toBeLessThan(TH.PRESELECT_PT)
    expect(naive.index).not.toBe(2)
  })

  it('恰好 44pt → armed 成立、snapped 不成立（三段语义互不混淆）', () => {
    const r = resolveSlot(offPerp(2, TH.PRESELECT_PT), CENTERS, { occupied: ALL_EMPTY })
    expect(r.distance).toBeCloseTo(TH.PRESELECT_PT, 6)
    expect(r.armed).toBe(true)
    expect(r.snapped).toBe(false)
  })

  it('恰好 28pt → snapped 成立（吸得上）', () => {
    const r = resolveSlot(offPerp(2, TH.SNAP_PT), CENTERS, { occupied: ALL_EMPTY })
    expect(r.distance).toBeCloseTo(TH.SNAP_PT, 6)
    expect(r.snapped).toBe(true)
    expect(r.armed).toBe(true)
  })

  it('★ PRESELECT_PT 必须大于 SNAP_PT，否则"预备吸附"这个中间态不会存在', () => {
    expect(TH.PRESELECT_PT).toBeGreaterThan(TH.SNAP_PT)
    // 28 ~ 44 之间：提亮了但还吸不上 —— 这正是"快到了"的反馈带
    const r = resolveSlot(offPerp(2, 35), CENTERS, { occupied: ALL_EMPTY })
    expect(r.armed).toBe(true)
    expect(r.snapped).toBe(false)
  })
})

describe('⑤ 已占用的槽不参与吸附（"这格已经有主了"）', () => {
  const occupied = [true, false, false, false, false, false]

  it('★ 直接指着已占槽的心，会退到最近的那个**空**槽，而不是返回已占槽', () => {
    const r = resolveSlot(CENTERS[0], CENTERS, { occupied })
    expect(r.index).not.toBe(0)
    expect(r.index).toBe(1)
  })

  it('nearestEmptySlot 跳过已占；六槽全满时返回 -1', () => {
    expect(nearestEmptySlot(CENTERS[0], CENTERS, occupied)).toBe(1)
    expect(nearestEmptySlot(CENTERS[0], CENTERS, CENTERS.map(() => true))).toBe(-1)
    expect(nearestEmptySlot(CENTERS[0], CENTERS, ALL_EMPTY)).toBe(0)
  })

  it('emptySlots 只列空槽，且顺序稳定（渲染呼吸循环靠它）', () => {
    const es = emptySlots(CENTERS, occupied)
    expect(es.map((e) => e.index)).toEqual([1, 2, 3, 4, 5])
    expect(es[0].center).toEqual(CENTERS[1])
  })

  it('六槽全满时 nearestEmptyCenter 仍返回一个可用点（绝不返回 null 让上层崩）', () => {
    const c = nearestEmptyCenter(CENTERS[0], CENTERS, CENTERS.map(() => true))
    expect(Number.isFinite(c.x)).toBe(true)
    expect(Number.isFinite(c.y)).toBe(true)
  })

  it('★ 空数组输入不崩（异常输入在底层静默降级）', () => {
    expect(() => resolveSlot(CENTERS[0], [], {})).not.toThrow()
    expect(resolveSlot(CENTERS[0], [], {}).index).toBe(-1)
    expect(resolveSlot(CENTERS[0], [], {}).distance).toBe(Infinity)
  })
})

describe('⑥ 松手的四种结局（规范 §5 引导态 C / D）', () => {
  it('落在槽心 28pt 内 → snap', () => {
    const near: Pt = { x: CENTERS[3].x + 5, y: CENTERS[3].y }
    expect(resolveDrop(near, CENTERS, ALL_EMPTY, CUP)).toEqual({ kind: 'snap', slot: 3 })
  })

  it('★ 拖到竹筒 40pt 内 → revoke（作废，但不扣次数、不计失败）', () => {
    const nearCup: Pt = { x: CUP.x + 20, y: CUP.y + 20 }
    expect(resolveDrop(nearCup, CENTERS, ALL_EMPTY, CUP)).toEqual({ kind: 'revoke' })
  })

  it('★ 停在别处 → stay（不弹回、不报错、保持可拖动）', () => {
    const nowhere: Pt = { x: 40, y: 800 }
    expect(resolveDrop(nowhere, CENTERS, ALL_EMPTY, CUP)).toEqual({ kind: 'stay' })
  })

  it('★ 先判吸附再判反悔：两者都不沾时才是 stay，且吸附优先', () => {
    // 构造一个同时"离某槽 28pt 内"且"离竹筒 40pt 内"的点很难（槽与筒相距很远），
    // 所以这里验语义顺序：把竹筒挪到槽旁边，吸附仍应赢
    const cupNextToSlot: Pt = { x: CENTERS[3].x + 10, y: CENTERS[3].y + 10 }
    const p: Pt = { x: CENTERS[3].x, y: CENTERS[3].y }
    expect(resolveDrop(p, CENTERS, ALL_EMPTY, cupNextToSlot)).toEqual({
      kind: 'snap',
      slot: 3,
    })
  })

  it('★ 全部落点都不返回"失败" —— 结局枚举里根本没有 error 这个分支', () => {
    const outcomes = [
      resolveDrop(CENTERS[0], CENTERS, ALL_EMPTY, CUP),
      resolveDrop(CUP, CENTERS, ALL_EMPTY, CUP),
      resolveDrop({ x: 200, y: 700 }, CENTERS, ALL_EMPTY, CUP),
    ].map((o) => o.kind)
    expect(outcomes.sort()).toEqual(['revoke', 'snap', 'stay'])
    expect(outcomes).not.toContain('error')
  })
})

describe('⑦ 与渲染层的契约：槽心只有一个真源', () => {
  it('resolveSlot 吃的就是渲染用的那六个坐标（没有第二份拷贝）', () => {
    const fromScene = slotCentersPx()
    expect(fromScene).toHaveLength(6)
    // 六个槽心必须沿等距轴单调推进（x 递增、y 递减），否则渲染与算法就错位了
    for (let i = 1; i < fromScene.length; i++) {
      expect(fromScene[i].x).toBeGreaterThan(fromScene[i - 1].x)
      expect(fromScene[i].y).toBeLessThan(fromScene[i - 1].y)
    }
  })
})
