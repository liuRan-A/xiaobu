/**
 * 小卜 · 背景音   tests/audio.spec.ts
 * ===========================================================================
 * 四块被测物（自下而上）：
 *   ① core/audio/ambient —— 纯调度：由月份定季节、由小时定时段、拼音轨 id 与音量
 *   ② core/audio/prefs   —— 静音偏好的默认值 / 往返 / 脏数据兜底
 *   ③ src/audio          —— 播放器：懒建、静默失败、可静音（用假 Audio 桩验证）
 *   ④ store/audio        —— 反应式投影 + 写回引擎持久化
 *
 * ★ 播放器的"真出声"在 node 里不可测，所以用**假 Audio 桩**验证调用序列：
 *   建元素 / 设 src / 设 volume / play / pause / muted —— 这些才是这一层真正的职责。
 * ===========================================================================
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  ambientAudioUrl,
  ambientPlanFor,
  ambientVolumeFor,
  dayPartOfHour,
  seasonOfMonth,
} from '@core/audio/ambient'
import { AUDIO_MUTED_DEFAULT, loadAudioMuted, saveAudioMuted } from '@core/audio/prefs'
import { PERSIST_KEYS, PersistedStore, createMemoryPort } from '@core/persist'
import {
  __test_resetAmbientAudio,
  ambientPlanNow,
  installAmbientAudio,
  isAmbientMuted,
  isAmbientOn,
  setAmbientMuted,
  syncAmbientAudio,
} from '@audio'
import { useAudioStore } from '@store/audio'
import { getEngine, resetEngineHost } from '@store/engineHost'
import { applyConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'

// ───────────────────────────────────────────────────────────────────────────
// 假 Audio 桩 —— 记录所有调用，node 里也能验证播放器行为
// ───────────────────────────────────────────────────────────────────────────

class FakeAudio {
  static instances: FakeAudio[] = []
  loop = false
  preload = ''
  muted = false
  volume = 1
  src = ''
  paused = true
  play = vi.fn(async () => {
    this.paused = false
  })
  pause = vi.fn(() => {
    this.paused = true
  })
  constructor() {
    FakeAudio.instances.push(this)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ① core/audio/ambient · 纯调度
// ───────────────────────────────────────────────────────────────────────────

describe('① audio/ambient · 季节 / 时段 / 音轨', () => {
  it('seasonOfMonth：3–5 春、6–8 夏、9–11 秋、12–2 冬', () => {
    expect(seasonOfMonth(2)).toBe('spring') // 3 月
    expect(seasonOfMonth(5)).toBe('summer') // 6 月
    expect(seasonOfMonth(8)).toBe('autumn') // 9 月
    expect(seasonOfMonth(11)).toBe('winter') // 12 月
    expect(seasonOfMonth(0)).toBe('winter') // 1 月
  })

  it('dayPartOfHour：夜 / 晨 / 昼 / 昏 边界', () => {
    expect(dayPartOfHour(3)).toBe('night')
    expect(dayPartOfHour(6)).toBe('dawn')
    expect(dayPartOfHour(11)).toBe('day')
    expect(dayPartOfHour(17)).toBe('dusk')
    expect(dayPartOfHour(21)).toBe('night')
  })

  it('ambientPlanFor：季节-时段拼成音轨 id', () => {
    expect(ambientPlanFor(new Date(2026, 2, 19, 18, 30)).trackId).toBe('spring-dusk')
    expect(ambientPlanFor(new Date(2026, 6, 1, 3, 0)).trackId).toBe('summer-night')
  })

  it('ambientVolumeFor：夜里最轻、白天稍高', () => {
    expect(ambientVolumeFor('night')).toBeLessThan(ambientVolumeFor('day'))
    expect(ambientVolumeFor('day')).toBeCloseTo(0.3)
  })

  it('ambientAudioUrl：拼到 cdnBase 下；空 base 返回空串（不播）', () => {
    expect(ambientAudioUrl('https://cdn.example.com/scene/', 'spring-dusk')).toBe(
      'https://cdn.example.com/scene/audio/spring-dusk.ogg',
    )
    expect(ambientAudioUrl('', 'spring-dusk')).toBe('')
    expect(ambientAudioUrl('https://x/', '')).toBe('')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② core/audio/prefs · 静音偏好
// ───────────────────────────────────────────────────────────────────────────

async function storeWith(seed: Record<string, unknown> = {}): Promise<PersistedStore> {
  const s = new PersistedStore(createMemoryPort(seed))
  await s.load()
  return s
}

describe('② audio/prefs · 静音偏好', () => {
  it('默认不静音（环境音是氛围的一部分）', async () => {
    const store = await storeWith()
    expect(AUDIO_MUTED_DEFAULT).toBe(false)
    expect(loadAudioMuted(store)).toBe(false)
  })

  it('写入可读回；写回 false 恢复', async () => {
    const store = await storeWith()
    saveAudioMuted(store, true)
    expect(store.get(PERSIST_KEYS.audioMuted, false)).toBe(true)
    expect(loadAudioMuted(store)).toBe(true)
    saveAudioMuted(store, false)
    expect(loadAudioMuted(store)).toBe(false)
  })

  it('脏数据（非布尔）兜底成默认 —— 不猜', async () => {
    const store = await storeWith({ [PERSIST_KEYS.audioMuted]: 'yes' })
    expect(loadAudioMuted(store)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ src/audio · 播放器（假 Audio 桩）
// ───────────────────────────────────────────────────────────────────────────

function withAmbient(on: boolean): XiaobuConfig {
  return {
    ...BUILT_IN_CONFIG,
    features: { ...BUILT_IN_CONFIG.features, ambientAudio: { enabled: on } },
  } as XiaobuConfig
}

const DUSK = new Date(2026, 2, 19, 18, 30) // spring · dusk

describe('③ audio · 播放器', () => {
  beforeEach(() => {
    FakeAudio.instances = []
    __test_resetAmbientAudio()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setAmbientMuted(false)
    __test_resetAmbientAudio()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
    FakeAudio.instances = []
  })

  it('按季节时段选轨、设音量并尝试播放', () => {
    vi.stubGlobal('Audio', FakeAudio)
    syncAmbientAudio(DUSK)
    expect(ambientPlanNow()?.trackId).toBe('spring-dusk')
    const el = FakeAudio.instances[0]
    expect(el).toBeTruthy()
    expect(el.src).toContain('spring-dusk.ogg')
    expect(el.volume).toBeCloseTo(0.26)
    expect(el.play).toHaveBeenCalled()
  })

  it('静音 ⇒ 暂停并置 muted；取消静音 ⇒ 再尝试播放', () => {
    vi.stubGlobal('Audio', FakeAudio)
    syncAmbientAudio(DUSK)
    const el = FakeAudio.instances[0]
    setAmbientMuted(true)
    expect(isAmbientMuted()).toBe(true)
    expect(el.muted).toBe(true)
    expect(el.pause).toHaveBeenCalled()
    setAmbientMuted(false)
    expect(el.muted).toBe(false)
    expect(el.play).toHaveBeenCalledTimes(2)
  })

  it('开关关闭 ⇒ 不建元素、不出声', () => {
    vi.stubGlobal('Audio', FakeAudio)
    applyConfig(withAmbient(false))
    expect(isAmbientOn()).toBe(false)
    syncAmbientAudio(DUSK)
    expect(FakeAudio.instances.length).toBe(0)
  })

  it('拿不到 Audio 构造器 ⇒ 静默跳过（不抛）', () => {
    // node 默认没有 Audio；不 stub，直接调，应当只是不出声
    expect(() => syncAmbientAudio(DUSK)).not.toThrow()
    expect(ambientPlanNow()?.trackId).toBe('spring-dusk')
  })

  it('installAmbientAudio 幂等、不阻塞首帧（不 await）', () => {
    vi.stubGlobal('Audio', FakeAudio)
    installAmbientAudio()
    installAmbientAudio() // 第二次应幂等：不再重复 sync
    expect(ambientPlanNow()).not.toBeNull()
    // 幂等的可观察后果：只建了一个元素
    expect(FakeAudio.instances.length).toBeLessThanOrEqual(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ store/audio · 投影 + 写回持久化
// ───────────────────────────────────────────────────────────────────────────

describe('④ store/audio · 投影与写回', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetEngineHost()
    __test_resetAmbientAudio()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  })

  afterEach(() => {
    resetEngineHost()
    __test_resetAmbientAudio()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  })

  it('start：从引擎读默认（不静音）、标记 ready、幂等', () => {
    const s = useAudioStore()
    s.start()
    expect(s.muted).toBe(false)
    expect(s.ready).toBe(true)
    s.start() // 幂等
    expect(s.ready).toBe(true)
  })

  it('setMuted：立即生效并写回引擎持久化', () => {
    const s = useAudioStore()
    s.setMuted(true)
    expect(s.muted).toBe(true)
    expect(isAmbientMuted()).toBe(true)
    expect(getEngine().getAudioMuted()).toBe(true)
  })

  it('toggle：在静音 / 取消静音间翻转，且持久化同步', () => {
    const s = useAudioStore()
    s.toggle()
    expect(s.muted).toBe(true)
    expect(getEngine().getAudioMuted()).toBe(true)
    s.toggle()
    expect(s.muted).toBe(false)
    expect(getEngine().getAudioMuted()).toBe(false)
  })

  it('引擎里已存的静音偏好在 start 后被投影出来', () => {
    getEngine().setAudioMuted(true)
    const s = useAudioStore()
    s.start()
    expect(s.muted).toBe(true)
  })
})
