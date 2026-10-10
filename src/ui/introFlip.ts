/**
 * 小卜 · 翻书进度数学   src/ui/introFlip.ts
 * ===========================================================================
 * 翻书启动流的**纯计算**部分，零 DOM / 零副作用 —— 为了能在 node 里单测。
 * IntroBook.vue 只做事件搬运与样式绑定，所有"该翻多少、算不算翻过去"都在这里。
 * ===========================================================================
 */

/** 翻页进度钳制区间 */
export function clampProgress(p: number): number {
  if (!Number.isFinite(p)) return 0
  return p < 0 ? 0 : p > 1 ? 1 : p
}

/**
 * 指针位移 → 翻页进度。
 * 向左拖（clientX 减小）为正方向：拖过一整页宽 = 翻完。
 */
export function progressFromDrag(startX: number, clientX: number, pageWidth: number): number {
  if (pageWidth <= 0) return 0
  return clampProgress((startX - clientX) / pageWidth)
}

/** 松手时够不够翻过去。0.55 是"翻页手感"的甜点：过半即成，不到回弹 */
export const FLIP_COMMIT_AT = 0.55

export function shouldCommitFlip(progress: number): boolean {
  return progress >= FLIP_COMMIT_AT
}

/**
 * 贝塞尔缓动：翻页完成的收尾不是匀速也不是 ease-out，
 * 用一条三次贝塞尔（纸张落下的"先快后顿"）把 p ∈ [0,1] 映射成时间曲线采样。
 * CSS 那边用同款 cubic-bezier(0.3, 0.7, 0.3, 1)，这里是给 rAF 动画用的孪生实现。
 */
export function flipEase(t: number): number {
  const u = clampProgress(t)
  // 三次贝塞尔 y(t)：控制点 (0.3, 0.7) 与 (0.3, 1) 的 y 分量
  const v = 1 - u
  return 3 * u * v * v * 0.7 + 3 * u * u * v * 1 + u * u * u
}
