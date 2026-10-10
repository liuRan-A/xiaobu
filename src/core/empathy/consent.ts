/**
 * 小卜 · 共情对话的云端同意   src/core/empathy/consent.ts
 * ===========================================================================
 * 「把你说的话发给小卜」这件事**必须用户点头**，而且默认**不**发。
 *
 * ── 为什么默认 off ──────────────────────────────────────────────────────────
 *   占卜那条线的隐私是**结构性**保证的：出端只有 `kind/dims/structure` 枚举，
 *   用户原话在 `serializeForNetwork()` 里就被剥掉了（见 reading.ts）。
 *   但「陪你说说话」天然需要原话 —— 于是这里换一种保证方式：
 *
 *     · 默认 `off`：不同意就一个字都不出端，本地回应照常（断网可用）。
 *     · 一旦 `on`：原话只走**独立的 `/api/chat` 同意通道**，
 *       不进 `reading` 白名单、不落盘、日志只记长度。
 *     · 用户可以随时改回 `off`，下一次发送立即生效。
 *
 * ★ 这个模块只做一件事：**读写这一个三态之二**。所有"要不要发请求"的判断
 *   都收口在这里与 `services/empathyCloud.ts`，不在 UI 里散落 `if`。
 *
 * ★ 零依赖（core 层约束）：只认 `PersistedStore` 这个端口，不碰浏览器 API。
 * ===========================================================================
 */

import { PERSIST_KEYS, type PersistedStore } from '@core/persist'

/** 云端通道同意：'off' = 永不出端；'on' = 允许把原话发给小卜 */
export type CloudConsent = 'off' | 'on'

/** ★ 默认值就是红线：没明确点过「好」，就永远是 off */
export const CLOUD_CONSENT_DEFAULT: CloudConsent = 'off'

/**
 * 读同意。★ 任何非 'on' 的值（含脏数据 / 老版本残留）一律当 'off' ——
 *   隐私开关的兜底方向只能是更保守，不能是更开放。
 */
export function loadConsent(store: PersistedStore): CloudConsent {
  const v = store.get<unknown>(PERSIST_KEYS.empathyConsent, CLOUD_CONSENT_DEFAULT)
  return v === 'on' ? 'on' : 'off'
}

/** 写同意。只落 'on' / 'off' 两个值，写不落盘也只是本轮内存态，不影响本次会话 */
export function saveConsent(store: PersistedStore, consent: CloudConsent): void {
  store.set(PERSIST_KEYS.empathyConsent, consent === 'on' ? 'on' : 'off')
}
