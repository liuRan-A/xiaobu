/**
 * 小卜 · 本地解读内容库与文案组装   tests/reading-copy.spec.ts
 * ===========================================================================
 * 两件事：
 *   ① 内容库结构正确：64 卦 / 78 牌，序号、数量、分组都不能错
 *   ② 语气红线：所有**面向用户**的字符串（卦名/牌名/主题/映照文字 + 组装结果）
 *      都不许命中 guide.ts 的 FORBIDDEN_COPY（吉凶/行话/预测类词）
 * ===========================================================================
 */
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_COPY } from '@core/guide/guide'
import { HEXAGRAMS, hexagramByNumber } from '@core/liuyao/hexagrams'
import { TAROT_DECK, tarotCardAt } from '@core/spread/deck'
import { interpretLocally } from '@core/readingCopy'
import type { ReadingPlan } from '@core/spread'
import type { HexagramRef, ReadingRequest } from '@core/reading'

// ───────────────────────────────────────────────────────────────────────────

describe('六爻内容库 · 64 卦', () => {
  it('正好 64 条，n 连续且唯一', () => {
    expect(HEXAGRAMS.length).toBe(64)
    expect(HEXAGRAMS.map((h) => h.n)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1))
  })

  it('卦名抽样与 King Wen 序一致', () => {
    const nameOf = (n: number) => hexagramByNumber(n)?.name
    expect(nameOf(1)).toBe('乾')
    expect(nameOf(2)).toBe('坤')
    expect(nameOf(11)).toBe('泰')
    expect(nameOf(12)).toBe('否')
    expect(nameOf(63)).toBe('既济')
    expect(nameOf(64)).toBe('未济')
  })

  it('卦符为对应 Unicode（U+4DC0 起）', () => {
    expect(hexagramByNumber(1)?.glyph).toBe(String.fromCodePoint(0x4dc0))
    expect(hexagramByNumber(64)?.glyph).toBe(String.fromCodePoint(0x4dc0 + 63))
  })

  it('越界返回 null', () => {
    expect(hexagramByNumber(0)).toBeNull()
    expect(hexagramByNumber(65)).toBeNull()
  })

  it('theme / reading / name 均不含禁词', () => {
    for (const h of HEXAGRAMS) {
      expect(`${h.name}${h.theme}${h.reading}`, `第 ${h.n} 卦`).not.toMatch(FORBIDDEN_COPY)
    }
  })
})

describe('塔罗内容库 · 78 牌', () => {
  it('正好 78 条，id 连续且唯一', () => {
    expect(TAROT_DECK.length).toBe(78)
    expect(TAROT_DECK.map((c) => c.id)).toEqual(Array.from({ length: 78 }, (_, i) => i))
  })

  it('大阿卡纳 22 张，四组小阿卡纳各 14 张', () => {
    expect(TAROT_DECK.filter((c) => c.arcana === 'major')).toHaveLength(22)
    for (const suit of ['wands', 'cups', 'swords', 'pentacles'] as const) {
      expect(TAROT_DECK.filter((c) => c.suit === suit), suit).toHaveLength(14)
    }
  })

  it('首尾牌名正确', () => {
    expect(tarotCardAt(0)?.name).toBe('愚者')
    expect(tarotCardAt(21)?.name).toBe('世界')
  })

  it('越界返回 null', () => {
    expect(tarotCardAt(-1)).toBeNull()
    expect(tarotCardAt(78)).toBeNull()
  })

  it('theme / reading / name 均不含禁词', () => {
    for (const c of TAROT_DECK) {
      expect(`${c.name}${c.theme}${c.reading}`, `id ${c.id}`).not.toMatch(FORBIDDEN_COPY)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────

const hexRef = (primary: number, changed: number | null = null, moving: number[] = []): HexagramRef => ({
  primary,
  changed,
  moving,
})

const req = (dims: Record<string, string>): ReadingRequest => ({
  kind: 'liuyao',
  dims,
  structure: 'hexagram',
  localOnly: {},
})

describe('interpretLocally · 组装与语气', () => {
  it('六爻：本卦名出现在标题，动爻给走向提示，全程无禁词', () => {
    const copy = interpretLocally({
      plan: null,
      request: req({ mood: 'ANXIOUS', focus: 'CAREER' }),
      hexagram: hexRef(11, 12, [0, 3]),
    })
    expect(copy.title).toContain('泰')
    expect(copy.sections).toHaveLength(1)
    expect(copy.sections[0].body).toContain('否') // 变卦方向提示
    const all = `${copy.title}${copy.subtitle}${copy.summary}${copy.sections.map((s) => s.label + s.body).join('')}`
    expect(all).not.toMatch(FORBIDDEN_COPY)
  })

  it('塔罗：按 plan.sections 分段，牌名出现在正文', () => {
    const plan: ReadingPlan = {
      spreadId: 'test',
      spreadName: '测试牌阵',
      title: '测试牌阵',
      subtitle: '随便看看',
      strategy: 'single',
      drawn: 1,
      sections: [{ order: 1, role: 'today', label: '今天的你', guidance: '', cardIndex: 0 }],
      summaryGuidance: '',
    }
    const copy = interpretLocally({ plan, request: req({ mood: 'CALM' }), hexagram: null })
    expect(copy.sections).toHaveLength(1)
    expect(copy.sections[0].body).toContain('愚者')
    expect(copy.sections[0].label).toBe('今天的你')
    expect(`${copy.title}${copy.subtitle}${copy.summary}${copy.sections[0].body}`).not.toMatch(FORBIDDEN_COPY)
  })

  it('未翻开的牌位不崩，给温和兜底', () => {
    const plan: ReadingPlan = {
      spreadId: 'test',
      spreadName: '测试牌阵',
      title: '测试牌阵',
      subtitle: '随便看看',
      strategy: 'single',
      drawn: 0,
      sections: [{ order: 1, role: 'today', label: '今天的你', guidance: '', cardIndex: null }],
      summaryGuidance: '',
    }
    const copy = interpretLocally({ plan, request: null, hexagram: null })
    expect(copy.sections[0].body).not.toBe('')
    expect(copy.sections[0].body).not.toMatch(FORBIDDEN_COPY)
  })

  it('三者皆无时不空白、不抛异常', () => {
    const copy = interpretLocally({ plan: null, request: null, hexagram: null })
    expect(copy.title.length).toBeGreaterThan(0)
    expect(copy.summary.length).toBeGreaterThan(0)
  })
})
