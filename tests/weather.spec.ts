/**
 * 小卜 · 天气模块   tests/weather.spec.ts
 * ===========================================================================
 * 四块被测物（自下而上，各管一段）：
 *   ① @weather      —— 纯函数：归一化 / 解析 / 新鲜度 / 短签（node 里直接跑）
 *   ② services/weather —— 两道闸门 + 永不抛 + 只在成功时记一次接口调用
 *   ③ store/weather —— 反应式投影：apply / refresh / visible / stale
 *   ④ scene/ambience —— kind → 氛围数值；unknown 必须**逐字等于出厂值**（不跳变）
 *
 * ★ 核心断言（写在最显眼处）：天气拿不到时，画面氛围与 L8/L9 出厂常量**逐字一致**。
 *   这是"断网 / 关停天气时画面不跳一下"的可证明落点。
 * ===========================================================================
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  WEATHER_KINDS,
  WEATHER_LABEL,
  clamp01,
  normalizeWeatherKind,
  parseWeatherPayload,
  weatherAgeMs,
  weatherFreshness,
  type WeatherSnapshot,
} from '@weather'
import { isWeatherEnabled, requestWeatherSnapshot } from '@services/weather'
import { useWeatherStore } from '@store/weather'
import { NEUTRAL_AMBIENCE, ambienceForKind, applyAmbience } from '@scene/ambience'
import { createSceneStack, getGrade, getVeilOpacity } from '@scene/layers'
import { applyConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'
import { __test_resetTrack, flushTrack, setTrackTransport, type TrackEvent } from '@services/track'

// ───────────────────────────────────────────────────────────────────────────
// ① @weather · 纯函数
// ───────────────────────────────────────────────────────────────────────────

describe('① @weather · 归一化与解析', () => {
  it('normalizeWeatherKind：只认五档，其余一律 unknown', () => {
    for (const k of WEATHER_KINDS) expect(normalizeWeatherKind(k)).toBe(k)
    expect(normalizeWeatherKind('sunny')).toBe('unknown')
    expect(normalizeWeatherKind(undefined)).toBe('unknown')
    expect(normalizeWeatherKind(123)).toBe('unknown')
  })

  it('clamp01：夹到 [0,1]，非有限数退回 fallback', () => {
    expect(clamp01(0.42)).toBe(0.42)
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(9)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0.5)
    expect(clamp01('x', 0.7)).toBe(0.7)
  })

  it('parseWeatherPayload：非对象 / 缺 kind ⇒ null', () => {
    expect(parseWeatherPayload(null, 1)).toBeNull()
    expect(parseWeatherPayload('x', 1)).toBeNull()
    expect(parseWeatherPayload({ tempC: 20 }, 1)).toBeNull()
  })

  it('parseWeatherPayload：kind=unknown 是**合法**快照（后端明确说拿不到）', () => {
    const s = parseWeatherPayload({ kind: 'unknown', degraded: 2 }, 1000)
    expect(s).not.toBeNull()
    expect(s?.kind).toBe('unknown')
    expect(s?.degraded).toBe(2)
    expect(s?.updatedAt).toBe(1000) // 没给 updatedAt ⇒ 用收到时刻
  })

  it('parseWeatherPayload：温度取整、亮度夹取、降级码收敛', () => {
    const s = parseWeatherPayload(
      { kind: 'rain', tempC: '18.6', brightness: 1.7, degraded: 9, updatedAt: 5 },
      999,
    )
    expect(s).toEqual<WeatherSnapshot>({
      kind: 'rain',
      tempC: 19,
      brightness: 1,
      degraded: 0, // 非法降级码收敛成 0
      updatedAt: 5,
    })
  })

  it('weatherAgeMs 恒非负（时钟回拨也不为负）', () => {
    const s = parseWeatherPayload({ kind: 'clear', updatedAt: 5000 }, 5000)!
    expect(weatherAgeMs(s, 5000)).toBe(0)
    expect(weatherAgeMs(s, 5000 + 123)).toBe(123)
    expect(weatherAgeMs(s, 1000)).toBe(0)
  })

  it('weatherFreshness：fresh / stale / expired 三档按 TTL 划', () => {
    const s = parseWeatherPayload({ kind: 'clear', updatedAt: 0 }, 0)!
    expect(weatherFreshness(s, 10 * 60_000, 30, 6)).toBe('fresh') // 10 分钟内
    expect(weatherFreshness(s, 60 * 60_000, 30, 6)).toBe('stale') // 1 小时
    expect(weatherFreshness(s, 7 * 3_600_000, 30, 6)).toBe('expired') // 7 小时
  })

  it('WEATHER_LABEL：unknown 不吐任何字（宁可不提，也不说错天气）', () => {
    expect(WEATHER_LABEL.unknown).toBe('')
    expect(WEATHER_LABEL.rain).toBe('外面在下雨')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② services/weather · 两道闸门 + 永不抛
// ───────────────────────────────────────────────────────────────────────────

function withWeather(
  enabled: boolean,
  kill = false,
): XiaobuConfig {
  return {
    ...BUILT_IN_CONFIG,
    features: { ...BUILT_IN_CONFIG.features, weather: { ...BUILT_IN_CONFIG.features.weather, enabled } },
    killSwitch: { ...BUILT_IN_CONFIG.killSwitch, disableWeather: kill },
  } as XiaobuConfig
}

function capturingFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0
  const fetchImpl = (async () => {
    n++
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body }
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => n }
}

const badJsonFetch: typeof fetch = (async () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new Error('bad json')
  },
})) as unknown as typeof fetch

const abortingFetch: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
  })

let tracked: TrackEvent[] = []

afterEach(() => {
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  __test_resetTrack()
  tracked = []
})

beforeEach(() => {
  __test_resetTrack()
  setTrackTransport((events) => {
    tracked.push(...events)
  })
})

describe('② services/weather · 闸门与回落', () => {
  it('开关关闭 ⇒ 不发请求，直接 null', async () => {
    applyConfig(withWeather(false))
    const f = capturingFetch({ kind: 'clear' })
    expect(isWeatherEnabled()).toBe(false)
    expect(await requestWeatherSnapshot({ fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('服务端一键停用 ⇒ 不发请求', async () => {
    applyConfig(withWeather(true, true))
    const f = capturingFetch({ kind: 'clear' })
    expect(isWeatherEnabled()).toBe(false)
    expect(await requestWeatherSnapshot({ fetchImpl: f.fetchImpl })).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('成功 ⇒ 返回快照，且记一次 WEATHER 接口调用', async () => {
    applyConfig(withWeather(true))
    const f = capturingFetch({ kind: 'rain', tempC: 18, degraded: 0, brightness: 0.35 })
    const snap = await requestWeatherSnapshot({ fetchImpl: f.fetchImpl, now: () => 777 })
    expect(snap?.kind).toBe('rain')
    expect(snap?.tempC).toBe(18)
    flushTrack() // 埋点在缓冲里攒批，落传输前先冲一次（同 llm.spec）
    expect(tracked.some((e) => e.name === 'API_CALL' && e.scope === 'WEATHER')).toBe(true)
  })

  it('非 2xx / 脏 JSON / 网络抛错 / 超时 ⇒ 全部 null（永不抛）', async () => {
    applyConfig(withWeather(true))
    const f500 = capturingFetch({ kind: 'clear' }, { ok: false, status: 500 })
    expect(await requestWeatherSnapshot({ fetchImpl: f500.fetchImpl })).toBeNull()
    expect(await requestWeatherSnapshot({ fetchImpl: badJsonFetch })).toBeNull()
    const boom = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(requestWeatherSnapshot({ fetchImpl: boom })).resolves.toBeNull()
    expect(await requestWeatherSnapshot({ fetchImpl: abortingFetch, timeoutMs: 5 })).toBeNull()
  })

  it('失败不计接口调用（只有成功才算）', async () => {
    applyConfig(withWeather(true))
    const f500 = capturingFetch({ kind: 'clear' }, { ok: false, status: 500 })
    await requestWeatherSnapshot({ fetchImpl: f500.fetchImpl })
    expect(tracked.length).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ store/weather · 反应式投影
// ───────────────────────────────────────────────────────────────────────────

describe('③ store/weather · 投影与新鲜度', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    applyConfig(withWeather(true))
  })

  it('apply：写入 kind / tempC，并按 TTL 记新鲜度', () => {
    const s = useWeatherStore()
    const snap: WeatherSnapshot = { kind: 'cloudy', tempC: 22, degraded: 0, brightness: 0.55, updatedAt: 1000 }
    s.apply(snap, 1000)
    expect(s.kind).toBe('cloudy')
    expect(s.tempText).toBe('22°')
    expect(s.state).toBe('fresh')
    expect(s.visible).toBe(true)
    expect(s.stale).toBe(false)
  })

  it('unknown ⇒ label 为空、visible 为假（什么都不提）', () => {
    const s = useWeatherStore()
    s.apply({ kind: 'unknown', tempC: null, degraded: 2, brightness: 0.5, updatedAt: 0 }, 0)
    expect(s.label).toBe('')
    expect(s.visible).toBe(false)
  })

  it('过期 ⇒ visible 为假（陈旧视同没有）', () => {
    const s = useWeatherStore()
    s.apply({ kind: 'clear', tempC: 20, degraded: 0, brightness: 0.8, updatedAt: 0 }, 0)
    // 7 小时后
    s.apply({ kind: 'clear', tempC: 20, degraded: 0, brightness: 0.8, updatedAt: 0 }, 7 * 3_600_000)
    expect(s.state).toBe('expired')
    expect(s.visible).toBe(false)
  })

  it('开关关闭 ⇒ refresh 不发请求，状态归 none', async () => {
    applyConfig(withWeather(false))
    const s = useWeatherStore()
    const f = capturingFetch({ kind: 'clear' })
    vi.stubGlobal('fetch', f.fetchImpl)
    await s.refresh(true)
    expect(f.calls()).toBe(0)
    expect(s.state).toBe('none')
    vi.unstubAllGlobals()
  })

  it('refresh：成功后 busy 复位、状态更新', async () => {
    const s = useWeatherStore()
    const f = capturingFetch({ kind: 'snow', tempC: -3, degraded: 0, brightness: 0.45 })
    vi.stubGlobal('fetch', f.fetchImpl)
    await s.refresh(true, 500)
    expect(s.kind).toBe('snow')
    expect(s.busy).toBe(false)
    vi.unstubAllGlobals()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ scene/ambience · kind → 氛围
// ───────────────────────────────────────────────────────────────────────────

describe('④ scene/ambience · 氛围映射', () => {
  it('unknown ⇒ 逐字等于出厂中性氛围（★断网不跳变）', () => {
    expect(ambienceForKind('unknown')).toEqual(NEUTRAL_AMBIENCE)
    expect(NEUTRAL_AMBIENCE).toEqual({ veilOpacity: 0.085, vignette: 0.26, bloom: 1 })
  })

  it('越阴沉 ⇒ 薄纱越浓、暗角越重、暖光越弱（单调）', () => {
    const clear = ambienceForKind('clear')
    const cloudy = ambienceForKind('cloudy')
    const rain = ambienceForKind('rain')
    expect(clear.veilOpacity).toBeLessThan(cloudy.veilOpacity)
    expect(cloudy.veilOpacity).toBeLessThan(rain.veilOpacity)
    expect(clear.bloom).toBeGreaterThan(cloudy.bloom)
    expect(cloudy.bloom).toBeGreaterThan(rain.bloom)
  })

  it('applyAmbience：写进 L8/L9，并且能在 clamp 内被读回', () => {
    const stack = createSceneStack()
    applyAmbience(ambienceForKind('rain'), stack)
    expect(getVeilOpacity()).toBeCloseTo(0.13, 5)
    expect(getGrade().vignette).toBeCloseTo(0.33, 5)
    // 还原，避免模块级状态泄漏给别的用例
    applyAmbience(NEUTRAL_AMBIENCE, stack)
    expect(getVeilOpacity()).toBeCloseTo(0.085, 5)
    expect(getGrade().vignette).toBeCloseTo(0.26, 5)
  })
})
