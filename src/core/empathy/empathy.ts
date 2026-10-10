/**
 * 小卜 · 共情回应（本地）   src/core/empathy/empathy.ts
 * ===========================================================================
 * 产品定位是「情绪陪伴 × 零门槛」。占卜那条线已经闭合，这里补的是**另一半**：
 * 用户对着小卜说一句话，小卜回一句「我在」。
 *
 * ── 为什么放在 core/ ────────────────────────────────────────────────────────
 *   它只有字符串进出、零外部依赖、不认识像素、不认识网络 —— 正是 core 的定义。
 *   于是它能在 node 里被单测整表扫一遍（禁词 / 字数 / 确定性），不靠人肉复核。
 *
 * ── 三条写作纪律（与 guide.ts 的引导文案同源）──────────────────────────────
 *   ① **映照 + 许可**：先说出用户此刻的状态，再给一句「这样也可以」的许可。
 *      绝不给建议、绝不做评估、绝不说教 —— 小卜不是导师，是陪着的人。
 *   ② **不连问**：至多一个轻轻的邀请，绝不「你怎么了？发生什么了？说说看？」连击。
 *   ③ **确定性**：同一句话 + 同一轮次 ⇒ 永远同一句回应（用 hash 取模，禁 Math.random）。
 *      同一条消息每次刷新都换一句，会让"被看见"变成"被随机"。
 *
 * ── 红线 ────────────────────────────────────────────────────────────────────
 *   面向用户的文案必须躲开 `FORBIDDEN_COPY`（吉凶 / 行话 / 预测，见 guide.ts）
 *   与 `FORBIDDEN_STRUCTURE_WORDS`（塔罗区 / 玩法 这类我们的目录名），
 *   另外还有本文件自己的 `EMPATHY_BANNED`（客服腔 / 心理诊断 / 空头承诺）。
 *   单测把整张表扫一遍 —— 一句话违规就构建失败。
 * ===========================================================================
 */

import { FORBIDDEN_COPY, FORBIDDEN_STRUCTURE_WORDS, MAX_GUIDE_CHARS } from '@core/guide/guide'
import type { MoodTone } from '@core/reading'

/** 单句回应字数上限。★ 与引导气泡同一把尺子 —— 一次说太多就不是"私语"了 */
export const EMPATHY_MAX_CHARS = MAX_GUIDE_CHARS

/** 用户一句话最多记多少字（超出截断；服务端契约同为 200） */
export const EMPATHY_TEXT_MAX_CHARS = 200

export const EMPATHY_INTENTS = [
  'greeting',
  'tired',
  'anxious',
  'down',
  'hopeful',
  'restless',
  'question',
  'unknown',
] as const
export type EmpathyIntent = (typeof EMPATHY_INTENTS)[number]

export interface EmpathyReply {
  /** 小卜的回应（≤ EMPATHY_MAX_CHARS，永不含禁词） */
  text: string
  /** 归类到的意图；调用方不需要它也能工作，但埋点/调试用得上 */
  intent: EmpathyIntent
}

// ───────────────────────────────────────────────────────────────────────────
// 语气红线（在 guide 之外，本模块自己再收一道）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 小卜不能说的话。分三组：
 *   · 客服腔（请 / 抱歉 / 尽快…）—— 它是"服务窗口"，不是"陪着的人"
 *   · 心理诊断（心理 / 咨询 / 治疗 / 症状 / 抑郁…）—— 我们不诊断、不打标签
 *   · 空头承诺（我会一直 / 永远 / 保证 / 承诺）—— 说得好听，但空洞且失真
 */
export const EMPATHY_BANNED =
  /请|抱歉|对不起|麻烦您|尽快|立刻|马上|你应该|建议你|心理|咨询|治疗|诊断|症状|抑郁|焦虑症|我会一直|永远|保证|承诺/

// ───────────────────────────────────────────────────────────────────────────
// 回应文案表（全部 ≤ 34 字、全部「映照 + 许可」）
// ───────────────────────────────────────────────────────────────────────────

const LINES: Record<EmpathyIntent, readonly string[]> = {
  greeting: ['我在。你想说什么，我都在听。', '你来啦。今天这一会儿，就交给我陪你。', '嗯，我在呢。慢慢说，不急。'],
  tired: ['累到这样还在撑着，辛苦你了。', '今天先不用逞强，靠着待一会儿也行。', '没力气的时候，就先什么都不做。'],
  anxious: ['心里悬着的时候，本来就很难坐得住。', '慌是身体在替你紧张，不是你的错。', '先把这一口气慢慢吐出来，我陪你。'],
  down: ['难过就难过吧，不用急着好起来。', '想哭就哭一会儿，我在旁边。', '这份低落不用瞒着，我接得住。'],
  hopeful: ['有点期待的样子，我也跟着高兴。', '这份亮亮的心情，值得多看两眼。', '嗯，感觉今天有点不一样了。'],
  restless: ['静不下来的时候，动一动也没关系。', '心里乱乱的，先不用逼自己想清楚。', '坐不住就站起来走走，我等你回来。'],
  question: ['这个问题，我们先不急着要答案。', '我听见了你问的，先陪你把话说完。', '嗯，先把它说给我听，好不好。'],
  unknown: ['嗯，我在听。你慢慢说。', '说多少都可以，我都在。', '嗯，然后呢？我想多听一点。'],
}

export const EMPATHY_ALL_LINES: readonly string[] = EMPATHY_INTENTS.flatMap((i) => LINES[i])

// ───────────────────────────────────────────────────────────────────────────
// 意图判定（关键词；顺序即优先级 —— 情绪在前，寒暄在后）
// ───────────────────────────────────────────────────────────────────────────

const RULES: ReadonlyArray<{ intent: EmpathyIntent; re: RegExp }> = [
  { intent: 'anxious', re: /焦虑|紧张|害怕|担心|慌|不安|压力|恐惧|悬着|手心冒汗|睡不着/ },
  { intent: 'down', re: /难过|伤心|低落|想哭|哭了|难受|失落|委屈|崩溃|沮丧|心痛|空落/ },
  { intent: 'tired', re: /累|疲惫|困|没力气|撑不住|熬|通宵|加班|虚脱/ },
  { intent: 'restless', re: /烦|静不下来|坐不住|浮躁|焦躁|乱|燥/ },
  { intent: 'hopeful', re: /开心|高兴|期待|顺利|好消息|轻松|太好了|有希望/ },
  { intent: 'question', re: /[?？]|怎么|为什么|怎样|该不该|要不要|是不是|能不能|如何/ },
  { intent: 'greeting', re: /你好|您好|嗨|哈喽|在吗|在么|早上好|晚上好|晚安|早安|hi|hello|hey/i },
]

/** 心情 → 意图（用户只选了心情、没打字时用） */
const MOOD_INTENT: Record<MoodTone, EmpathyIntent> = {
  CALM: 'unknown',
  TIRED: 'tired',
  ANXIOUS: 'anxious',
  DOWN: 'down',
  HOPEFUL: 'hopeful',
  RESTLESS: 'restless',
}

export function classifyEmpathy(text: string): EmpathyIntent {
  const t = String(text ?? '').trim()
  if (!t) return 'unknown'
  for (const r of RULES) {
    if (r.re.test(t)) return r.intent
  }
  return 'unknown'
}

// ───────────────────────────────────────────────────────────────────────────
// 确定性选句
// ───────────────────────────────────────────────────────────────────────────

/** FNV-1a 变体；纯函数、无随机、可复现 */
function hash(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * 生成一句本地回应。
 * ★ 永不抛、永远返回合格文案（最差也落在 `unknown` 的兜底句上）。
 * ★ 确定性：同一 (text, turn) 永远同一句 —— 见文件头纪律③。
 */
export function replyLocally(input: { text?: string; mood?: MoodTone | null; turn: number }): EmpathyReply {
  const raw = String(input.text ?? '').trim()
  const intent = raw ? classifyEmpathy(raw) : input.mood ? MOOD_INTENT[input.mood] : 'unknown'
  const pool = LINES[intent]
  const turn = Number.isFinite(input.turn) ? Math.max(0, Math.floor(input.turn)) : 0
  const idx = hash(`${intent}|${raw}|${turn}`) % pool.length
  return { text: pool[idx], intent }
}

// ───────────────────────────────────────────────────────────────────────────
// 合规自检（单测 + 云端响应校验共用）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 这句话能不能给用户看。
 * ★ 空串、超长、命中任意一类禁词都算不合格。
 * ★ 云端返回的回应也要过这一关 —— 宁可回落本地合规文案。
 */
export function isEmpathySafe(text: string): boolean {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (t.length > EMPATHY_MAX_CHARS) return false
  if (FORBIDDEN_COPY.test(t)) return false
  if (FORBIDDEN_STRUCTURE_WORDS.test(t)) return false
  if (EMPATHY_BANNED.test(t)) return false
  return true
}
