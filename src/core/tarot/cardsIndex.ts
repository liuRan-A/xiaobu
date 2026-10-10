/**
 * 小卜 · 78 张塔罗牌索引   src/core/tarot/cardsIndex.ts
 * ===========================================================================
 * 一副塔罗 = 大阿卡纳 22 张 + 小阿卡纳 4 组 × 14 张 = 78 张。
 *
 * ── 为什么放在 core/ 且是"纯数据" ───────────────────────────────────────────
 *   它只有字符串与数字，零依赖、不认识像素、不认识网络、不认识 assets ——
 *   正是 core 的定义。于是它能在 node 里被整表扫一遍（张数 / 唯一性 / 查表），
 *   也能被任何层安全引用而不产生反向依赖。
 *
 * ── 三张面孔：id / slug / num ────────────────────────────────────────────────
 *   · `id`   程序内部稳定键：`major-00`…`major-21`、`wands-01`…`pentacles-14`。
 *            它是**不变**的 —— 存进记忆锚点、日志、埋点里的都是它。
 *   · `slug` 美术交付用的可读文件名（kebab 英文名）：`the-fool`、`wands-ace`…
 *            牌面资产文件名 = `<slug>.webp`。换画师也不改 id，只改文件。
 *   · `num`  序号：大阿卡纳 0–21；小阿卡纳 1–14（1=ace … 11=page … 14=king）。
 *
 * ★ 这里**不含任何牌义 / 正逆位 / 吉凶** —— 那些既违反文案红线，也不是索引该管的事。
 *   索引只回答一个问题："这副牌里有哪 78 张，它们各自叫什么。"
 * ===========================================================================
 */

export type Arcana = 'major' | 'minor'
export const SUITS = ['wands', 'cups', 'swords', 'pentacles'] as const
export type Suit = (typeof SUITS)[number]

export interface TarotCard {
  /** 程序内部稳定键（存盘 / 埋点用），如 `major-00` / `wands-01` */
  readonly id: string
  readonly arcana: Arcana
  /** 大阿卡纳为 null */
  readonly suit: Suit | null
  /** 大阿卡纳 0–21；小阿卡纳 1–14 */
  readonly num: number
  /** 美术文件名键（kebab 英文名），资产名 = `<slug>.webp` */
  readonly slug: string
}

/** 大阿卡纳 22 张的英文名（顺序即 0–21） */
const MAJOR_SLUGS = [
  'the-fool',
  'the-magician',
  'the-high-priestess',
  'the-empress',
  'the-emperor',
  'the-hierophant',
  'the-lovers',
  'the-chariot',
  'strength',
  'the-hermit',
  'wheel-of-fortune',
  'justice',
  'the-hanged-man',
  'death',
  'temperance',
  'the-devil',
  'the-tower',
  'the-star',
  'the-moon',
  'the-sun',
  'judgement',
  'the-world',
] as const

/** 小阿卡纳 14 个阶位（顺序即 1–14） */
const RANK_SLUGS = [
  'ace',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'page',
  'knight',
  'queen',
  'king',
] as const

/** 两位补零（`major-00` 而不是 `major-0`，让文件名可排序） */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export const MAJOR_ARCANA: readonly TarotCard[] = MAJOR_SLUGS.map((slug, i) => ({
  id: `major-${pad2(i)}`,
  arcana: 'major' as const,
  suit: null,
  num: i,
  slug,
}))

export const MINOR_ARCANA: readonly TarotCard[] = SUITS.flatMap((suit) =>
  RANK_SLUGS.map((rank, idx) => ({
    id: `${suit}-${pad2(idx + 1)}`,
    arcana: 'minor' as const,
    suit,
    num: idx + 1,
    slug: `${suit}-${rank}`,
  })),
)

/** 全副 78 张（大阿卡纳在前，小阿卡纳按 权杖→圣杯→宝剑→星币 分组） */
export const CARDS: readonly TarotCard[] = [...MAJOR_ARCANA, ...MINOR_ARCANA]

export const CARD_COUNT = 78
export const MAJOR_COUNT = 22
export const MINOR_PER_SUIT = 14

const BY_ID: ReadonlyMap<string, TarotCard> = new Map(CARDS.map((c) => [c.id, c]))
const BY_SLUG: ReadonlyMap<string, TarotCard> = new Map(CARDS.map((c) => [c.slug, c]))

/** 按 id 取牌；没有返回 null（永不抛 —— 未知 id 是"没有这张牌"，不是异常） */
export function getCard(id: string): TarotCard | null {
  return BY_ID.get(String(id ?? '')) ?? null
}

/** 按 slug 取牌；没有返回 null */
export function getCardBySlug(slug: string): TarotCard | null {
  return BY_SLUG.get(String(slug ?? '')) ?? null
}

/** 某组小阿卡纳的 14 张 */
export function cardsOfSuit(suit: Suit): readonly TarotCard[] {
  return MINOR_ARCANA.filter((c) => c.suit === suit)
}
