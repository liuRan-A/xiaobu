/**
 * 小卜 · 背景音偏好（静音开关）   src/core/audio/prefs.ts
 * ===========================================================================
 * 唯一被持久化的音频偏好就是"静音与否"。它经 `PersistedStore`（带写预算）落盘，
 * 与语音/共情同意同路 —— 因为"要不要出声"是用户的长期选择，不该每次开机重问。
 *
 * ★ 默认**不静音**（muted = false）：背景音是氛围的一部分，默认开着；
 *   反感它的用户点一下就能关掉，并永久记住。
 * ★ 脏数据（存进来的不是布尔）→ 退回默认；解析这件事不猜（与 localStore 同一约定）。
 * ===========================================================================
 */

import { PERSIST_KEYS, type PersistedStore } from '@core/persist'

/** 默认：不静音（声音开着） */
export const AUDIO_MUTED_DEFAULT = false

/** 读静音偏好。★ 缺省 / 脏数据都退回默认，绝不抛 */
export function loadAudioMuted(store: PersistedStore): boolean {
  const v = store.get<unknown>(PERSIST_KEYS.audioMuted, AUDIO_MUTED_DEFAULT)
  return typeof v === 'boolean' ? v : AUDIO_MUTED_DEFAULT
}

/** 写静音偏好（下一次 flush 落盘） */
export function saveAudioMuted(store: PersistedStore, muted: boolean): void {
  store.set(PERSIST_KEYS.audioMuted, muted === true)
}
