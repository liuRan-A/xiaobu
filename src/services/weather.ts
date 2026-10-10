/**
 * 小卜 · 天气网关客户端   src/services/weather.ts
 * ===========================================================================
 * 天气那半条腿的**唯一出口**：向自家后端要一份**归一化快照**。
 *
 * ── 为什么走自家后端，而不是直接连和风 ──────────────────────────────────────
 *   和风 Key 是"用一次就烧一次额度"的东西，放进客户端产物 = 任何人解包即可盗用。
 *   所以 Key 只在服务端 .env 里，客户端只见 `/api/weather`（**路径里没有任何密钥**，
 *   门禁⑤ 会扫产物确认这一点）。
 *
 * ── 两道闸门（任一不过 ⇒ 连请求都不发，直接返回 null）──────────────────────
 *   ① features.weather.enabled        配置总开关
 *   ② killSwitch.disableWeather       服务端一键停用（秒级止血）
 *
 * ── 唯一出口永不变 ──────────────────────────────────────────────────────────
 *   `requestWeatherSnapshot()` **永不抛**：返回快照 = 拿到；返回 null = 这一次不提天气
 *   （含：开关关闭 / 停用 / 无 fetch / 超时 / 非 2xx / 非法 JSON / 结构不合格）。
 *   调用方只需 `snap ?? 保持上一份`，永远不需要 try/catch。
 *
 * ★ 单向只读：本模块的返回值只被氛围层消费，绝不回流进任何占卜逻辑（门禁⑥）。
 * ★ 门禁⑨：catch 内只 logger.warn，绝不弹 UI、绝不冒泡。
 * ★ 门禁⑩：本模块不建任何队列、不碰任何持久化。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { currentConfig } from '@bootstrap/bootSequence'
import { trackApiCall } from '@services/track'
import { parseWeatherPayload, type WeatherSnapshot } from '@weather'

/**
 * 出网基址。★ 真机 / 生产必须用 VITE_API_BASE 给绝对地址 ——
 * Capacitor 里相对路径会打到 capacitor://localhost，命中不了自家后端。
 * Web 开发留空即可，由 Vite dev 代理转发（见 vite.config.ts 的 server.proxy）。
 */
const API_BASE = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 天气网关：路径里**不含任何密钥**（和风 Key 只在服务端 .env 里） */
const WEATHER_ENDPOINT = `${API_BASE}/api/weather`

/** 天气是"背景信息"，比解读更不该让用户等 —— 超时即当拿不到 */
const WEATHER_TIMEOUT_MS = 5000

export interface WeatherOptions {
  /** 端点覆盖（测试用） */
  url?: string
  /** 超时覆盖（测试用） */
  timeoutMs?: number
  /** fetch 注入（测试 / SSR 环境） */
  fetchImpl?: typeof fetch
  /** 当前时刻注入（测试用） */
  now?: () => number
}

/**
 * 天气此刻是否可用（两道闸门）。
 * ★ 只是"要不要发请求"的预判；真正的失败（超时 / 结构非法）由 requestWeatherSnapshot 兜。
 */
export function isWeatherEnabled(): boolean {
  const cfg = currentConfig()
  if (!cfg.features.weather.enabled) return false
  if (cfg.killSwitch.disableWeather) return false
  return true
}

/**
 * 向自家后端要一份天气快照。
 *
 * @returns 归一化快照；`null` = 这一次不提天气（含上述全部失败情形）。
 *          **调用方只需 `snap ?? 保持上一份`。**
 */
export async function requestWeatherSnapshot(
  opts: WeatherOptions = {},
): Promise<WeatherSnapshot | null> {
  // ① 两道闸门
  if (!isWeatherEnabled()) return null

  // ② 传输可用性
  const doFetch = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!doFetch) return null

  const nowFn = opts.now ?? Date.now
  const url = opts.url ?? WEATHER_ENDPOINT
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? WEATHER_TIMEOUT_MS)

  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null

    let raw: unknown
    try {
      raw = await res.json()
    } catch {
      return null
    }

    const snap = parseWeatherPayload(raw, nowFn())
    if (!snap) return null

    // 成功才算一次接口调用（失败不计）
    trackApiCall('WEATHER')
    return snap
  } catch (e) {
    // ★ 门禁⑨：超时 / 断网 / 任何异常都静默"这次不提天气"，绝不弹 UI、绝不冒泡
    logger.warn('[weather] cloud weather unavailable, keep ambience', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}
