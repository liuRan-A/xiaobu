/**
 * 场景 → 引擎接线 · 回归测试   tests/scene-hit.spec.ts
 * ===========================================================================
 * 对应 M2 开发任务书「二、边界②」那句：
 *   「`core` 从不接触像素 —— 命中测试由 `EngineOptions.hitTest` 注入，
 *     UI 层知道屏幕布局，core 只知道"命中了什么"。」
 *
 * 这一份测的就是**那句注入语的两端**：
 *   · 一端是 `scene/hit`（`hitTestAt`）—— 像素 → 语义
 *   · 另一端是 `engine.handleTap` —— 语义 → 去哪
 * 中间那条缝最容易出 bug，也最难自查：几何全对、流程全对，但**顺序错了**，
 * 表现为"点了没反应"或"点了跳到别处"。所以下面用力最多的地方是**优先级**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  这一份里最值钱的四条（都是"真出过 / 差点出事"的）
 * ───────────────────────────────────────────────────────────────────────────
 *   ① **命中顺序 = 需求。** 摆件是放在锚点上的，锚点若先判，用户点自己那盆绿植
 *      会被判成"点到茶几" → 进塔罗流程。语义被吃掉，只剩"点了没反应"。
 *   ② **锚点必须按自己的分区进。** `TEA_TABLE`（茶几）声明在 TAROT，
 *      而 `handleTap` 曾经一律 `enterZone('LIUYAO')` —— 点茶几会让人去选心情。
 *      这里钉住它，并且额外证明"用 zoneAt 代替锚点分区"是错的（边界上会判反）。
 *   ③ **脏坐标不抛。** NaN 在设计坐标里真的会出现（见 roomZone 那段留档：
 *      `Math.hypot(NaN, …) > r` 是 false，半径筛选拦不住它）。
 *   ④ **可点域之间不许重叠。** 两枚待机铜钱中心只差 43.3pt —— 铜钱可点半径
 *      一旦被谁"顺手"从 18 调到 22，两个域就重叠，按哪一枚变成亚像素抽奖。
 *      这是一个**不等式形式的断言**，不是拍照对比。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  COIN_TOUCH_R_PT,
  DECK_TOUCH_R_PT,
  MEMORY_TOUCH_R_PT,
  TIMEPIECE_TOUCH_R_PT,
  TUBE_TOUCH_PAD_PT,
  createSceneHitTest,
  hitTestAt,
  idleHitState,
  type HitCircle,
  type SceneHitState,
} from '@scene/hit'
import { COIN_IDLE_PX, TUBE_PX } from '@scene/layers'
import { ANCHORS, getAnchor, zoneAt, type AnchorId, type ZoneId } from '@core/room/roomZone'
import { Engine, type EngineHit } from '@core/engine'
import { createMemoryPort } from '@core/persist'
import { TH } from '@core/ritual/thresholds'
import type { Pt } from '@core/ritual/flight'
import { DESIGN_H, DESIGN_W } from '@scene/renderer'

// ───────────────────────────────────────────────────────────────────────────
// 小工具（测试自带，不用被测代码的实现去验证被测代码）
// ───────────────────────────────────────────────────────────────────────────

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

const anchorPt = (id: AnchorId): Pt => {
  const a = getAnchor(id)
  if (!a) throw new Error(`锚点 ${id} 不存在`)
  return a.at
}

/** 竹筒外接框中心 —— 用真实 TUBE_PX 算，不手抄 */
const TUBE_MID: Pt = { x: TUBE_PX.x + TUBE_PX.w / 2, y: TUBE_PX.y + TUBE_PX.h / 2 }

/** 合法的命中值域 —— 用来断言"任何输入都得到这七种之一" */
const KINDS = ['coin', 'tube', 'deck', 'anchor', 'memory', 'timepiece', 'none'] as const

function withState(patch: Partial<SceneHitState>): SceneHitState {
  return { ...idleHitState(), ...patch }
}

/** 造一个"引擎 + 指定命中函数"，并推到可交互的 ROOM 态 */
async function mkEngine(hit: (p: Pt) => EngineHit): Promise<Engine> {
  const engine = new Engine({ port: createMemoryPort(), hitTest: hit, now: () => 1_800_000_000_000 })
  await engine.boot()
  return engine
}

/** 走一次完整的轻点（按下 → 40ms 后抬起，位移 0 ⇒ 一定是 TAP） */
function tap(engine: Engine, p: Pt): void {
  const t = 10_000
  engine.pointerDown({ id: 0, x: p.x, y: p.y, t })
  engine.pointerUp({ id: 0, x: p.x, y: p.y, t: t + 40 })
}

// ═══════════════════════════════════════════════════════════════════════════
// 一、开场状态
// ═══════════════════════════════════════════════════════════════════════════

describe('idleHitState · 开场那一刻屋子里有什么', () => {
  it('就是桌面上那两枚待机铜钱，竹筒在场，其余空空', () => {
    const s = idleHitState()
    expect(s.coins).toHaveLength(COIN_IDLE_PX.length)
    s.coins.forEach((c, i) => {
      expect(c.x).toBe(COIN_IDLE_PX[i].x)
      expect(c.y).toBe(COIN_IDLE_PX[i].y)
    })
    expect(s.tubeVisible).toBe(true)
    // ★ 牌堆与摆件在 M2 开场时都不存在 —— 这不是"忘了写"，是设计稿还没到
    expect(s.deck).toBeNull()
    expect(s.memory).toEqual([])
    expect(s.timepiece).toEqual([])
  })

  it('★ 返回的是**复制**，改它不会污染下一次调用（否则开场状态会被永久改写）', () => {
    const a = idleHitState()
    const b = idleHitState()
    // 数组本身与每个元素都得是新的一份 —— 少一层复制就会串味
    expect(a.coins).not.toBe(b.coins)
    expect(a.coins[0]).not.toBe(b.coins[0])

    a.coins[0].x = -999
    a.tubeVisible = false

    const c = idleHitState()
    expect(c.coins).toHaveLength(COIN_IDLE_PX.length)
    expect(c.coins[0].x).toBe(COIN_IDLE_PX[0].x)
    expect(c.tubeVisible).toBe(true)
    // 先拿到的那一份也不受后改的影响
    expect(b.coins[0].x).toBe(COIN_IDLE_PX[0].x)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 二、可点域的结构性约束（不等式断言，不是拍照对比）
// ═══════════════════════════════════════════════════════════════════════════

describe('可点域 · 结构性约束', () => {
  it('★ 两枚待机铜钱的可点域**不重叠**（中心距 43.3pt > 18 + 18）', () => {
    const d = dist(COIN_IDLE_PX[0], COIN_IDLE_PX[1])
    expect(d).toBeGreaterThan(COIN_TOUCH_R_PT * 2)
  })

  it('★ 任意两个锚点的可点域不重叠 —— 这是"点在自己域内一定命中自己"的前提', () => {
    for (let i = 0; i < ANCHORS.length; i++) {
      for (let j = i + 1; j < ANCHORS.length; j++) {
        const gap = dist(ANCHORS[i].at, ANCHORS[j].at)
        const need = ANCHORS[i].radius + ANCHORS[j].radius
        expect(gap, `${ANCHORS[i].id} 与 ${ANCHORS[j].id} 的可点域重叠了`).toBeGreaterThan(need)
      }
    }
  })

  it('铜钱的可点域不吞掉竹筒 —— 否则"想拿铜钱"会先命中竹筒', () => {
    const pad = TUBE_TOUCH_PAD_PT
    for (const c of COIN_IDLE_PX) {
      // 铜钱心到竹筒外接框（含外扩）的最近距离
      const nx = Math.max(TUBE_PX.x - pad - c.x, 0, c.x - (TUBE_PX.x + TUBE_PX.w + pad))
      const ny = Math.max(TUBE_PX.y - pad - c.y, 0, c.y - (TUBE_PX.y + TUBE_PX.h + pad))
      expect(Math.hypot(nx, ny), `铜钱 ${JSON.stringify(c)} 落在竹筒可点域里`).toBeGreaterThan(
        COIN_TOUCH_R_PT,
      )
    }
  })

  it('可点域半径都满足"≥ 44pt 可点区域要求"的常识下限（除了刻意更小的摆件）', () => {
    // 铜钱视觉只有 22×11pt，但可点域必须远大于它 —— 这是"掷币不能变成抽奖"的底线
    expect(COIN_TOUCH_R_PT).toBeGreaterThan(11)
    expect(TIMEPIECE_TOUCH_R_PT).toBeGreaterThan(11)
    expect(MEMORY_TOUCH_R_PT).toBeGreaterThanOrEqual(16)
    // 摆件是有记忆、照着位置去点的小东西，可以略小于 18，但不该小于 16
    expect(DECK_TOUCH_R_PT).toBeGreaterThan(TIMEPIECE_TOUCH_R_PT)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 三、命中优先级（本文件最核心的一段）
// ═══════════════════════════════════════════════════════════════════════════

describe('命中优先级 · 顺序错了就是 bug', () => {
  /** 故意把五类物件**全部堆在同一个点上**，用来一次判别顺序 */
  const CROWD: Pt = { x: 300, y: 636 } // 茶几锚点，也是塔罗区中心（2026-10-10 移到右前角）
  const crowded = (): SceneHitState =>
    withState({
      coins: [CROWD],
      tubeVisible: true,
      deck: { id: 'deck-1', at: CROWD },
      memory: [{ id: 'm1', at: CROWD }],
      timepiece: [{ id: 't1', at: CROWD }],
    })

  it('★ 记忆锚点 > 倒计时摆件 > 铜钱 > 竹筒 > 牌堆 > 锚点（同一位置的完整顺序）', () => {
    const s = crowded()
    expect(hitTestAt(CROWD, s)).toEqual({ kind: 'memory', id: 'm1' })

    // 拿掉记忆锚点 → 轮到倒计时摆件
    expect(hitTestAt(CROWD, { ...s, memory: [] })).toEqual({ kind: 'timepiece', id: 't1' })

    // 再拿掉倒计时 → 轮到铜钱
    expect(hitTestAt(CROWD, { ...s, memory: [], timepiece: [] })).toEqual({ kind: 'coin', coinId: 0 })

    // 再拿掉铜钱 → 轮到牌堆（竹筒离得远，此处不参与）
    expect(hitTestAt(CROWD, { ...s, memory: [], timepiece: [], coins: [] })).toEqual({ kind: 'deck' })

    // 再拿掉牌堆 → 才轮到锚点
    const onlyAnchor = { ...s, memory: [], timepiece: [], coins: [], deck: null }
    expect(hitTestAt(CROWD, onlyAnchor)).toEqual({ kind: 'anchor', id: 'TEA_TABLE' })
  })

  it('★ 摆件放在锚点上时，点它**必须回放记忆**而不是"进分区"', () => {
    // 这是本条优先级存在的全部理由：摆件与锚点同心
    const s = withState({ memory: [{ id: 'plant-1', at: anchorPt('TEA_TABLE') }] })
    const hit = hitTestAt(anchorPt('TEA_TABLE'), s)
    expect(hit).toEqual({ kind: 'memory', id: 'plant-1' })
    expect(hit.kind).not.toBe('anchor')
  })

  it('★ 铜钱压在竹筒上时命中铜钱 —— 顺序反了掷币就永远起不来', () => {
    // 引擎只在 pressHit.kind === 'coin' 时才把 LONG_PRESS 转给仪式机，
    // 所以"铜钱 vs 竹筒"这个顺序是功能性的，不是手感偏好。
    const s = withState({ coins: [TUBE_MID], tubeVisible: true })
    expect(hitTestAt(TUBE_MID, s)).toEqual({ kind: 'coin', coinId: 0 })
  })

  it('牌堆压在自己那张茶几上时命中牌堆（同区，但语义更具体）', () => {
    const s = withState({ deck: { id: 'deck-1', at: anchorPt('TEA_TABLE') } })
    expect(hitTestAt(anchorPt('TEA_TABLE'), s)).toEqual({ kind: 'deck' })
  })

  it('摆件的半径可以逐件覆盖（大摆件给小摆件让路时不必改全局常量）', () => {
    const big: HitCircle = { id: 'big', at: { x: 100, y: 100 }, r: 40 }
    const small: HitCircle = { id: 'small', at: { x: 120, y: 100 }, r: 10 }
    // 只带大摆件时，点在 (120,100) 命中的是大摆件
    expect(hitTestAt({ x: 120, y: 100 }, withState({ memory: [big] }))).toEqual({
      kind: 'memory',
      id: 'big',
    })
    // 加上小摆件后，同一个点改为命中更近的小摆件
    expect(hitTestAt({ x: 120, y: 100 }, withState({ memory: [big, small] }))).toEqual({
      kind: 'memory',
      id: 'small',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 四、逐类物件的可点域
// ═══════════════════════════════════════════════════════════════════════════

describe('铜钱', () => {
  it('两枚待机铜钱各自命中，coinId 就是它在数组里的下标', () => {
    const s = idleHitState()
    expect(hitTestAt(COIN_IDLE_PX[0], s)).toEqual({ kind: 'coin', coinId: 0 })
    expect(hitTestAt(COIN_IDLE_PX[1], s)).toEqual({ kind: 'coin', coinId: 1 })
  })

  it('刚好在可点半径上算命中，超出一点就不算（边界不是模糊的）', () => {
    const c: Pt = { x: 196, y: 452 }
    const s = withState({ coins: [c] })
    expect(hitTestAt({ x: c.x + COIN_TOUCH_R_PT, y: c.y }, s)).toEqual({ kind: 'coin', coinId: 0 })
    expect(hitTestAt({ x: c.x + COIN_TOUCH_R_PT + 0.01, y: c.y }, s).kind).not.toBe('coin')
  })

  it('两枚铜钱中点：离得一样远 ⇒ 取下标更小者（摇摆不定比选错一格更糟）', () => {
    // ★ 两枚必须都落在各自的可点域内 —— 否则这条测的就不是"并列"，而是"都够不着"。
    //   曾经写成相距 100pt 的两枚，结果两边都超出 18pt 的可点域，判成了 none。
    const a: Pt = { x: 100, y: 200 }
    const b: Pt = { x: 100 + COIN_TOUCH_R_PT * 2, y: 200 }
    const probe: Pt = { x: 100 + COIN_TOUCH_R_PT, y: 200 }
    expect(dist(probe, a)).toBe(COIN_TOUCH_R_PT)
    expect(dist(probe, b)).toBe(COIN_TOUCH_R_PT)

    const s = withState({ coins: [a, b] })
    expect(hitTestAt(probe, s)).toEqual({ kind: 'coin', coinId: 0 })
    // 顺序反过来时，取的是新的 0 号 —— 说明它取的是"下标更小"而不是"固定原来那枚"
    expect(hitTestAt(probe, withState({ coins: [b, a] }))).toEqual({ kind: 'coin', coinId: 0 })
  })

  it('铜钱飞走后原位置不再命中（命中判定读的是当前位置，不是"曾在那里的东西"）', () => {
    const s = withState({ coins: [{ x: 999, y: 999 }] })
    expect(hitTestAt(COIN_IDLE_PX[0], s).kind).not.toBe('coin')
  })

  it('铜钱为空时什么都不命中，也不抛', () => {
    const s = withState({ coins: [] })
    for (const p of COIN_IDLE_PX) expect(() => hitTestAt(p, s)).not.toThrow()
    expect(hitTestAt(COIN_IDLE_PX[0], s).kind).not.toBe('coin')
  })
})

describe('竹筒（唯一用矩形判定的物件）', () => {
  it('外接框内命中', () => {
    expect(hitTestAt(TUBE_MID, idleHitState())).toEqual({ kind: 'tube' })
  })

  it('★ 两个上角也命中 —— 用圆判定会把筒口那两角切掉，而用户戳的正是那里', () => {
    const s = idleHitState()
    const topLeft: Pt = { x: TUBE_PX.x + 1, y: TUBE_PX.y + 1 }
    const topRight: Pt = { x: TUBE_PX.x + TUBE_PX.w - 1, y: TUBE_PX.y + 1 }
    // 这两个点到框心的距离都超过内切圆半径，圆判定必然漏
    expect(hitTestAt(topLeft, s)).toEqual({ kind: 'tube' })
    expect(hitTestAt(topRight, s)).toEqual({ kind: 'tube' })
  })

  it('外扩 8pt 之外不再命中（外扩量是有限的，不会吞掉半个桌面）', () => {
    const s = idleHitState()
    const inside: Pt = { x: TUBE_PX.x - TUBE_TOUCH_PAD_PT + 0.5, y: TUBE_MID.y }
    const outside: Pt = { x: TUBE_PX.x - TUBE_TOUCH_PAD_PT - 0.5, y: TUBE_MID.y }
    expect(hitTestAt(inside, s)).toEqual({ kind: 'tube' })
    expect(hitTestAt(outside, s).kind).not.toBe('tube')
  })

  it('★ 竹筒不在场时（被拿起 / 收进筒）原位置不再命中', () => {
    const s = withState({ tubeVisible: false })
    expect(hitTestAt(TUBE_MID, s).kind).not.toBe('tube')
  })
})

describe('放置锚点', () => {
  it('四个锚点的中心各自命中自己', () => {
    const s = idleHitState()
    for (const a of ANCHORS) {
      expect(hitTestAt(a.at, s), `${a.id} 中心没命中自己`).toEqual({ kind: 'anchor', id: a.id })
    }
  })

  it('★ 每个锚点的**整个可点域**都命中它自己（可点域不重叠的直接推论）', () => {
    const s = idleHitState()
    for (const a of ANCHORS) {
      for (let k = 0; k < 16; k++) {
        const ang = (Math.PI * 2 * k) / 16
        const p: Pt = {
          x: a.at.x + Math.cos(ang) * (a.radius - 0.5),
          y: a.at.y + Math.sin(ang) * (a.radius - 0.5),
        }
        expect(hitTestAt(p, s), `${a.id} 域内 ${JSON.stringify(p)} 没命中自己`).toEqual({
          kind: 'anchor',
          id: a.id,
        })
      }
    }
  })

  it('★ 锚点可点域不跨出自己声明的分区 —— 用 zoneAt 独立复核一遍', () => {
    // 这条不变量让"点茶几一定在塔罗区、点木桌不一定（见下一条）"可以被解释清楚
    const s = idleHitState()
    const got = new Map<AnchorId, Set<ZoneId | null>>()
    for (const a of ANCHORS) {
      const set = new Set<ZoneId | null>()
      for (let dx = -a.radius; dx <= a.radius; dx += 4) {
        for (let dy = -a.radius; dy <= a.radius; dy += 4) {
          const p: Pt = { x: a.at.x + dx, y: a.at.y + dy }
          if (dist(p, a.at) > a.radius) continue
          const hit = hitTestAt(p, s)
          if (hit.kind !== 'anchor' || hit.id !== a.id) continue
          set.add(zoneAt(p))
        }
      }
      got.set(a.id, set)
    }
    // 茶几（52pt 域）完全落在塔罗区内
    expect([...got.get('TEA_TABLE')!].every((z) => z === 'TAROT')).toBe(true)
  })
})

describe('牌堆（美术稿到位前恒为 null）', () => {
  it('默认不在场：戳毯子落到 none，之后由 zoneAt 兜底进塔罗区', () => {
    const felt: Pt = { x: 300, y: 700 }
    const hit = hitTestAt(felt, idleHitState())
    expect(hit).toEqual({ kind: 'none' })
    // ★ 兜底链是完好的：none → zoneAt → TAROT。所以"牌堆还没画"不会让毯子变哑
    expect(zoneAt(felt)).toBe('TAROT')
  })

  it('在场时按自己的半径命中，且**优先于**锚点', () => {
    const deck: HitCircle = { id: 'deck-1', at: { x: 300, y: 636 } }
    const s = withState({ deck })
    expect(hitTestAt(deck.at, s)).toEqual({ kind: 'deck' })
    expect(hitTestAt({ x: deck.at.x + DECK_TOUCH_R_PT - 1, y: deck.at.y }, s)).toEqual({
      kind: 'deck',
    })
    expect(hitTestAt({ x: deck.at.x + DECK_TOUCH_R_PT + 1, y: deck.at.y }, s).kind).not.toBe('deck')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 五、脏输入与全域扫描（"绝不抛"是可执行断言，不是口号）
// ═══════════════════════════════════════════════════════════════════════════

describe('脏坐标 · 不许抛、不许返回 undefined', () => {
  const BAD: Pt[] = [
    { x: NaN, y: NaN },
    { x: NaN, y: 100 },
    { x: 100, y: NaN },
    { x: Infinity, y: 0 },
    { x: -Infinity, y: 100 },
    { x: 0, y: -Infinity },
    { x: -1e9, y: -1e9 },
    { x: 1e9, y: 1e9 },
  ]

  it('★ 全部返回 none，且不抛（NaN 会绕过半径筛选，只能靠入口挡）', () => {
    const s = withState({
      coins: [{ x: 100, y: 100 }],
      memory: [{ id: 'm', at: { x: 100, y: 100 } }],
      timepiece: [{ id: 't', at: { x: 100, y: 100 } }],
      deck: { id: 'd', at: { x: 100, y: 100 } },
    })
    for (const p of BAD) {
      expect(() => hitTestAt(p, s), `${JSON.stringify(p)} 抛了`).not.toThrow()
      expect(hitTestAt(p, s), `${JSON.stringify(p)} 应当什么都没有`).toEqual({ kind: 'none' })
    }
  })

  it('★ 物件坐标本身是 NaN 时也不抛，只是那个物件不参与命中', () => {
    const s = withState({
      coins: [{ x: NaN, y: NaN }],
      memory: [{ id: 'm', at: { x: NaN, y: 0 } }],
      timepiece: [{ id: 't', at: { x: Infinity, y: 0 } }],
      deck: { id: 'd', at: { x: NaN, y: 0 } },
    })
    expect(() => hitTestAt({ x: 100, y: 100 }, s)).not.toThrow()
    expect(hitTestAt({ x: 100, y: 100 }, s).kind).not.toBe('memory')
    expect(hitTestAt({ x: 100, y: 100 }, s).kind).not.toBe('timepiece')
    expect(hitTestAt({ x: 100, y: 100 }, s).kind).not.toBe('deck')
  })
})

describe('全画布扫描 · 任何一点都要有合法结局', () => {
  it('★ 每个点都返回七种 kind 之一，且返回的物件确实覆盖了这个点', () => {
    const s = withState({
      coins: [{ x: 196, y: 452 }, { x: 232, y: 476 }],
      memory: [{ id: 'm1', at: anchorPt('WINDOW_SILL') }],
      timepiece: [{ id: 't1', at: { x: 300, y: 700 } }],
      deck: { id: 'deck-1', at: { x: 300, y: 636 } },
    })

    const seen = new Set<string>()

    for (let x = 0; x <= DESIGN_W; x += 3) {
      for (let y = 0; y <= DESIGN_H; y += 7) {
        const p: Pt = { x, y }
        expect(() => hitTestAt(p, s), `(${x}, ${y}) 抛了`).not.toThrow()

        const hit: EngineHit = hitTestAt(p, s)
        expect(KINDS, `(${x}, ${y}) 返回了非法 kind=${hit.kind}`).toContain(hit.kind)
        seen.add(hit.kind)

        // 返回什么，就必须真的覆盖了这个点 —— 这是"没有幽灵命中"的断言
        switch (hit.kind) {
          case 'coin':
            expect(dist(p, s.coins[hit.coinId]), `(${x},${y}) 的铜钱命中不自洽`).toBeLessThanOrEqual(
              COIN_TOUCH_R_PT + 1e-9,
            )
            break
          case 'memory':
            expect(dist(p, s.memory[0].at)).toBeLessThanOrEqual(MEMORY_TOUCH_R_PT + 1e-9)
            break
          case 'timepiece':
            expect(dist(p, s.timepiece[0].at)).toBeLessThanOrEqual(TIMEPIECE_TOUCH_R_PT + 1e-9)
            break
          case 'deck':
            expect(dist(p, s.deck!.at)).toBeLessThanOrEqual(DECK_TOUCH_R_PT + 1e-9)
            break
          case 'anchor': {
            const a = getAnchor(hit.id)
            expect(a, `(${x},${y}) 命中了不存在的锚点 ${hit.id}`).not.toBeNull()
            expect(dist(p, a!.at)).toBeLessThanOrEqual(a!.radius + 1e-9)
            break
          }
          case 'tube': {
            const pad = TUBE_TOUCH_PAD_PT
            expect(p.x).toBeGreaterThanOrEqual(TUBE_PX.x - pad - 1e-9)
            expect(p.x).toBeLessThanOrEqual(TUBE_PX.x + TUBE_PX.w + pad + 1e-9)
            break
          }
          default:
            break
        }
      }
    }

    // 五类物件与锚点、空格子都得在扫描里出现过 —— 否则说明有一类根本点不到
    for (const k of ['coin', 'tube', 'deck', 'anchor', 'memory', 'timepiece', 'none']) {
      expect(seen.has(k), `扫描里从未出现过 ${k}`).toBe(true)
    }
  })

  it('房间外的点（负坐标、超出 390×844）不会命中锚点或道具，也不会抛', () => {
    const s = idleHitState()
    for (const p of [
      { x: -50, y: 400 },
      { x: 500, y: 400 },
      { x: 195, y: -50 },
      { x: 195, y: 900 },
    ]) {
      expect(() => hitTestAt(p, s)).not.toThrow()
      const hit = hitTestAt(p, s)
      expect(['none', 'tube']).toContain(hit.kind)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 六、给引擎用的闭包
// ═══════════════════════════════════════════════════════════════════════════

describe('createSceneHitTest · 闭包契约', () => {
  it('★ 每次判定都**重新取一次**状态，绝不缓存（铜钱每帧都在动）', () => {
    let state = withState({ coins: [{ x: 100, y: 100 }] })
    const hit = createSceneHitTest(() => state)

    expect(hit({ x: 100, y: 100 })).toEqual({ kind: 'coin', coinId: 0 })

    // 铜钱飞走了 —— 同一个闭包必须立刻反映出来
    state = withState({ coins: [{ x: 300, y: 700 }] })
    expect(hit({ x: 100, y: 100 }).kind).not.toBe('coin')
    expect(hit({ x: 300, y: 700 })).toEqual({ kind: 'coin', coinId: 0 })
  })

  it('状态在两次调用之间被换掉时，结果跟着换（不是"建闭包时快照一次"）', () => {
    let state = withState({ memory: [{ id: 'a', at: { x: 50, y: 50 } }] })
    const hit = createSceneHitTest(() => state)
    expect(hit({ x: 50, y: 50 })).toEqual({ kind: 'memory', id: 'a' })
    state = withState({ memory: [{ id: 'b', at: { x: 50, y: 50 } }] })
    expect(hit({ x: 50, y: 50 })).toEqual({ kind: 'memory', id: 'b' })
    state = withState({})
    expect(hit({ x: 50, y: 50 }).kind).not.toBe('memory')
  })

  it('★ 取状态的函数抛异常时返回 none —— 命中测试是最外层输入，它崩了手势会全程丢失', () => {
    const hit = createSceneHitTest(() => {
      throw new Error('boom')
    })
    expect(() => hit({ x: 100, y: 100 })).not.toThrow()
    expect(hit({ x: 100, y: 100 })).toEqual({ kind: 'none' })
  })

  it('确定性：同一组输入永远同一组输出（重放 3 次结果一致）', () => {
    const s = withState({
      coins: [{ x: 196, y: 452 }],
      memory: [{ id: 'm', at: anchorPt('TABLE_TOP') }],
    })
    const first = JSON.stringify(hitTestAt(anchorPt('TABLE_TOP'), s))
    for (let i = 0; i < 3; i++) {
      expect(JSON.stringify(hitTestAt(anchorPt('TABLE_TOP'), s))).toBe(first)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 七、语义 → 去哪（`engine.handleTap`）
// ═══════════════════════════════════════════════════════════════════════════

describe('引擎接线 · 语义决定了去哪', () => {
  const stateWith = (patch: Partial<SceneHitState> = {}): SceneHitState => withState(patch)
  const mkHit = (s: SceneHitState) => (p: Pt): EngineHit => hitTestAt(p, s)

  it('★ 点茶几（TEA_TABLE 声明在 TAROT）必须进塔罗，而不是六爻', async () => {
    // 这里曾经是错的：`case 'anchor'` 一律 enterZone('LIUYAO')，
    // 于是"在茶几上点一下"会让用户去选今天的心情 —— 而他是想翻牌的。
    const engine = await mkEngine(mkHit(stateWith()))
    expect(engine.roomState).not.toBe('BOOT')

    tap(engine, anchorPt('TEA_TABLE'))
    expect(engine.roomState).toBe('SPREAD_PICK')
    expect(engine.snapshot().zone).toBe('TAROT')
  })

  it('★ 点木桌/窗边/毯边仍然进六爻（按锚点自己的 zone，不是按几何分区）', async () => {
    for (const id of ['TABLE_TOP', 'WINDOW_SILL', 'CENSER_SIDE'] as const) {
      const engine = await mkEngine(mkHit(stateWith()))
      tap(engine, anchorPt(id))
      expect(engine.roomState, `${id} 没进六爻`).toBe('MOOD_PICK')
      expect(engine.snapshot().zone).toBe('LIUYAO')
    }
  })

  it('★ 木桌锚点域的**外沿**也进六爻 —— 这里 zoneAt 会判成塔罗，锚点分区才是权威', async () => {
    // 这条是"为什么不能用 zoneAt(at) 代替锚点自己的 zone"的实证。
    // 木桌锚点圆心 (195,612)、半径 44，取它朝塔罗区的**右沿** x = 195 + 44 = 239；
    // 该点落在塔罗圆（圆心 300,636、半径 100）内 —— 距塔罗圆心 65.6pt，
    // 按"半径小的赢"算出来是 TAROT。用 zoneAt 代替 → 用户点木桌右沿会被送进塔罗。
    const edge: Pt = { x: 239, y: 612 }
    const a = getAnchor('TABLE_TOP')
    expect(a).not.toBeNull()
    expect(dist(edge, a!.at)).toBeLessThanOrEqual(a!.radius + 1e-9)

    // 先证明"这个点上 zoneAt 确实与锚点分区不一致"，否则这条测试是空转的
    expect(zoneAt(edge)).toBe('TAROT')
    expect(a!.zone).toBe('LIUYAO')

    const engine = await mkEngine(mkHit(stateWith()))
    tap(engine, edge)
    expect(engine.roomState).toBe('MOOD_PICK')
  })

  it('点待机铜钱会把人领到六爻的第一步（"想掷币"这件事得先选心情）', async () => {
    const engine = await mkEngine(mkHit(stateWith()))
    tap(engine, COIN_IDLE_PX[0])
    expect(engine.roomState).toBe('MOOD_PICK')
    expect(engine.snapshot().zone).toBe('LIUYAO')
  })

  it('点竹筒同样进六爻', async () => {
    const engine = await mkEngine(mkHit(stateWith()))
    tap(engine, TUBE_MID)
    expect(engine.roomState).toBe('MOOD_PICK')
  })

  it('点牌堆进塔罗（美术稿到位后这条路径就会真的被走到）', async () => {
    const deckAt: Pt = { x: 300, y: 636 }
    const engine = await mkEngine(mkHit(stateWith({ deck: { id: 'deck-1', at: deckAt } })))
    tap(engine, deckAt)
    expect(engine.roomState).toBe('SPREAD_PICK')
  })

  it('点倒计时摆件直接开设定面板（它是全屏唯一入口）', async () => {
    const at: Pt = { x: 300, y: 700 }
    const engine = await mkEngine(mkHit(stateWith({ timepiece: [{ id: 'cd-1', at }] })))
    tap(engine, at)
    expect(engine.roomState).toBe('COUNTDOWN_SET')
  })

  it('★ 点一件引擎里不存在的摆件：静默忽略、不抛、房间照旧（不做任何"找不到"的反馈）', async () => {
    const at: Pt = { x: 120, y: 300 }
    const engine = await mkEngine(mkHit(stateWith({ memory: [{ id: 'ghost', at }] })))
    expect(() => tap(engine, at)).not.toThrow()
    expect(engine.roomState).toBe('ROOM')
  })

  it('戳空地毯（none）会经 zoneAt 兜底进塔罗 —— "随便点一下也有回应"', async () => {
    const felt: Pt = { x: 300, y: 700 }
    expect(idleHitState().deck).toBeNull()
    const engine = await mkEngine(mkHit(stateWith()))
    tap(engine, felt)
    expect(engine.roomState).toBe('SPREAD_PICK')
    expect(engine.snapshot().zone).toBe('TAROT')
  })

  it('戳墙（超出两个分区）什么都不会发生，也**不会弹任何提示**', async () => {
    const wall: Pt = { x: 380, y: 60 }
    expect(zoneAt(wall)).toBeNull()
    const engine = await mkEngine(mkHit(stateWith()))
    tap(engine, wall)
    expect(engine.roomState).toBe('ROOM')
    expect(engine.snapshot().zone).toBeNull()
  })

  it('★ 命中函数自己抛异常时，引擎照常活着（safeHit 兜住，退化成"没戳到"再走分区兜底）', async () => {
    const engine = await mkEngine(() => {
      throw new Error('hit boom')
    })
    expect(() => tap(engine, { x: 100, y: 300 })).not.toThrow()
    // (100,300) 在六爻区里（离桌心 195pt），所以兜底之后应该进六爻 —— 而不是卡死
    expect(engine.roomState).toBe('MOOD_PICK')
  })

  it('★ 脏坐标（NaN）连一次轻点都构不成 —— 房间停在原处，不抛，也不乱跳', async () => {
    const engine = await mkEngine(mkHit(stateWith()))
    const before = engine.roomState
    expect(() => tap(engine, { x: NaN, y: NaN })).not.toThrow()

    // ★ 这里记录的是真实的降级路径（不是愿望）：
    //   手势层算净位移时 `Math.hypot(NaN, …)` 是 NaN，而 `NaN <= TAP_MAX_MOVE_PT` 是 false
    //   —— 于是这一下**既不是 TAP 也不是有效 RELEASE**，引擎收不到任何语义事件。
    //   结果就是"什么都没发生"：房间仍停在首启引导里，等着用户真的点一下。
    //   这比"伪造一个 (0,0)"好得多 —— 后者会被当成"用户在左上角按了一下"。
    expect(engine.roomState).toBe(before)
    expect(before).toBe('GUIDE')

    // 脏输入没有把状态写坏：紧接着一次正常点击照常生效
    tap(engine, anchorPt('TEA_TABLE'))
    expect(engine.roomState).toBe('SPREAD_PICK')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 八、装配层（`store/engineHost`）
// ═══════════════════════════════════════════════════════════════════════════

describe('engineHost · 单例与活状态', () => {
  it('★ 反复取都是同一个引擎（两台状态机是模块级单例，建两个会串味）', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    const a = host.getEngine()
    const b = host.getEngine()
    expect(b).toBe(a)
    expect(host.getEngine()).toBe(a)
    host.resetEngineHost()
  })

  it('boot 只生效一次：重复 boot 不会把房间退回 BOOT', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    await host.bootEngine()
    const s1 = host.getEngine().roomState
    expect(s1).not.toBe('BOOT')
    await host.bootEngine()
    expect(host.getEngine().roomState).toBe(s1)
    host.resetEngineHost()
  })

  it('★ 场景层推进来的活位置**当场生效** —— 命中不走快照，没有一帧延迟', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    await host.bootEngine()

    /** 每个探针都用一个新引擎：两台状态机是模块级单例，不换会沿用上一个流程 */
    const engineReadingLiveScene = async (): Promise<Engine> => {
      const e = new Engine({
        port: createMemoryPort(),
        hitTest: (p) => hitTestAt(p, host.sceneState()),
        now: () => 1_800_000_000_000,
      })
      await e.boot()
      return e
    }

    // ── 探针 A：牌堆 ─────────────────────────────────────────────────────
    // 毯边 (96,640) 在**六爻区**里，且正好压着 CENSER_SIDE 锚点 ——
    // 于是"看见牌堆"与"看不见牌堆"会走向完全不同的两条支线，判别力最强。
    const censer = anchorPt('CENSER_SIDE')
    host.setDeck(null)
    const eA = await engineReadingLiveScene()
    tap(eA, censer)
    expect(eA.roomState, '没有牌堆时，毯边应当走六爻').toBe('MOOD_PICK')

    host.setDeck({ id: 'deck-x', at: censer })
    const eB = await engineReadingLiveScene()
    // ★ 关键：`setDeck` 之后没有任何"刷新"调用 —— 下一次判定就该看见它
    tap(eB, censer)
    expect(eB.roomState, '放上牌堆后，同一个点应当改成翻牌').toBe('SPREAD_PICK')

    // ── 探针 B：铜钱 ─────────────────────────────────────────────────────
    // 把一枚铜钱挪到茶几上。铜钱的语义固定是"想掷币"（进六爻），
    // 而茶几锚点的语义是"想翻牌"（进塔罗）—— 同一个点，两种结局，全看铜钱在哪。
    host.setDeck(null)
    const tea = anchorPt('TEA_TABLE')
    host.setLiveCoins([{ x: 999, y: 999 }]) // 先挪开，断言下面的基线
    const eC = await engineReadingLiveScene()
    tap(eC, tea)
    expect(eC.roomState, '铜钱不在茶几上时，点茶几应当翻牌').toBe('SPREAD_PICK')

    host.setLiveCoins([tea]) // 铜钱挪到茶几上
    const eD = await engineReadingLiveScene()
    tap(eD, tea)
    expect(eD.roomState, '铜钱挪到茶几上后，同一个点应当变成"想掷币"').toBe('MOOD_PICK')

    host.resetEngineHost()
  })

  it('resetEngineHost 会把活状态与单例一起退回开场（不提它，用例之间会互相串味）', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    await host.bootEngine()
    host.setLiveCoins([{ x: 1, y: 2 }])
    host.setTubeVisible(false)
    host.setDeck({ id: 'd', at: { x: 3, y: 4 } })

    host.resetEngineHost()
    const s = host.sceneState()
    expect(s.tubeVisible).toBe(true)
    expect(s.deck).toBeNull()
    expect(s.coins[0].x).toBe(COIN_IDLE_PX[0].x)
  })

  it('tickEngine 在没有引擎时是安全的空操作（首帧早于 boot 也能调）', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    expect(() => host.tickEngine()).not.toThrow()
    await expect(host.flushEngine()).resolves.toBeUndefined()
  })

  it('★ 起飞回调抛异常也不会冒泡，而且**掷币照常发生**（动画起不来 ≠ 掷币失败）', async () => {
    const host = await import('@store/engineHost')
    host.resetEngineHost()
    const engine = await host.bootEngine()

    host.setTossHandler(() => {
      throw new Error('anim boom')
    })

    // 走完整条六爻前置流程，进到 RITUAL —— 摇晃才有意义
    engine.enterZone('LIUYAO')
    engine.pickMood('CALM')
    engine.pickFocus('CAREER')
    engine.placeItem('TABLE_TOP', anchorPt('TABLE_TOP'))
    expect(engine.roomState).toBe('RITUAL')
    expect(engine.ritualState).toBe('IDLE')

    // 摇晃 = 幅度 + 持续 + 冷却 三条件。第一次只起算，第二次（+90ms ≥ 80ms）才发 SHAKE
    engine.motion(TH.SHAKE_G + 1, 1_000)
    expect(() => engine.motion(TH.SHAKE_G + 1, 1_090)).not.toThrow()
    // ★ 这是本条的要点：回调炸了，仪式依然从 IDLE 走到了 TOSS
    expect(engine.ritualState).toBe('TOSS')

    host.resetEngineHost()
  })
})
