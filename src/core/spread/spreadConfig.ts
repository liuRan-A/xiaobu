/**
 * 小卜 · 牌阵引擎（数据驱动）   src/core/spread/spreadConfig.ts
 * ===========================================================================
 * 战略原文：
 *   「**数据驱动的牌阵引擎（SpreadConfig）**：底层使用配置数组，严禁写死代码。
 *     在 `spreads.json` 中配置不同牌阵的**卡牌数量、坐标排布与抽牌顺序**。」
 *   「**专业与温柔的完美平衡（排版铁律）**：真实名称必须放在第一行（主标题），
 *     温柔的解释放在第二行（副标题）。」
 *   「AI 解读需根据牌阵结构**动态调整**（如时间线、对比分析）。」
 *
 * ── 本文件守的三件事 ───────────────────────────────────────────────────────
 *   ① **坐标只在 spreads.json 里存在。** 本文件不出现任何一个字面量坐标；
 *      渲染层也不许出现。想改排布 → 改 JSON，代码零改动。
 *   ② **排版铁律由一个函数兑现。** `subtitleOf()` 是副标题的**唯一生成处**，
 *      主标题 = `spread.name`。单测钉住用户给的两个样例字符串逐字相等 ——
 *      这样"真名在上、解释在下"就不是设计口头约定，而是编译期资产。
 *   ③ **解读计划按牌阵结构生成。** 不同牌阵产出不同的 `sections` 与不同的
 *      `guidance`（时间线要串因果、对比要并置、十字要先中心后四周）——
 *      这就是"AI 解读动态调整"的落点，且它是纯数据，可单测。
 *
 * ── 为什么这里不 import @scene/renderer ────────────────────────────────────
 * ESLint 禁令 1：`src/core/**` 必须零依赖（不许 import @scene / @ui / @store）。
 * 所以牌阵自己的等比适配在下面用 8 行写完。它和 scene 的 `computeFit()` 是
 * **两个不同领域**的适配（一个是 UI 面板，一个是等距房间），不是重复实现。
 * ===========================================================================
 */

import rawSpreads from './spreads.json'
import { logger } from '@shared/logger'

// ───────────────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────────────

export const SPREAD_SCHEMA_VERSION = 1

export const SPREAD_TIERS = ['hot', 'advanced'] as const
export type SpreadTier = (typeof SPREAD_TIERS)[number]
export const TIER_LABEL: Record<SpreadTier, string> = {
  hot: '常被翻开',
  advanced: '想深入时',
}

export type ReadingStrategy = 'single' | 'timeline' | 'comparison' | 'cross'

/**
 * ★ 每个解读结构**必须**用到的角色集合。
 *   这是"牌阵结构决定解读结构"的硬约束：JSON 里少写/多写一个角色，直接不通过校验。
 *   好处是——将来加一个牌阵，忘了给某张牌定角色，CI 会先炸，而不是上线后 AI 解读少一段。
 */
export const READING_ROLES: Record<ReadingStrategy, readonly string[]> = {
  single: ['today'],
  timeline: ['past', 'present', 'future'],
  comparison: ['now', 'pathA_near', 'pathA_far', 'pathB_near', 'pathB_far'],
  cross: ['now', 'block', 'root', 'past', 'goal', 'future', 'self', 'env', 'hope_fear', 'outcome'],
}

/** 解读指引：写给"提示词组装层"看的，不是写给用户看的 */
const STRATEGY_GUIDANCE: Record<ReadingStrategy, { section: string; summary: string }> = {
  single: {
    section: '只读这一张：不展开、不堆术语，最后落到一件**今天就能做的小事**上。',
    summary: '一句话收束，留一个开放式的问题给用户。',
  },
  timeline: {
    section: '三段必须串成**一条线**：指出前一段如何导致了后一段，而不是三段各说一遍。',
    summary: '按"来路 → 脚下 → 前方"的顺序讲，中间不要跳。',
  },
  comparison: {
    section: '左右两路**分别成段**，各自讲清"近景是什么感觉、远处会到哪里"。',
    summary: '最后给出两条路各自的风景，**不做胜负裁决** —— 决定的人是用户。',
  },
  cross: {
    section: '先读**中心两张**（现况 + 横亘其上的），这两张的解释要相互咬合；再读四周的处境。',
    summary: '最后才读右侧一列的结果，并说明"这是在当前选择下才成立的结果"。',
  },
}

export interface SpreadCard {
  /** 牌阵空间里的中心点（画布坐标系见 spreads.json 的 canvas） */
  x: number
  y: number
  /** 旋转角度（度）。凯尔特十字的第 2 张横放 = 90 */
  rot: number
  /** ★ 抽牌顺序：必须是 1..count 的一个排列 */
  order: number
  /** 分组泳道：二选一用 A / B 区分两条路；凯尔特用 staff 区分右侧一列 */
  lane: string
  /** 语义角色：解读计划据此分段（键必须是 READING_ROLES[strategy] 的成员） */
  role: string
  /** 牌位含义标签，展示给用户（如"现况""正在退场的事"） */
  label: string
}

export interface SpreadConfig {
  id: string
  tier: SpreadTier
  /** ★ 第一行：真实名称（主标题） */
  name: string
  /** ★ 第二行开头：温柔的别名（如"深潜星图"） */
  poeticAlias: string
  /** ★ 第二行正文：一句话解释 */
  poeticLine: string
  /** ★ 第二行括号里：适合什么 */
  suitable: string[]
  reading: ReadingStrategy
  count: number
  cards: SpreadCard[]
}

export interface SpreadCardMetrics {
  w: number
  h: number
  radius: number
}

export interface SpreadIssue {
  /** 出问题的牌阵 id；整份文件级问题用 '(root)' */
  id: string
  field: string
  msg: string
}

export interface SpreadRegistry {
  schemaVersion: number
  card: SpreadCardMetrics
  canvas: { w: number; h: number }
  spreads: SpreadConfig[]
  issues: SpreadIssue[]
}

// ───────────────────────────────────────────────────────────────────────────
// 解析与校验 —— ★ 永不抛异常，最坏情况退到 FALLBACK_SPREAD（防崩底线）
// ───────────────────────────────────────────────────────────────────────────

const EPS = 1e-6

/**
 * 保命牌阵：只在整份 JSON 不可用时使用。
 * ★ 它**不是常规路径** —— 常规路径是 spreads.json（随包构建，运行时不可能解析失败）。
 *   存在的意义是：万一有人把 JSON 改坏、构建期没拦住，用户仍能完成一次占卜，
 *   而不是对着一个空的牌阵选择页。类型上它是完整的 SpreadConfig，不需要特判。
 */
export const FALLBACK_SPREAD: SpreadConfig = Object.freeze({
  id: 'daily-single',
  tier: 'hot',
  name: '单张每日指引',
  poeticAlias: '清晨的一枚书签',
  poeticLine: '一句话，今天只带这一句上路',
  suitable: ['今日状态'],
  reading: 'single',
  count: 1,
  cards: [
    { x: 360, y: 360, rot: 0, order: 1, lane: 'main', role: 'today', label: '今日' },
  ],
}) as unknown as SpreadConfig

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** 旋转后的半外接尺寸 —— 90/270 度时宽高互换 */
export function halfExtent(card: SpreadCard, m: SpreadCardMetrics): { hw: number; hh: number } {
  const swapped = Math.abs(Math.round(card.rot) % 180) === 90
  return swapped ? { hw: m.h / 2, hh: m.w / 2 } : { hw: m.w / 2, hh: m.h / 2 }
}

/** 校验一个牌阵。返回 { spread, issues }；spread 为 null 表示这个牌阵不可用 */
export function validateSpread(
  input: unknown,
  metrics: SpreadCardMetrics,
  canvas: { w: number; h: number },
): { spread: SpreadConfig | null; issues: SpreadIssue[] } {
  const issues: SpreadIssue[] = []
  const id = (input as { id?: unknown })?.id
  const oid = isNonEmptyStr(id) ? id : '(unknown)'
  const bad = (field: string, msg: string): void => {
    issues.push({ id: oid, field, msg })
  }

  if (!input || typeof input !== 'object') {
    bad('shape', '不是一个对象')
    return { spread: null, issues }
  }

  const o = input as Record<string, unknown>

  if (!isNonEmptyStr(o.id)) bad('id', '必须是非空字符串')
  if (!SPREAD_TIERS.includes(o.tier as SpreadTier)) bad('tier', `必须是 ${SPREAD_TIERS.join(' / ')}`)
  if (!isNonEmptyStr(o.name)) bad('name', '主标题（真实名称）不能为空 —— 排版铁律第一行')
  if (!isNonEmptyStr(o.poeticAlias)) bad('poeticAlias', '副标题的温柔别名不能为空')
  if (!isNonEmptyStr(o.poeticLine)) bad('poeticLine', '副标题的解释句不能为空')
  if (!Array.isArray(o.suitable) || o.suitable.length === 0 || !o.suitable.every(isNonEmptyStr)) {
    bad('suitable', '必须是非空的「适合什么」字符串数组')
  }
  // ★ 判断「这个 reading 值认不认识」。
  //   千万不要写成 `!(o.reading as string) in READING_ROLES`：
  //   `in` 的优先级低于 `!`，那句话会被解析成 `(!x) in T` ——
  //   布尔值在对象里永远查不到键，于是**永远为 false**，
  //   结果是非法 reading 值一路放行，直到后面 `READING_ROLES[undefined]` 才炸。
  const strategyOk =
    isNonEmptyStr(o.reading) && Object.prototype.hasOwnProperty.call(READING_ROLES, o.reading)
  if (!strategyOk) {
    bad('reading', `必须是 ${Object.keys(READING_ROLES).join(' / ')} 之一`)
  }
  if (!Array.isArray(o.cards)) {
    bad('cards', '必须是数组')
    return { spread: null, issues }
  }

  const cards = o.cards as unknown[]
  if (!isFiniteNum(o.count)) bad('count', '必须是数字')
  else if (o.count !== cards.length) bad('count', `声明 ${o.count} 张，实际给了 ${cards.length} 张`)

  // ── 逐张校验 ──
  const parsed: SpreadCard[] = []
  cards.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      bad(`cards[${i}]`, '不是对象')
      return
    }
    const cc = c as Record<string, unknown>
    if (!isFiniteNum(cc.x) || !isFiniteNum(cc.y)) bad(`cards[${i}].xy`, 'x / y 必须是有限数字')
    if (!isFiniteNum(cc.rot) || Math.abs(cc.rot) > 180) bad(`cards[${i}].rot`, 'rot 必须是 [-180,180] 内的数字')
    if (!isFiniteNum(cc.order) || !Number.isInteger(cc.order)) bad(`cards[${i}].order`, 'order 必须是整数')
    if (!isNonEmptyStr(cc.lane)) bad(`cards[${i}].lane`, 'lane 不能为空')
    if (!isNonEmptyStr(cc.role)) bad(`cards[${i}].role`, 'role 不能为空')
    if (!isNonEmptyStr(cc.label)) bad(`cards[${i}].label`, 'label（牌位含义）不能为空')
    if (isFiniteNum(cc.x) && isFiniteNum(cc.y) && isFiniteNum(cc.rot)) {
      parsed.push({
        x: cc.x,
        y: cc.y,
        rot: cc.rot,
        order: isFiniteNum(cc.order) ? cc.order : i + 1,
        lane: String(cc.lane ?? ''),
        role: String(cc.role ?? ''),
        label: String(cc.label ?? ''),
      })
    }
  })

  // ── 抽牌顺序必须是 1..count 的一个排列 ──
  // ★ 这条不能省：order 写重复了，会在"抽到第 3 张该落在哪个位置"时静默错位，
  //   而且错得极隐蔽（前两张看着都对）。用排列校验一次性拦住。
  const orders = parsed.map((c) => c.order).sort((a, b) => a - b)
  const expected = Array.from({ length: cards.length }, (_, i) => i + 1)
  if (orders.length === expected.length && orders.some((v, i) => v !== expected[i])) {
    bad('cards[].order', `抽牌顺序必须是 1..${cards.length} 的排列，实际是 [${orders.join(', ')}]`)
  }

  // ── 每张牌必须完整落在画布内（含旋转后的外接框） ──
  parsed.forEach((c, i) => {
    const { hw, hh } = halfExtent(c, metrics)
    if (
      c.x - hw < -EPS ||
      c.x + hw > canvas.w + EPS ||
      c.y - hh < -EPS ||
      c.y + hh > canvas.h + EPS
    ) {
      bad(
        `cards[${i}]`,
        `牌位「${c.label}」越界：中心 (${c.x}, ${c.y}) ± (${hw}, ${hh}) 超出画布 ${canvas.w}×${canvas.h}`,
      )
    }
  })

  // ── 角色集合必须与解读结构**完全一致** ──
  if (strategyOk) {
    const strategy = o.reading as ReadingStrategy
    const want = READING_ROLES[strategy]
    const got = parsed.map((c) => c.role)
    const missing = want.filter((r) => !got.includes(r))
    const extra = got.filter((r) => !want.includes(r))
    if (missing.length) bad('cards[].role', `解读结构「${strategy}」缺少角色：${missing.join(', ')}`)
    if (extra.length) bad('cards[].role', `解读结构「${strategy}」不认识这些角色：${extra.join(', ')}`)
  }

  if (issues.length) return { spread: null, issues }

  const spread: SpreadConfig = {
    id: o.id as string,
    tier: o.tier as SpreadTier,
    name: o.name as string,
    poeticAlias: o.poeticAlias as string,
    poeticLine: o.poeticLine as string,
    suitable: (o.suitable as string[]).slice(),
    reading: o.reading as ReadingStrategy,
    count: cards.length,
    cards: parsed,
  }
  return { spread, issues }
}

function readMetrics(v: unknown): SpreadCardMetrics {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    w: isFiniteNum(o.w) && o.w > 0 ? o.w : 108,
    h: isFiniteNum(o.h) && o.h > 0 ? o.h : 180,
    radius: isFiniteNum(o.radius) && o.radius >= 0 ? o.radius : 12,
  }
}

function readCanvas(v: unknown): { w: number; h: number } {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    w: isFiniteNum(o.w) && o.w > 0 ? o.w : 720,
    h: isFiniteNum(o.h) && o.h > 0 ? o.h : 720,
  }
}

/** 校验整份注册表。单个牌阵坏掉只丢它自己，不牵连其他 —— 与远程配置同一套降级哲学。 */
export function validateRegistry(raw: unknown): SpreadRegistry {
  const root = (raw ?? {}) as Record<string, unknown>
  const metrics = readMetrics(root.card)
  const canvas = readCanvas(root.canvas)
  const issues: SpreadIssue[] = []
  const spreads: SpreadConfig[] = []

  if (root.schemaVersion !== SPREAD_SCHEMA_VERSION) {
    issues.push({
      id: '(root)',
      field: 'schemaVersion',
      msg: `期望 ${SPREAD_SCHEMA_VERSION}，实际 ${String(root.schemaVersion)} —— 整份丢弃`,
    })
    // ★ 版本不认识就整份丢弃，不用半个：字段语义可能已经变了（与远程配置 §8.4.4 同款判断）
    return { schemaVersion: SPREAD_SCHEMA_VERSION, card: metrics, canvas, spreads: [FALLBACK_SPREAD], issues }
  }

  const list = Array.isArray(root.spreads) ? root.spreads : []
  const seen = new Set<string>()
  for (const item of list) {
    const r = validateSpread(item, metrics, canvas)
    issues.push(...r.issues)
    if (!r.spread) continue
    if (seen.has(r.spread.id)) {
      issues.push({ id: r.spread.id, field: 'id', msg: '重复的牌阵 id' })
      continue
    }
    seen.add(r.spread.id)
    spreads.push(r.spread)
  }

  if (spreads.length === 0) {
    issues.push({ id: '(root)', field: 'spreads', msg: '没有任何可用牌阵 —— 退到保命牌阵' })
    spreads.push(FALLBACK_SPREAD)
  }

  return { schemaVersion: SPREAD_SCHEMA_VERSION, card: metrics, canvas, spreads, issues }
}

/** 构建期就把 JSON 校验掉；失败也绝不抛，只 warn 一次（门禁 ⑨：catch 内不出 UI） */
function loadRegistry(): SpreadRegistry {
  try {
    return validateRegistry(rawSpreads as unknown)
  } catch (e) {
    logger.warn('[spread] 注册表解析失败，退到保命牌阵', e)
    return {
      schemaVersion: SPREAD_SCHEMA_VERSION,
      card: readMetrics(undefined),
      canvas: readCanvas(undefined),
      spreads: [FALLBACK_SPREAD],
      issues: [{ id: '(root)', field: 'parse', msg: '抛异常' }],
    }
  }
}

export const SPREAD_REGISTRY: SpreadRegistry = loadRegistry()
export const SPREADS: readonly SpreadConfig[] = SPREAD_REGISTRY.spreads
export const SPREAD_ISSUES: readonly SpreadIssue[] = SPREAD_REGISTRY.issues
export const SPREAD_CARD_METRICS: SpreadCardMetrics = SPREAD_REGISTRY.card
export const SPREAD_CANVAS: { w: number; h: number } = SPREAD_REGISTRY.canvas

if (SPREAD_ISSUES.length) {
  // 生产里这一行是排查线索，不是给用户看的东西
  logger.warn(`[spread] ${SPREAD_ISSUES.length} 项配置问题`, SPREAD_ISSUES)
}

export function getSpread(id: string): SpreadConfig | null {
  return SPREADS.find((s) => s.id === id) ?? null
}

/** ★ 按 tier 分组给 UI —— UI 不许自己写死"哪些是常被翻开的" */
export function spreadsByTier(tier: SpreadTier): SpreadConfig[] {
  return SPREADS.filter((s) => s.tier === tier)
}

// ───────────────────────────────────────────────────────────────────────────
// 排版铁律：真名在上，解释在下
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★★ 副标题的**唯一生成处**。UI 层不许自己拼字符串 ——
 *    一旦两处拼，`suitable` 改了就会有一处忘记同步。
 *
 * 产出形态（与战略书逐字一致）：
 *   深潜星图 · 一次深度的自我对话，剖析深层阻碍与结果（适合：复杂心结、人生规划）
 */
export function subtitleOf(s: SpreadConfig): string {
  return `${s.poeticAlias} · ${s.poeticLine}（适合：${s.suitable.join('、')}）`
}

/** 牌阵选择条目 —— UI 只消费这个结构，不自己拼文案 */
export interface SpreadListItem {
  id: string
  tier: SpreadTier
  /** 第一行：真名 */
  title: string
  /** 第二行：温柔的解释 */
  subtitle: string
  /** 第三行：中性的数量说明（留给排版做次级信息） */
  meta: string
}

export function toListItem(s: SpreadConfig): SpreadListItem {
  return {
    id: s.id,
    tier: s.tier,
    title: s.name,
    subtitle: subtitleOf(s),
    meta: `${s.count} 张`,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 抽牌顺序与坐标解算
// ───────────────────────────────────────────────────────────────────────────

/** ★ 抽牌顺序：按 order 升序 —— 不是数组顺序，也不是位置顺序 */
export function drawOrder(s: SpreadConfig): SpreadCard[] {
  return [...s.cards].sort((a, b) => a.order - b.order)
}

/** 第 n 张被抽出的牌该落在哪个牌位（n 从 0 起） */
export function cardForDraw(s: SpreadConfig, n: number): SpreadCard | null {
  return drawOrder(s)[n] ?? null
}

export interface ResolvedCard {
  card: SpreadCard
  /** 面板坐标里的中心点 */
  x: number
  y: number
  rot: number
  /** 面板坐标里的尺寸（已含缩放） */
  w: number
  h: number
}

export interface ResolvedLayout {
  scale: number
  offX: number
  offY: number
  /** 面板盒子（就是传进来的 box） */
  w: number
  h: number
  cards: ResolvedCard[]
}

export interface LayoutOptions {
  /** 面板四周留白（面板坐标单位） */
  padding?: number
  /** 卡片整体缩放（手账上牌比牌位略小一点更好看） */
  cardScale?: number
}

/**
 * 把牌阵等比适配到面板盒子里。
 * ★ 等比，不拉伸 —— 拉伸会让凯尔特十字的十字臂长不等，牌阵结构就读不出来了。
 * ★ 尺寸非法时返回一组合法的空布局，而不是 NaN（NaN 会在渲染层静默画出空白，
 *   排查时完全看不出是哪来的 —— 见 skill: ardot-canvas-pitfalls §九·5）。
 */
export function resolveLayout(
  s: SpreadConfig,
  boxW: number,
  boxH: number,
  opts: LayoutOptions = {},
): ResolvedLayout {
  const pad = opts.padding ?? 0
  const cardScale = opts.cardScale ?? 1
  const bw = Number.isFinite(boxW) && boxW > 0 ? boxW : SPREAD_CANVAS.w
  const bh = Number.isFinite(boxH) && boxH > 0 ? boxH : SPREAD_CANVAS.h
  const innerW = Math.max(0, bw - pad * 2)
  const innerH = Math.max(0, bh - pad * 2)

  const raw = Math.min(innerW / SPREAD_CANVAS.w, innerH / SPREAD_CANVAS.h)
  const usable = Number.isFinite(raw) && raw > 0 ? raw : 0
  const offX = (bw - SPREAD_CANVAS.w * usable) / 2
  const offY = (bh - SPREAD_CANVAS.h * usable) / 2

  return {
    scale: usable,
    offX,
    offY,
    w: bw,
    h: bh,
    cards: s.cards.map((card) => ({
      card,
      x: offX + card.x * usable,
      y: offY + card.y * usable,
      rot: card.rot,
      w: SPREAD_CARD_METRICS.w * usable * cardScale,
      h: SPREAD_CARD_METRICS.h * usable * cardScale,
    })),
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 解读计划 —— 「按牌阵结构动态调整」
// ───────────────────────────────────────────────────────────────────────────

export interface ReadingSection {
  order: number
  role: string
  label: string
  /** 该牌位的解读指引（喂给提示词，不展示） */
  guidance: string
  /** 该位置上的牌（未抽到则为 null —— 半途浏览时不崩） */
  cardIndex: number | null
}

export interface ReadingPlan {
  spreadId: string
  spreadName: string
  /** ★ 主标题 */
  title: string
  /** ★ 副标题（温柔的解释） */
  subtitle: string
  strategy: ReadingStrategy
  sections: ReadingSection[]
  summaryGuidance: string
  /** 用户实际翻开了几张 */
  drawn: number
}

/**
 * 生成解读计划。
 *
 * @param s     牌阵
 * @param drawn 用户实际翻开的牌数（默认全部）。★ 不是失败态：翻几张就解读几张，
 *              少的那几段直接不出现在计划里 —— 这比"请先抽满 10 张"温柔得多。
 * @param deck  实际抽出的牌（牌库下标），缺省表示还没抽
 */
export function buildReadingPlan(
  s: SpreadConfig,
  drawn: number = s.count,
  deck: readonly number[] = [],
): ReadingPlan {
  const n = Math.max(0, Math.min(Math.floor(drawn) || 0, s.count))
  const g = STRATEGY_GUIDANCE[s.reading]
  const sequence = drawOrder(s).slice(0, n)

  return {
    spreadId: s.id,
    spreadName: s.name,
    title: s.name,
    subtitle: subtitleOf(s),
    strategy: s.reading,
    drawn: n,
    sections: sequence.map((c, i) => ({
      order: c.order,
      role: c.role,
      label: c.label,
      guidance: g.section,
      cardIndex: deck.length > i ? (deck[i] ?? null) : null,
    })),
    summaryGuidance: g.summary,
  }
}
