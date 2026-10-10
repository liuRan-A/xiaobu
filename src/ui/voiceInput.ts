/**
 * 小卜 · 语音输入编排   src/ui/voiceInput.ts
 * ===========================================================================
 * 把「按住说话」串起来的那根线。沿用 `src/ui/empathyChat.ts` 的范式：
 * ui 下的纯 TS 模块，不写模板、不碰 DOM，只做编排。
 *
 * ── 一次「按住说话」的完整时序 ──────────────────────────────────────────────
 *   pointerdown ⇒ `startVoice()`
 *     · 同步同意镜像、清上一句提示
 *     · 未同意 ⇒ **不碰麦克风**，只让同意行出现（等用户点「好」）
 *     · 已同意 ⇒ 开始录音（设备不支持则给柔和提示）
 *   pointerup   ⇒ `finishVoice()`
 *     · 按住太短 ⇒ 丢掉（误触不花一次云端识别），但仍释放麦克风
 *     · 拿到音频 ⇒ 走独立的 `/api/asr`（**永不出端的本地兜底**：拿不到就提示再试）
 *     · 识别成功 ⇒ 写入 `store.heard`，由组件把它端到用户面前（切球 + 开对话 + 发送）
 *
 * ── 三条边界 ────────────────────────────────────────────────────────────────
 *   · 隐私：音频只在**用户显式同意**下出端；未同意时连录制都不开始
 *   · 埋点只记枚举（VOICE_*），永不含音频或识别文本（门禁⑦）
 *   · catch 内只 logger.warn（门禁⑨）
 * ===========================================================================
 */
import { getEngine } from '@store/engineHost'
import { useVoiceInputStore } from '@store/voiceInput'
import { requestSpeechText } from '@services/asr'
import { startVoiceCapture, finishVoiceCapture, isVoiceRecordingSupported } from '@services/voiceRecorder'
import { isHoldLongEnough, isVoiceTextUsable, normalizeVoiceText } from '@core/voice/voice'
import { trackFunnel } from '@services/track'
import { logger } from '@shared/logger'

/** 提示文案（全部柔和、无感叹号、无报错腔） */
const HINT_TOO_SHORT = '按住再久一点点，我才能听清。'
const HINT_UNSUPPORTED = '这儿暂时听不了，可以打字告诉小卜。'
const HINT_FAILED = '刚才没听清，要不要再按住说一次？'
const HINT_SENT = '听到了，这就去和小卜说。'

/** 按下时刻（算按住时长） */
let pressAt = 0
/** 开始录音那一步的 promise（getUserMedia 是异步的，收尾时要等它落地） */
let startPromise: Promise<boolean> | null = null
/** 会话序号：作废在途的听写请求，避免"这一轮的识别结果"写进"下一轮" */
let busySeq = 0

/** 从引擎持久化同步语音同意镜像到 store（按下 / 打开时调一次） */
function syncVoiceConsent(store: ReturnType<typeof useVoiceInputStore>): void {
  try {
    store.setConsent(getEngine().getVoiceConsent())
  } catch (e) {
    logger.warn('[voice] 读取语音同意失败（按默认 off 处理）', e)
  }
}

/**
 * 按下「按住说话」。★ 永不抛。
 * 未同意时不碰麦克风 —— 同意是音频出端的第一道闸，录制之前就该挡下。
 */
export function startVoice(): void {
  const store = useVoiceInputStore()
  syncVoiceConsent(store)
  store.setHint('')
  store.setHeard('')
  busySeq++ // 作废上一轮在途的听写
  pressAt = Date.now()
  store.setHeld(true)
  trackFunnel('VOICE_HOLD')

  if (store.consent !== 'on') return

  if (!isVoiceRecordingSupported()) {
    store.setHint(HINT_UNSUPPORTED)
    return
  }

  store.setRecording(true)
  const p = startVoiceCapture()
  startPromise = p
  void p.then((ok) => {
    if (!ok) {
      store.setRecording(false)
      store.setHint(HINT_UNSUPPORTED)
    }
  })
}

/**
 * 松开「按住说话」。★ 永不抛；任何失败都只给一句柔和提示，绝不弹 UI。
 */
export async function finishVoice(): Promise<void> {
  const store = useVoiceInputStore()
  const wasHeld = store.held
  store.setHeld(false)
  if (!wasHeld) return
  if (store.consent !== 'on') return
  if (!store.recording) return

  store.setRecording(false)
  const heldMs = Date.now() - pressAt

  // 等"开始录音"那一步落地（它内部已兜住所有异常，await 是安全的）
  if (startPromise) {
    await startPromise
    startPromise = null
  }

  if (!isHoldLongEnough(heldMs)) {
    // 误触：麦克风仍要收掉，但不送识别（不花这一次成本）
    await finishVoiceCapture()
    store.setHint(HINT_TOO_SHORT)
    return
  }

  const clip = await finishVoiceCapture()
  if (!clip) {
    store.setHint(HINT_FAILED)
    trackFunnel('VOICE_FAILED')
    return
  }

  const seq = ++busySeq
  store.setBusy(true)
  let said: string | null = null
  try {
    said = await requestSpeechText({
      audio: clip.dataBase64,
      format: clip.format,
      durationMs: clip.durationMs,
    })
  } finally {
    if (seq === busySeq) store.setBusy(false)
  }

  // 会话守卫：期间用户又按了一次 / 离开了 ⇒ 丢弃这次过期结果
  if (seq !== busySeq) return

  if (!isVoiceTextUsable(said)) {
    store.setHint(HINT_FAILED)
    trackFunnel('VOICE_FAILED')
    return
  }

  store.setHeard(normalizeVoiceText(said))
  store.setHint(HINT_SENT)
  trackFunnel('VOICE_SENT')
}

/**
 * 用户在同意行里做选择。
 * ★ 只有 'on' 时才允许把录音交给云端；'off'（先这样）保持"按住说话"只做本地提示。
 */
export function setVoiceConsent(choice: 'off' | 'on'): void {
  const store = useVoiceInputStore()
  const c = choice === 'on' ? 'on' : 'off'
  store.setConsent(c)
  store.setConsentAsked(true)
  try {
    // 真源在引擎持久化里；写失败也只 warn —— 本轮内存镜像已生效
    getEngine().setVoiceConsent(c)
  } catch (e) {
    logger.warn('[voice] 保存语音同意失败（本轮内存态仍生效）', e)
  }
  if (c === 'on') trackFunnel('VOICE_CONSENT_ON')
}

/** 离开小屋 / 收起时调：清掉按压态与提示，并作废在途听写 */
export function resetVoiceInput(): void {
  const store = useVoiceInputStore()
  busySeq++
  store.reset()
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：重置计时与序号（跨用例隔离） */
export function __test_resetVoiceInput(): void {
  pressAt = 0
  startPromise = null
  busySeq = 0
}
