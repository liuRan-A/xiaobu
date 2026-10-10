/**
 * 小卜 · 金色时刻光影系统（Canvas 渲染参数）   src/scene/lighting.ts
 * ===========================================================================
 * 《UI交互规范》§视觉基调 v3 的落点。参考 Lapin / Ori 的"暖阳 + 发光植物"
 * 氛围，但**画风仍是 2.5D 等距微缩模型** —— 提取的是光，不是笔触。
 *
 * ── 三条硬规则（规范原文，改代码前先看）────────────────────────────────
 *  ① 光源只有一盏：窗外 Golden Hour 暖阳（右上 → 屋内左下），
 *    一切高光 / 边缘光 / 投影方向都从它推 —— 不许出现第二光源。
 *  ② 影子只能是暖棕（rgba(80,60,50,·)），由 warmShadow() 统一产出并被
 *    α 上限钳制 —— **禁止死黑**。画面里出现 #000 系投影即违规。
 *  ③ 色值只住 tokens.css（经 tokens.gen.ts 到这里），本文件不写十六进制。
 *
 * ── 反面清单（设计禁令）─────────────────────────────────────────────────
 *  禁止空洞骑士式幽暗 / 高反差 / 冷色调压抑：不引入冷色叠加层，
 *  暗部亮度不许低于 --c-night-guard（暖米），对比度靠"光更暖"而不是"暗更死"。
 * ===========================================================================
 */

import { TOKENS } from './renderer/tokens.gen'

export type Vec2 = { x: number; y: number }

/** 窗外暖阳方向（单位向量，由 tokens 同源给出）：右上 → 屋内左下 */
export const LIGHT_DIR: Vec2 = { x: TOKENS.lightDirX, y: TOKENS.lightDirY }

/**
 * Golden Hour 光柱与边缘光。
 * · rimCream：奶油白边缘光 —— 木桌沿、铜钱外沿、地毯绒边的柔亮描边；
 * · rimWarm：暖木色边缘光 —— 背光面第二层，即"像 Ori 的发光植物、
 *   但颜色必须奶油白和暖木色"的那一条。
 */
export const GOLDEN_HOUR = {
  beamColor: TOKENS.cSunbeam,
  beamSoftColor: TOKENS.cSunbeamSoft,
  beamOpacity: TOKENS.lightBeamOpacity,
  rimCream: TOKENS.cRimLight,
  rimWarm: TOKENS.cRimWarm,
  rimWidthPx: TOKENS.lightRimWidth,
} as const

/**
 * 玩具盒体积参数 —— 画面必须是"立体微缩玩具盒"：
 * 桌角有倒角、地毯有厚度、器物有侧壁。阴影暖棕，绝无死黑。
 */
export const TOYBOX = {
  bevelPx: TOKENS.toyBevel,
  thicknessPx: TOKENS.toyThickness,
  aoColor: TOKENS.cAoWarm,
  nightFloor: TOKENS.cNightGuard,
} as const

/** 从 tokens 里的 rgba 字符串解析出 rgb 分量（唯一真源，本文件不抄数字） */
function rgbOf(rgba: string): [number, number, number] {
  const m = rgba.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)
  if (!m) throw new Error(`[lighting] 无法解析投影色 token: ${rgba}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

const SHADOW_RGB = rgbOf(TOKENS.cShadowWarm)

/**
 * 全场景唯一合法的投影产出器。
 * 默认 α = tokens 同源的 0.2；需要更深的接触影时也**只许**到
 * --shadow-alpha-max（0.32）为止 —— 比"最深 0.32 的暖棕"更深即违规。
 */
export function warmShadow(alpha: number = TOKENS.shadowAlpha): string {
  const a = Math.min(Math.max(alpha, 0), TOKENS.shadowAlphaMax)
  return `rgba(${SHADOW_RGB[0]}, ${SHADOW_RGB[1]}, ${SHADOW_RGB[2]}, ${a})`
}
