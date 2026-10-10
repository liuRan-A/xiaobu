/**
 * 小卜 · 命中层出口   src/scene/hit/index.ts
 * ---------------------------------------------------------------------------
 * Scene 把"手指落在哪儿"翻译成 `EngineHit` 的那一层，对外只暴露这一组。
 * 与 `renderer/index.ts` 一样，内部文件不直接被外部引用 ——
 * 这样以后加物件类型（牌堆、纪念品架）只改这一层。
 * ---------------------------------------------------------------------------
 */
export {
  COIN_TOUCH_R_PT,
  DECK_TOUCH_R_PT,
  MEMORY_TOUCH_R_PT,
  TIMEPIECE_TOUCH_R_PT,
  TUBE_TOUCH_PAD_PT,
  createSceneHitTest,
  hitTestAt,
  idleHitState,
  type HitCircle,
  type SceneHitState,
  type SceneHitStateGetter,
} from './hitTest'
