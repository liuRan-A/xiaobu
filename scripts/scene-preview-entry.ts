/**
 * 小卜 · 场景预览入口   scripts/scene-preview-entry.ts
 * ===========================================================================
 * 只服务一件事：让完整场景能在一个**普通 2D 上下文**里画一遍。
 *
 * 用途：
 *   · `npm run preview:scene` 在 node 侧把 M1 场景渲染成 PNG，用于视觉回归
 *     （不依赖浏览器 / 不需要 Chromium，几百毫秒出图）。
 *   · 也是"渲染核心不依赖 DOM"这条约束的活证明 —— 它能在 node 里跑，
 *     就说明 isometric / LayerStack / 各图层都没有偷偷碰 window。
 *
 * ★ 本文件不参与 app 打包（只在 scripts/ 里被 esbuild 引用）。
 * ===========================================================================
 */

export { createSceneStack } from '@scene/layers'
export { DESIGN_W, DESIGN_H, TOKENS } from '@scene/renderer'
export { computeFit } from '@scene/renderer' // 门禁⑭ 渲染冒烟：fit 路径（离屏缓存）要用
export type { Frame } from '@scene/renderer'

// ── 几何体检用的出口 ───────────────────────────────────────────────────────
//   `scripts/check-art-geometry.mjs` 拿这几个去核对"美术实测值"与等距网格是否自洽。
//   刻意走真实模块而不是在脚本里重抄一遍常量 —— 否则体检表本身就会说谎。
export { ISO, MEASURED, project, unproject, quadOf, quadFrom } from '@scene/renderer'
export {
  BOARD,
  TABLE_QUAD,
  TABLE_Z,
  TABLE_APRON,
  FLOOR_SHEEN_UNITS,
  boardQuad,
} from '@scene/layers'

// ── 卡背烘焙出口 ──────────────────────────────────────────────────────────
//   `scripts/export-cardback.mjs` 用它把程序化卡背烘成 512×709 WebP 资产
//   （贴图阶段的"同稿自产"测试资产，美术真稿到位后直接覆盖同名文件即可）。
export { drawDeckTop, DECK_METRICS } from '@scene/layers'
