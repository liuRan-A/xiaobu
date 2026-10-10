/**
 * 小卜 · 记忆锚点   src/core/memory/memoryAnchor.ts
 * ===========================================================================
 * 战略原文（灵魂机制 ①）：
 *   「**记忆锚点（Memory Anchor）**：每次占卜听完解读后，根据**情绪基调**
 *     提供 2–3 个轻量级摆件。用户**亲手拖拽**放置到小屋。点击摆件，
 *     **优雅浮现**当时的记录（如：'2026年10月10日，你选择了这盆绿植，决定重新出发'）。
 *     纯本地存储（禁用高并发 LocalStorage 与 IndexedDB），**绝对不做社交分享**。」
 *
 * ── 三个"必须"和三个"绝不" ─────────────────────────────────────────────────
 *   必须：① 摆件由**情绪基调**筛出来（不是随机发奖）
 *         ② 用户**亲手**放（引擎只给建议，绝不自动摆好）
 *         ③ 记录用**当时的日期 + 当时的话**，所以这份数据必须真的留在本地
 *   绝不：① 不分享、不上传（出端载荷里根本没有这些字段，见 reading.ts）
 *         ② 不做"收集度/成就/连续打卡"—— 那是把陪伴变成任务
 *         ③ 不做删除确认弹窗（用户想扔就扔，进程里删掉就行）
 *
 * ── 「优雅浮现」是什么 ──────────────────────────────────────────────────────
 *   点击摆件 → 小卜的**低语卡**（不是弹窗、不是模态、不遮住小屋）：
 *   一行日期 + 一行当时的话。它由 `recallOf()` 生成，格式按战略原文逐字对齐。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { FOCUS_LABEL, MOOD_LABEL, type FocusId, type MoodTone } from '@core/reading'
import { occupancyOf, placeAt, type AnchorId } from '@core/room/roomZone'
import { PERSIST_KEYS, type PersistedStore } from '@core/persist'
import type { Pt } from '@core/ritual/flight'

// ───────────────────────────────────────────────────────────────────────────
// 摆件目录
// ───────────────────────────────────────────────────────────────────────────

export const MEMORY_KINDS = ['plant', 'stone', 'lantern', 'shell', 'bell', 'candle', 'seed', 'ticket'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

export interface MemoryKindDef {
  /** 展示名 —— 会出现在浮现的句子里，所以必须能自然地被"你选择了这XX"接住 */
  name: string
  /** 量词 —— 「这盆绿植」「这块石头」；中文量词不写对，整句话就假了 */
  classifier: string
  /** 适合哪些情绪基调。空数组 = 谁都可以（保留给纪念品） */
  tones: readonly MoodTone[]
  /** 轻量级说明（1 行，给"想带走哪一件"那张卡片用） */
  whisper: string
}

/**
 * ★ 目录只有 8 件，而且是**刻意**少。
 *   "轻量级摆件"的"轻"既指视觉轻，也指**选择负担轻**：
 *   每次只给 2–3 个候选，多的选项只会让"我想要哪个"变成"我该选哪个"。
 */
export const MEMORY_CATALOG: Record<MemoryKind, MemoryKindDef> = {
  plant: { name: '绿植', classifier: '盆', tones: ['HOPEFUL', 'CALM'], whisper: '会长大，不用你操心。' },
  stone: { name: '鹅卵石', classifier: '块', tones: ['TIRED', 'DOWN'], whisper: '什么都不做，只是沉在那里。' },
  lantern: { name: '小灯', classifier: '盏', tones: ['DOWN', 'ANXIOUS'], whisper: '不亮，但一直有电。' },
  shell: { name: '贝壳', classifier: '枚', tones: ['CALM'], whisper: '贴耳朵能听见很远的地方。' },
  bell: { name: '铜铃', classifier: '只', tones: ['RESTLESS', 'ANXIOUS'], whisper: '碰一下才响，不碰就一直安静。' },
  candle: { name: '蜡烛', classifier: '支', tones: ['ANXIOUS', 'RESTLESS'], whisper: '烧得很慢，可以陪很久。' },
  seed: { name: '一粒种子', classifier: '颗', tones: ['HOPEFUL'], whisper: '不知道会长成什么，先埋下去。' },
  // ★ 纪念品：不给用户"选"，只在倒计时归零时赠予（tones 为空 = 不属于任何情绪基调）
  ticket: { name: '褪色的船票', classifier: '张', tones: [], whisper: '上面的字已经淡了，但你记得是去哪儿。' },
}

/** 每次提供的候选数量（战略原文的「2–3 个」） */
export const MEMORY_OFFER_MIN = 2
export const MEMORY_OFFER_MAX = 3

/** 小屋里的摆件上限 —— 保护单键 64KB 的写预算，不是产品限制 */
export const MAX_MEMORY_ITEMS = 120

const DEFAULT_TAIL: Record<MoodTone, string> = {
  CALM: '想记着这份平静',
  TIRED: '想给自己留一点余地',
  ANXIOUS: '想让自己慢下来',
  DOWN: '想等一等自己',
  HOPEFUL: '决定重新出发',
  RESTLESS: '想把心放回原处',
}

// ───────────────────────────────────────────────────────────────────────────
// 数据模型
// ───────────────────────────────────────────────────────────────────────────

export type MemorySource =
  | { kind: 'liuyao'; hexagram: number; focus?: FocusId }
  | { kind: 'tarot'; spreadId: string; cards: readonly number[] }
  /** 倒计时归零赠出的纪念品 —— 它的来源不是一次占卜，而是一个日子 */
  | { kind: 'countdown'; countdownId: string; title: string }

export interface MemoryItem {
  id: string
  /** 放下它的时刻（本地时间戳） */
  createdAt: number
  /** 它记住的那次占卜是**哪一天**发生的（可能早于 createdAt — 用户隔天才摆） */
  readAt: number
  kind: MemoryKind
  source: MemorySource
  /** 当时的情绪基调 —— 摆件就是按它筛的，所以必须留下 */
  tone: MoodTone
  /**
   * ★ 用户当时说的那一句话。
   *   它**只存在于本地**：`serializeForNetwork()` 的字段白名单里没有它，
   *   门禁⑦ 也扫不到它 —— 因为它压根没进过请求。
   */
  note: string
  /** 放在哪个锚点；null = 用户放在了空地上（这是**正常**的，不是失败） */
  anchorId: AnchorId | null
  at: Pt
  /** 倒计时归零赠予的纪念品 */
  keepsake?: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// 建议：情绪基调 → 2–3 件
// ───────────────────────────────────────────────────────────────────────────

/**
 * 按情绪基调挑候选摆件。
 *
 * ★ 确定性：同样的 (tone, seed) 出同样的结果。
 *   随机抽奖会让"我抽到的是绿植"变成运气，而这里要的是**被看见**的感觉 ——
 *   "你心里悬着，所以给你一盏小灯"必须说得通。
 *   `seed` 从哪来？用那次占卜的卦象/牌阵序号，于是同一个卦象始终推荐同一件。
 *
 * ★ **专属件一定在候选里**，seed 只决定"陪衬是谁"。
 *   这里曾经写成语义与注释不符的版本：把 matched + generic 拼成一个池子，
 *   再按 seed 在**整个池子**上取窗口 —— 结果是"累了"的用户在 seed=3 时
 *   会收到贝壳 / 铜铃 / 蜡烛，一件都不对口，"被看见"直接落了空。
 *   现在改成：先把 matched 全部放进去，不够 n 件时再用 seed 轮转着补通用件。
 */
export function suggestMemoryItems(
  tone: MoodTone,
  seed = 0,
  count: number = MEMORY_OFFER_MAX,
): MemoryKind[] {
  const n = Math.max(MEMORY_OFFER_MIN, Math.min(MEMORY_OFFER_MAX, Math.floor(count) || MEMORY_OFFER_MAX))
  // 先取该基调专属的（ticket 是纪念品，永不出现在候选里）
  const matched = MEMORY_KINDS.filter((k) => k !== 'ticket' && MEMORY_CATALOG[k].tones.includes(tone))
  const generic = MEMORY_KINDS.filter((k) => k !== 'ticket' && !matched.includes(k))
  if (matched.length + generic.length === 0) return []

  const out: MemoryKind[] = matched.slice(0, n)
  // 不够 n 件就用通用件补齐（专属件最多 3 件 = n，所以这一段通常是给"单一基调件"的基调用）
  if (out.length < n && generic.length > 0) {
    const start = Math.abs(Math.floor(seed) || 0) % generic.length
    for (let i = 0; out.length < n && i < generic.length; i++) {
      out.push(generic[(start + i) % generic.length])
    }
  }
  return out
}

// ───────────────────────────────────────────────────────────────────────────
// 放置 —— 亲手拖拽
// ───────────────────────────────────────────────────────────────────────────

let seq = 0

/** 生成 id。★ 不用 Math.random（单测要确定性）；时间戳 + 进程内序号足够唯一 */
function nextId(now: number): string {
  seq += 1
  return `m${now.toString(36)}-${seq.toString(36)}`
}

export interface PlaceMemoryOptions {
  /**
   * 已经在屋里的东西（用来算锚点占用）。
   * ★ 只要"有 anchorId"就够，所以类型收窄到结构而不是 MemoryItem ——
   *   这样倒计时摆件（Countdown 也有 anchorId）能一起传进来，
   *   不必为了凑类型先转一道。
   */
  placed: readonly { anchorId: AnchorId | null }[]
  /** 只允许放进这些锚点；缺省 = 全部 */
  allow?: readonly AnchorId[]
  now: number
}

export interface PlaceMemoryResult {
  item: MemoryItem
  /** 'anchor' = 吸附到了锚点；'free' = 就地放下。★ 没有失败态 */
  outcome: 'anchor' | 'free'
}

/**
 * 把摆件放到指针位置。
 *
 * ★ 无论吸附成功还是原地放下，**结果都是"放下了"**。
 *   战略原文三条底线之一："绝不弹报错"。一个"没放进格子里"的动作，
 *   最自然的回应是"那就放这儿吧"，绝不是回弹 + 提示。
 */
export function placeMemory(
  item: MemoryItem,
  p: Pt,
  opts: PlaceMemoryOptions,
): PlaceMemoryResult {
  const full = occupancyOf(opts.placed)
  const out = placeAt(p, { full, ...(opts.allow ? { allow: opts.allow } : {}) })
  return {
    item: { ...item, anchorId: out.kind === 'anchor' ? out.id : null, at: out.at },
    outcome: out.kind,
  }
}

export interface DraftMemoryInput {
  kind: MemoryKind
  tone: MoodTone
  source: MemorySource
  note?: string
  readAt: number
  now: number
}

/** 造一条还没放置的记忆（用户点"想带走这件"之后） */
export function draftMemory(input: DraftMemoryInput): MemoryItem {
  return {
    id: nextId(input.now),
    createdAt: input.now,
    readAt: input.readAt,
    kind: input.kind,
    source: input.source,
    tone: input.tone,
    note: (input.note ?? '').trim(),
    anchorId: null,
    // ★ 未放置的哨兵坐标用 (0,0)，**不能**用 NaN：
    //   `JSON.stringify(NaN)` 产出的是 `null`，写进本地再读回来就变成
    //   `at: { x: null, y: null }` —— 于是这条记忆会在加载时被 isMemoryItem 静默丢掉，
    //   表现为"我放的东西第二天不见了"，而日志里一个字都没有。
    //   反正 placeMemory() 会立刻覆盖它，用 (0,0) 只是为了让数据在**任意时刻**
    //   都是可序列化、可校验的。
    at: { x: 0, y: 0 },
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 优雅浮现
// ───────────────────────────────────────────────────────────────────────────

/** `2026年10月10日` —— ★ 不补零，与战略原文的样例逐字一致 */
export function dateLabel(ts: number): string {
  const d = new Date(ts)
  // ★ 用 getFullYear/getMonth/getDate（**本地**）而不是 toISOString（UTC）。
  //   UTC 会让「今天 23:30 发生的事」在 UTC+8 显示成明天，用户一眼就发现不对。
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export interface Recall {
  /** 日期行 */
  date: string
  /** 摆件的名字（含量词）：这盆绿植 / 这块鹅卵石 */
  itemName: string
  /** 当时那句话 */
  tail: string
  /** ★ 整句：`2026年10月10日，你选择了这盆绿植，决定重新出发` */
  line: string
  /** 那次占卜的简写，给卡片的次行用 */
  sourceLabel: string
  /** 卡片顶部的心情标签（如「心里悬着」），与战略原文「日期 + 心情标签」对齐 */
  moodLabel: string
  /** 卡片中部的占卜类型（如「六爻 · 工作上的事」），含方向维度 */
  sourceType: string
}

/**
 * 摆件的称呼。
 * ★ 中文量词必须由代码拼，不能各写各的 —— 战略原文的样例是「你选择了**这**盆绿植」，
 *   而候选卡片上要写「**一**盆绿植」。同一件东西两种说法，
 *   两处手写必然有一天不一致（"一绿植"这种句子一眼就假，但很容易漏出去）。
 */
export function itemName(item: { kind: MemoryKind }, form: 'this' | 'one' = 'this'): string {
  const def = MEMORY_CATALOG[item.kind]
  return `${form === 'this' ? '这' : '一'}${def.classifier}${def.name}`
}

/**
 * 生成"优雅浮现"的记录。
 *
 * ★ 句子结构与战略原文的样例逐字对齐，由单测钉住：
 *     `2026年10月10日，你选择了这盆绿植，决定重新出发`
 *   三段分别来自：日期 / 量词 + 摆件名 / 用户自己的话（缺省时用基调兜底）。
 */
export function recallOf(item: MemoryItem): Recall {
  const tail = item.note || DEFAULT_TAIL[item.tone] || '想把它留在这里'
  const date = dateLabel(item.readAt)
  return {
    date,
    itemName: itemName(item, 'this'),
    tail,
    line: `${date}，你选择了${itemName(item, 'this')}，${tail}`,
    sourceLabel: sourceLabelOf(item.source),
    moodLabel: MOOD_LABEL[item.tone],
    sourceType: sourceTypeOf(item.source),
  }
}

function sourceLabelOf(source: MemorySource): string {
  switch (source.kind) {
    case 'liuyao':
      return `第 ${source.hexagram} 卦`
    case 'tarot':
      return `「${source.spreadId}」${source.cards.length} 张`
    case 'countdown':
      return `「${source.title}」那天`
  }
}

/**
 * 卡片中部的「占卜类型」标签。
 *
 * ★ 与 `sourceLabel`（给次行用的简写）**不同**：这里是给人一眼看懂的「哪一类占卜
 *   + 当时问了什么方向」，所以六爻会带上 focus 维度（如「六爻 · 工作上的事」）。
 *   focus 来自 MemoryItem.source，是 buildDraft 在落成记忆时一并记下的 ——
 *   不记的话卡片中部只能空着方向，那句「你当时在想什么」就少了半句。
 */
function sourceTypeOf(source: MemorySource): string {
  switch (source.kind) {
    case 'liuyao':
      return `六爻 · ${source.focus ? FOCUS_LABEL[source.focus] : '那一卦'}`
    case 'tarot':
      return '塔罗'
    case 'countdown':
      return '纪念'
  }
}

/** 小屋的一句话概览（房间里那行很淡的字） */
export function roomSummary(items: readonly MemoryItem[]): string {
  if (items.length === 0) return '小屋里还空着。'
  const latest = items.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))
  return `${items.length} 件东西。最近放下的是${recallOf(latest).itemName}。`
}

// ───────────────────────────────────────────────────────────────────────────
// 本地读写（走 core/persist 的写预算通道）
// ───────────────────────────────────────────────────────────────────────────

export function loadMemory(store: PersistedStore): MemoryItem[] {
  const raw = store.get<unknown>(PERSIST_KEYS.memory, [])
  if (!Array.isArray(raw)) return []
  return raw.filter(isMemoryItem).slice(0, MAX_MEMORY_ITEMS)
}

/**
 * 写回。★ 超出上限时丢最旧的，并 warn 一次 ——
 *   不弹提示、不阻止用户继续摆；小屋从来不会因为"满了"而拒绝一件东西。
 */
export function saveMemory(store: PersistedStore, items: readonly MemoryItem[]): MemoryItem[] {
  let kept = [...items]
  if (kept.length > MAX_MEMORY_ITEMS) {
    const drop = kept.length - MAX_MEMORY_ITEMS
    kept = kept.slice(drop)
    logger.warn(`[memory] 小屋超过 ${MAX_MEMORY_ITEMS} 件，丢弃最旧的 ${drop} 件`)
  }
  store.set(PERSIST_KEYS.memory, kept)
  return kept
}

/** 删掉一件（用户想扔就扔，没有确认弹窗） */
export function forgetMemory(items: readonly MemoryItem[], id: string): MemoryItem[] {
  return items.filter((i) => i.id !== id)
}

/** 结构校验：手工改过的本地数据不该让整个小屋打不开 */
function isMemoryItem(v: unknown): v is MemoryItem {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return false
  if (!Number.isFinite(o.createdAt)) return false
  if (typeof o.kind !== 'string' || !(o.kind in MEMORY_CATALOG)) return false
  if (!Number.isFinite(o.readAt)) return false
  const at = o.at as { x?: unknown; y?: unknown } | undefined
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return false
  return true
}

/** 给"想带走哪一件"那张卡片用的展示结构 —— UI 不自己拼文案 */
export interface MemoryOffer {
  kind: MemoryKind
  /** 「一盆绿植」 */
  name: string
  whisper: string
  toneLabel: string
}

export function toOffers(kinds: readonly MemoryKind[], tone: MoodTone): MemoryOffer[] {
  return kinds.map((kind) => ({
    kind,
    name: itemName({ kind }, 'one'),
    whisper: MEMORY_CATALOG[kind].whisper,
    toneLabel: MOOD_LABEL[tone],
  }))
}
