/**
 * 小卜 · 问事分类与解读请求组装   src/core/reading.ts
 * ===========================================================================
 * 战略原文：
 *   「用户必须先选择【心情】和【问事方向】，再将道具拖拽放置到预设锚点
 *     （窗边、木桌、香炉旁），最后掷币。**AI 的 Prompt 必须结合
 *     【问事方向 + 当前心情 + 放置位置】三维数据**给出心理剖析。」
 *
 * ── 这份文件里最重要的一条约束：**三维数据全是枚举，没有一个自由文本** ────
 *   这不是偷懒，是刻意设计：
 *
 *   ① **隐私上自动合规。** 出端的内容只有 `'CALM'` / `'CAREER'` / `'WINDOW_SILL'`
 *      这种固定词表里的值，用户写的任何一句话都不会被拼进请求。
 *      「不上报隐私」这条底线于是不靠 review 保证，而是**结构上不可能违反**。
 *   ② **本地兜底也更好写。** 断网降级成本地模板时，枚举就是维度键，
 *      查表拼文案即可，不需要"从中文里猜意图"。
 *   ③ **模型侧更稳。** 枚举值让不同用户、不同次数的输入分布一致，
 *      解读风格不会因为一次输入带情绪词就漂移。
 *
 *   用户的**原话**当然要留着（那是记忆锚点里最动人的部分），
 *   但它存在 `localOnly` 里，`serializeForNetwork()` 会把它整个剥掉。
 *   这个剥的动作有单测钉着 —— 见 `tests/lifecycle.spec.ts`。
 * ===========================================================================
 */

import type { AnchorId } from '@core/room/roomZone'

// ───────────────────────────────────────────────────────────────────────────
// 一、问事方向（六爻）
// ───────────────────────────────────────────────────────────────────────────

export const FOCUS_IDS = ['CAREER', 'RELATION', 'STUDY', 'MONEY', 'FAMILY', 'SELF', 'UNSURE'] as const
export type FocusId = (typeof FOCUS_IDS)[number]

/**
 * ★ 展示名一律用**生活语言**，不用"求财 / 问姻缘 / 测官运"这类术数行话。
 *   最后一项「说不上来」必须存在 —— 它承接的是"用户自己都没想清楚"这个真实状态，
 *   而"你必须选一个"本身就是压力。战略原文：拒绝压力。
 */
export const FOCUS_LABEL: Record<FocusId, string> = {
  CAREER: '工作上的事',
  RELATION: '和某个人的关系',
  STUDY: '学习与考试',
  MONEY: '钱的事',
  FAMILY: '家里的事',
  SELF: '就是我自己',
  UNSURE: '说不上来',
}

/** 给 Prompt 用的语义提示词（英文，模型侧更稳；同样出自固定词表） */
export const FOCUS_PROMPT: Record<FocusId, string> = {
  CAREER: 'career pressure and direction',
  RELATION: 'an interpersonal relationship',
  STUDY: 'study and examination',
  MONEY: 'financial stress and security',
  FAMILY: 'family matters',
  SELF: 'self-identity and inner state',
  UNSURE: 'unnamed general unease',
}

// ───────────────────────────────────────────────────────────────────────────
// 二、心情（六爻 + 记忆锚点共用）
// ───────────────────────────────────────────────────────────────────────────

export const MOOD_TONES = ['CALM', 'TIRED', 'ANXIOUS', 'DOWN', 'HOPEFUL', 'RESTLESS'] as const
export type MoodTone = (typeof MOOD_TONES)[number]

/**
 * ★ 心情选项也不许出现情绪评分（"1 到 5 分"）或诊断性词汇。
 *   它们是**描述**，不是量表 —— 用户是在说"我今天这样"，
 *   而不是在填一份抑郁自评表。
 */
export const MOOD_LABEL: Record<MoodTone, string> = {
  CALM: '还算平静',
  TIRED: '有点累',
  ANXIOUS: '心里悬着',
  DOWN: '提不起劲',
  HOPEFUL: '有点期待',
  RESTLESS: '静不下来',
}

export const MOOD_PROMPT: Record<MoodTone, string> = {
  CALM: 'calm and settled',
  TIRED: 'tired, low on energy',
  ANXIOUS: 'anxious and unsettled',
  DOWN: 'low mood, listless',
  HOPEFUL: 'quietly hopeful',
  RESTLESS: 'restless, hard to sit still',
}

// ───────────────────────────────────────────────────────────────────────────
// 三、放置位置（六爻的第三个维度）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 位置进 Prompt 的意义不是"风水"，而是**空间与心境的关系**。
 *   放在窗边 ≈ 想让事情透透气；放在桌上 ≈ 想每天看见它；
 *   放在香炉旁 ≈ 想安静下来。这是心理剖析的抓手，不是吉凶的依据。
 */
export const PLACE_PROMPT: Record<AnchorId, string> = {
  WINDOW_SILL: 'placed by the window — leaning toward airing it out and looking outward',
  TABLE_TOP: 'placed on the table — wanting to keep it in daily sight and deal with it steadily',
  CENSER_SIDE: 'placed beside the censer — seeking quiet and a slower pace',
  TEA_TABLE: 'placed on the tea table — sitting down with it, taking time',
}

// ───────────────────────────────────────────────────────────────────────────
// 四、请求组装
// ───────────────────────────────────────────────────────────────────────────

export interface HexagramRef {
  /** 本卦序号（1–64）—— ★ 只传序号，不传爻值、不传解读文本 */
  primary: number
  /** 变卦序号；无变爻为 null */
  changed: number | null
  /** 动爻位置（0–5 自下而上）。★ 只用于提示词强调，不用于任何"吉凶"判断 */
  moving: readonly number[]
}

export interface LiuyaoRequestInput {
  focus: FocusId
  mood: MoodTone
  anchorId: AnchorId | null
  hexagram: HexagramRef
  /** 用户的原话 —— ★ 只进 localOnly，`serializeForNetwork()` 会剥掉 */
  question?: string
}

export interface ReadingRequest {
  kind: 'liuyao' | 'tarot'
  /** ★ 三维（或牌阵维度）的枚举，出端内容就是它 */
  dims: Record<string, string | number>
  /** 该按什么结构解读（六爻 = 单卦；塔罗 = 牌阵结构生成的 sections） */
  structure: string
  /** 本地专有字段 —— **永不出端** */
  localOnly: { question?: string }
}

export function buildLiuyaoRequest(input: LiuyaoRequestInput): ReadingRequest {
  const dims: Record<string, string | number> = {
    focus: input.focus,
    focus_hint: FOCUS_PROMPT[input.focus] ?? FOCUS_PROMPT.UNSURE,
    mood: input.mood,
    mood_hint: MOOD_PROMPT[input.mood] ?? MOOD_PROMPT.CALM,
    // ★ 没放锚点时给一个中性值，而不是省略这个字段 ——
    //   字段缺失会让模型自己去猜，反而更容易说出不该说的话
    place: input.anchorId ?? 'NONE',
    place_hint: input.anchorId ? PLACE_PROMPT[input.anchorId] : 'not placed anywhere in particular',
    hexagram: input.hexagram.primary,
    hexagram_changed: input.hexagram.changed ?? 0,
    moving_count: input.hexagram.moving.length,
  }

  return {
    kind: 'liuyao',
    dims,
    structure: 'hexagram',
    localOnly: input.question ? { question: input.question } : {},
  }
}

/**
 * 塔罗请求：维度来自**牌阵结构**（这就是"AI 解读随牌阵动态调整"的落点）。
 * 时间线阵给三段串因果，对比阵给左右并置，十字阵给先中心后四周 ——
 * 结构指令由 `plan.sections[].guidance` 带出，不需要在请求里再判断一次。
 */
export function buildTarotRequest(plan: {
  spreadId: string
  strategy: string
  title: string
  sections: ReadonlyArray<{ role: string; label: string; guidance: string }>
  summaryGuidance: string
  drawn: number
}, mood: MoodTone, question?: string): ReadingRequest {
  return {
    kind: 'tarot',
    dims: {
      spread: plan.spreadId,
      strategy: plan.strategy,
      drawn: plan.drawn,
      mood,
      mood_hint: MOOD_PROMPT[mood] ?? MOOD_PROMPT.CALM,
      roles: plan.sections.map((s) => s.role).join(','),
    },
    structure: plan.strategy,
    localOnly: question ? { question } : {},
  }
}

/** ★ 出端字段白名单。新增维度必须显式加进来，否则不会被发送（保守默认） */
export const NETWORK_FIELDS = ['kind', 'dims', 'structure'] as const

/** 绝不许出现在出端载荷里的字段名 —— 由门禁⑦与单测共同看守 */
export const PRIVATE_FIELDS = ['question', 'note', 'text', 'transcript', 'prompt', 'completion'] as const

/**
 * ★ 唯一的出端序列化入口。
 *   它只挑白名单字段，其余一律丢弃 —— 包括 `localOnly`。
 *   于是"用户原话外传"这件事在**代码层面无从发生**，不依赖任何人的自觉。
 */
export function serializeForNetwork(req: ReadingRequest): string {
  const out: Record<string, unknown> = {}
  for (const f of NETWORK_FIELDS) out[f] = req[f]
  return JSON.stringify(out)
}

/** 自检：载荷里有没有混进私有内容（单测与门禁⑦都会调它） */
export function hasPrivateLeak(payload: string, needles: readonly string[] = []): boolean {
  const lower = payload.toLowerCase()
  if (PRIVATE_FIELDS.some((f) => lower.includes(`"${f}"`))) return true
  return needles.some((n) => n && lower.includes(n.toLowerCase()))
}
