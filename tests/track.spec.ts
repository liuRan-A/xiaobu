/**
 * 监控埋点   tests/track.spec.ts
 * ===========================================================================
 * 门禁⑩（禁持久化上报队列）+ 门禁⑦（禁隐私载荷）的落点验证：
 *   · 埋点只在内存缓冲，flush 走 sendBeacon（测试用 transport 接管）
 *   · 载荷只有枚举与数值
 *   · 批阈值触发自动 flush、成本熔断触发 blown
 *   · 采样率 < 1 时按概率丢弃
 *   · transport 抛错也不影响主流程（never throw）
 * ===========================================================================
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  trackFunnel,
  trackError,
  trackApiCall,
  recordLlmCost,
  isLlmCircuitBlown,
  flushTrack,
  setTrackTransport,
  __test_resetTrack,
  __test_pendingCount,
  type TrackEvent,
} from '@services/track'
import { applyConfig, currentConfig } from '@bootstrap/bootSequence'
import { BUILT_IN_CONFIG, type XiaobuConfig } from '@bootstrap/builtinConfig'

let sent: TrackEvent[][]
const transport = (batch: readonly TrackEvent[]) => {
  sent.push([...batch])
}

beforeEach(() => {
  __test_resetTrack()
  sent = []
  setTrackTransport(transport)
})

afterEach(() => {
  setTrackTransport(null)
  // 还原配置（部分用例改过 monitor.batchMaxCount / quota / sampleRate）
  applyConfig(BUILT_IN_CONFIG as unknown as XiaobuConfig)
})

/** 深拷贝当前生效配置，得到一份可变副本（用于注入测试用的微调项） */
function cloneConfig(): XiaobuConfig {
  return JSON.parse(JSON.stringify(currentConfig())) as XiaobuConfig
}

describe('埋点缓冲与 flush', () => {
  it('trackFunnel 压入 FUNNEL 事件，flush 后清空', () => {
    trackFunnel('LIUYAO_ENTER')
    expect(__test_pendingCount()).toBe(1)
    flushTrack()
    expect(__test_pendingCount()).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toMatchObject({ name: 'FUNNEL', node: 'LIUYAO_ENTER' })
  })

  it('ERROR / API_CALL 事件形状正确（只有枚举与数值）', () => {
    trackError('core.liuyao', 'network')
    trackApiCall('services.config')
    flushTrack()
    expect(sent[0]).toHaveLength(2)
    expect(sent[0][0]).toMatchObject({ name: 'ERROR', scope: 'core.liuyao', ok: 0 })
    expect(sent[0][1]).toMatchObject({ name: 'API_CALL', scope: 'services.config', count: 1 })
  })

  it('一次 flush 把整批送出，不漏不重', () => {
    trackFunnel('TAROT_PICK')
    trackFunnel('TAROT_DRAW')
    trackFunnel('TAROT_READING')
    flushTrack()
    expect(__test_pendingCount()).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(3)
  })
})

describe('批阈值自动 flush', () => {
  it('pending 达到 batchMaxCount 时自动 flush（门禁⑩：仍只走内存缓冲）', () => {
    const c = cloneConfig()
    c.monitor.batchMaxCount = 3
    applyConfig(c)

    trackFunnel('LIUYAO_MOOD')
    expect(sent).toHaveLength(0)
    trackFunnel('LIUYAO_FOCUS')
    expect(sent).toHaveLength(0)
    trackFunnel('LIUYAO_PLACE')
    // 第 3 条触顶，自动 flush
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(3)
    expect(__test_pendingCount()).toBe(0)
  })
})

describe('大模型成本熔断', () => {
  it('累计超阈值 → blown=1 且 isLlmCircuitBlown() 置位', () => {
    const c = cloneConfig()
    c.quota.llmGlobalDailyCircuit = 100
    applyConfig(c)

    recordLlmCost(60)
    expect(isLlmCircuitBlown()).toBe(false)
    recordLlmCost(50) // 累计 110 ≥ 100
    expect(isLlmCircuitBlown()).toBe(true)

    flushTrack()
    const blown = sent.flat().find((e) => e.name === 'LLM_COST')
    expect(blown).toMatchObject({ name: 'LLM_COST', blown: 1 })
  })

  it('未达阈值不熔断', () => {
    const c = cloneConfig()
    c.quota.llmGlobalDailyCircuit = 200
    applyConfig(c)
    recordLlmCost(50)
    expect(isLlmCircuitBlown()).toBe(false)
  })
})

describe('采样率', () => {
  it('sampleRate < 1 时按随机概率丢弃（Math.random 钉死可复现）', () => {
    const c = cloneConfig()
    c.monitor.sampleRate = 0.5
    applyConfig(c)

    const r = vi.spyOn(Math, 'random')
    r.mockReturnValue(0.99) // 0.99 > 0.5 → 丢弃
    trackFunnel('LIUYAO_ENTER')
    expect(__test_pendingCount()).toBe(0)

    r.mockReturnValue(0.01) // 0.01 > 0.5 → false → 保留
    trackFunnel('LIUYAO_MOOD')
    expect(__test_pendingCount()).toBe(1)
    r.mockRestore()
  })
})

describe('韧性（门禁⑨：永不抛）', () => {
  it('transport 抛错也不冒泡到调用方', () => {
    const bad = vi.fn(() => {
      throw new Error('boom')
    })
    setTrackTransport(bad)
    expect(() => {
      trackFunnel('LIUYAO_ENTER')
      flushTrack()
    }).not.toThrow()
  })

  it('无 transport 且非浏览器环境：flush 静默跳过，不抛', () => {
    setTrackTransport(null)
    expect(() => {
      trackFunnel('LIUYAO_ENTER')
      flushTrack()
    }).not.toThrow()
  })
})

describe('隐私边界（门禁⑦）', () => {
  it('载荷里只有枚举与数值，不出自由文本', () => {
    trackFunnel('LIUYAO_CAST')
    trackError('core.liuyao', 'fatal')
    flushTrack()
    const dump = JSON.stringify(sent)
    expect(dump).not.toContain('TypeError')
    expect(dump).not.toContain('undefined is not a function')
  })
})
