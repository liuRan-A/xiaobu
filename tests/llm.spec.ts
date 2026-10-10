/**
 * 小卜 · 云端解读客户端   tests/llm.spec.ts
 * ===========================================================================
 * 第 3 步「接云端 AI」的验证点：
 *   · 出端载荷**只有白名单**（kind / dims / structure），用户原话永不出端
 *   · 三道闸门（killSwitch.disableLlm / 成本熔断 / 每用户日额度）任一不过 ⇒ 不发请求
 *   · 任何失败（超时 / 非 2xx / 非法 JSON / 结构不合格 / 命中禁词）⇒ 返回 null
 *   · 成功 ⇒ 返回与本地同形的结构化文案，并计额度 + 打点 + 记成本
 * ★ 这里最重要的是"失败返回 null"这条：调用方据此回落本地模板，断网永远可玩。
 * ===========================================================================
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  requestCloudReading,
  parseCloudReading,
  isLlmEnabled,
  __test_resetLlm,
} from '@services/llm'
import { applyConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'
import {
  __test_resetTrack,
  flushTrack,
  recordLlmCost,
  setTrackTransport,
  type TrackEvent,
} from '@services/track'
import type { ReadingRequest } from '@core/reading'

// ───────────────────────────────────────────────────────────────────────────

/** 带本地原话的请求 —— 用来证明 localOnly 不会出现在出端载荷里 */
function request(): ReadingRequest {
  return {
    kind: 'liuyao',
    dims: { mood: 'ANXIOUS', focus: 'CAREER' },
    structure: 'hexagram',
    localOnly: { question: '我该不该辞职' },
  }
}

/** 结构合法的云端返回（与本地 ReadingCopy 同形） */
function goodBody(): unknown {
  return {
    title: '第 11 卦 · 泰',
    subtitle: '顺畅里的舒展',
    sections: [{ label: '关于工作上的事', body: '慢慢来，先看脚下这一段。' }],
    summary: '卦只是个由头。',
    moodLabel: '心里悬着',
    cents: 3,
  }
}

/** 造一个捕获请求体的 fetch 桩 */
function capturingFetch(
  body: unknown,
  opts: { ok?: boolean; status?: number } = {},
): { fetchImpl: typeof fetch; getBody: () => string } {
  let last = ''
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    last = typeof init?.body === 'string' ? init.body : ''
    return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body }
  }) as unknown as typeof fetch
  return { fetchImpl, getBody: () => last }
}

/** 永不 resolve，只在 signal abort 时 reject —— 打超时路径 */
const abortingFetch: typeof fetch = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener?.('abort', () => reject(new Error('aborted')))
  })

/** 造一份改过字段的配置（不改冻结点，只在新对象上覆盖） */
function withConfig(patch: Partial<XiaobuConfig>): XiaobuConfig {
  return { ...BUILT_IN_CONFIG, ...patch } as XiaobuConfig
}

afterEach(() => {
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  __test_resetLlm()
  __test_resetTrack()
  setTrackTransport(null)
})

// ───────────────────────────────────────────────────────────────────────────

describe('出端载荷 · 隐私', () => {
  it('只发白名单字段，用户原话（localOnly）不出端', async () => {
    const { fetchImpl, getBody } = capturingFetch(goodBody())
    await requestCloudReading(request(), { fetchImpl })

    const sent = JSON.parse(getBody()) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual(['dims', 'kind', 'structure'])
    expect(getBody()).not.toContain('辞职')
    expect(sent.kind).toBe('liuyao')
    expect(sent.structure).toBe('hexagram')
  })
})

describe('三道闸门 · 不过就不发请求', () => {
  it('killSwitch.disableLlm = true ⇒ 直接 null，且不调用 fetch', async () => {
    applyConfig(withConfig({ killSwitch: { ...BUILT_IN_CONFIG.killSwitch, disableLlm: true } }))
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return { ok: true, status: 200, json: async () => goodBody() }
    }) as unknown as typeof fetch

    expect(isLlmEnabled()).toBe(false)
    await expect(requestCloudReading(request(), { fetchImpl })).resolves.toBeNull()
    expect(called).toBe(0)
  })

  it('成本熔断 ⇒ null，且不调用 fetch', async () => {
    applyConfig(withConfig({ quota: { llmDailyFreePerUser: 20, llmGlobalDailyCircuit: 1 } }))
    recordLlmCost(5) // 超过全局上限 → 熔断
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return { ok: true, status: 200, json: async () => goodBody() }
    }) as unknown as typeof fetch

    expect(isLlmEnabled()).toBe(false)
    await expect(requestCloudReading(request(), { fetchImpl })).resolves.toBeNull()
    expect(called).toBe(0)
  })

  it('每用户日额度用尽 ⇒ 第二次不再发请求；跨天自动归零', async () => {
    applyConfig(withConfig({ quota: { llmDailyFreePerUser: 1, llmGlobalDailyCircuit: 20000 } }))
    const { fetchImpl, getBody } = capturingFetch(goodBody())

    const day1 = new Date(2026, 0, 5, 10, 0, 0).getTime()
    const day2 = new Date(2026, 0, 6, 10, 0, 0).getTime()

    const first = await requestCloudReading(request(), { fetchImpl, now: () => day1 })
    expect(first).not.toBeNull()

    // 同日第二次：额度已用尽 → null（fetch 不再被调用，载荷保持上一次）
    const before = getBody()
    const second = await requestCloudReading(request(), { fetchImpl, now: () => day1 })
    expect(second).toBeNull()
    expect(getBody()).toBe(before)

    // 跨天：额度归零，重新可用
    const third = await requestCloudReading(request(), { fetchImpl, now: () => day2 })
    expect(third).not.toBeNull()
  })
})

describe('失败一律回落本地（返回 null）', () => {
  it('超时（AbortController 触发）⇒ null', async () => {
    await expect(
      requestCloudReading(request(), { fetchImpl: abortingFetch, timeoutMs: 10 }),
    ).resolves.toBeNull()
  })

  it('非 2xx ⇒ null', async () => {
    const { fetchImpl } = capturingFetch({}, { ok: false, status: 503 })
    await expect(requestCloudReading(request(), { fetchImpl })).resolves.toBeNull()
  })

  it('响应体非法 JSON ⇒ null', async () => {
    const bad = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('boom')
      },
    })) as unknown as typeof fetch
    await expect(requestCloudReading(request(), { fetchImpl: bad })).resolves.toBeNull()
  })

  it('网络抛错 ⇒ null（且不冒泡）', async () => {
    const broken = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(requestCloudReading(request(), { fetchImpl: broken })).resolves.toBeNull()
  })
})

describe('parseCloudReading · 结构与语气', () => {
  it('补齐缺省字段并透出 cents', () => {
    const parsed = parseCloudReading(goodBody())
    expect(parsed?.copy.title).toContain('泰')
    expect(parsed?.copy.sections[0].label).toBe('关于工作上的事')
    expect(parsed?.cents).toBe(3)
  })

  it('title / subtitle 可缺省（由调用方沿用本地标题），但 sections 必须合格', () => {
    const bare = parseCloudReading({ sections: [{ label: '今日', body: '慢慢来。' }] })
    expect(bare).not.toBeNull()
    expect(bare?.copy.title).toBe('')
    expect(bare?.copy.subtitle).toBe('')
  })

  it('sections 为空 / 段落缺正文 / 非对象 ⇒ null', () => {
    expect(parseCloudReading({ title: 't', sections: [] })).toBeNull()
    expect(parseCloudReading({ title: 't', sections: [{ label: 'a', body: '' }] })).toBeNull()
    expect(parseCloudReading({ title: 't', sections: [{ label: '', body: 'b' }] })).toBeNull()
    expect(parseCloudReading({ title: 't' })).toBeNull()
    expect(parseCloudReading(null)).toBeNull()
  })

  it('命中禁词 ⇒ null（宁可回落本地合规文案）', () => {
    const bad = { ...(goodBody() as Record<string, unknown>), title: '今日吉' }
    expect(parseCloudReading(bad)).toBeNull()
  })
})

describe('成功路径 · 计额度 + 打点 + 记成本', () => {
  it('返回结构化文案并上报 API_CALL', async () => {
    const events: TrackEvent[] = []
    setTrackTransport((evs) => events.push(...evs))
    const { fetchImpl } = capturingFetch(goodBody())

    const copy = await requestCloudReading(request(), { fetchImpl })
    expect(copy?.title).toContain('泰')
    expect(copy?.summary).toBe('卦只是个由头。')
    expect(copy?.moodLabel).toBe('心里悬着')

    // 埋点是内存缓冲，要 flush 才会送达传输器
    flushTrack()
    expect(events.some((e) => e.name === 'API_CALL' && e.scope === 'READING')).toBe(true)
    // cents=3 也计入成本熔断
    expect(events.some((e) => e.name === 'LLM_COST')).toBe(false) // 未超阈值不上报
  })
})
