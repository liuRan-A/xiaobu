/**
 * 小卜 · 纸张音效   src/ui/paperSound.ts
 * ===========================================================================
 * 翻页音效：WebAudio **程序化合成**的纸张沙沙声 —— 白噪声 + 低通 + 包络。
 * ★ 0 包体：没有 mp3/ogg 文件，声音在播放的那一刻才被"算"出来。
 *
 * ★ 懒创建 AudioContext：浏览器要求音频上下文必须由用户手势触发，
 *   而翻页恰恰就是手势 —— 时序天然合规。失败（无声卡 / 策略阻止）静默降级：
 *   翻页没有声音不影响任何功能（门禁 ⑨ 精神：catch 内不出 UI）。
 * ===========================================================================
 */
import { logger } from '@shared/logger'

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (ctx) return ctx
  const AC = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext
  if (!AC) return null
  try {
    ctx = new AC()
  } catch (e) {
    logger.warn('[sound] AudioContext 创建失败（翻页静音播放）', e)
    return null
  }
  return ctx
}

/** 一次 0.28s 的纸张沙沙。重复调用各自独立，互不打断 */
export function playPaperRustle(): void {
  const ac = getCtx()
  if (!ac) return

  try {
    const dur = 0.28
    const sr = ac.sampleRate
    const buf = ac.createBuffer(1, Math.ceil(sr * dur), sr)
    const data = buf.getChannelData(0)

    // 纸张质感 = 白噪声 + 快速的幅度抖动（纸纤维的"沙"）
    for (let i = 0; i < data.length; i++) {
      const t = i / data.length
      // 包络：快起（10%）- 慴落，像纸页从手里滑过
      const env = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9
      const fiber = 0.55 + 0.45 * Math.sin(i * 0.021) * Math.sin(i * 0.0043)
      data[i] = (Math.random() * 2 - 1) * env * fiber
    }

    const src = ac.createBufferSource()
    src.buffer = buf

    // 低通：把白噪声的"刺"磨成"沙"
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 2400
    lp.Q.value = 0.7

    const gain = ac.createGain()
    gain.gain.value = 0.16 // 刻意轻：音效是气氛，不是存在感

    src.connect(lp).connect(gain).connect(ac.destination)
    src.start()
  } catch (e) {
    logger.warn('[sound] 纸张音效播放失败（静默）', e)
  }
}
