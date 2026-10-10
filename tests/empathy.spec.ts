/**
 * 小卜 · 共情对话（本地）   tests/empathy.spec.ts
 * ===========================================================================
 * 三块被测物，全部零 DOM / 零网络：
 *   ① empathy.ts  —— 意图归类、确定性选句、文案红线自检
 *   ② consent.ts  —— 云端同意默认 off、读写往返、脏数据兜底
 *   ③ payload.ts  —— 逐字段出端、截断、白名单序列化
 * ===========================================================================
 */
import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  EMPATHY_ALL_LINES,
  EMPATHY_BANNED,
  EMPATHY_INTENTS,
  EMPATHY_MAX_CHARS,
  EMPATHY_TEXT_MAX_CHARS,
  classifyEmpathy,
  isEmpathySafe,
  replyLocally,
  type EmpathyIntent,
} from '@core/empathy/empathy'
import { CLOUD_CONSENT_DEFAULT, loadConsent, saveConsent } from '@core/empathy/consent'
import {
  EMPATHY_NETWORK_FIELDS,
  buildEmpathyPayload,
  serializeEmpathyPayload,
} from '@core/empathy/payload'
import { FORBIDDEN_COPY, FORBIDDEN_STRUCTURE_WORDS } from '@core/guide/guide'
import { PERSIST_KEYS, PersistedStore, createMemoryPort } from '@core/persist'
import {
  requestCloudEmpathy,
  parseCloudEmpathy,
  isEmpathyCloudEnabled,
  __test_resetEmpathyCloud,
} from '@services/empathyCloud'
import { applyConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'
import {
  openEmpathy,
  closeEmpathy,
  sendEmpathy,
  __test_resetEmpathyChat,
} from '@ui/empathyChat'
import { useXiaobuFormStore } from '@store/xiaobuForm'
import { resetEngineHost } from '@store/engineHost'

// ───────────────────────────────────────────────────────────────────────────
// ① empathy.ts
// ───────────────────────────────────────────────────────────────────────────

describe('① empathy · 文案红线', () => {
  it('八种意图全部可达，且各自的回应都合格', () => {
    // 心情覆盖 6 种，文本归类补齐 greeting / question
    const reached = new Set<string>()
    const viaMood = ['CALM', 'TIRED', 'ANXIOUS', 'DOWN', 'HOPEFUL', 'RESTLESS'] as const
    for (const m of viaMood) reached.add(replyLocally({ text: '', mood: m, turn: 0 }).intent)
    reached.add(replyLocally({ text: '你好', mood: null, turn: 0 }).intent)
    reached.add(replyLocally({ text: '怎么办？', mood: null, turn: 0 }).intent)

    expect([...reached].sort()).toEqual([...EMPATHY_INTENTS].sort())
  })

  it('整张表：非空、≤34 字、四类禁词全不命中', () => {
    for (const line of EMPATHY_ALL_LINES) {
      expect(line.length, line).toBeGreaterThan(0)
      expect(line.length, line).toBeLessThanOrEqual(EMPATHY_MAX_CHARS)
      expect(line, line).not.toMatch(FORBIDDEN_COPY)
      expect(line, line).not.toMatch(FORBIDDEN_STRUCTURE_WORDS)
      expect(line, line).not.toMatch(EMPATHY_BANNED)
    }
  })

  it('isEmpathySafe：合格文案为真；空 / 超长 / 禁词为假', () => {
    expect(isEmpathySafe(EMPATHY_ALL_LINES[0])).toBe(true)
    expect(isEmpathySafe('')).toBe(false)
    expect(isEmpathySafe('   ')).toBe(false)
    expect(isEmpathySafe('好'.repeat(EMPATHY_MAX_CHARS + 1))).toBe(false)
    expect(isEmpathySafe('这卦吉')).toBe(false) // FORBIDDEN_COPY
    expect(isEmpathySafe('进入塔罗区看看')).toBe(false) // FORBIDDEN_STRUCTURE_WORDS
    expect(isEmpathySafe('抱歉，我建议你')).toBe(false) // EMPATHY_BANNED
  })
})

describe('① empathy · 意图归类', () => {
  it('关键词归类到对应意图', () => {
    expect(classifyEmpathy('今天好累啊')).toBe('tired')
    expect(classifyEmpathy('我好焦虑')).toBe('anxious')
    expect(classifyEmpathy('有点难过')).toBe('down')
    expect(classifyEmpathy('今天很开心')).toBe('hopeful')
    expect(classifyEmpathy('心里烦')).toBe('restless')
    expect(classifyEmpathy('你好')).toBe('greeting')
    expect(classifyEmpathy('我该怎么办？')).toBe('question')
  })

  it('情绪优先于问句：带问号的焦虑仍归 anxious', () => {
    expect(classifyEmpathy('我为什么会这么焦虑？')).toBe('anxious')
  })

  it('空串 / 无法归类 → unknown', () => {
    expect(classifyEmpathy('')).toBe('unknown')
    expect(classifyEmpathy('嗯嗯好的')).toBe('unknown')
  })
})

describe('① empathy · 回应与确定性', () => {
  it('无文本时按心情兜底，回应落在该意图句池内', () => {
    const r = replyLocally({ text: '', mood: 'TIRED', turn: 0 })
    expect(r.intent).toBe('tired')
    expect(EMPATHY_ALL_LINES).toContain(r.text)
  })

  it('同一 (text, turn) 永远同一句；响应永远是合格文案', () => {
    const a = replyLocally({ text: '今天好累', mood: null, turn: 3 })
    const b = replyLocally({ text: '今天好累', mood: null, turn: 3 })
    expect(a.text).toBe(b.text)
    expect(isEmpathySafe(a.text)).toBe(true)
  })

  it('意图确定时，不同轮次可在句池内取到不同句（不是恒同一句）', () => {
    const first = replyLocally({ text: '', mood: 'ANXIOUS', turn: 0 })
    const distinct = new Set<string>()
    for (let t = 0; t < 12; t++) distinct.add(replyLocally({ text: '', mood: 'ANXIOUS', turn: t }).text)
    expect(distinct.size).toBeGreaterThan(1)
    expect(distinct.has(first.text)).toBe(true)
  })

  it('极端 turn（NaN / 负数 / 小数）不崩、仍返回合格文案', () => {
    for (const turn of [NaN, -5, 2.7, Infinity]) {
      const r = replyLocally({ text: '你好', mood: null, turn })
      expect(isEmpathySafe(r.text), String(turn)).toBe(true)
      expect(typeof r.intent).toBe('string')
    }
  })

  it('每次返回的 intent 都是合法枚举', () => {
    for (const s of ['', '累', '慌', '难过', '开心', '烦', '你好', '怎么办', '随便']) {
      const r = replyLocally({ text: s, mood: null, turn: 1 })
      expect(EMPATHY_INTENTS).toContain(r.intent as EmpathyIntent)
    }
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

describe('② consent · 云端同意', () => {
  it('默认是 off（没点过「好」就永不出端）', async () => {
    const store = await storeWith()
    expect(CLOUD_CONSENT_DEFAULT).toBe('off')
    expect(loadConsent(store)).toBe('off')
  })

  it('写入 on 后可读回 on；写回 off 后恢复 off', async () => {
    const store = await storeWith()
    saveConsent(store, 'on')
    expect(store.get(PERSIST_KEYS.empathyConsent, 'off')).toBe('on')
    expect(loadConsent(store)).toBe('on')

    saveConsent(store, 'off')
    expect(loadConsent(store)).toBe('off')
  })

  it('脏数据（非 on/off）一律兜底成 off', async () => {
    const store = await storeWith({ [PERSIST_KEYS.empathyConsent]: 'yes' })
    expect(loadConsent(store)).toBe('off')
  })

  it('从种子读回已存的 on', async () => {
    const store = await storeWith({ [PERSIST_KEYS.empathyConsent]: 'on' })
    expect(loadConsent(store)).toBe('on')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ payload.ts
// ───────────────────────────────────────────────────────────────────────────

describe('③ payload · 出端载荷', () => {
  it('逐字段构造：只含白名单三字段', () => {
    const p = buildEmpathyPayload({ text: '今天好累', mood: 'TIRED', turns: 2 })
    expect(Object.keys(p).sort()).toEqual([...EMPATHY_NETWORK_FIELDS].sort())
    expect(p.text).toBe('今天好累')
    expect(p.mood).toBe('TIRED')
    expect(p.turns).toBe(2)
  })

  it('超长文本按 200 字截断，不抛', () => {
    const p = buildEmpathyPayload({ text: '啊'.repeat(EMPATHY_TEXT_MAX_CHARS + 80), turns: 0 })
    expect(p.text.length).toBe(EMPATHY_TEXT_MAX_CHARS)
  })

  it('缺省输入退化为空文本 / 空心情 / 0 轮', () => {
    const p = buildEmpathyPayload({})
    expect(p).toEqual({ text: '', mood: null, turns: 0 })
  })

  it('turns 归一化（负数 / 小数 / NaN → 非负整数）', () => {
    expect(buildEmpathyPayload({ turns: -3 }).turns).toBe(0)
    expect(buildEmpathyPayload({ turns: 2.9 }).turns).toBe(2)
    expect(buildEmpathyPayload({ turns: NaN }).turns).toBe(0)
  })

  it('serialize 只出白名单字段，且不混入额外键', () => {
    const p = buildEmpathyPayload({ text: '嗯', mood: 'CALM', turns: 1 })
    const obj = JSON.parse(serializeEmpathyPayload(p)) as Record<string, unknown>
    expect(Object.keys(obj).sort()).toEqual([...EMPATHY_NETWORK_FIELDS].sort())
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ empathyCloud.ts（四道闸门 + 回落）
// ───────────────────────────────────────────────────────────────────────────

/** 造一份只改 empathyCloud 开关的配置 */
function withCloud(on: boolean): XiaobuConfig {
  return {
    ...BUILT_IN_CONFIG,
    features: { ...BUILT_IN_CONFIG.features, empathyCloud: { enabled: on } },
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

afterEach(() => {
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  __test_resetEmpathyCloud()
})

const CONSENT_ON = { text: '今天好累', mood: 'TIRED' as const, turns: 1, consent: 'on' as const }

describe('④ empathyCloud · 四道闸门', () => {
  it('未同意 ⇒ 连请求都不发（fetchImpl 零调用）—— 隐私关键断言', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '嗯' })
    const r = await requestCloudEmpathy({ ...CONSENT_ON, consent: 'off' }, { fetchImpl: f.fetchImpl })
    expect(r).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('开关关闭（默认 false）⇒ 即便同意也不发', async () => {
    const f = capturingFetch({ reply: '嗯' })
    expect(isEmpathyCloudEnabled()).toBe(false)
    const r = await requestCloudEmpathy(CONSENT_ON, { fetchImpl: f.fetchImpl })
    expect(r).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('开启 + 同意 ⇒ 成功返回云端回应，且出端只含白名单三字段', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '嗯，我在听。你慢慢说。', cents: 2 })
    const r = await requestCloudEmpathy(CONSENT_ON, { fetchImpl: f.fetchImpl })
    expect(r).toBe('嗯，我在听。你慢慢说。')
    const obj = JSON.parse(f.getBody()) as Record<string, unknown>
    expect(Object.keys(obj).sort()).toEqual([...EMPATHY_NETWORK_FIELDS].sort())
    expect(obj.text).toBe('今天好累')
    expect(obj.turns).toBe(1)
  })

  it('空文本不出端 ⇒ null（零调用）', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '嗯' })
    const r = await requestCloudEmpathy({ ...CONSENT_ON, text: '   ' }, { fetchImpl: f.fetchImpl })
    expect(r).toBeNull()
    expect(f.calls()).toBe(0)
  })

  it('超时 ⇒ null', async () => {
    applyConfig(withCloud(true))
    const r = await requestCloudEmpathy(CONSENT_ON, { fetchImpl: abortingFetch, timeoutMs: 5 })
    expect(r).toBeNull()
  })

  it('非 2xx ⇒ null', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '嗯' }, { ok: false, status: 500 })
    expect(await requestCloudEmpathy(CONSENT_ON, { fetchImpl: f.fetchImpl })).toBeNull()
  })

  it('脏 JSON ⇒ null', async () => {
    applyConfig(withCloud(true))
    expect(await requestCloudEmpathy(CONSENT_ON, { fetchImpl: badJsonFetch })).toBeNull()
  })

  it('命中禁词的回应 ⇒ null（回落本地）', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '这卦吉' })
    expect(await requestCloudEmpathy(CONSENT_ON, { fetchImpl: f.fetchImpl })).toBeNull()
  })

  it('网络抛错 ⇒ null 且不冒泡', async () => {
    applyConfig(withCloud(true))
    const boom = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(requestCloudEmpathy(CONSENT_ON, { fetchImpl: boom })).resolves.toBeNull()
  })
})

describe('④ parseCloudEmpathy · 结构校验', () => {
  it('合法回应通过，带上 cents', () => {
    expect(parseCloudEmpathy({ reply: '我在。', cents: 3 })).toEqual({ reply: '我在。', cents: 3 })
    expect(parseCloudEmpathy({ reply: '我在。' })).toEqual({ reply: '我在。', cents: 0 })
  })

  it('空 / 超长 / 禁词 / 非对象 ⇒ null', () => {
    expect(parseCloudEmpathy(null)).toBeNull()
    expect(parseCloudEmpathy('x')).toBeNull()
    expect(parseCloudEmpathy({ reply: '' })).toBeNull()
    expect(parseCloudEmpathy({ reply: '好'.repeat(EMPATHY_MAX_CHARS + 1) })).toBeNull()
    expect(parseCloudEmpathy({ reply: '抱歉，建议你休息' })).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ⑤ ui/empathyChat.ts（编排与容错 · 柔和降级）
// ───────────────────────────────────────────────────────────────────────────

/** 只压日额度的配置（默认 20 太高，额度用例要压到 1） */
function withQuota(on: boolean, quota: number): XiaobuConfig {
  return {
    ...BUILT_IN_CONFIG,
    features: { ...BUILT_IN_CONFIG.features, empathyCloud: { enabled: on } },
    quota: { ...BUILT_IN_CONFIG.quota, llmDailyFreePerUser: quota },
  } as XiaobuConfig
}

/** 手动放行的 fetch：先挂起，测试里再 `done()` 让它回来 —— 用于"请求在途时关面板" */
function deferredFetch(body: unknown): { fetchImpl: typeof fetch; done: () => void } {
  let resolve!: (r: unknown) => void
  const gate = new Promise<unknown>((r) => {
    resolve = r
  })
  const fetchImpl = (async () => await gate) as unknown as typeof fetch
  return { fetchImpl, done: () => resolve({ ok: true, status: 200, json: async () => body }) }
}

describe('⑤ empathyChat · 编排与容错（柔和降级）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    __test_resetEmpathyChat()
    __test_resetEmpathyCloud()
    resetEngineHost()
    applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('云端开关关闭（默认）⇒ 零请求、不显示 typing、本地回应照常', async () => {
    const f = capturingFetch({ reply: '云端回应不该出现' })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on') // 已同意，但开关关闭 → 闸门仍不过
    await sendEmpathy('今天好累')
    expect(f.calls()).toBe(0)
    expect(s.typing).toBe(false)
    expect(isEmpathySafe(s.latest.reply)).toBe(true)
    expect(s.latest.reply).not.toBe('云端回应不该出现')
  })

  it('云端可用 + 云端成功 ⇒ 静默替换为云端回应', async () => {
    applyConfig(withCloud(true))
    const reply = '嗯，我在听。你慢慢说。'
    const f = capturingFetch({ reply, cents: 1 })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on')
    await sendEmpathy('今天好累')
    expect(s.latest.mine).toBe('今天好累')
    expect(s.latest.reply).toBe(reply)
    expect(s.typing).toBe(false)
  })

  it('云端抛错 ⇒ 保留本地回应、不抛、typing 复位', async () => {
    applyConfig(withCloud(true))
    const boom = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', boom)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on')
    const p = sendEmpathy('今天好累')
    const local = s.latest.reply // 同帧就该有本地回应
    expect(isEmpathySafe(local)).toBe(true)
    await expect(p).resolves.toBeUndefined()
    expect(s.latest.reply).toBe(local) // 未被替换
    expect(s.typing).toBe(false)
  })

  it('云端回应命中禁词 ⇒ 保留本地（客户端再守一道）', async () => {
    applyConfig(withCloud(true))
    const f = capturingFetch({ reply: '这卦吉' }) // FORBIDDEN_COPY
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on')
    const p = sendEmpathy('今天好累')
    const local = s.latest.reply
    await p
    expect(s.latest.reply).toBe(local)
  })

  it('额度用尽 ⇒ 第二次发送零请求、不显示 typing，仍有本地回应', async () => {
    applyConfig(withQuota(true, 1))
    const f = capturingFetch({ reply: '嗯，我在。', cents: 1 })
    vi.stubGlobal('fetch', f.fetchImpl)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on')

    await sendEmpathy('第一句')
    expect(f.calls()).toBe(1) // 额度内：出端一次

    await sendEmpathy('第二句')
    expect(f.calls()).toBe(1) // 额度用尽：不再出端
    expect(s.typing).toBe(false)
    expect(isEmpathySafe(s.latest.reply)).toBe(true)
  })

  it('关闭面板后，迟到的云端回应不写回（防跨会话串话）', async () => {
    applyConfig(withCloud(true))
    const d = deferredFetch({ reply: '这是上一会话的迟到回应' })
    vi.stubGlobal('fetch', d.fetchImpl)
    const s = useXiaobuFormStore()
    openEmpathy()
    s.setConsent('on')

    const p = sendEmpathy('今天好累')
    expect(s.typing).toBe(true) // 请求在途

    // 用户关掉面板（UI 的 watch 会 closeEmpathy + clearTurn）
    closeEmpathy()
    s.clearTurn()

    d.done() // 云端这才回来
    await p

    expect(s.latest.reply).toBe('') // 迟到回应被会话守卫丢弃
    expect(s.typing).toBe(false)
  })
})
