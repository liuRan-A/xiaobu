/**
 * 小卜 · 天气氛围桥   src/scene/ambience.ts
 * ===========================================================================
 * 天气的**唯一合法去处**：把天气翻译成光色 / 薄纱 / 暗角的数值，写进 L8 / L9。
 * 门禁⑥ 会检查：核心决策逻辑零感知天气 —— 天气只能向氛围层流动。
 *
 *   · `ambienceForKind()` 是**纯函数**：kind → 三个氛围数值，可在 node 里单测；
 *   · `applyAmbience()` 只调 L8 / L9 的写入口（setVeilOpacity / setGrade），
 *     而那两个入口本身就有 clamp，远端配置也调不坏画面。
 *
 * ★ 为什么映射里有"春·黄昏 = 出厂值"这一档：
 *   kind='unknown'（拿不到天气 / 关停）时，映射结果与 L8 / L9 的出厂常量
 *   **逐字相同** —— 于是"没有天气"和"天气拿不到"在画面上完全一致，
 *   绝不会有"网络一断画面就跳一下"的观感。
 *
 * ★ 反向引用禁止：本文件不 import 任何 core / store，只 import @weather 的类型。
 * ===========================================================================
 */

import type { LayerStack } from '@scene/renderer'
import { setGrade, setVeilOpacity } from './layers'
import type { WeatherKind } from '@weather'

/** 三个氛围数值。它们的合法区间由 L8 / L9 的写入口 clamp，这里只给意图 */
export interface WeatherAmbience {
  /** L8 暖色薄纱浓度 */
  veilOpacity: number
  /** L9 暗角浓度 */
  vignette: number
  /** L9 暖光晕强度倍率 */
  bloom: number
}

/**
 * 中性氛围（= 春·黄昏 / 拿不到天气）。
 * ★ 必须与 L8Veil 的 `veilOpacity = 0.085` 和 L9Grade 的
 *   `vignette = 0.26 / bloom = 1` 逐字一致 —— 否则"没有天气"时画面会与出厂不同。
 */
export const NEUTRAL_AMBIENCE: WeatherAmbience = { veilOpacity: 0.085, vignette: 0.26, bloom: 1 }

/**
 * 天气 → 氛围。★ 纯函数、只返回数值，不碰渲染栈。
 *
 *   越阴沉（雨/雪）⇒ 薄纱更浓（把颜色压到同一色温）、暗角更重、暖光更弱；
 *   越明亮（晴）   ⇒ 反过来。数值都落在 L8 / L9 的 clamp 区间内。
 */
export function ambienceForKind(kind: WeatherKind): WeatherAmbience {
  switch (kind) {
    case 'clear':
      return { veilOpacity: 0.075, vignette: 0.22, bloom: 1.12 }
    case 'cloudy':
      return { veilOpacity: 0.11, vignette: 0.29, bloom: 0.95 }
    case 'rain':
      return { veilOpacity: 0.13, vignette: 0.33, bloom: 0.86 }
    case 'snow':
      return { veilOpacity: 0.1, vignette: 0.3, bloom: 0.9 }
    default:
      // unknown / 拿不到 ⇒ 出厂氛围（绝不"跳一下"）
      return { ...NEUTRAL_AMBIENCE }
  }
}

/**
 * 把氛围写进渲染栈。
 * ★ 只调 L8 / L9 的写入口 —— 天气能改的画面元素**仅此两处**（门禁⑥）。
 *   两个入口各自 clamp 并失效 GRADE 缓存，下一帧生效。
 */
export function applyAmbience(a: WeatherAmbience, stack: LayerStack): void {
  setVeilOpacity(a.veilOpacity, stack)
  setGrade({ vignette: a.vignette, bloom: a.bloom }, stack)
}
