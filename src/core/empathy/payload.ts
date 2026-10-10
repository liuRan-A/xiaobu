/**
 * 小卜 · 共情对话的出端载荷   src/core/empathy/payload.ts
 * ===========================================================================
 * ⚠️ 这是全仓**唯一**允许把用户原话送出去的通道。
 *
 * ── 它为什么能存在（而不违反"原话不出端"）──────────────────────────────────
 *   白皮书冻结的红线是：**占卜解读**这条链路里，用户原话一个字节都不出端 ——
 *   那条线由 `reading.ts` 的 `serializeForNetwork()` 结构性保证，本模块碰不到它。
 *
 *   而"陪你说说话"如果不看原话，就只剩复读机。所以走**独立的同意通道**：
 *     · 只在 `consent === 'on'` 且 `features.empathyCloud.enabled` 时才构造并发送；
 *     · 只发 `/api/chat`，与 `/api/reading` 是两个端点、两套契约；
 *     · 服务端不落盘、日志只记长度，客户端埋点永不含文本。
 *   于是"什么时候出端"从一个模糊承诺，变成**一个布尔开关 + 一个函数**。
 *
 * ── 逐字段构造，绝不 spread ─────────────────────────────────────────────────
 *   门禁⑦ 明令禁止 `...payload` 这类展开 —— 展开会把将来新增的字段
 *   （哪怕是不该出端的）一起带出去。这里三个字段一个字一个字写死，
 *   新增字段必须**显式**加进来，这是保守默认。
 * ===========================================================================
 */

import { EMPATHY_TEXT_MAX_CHARS } from '@core/empathy/empathy'
import type { MoodTone } from '@core/reading'

/** 出端载荷：三个字段，就是全部 */
export interface EmpathyPayload {
  /** 用户这一句（已截断到 EMPATHY_TEXT_MAX_CHARS） */
  text: string
  /** 用户选的心情（可空 —— 没选过就是 null） */
  mood: MoodTone | null
  /** 本会话说了第几轮（数值，用于服务端选语气，不含任何内容） */
  turns: number
}

/** ★ 出端字段白名单。新增字段必须显式加进来，否则不会被发送（保守默认） */
export const EMPATHY_NETWORK_FIELDS = ['text', 'mood', 'turns'] as const

/** 按码元截断（中文每字 1 码元），超长直接切，不做省略号（服务端契约同为 200） */
function clampText(s: string): string {
  const t = String(s ?? '')
  return t.length > EMPATHY_TEXT_MAX_CHARS ? t.slice(0, EMPATHY_TEXT_MAX_CHARS) : t
}

function clampTurns(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
}

/**
 * 组装出端载荷。
 * ★ 逐字段构造：不 spread、不带任何 `localOnly` 式的旁路。
 * ★ 永不抛：任何异常输入都退化成"空文本 + 空心情 + 0 轮"。
 */
export function buildEmpathyPayload(input: {
  text?: string
  mood?: MoodTone | null
  turns?: number
}): EmpathyPayload {
  return {
    text: clampText(input.text ?? ''),
    mood: input.mood ?? null,
    turns: clampTurns(input.turns ?? 0),
  }
}

/**
 * 序列化。★ 与 `serializeForNetwork()` 同构：只挑白名单字段，其余丢弃。
 */
export function serializeEmpathyPayload(p: EmpathyPayload): string {
  const out: Record<string, unknown> = {}
  for (const f of EMPATHY_NETWORK_FIELDS) out[f] = p[f]
  return JSON.stringify(out)
}
