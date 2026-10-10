/**
 * 小卜 · 内置默认配置   src/bootstrap/builtinConfig.ts
 * ---------------------------------------------------------------------------
 * BUILT_IN_CONFIG 是**唯一真源**：断网、首启、验签失败、schemaVersion 越界 ——
 * 四种情况最后的答案都是它。所以它必须能在没有任何 IO 的前提下立刻可用。
 *
 * ★ 红线：本配置内不允许出现任何密钥（门禁 ⑧ 会扫）。
 *   cdnBase 只是一个公开的静态资源前缀，不是密钥。
 *
 * ★ 配置只描述"开关与额度"，绝不参与六爻与掷币的判断：
 *   关掉天气、关掉语音、关掉联网，六次掷币依然 100% 可玩。
 * ---------------------------------------------------------------------------
 */
import raw from '../config/config.json'

/** 当前客户端能理解的配置结构版本。远端 > 本值 → 整份丢弃（防新字段打崩老版本） */
export const CONFIG_SCHEMA_VERSION = 3

export interface WeatherFeature {
  enabled: boolean
  provider: 'hefeng' | 'none'
  ttlFreshMin: number
  ttlStaleHour: number
}

export interface XiaobuConfig {
  schemaVersion: number
  features: {
    weather: WeatherFeature
    voiceInput: { enabled: boolean }
    haptics: { enabled: boolean }
    ledger: { cnzz: boolean; abtest: boolean }
    /**
     * 共情对话的云端通道。★ 默认 false：不出端是默认态。
     * 即便置 true，仍需用户显式同意（consent='on'）才会把原话发往 /api/chat。
     */
    empathyCloud: { enabled: boolean }
  }
  quota: { llmDailyFreePerUser: number; llmGlobalDailyCircuit: number }
  assets: { cdnBase: string; packs: Record<string, string>; integrity: string }
  devWhitelist: { salt: string; deviceHashes: string[] }
  killSwitch: {
    forceSpringOnly: boolean
    disableLlm: boolean
    disableWeather: boolean
    disableTrack: boolean
  }
  monitor: {
    trackEnabled: boolean
    batchIntervalMs: number
    batchMaxCount: number
    batchMaxBytes: number
    flushOnBackground: boolean
    sampleRate: number
  }
  tuning: {
    longPressMs: number
    tossDistancePt: number
    snapRadiusPt: number
    settleMs: number
  }
}

/** 去掉 json 里的 _comment / _redline 等说明字段，得到纯配置对象 */
function stripMeta(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o as object).forEach(deepFreeze)
    Object.freeze(o)
  }
  return o
}

/**
 * ★ 内置默认 = "离线可用态"：
 *   春 · 黄昏，附加功能全关，但六爻与掷币 100% 吃内置资源。
 *   所以哪怕是全新安装 + 飞行模式，用户第一眼也是暖黄的黄昏小屋。
 */
export const BUILT_IN_CONFIG: Readonly<XiaobuConfig> = deepFreeze(
  stripMeta(raw) as unknown as XiaobuConfig,
)

/** 允许线上微调的四个数值都有硬边界 —— clamp 之后才允许生效（规划 §5） */
const BOUNDS = {
  longPressMs: [120, 300] as const,
  tossDistancePt: [40, 120] as const,
  snapRadiusPt: [20, 44] as const,
  settleMs: [800, 2000] as const,
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * 结构校验 + 边界收敛（手写，约 40 行，不引 zod，保住包体）。
 * 返回 null 表示这份配置整体不可信 → 调用方回退 BUILT_IN_CONFIG。
 */
export function validateConfig(input: unknown): XiaobuConfig | null {
  if (!input || typeof input !== 'object') return null
  const c = input as Partial<XiaobuConfig>

  // schemaVersion 越界（> 本版本 或 < 1）→ 整份丢弃（Checklist A6）
  if (typeof c.schemaVersion !== 'number') return null
  if (c.schemaVersion < 1 || c.schemaVersion > CONFIG_SCHEMA_VERSION) return null

  if (!c.features || !c.quota || !c.assets || !c.tuning) return null

  const merged: XiaobuConfig = {
    ...BUILT_IN_CONFIG,
    ...c,
    features: { ...BUILT_IN_CONFIG.features, ...c.features },
    quota: { ...BUILT_IN_CONFIG.quota, ...c.quota },
    assets: { ...BUILT_IN_CONFIG.assets, ...c.assets },
    devWhitelist: { ...BUILT_IN_CONFIG.devWhitelist, ...c.devWhitelist },
    killSwitch: { ...BUILT_IN_CONFIG.killSwitch, ...c.killSwitch },
    monitor: { ...BUILT_IN_CONFIG.monitor, ...c.monitor },
    tuning: { ...BUILT_IN_CONFIG.tuning, ...c.tuning },
  }

  for (const key of Object.keys(BOUNDS) as (keyof typeof BOUNDS)[]) {
    const [lo, hi] = BOUNDS[key]
    merged.tuning[key] = clamp(Number(merged.tuning[key]) || lo, lo, hi)
  }

  return merged
}
