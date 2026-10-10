/**
 * 远端配置拉取   tests/remote-config.spec.ts
 * ===========================================================================
 * D9 落点验证：
 *   · fetchRemoteConfig 超时 / 非法 JSON / 越界 schemaVersion 一律 throw
 *     （交给 loadRemoteConfig 走四层兜底静默降级）
 *   · loadRemoteConfig 成功 → 应用 + 写缓存；失败 → 静默保持现状、绝不向上抛
 *   · 四层兜底的终态：仍是能玩的黄昏小屋（内置默认）
 * ===========================================================================
 */
import { describe, expect, it, afterEach } from 'vitest'
import { fetchRemoteConfig, loadRemoteConfig, RemoteConfigError } from '@bootstrap/remoteConfig'
import { applyConfig, currentConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'

/** 造一个满足 `typeof fetch` 的桩，返回给定 body */
function makeFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}): typeof fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) =>
    ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => body,
    }) as unknown as Response
}

/** 永不 resolve，只在 signal abort 时 reject —— 用来打超时路径 */
const abortingFetch: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
  })

/** 深拷贝内置默认并覆盖某个字段，得到一份「合法远端配置」 */
function fullRemote(overrides: Partial<XiaobuConfig>): unknown {
  const base = JSON.parse(JSON.stringify(BUILT_IN_CONFIG)) as XiaobuConfig
  return { ...base, ...overrides }
}

afterEach(() => {
  // 还原为内置默认，避免污染后续用例
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
})

describe('fetchRemoteConfig · 成功路径', () => {
  it('合法配置通过校验，并合并进内置默认（远端给完整配置）', async () => {
    const remote = fullRemote({ quota: { llmDailyFreePerUser: 99, llmGlobalDailyCircuit: 20000 } })
    const got = await fetchRemoteConfig({ fetchImpl: makeFetch(remote) })
    expect(got.schemaVersion).toBe(3)
    expect(got.quota.llmDailyFreePerUser).toBe(99)
    // 未覆盖的字段仍来自内置默认
    expect(got.features.weather.enabled).toBe(true)
    expect(got.assets.cdnBase).toContain('cdn.example.com')
  })
})

describe('fetchRemoteConfig · 失败一律 throw', () => {
  it('HTTP 非 2xx → RemoteConfigError', async () => {
    await expect(
      fetchRemoteConfig({ fetchImpl: makeFetch({}, { ok: false, status: 503 }) }),
    ).rejects.toBeInstanceOf(RemoteConfigError)
  })

  it('响应体非法 JSON → RemoteConfigError', async () => {
    const bad = async () => ({ ok: true, json: async () => { throw new Error('boom') } })
    await expect(fetchRemoteConfig({ fetchImpl: bad as unknown as typeof fetch })).rejects.toBeInstanceOf(
      RemoteConfigError,
    )
  })

  it('schemaVersion 越界 → 整份丢弃（RemoteConfigError）', async () => {
    await expect(
      fetchRemoteConfig({ fetchImpl: makeFetch({ schemaVersion: 999 }) }),
    ).rejects.toBeInstanceOf(RemoteConfigError)
  })

  it('超时（AbortController 触发）→ RemoteConfigError', async () => {
    await expect(
      fetchRemoteConfig({ fetchImpl: abortingFetch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RemoteConfigError)
  })
})

describe('loadRemoteConfig · 四层兜底', () => {
  it('成功 → 应用远端配置到生效态（且写缓存镜像）', async () => {
    const remote = fullRemote({ quota: { llmDailyFreePerUser: 77, llmGlobalDailyCircuit: 20000 } })
    await loadRemoteConfig({ fetchImpl: makeFetch(remote) })
    expect(currentConfig().quota.llmDailyFreePerUser).toBe(77)
  })

  it('网络抛错 → 静默降级，生效态保持内置默认、绝不向上抛', async () => {
    const broken = async () => {
      throw new Error('network down')
    }
    expect(currentConfig().quota.llmDailyFreePerUser).toBe(20)
    await expect(loadRemoteConfig({ fetchImpl: broken as unknown as typeof fetch })).resolves.toBeUndefined()
    expect(currentConfig().quota.llmDailyFreePerUser).toBe(20)
  })

  it('坏状态也不抛，保持现状', async () => {
    await expect(
      loadRemoteConfig({ fetchImpl: makeFetch({}, { ok: false, status: 500 }) }),
    ).resolves.toBeUndefined()
    expect(currentConfig().quota.llmDailyFreePerUser).toBe(20)
  })
})
