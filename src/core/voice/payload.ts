/**
 * 小卜 · 语音出端载荷   src/core/voice/payload.ts
 * ===========================================================================
 * ⚠️ 这是全仓**唯一**允许把用户录音送出去的通道。
 *
 * ── 它为什么能存在（而不违反"原话不出端"）──────────────────────────────────
 *   白皮书的红线是：**占卜解读**链路里，用户的原话/录音一个字节都不出端 ——
 *   那条线由 `reading.ts` 的 `serializeForNetwork()` 结构性保证，本模块碰不到它。
 *
 *   而"按住说话"如果不把音频交给听写服务，就只是录音机。所以走**独立的同意通道**：
 *     · 只在 `consent === 'on'` 且 `features.voiceInput.enabled` 时才构造并发送；
 *     · 只发 `/api/asr`，与 `/api/chat`、`/api/reading` 是三个端点、三套契约；
 *     · 服务端不落盘、日志只记时长与格式，客户端埋点永不含音频或文本。
 *   于是"什么时候出端"从一个模糊承诺，变成**一个布尔开关 + 一个函数**。
 *
 * ── 逐字段构造，绝不 spread ─────────────────────────────────────────────────
 *   门禁⑦ 明令禁止 `...payload` 这类展开 —— 展开会把将来新增的字段
 *   （哪怕是不该出端的）一起带出去。这里三个字段一个字一个字写死，
 *   新增字段必须**显式**加进来，这是保守默认。
 * ===========================================================================
 */

/** 出端载荷：三个字段，就是全部 */
export interface VoicePayload {
  /** 录音的 base64（不含 data: 前缀） */
  audio: string
  /** 音频容器格式（如 audio/webm;codecs=opus），供服务端选择解码方式 */
  format: string
  /** 录音时长（ms，数值，用于兜底闸与成本估算，不含任何内容） */
  durationMs: number
}

/** ★ 出端字段白名单。新增字段必须显式加进来，否则不会被发送（保守默认） */
export const VOICE_NETWORK_FIELDS = ['audio', 'format', 'durationMs'] as const

function clampDuration(n: unknown): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
}

/**
 * 组装出端载荷。
 * ★ 逐字段构造：不 spread、不带任何旁路字段。
 * ★ 永不抛：任何异常输入都退化成"空音频 + 空格式 + 0 时长"。
 */
export function buildVoicePayload(input: {
  audio?: string
  format?: string
  durationMs?: number
}): VoicePayload {
  return {
    audio: String(input.audio ?? ''),
    format: String(input.format ?? ''),
    durationMs: clampDuration(input.durationMs),
  }
}

/**
 * 序列化。★ 与 `serializeForNetwork()` / `serializeEmpathyPayload()` 同构：
 *   只挑白名单字段，其余丢弃。
 */
export function serializeVoicePayload(p: VoicePayload): string {
  const out: Record<string, unknown> = {}
  for (const f of VOICE_NETWORK_FIELDS) out[f] = p[f]
  return JSON.stringify(out)
}
