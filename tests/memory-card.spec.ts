/**
 * 记忆浮现卡 · MemoryCardView   tests/memory-card.spec.ts
 * ===========================================================================
 * 对应 M2 任务书「记忆锚点浮现卡」环节：
 *   · 点摆件 → Engine 接管、卡片温柔浮现（不弹系统对话框）
 *   · 数据完全来自 MemoryItem / 本地存储，绝对无网络请求
 *   · 点击卡片外区域 → 优雅淡出 → 退回待机
 *   · 卡片开启时底层降帧（省电防卡顿）
 *
 * ── 为什么这套用例必须存在 ────────────────────────────────────────────────
 *   MemoryCardView 是**独立于 roomMachine.MEMORY_RECALL 的呈现态**：
 *   流程态管「在回看哪条记忆」，相位管「卡片画到哪一步（淡入/常驻/淡出）」。
 *   两者分离后，"点外区域收起"得到的是淡出而不是硬切 —— 但分离也意味着
 *   状态可能卡在 appearing/fading 不退场。这里逐相位钉住生命周期，
 *   并专门证明：连续开关 30 轮、关闭后狂 tick 200 帧，都不泄漏、不卡死、不增长。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import { Engine, MEMORY_CARD_APPEAR_MS, MEMORY_CARD_FADE_MS } from '@core/engine'
import { createMemoryPort } from '@core/persist'
import type { MemoryItem } from '@core/memory/memoryAnchor'

// 与 countdown-memory.spec 同源的"那一天中午"
const T = 1_800_000_000_000
const READ_AT = new Date(2026, 9, 10, 12, 0, 0).getTime()

function mkItem(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'm1',
    createdAt: T,
    readAt: READ_AT,
    kind: 'plant',
    source: { kind: 'liuyao', hexagram: 12, focus: 'CAREER' },
    tone: 'HOPEFUL',
    note: '',
    anchorId: null,
    at: { x: 100, y: 200 },
    ...over,
  }
}

/** 造一个已从本地存储读好记忆、且见过首启引导（直接进 ROOM）的引擎 */
function mkEngine(items: MemoryItem[]) {
  const port = createMemoryPort({
    'xiaobu.memory.v1': items,
    // 记过 FIRST_LAUNCH → boot 后直接 ROOM，不用先走引导
    'xiaobu.guide.v1': ['FIRST_LAUNCH'],
  })
  let now = T
  const engine = new Engine({ port, now: () => now })
  const advance = (ms: number) => {
    now += ms
    engine.tick(now)
  }
  return { engine, advance }
}

/** 与 scene-hit.spec 同款的轻点：down→up，短促无位移 ⇒ TAP */
function tap(engine: Engine, p: { x: number; y: number }): void {
  const t = 10_000
  engine.pointerDown({ id: 0, x: p.x, y: p.y, t })
  engine.pointerUp({ id: 0, x: p.x, y: p.y, t: t + 40 })
}

describe('浮现卡 · 数据完全来自本地，无网络', () => {
  it('★ 点摆件后从本地 MemoryItem 读出三段内容，且流程态进入 MEMORY_RECALL', async () => {
    const { engine } = mkEngine([mkItem()])
    await engine.boot()
    expect(engine.roomState).toBe('ROOM')

    engine.recallMemory('m1')
    const snap = engine.snapshot()

    expect(engine.roomState).toBe('MEMORY_RECALL')
    expect(snap.memory.recall).not.toBeNull()
    // 顶部：日期
    expect(snap.memory.recall!.date).toBe('2026年10月10日')
    // 顶部：心情标签（与战略原文「日期 + 心情标签」一致）
    expect(snap.memory.recall!.moodLabel).toBe('有点期待')
    // 中部：占卜类型含方向维度
    expect(snap.memory.recall!.sourceType).toBe('六爻 · 工作上的事')
    // ★ sourceLabel 这一旧字段不被破坏（既有测试依赖它）
    expect(snap.memory.recall!.sourceLabel).toBe('第 12 卦')
  })

  it('塔罗来源的记忆，中部标签为「塔罗」', async () => {
    const { engine } = mkEngine([
      mkItem({ id: 't1', source: { kind: 'tarot', spreadId: 'past-present-future', cards: [0, 1, 2] } }),
    ])
    await engine.boot()
    engine.recallMemory('t1')
    expect(engine.snapshot().memory.recall!.sourceType).toBe('塔罗')
  })
})

describe('浮现卡 · 相位生命周期（appearing→shown→fading→hidden）', () => {
  it('进入即 appearing；满 APPEAR_MS 转为 shown', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()

    engine.recallMemory('m1')
    expect(engine.snapshot().memoryCard.phase).toBe('appearing')

    advance(MEMORY_CARD_APPEAR_MS + 1)
    expect(engine.snapshot().memoryCard.phase).toBe('shown')
  })

  it('★ 点卡片外区域（任意轻点）→ 进入 fading → 满 FADE_MS 真正退场回 ROOM', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()

    engine.recallMemory('m1')
    advance(MEMORY_CARD_APPEAR_MS + 1)
    expect(engine.snapshot().memoryCard.phase).toBe('shown')

    // 在卡片开启时，画布上任何轻点都只是"收起"
    tap(engine, { x: 5, y: 5 })
    expect(engine.snapshot().memoryCard.phase).toBe('fading')
    // 此刻流程态仍停在 MEMORY_RECALL（淡出还没播完，绝不硬切）
    expect(engine.roomState).toBe('MEMORY_RECALL')

    advance(MEMORY_CARD_FADE_MS + 1)
    const s2 = engine.snapshot()
    expect(s2.memoryCard.phase).toBe('hidden')
    expect(s2.memoryCard.reducedMotion).toBe(false)
    expect(s2.room).toBe('ROOM') // 真正退回待机
    expect(s2.memory.recall).toBeNull() // recalled 已清空
  })

  it('closeRecall 直接调用也走同一淡出路径（API 等价）', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()
    engine.recallMemory('m1')
    advance(MEMORY_CARD_APPEAR_MS + 1)
    engine.closeRecall()
    expect(engine.snapshot().memoryCard.phase).toBe('fading')
    advance(MEMORY_CARD_FADE_MS + 1)
    expect(engine.snapshot().memoryCard.phase).toBe('hidden')
  })
})

describe('浮现卡 · 降帧（省电防卡顿）', () => {
  it('卡片开启时 renderReduced 为真，关闭后恢复', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()
    expect(engine.renderReduced).toBe(false)

    engine.recallMemory('m1')
    expect(engine.renderReduced).toBe(true)
    expect(engine.snapshot().memoryCard.reducedMotion).toBe(true)

    advance(MEMORY_CARD_APPEAR_MS + 1)
    expect(engine.renderReduced).toBe(true) // shown 仍算"开启"

    engine.closeRecall()
    advance(MEMORY_CARD_FADE_MS + 1)
    expect(engine.renderReduced).toBe(false)
  })
})

describe('浮现卡 · 边界与健壮性', () => {
  it('★ 召回不存在的摆件：不抛、不进流程、不现卡', async () => {
    const { engine } = mkEngine([mkItem()])
    await engine.boot()
    expect(() => engine.recallMemory('ghost')).not.toThrow()
    expect(engine.roomState).toBe('ROOM')
    expect(engine.snapshot().memoryCard.phase).toBe('hidden')
    expect(engine.snapshot().memory.recall).toBeNull()
    expect(engine.renderReduced).toBe(false)
  })

  it('在已浮现时召回另一件 → 重新 from appearing 浮现（不残留旧相位）', async () => {
    const { engine, advance } = mkEngine([
      mkItem({ id: 'm1', source: { kind: 'liuyao', hexagram: 12, focus: 'CAREER' } }),
      mkItem({ id: 'm2', kind: 'lantern', source: { kind: 'tarot', spreadId: 'daily-single', cards: [1] } }),
    ])
    await engine.boot()

    engine.recallMemory('m1')
    advance(MEMORY_CARD_APPEAR_MS + 1)
    expect(engine.snapshot().memory.recall!.sourceType).toBe('六爻 · 工作上的事')

    engine.recallMemory('m2') // 切换
    expect(engine.snapshot().memoryCard.phase).toBe('appearing')
    expect(engine.snapshot().memory.recall!.sourceType).toBe('塔罗')
  })
})

describe('浮现卡 · 连续开关不泄漏 / 不增长 / 不卡死', () => {
  it('★ 开→关 30 轮：本地记忆数量不变、相位最终 hidden、无残留', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()

    const before = engine.inspect().memory
    for (let i = 0; i < 30; i++) {
      engine.recallMemory('m1')
      advance(MEMORY_CARD_APPEAR_MS + 1)
      engine.closeRecall()
      advance(MEMORY_CARD_FADE_MS + 1)
    }
    const after = engine.inspect().memory

    expect(after).toBe(before) // 记忆条数丝毫不增（不复制、不堆积）
    expect(engine.snapshot().memoryCard.phase).toBe('hidden')
    expect(engine.snapshot().memory.recall).toBeNull()
    expect(engine.roomState).toBe('ROOM')
  })

  it('关闭后狂 tick 200 帧也不改变状态、不抛异常', async () => {
    const { engine, advance } = mkEngine([mkItem()])
    await engine.boot()
    engine.recallMemory('m1')
    advance(MEMORY_CARD_APPEAR_MS + 1)
    engine.closeRecall()
    advance(MEMORY_CARD_FADE_MS + 1)

    expect(() => {
      for (let i = 0; i < 200; i++) advance(16)
    }).not.toThrow()

    expect(engine.snapshot().memoryCard.phase).toBe('hidden')
    expect(engine.snapshot().memory.items).toHaveLength(1)
    expect(engine.renderReduced).toBe(false)
  })
})
