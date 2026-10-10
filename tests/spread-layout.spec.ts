/**
 * 牌阵引擎 · 坐标排布与解读计划回归测试   tests/spread-layout.spec.ts
 * ===========================================================================
 * 对应 M2 任务书「一、数据驱动的牌阵引擎」与「二、空间布局与双核心玩法」。
 *
 * 为什么这一幕最该有测试：
 *   牌阵的全部坐标、抽牌顺序、牌位角色都住在 `spreads.json` 里 ——
 *   也就是说**没有任何一句代码在写死它们**。这带来一个真实的代价：
 *   改 JSON 不会有编译错误。少写一个 `order`、把某张牌推出画布、
 *   给凯尔特十字漏掉 `outcome` 角色，类型系统全都看不见，
 *   表现却是"AI 解读少了一段""某张牌翻出来落在屏幕外"。
 *   这一套用例就是那些本该由编译器给出的报错。
 *
 * 三组断言，各自盯一类错误：
 *   ① **几何**：牌数 / 抽牌顺序是不是排列 / 是否越界 / 两条泳道是否镜像
 *   ② **结构**：牌位角色集合必须与 `READING_ROLES[strategy]` 完全一致
 *   ③ **文案**：排版铁律「真名在上、解释在下」的两条样例逐字钉死
 *
 * ★ 零硬编码原则：这里的期望值要么来自 `SPREADS`（被测真源），
 *   要么来自 `@scene` 的真实几何，绝不另抄一份坐标 ——
 *   抄一份就等于把"漂移"这件事藏起来。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_SPREAD,
  READING_ROLES,
  SPREAD_CANVAS,
  SPREAD_CARD_METRICS,
  SPREAD_ISSUES,
  SPREAD_SCHEMA_VERSION,
  SPREADS,
  TIER_LABEL,
  buildReadingPlan,
  cardForDraw,
  drawOrder,
  getSpread,
  halfExtent,
  resolveLayout,
  spreadsByTier,
  subtitleOf,
  toListItem,
  validateRegistry,
  validateSpread,
  type ReadingStrategy,
  type SpreadCard,
  type SpreadConfig,
  type SpreadTier,
} from '@core/spread'

// ───────────────────────────────────────────────────────────────────────────
// 小工具
// ───────────────────────────────────────────────────────────────────────────

const byId = (id: string): SpreadConfig => {
  const s = getSpread(id)
  if (!s) throw new Error(`牌阵「${id}」不在注册表里 —— 先看 SPREAD_ISSUES`)
  return s
}

/** 造一个「已知合法」的三张时间线，再按需破坏其中一处 —— 用于反向用例 */
function mkTimeline(patch: Partial<SpreadConfig> = {}, cardPatch: Partial<SpreadCard> = {}): unknown {
  const base: SpreadConfig = {
    id: 'unit-timeline',
    tier: 'hot',
    name: '三张过去·现在·未来',
    poeticAlias: '河流的三道波光',
    poeticLine: '看清来路、脚下与前方，三张牌连成一条时间线',
    suitable: ['时间线梳理'],
    reading: 'timeline',
    count: 3,
    cards: [
      { x: 232, y: 360, rot: 0, order: 1, lane: 'main', role: 'past', label: '过去' },
      { x: 360, y: 360, rot: 0, order: 2, lane: 'main', role: 'present', label: '现在' },
      { x: 488, y: 360, rot: 0, order: 3, lane: 'main', role: 'future', label: '未来' },
    ],
  }
  const merged: SpreadConfig = { ...base, ...patch }
  merged.cards = merged.cards.map((c) => ({ ...c, ...cardPatch }))
  if (patch.cards) merged.cards = patch.cards
  return JSON.parse(JSON.stringify(merged))
}

const validate = (raw: unknown) => validateSpread(raw, SPREAD_CARD_METRICS, SPREAD_CANVAS)

// ═══════════════════════════════════════════════════════════════════════════
//  ①  注册表本身是干净的
// ═══════════════════════════════════════════════════════════════════════════

describe('牌阵注册表 · 装载', () => {
  it('spreads.json 校验零 issue —— 任何一条都说明配置被改坏了', () => {
    // 这条断言的价值在于「第一次有人改坏 JSON 的那一刻」：
    // 失败信息里带 field + msg，直接指到哪一行该修。
    expect(SPREAD_ISSUES).toEqual([])
  })

  it('schemaVersion 与代码一致', () => {
    expect(SPREAD_SCHEMA_VERSION).toBe(1)
  })

  it('M2 要求的四套牌阵齐全，且分档正确', () => {
    const hot = spreadsByTier('hot').map((s) => s.id)
    const advanced = spreadsByTier('advanced').map((s) => s.id)

    // 常被翻开：单张每日指引 + 三张过去现在未来
    expect(hot).toEqual(['daily-single', 'past-present-future'])
    // 想深入时：二选一抉择阵 + 凯尔特十字牌阵
    expect(advanced).toEqual(['crossroads-two', 'celtic-cross'])
    expect(hot.length + advanced.length).toBe(SPREADS.length)
  })

  it('两档都有面向人的名字 —— 不许把 hot / advanced 直接给用户看', () => {
    const tiers: SpreadTier[] = ['hot', 'advanced']
    for (const t of tiers) {
      expect(TIER_LABEL[t]).toBeTruthy()
      expect(TIER_LABEL[t]).not.toContain(t)
    }
    expect(TIER_LABEL.hot).toBe('常被翻开')
    expect(TIER_LABEL.advanced).toBe('想深入时')
  })

  it('getSpread 认识全部牌阵，且不认识的返回 null（不是抛异常）', () => {
    for (const s of SPREADS) expect(getSpread(s.id)?.id).toBe(s.id)
    expect(getSpread('不存在的牌阵')).toBeNull()
    expect(getSpread('')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ②  几何：牌数 / 抽牌顺序 / 越界
// ═══════════════════════════════════════════════════════════════════════════

describe('牌阵几何 · 逐阵检查', () => {
  it('每个牌阵声明的 count 与实际 cards 长度一致', () => {
    for (const s of SPREADS) {
      expect(s.count, `牌阵「${s.name}」`).toBe(s.cards.length)
    }
  })

  it('抽牌顺序必须是 1..count 的一个排列 —— 重复或跳号都会让牌落错位置', () => {
    // 这是整套用例里最重要的一条。order 写重复时，前几张看着完全正常，
    // 错位发生在第 N 张之后，排查时几乎不可能想到是配置问题。
    for (const s of SPREADS) {
      const orders = s.cards.map((c) => c.order).sort((a, b) => a - b)
      const expected = Array.from({ length: s.count }, (_, i) => i + 1)
      expect(orders, `牌阵「${s.name}」的 order`).toEqual(expected)
    }
  })

  it('每一张牌都完整落在画布内（含旋转后的外接框）', () => {
    for (const s of SPREADS) {
      for (const c of s.cards) {
        const { hw, hh } = halfExtent(c, SPREAD_CARD_METRICS)
        const label = `${s.name} / ${c.label}`
        expect(c.x - hw, `${label} 左缘`).toBeGreaterThanOrEqual(-1e-6)
        expect(c.x + hw, `${label} 右缘`).toBeLessThanOrEqual(SPREAD_CANVAS.w + 1e-6)
        expect(c.y - hh, `${label} 上缘`).toBeGreaterThanOrEqual(-1e-6)
        expect(c.y + hh, `${label} 下缘`).toBeLessThanOrEqual(SPREAD_CANVAS.h + 1e-6)
      }
    }
  })

  it('横放的牌（rot ≈ 90）宽高互换 —— 否则越界检查会漏掉左右两侧', () => {
    const flat: SpreadCard = { x: 360, y: 360, rot: 90, order: 1, lane: 'main', role: 'r', label: 'l' }
    const { hw, hh } = halfExtent(flat, SPREAD_CARD_METRICS)
    expect(hw).toBe(SPREAD_CARD_METRICS.h / 2)
    expect(hh).toBe(SPREAD_CARD_METRICS.w / 2)

    // -90 走绝对值，结果与 +90 完全相同（判定不看旋转的正负，只看"是不是躺下")
    expect(halfExtent({ ...flat, rot: -90 }, SPREAD_CARD_METRICS)).toEqual({ hw, hh })
    // 45° 不互换：只有 90 / 270 才是严格横放，斜放的轴对齐外接框按未旋转算
    expect(halfExtent({ ...flat, rot: 45 }, SPREAD_CARD_METRICS)).toEqual({
      hw: SPREAD_CARD_METRICS.w / 2,
      hh: SPREAD_CARD_METRICS.h / 2,
    })
  })

  it('三张牌 —— 同一水平线、等距排开、方向一致', () => {
    const s = byId('past-present-future')
    const [a, b, c] = drawOrder(s)
    expect(a.y).toBe(b.y)
    expect(b.y).toBe(c.y)
    // 等距：相邻间距完全一致（时间线读起来才顺）
    expect(b.x - a.x).toBeCloseTo(c.x - b.x, 6)
    expect(a.rot).toBe(0)
    expect(b.rot).toBe(0)
    expect(c.rot).toBe(0)
  })

  it('二选一 —— A / B 两条泳道关于中轴镜像，各两张，且「远处」比「近景」更靠上', () => {
    const s = byId('crossroads-two')
    const cards = s.cards

    const laneA = cards.filter((c) => c.lane === 'A')
    const laneB = cards.filter((c) => c.lane === 'B')
    const main = cards.filter((c) => c.lane === 'main')
    expect(main).toHaveLength(1)
    expect(laneA).toHaveLength(2)
    expect(laneB).toHaveLength(2)

    const mid = main[0].x // 中轴 = 「此刻」的 x
    // ★ 镜像：A 的 x 与 B 的 x 关于中轴对称，误差 0
    expect(laneA[0].x - mid).toBeCloseTo(mid - laneB[0].x, 6)
    expect(laneA[1].x - mid).toBeCloseTo(mid - laneB[1].x, 6)

    // 两条路的旋转方向相反 —— 视觉上"往两边张开"
    expect(laneA[0].rot).toBeCloseTo(-laneB[0].rot, 6)
    expect(laneA[1].rot).toBeCloseTo(-laneB[1].rot, 6)

    // 「远处」在「近景」之上（y 更小）
    expect(laneA[1].y).toBeLessThan(laneA[0].y)
    expect(laneB[1].y).toBeLessThan(laneB[0].y)
  })

  it('凯尔特十字 —— 中心两张重叠（现况 + 横亘），十字臂对称，右侧一列四张', () => {
    const s = byId('celtic-cross')
    expect(s.count).toBe(10)

    const at = (role: string): SpreadCard => {
      const c = s.cards.find((x) => x.role === role)
      if (!c) throw new Error(`凯尔特十字缺少角色 ${role}`)
      return c
    }

    // ① 第 1、2 张同一点：一张正放、一张横放（这就是"十字"的来源）
    expect(at('now').x).toBe(at('block').x)
    expect(at('now').y).toBe(at('block').y)
    expect(at('now').rot).toBe(0)
    expect(at('block').rot).toBe(90)

    // ② 左右两臂关于中心竖轴对称
    const cx = at('now').x
    expect(at('past').x - cx).toBeCloseTo(cx - at('future').x, 6)
    expect(at('past').y).toBe(at('now').y)
    expect(at('future').y).toBe(at('now').y)

    // ③ 上下两张分居中心两侧（根基在下、目标在上）
    expect(at('goal').y).toBeLessThan(at('now').y)
    expect(at('root').y).toBeGreaterThan(at('now').y)

    // ④ 右侧「杖」列四张：x 相同、y 自上而下递增，且都在十字的右边
    const staff = s.cards.filter((c) => c.lane === 'staff')
    expect(staff).toHaveLength(4)
    expect(new Set(staff.map((c) => c.x)).size).toBe(1)
    const ys = staff.map((c) => c.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
    for (const c of staff) expect(c.x).toBeGreaterThan(at('now').x)

    // ⑤ 抽牌顺序里，右侧一列排在十字之后（先讲核心，再讲处境，最后结果）
    const order = drawOrder(s)
    expect(order[order.length - 1].role).toBe('outcome')
    expect(order.slice(6).map((c) => c.lane)).toEqual(['staff', 'staff', 'staff', 'staff'])
  })

  it('cardForDraw —— 第 n 张按 order 取，越界返回 null 而不是 undefined 崩掉', () => {
    const s = byId('crossroads-two')
    const order = drawOrder(s)
    for (let i = 0; i < s.count; i++) {
      expect(cardForDraw(s, i)).toEqual(order[i])
      expect(cardForDraw(s, i)?.order).toBe(i + 1)
    }
    expect(cardForDraw(s, s.count)).toBeNull()
    expect(cardForDraw(s, -1)).toBeNull()
  })

  it('drawOrder 不改动原数组（避免"顺手排序"污染配置真源）', () => {
    const s = byId('celtic-cross')
    const before = s.cards.map((c) => c.order)
    drawOrder(s)
    expect(s.cards.map((c) => c.order)).toEqual(before)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ③  结构：角色集合必须与解读结构完全一致
// ═══════════════════════════════════════════════════════════════════════════

describe('牌阵结构 · 角色集合是硬约束', () => {
  it('每个牌阵的角色集合与 READING_ROLES[strategy] 完全一致', () => {
    for (const s of SPREADS) {
      const want = [...READING_ROLES[s.reading]].sort()
      const got = s.cards.map((c) => c.role).sort()
      expect(got, `牌阵「${s.name}」(${s.reading})`).toEqual(want)
    }
  })

  it('四种解读结构都被用上了 —— 没有配了不用的策略', () => {
    const used = new Set(SPREADS.map((s) => s.reading))
    const all = Object.keys(READING_ROLES) as ReadingStrategy[]
    for (const k of all) expect(used.has(k), `没有牌阵在用 ${k}`).toBe(true)
  })

  it('牌位 label 互不重复 —— 两张牌叫同一个名字，用户不知道该看哪张', () => {
    for (const s of SPREADS) {
      const labels = s.cards.map((c) => c.label)
      expect(new Set(labels).size, `牌阵「${s.name}」的牌位名`).toBe(labels.length)
    }
  })

  it('same-position 的两张牌（凯尔特第 1/2 张）label 必须不同 —— 靠 label 区分正放与横放', () => {
    const s = byId('celtic-cross')
    const same = s.cards.filter((c) => c.x === s.cards[0].x && c.y === s.cards[0].y)
    expect(same).toHaveLength(2)
    expect(same[0].label).not.toBe(same[1].label)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ④  排版铁律：真名在上，解释在下
// ═══════════════════════════════════════════════════════════════════════════

describe('排版铁律 · 真名在上、解释在下', () => {
  it('凯尔特十字的副标题与需求原文逐字一致', () => {
    // ★ 用户给的原文，一个字都不能动。
    //   这条断言的意义不是"测试写得工整"，而是防止有人后来"顺手润色"一句 ——
    //   这句文案是产品定位的一部分，不是装饰。
    expect(subtitleOf(byId('celtic-cross'))).toBe(
      '深潜星图 · 一次深度的自我对话，剖析深层阻碍与结果（适合：复杂心结、人生规划）',
    )
  })

  it('二选一抉择阵的副标题与需求原文逐字一致', () => {
    expect(subtitleOf(byId('crossroads-two'))).toBe(
      '十字路口的微风 · 如果你面临选择，让牌面看看两边的风景（适合：决策困难、求事业）',
    )
  })

  it('toListItem 的第一行是「真名」，第二行是「解释」—— 两行不许颠倒', () => {
    for (const s of SPREADS) {
      const item = toListItem(s)
      expect(item.title).toBe(s.name)
      expect(item.subtitle).toBe(subtitleOf(s))
      // 主标题必须不含解释句的正文，否则就是有人把它塞进了第一行
      expect(item.title).not.toContain(s.poeticLine)
      // 副标题必须含别名与「适合：」
      expect(item.subtitle).toContain(s.poeticAlias)
      expect(item.subtitle).toContain('适合：')
    }
  })

  it('副标题由 subtitleOf 唯一生成 —— suitable 改了立刻反映，不会漏改某处手写文案', () => {
    const s = byId('past-present-future')
    const mutated: SpreadConfig = { ...s, suitable: ['甲', '乙', '丙'] }
    expect(subtitleOf(mutated)).toBe(`${s.poeticAlias} · ${s.poeticLine}（适合：甲、乙、丙）`)
  })

  it('meta 是中性数量说明，不带情绪修饰', () => {
    for (const s of SPREADS) {
      expect(toListItem(s).meta).toBe(`${s.count} 张`)
    }
  })

  it('副标题的行长可控 —— 超过两行就读不成「私语」了', () => {
    // 气泡 / 卡片第二行给的是约 300pt 宽、15pt 字号 ⇒ 一行约 20 字。
    // 副标题超过 46 字就必然折成三行，排版会挤掉主标题的呼吸感。
    for (const s of SPREADS) {
      expect(subtitleOf(s).length, `牌阵「${s.name}」副标题过长`).toBeLessThanOrEqual(46)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤  等比适配：resolveLayout
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveLayout · 等比适配到面板盒子', () => {
  const s = byId('celtic-cross')

  it('同尺寸盒子 = 恒等变换', () => {
    const l = resolveLayout(s, SPREAD_CANVAS.w, SPREAD_CANVAS.h)
    expect(l.scale).toBeCloseTo(1, 9)
    expect(l.offX).toBeCloseTo(0, 9)
    expect(l.offY).toBeCloseTo(0, 9)
    expect(l.cards.map((c) => c.x)).toEqual(s.cards.map((c) => c.x))
  })

  it('等比、不拉伸 —— 纵向不变、横向裁到一半时，两个方向的缩放必须相同', () => {
    const box = resolveLayout(s, 360, 720)
    // min(360/720, 720/720) = 0.5
    expect(box.scale).toBeCloseTo(0.5, 9)
    // 剩余空间居中：offX = (360 - 360)/2 = 0，offY = (720-720*0.5)/2 = 180
    expect(box.offX).toBeCloseTo(0, 9)
    expect(box.offY).toBeCloseTo(180, 9)

    // ★ 不拉伸的关键证据：卡片宽高比在面板坐标里仍等于原始比例
    const c0 = box.cards[0]
    expect(c0.w / c0.h).toBeCloseTo(SPREAD_CARD_METRICS.w / SPREAD_CARD_METRICS.h, 9)
  })

  it('相对关系（顺序、对称、泳道分组）在缩放后全部保持', () => {
    const l = resolveLayout(s, 400, 300, { padding: 16 })
    // 抽牌顺序仍按原 order 一一对应
    l.cards.forEach((rc, i) => {
      expect(rc.card).toBe(s.cards[i])
      expect(rc.rot).toBe(s.cards[i].rot)
    })
    // past / future 仍关于 now 的竖轴对称
    const cx = l.cards[0].x
    expect(l.cards[3].x - cx).toBeCloseTo(cx - l.cards[5].x, 9)
  })

  it('padding 计入内部可用区，且不改变等比性质', () => {
    const a = resolveLayout(s, 400, 400, { padding: 20 })
    const b = resolveLayout(s, 360, 360) // 400 - 2*20 = 360
    expect(a.scale).toBeCloseTo(b.scale, 9)
    expect(a.offX).toBeCloseTo(20, 9)
    expect(a.offY).toBeCloseTo(20, 9)
  })

  it('cardScale 只缩卡片本身，不动牌位坐标 —— 手账上的牌比牌位略小一点', () => {
    const big = resolveLayout(s, 720, 720)
    const small = resolveLayout(s, 720, 720, { cardScale: 0.9 })
    expect(small.cards.map((c) => c.x)).toEqual(big.cards.map((c) => c.x))
    expect(small.cards[0].w).toBeCloseTo(big.cards[0].w * 0.9, 9)
  })

  it('★ 尺寸非法时返回合法空布局，绝不是 NaN', () => {
    // NaN 会在渲染层静默画出空白，排查时完全看不出是哪来的。
    // 这里把「每个数都是有限数」当成硬约束。
    const bad: Array<[number, number]> = [
      [0, 0],
      [-100, -100],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 720],
      [-Infinity, -Infinity],
    ]
    for (const [w, h] of bad) {
      const l = resolveLayout(s, w, h)
      expect(Number.isFinite(l.scale)).toBe(true)
      expect(Number.isFinite(l.offX)).toBe(true)
      expect(Number.isFinite(l.offY)).toBe(true)
      for (const c of l.cards) {
        expect(Number.isFinite(c.x)).toBe(true)
        expect(Number.isFinite(c.y)).toBe(true)
        expect(Number.isFinite(c.w)).toBe(true)
        expect(Number.isFinite(c.h)).toBe(true)
      }
    }
  })

  it('padding 大于盒子时退化为 scale 0，仍然不是 NaN', () => {
    const l = resolveLayout(s, 100, 100, { padding: 200 })
    expect(l.scale).toBe(0)
    expect(Number.isFinite(l.offX)).toBe(true)
    expect(l.cards.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑥  解读计划：按牌阵结构动态调整
// ═══════════════════════════════════════════════════════════════════════════

describe('buildReadingPlan · 解读随牌阵结构变化', () => {
  it('默认读满：段落数 = 牌数，顺序与抽牌一致', () => {
    for (const s of SPREADS) {
      const plan = buildReadingPlan(s)
      expect(plan.drawn).toBe(s.count)
      expect(plan.sections).toHaveLength(s.count)
      expect(plan.sections.map((x) => x.order)).toEqual(
        Array.from({ length: s.count }, (_, i) => i + 1),
      )
      expect(plan.sections.map((x) => x.role)).toEqual(drawOrder(s).map((c) => c.role))
    }
  })

  it('★ 少翻几张也成立 —— 翻几张解读几张，不是失败态', () => {
    const s = byId('celtic-cross')
    const plan = buildReadingPlan(s, 3)
    expect(plan.drawn).toBe(3)
    expect(plan.sections).toHaveLength(3)
    expect(plan.sections.map((x) => x.role)).toEqual(['now', 'block', 'root'])
    expect(plan.sections.every((x) => x.cardIndex === null)).toBe(true)
  })

  it('drawn 越界被夹紧：负数 → 0，超过牌数 → 牌数', () => {
    const s = byId('crossroads-two')
    expect(buildReadingPlan(s, -5).sections).toHaveLength(0)
    expect(buildReadingPlan(s, 99).sections).toHaveLength(s.count)
    expect(buildReadingPlan(s, Number.NaN).sections).toHaveLength(0)
  })

  it('已抽到的牌映射到对应段落；没抽到的段 cardIndex 为 null', () => {
    const s = byId('past-present-future')
    const plan = buildReadingPlan(s, 3, [7, 3, 11])
    expect(plan.sections.map((x) => x.cardIndex)).toEqual([7, 3, 11])
  })

  it('★ 解读指引随结构不同 —— 时间线要串成一条线，对比阵不做胜负裁决', () => {
    const timeline = buildReadingPlan(byId('past-present-future'))
    const comparison = buildReadingPlan(byId('crossroads-two'))
    const cross = buildReadingPlan(byId('celtic-cross'))

    expect(timeline.summaryGuidance).toContain('来路')
    expect(comparison.summaryGuidance).toContain('不做胜负裁决')
    expect(cross.summaryGuidance).toContain('结果')

    // 三者的段落指引两两不同，且 summary 也两两不同
    const summ = new Set([timeline.summaryGuidance, comparison.summaryGuidance, cross.summaryGuidance])
    expect(summ.size).toBe(3)
    expect(timeline.sections[0].guidance).not.toBe(comparison.sections[0].guidance)
    expect(cross.sections[0].guidance).toContain('中心')
  })

  it('计划里带上了标题与副标题 —— UI 不必再去查牌阵', () => {
    const s = byId('crossroads-two')
    const plan = buildReadingPlan(s)
    expect(plan.title).toBe(s.name)
    expect(plan.subtitle).toBe(subtitleOf(s))
    expect(plan.strategy).toBe('comparison')
    expect(plan.spreadId).toBe('crossroads-two')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑦  防崩降级：坏配置只丢坏的那部分
// ═══════════════════════════════════════════════════════════════════════════

describe('validateRegistry · 降级哲学', () => {
  it('schemaVersion 不认识 → 整份丢弃，退到保命牌阵', () => {
    const r = validateRegistry({ schemaVersion: 999, spreads: [mkTimeline()] })
    expect(r.spreads).toHaveLength(1)
    expect(r.spreads[0].id).toBe(FALLBACK_SPREAD.id)
    expect(r.issues.some((i) => i.field === 'schemaVersion')).toBe(true)
  })

  it('保命牌阵本身是合法的 —— 它要能真的走完一次占卜', () => {
    expect(FALLBACK_SPREAD.count).toBe(FALLBACK_SPREAD.cards.length)
    const plan = buildReadingPlan(FALLBACK_SPREAD)
    expect(plan.sections).toHaveLength(1)
    expect(plan.sections[0].role).toBe('today')
  })

  it('单个牌阵坏掉只丢它自己，其余照常可用', () => {
    const good = mkTimeline()
    const bad = mkTimeline({ id: 'broken', cards: [{ ...drawOrder(byId('past-present-future'))[0], order: 9 }] })
    const r = validateRegistry({ schemaVersion: 1, spreads: [good, bad] })
    expect(r.spreads.map((s) => s.id)).toEqual(['unit-timeline'])
    expect(r.issues.some((i) => i.id === 'broken' && i.field === 'count')).toBe(true)
  })

  it('一个可用牌阵都没有 → 退到保命牌阵（而不是空列表）', () => {
    const r = validateRegistry({ schemaVersion: 1, spreads: [] })
    expect(r.spreads.map((s) => s.id)).toEqual([FALLBACK_SPREAD.id])
    expect(r.issues.some((i) => i.id === '(root)')).toBe(true)
  })

  it('重复 id 只保留先出现的那个', () => {
    const r = validateRegistry({ schemaVersion: 1, spreads: [mkTimeline(), mkTimeline()] })
    expect(r.spreads).toHaveLength(1)
    expect(r.issues.some((i) => i.field === 'id' && i.msg.includes('重复'))).toBe(true)
  })

  it('完全不是对象 / null / 字符串都不抛异常', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      const r = validateRegistry(junk)
      expect(r.spreads.length).toBeGreaterThan(0)
    }
  })
})

describe('validateSpread · 逐字段拦截', () => {
  it('合法输入通过，且 cards 被规整复制（不与入参共享引用）', () => {
    const raw = mkTimeline()
    const r = validate(raw)
    expect(r.issues).toEqual([])
    expect(r.spread).not.toBeNull()
    expect(r.spread!.cards).not.toBe((raw as SpreadConfig).cards)
  })

  it('抽牌顺序不是排列 → 拦截，报出实际顺序', () => {
    const s = byId('past-present-future')
    const raw = mkTimeline({
      cards: s.cards.map((c, i) => ({ ...c, order: i === 2 ? 2 : c.order })),
    })
    const r = validate(raw)
    expect(r.spread).toBeNull()
    const issue = r.issues.find((i) => i.field === 'cards[].order')
    expect(issue).toBeTruthy()
    expect(issue!.msg).toContain('排列')
    expect(issue!.msg).toContain('1, 2, 2')
  })

  it('越界 → 拦截，并把越界的那张牌的名字说出来', () => {
    const s = byId('past-present-future')
    const raw = mkTimeline({ cards: [{ ...s.cards[0], x: 5 }, s.cards[1], s.cards[2]] })
    const r = validate(raw)
    expect(r.spread).toBeNull()
    const issue = r.issues.find((i) => i.msg.includes('越界'))
    expect(issue).toBeTruthy()
    expect(issue!.msg).toContain('过去')
  })

  it('角色缺失 / 多出 → 拦截，并指名道姓', () => {
    const s = byId('past-present-future')
    const missing = validate(mkTimeline({ cards: [{ ...s.cards[0], role: 'future' }, s.cards[1], s.cards[2]] }))
    expect(missing.spread).toBeNull()
    expect(missing.issues.some((i) => i.msg.includes('缺少角色') && i.msg.includes('past'))).toBe(true)

    const extra = validate(mkTimeline({ cards: [{ ...s.cards[0], role: '命运' }, s.cards[1], s.cards[2]] }))
    expect(extra.spread).toBeNull()
    expect(extra.issues.some((i) => i.msg.includes('不认识'))).toBe(true)
  })

  it('★ 非法的 reading 值必须被拦下（这里曾有过运算符优先级 bug，永远放行）', () => {
    // 回归用例：`!(x) in TABLE` 会被解析成 `(!x) in TABLE` —— 布尔值永远查不到键，
    // 于是非法 reading 一路放行，直到后面按 undefined 取表才炸。
    for (const bad of ['', 'timeline ', 'TIMELINE', 'nope', 0, null, undefined]) {
      const r = validate(mkTimeline({ reading: bad as unknown as ReadingStrategy }))
      expect(r.spread, `reading=${String(bad)} 应被拒绝`).toBeNull()
      expect(r.issues.some((i) => i.field === 'reading')).toBe(true)
    }
  })

  it('count 与实际牌数不符 → 拦截', () => {
    const r = validate(mkTimeline({ count: 4 }))
    expect(r.spread).toBeNull()
    expect(r.issues.some((i) => i.field === 'count')).toBe(true)
  })

  it('缺 subtitle 三要素任一个 → 拦截（排版铁律不允许第二行开天窗）', () => {
    for (const field of ['poeticAlias', 'poeticLine'] as const) {
      const r = validate(mkTimeline({ [field]: '' } as Partial<SpreadConfig>))
      expect(r.spread).toBeNull()
      expect(r.issues.some((i) => i.field === field)).toBe(true)
    }
    const r = validate(mkTimeline({ name: '' }))
    expect(r.issues.some((i) => i.field === 'name')).toBe(true)
  })

  it('suitable 为空数组 → 拦截（「适合：」后面不能是空的）', () => {
    const r = validate(mkTimeline({ suitable: [] }))
    expect(r.spread).toBeNull()
    expect(r.issues.some((i) => i.field === 'suitable')).toBe(true)
  })

  it('rot 超出 [-180,180] → 拦截', () => {
    const r = validate(mkTimeline({}, { rot: 200 }))
    expect(r.spread).toBeNull()
    expect(r.issues.some((i) => i.field.includes('rot'))).toBe(true)
  })

  it('坐标是 NaN / 无穷 → 拦截，不允许半张牌', () => {
    const r = validate(mkTimeline({}, { x: Number.NaN }))
    expect(r.spread).toBeNull()
    expect(r.issues.some((i) => i.field.includes('xy'))).toBe(true)
  })
})
