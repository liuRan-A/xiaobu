/**
 * 记忆锚点与倒计时 · 回归测试   tests/countdown-memory.spec.ts
 * ===========================================================================
 * 对应 M2 任务书「三、灵魂机制：记忆锚点与倒计时（情绪羁绊）」。
 *
 * 这一节是整个产品最容易做"薄"的部分。它很容易被实现成一个"收藏夹 + 提醒"，
 * 于是丢掉全部意义。所以这里的断言盯的是**语气与结构**，不只是功能：
 *
 *   ① 记忆锚点的句子是**逐字**的 —— `2026年10月10日，你选择了这盆绿植，决定重新出发`
 *      三段（日期 / 量词+摆件名 / 用户的话）各由一处代码生成，
 *      任意一处漂移都立刻红。中文量和错一个字，整句话就假了。
 *   ② 倒计时的文案里**不许出现**"倒计时 / 剩余 / 逾期 / 已过期" ——
 *      那是任务管理器的语言。这里只有「还有 N 天 / 就是今天 / 那一天已经过去了」。
 *   ③ 归零是**馈赠**不是**通知**：幂等（同一天开十次只发一件）、可补发（触发时崩了下次补）、
 *      而且它在视觉上是一次完整的记忆锚点事件。
 *   ④ 日期算术必须走**日历日**，不是毫秒除法 —— 跨夏令时 / 闰年 / 时区都不能差一天。
 * ===========================================================================
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  MAX_MEMORY_ITEMS,
  MEMORY_CATALOG,
  MEMORY_KINDS,
  MEMORY_OFFER_MAX,
  MEMORY_OFFER_MIN,
  dateLabel,
  draftMemory,
  forgetMemory,
  itemName,
  loadMemory,
  placeMemory,
  recallOf,
  roomSummary,
  saveMemory,
  suggestMemoryItems,
  toOffers,
  type MemoryItem,
  type MemoryKind,
} from '@core/memory/memoryAnchor'
import {
  KEEPSAKE_KIND,
  MAX_COUNTDOWN_ITEMS,
  addCountdown,
  countdownOccupancy,
  dayIndexOf,
  daysLeft,
  formatLocalDay,
  isDue,
  loadCountdowns,
  localDayOf,
  makeKeepsake,
  parseLocalDay,
  removeCountdown,
  saveCountdowns,
  tickCountdowns,
  toView,
  type Countdown,
} from '@core/countdown/countdown'
import { createMemoryPort, PersistedStore, PERSIST_KEYS } from '@core/persist'
import { ANCHORS, getAnchor, type AnchorId } from '@core/room/roomZone'
import { FORBIDDEN_COPY, FORBIDDEN_STRUCTURE_WORDS } from '@core/guide/guide'
import type { MoodTone } from '@core/reading'

// ───────────────────────────────────────────────────────────────────────────
// 小工具
// ───────────────────────────────────────────────────────────────────────────

/** 本地那一天的**正午**时间戳。用正午而不是 0 点，跨时区时不会滑到前一天 */
const noonOf = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime()

const NOW = noonOf(2026, 10, 9)

let clock = 0
const nextNow = (): number => (clock += 1000)

const mkCountdown = (over: Partial<Countdown> = {}): Countdown => ({
  id: `c-${nextNow()}`,
  title: '交材料的那天',
  target: { y: 2026, m: 10, d: 20 },
  createdAt: NOW,
  anchorId: null,
  at: { x: 0, y: 0 },
  firedAt: null,
  keepsakeId: null,
  ...over,
})

const mkItem = (over: Partial<MemoryItem> = {}): MemoryItem => ({
  id: `m-${nextNow()}`,
  createdAt: NOW,
  readAt: NOW,
  kind: 'plant',
  source: { kind: 'liuyao', hexagram: 12 },
  tone: 'HOPEFUL',
  note: '',
  anchorId: null,
  at: { x: 100, y: 100 },
  ...over,
})

beforeEach(() => {
  clock = 0
})

// ═══════════════════════════════════════════════════════════════════════════
//  ①  日历日算术
// ═══════════════════════════════════════════════════════════════════════════

describe('日历日算术 · 不受时区与夏令时影响', () => {
  it('纪元日：1970-01-01 → 0', () => {
    expect(dayIndexOf({ y: 1970, m: 1, d: 1 })).toBe(0)
    expect(dayIndexOf({ y: 1970, m: 1, d: 2 })).toBe(1)
    expect(dayIndexOf({ y: 1969, m: 12, d: 31 })).toBe(-1)
  })

  it('★ 同一个日历日的不同时刻 → 同一个天号（差 1 毫秒也不能跨天）', () => {
    const a = dayIndexOf(localDayOf(noonOf(2026, 3, 8)))
    const b = dayIndexOf(localDayOf(new Date(2026, 2, 8, 23, 59, 59).getTime()))
    const c = dayIndexOf(localDayOf(new Date(2026, 2, 8, 0, 0, 1).getTime()))
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('★ daysLeft 走日历日整数差 —— 不是毫秒除法', () => {
    const target = { y: 2026, m: 10, d: 20 }
    expect(daysLeft(target, noonOf(2026, 10, 9))).toBe(11)
    expect(daysLeft(target, noonOf(2026, 10, 20))).toBe(0)
    expect(daysLeft(target, noonOf(2026, 10, 21))).toBe(-1)
    // 差 11 天多一点、差 11 天少一点，都是 11
    expect(daysLeft(target, new Date(2026, 9, 9, 0, 0, 1).getTime())).toBe(11)
    expect(daysLeft(target, new Date(2026, 9, 9, 23, 59, 59).getTime())).toBe(11)
  })

  it('跨月 / 跨年 / 闰年都算对', () => {
    expect(daysLeft({ y: 2027, m: 1, d: 1 }, noonOf(2026, 12, 31))).toBe(1)
    expect(daysLeft({ y: 2026, m: 3, d: 1 }, noonOf(2026, 2, 28))).toBe(1)
    // 2028 是闰年：2 月有 29 天
    expect(daysLeft({ y: 2028, m: 3, d: 1 }, noonOf(2028, 2, 28))).toBe(2)
    // 平年 2027：2 月 28 天
    expect(daysLeft({ y: 2027, m: 3, d: 1 }, noonOf(2027, 2, 28))).toBe(1)
  })

  it('localDayOf 用**本地** getter（不是 toISOString —— 那会差一天）', () => {
    const ts = noonOf(2026, 10, 9)
    const d = localDayOf(ts)
    expect(d).toEqual({ y: 2026, m: 10, d: 9 })
    // 与本地 Date 的三个 getter 完全一致
    const raw = new Date(ts)
    expect(d.y).toBe(raw.getFullYear())
    expect(d.m).toBe(raw.getMonth() + 1)
    expect(d.d).toBe(raw.getDate())
  })

  it('formatLocalDay 补零，parseLocalDay 反解一致', () => {
    expect(formatLocalDay({ y: 2026, m: 1, d: 5 })).toBe('2026-01-05')
    expect(parseLocalDay('2026-01-05')).toEqual({ y: 2026, m: 1, d: 5 })
    expect(parseLocalDay(formatLocalDay({ y: 2026, m: 12, d: 31 }))).toEqual({ y: 2026, m: 12, d: 31 })
  })

  it('★ parseLocalDay 挡住"格式对但不存在"的日期，非法返回 null 而不是抛', () => {
    expect(parseLocalDay('2026-02-30')).toBeNull()
    expect(parseLocalDay('2027-02-29')).toBeNull() // 平年没有 2/29
    expect(parseLocalDay('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 }) // 闰年有
    expect(parseLocalDay('2026-13-01')).toBeNull()
    expect(parseLocalDay('2026-00-10')).toBeNull()
    expect(parseLocalDay('2026-1-5')).toBeNull() // 必须两位
    expect(parseLocalDay('')).toBeNull()
    expect(parseLocalDay(null)).toBeNull()
    expect(parseLocalDay(20260105)).toBeNull()
    expect(parseLocalDay(' 2026-01-05 ')).toEqual({ y: 2026, m: 1, d: 5 }) // 两侧空白容忍
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ②  倒计时文案：说不出"焦虑"的词
// ═══════════════════════════════════════════════════════════════════════════

describe('倒计时视图 · 语气底线', () => {
  it('三种文案与需求一致', () => {
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 20 } })
    expect(toView(c, noonOf(2026, 10, 9)).caption).toBe('还有 11 天')
    expect(toView(c, noonOf(2026, 10, 20)).caption).toBe('就是今天')
    expect(toView(c, noonOf(2026, 10, 25)).caption).toBe('那一天已经过去了')
  })

  it('★ 文案里不许出现任务管理器的词（倒计时 / 剩余 / 逾期 / 已过期）', () => {
    const banned = /倒计时|剩余|逾期|过期|还剩|deadline|due/i
    for (const now of [noonOf(2026, 10, 1), noonOf(2026, 10, 20), noonOf(2026, 11, 1)]) {
      const v = toView(mkCountdown(), now)
      expect(v.caption).not.toMatch(banned)
      expect(v.title).not.toMatch(/倒计时|提醒|待办/)
    }
  })

  it('due 标记与 daysLeft 一致：0 那天也算"到了"', () => {
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 20 } })
    expect(toView(c, noonOf(2026, 10, 19)).due).toBe(false)
    expect(toView(c, noonOf(2026, 10, 20)).due).toBe(true)
    expect(toView(c, noonOf(2026, 10, 21)).due).toBe(true)
    expect(toView(c, noonOf(2026, 10, 20)).daysLeft).toBe(0)
  })

  it('view 不暴露 firedAt / keepsakeId 这类内部字段（UI 无从拿它做"已提醒"标记）', () => {
    const v = toView(mkCountdown(), NOW)
    expect(Object.keys(v).sort()).toEqual(['caption', 'daysLeft', 'due', 'id', 'title'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ③  新建 / 删除：拒绝压力
// ═══════════════════════════════════════════════════════════════════════════

describe('addCountdown · 不拒绝、不报错', () => {
  it('空标题 / 纯空白 → 不新建，也不抛（调用方继续跑）', () => {
    expect(addCountdown([], { title: '', target: { y: 2026, m: 11, d: 1 }, now: NOW }).added).toBeNull()
    expect(addCountdown([], { title: '   ', target: { y: 2026, m: 11, d: 1 }, now: NOW }).added).toBeNull()
    expect(addCountdown([], { title: undefined as never, target: { y: 2026, m: 11, d: 1 }, now: NOW }).items)
      .toEqual([])
  })

  it('★ 目标日已经过去也照样能建 —— 用户想记一个"已经过去的日子"完全合理', () => {
    const { added } = addCountdown([], { title: '她从那天开始上班', target: { y: 2026, m: 1, d: 1 }, now: NOW })
    expect(added).not.toBeNull()
    expect(added!.firedAt).toBeNull() // 还没发过纪念品，所以它现在是"该发了"
    expect(isDue(added!, NOW)).toBe(true)
  })

  it('标题裁剪到 24 字（沙漏上放不下更多，且长标题会挤掉那行大字）', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六'
    const { added } = addCountdown([], { title: long, target: { y: 2026, m: 11, d: 1 }, now: NOW })
    expect(added!.title).toHaveLength(24)
    expect(added!.title).toBe(long.slice(0, 24))
  })

  it('不改动传入数组（纯函数）', () => {
    const before: Countdown[] = []
    addCountdown(before, { title: '甲', target: { y: 2026, m: 11, d: 1 }, now: NOW })
    expect(before).toHaveLength(0)
  })

  it('★ 超过上限时只丢"已经发过纪念品"的，绝不丢掉用户在等的那个日子', () => {
    const done: Countdown[] = Array.from({ length: MAX_COUNTDOWN_ITEMS }, (_, i) =>
      mkCountdown({ id: `done-${i}`, createdAt: i, firedAt: 1 }),
    )
    // 再加一个"还没到期"的：总数超了，但只能丢已完成的
    const { items, added } = addCountdown(done, {
      title: '新的一天',
      target: { y: 2027, m: 1, d: 1 },
      now: NOW,
    })
    expect(added).not.toBeNull()
    expect(items).toHaveLength(MAX_COUNTDOWN_ITEMS)
    expect(items.some((c) => c.id === added!.id)).toBe(true) // 新的那个一定还在
    expect(items.filter((c) => c.firedAt === null)).toHaveLength(1)
    // 丢的是最早完成的那些
    expect(items.some((c) => c.id === 'done-0')).toBe(false)
  })

  it('全部都没完成时，宁可暂时超限也不丢 —— "等着的日子"不可被静默取消', () => {
    const pending: Countdown[] = Array.from({ length: MAX_COUNTDOWN_ITEMS }, (_, i) =>
      mkCountdown({ id: `p-${i}`, createdAt: i }),
    )
    const { items } = addCountdown(pending, { title: '再来一天', target: { y: 2027, m: 1, d: 1 }, now: NOW })
    expect(items).toHaveLength(MAX_COUNTDOWN_ITEMS + 1)
  })

  it('removeCountdown 按 id 移除；不存在的 id 原样返回', () => {
    const list = [mkCountdown({ id: 'a' }), mkCountdown({ id: 'b' })]
    expect(removeCountdown(list, 'a').map((c) => c.id)).toEqual(['b'])
    expect(removeCountdown(list, 'zzz').map((c) => c.id)).toEqual(['a', 'b'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ④  归零触发：幂等 + 可补发
// ═══════════════════════════════════════════════════════════════════════════

describe('tickCountdowns · 宁可补发，不可漏发', () => {
  it('未到期 → 不触发', () => {
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 20 } })
    const r = tickCountdowns([c], noonOf(2026, 10, 19))
    expect(r.fired).toEqual([])
    expect(r.items[0].firedAt).toBeNull()
  })

  it('到期当天 → 触发一次，且立刻打上 firedAt', () => {
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 20 } })
    const r = tickCountdowns([c], noonOf(2026, 10, 20))
    expect(r.fired).toHaveLength(1)
    expect(r.fired[0].id).toBe(c.id)
    expect(r.items[0].firedAt).toBe(noonOf(2026, 10, 20))
  })

  it('★ 幂等：同一天连 tick 十次，只触发一次', () => {
    let items = [mkCountdown({ target: { y: 2026, m: 10, d: 20 } })]
    let totalFired = 0
    for (let i = 0; i < 10; i++) {
      const r = tickCountdowns(items, noonOf(2026, 10, 20))
      items = r.items
      totalFired += r.fired.length
    }
    expect(totalFired).toBe(1)
    expect(items[0].firedAt).not.toBeNull()
  })

  it('★ 补发：触发那一刻崩溃了（firedAt 仍是 null），下次启动会补上', () => {
    // 模拟"上一次 tick 抛了/进程被杀" —— 数据里 firedAt 依然是 null
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 20 } })
    expect(isDue(c, noonOf(2026, 10, 27))).toBe(true)
    const r = tickCountdowns([c], noonOf(2026, 10, 27))
    expect(r.fired).toHaveLength(1)
    expect(r.items[0].firedAt).toBe(noonOf(2026, 10, 27))
  })

  it('多个同时到期 → 一次 tick 全部触发（队列会一个一个展示）', () => {
    const a = mkCountdown({ id: 'a', target: { y: 2026, m: 10, d: 1 } })
    const b = mkCountdown({ id: 'b', target: { y: 2026, m: 10, d: 5 } })
    const c = mkCountdown({ id: 'c', target: { y: 2026, m: 12, d: 1 } })
    const r = tickCountdowns([a, b, c], noonOf(2026, 10, 9))
    expect(r.fired.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.items[2].firedAt).toBeNull()
  })

  it('不修改原数组元素（返回新对象）', () => {
    const c = mkCountdown({ target: { y: 2026, m: 10, d: 1 } })
    const r = tickCountdowns([c], NOW)
    expect(c.firedAt).toBeNull()
    expect(r.items[0]).not.toBe(c)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤  纪念品：一次完整的记忆锚点事件
// ═══════════════════════════════════════════════════════════════════════════

describe('makeKeepsake · 到日子了不是"通知"，是"留下"', () => {
  const tone: MoodTone = 'HOPEFUL'

  it('固定是「褪色的船票」，来源是 countdown 变体（不是"第 0 卦"）', () => {
    const c = mkCountdown()
    const k = makeKeepsake({
      countdown: c,
      now: NOW,
      tone,
      fallbackAt: { x: 195, y: 738 },
      placed: [],
    })
    expect(k.kind).toBe(KEEPSAKE_KIND)
    expect(k.kind).toBe('ticket')
    expect(k.keepsake).toBe(true)
    expect(k.source).toEqual({ kind: 'countdown', countdownId: c.id, title: c.title })
    expect(k.note).toContain(c.title)
  })

  it('★ 落到倒计时自己的锚点上，且**只允许**那个锚点（不被塞进窗边/香炉旁）', () => {
    const anchor = getAnchor('TEA_TABLE')!
    const c = mkCountdown({ anchorId: 'TEA_TABLE', at: { ...anchor.at } })
    const k = makeKeepsake({ countdown: c, now: NOW, tone, fallbackAt: { x: 1, y: 1 }, placed: [] })
    expect(k.anchorId).toBe('TEA_TABLE')
    expect(k.at).toEqual(anchor.at)
  })

  it('锚点被别人占满了 → 就地放下，纪念品照样出现（绝不失败）', () => {
    const anchor = getAnchor('TEA_TABLE')!
    const c = mkCountdown({ anchorId: 'TEA_TABLE', at: { ...anchor.at } })
    const occupied = mkItem({ anchorId: 'TEA_TABLE' })
    const k = makeKeepsake({ countdown: c, now: NOW, tone, fallbackAt: { x: 5, y: 5 }, placed: [occupied] })
    expect(k.kind).toBe('ticket')
    expect(k.anchorId).toBeNull() // 就地放下
    expect(k.at).toEqual(anchor.at)
  })

  it('没设锚点时用 fallbackAt（通常就是沙漏旁边）', () => {
    const k = makeKeepsake({
      countdown: mkCountdown({ anchorId: null, at: { x: 0, y: 0 } }),
      now: NOW,
      tone,
      fallbackAt: { x: 120, y: 340 },
      placed: [],
    })
    expect(k.anchorId).toBeNull()
    expect(k.at).toEqual({ x: 120, y: 340 })
  })

  it('★ (0,0) 是"还没放过"的哨兵，不是"房间左上角" —— 必须退到 fallbackAt', () => {
    // 这条路径真实可达：用户在 COUNTDOWN_SET 面板直接定日子、没把沙漏拖到任何地方。
    // 修复前它会落在 (0,0)，也就是画布外的角落 ——"到日子了，但什么都没看见"。
    const k = makeKeepsake({
      countdown: mkCountdown({ anchorId: null, at: { x: 0, y: 0 } }),
      now: NOW,
      tone,
      fallbackAt: { x: 195, y: 700 },
      placed: [],
    })
    expect(k.at).not.toEqual({ x: 0, y: 0 })
    expect(k.at).toEqual({ x: 195, y: 700 })
  })

  it('★ 设了锚点但 at 还是哨兵 → 用锚点坐标（不是 fallbackAt，也不是 (0,0)）', () => {
    const anchor = getAnchor('WINDOW_SILL')!
    const k = makeKeepsake({
      countdown: mkCountdown({ anchorId: 'WINDOW_SILL', at: { x: 0, y: 0 } }),
      now: NOW,
      tone,
      fallbackAt: { x: 195, y: 700 },
      placed: [],
    })
    expect(k.anchorId).toBe('WINDOW_SILL')
    expect(k.at).toEqual(anchor.at)
  })

  it('at 是 NaN 的脏数据 → 退到 fallbackAt，不写进一个坏坐标', () => {
    const k = makeKeepsake({
      countdown: mkCountdown({ at: { x: Number.NaN, y: Number.NaN } }),
      now: NOW,
      tone,
      fallbackAt: { x: 7, y: 9 },
      placed: [],
    })
    expect(Number.isFinite(k.at.x)).toBe(true)
    expect(k.at).toEqual({ x: 7, y: 9 })
  })

  it('★ 纪念品点开会说话，且语气是"等到了"而不是"已到期"', () => {
    const anchor = getAnchor('TEA_TABLE')!
    const c = mkCountdown({ id: 'cd-1', title: '交材料的那天', anchorId: 'TEA_TABLE', at: { ...anchor.at } })
    const k = makeKeepsake({ countdown: c, now: NOW, tone, fallbackAt: anchor.at, placed: [] })
    const r = recallOf(k)
    expect(r.line).toBe(`2026年10月9日，你选择了这张褪色的船票，等到了「交材料的那天」的这一天`)
    expect(r.line).not.toMatch(/逾期|过期|提醒|倒计时/)
    expect(r.sourceLabel).toBe('「交材料的那天」那天')
  })

  it('倒计时摆件也会占用锚点（它也是"放在屋里的东西"）', () => {
    const full = countdownOccupancy([mkCountdown({ anchorId: 'TABLE_TOP' })])
    expect(full[ANCHORS.findIndex((a) => a.id === 'TABLE_TOP')]).toBe(true)
    expect(full.filter(Boolean)).toHaveLength(1)
    expect(countdownOccupancy([mkCountdown({ anchorId: null })])).toEqual(ANCHORS.map(() => false))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑥  记忆锚点：句子是逐字的
// ═══════════════════════════════════════════════════════════════════════════

describe('recallOf · 优雅浮现的句子', () => {
  it('★ 与需求原文逐字一致', () => {
    const item = mkItem({
      kind: 'plant',
      tone: 'HOPEFUL',
      note: '',
      readAt: noonOf(2026, 10, 10),
    })
    expect(recallOf(item).line).toBe('2026年10月10日，你选择了这盆绿植，决定重新出发')
  })

  it('三段各自来源清楚：日期 / 量词+摆件名 / 用户的话', () => {
    const item = mkItem({ kind: 'stone', tone: 'TIRED', note: '想歇一歇', readAt: noonOf(2026, 1, 3) })
    const r = recallOf(item)
    expect(r.date).toBe('2026年1月3日')
    expect(r.itemName).toBe('这块鹅卵石')
    expect(r.tail).toBe('想歇一歇')
    expect(r.line).toBe('2026年1月3日，你选择了这块鹅卵石，想歇一歇')
  })

  it('用户没写话时用基调兜底 —— 而不是留一个空尾巴', () => {
    const tones: MoodTone[] = ['CALM', 'TIRED', 'ANXIOUS', 'DOWN', 'HOPEFUL', 'RESTLESS']
    for (const t of tones) {
      const r = recallOf(mkItem({ tone: t, note: '' }))
      expect(r.tail.length).toBeGreaterThan(0)
      expect(r.line).not.toMatch(/，$/)
      expect(r.line.endsWith('，')).toBe(false)
    }
  })

  it('★ 中文量词由代码拼 —— 「这盆绿植」/「一盆绿植」两种说法都正确', () => {
    const expectPairs: Array<[MemoryKind, string, string]> = [
      ['plant', '这盆绿植', '一盆绿植'],
      ['stone', '这块鹅卵石', '一块鹅卵石'],
      ['lantern', '这盏小灯', '一盏小灯'],
      ['shell', '这枚贝壳', '一枚贝壳'],
      ['bell', '这只铜铃', '一只铜铃'],
      ['candle', '这支蜡烛', '一支蜡烛'],
      ['seed', '这颗一粒种子', '一颗一粒种子'],
      ['ticket', '这张褪色的船票', '一张褪色的船票'],
    ]
    for (const [kind, thisForm, oneForm] of expectPairs) {
      expect(itemName({ kind }, 'this')).toBe(thisForm)
      expect(itemName({ kind }, 'one')).toBe(oneForm)
      // 缺省是"这"（浮现用），候选卡片显式传 'one'
      expect(itemName({ kind })).toBe(thisForm)
    }
  })

  it('每一件的名字都能自然接住「你选择了这XX」—— 量词与名称都不为空', () => {
    for (const kind of MEMORY_KINDS) {
      const def = MEMORY_CATALOG[kind]
      expect(def.name.length, `${kind} 的名字`).toBeGreaterThan(0)
      expect(def.classifier.length, `${kind} 的量词`).toBeGreaterThan(0)
      expect(def.whisper.length, `${kind} 的那句话`).toBeGreaterThan(0)
      expect(itemName({ kind }, 'this')).toMatch(/^这[\u4e00-\u9fa5]/)
    }
  })

  it('★ dateLabel 不补零，且用本地日期（UTC 会让 23:30 的事变成明天）', () => {
    expect(dateLabel(noonOf(2026, 10, 10))).toBe('2026年10月10日')
    expect(dateLabel(noonOf(2026, 1, 5))).toBe('2026年1月5日')
    const d = new Date(noonOf(2026, 7, 15))
    expect(dateLabel(d.getTime())).toBe(`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`)
  })

  it('sourceLabel 覆盖三种来源，且不认识时也不崩', () => {
    expect(recallOf(mkItem({ source: { kind: 'liuyao', hexagram: 12 } })).sourceLabel).toBe('第 12 卦')
    expect(
      recallOf(mkItem({ source: { kind: 'tarot', spreadId: 'celtic-cross', cards: [1, 2, 3] } })).sourceLabel,
    ).toBe('「celtic-cross」3 张')
    expect(
      recallOf(mkItem({ source: { kind: 'countdown', countdownId: 'x', title: '那天' } })).sourceLabel,
    ).toBe('「那天」那天')
  })

  it('★ 浮现的句子里不许出现合规红线词与结构行话', () => {
    for (const kind of MEMORY_KINDS) {
      for (const tone of ['CALM', 'HOPEFUL', 'DOWN'] as MoodTone[]) {
        const r = recallOf(mkItem({ kind, tone, note: '想继续往前走' }))
        expect(r.line).not.toMatch(FORBIDDEN_COPY)
        expect(r.line).not.toMatch(FORBIDDEN_STRUCTURE_WORDS)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑦  候选：少即是"选择负担轻"
// ═══════════════════════════════════════════════════════════════════════════

describe('suggestMemoryItems · 2–3 件，且是确定的', () => {
  const tones: MoodTone[] = ['CALM', 'TIRED', 'ANXIOUS', 'DOWN', 'HOPEFUL', 'RESTLESS']

  it('★ 确定性：同样的 (tone, seed) 永远给同一批 —— 不是抽奖', () => {
    for (const t of tones) {
      for (const seed of [0, 1, 7, 12, 64, 9999]) {
        const a = suggestMemoryItems(t, seed)
        const b = suggestMemoryItems(t, seed)
        expect(a, `${t} / seed=${seed}`).toEqual(b)
      }
    }
  })

  it('数量恒在 2–3 之间，并且互不重复', () => {
    for (const t of tones) {
      for (let seed = 0; seed < 20; seed++) {
        const list = suggestMemoryItems(t, seed)
        expect(list.length).toBeGreaterThanOrEqual(MEMORY_OFFER_MIN)
        expect(list.length).toBeLessThanOrEqual(MEMORY_OFFER_MAX)
        expect(new Set(list).size).toBe(list.length)
      }
    }
    // 显式传数量也被夹到区间内
    expect(suggestMemoryItems('CALM', 0, 99)).toHaveLength(MEMORY_OFFER_MAX)
    expect(suggestMemoryItems('CALM', 0, 0)).toHaveLength(MEMORY_OFFER_MAX) // 0 → 缺省
    expect(suggestMemoryItems('CALM', 0, Number.NaN)).toHaveLength(MEMORY_OFFER_MAX)
  })

  it('★ 纪念品永不出现在候选里 —— 它只在倒计时归零时被赠予', () => {
    for (const t of tones) {
      for (let seed = 0; seed < 40; seed++) {
        expect(suggestMemoryItems(t, seed)).not.toContain('ticket')
      }
    }
    expect(MEMORY_CATALOG.ticket.tones).toEqual([])
  })

  it('专属件优先：候选里至少有一件是该基调"对口"的', () => {
    for (const t of tones) {
      const matched = MEMORY_KINDS.filter((k) => k !== 'ticket' && MEMORY_CATALOG[k].tones.includes(t))
      if (matched.length === 0) continue
      for (let seed = 0; seed < 12; seed++) {
        const list = suggestMemoryItems(t, seed)
        expect(list.some((k) => matched.includes(k)), `${t} / seed=${seed} 没有对口件`).toBe(true)
      }
    }
  })

  it('每个情绪基调都至少有一件专属摆件 —— 不能让某种心情"无话可说"', () => {
    for (const t of tones) {
      const matched = MEMORY_KINDS.filter((k) => k !== 'ticket' && MEMORY_CATALOG[k].tones.includes(t))
      expect(matched.length, `${t} 没有专属摆件`).toBeGreaterThan(0)
    }
  })

  it('负数 / 非整数 seed 也不崩', () => {
    expect(suggestMemoryItems('CALM', -3).length).toBeGreaterThanOrEqual(MEMORY_OFFER_MIN)
    expect(suggestMemoryItems('CALM', 2.7).length).toBeGreaterThanOrEqual(MEMORY_OFFER_MIN)
    expect(suggestMemoryItems('CALM', Number.NaN).length).toBeGreaterThanOrEqual(MEMORY_OFFER_MIN)
  })

  it('toOffers 产出 UI 直接可用的卡片数据，且不出现"塔罗/六爻"这类行话', () => {
    const offers = toOffers(suggestMemoryItems('ANXIOUS', 5), 'ANXIOUS')
    expect(offers.length).toBeGreaterThanOrEqual(MEMORY_OFFER_MIN)
    for (const o of offers) {
      expect(o.name).toMatch(/^一/)
      expect(o.whisper.length).toBeGreaterThan(0)
      expect(o.toneLabel.length).toBeGreaterThan(0)
      expect(`${o.name}${o.whisper}${o.toneLabel}`).not.toMatch(FORBIDDEN_STRUCTURE_WORDS)
      expect(`${o.name}${o.whisper}`).not.toMatch(FORBIDDEN_COPY)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑧  亲手放下
// ═══════════════════════════════════════════════════════════════════════════

describe('placeMemory / draftMemory', () => {
  it('★ 吸到锚点上、或就地放下 —— 两种结局，没有失败态', () => {
    const anchor = getAnchor('TABLE_TOP')!
    const snapped = placeMemory(mkItem(), anchor.at, { placed: [], now: NOW })
    expect(snapped.outcome).toBe('anchor')
    expect(snapped.item.anchorId).toBe('TABLE_TOP')
    expect(snapped.item.at).toEqual(anchor.at)

    const free = placeMemory(mkItem(), { x: 320, y: 260 }, { placed: [], now: NOW })
    expect(free.outcome).toBe('free')
    expect(free.item.anchorId).toBeNull()
    expect(free.item.at).toEqual({ x: 320, y: 260 })
  })

  it('锚点已被占满 → 就地放下，用户的东西不会消失', () => {
    const anchor = getAnchor('WINDOW_SILL')!
    const occupied = mkItem({ anchorId: 'WINDOW_SILL' })
    const r = placeMemory(mkItem(), anchor.at, { placed: [occupied], now: NOW })
    expect(r.outcome).toBe('free')
    expect(r.item.anchorId).toBeNull()
    expect(r.item.at).toEqual(anchor.at)
  })

  it('allow 限定可选锚点（例：六爻道具只许放六爻那三个）', () => {
    const tea = getAnchor('TEA_TABLE')!
    const allow: AnchorId[] = ['WINDOW_SILL', 'TABLE_TOP', 'CENSER_SIDE']
    const r = placeMemory(mkItem(), tea.at, { placed: [], allow, now: NOW })
    expect(r.item.anchorId).toBeNull() // 茶几在塔罗区，不在名单里
    expect(r.outcome).toBe('free')
  })

  it('★ draftMemory 的哨兵坐标是 (0,0) 而**不是 NaN**', () => {
    // NaN 会被 JSON.stringify 写成 null，读回来就被 isMemoryItem 静默丢掉 ——
    // 表现为"我放的东西第二天不见了"。这条断言守住那个坑。
    const d = draftMemory({ kind: 'shell', tone: 'CALM', source: { kind: 'liuyao', hexagram: 3 }, readAt: NOW, now: NOW })
    expect(d.at).toEqual({ x: 0, y: 0 })
    expect(Number.isFinite(d.at.x)).toBe(true)
    expect(JSON.parse(JSON.stringify(d)).at).toEqual({ x: 0, y: 0 })
  })

  it('draftMemory 的 note 去空白；未放置时 anchorId 为 null', () => {
    const d = draftMemory({
      kind: 'seed',
      tone: 'HOPEFUL',
      source: { kind: 'tarot', spreadId: 'daily-single', cards: [4] },
      note: '  先埋下去  ',
      readAt: NOW,
      now: NOW,
    })
    expect(d.note).toBe('先埋下去')
    expect(d.anchorId).toBeNull()
    expect(d.keepsake).toBeUndefined()
  })

  it('id 确定唯一（不用 Math.random —— 单测要可重复）', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      ids.add(draftMemory({ kind: 'bell', tone: 'RESTLESS', source: { kind: 'liuyao', hexagram: i }, readAt: NOW, now: NOW }).id)
    }
    expect(ids.size).toBe(50)
  })

  it('roomSummary：空屋与有东西两种说法，且不说"共 N 件"这种报表话', () => {
    expect(roomSummary([])).toBe('小屋里还空着。')
    const items = [
      mkItem({ id: 'a', kind: 'plant', createdAt: 1 }),
      mkItem({ id: 'b', kind: 'lantern', createdAt: 2 }),
    ]
    const s = roomSummary(items)
    expect(s).toContain('2 件东西')
    expect(s).toContain('这盏小灯') // 最近放下的那件
    expect(s).not.toMatch(/共|总计|统计/)
  })

  it('forgetMemory 想扔就扔，没有确认流程', () => {
    const items = [mkItem({ id: 'a' }), mkItem({ id: 'b' })]
    expect(forgetMemory(items, 'a').map((i) => i.id)).toEqual(['b'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑨  本地读写：坏数据不该让小屋打不开
// ═══════════════════════════════════════════════════════════════════════════

describe('本地读写 · 结构校验与容量', () => {
  it('正常往返：写进去读回来一致', async () => {
    const store = new PersistedStore(createMemoryPort())
    await store.load()
    const items = [mkItem({ id: 'a' }), mkItem({ id: 'b', anchorId: 'TABLE_TOP' })]
    saveMemory(store, items)
    const back = loadMemory(store)
    expect(back.map((i) => i.id)).toEqual(['a', 'b'])
    expect(back[1].anchorId).toBe('TABLE_TOP')
  })

  it('★ 被手改过的脏数据被逐条过滤掉，而不是让整份读取失败', async () => {
    const store = new PersistedStore(
      createMemoryPort({
        [PERSIST_KEYS.memory]: [
          mkItem({ id: 'ok' }),
          { id: 'no-kind', createdAt: 1, readAt: 1, at: { x: 0, y: 0 }, kind: '不存在的摆件' },
          { id: 'nan-at', createdAt: 1, readAt: 1, kind: 'plant', at: { x: null, y: null } },
          { id: 'missing-at', createdAt: 1, readAt: 1, kind: 'plant' },
          null,
          'nope',
          mkItem({ id: 'ok2' }),
        ],
      }),
    )
    await store.load()
    expect(loadMemory(store).map((i) => i.id)).toEqual(['ok', 'ok2'])
  })

  it('存的东西不是数组 → 当空屋，不抛', async () => {
    const store = new PersistedStore(createMemoryPort({ [PERSIST_KEYS.memory]: { boom: true } }))
    await store.load()
    expect(loadMemory(store)).toEqual([])
  })

  it('★ 超过上限时丢最旧的，但绝不阻止用户继续摆', async () => {
    const store = new PersistedStore(createMemoryPort())
    await store.load()
    const many = Array.from({ length: MAX_MEMORY_ITEMS + 5 }, (_, i) => mkItem({ id: `m${i}`, createdAt: i }))
    const kept = saveMemory(store, many)
    expect(kept).toHaveLength(MAX_MEMORY_ITEMS)
    expect(kept[0].id).toBe('m5') // 最旧的被丢掉
    expect(loadMemory(store)).toHaveLength(MAX_MEMORY_ITEMS)
  })

  it('倒计时同样逐条校验，且超出上限时截断', async () => {
    const store = new PersistedStore(
      createMemoryPort({
        [PERSIST_KEYS.countdown]: [
          mkCountdown({ id: 'ok' }),
          { id: 'bad-target', title: 'x', createdAt: 1, target: { y: 'a', m: 1, d: 1 } },
          { id: '', title: 'x', createdAt: 1, target: { y: 2026, m: 1, d: 1 } },
          null,
          mkCountdown({ id: 'ok2' }),
        ],
      }),
    )
    await store.load()
    expect(loadCountdowns(store).map((c) => c.id)).toEqual(['ok', 'ok2'])
  })

  it('倒计时写入后读回一致（含 firedAt 这个幂等锚点）', async () => {
    const store = new PersistedStore(createMemoryPort())
    await store.load()
    const c = mkCountdown({ id: 'cd', firedAt: null, keepsakeId: null })
    saveCountdowns(store, [c])
    const back = loadCountdowns(store)
    expect(back).toHaveLength(1)
    expect(back[0].id).toBe('cd')
    expect(back[0].firedAt).toBeNull()
  })
})
