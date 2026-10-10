/**
 * 小卜 · 背景音播放器   src/audio/index.ts
 * ===========================================================================
 * 唯一出声的地方。它把 `core/audio/ambient.ts` 算出的"该放哪一首、多大声"
 * 落到一个 `<audio>` 上。
 *
 * ── 四条纪律 ────────────────────────────────────────────────────────────────
 *   ① **不阻塞首帧**：`installAmbientAudio()` 不 await、不预先建元素；
 *      `<audio>` 在"真要播的那一刻"才建，URL 也才第一次拼。
 *   ② **失败静默**：拿不到元素 / 播不了 / url 为空 / 网络拒绝 —— 全部只
 *      `logger.warn` 一次，绝不弹 UI、绝不冒泡（门禁⑨）。
 *   ③ **可静音**：静音即暂停并记住；取消静音再尝试继续。
 *   ④ **随季节 / 时段**：每次 `syncAmbientAudio()` 重算音轨；跨时段或换季时
 *      自然切到新的一首（切歌失败也只是没声音，不影响任何玩法）。
 *
 * ★ 自动播放策略：浏览器要求"用户手势后"才允许出声。所以这里挂一次性的
 *   `pointerdown` 监听，在用户第一次触碰屏幕时再尝试播放 —— 不做任何"提示用户
 *   去点一下才能听声音"的打扰，能响就响，不能响就算了。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { currentConfig } from '@bootstrap/bootSequence'
import {
  ambientAudioUrl,
  ambientPlanFor,
  ambientVolumeFor,
  type AmbientPlan,
} from '@core/audio/ambient'

/** 当前是否静音。★ 真源在引擎持久化里，这里只是播放器要用的内存镜像 */
let muted = false

/** 当前的 <audio>（懒建；拿不到就一直是 null） */
let el: HTMLAudioElement | null = null
/** 当前已挂的音轨地址，避免同一首反复改 src（会打断正在播的声音） */
let currentUrl = ''
/** 最近一次算出的调度计划（调试 / 测试读它） */
let plan: AmbientPlan | null = null
/** 是否已装过（幂等） */
let installed = false

/** 安全取 Audio 构造器：SSR / 老 WebView 里可能没有 */
function audioCtor(): typeof Audio | null {
  try {
    return typeof Audio !== 'undefined' ? Audio : null
  } catch (e) {
    logger.warn('[audio] Audio 构造器不可用（跳过背景音）', e)
    return null
  }
}

/** 背景音此刻是否"该响"：开关开启 + 未静音 */
export function isAmbientOn(): boolean {
  return currentConfig().features.ambientAudio.enabled && !muted
}

/** 当前是否静音 */
export function isAmbientMuted(): boolean {
  return muted
}

/** 最近一次调度计划（测试 / 调试用） */
export function ambientPlanNow(): AmbientPlan | null {
  return plan
}

/** 懒建 / 复用 <audio> 并挂上音轨。任何一步失败都返回 null（不抛） */
function ensureElement(url: string): HTMLAudioElement | null {
  const Ctor = audioCtor()
  if (!Ctor) return null
  try {
    if (!el) {
      el = new Ctor()
      el.loop = true
      el.preload = 'none'
      el.muted = muted
    }
    if (currentUrl !== url) {
      currentUrl = url
      el.src = url
    }
    el.muted = muted
    return el
  } catch (e) {
    // ★ 门禁⑨：建元素失败只是没有背景音，不影响任何玩法
    logger.warn('[audio] 建立背景音元素失败（静默跳过）', e)
    return null
  }
}

/** 尝试播放（内部分支全部吞掉异常） */
async function play(): Promise<void> {
  if (!el || muted) return
  try {
    await el.play()
  } catch (e) {
    // ★ 门禁⑨：自动播放被拦 / 编解码失败 / 资源 404 —— 都只是"这次没声音"
    logger.warn('[audio] 背景音播放被拦（静默）', e)
  }
}

function pause(): void {
  try {
    el?.pause()
  } catch (e) {
    logger.warn('[audio] 背景音暂停失败（静默）', e)
  }
}

/**
 * 同步一次背景音：按**此刻**的季节 / 时段与配置决定放什么。
 * ★ 永不抛；开关关闭或静音时只做暂停。
 */
export function syncAmbientAudio(now = new Date()): void {
  try {
    const cfg = currentConfig()
    if (!cfg.features.ambientAudio.enabled || muted) {
      pause()
      return
    }

    const p = ambientPlanFor(now)
    plan = p

    const url = ambientAudioUrl(cfg.assets.cdnBase, p.trackId)
    if (!url) return // cdnBase 为空（首启 / 断网）→ 不播，也不报错

    const a = ensureElement(url)
    if (!a) return
    a.volume = ambientVolumeFor(p.dayPart)
    void play()
  } catch (e) {
    // ★ 门禁⑨：任何意外都只是没有背景音
    logger.warn('[audio] 背景音同步失败（静默）', e)
  }
}

/**
 * 设置静音。★ 由 store / 用户点选驱动；立即生效、不抛。
 */
export function setAmbientMuted(v: boolean): void {
  muted = v === true
  if (el) el.muted = muted
  if (muted) pause()
  else syncAmbientAudio()
}

/**
 * 装上背景音。★ 幂等；不阻塞首帧（不 await、不预建元素）。
 *
 * 先按当前时刻尝试一次（WebView 有时允许），再挂一次性的"首次触摸"监听：
 * 用户在屏幕上按第一下时再试一次 —— 那是浏览器允许出声的时机。
 */
export function installAmbientAudio(): void {
  if (installed) return
  installed = true

  syncAmbientAudio()

  if (typeof window === 'undefined') return
  const kick = (): void => {
    window.removeEventListener('pointerdown', kick)
    syncAmbientAudio()
  }
  window.addEventListener('pointerdown', kick, { once: true })
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：重置播放器内部状态（跨用例隔离） */
export function __test_resetAmbientAudio(): void {
  muted = false
  el = null
  currentUrl = ''
  plan = null
  installed = false
}
