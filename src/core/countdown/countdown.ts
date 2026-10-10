/**
 * 小卜 · 倒计时   src/core/countdown/countdown.ts
 * ===========================================================================
 * 战略原文（灵魂机制 ②）：
 *   「**倒计时（Countdown）**：房间放置沙漏 / 日历摆件。用户设定目标。
 *     **倒计时归零当天**，自动触发一次**特殊记忆锚点**，赠送**专属纪念品**
 *     （如褪色的船票）。**纯本地时间戳计算，无网络依赖，绝不允许弹报错**。」
 *
 * ── 本文件存在的唯一理由：把"还剩几天"算对 ─────────────────────────────────
 *
 * 绝大多数倒计时的 bug 都来自同一个写法：
 *
 *     const days = Math.ceil((target - Date.now()) / 86400000)   // ✗
 *
 * 它在三种情况下会给出用户无法理解的结果：
 *   ① **晚上设定"明天"** —— 23:59 设「明天」，差值只有 1 分钟，
 *      `ceil` 得 1（对），但 `floor` 得 0（显示"今天"）。用 `ceil` 也对不了：
 *      到了第二天 00:01 再算，差值 23h59m，`ceil` 还是 1 —— 于是"今天到了"
 *      这件事**永远不会显示成 0 天**，纪念品也就永远不会发。
 *   ② **夏令时 / 时区** —— 有些日子是 23 小时或 25 小时，除以 86400000 不是整数。
 *   ③ **跨年** —— 12 月 31 日设 1 月 1 日，差值里混进闰年天数。
 *
 * 正确做法：**把"天"当成日历上的刻度，而不是时长的除法。**
 *   把本地年月日压成一个整数天号（`dayIndexOf`），两个天号相减就是"还剩几天"。
 *   它与小时、分钟、夏令时、闰年**全部无关**，而且是整数运算，没有浮点误差。
 *
 * ── 另一条设计：归零只在"当天"发生一次 ──────────────────────────────────────
 *   "自动触发"必须**幂等**：用户在归零当天可能会开关 App 十几次，
 *   纪念品只能送一次。所以触发后写 `firedAt`，之后永不重发。
 *   若触发那一刻恰好崩溃（进程被杀），下次启动 `firedAt` 仍是 null → 补发一次。
 *   **宁可补发，不可漏发** —— 漏掉的是用户等了一个月的那一天。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { getAnchor, occupancyOf, type AnchorId } from '@core/room/roomZone'
import { PERSIST_KEYS, type PersistedStore } from '@core/persist'
import { draftMemory, placeMemory, type MemoryItem, type MemorySource } from '@core/memory/memoryAnchor'
import type { MoodTone } from '@core/reading'
import type { Pt } from '@core/ritual/flight'

// ───────────────────────────────────────────────────────────────────────────
// 日历日
// ───────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000

/** 本地日历日。m 用 1–12（与用户直觉一致，不用 JS 的 0 基月份） */
export interface LocalDay {
  y: number
  m: number
  d: number
}

/**
 * 把日历日压成一个「天号」（1970-01-01 起的天数）。
 * ★ 用 `Date.UTC` 而不是 `Date.now()` 的本地时刻 ——
 *   `Date.UTC` 相当于把"本地年月日"搬到 UTC 里去数数，
 *   于是结果**不受时区与夏令时影响**，永远是一个稳定的整数。
 *   这一步是整个倒计时能算对的关键。
 */
export function dayIndexOf(day: LocalDay): number {
  return Math.floor(Date.UTC(day.y, day.m - 1, day.d) / MS_PER_DAY)
}

/** 时间戳 → 本地日历日。★ 用本地 getter，不用 toISOString（那是 UTC，会差一天） */
export function localDayOf(ts: number): LocalDay {
  const d = new Date(ts)
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() }
}

/** 解析 `YYYY-MM-DD`。非法输入返回 null（调用方不当它是错误，只是没设定） */
export function parseLocalDay(s: unknown): LocalDay | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  // 反查一遍，挡住 2026-02-30 这种"格式对但不存在"的日期
  const back = localDayOf(Date.UTC(y, mo - 1, d))
  if (back.y !== y || back.m !== mo || back.d !== d) return null
  return { y, m: mo, d }
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))
export function formatLocalDay(day: LocalDay): string {
  return `${day.y}-${pad2(day.m)}-${pad2(day.d)}`
}

/** 还剩几天。0 = 就是今天；负数 = 已经过去几天了 */
export function daysLeft(target: LocalDay, nowTs: number): number {
  return dayIndexOf(target) - dayIndexOf(localDayOf(nowTs))
}

// ───────────────────────────────────────────────────────────────────────────
// 数据模型
// ───────────────────────────────────────────────────────────────────────────

export interface Countdown {
  id: string
  /** 用户给它起的名字，如"交材料的那天" */
  title: string
  /** ★ 目标日（本地日历日）—— 只到"天"，不到"分秒"：
   *  用户想的是"那一天"，精确到分钟只会制造焦虑与误判 */
  target: LocalDay
  createdAt: number
  /** 摆在哪（沙漏 / 日历摆件）；null = 还没放 */
  anchorId: AnchorId | null
  at: Pt
  /** ★ 归零后写一次；非 null 表示纪念品已经发过了（幂等的锚点） */
  firedAt: number | null
  /** 赠出的纪念品 id（指向 MemoryItem） */
  keepsakeId: string | null
}

/** 同时最多几个倒计时。不是一个产品限制，是"保护写预算"与"不让房间变成待办清单" */
export const MAX_COUNTDOWN_ITEMS = 12

/** 纪念品固定用「褪色的船票」（MEMORY_CATALOG 里 tones 为空的那件，永不出现在候选里） */
export const KEEPSAKE_KIND = 'ticket' as const

export interface CountdownInput {
  title: string
  target: LocalDay
  anchorId?: AnchorId | null
  at?: Pt
  now: number
}

let cseq = 0
function nextCountdownId(now: number): string {
  cseq += 1
  return `c${now.toString(36)}-${cseq.toString(36)}`
}

/**
 * 新建一个倒计时。
 * ★ 目标日**已经过去**时不拒绝、不报错 —— 用户想记一个"已经过去的日子"完全合理
 *   （比如"她从那天开始上班"，只是想有个日子戳着）。
 *   若真的已过期，它会立刻进入"该发纪念品"的状态，而那是**馈赠**不是**报错**。
 */
export function addCountdown(
  items: readonly Countdown[],
  input: CountdownInput,
): { items: Countdown[]; added: Countdown | null } {
  const title = (input.title ?? '').trim()
  if (!title) return { items: [...items], added: null }

  const added: Countdown = {
    id: nextCountdownId(input.now),
    title: title.slice(0, 24),
    target: input.target,
    createdAt: input.now,
    anchorId: input.anchorId ?? null,
    at: input.at ?? { x: 0, y: 0 },
    firedAt: null,
    keepsakeId: null,
  }

  let next = [...items, added]
  if (next.length > MAX_COUNTDOWN_ITEMS) {
    // ★ 丢最旧的、且**只丢已经发过纪念品的**：
    //   丢掉一个还没到期的倒计时 = 悄悄取消了用户等的那个日子，这是不可接受的。
    const droppable = next.filter((c) => c.firedAt !== null).sort((a, b) => a.createdAt - b.createdAt)
    const need = next.length - MAX_COUNTDOWN_ITEMS
    const dropIds = new Set(droppable.slice(0, need).map((c) => c.id))
    if (dropIds.size > 0) {
      next = next.filter((c) => !dropIds.has(c.id))
      logger.warn(`[countdown] 超过 ${MAX_COUNTDOWN_ITEMS} 个，清理已完成的 ${dropIds.size} 个`)
    }
  }

  return { items: next, added }
}

export function removeCountdown(items: readonly Countdown[], id: string): Countdown[] {
  return items.filter((c) => c.id !== id)
}

/** 这个倒计时是不是"该发纪念品了" */
export function isDue(c: Countdown, nowTs: number): boolean {
  return c.firedAt === null && daysLeft(c.target, nowTs) <= 0
}

export interface TickResult {
  items: Countdown[]
  /** ★ 本次新触发的（需要发纪念品）。通常 1 个，补发场景可能多个 */
  fired: Countdown[]
}

/**
 * 走过一次时间。
 * ★ 幂等：只有 `firedAt === null` 的才会进 `fired`，触发后立刻打标记。
 *   所以"同一天开关 App 十几次"只会发一次纪念品，而"触发时崩溃"下次会补发。
 */
export function tickCountdowns(items: readonly Countdown[], nowTs: number): TickResult {
  const fired: Countdown[] = []
  const next = items.map((c) => {
    if (!isDue(c, nowTs)) return c
    const updated: Countdown = { ...c, firedAt: nowTs }
    fired.push(updated)
    return updated
  })
  return { items: next, fired }
}

/** 还有几天——给摆件上的那行小字 / 点击低语用 */
export interface CountdownView {
  id: string
  title: string
  /** 沙漏上那行字：`还有 12 天` / `就是今天` / `已经过去了` */
  caption: string
  daysLeft: number
  /** 已归零 */
  due: boolean
}

/**
 * ★ 文案里**不许出现**"倒计时""剩余""逾期""已过期"这类词 ——
 *   它们是任务管理器的语言，不是陪伴的语言。
 */
export function toView(c: Countdown, nowTs: number): CountdownView {
  const n = daysLeft(c.target, nowTs)
  let caption: string
  if (n > 0) caption = `还有 ${n} 天`
  else if (n === 0) caption = '就是今天'
  else caption = '那一天已经过去了'

  return { id: c.id, title: c.title, caption, daysLeft: n, due: n <= 0 }
}

// ───────────────────────────────────────────────────────────────────────────
// 纪念品
// ───────────────────────────────────────────────────────────────────────────

export interface KeepsakeInput {
  countdown: Countdown
  now: number
  /** 用户最近一次选的基调（决定记录末尾那句话的语气） */
  tone: MoodTone
  /** 摆件该落在哪 —— 通常摆在沙漏旁边，所以缺省用倒计时自己的锚点 */
  fallbackAt: Pt
  placed: readonly MemoryItem[]
}

/**
 * 一个倒计时"到底在哪儿"，取不到就返回 null。
 *
 * ★ 为什么需要一个函数而不是直接读 `c.at`：
 *   `at` 的缺省值是 **(0, 0)** —— 它是"还没放过"的哨兵坐标，与
 *   `draftMemory` 用的是同一个约定。可是 `(0,0)` 在数值上完全合法，
 *   于是"直接读 c.at"会把哨兵当成真坐标，纪念品被放到房间**左上角**，
 *   结果是"到日子了，但什么都没看见"。
 *   这条路径在 M2 里是真实可达的：从 COUNTDOWN_SET 面板直接定日子、
 *   没有把沙漏拖到任何地方的用户，`at` 就是 (0,0)。
 *
 * 优先级：锚点坐标 > 真实的就地放下坐标 > null（交给调用方的 fallbackAt）
 */
function placedAt(c: Countdown): Pt | null {
  if (c.anchorId) {
    const a = getAnchor(c.anchorId)
    if (a) return { ...a.at }
  }
  if (!c.at) return null
  if (!Number.isFinite(c.at.x) || !Number.isFinite(c.at.y)) return null
  // 哨兵 (0,0) 等同于"没放过"
  if (c.at.x === 0 && c.at.y === 0) return null
  return c.at
}

/**
 * 归零时赠出的专属纪念品。
 *
 * ★ 它是**一次完整的记忆锚点事件**，不是一条公告：
 *   造出一件「褪色的船票」→ 落到锚点上（满了就就地放下，绝不失败）→
 *   之后点它，浮现的是「2026年10月10日，你选择了这张褪色的船票，等到了这一天」。
 *   于是"到日子了"这件事被**留下**，而不是被**通知**。
 */
export function makeKeepsake(input: KeepsakeInput): MemoryItem {
  const c = input.countdown
  // ★ 来源用专门的 countdown 变体，而不是塞一个 `hexagram: 0` ——
  //   "第 0 卦"是一个不存在的卦象，写进数据里以后一定会有人当真。
  const source: MemorySource = { kind: 'countdown', countdownId: c.id, title: c.title }

  const draft = draftMemory({
    kind: KEEPSAKE_KIND,
    tone: input.tone,
    source,
    note: `等到了「${c.title}」的这一天`,
    readAt: input.now,
    now: input.now,
  })

  const target: Pt = placedAt(c) ?? input.fallbackAt
  const placed = placeMemory({ ...draft, keepsake: true }, target, {
    placed: input.placed,
    now: input.now,
    // ★ 纪念品只落在倒计时自己那个锚点上：它是"这件事的位置"，
    //   不该被塞进窗边或香炉旁的通用位置里
    ...(c.anchorId ? { allow: [c.anchorId] } : {}),
  })

  return placed.item
}

// ───────────────────────────────────────────────────────────────────────────
// 本地读写
// ───────────────────────────────────────────────────────────────────────────

export function loadCountdowns(store: PersistedStore): Countdown[] {
  const raw = store.get<unknown>(PERSIST_KEYS.countdown, [])
  if (!Array.isArray(raw)) return []
  return raw.filter(isCountdown).slice(0, MAX_COUNTDOWN_ITEMS)
}

export function saveCountdowns(store: PersistedStore, items: readonly Countdown[]): void {
  store.set(PERSIST_KEYS.countdown, items)
}

/** 结构校验：本地数据被手改过也不该让房间打不开 */
function isCountdown(v: unknown): v is Countdown {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return false
  if (typeof o.title !== 'string') return false
  if (!Number.isFinite(o.createdAt)) return false
  const t = o.target as LocalDay | undefined
  if (!t || !Number.isFinite(t.y) || !Number.isFinite(t.m) || !Number.isFinite(t.d)) return false
  return true
}

/** 占用表：倒计时摆件也会占锚点（它也是"放在屋里的东西"） */
export function countdownOccupancy(items: readonly Countdown[]): boolean[] {
  return occupancyOf(items.map((c) => ({ anchorId: c.anchorId })))
}
