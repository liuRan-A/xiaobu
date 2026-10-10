/**
 * 小卜 · 语音出端的用户同意   src/core/voice/consent.ts
 * ===========================================================================
 * 「把你说的话发给小卜听写」这件事**必须用户点头**，而且默认**不**发。
 *
 * ── 为什么与共情同意分开一份 ────────────────────────────────────────────────
 *   共情的同意（empathyConsent）管的是**文字原话**走 `/api/chat`；
 *   语音的同意管的是**录音音频**走 `/api/asr`。两者是**两条独立的出端通道**：
 *     · 用户可以只想打字、不录语音（或反过来），所以开关必须各管各的；
 *     · 音频比文字更敏感 —— 它带着声纹与环境音，绝不能因为"上次打字同意过"
 *       就默认也可以上传音频。
 *   于是这里刻意**不复用** empathyConsent，而是自己一个键、自己一个默认。
 *
 * ── 三态之二 + 保守兜底 ─────────────────────────────────────────────────────
 *   · 默认 `off`：不同意就一个字节音频都不出端，"按住说话"只显示同意行。
 *   · 一旦 `on`：音频只走**独立的 `/api/asr` 通道**，不进任何解读白名单。
 *   · 任何非 'on' 的值（脏数据 / 老版本残留）一律当 'off' —— 隐私开关的兜底方向
 *     只能是更保守，不能更开放。
 *
 * ★ 零依赖（core 层约束）：只认 `PersistedStore` 这个端口，不碰浏览器 API。
 * ===========================================================================
 */

import { PERSIST_KEYS, type PersistedStore } from '@core/persist'

/** 语音出端同意：'off' = 永不出端（只显示同意行）；'on' = 允许把这段录音发给小卜听写 */
export type VoiceConsent = 'off' | 'on'

/** ★ 默认值就是红线：没明确点过「好」，就永远是 off */
export const VOICE_CONSENT_DEFAULT: VoiceConsent = 'off'

/** 读同意。★ 非 'on' 一律当 'off'（兜底方向只能更保守） */
export function loadVoiceConsent(store: PersistedStore): VoiceConsent {
  const v = store.get<unknown>(PERSIST_KEYS.voiceConsent, VOICE_CONSENT_DEFAULT)
  return v === 'on' ? 'on' : 'off'
}

/** 写同意。只落 'on' / 'off'；写不落盘也只影响本轮内存态，不影响本次会话 */
export function saveVoiceConsent(store: PersistedStore, consent: VoiceConsent): void {
  store.set(PERSIST_KEYS.voiceConsent, consent === 'on' ? 'on' : 'off')
}
