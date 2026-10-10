/**
 * 小卜 · 语音输入   tests/voice.spec.ts
 * ===========================================================================
 * 五块被测物：
 *   ① voice.ts     —— 归一化 / 可用判据 / 按住时长阈值（纯函数）
 *   ② consent.ts   —— 音频出端同意默认 off、读写往返、脏数据兜底
 *   ③ payload.ts   —— 逐字段出端、白名单序列化、时长归一
 *   ④ asr.ts       —— 四道闸门 + 回落"没听清"（永不抛）
 *   ⑤ ui/voiceInput.ts —— 一次「按住说话」的完整编排与容错
 *
 * ★ 麦克风那一段（voiceRecorder）在 ⑤ 里被整体替换成 mock：
 *   它有真实 DOM / MediaRecorder 依赖，node 里跑不了；被替换掉的只是"采集"，
 *   而"听到了什么"仍走真实的 ui/voiceInput + 真实的 asr（fetch 打桩）。
 * ===========================================================================
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  VOICE_TEXT_MAX_CHARS,
  VOICE_MIN_HOLD_MS,
  normalizeVoiceText,
  isVoiceTextUsable,
  isHoldLongEnough,
} from '@core/voice/voice'
import { VOICE_CONSENT_DEFAULT, loadVoiceConsent, saveVoiceConsent } from '@core/voice/consent'
import { VOICE_NETWORK_FIELDS, buildVoicePayload, serializeVoicePayload } from '@core/voice/payload'
import { PERSIST_KEYS, PersistedStore, createMemoryPort } from '@core/persist'
import { requestSpeechText, parseAsr, isAsrEnabled, __test_resetAsr } from '@services/asr'
import { applyConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'
import { resetEngineHost } from '@store/engineHost'
import { useVoiceInputStore } from '@store/voiceInput'
import {
  startVoice,
  finishVoice,
  setVoiceConsent,
  __test_resetVoiceInput,
} from '@ui/voiceInput'
import { __test_resetTrack } from '@services/track'
import * as recorder from '@services/voiceRecorder'

// 麦克风采集层整体替换（只替换"采集"，识别仍走真实 asr）
vi.mock('@services/voiceRecorder', () => ({
  isVoiceRecordingSupported: vi.fn(() => true),
  startVoiceCapture: vi.fn(async () => true),
  finishVoiceCapture: vi.fn(async () => ({
    dataBase64: 'ZmFrZQ==',
    format: 'audio/webm',
    durationMs: 900,
  })),
  __test_resetVoiceRecorder: vi.fn(),
}))

// ───────────────────────────────────────────────────────────────────────────
// ① voice.ts
// ───────────────────────────────────────────────────────────────────────────

describe('① voice · 归一化与判据', () => {
  it('折叠连续空白（含全角空格）为单个半角空格并去首尾', () => {
    expect(normalizeVoiceText('  今天  很累 ')).toBe('今天 很累')
    expect(normalizeVoiceText('今天\u3000\u3000好累')).toBe('今天 好累')
    expect(normalizeVoiceText('\n\t今天\n')).toBe('今天')
  })

  it('超长按上限截断', () => {
    const long = '啊'.repeat(VOICE_TEXT_MAX_CHARS + 50)
    expect(normalizeVoiceText(long).length).toBe(VOICE_TEXT_MAX_CHARS)
  })

  it('脏输入永不抛，退化成空串', () => {
    expect(normalizeVoiceText(undefined)).toBe('')
    expect(normalizeVoiceText(null)).toBe('')
    expect(normalizeVoiceText(123 as unknown)).toBe('123')
  })

  it('isVoiceTextUsable：只有归一化后非空才算可用', () => {
    expect(isVoiceTextUsable('嗯')).toBe(true)
    expect(isVoiceTextUsable('   ')).toBe(false)
    expect(isVoiceTextUsable('')).toBe(false)
    expect(isVoiceTextUsable(null)).toBe(false)
  })

  it('isHoldLongEnough：非有限数一律算不够', () => {
    expect(isHoldLongEnough(VOICE_MIN_HOLD_MS)).toBe(true)
    expect(isHoldLongEnough(VOICE_MIN_HOLD_MS - 1)).toBe(false)
    expect(isHoldLongEnough(NaN)).toBe(false)
    expect(isHoldLongEnough(Infinity)).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② consent.ts
// ───────────────────────────────────────────────────────────────────────────

async function storeWith(seed: Record<string, unknown> = {}): Promise<PersistedStore> {
  const s = new PersistedStore(createMemoryPort(seed))
  await s.load()
  return s
}

describe('② consent · 音频出端同意', () => {
  it('默认 off（没对音频点头就永不出端）', async () => {
    const store = await storeWith()
    expect(VOICE_CONSENT_DEFAULT).toBe('off')
    expect(loadVoiceConsent(store)).toBe('off')
  })

  it('写入 on 可读回 on；写回 off 恢复 off', async () => {
    const store = await storeWith()
    saveVoiceConsent(store, 'on')
    expect(store.get(PERSIST_KEYS.voiceConsent, 'off')).toBe('on')
    expect(loadVoiceConsent(store)).toBe('on')
    saveVoiceConsent(store, 'off')
    expect(loadVoiceConsent(store)).toBe('off')
  })

  it('脏数据（非 on/off）兜底成 off —— 隐私兜底方向只能更保守', async () => {
    const store = await storeWith({ [PERSIST_KEYS.voiceConsent]: 'yes' })
    expect(loadVoiceConsent(store)).toBe('off')
  })

  it('与共情同意各管各的（键不共用）', async () => {
    const store = await storeWith({ [PERSIST_KEYS.empathyConsent]: 'on' })
    expect(loadVoiceConsent(store)).toBe('off')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ payload.ts
// ───────────────────────────────────────────────────────────────────────────

describe('③ payload · 出端载荷', () => {
  it('逐字段构造：只含白名单三字段', () => {
    const p = buildVoicePayload({ audio: 'AAA', format: 'audio/webm', durationMs: 900 })
    expect(Object.keys(p).sort()).toEqual([...VOICE_NETWORK_FIELDS].sort())
    expect(p.audio).toBe('AAA')
    expect(p.format).toBe('audio/webm')
    expect(p.durationMs).toBe(900)
  })

  it('时长归一（负数 / 小数 / NaN → 非负整数）', () => {
    expect(buildVoicePayload({ durationMs: -5 }).durationMs).toBe(0)
    expect(buildVoicePayload({ durationMs: 12.9 }).durationMs).toBe(12)
    expect(buildVoicePayload({ durationMs: NaN }).durationMs).toBe(0)
  })

  it('缺省输入退化为空音频 / 空格式 / 0 时长', () => {
    expect(buildVoicePayload({})).toEqual({ audio: '', format: '', durationMs: 0 })
  })

  it('serialize 只出白名单字段，不混入额外键', () => {
    const p = buildVoicePayload({ audio: 'AAA', format: 'raw', durationMs: 1 })
    const obj = JSON.parse(serializeVoicePayload(p)) as Record<string, unknown>
    expect(Object.keys(obj).sort()).toEqual([...VOICE_NETWORK_FIELDS].sort())
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ asr.ts（四道闸门 + 回落"没听清"）
// ───────────────────────────────────────────────────────────────────────────

/** 造一份只改 voiceInput 开关的配置 */
function withVoice(on: boolean, quota?: number): XiaobuConfig {
  return {
    ...BUILT_IN_CONFIG,
    features: { ...BUILT_IN_CONFIG.features, voiceInput: { enabled: on } },
    quota: { ...BUILT_IN_CONFIG.quota, ...(quota === undefined ? {} : { llmDailyFreePerUser: quota }) },
  } as XiaobuConfig
}

function capturingFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: typeof fetch; getBody: () => string; calls: () => number } {
  let last = ''
  let n = 0
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    n++
    last = typeof init?.body === 'string' ? init.body : ''
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body }
  }) as unknown as typeof fetch
  return { fetchImpl, getBody: () => last, calls: () => n }
}

const abortingFetch: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
  })

const badJsonFetch: typeof fetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new Error('bad json')
  },
})) as unknown as typeof fetch

const CLIP = { audio: 'ZmFrZQ==', format: 'audio/webm', durationMs: 900 }

afterEach(() => {
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  __test_resetAsr()
  __test_resetTrack()
})

describe('④ asr · 四道闸门', () => {
  it('开关关闭 ⇒ 不发请求，直接回落 null', async () => {
    applyConfig(withVoice(false))
    const f = capturingFetch({ text: '嗯' })
    expect(isAsrEnabled()).toBe(false)
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('全局停用（disableLlm）⇒ 不发请求', async () => {
    applyConfig({
      ...withVoice(true),
      killSwitch: { ...BUILT_IN_CONFIG.killSwitch, disableLlm: true },
    } as XiaobuConfig)
    const f = capturingFetch({ text: '嗯' })
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('空音频 ⇒ 不出端（零调用）', async () => {
    applyConfig(withVoice(true))
    const f = capturingFetch({ text: '嗯' })
    expect(await requestSpeechText({ ...CLIP, audio: '   ' }, { fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('成功 ⇒ 返回归一化文本，且出端只含白名单三字段', async () => {
    applyConfig(withVoice(true))
    const f = capturingFetch({ text: '  今天  好累 ', cents: 1 })
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBe('今天 好累')
    const obj = JSON.parse(f.getBody()) as Record<string, unknown>
    expect(Object.keys(obj).sort()).toEqual([...VOICE_NETWORK_FIELDS].sort())
    expect(obj.format).toBe('audio/webm')
  })

  it('空 / 纯空白文本 ⇒ null（服务端也没听清）', async () => {
    applyConfig(withVoice(true))
    const f = capturingFetch({ text: '   ' })
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBeNull()
  })

  it('超时 ⇒ null', async () => {
    applyConfig(withVoice(true))
    expect(await requestSpeechText(CLIP, { fetchImpl: abortingFetch, timeoutMs: 5 })).toBeNull()
  })

  it('非 2xx ⇒ null', async () => {
    applyConfig(withVoice(true))
    const f = capturingFetch({ text: '嗯' }, { ok: false, status: 500 })
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBeNull()
  })

  it('脏 JSON ⇒ null', async () => {
    applyConfig(withVoice(true))
    expect(await requestSpeechText(CLIP, { fetchImpl: badJsonFetch })).toBeNull()
  })

  it('网络抛错 ⇒ null 且不冒泡', async () => {
    applyConfig(withVoice(true))
    const boom = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(requestSpeechText(CLIP, { fetchImpl: boom })).resolves.toBeNull()
  })

  it('额度用尽 ⇒ 第二次不再出端', async () => {
    applyConfig(withVoice(true, 1))
    const f = capturingFetch({ text: '嗯', cents: 1 })
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBe('嗯')
    expect(f.calls()).toBe(1)
    expect(await requestSpeechText(CLIP, { fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(1)
  })
})

describe('④ parseAsr · 结构校验', () => {
  it('非对象 / 空文本 ⇒ null', () => {
    expect(parseAsr(null)).toBeNull()
    expect(parseAsr('x')).toBeNull()
    expect(parseAsr({ text: '' })).toBeNull()
    expect(parseAsr({ text: '  ' })).toBeNull()
  })

  it('合法文本归一化后返回', () => {
    expect(parseAsr({ text: '  你好  呀 ' })).toBe('你好 呀')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ⑤ ui/voiceInput.ts（编排与容错）
// ───────────────────────────────────────────────────────────────────────────

describe('⑤ voiceInput · 编排与容错', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'))
    setActivePinia(createPinia())
    __test_resetVoiceInput()
    __test_resetAsr()
    __test_resetTrack()
    resetEngineHost()
    applyConfig(withVoice(true))
    vi.mocked(recorder.isVoiceRecordingSupported).mockReturnValue(true)
    vi.mocked(recorder.startVoiceCapture).mockResolvedValue(true)
    vi.mocked(recorder.finishVoiceCapture).mockResolvedValue({
      dataBase64: 'ZmFrZQ==',
      format: 'audio/webm',
      durationMs: 900,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.mocked(recorder.startVoiceCapture).mockClear()
    vi.mocked(recorder.finishVoiceCapture).mockClear()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  })

  it('未同意 ⇒ 不碰麦克风、零请求（隐私关键断言）', async () => {
    const f = capturingFetch({ text: '不该出现' })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useVoiceInputStore()

    startVoice()
    expect(s.held).toBe(true)
    expect(s.consent).toBe('off')
    expect(recorder.startVoiceCapture).not.toHaveBeenCalled()

    await finishVoice()
    expect(f.calls()).toBe(0)
    expect(s.heard).toBe('')
  })

  it('已同意但设备不支持 ⇒ 柔和提示、不录', async () => {
    vi.mocked(recorder.isVoiceRecordingSupported).mockReturnValue(false)
    const s = useVoiceInputStore()
    setVoiceConsent('on')

    startVoice()
    expect(s.recording).toBe(false)
    expect(s.hint.length).toBeGreaterThan(0)
    expect(recorder.startVoiceCapture).not.toHaveBeenCalled()
  })

  it('已同意 + 按住太短 ⇒ 释放麦克风、不请求、提示再按久一点', async () => {
    const f = capturingFetch({ text: 'x' })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useVoiceInputStore()
    setVoiceConsent('on')

    startVoice()
    vi.advanceTimersByTime(VOICE_MIN_HOLD_MS - 100)
    await finishVoice()

    expect(f.calls()).toBe(0)
    expect(recorder.finishVoiceCapture).toHaveBeenCalled() // 麦克风仍要收掉
    expect(s.hint).toContain('久')
  })

  it('已同意 + 云端成功 ⇒ 写入 heard、复位 busy', async () => {
    const f = capturingFetch({ text: '  今天   好累 ' })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useVoiceInputStore()
    setVoiceConsent('on')

    startVoice()
    vi.advanceTimersByTime(500)
    await finishVoice()

    expect(f.calls()).toBe(1)
    expect(s.heard).toBe('今天 好累')
    expect(s.busy).toBe(false)
  })

  it('已同意 + 云端空结果（没听清）⇒ heard 空、给柔和提示', async () => {
    const f = capturingFetch({ text: '' })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useVoiceInputStore()
    setVoiceConsent('on')

    startVoice()
    vi.advanceTimersByTime(500)
    await finishVoice()

    expect(s.heard).toBe('')
    expect(s.hint.length).toBeGreaterThan(0)
  })
})
