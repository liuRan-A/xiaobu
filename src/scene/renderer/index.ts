/**
 * 小卜 · 渲染内核出口   src/scene/renderer/index.ts
 * ---------------------------------------------------------------------------
 * 场景层对外只暴露这一组东西。layers/ 与 Scene.vue 都从这里 import，
 * 不直接引用内部文件 —— 这样以后替换渲染后端（比如换成 WebGL）只改这里。
 * ---------------------------------------------------------------------------
 */
export {
  BAND,
  BAND_LABEL,
  PASS,
  PASSES,
  LayerStack,
  defaultPass,
  isWeatherWritable,
  type Band,
  type Frame,
  type PassId,
  type PassSpec,
  type RenderItem,
  type SortMode,
} from './LayerStack'

export { CanvasRenderer, type CanvasRendererOptions } from './CanvasRenderer'

export {
  DESIGN_W,
  DESIGN_H,
  ISO,
  MEASURED,
  deriveIso,
  project,
  unproject,
  liftPx,
  shadowOf,
  quadOf,
  quadCenter,
  quadFrom,
  stylizedDiamond,
  quadPath,
  lerpPt,
  sliceLine,
  actorSortY,
  platformSortY,
  sortYAt,
  stepU,
  stepV,
  distPt,
  snapToHalf,
  type IsoCalibration,
  type MeasuredAnchors,
  type Quad,
  type Vec2,
} from './isometric'

export {
  computeFit,
  distributeEvenly,
  labelPlusEven,
  layoutIsExact,
  screenToDesign,
  designToScreen,
  type FitBox,
  type RowLayout,
} from './layoutMath'

export { TOKENS, type TokenName } from './tokens.gen'

export { alpha, mix, shade, parseColor, flattenRy, type Rgb } from './color'
