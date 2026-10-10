/**
 * 小卜 · 牌阵引擎出口   src/core/spread/index.ts
 * ---------------------------------------------------------------------------
 * 只导出这一个面。UI 与 engine 都从这里 import，不直接引用内部文件。
 * ---------------------------------------------------------------------------
 */
export {
  SPREAD_SCHEMA_VERSION,
  SPREAD_TIERS,
  TIER_LABEL,
  READING_ROLES,
  SPREAD_REGISTRY,
  SPREADS,
  SPREAD_ISSUES,
  SPREAD_CARD_METRICS,
  SPREAD_CANVAS,
  FALLBACK_SPREAD,
  getSpread,
  spreadsByTier,
  subtitleOf,
  toListItem,
  drawOrder,
  cardForDraw,
  halfExtent,
  resolveLayout,
  buildReadingPlan,
  validateSpread,
  validateRegistry,
  type ReadingPlan,
  type ReadingSection,
  type ReadingStrategy,
  type ResolvedCard,
  type ResolvedLayout,
  type LayoutOptions,
  type SpreadCard,
  type SpreadCardMetrics,
  type SpreadConfig,
  type SpreadIssue,
  type SpreadListItem,
  type SpreadRegistry,
  type SpreadTier,
} from './spreadConfig'
