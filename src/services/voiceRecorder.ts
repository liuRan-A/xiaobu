/**
 * 小卜 · 录音采集适配层   src/services/voiceRecorder.ts
 * ===========================================================================
 * 「按住说话」的**麦克风那一段**：把浏览器 / WebView 的 `MediaRecorder` 收口到一个
 * 文件里，对外只暴露两个动作：
 *   · `startVoiceCapture()`  按下时开始录
 *   · `finishVoiceCapture()` 松手时收尾，拿到 base64 + 格式 + 时长（或 null）
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *   ① **永不抛**：麦克风没授权 / 设备不支持 / 采集失败，一律返回 false / null，
 *      由编排层（ui/voiceInput.ts）给出柔和提示 —— 绝不弹任何系统级报错（门禁⑨）。
 *   ② **不持久化**：录音只活在内存里（chunks 数组），拿到 base64 立即交给上端出端，
 *      本模块不碰任何存储（门禁⑩ / ⑬）。
 *   ③ **一次只录一段**：模块级单例 `active`，重复 start 直接返回真 —— 避免"两次按下
 *      叠了两个 MediaRecorder，麦克风互相抢"这种典型的时序 bug。
 *
 * ★ 本模块不认识"同意"、不认识"网络" —— 它只管把声音变成字节。要不要出端、
 *   出到哪，由 asr.ts 与 ui/voiceInput.ts 决定。
 * ===========================================================================
 */

import { logger } from '@shared/logger'

/** 一段录好的音频：base64（无 data: 前缀）+ 容器格式 + 时长 */
export interface VoiceClip {
  dataBase64: string
  format: string
  durationMs: number
}

interface RecorderState {
  recorder: MediaRecorder
  chunks: Blob[]
  startedAt: number
  mimeType: string
}

/** 模块级单例：同一时刻只允许一段在录 */
let active: RecorderState | null = null

/** 这台设备 / 这个 WebView 能不能录音 */
export function isVoiceRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  )
}

/** 挑一个 MediaRecorder 认的容器格式；都不支持就让浏览器自己选 */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  try {
    for (const c of candidates) {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c)) return c
    }
  } catch {
    // ★ 门禁⑨：探测格式失败不弹 UI，退回让浏览器自选
  }
  return ''
}

/**
 * 开始录音。★ 永不抛。
 * @returns true = 已经在录（含重复调用）；false = 设备不支持 / 未授权 / 起不来
 */
export async function startVoiceCapture(): Promise<boolean> {
  if (active) return true
  if (!isVoiceRecordingSupported()) return false

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickMimeType()
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.start()
    active = { recorder, chunks, startedAt: Date.now(), mimeType: mimeType || 'audio/webm' }
    return true
  } catch (e) {
    // ★ 门禁⑨：麦克风不可用 / 未授权 —— 只记日志，静默返回失败，由编排层给柔和提示
    logger.warn('[voice] 无法开始录音（麦克风不可用或未授权）', e)
    active = null
    return false
  }
}

/** 收尾：停止录音、释放麦克风、拿到一段音频。★ 永不抛；没在录或失败返回 null */
export async function finishVoiceCapture(): Promise<VoiceClip | null> {
  const state = active
  if (!state) return null
  active = null

  const durationMs = Math.max(0, Date.now() - state.startedAt)
  try {
    const blob = await stopAndCollect(state)
    releaseStream(state)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes.length === 0) return null
    return { dataBase64: toBase64(bytes), format: state.mimeType, durationMs }
  } catch (e) {
    // ★ 门禁⑨：收尾失败当作"没听到"，只记日志；麦克风仍要尽量释放
    logger.warn('[voice] 录音收尾失败（当作没听到）', e)
    releaseStream(state)
    return null
  }
}

/** 停止并收集最后一段数据 */
function stopAndCollect(state: RecorderState): Promise<Blob> {
  return new Promise<Blob>((resolve) => {
    state.recorder.onstop = () => resolve(new Blob(state.chunks, { type: state.mimeType }))
    try {
      state.recorder.stop()
    } catch {
      // ★ 门禁⑨：stop 抛错就直接用已收集的片段收尾，不弹 UI
      resolve(new Blob(state.chunks, { type: state.mimeType }))
    }
  })
}

/** 释放麦克风轨道（不释放会一直亮着录音指示灯） */
function releaseStream(state: RecorderState): void {
  try {
    state.recorder.stream.getTracks().forEach((t) => t.stop())
  } catch {
    // ★ 门禁⑨：释放失败只影响指示灯，不影响流程
  }
}

/** Uint8Array → base64（无 data: 前缀）。短片段用简单循环即可 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：丢弃在录状态（跨用例隔离） */
export function __test_resetVoiceRecorder(): void {
  if (active) releaseStream(active)
  active = null
}
