/**
 * 小卜 · 语音输入（本地纯函数）   src/core/voice/voice.ts
 * ===========================================================================
 * 「按住说话」这条链路的**本地那半**：把麦克风转出来的音频，最终变成一句
 * 用户能看、小卜能接的话。这里只放**不认识像素、不认识网络**的纯函数，
 * 所以它能在 node 里被单测整表扫一遍。
 *
 * ── 三件小事，各有各的理由 ──────────────────────────────────────────────────
 *   ① `normalizeVoiceText` —— ASR 回来的文本常带首尾空白、句中双空格（口播停顿）。
 *      不折叠就会让「今天  很累」和「今天 很累」被当成两句不同的话。截断到
 *      `VOICE_TEXT_MAX_CHARS`，与共情通道同一把尺子（服务端 /api/chat 契约同为 200）。
 *   ② `isVoiceTextUsable` —— 空串 / 纯空白 = 没听清。这是"要不要往下走"的唯一判据。
 *   ③ `isHoldLongEnough` —— 误触（点一下就松）不该白花一次云端识别。低于阈值直接丢。
 *
 * ★ 零依赖：core 层约束（ESLint 禁令 1）—— 不许 import vue / pinia / @store / @scene。
 * ★ 永不抛：任何脏输入都退化成"空串 / false"，绝不让一次误触把主流程带崩。
 * ===========================================================================
 */

/** 识别结果最多留多少字。★ 与 EMPATHY_TEXT_MAX_CHARS 同值（200）—— 语音最终就是喂给共情通道 */
export const VOICE_TEXT_MAX_CHARS = 200

/** 按住低于这个时长视为误触，不送识别（一次云端识别有成本，不该被误触花掉） */
export const VOICE_MIN_HOLD_MS = 300

/**
 * 归一化识别文本：折叠所有连续空白（含全角空格）为单个半角空格 + 去首尾 + 截断。
 * ★ 永不抛：非字符串输入一律当空串。
 */
export function normalizeVoiceText(raw: unknown): string {
  const t = String(raw ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
  return t.length > VOICE_TEXT_MAX_CHARS ? t.slice(0, VOICE_TEXT_MAX_CHARS) : t
}

/** 这段识别结果能不能用。★ 判据只有一条：归一化后非空。 */
export function isVoiceTextUsable(text: unknown): boolean {
  return normalizeVoiceText(text).length > 0
}

/** 按住的时长够不够。★ 非有限数（NaN / Infinity）一律算不够。 */
export function isHoldLongEnough(ms: number): boolean {
  return Number.isFinite(ms) && ms >= VOICE_MIN_HOLD_MS
}
