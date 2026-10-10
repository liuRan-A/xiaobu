/**
 * 小卜 · 背景音调度（纯逻辑）   src/core/audio/ambient.ts
 * ===========================================================================
 * 背景音"放哪一首、多大声"的纯计算：由**月份**定季节、由**小时**定时段，
 * 两者拼成一个音轨 id。零依赖、不碰 DOM 与 Audio —— 于是它能在 node 里单测，
 * 真正出声的那一段在 `@audio`（src/audio/index.ts）。
 *
 * ★ 为什么把"选哪首"放进 core：
 *   "现在该放春天黄昏"这件事与设备、网络、渲染全无关系，是纯粹的规则计算。
 *   把它隔离出来，就能确定性地测"3 月 19 点是 spring-dusk"，
 *   而不必真去启动一个 <audio>。
 *
 * ★ 门禁③：本文件不写死季节资源路径、不做 `season = 'summer'` 这类赋值，
 *   季节只由日期推出、音轨地址由配置里的 cdnBase 拼出。
 * ===========================================================================
 */

/** 四季。★ 只是音乐分组的名字，与"主包资源季节"无关（素材一律走 CDN） */
export type AmbientSeason = 'spring' | 'summer' | 'autumn' | 'winter'

/** 一天四段：清晨 / 白天 / 黄昏 / 夜 */
export type AmbientDayPart = 'dawn' | 'day' | 'dusk' | 'night'

/** 月份（0 = 一月）→ 季节。★ 按天文习惯：3–5 春、6–8 夏、9–11 秋、12–2 冬 */
export function seasonOfMonth(month0: number): AmbientSeason {
  const m = (((Math.floor(month0) % 12) + 12) % 12)
  if (m >= 2 && m <= 4) return 'spring'
  if (m >= 5 && m <= 7) return 'summer'
  if (m >= 8 && m <= 10) return 'autumn'
  return 'winter'
}

/** 小时（0–23）→ 时段。夜里最安静，白天最亮 */
export function dayPartOfHour(hour: number): AmbientDayPart {
  const h = (((Math.floor(hour) % 24) + 24) % 24)
  if (h < 6) return 'night'
  if (h < 11) return 'dawn'
  if (h < 17) return 'day'
  if (h < 21) return 'dusk'
  return 'night'
}

export interface AmbientPlan {
  season: AmbientSeason
  dayPart: AmbientDayPart
  /** 音轨 id，形如 `spring-dusk` —— 也是 CDN 上的文件名 */
  trackId: string
}

/** 由当前时刻算出该放哪一首 */
export function ambientPlanFor(date: Date): AmbientPlan {
  const season = seasonOfMonth(date.getMonth())
  const dayPart = dayPartOfHour(date.getHours())
  return { season, dayPart, trackId: `${season}-${dayPart}` }
}

/**
 * 音量基线：凌晨最轻、白天稍高。
 * ★ 这些值只是"播放器把音量调到多少"，最终是否出声还取决于用户有没有静音。
 */
export function ambientVolumeFor(dayPart: AmbientDayPart): number {
  switch (dayPart) {
    case 'night':
      return 0.18
    case 'dawn':
      return 0.24
    case 'day':
      return 0.3
    case 'dusk':
      return 0.26
  }
}

/**
 * 从 cdnBase 拼出音轨地址。
 * ★ 客户端零密钥：音轨是公开静态资源，url 里不含任何密钥；
 *   cdnBase 为空（首启 / 断网）就返回空串 —— 调用方据此**不播**。
 */
export function ambientAudioUrl(cdnBase: string, trackId: string): string {
  const base = String(cdnBase ?? '').trim()
  if (!base || !trackId) return ''
  return `${base.replace(/\/+$/, '')}/audio/${trackId}.ogg`
}
