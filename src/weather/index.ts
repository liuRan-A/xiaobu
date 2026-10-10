/**
 * 小卜 · 天气模块（@weather）   src/weather/index.ts
 * ===========================================================================
 * 天气在小卜里是**一个只读的氛围输入**，不是玩法数据。它的流向只有一条：
 *
 *        /api/weather → services/weather → store/weather → scene/ambience → L8/L9
 *
 * ★ 三条硬线（门禁⑤⑥ 会守）
 *   ① **零密钥**：客户端只见自家后端的**归一化快照**（kind / tempC / 降级码 /
 *      归一化亮度），和风 Key 只在服务端 .env 里。
 *   ② **单向只读**：天气绝不参与六爻 / 塔罗 / 解读的任何一个判断。
 *      所以"今天下雨"永远不会改变任何一次占卜的结果。
 *   ③ **拿不到就不提**：认不出的 kind 一律 'unknown'；界面读到 unknown / 过期
 *      就什么都不显示 —— 宁可不提天气，也不给用户一句错天气。
 *
 * ★ 本模块零依赖、纯函数，可在 node 里直接单测。
 * ===========================================================================
 */

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'snow' | 'unknown'

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'rain', 'snow', 'unknown']

/**
 * 服务端降级码（与后端 /api/weather 同源）：
 *   0 = 正常；1 = 上游超时/无响应；2 = 拿不到；3 = 被服务端一键关停。
 * ★ 客户端不因降级码做任何玩法决策，只用来"这次要不要提天气"。
 */
export type WeatherDegraded = 0 | 1 | 2 | 3

/** 客户端只收这一个形状（服务端代理在其后，把厂商响应归一化成它） */
export interface WeatherSnapshot {
  kind: WeatherKind
  /** 摄氏温度（整数，取整）；未知为 null */
  tempC: number | null
  degraded: WeatherDegraded
  /** 归一化氛围亮度（0..1）：0 = 最暗沉，1 = 最明亮（供氛围层推薄纱/暗角） */
  brightness: number
  /** 采集时刻（ms）：服务端给就用它的，没给就用客户端收到的时刻 */
  updatedAt: number
}

/** 新鲜度三档：新鲜 / 陈旧（仍显示但标一句）/ 过期（视同没有） */
export type WeatherFreshness = 'fresh' | 'stale' | 'expired'

/** 归一化 kind —— 认不出的一律 'unknown'（保守方向：不显示） */
export function normalizeWeatherKind(v: unknown): WeatherKind {
  return typeof v === 'string' && (WEATHER_KINDS as readonly string[]).includes(v)
    ? (v as WeatherKind)
    : 'unknown'
}

/** clamp 到 [0,1]；非有限数退回 fallback */
export function clamp01(v: unknown, fallback = 0.5): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : NaN
  if (Number.isNaN(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** 数值取整；认不出就 null（负数温度也照收） */
function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Math.round(Number(v))
  return null
}

function degradedOf(v: unknown): WeatherDegraded {
  const n = intOrNull(v)
  return n === 1 || n === 2 || n === 3 ? n : 0
}

/**
 * 解析 /api/weather 的响应。
 * ★ 只有"非对象 / 缺 kind"才算不合格（⇒ null，调用方保持上一份或什么都不提）。
 *   kind='unknown' 是**合法**的：后端明确说"这次拿不到"时会这么回。
 */
export function parseWeatherPayload(raw: unknown, now: number): WeatherSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.kind !== 'string') return null
  return {
    kind: normalizeWeatherKind(r.kind),
    tempC: intOrNull(r.tempC),
    degraded: degradedOf(r.degraded),
    brightness: clamp01(r.brightness, 0.5),
    updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : now,
  }
}

/** 距采集过了多久（ms，恒非负） */
export function weatherAgeMs(s: WeatherSnapshot, now: number): number {
  return Math.max(0, now - s.updatedAt)
}

/**
 * 新鲜度三档（TTL 由 config.features.weather 给）：
 *   fresh   —— ttlFreshMin 分钟内，直接用；
 *   stale   —— ttlStaleHour 小时内，仍显示但标注一句"刚看过"；
 *   expired —— 超了 ttlStaleHour，视同没有。
 */
export function weatherFreshness(
  s: WeatherSnapshot,
  now: number,
  ttlFreshMin: number,
  ttlStaleHour: number,
): WeatherFreshness {
  const age = weatherAgeMs(s, now)
  if (age <= Math.max(0, ttlFreshMin) * 60_000) return 'fresh'
  if (age <= Math.max(0, ttlStaleHour) * 3_600_000) return 'stale'
  return 'expired'
}

/**
 * 面向用户的柔和短签。
 * ★ 无"预报/降雨概率/气压"这类行话，也不报好坏 —— 只是替用户看一眼窗外。
 */
export const WEATHER_LABEL: Readonly<Record<WeatherKind, string>> = {
  clear: '窗外晴着',
  cloudy: '天有点阴',
  rain: '外面在下雨',
  snow: '下雪了',
  unknown: '',
}
