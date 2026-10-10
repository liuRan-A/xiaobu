/**
 * 小卜 · 天气投影   src/store/weather.ts
 * ===========================================================================
 * UI 与氛围层读天气的**唯一入口**。它做三件事：
 *
 *   · 把 services/weather 的裸快照收成一份**反应式投影**（kind / tempC / 新鲜度）
 *   · 按 TTL 判定"这份还新不新"（新鲜直接用 / 陈旧标一句 / 过期视同没有）
 *   · 暴露 `refresh()` 给装配层非阻塞地拉取
 *
 * ★ 为什么 UI 不直连 @weather：门禁⑥ / ESLint 明确要求 —— UI 只读这份投影，
 *   不直连天气模块。这样"谁能改天气、谁只能看天气"在依赖方向上就是确定的。
 * ★ 本 store 不 import 任何 scene / 渲染层：它只描述"天气是什么"，
 *   "天气让画面变成什么样"由 src/scene/ambience.ts 决定。
 * ★ 单向只读：这里的任何字段都不会被占卜 / 解读读取（门禁⑥）。
 * ===========================================================================
 */
import { defineStore } from 'pinia'
import { currentConfig } from '@bootstrap/bootSequence'
import { requestWeatherSnapshot, isWeatherEnabled } from '@services/weather'
import {
  WEATHER_LABEL,
  weatherFreshness,
  type WeatherFreshness,
  type WeatherKind,
  type WeatherSnapshot,
} from '@weather'

/** 'none' = 还没拿到过任何一份（含关闭 / 从未成功） */
export type WeatherState = 'none' | WeatherFreshness

export const useWeatherStore = defineStore('weather', {
  state: () => ({
    kind: 'unknown' as WeatherKind,
    tempC: null as number | null,
    /** 'none' | 'fresh' | 'stale' | 'expired' */
    state: 'none' as WeatherState,
    /** 采集时刻（ms） */
    updatedAt: 0,
    /** 正在拉取（UI 可据此不做任何事，只留个读点） */
    busy: false,
  }),

  getters: {
    /** 面向用户的短签（unknown / 过期时为空串） */
    label(state): string {
      return WEATHER_LABEL[state.kind] ?? ''
    },

    /** 温度小字（未知为空串） */
    tempText(state): string {
      return state.tempC === null ? '' : `${state.tempC}°`
    },

    /** 是否值得在界面上提一句：开关开着 + 有短签 + 没过期 */
    visible(state): boolean {
      return (
        isWeatherEnabled() &&
        (WEATHER_LABEL[state.kind] ?? '') !== '' &&
        state.state !== 'none' &&
        state.state !== 'expired'
      )
    },

    /** 陈旧（仍显示，但该标一句"刚看过"） */
    stale(state): boolean {
      return state.state === 'stale'
    },
  },

  actions: {
    /** 应用一份快照（含"后端明确说拿不到"的 unknown 快照），并按 TTL 记新鲜度 */
    apply(s: WeatherSnapshot, now = Date.now()): void {
      const cfg = currentConfig().features.weather
      this.kind = s.kind
      this.tempC = s.tempC
      this.updatedAt = s.updatedAt
      this.state = weatherFreshness(s, now, cfg.ttlFreshMin, cfg.ttlStaleHour)
    },

    /**
     * 拉一次天气。★ 非阻塞（装配层 `void` 它）、永不抛。
     * @param force 忽略 TTL，强制出网（测试 / 手动刷新用）
     */
    async refresh(force = false, now = Date.now()): Promise<void> {
      if (!isWeatherEnabled()) {
        this.state = 'none'
        return
      }
      if (!force && this.state === 'fresh') return

      this.busy = true
      try {
        const s = await requestWeatherSnapshot({ now: () => now })
        if (s) this.apply(s, now)
      } finally {
        this.busy = false
      }
    },
  },
})
