/**
 * 小卜 · L10 纸张质感层   src/scene/layers/L10Paper.ts
 * ===========================================================================
 * 「落日山丘」绘本质感的最后一笔，两件事：
 *
 *   ① 暖琥珀渐变遮罩：把整张画面统一压进同一盏黄昏灯下 ——
 *      上浅下略深的暖琥珀，像一张旧纸被暖灯从上方照过。
 *      这与 L8 暖纱、L9 暗角**不冲突**：L8 管光从哪来，L9 管视线往哪收，
 *      L10 管"整张纸是什么纸"。
 *
 *   ② 水彩纸 / 旧纸张噪点：极低透明度、极细的颗粒纹理。
 *      纯代码生成，0 额外包体 —— 不引任何图片。
 *
 * ★★ 与 L8/L9 的关键区别：本层**不是天气可写**（不在 WEATHER_WRITABLE 白名单）。
 *   纸张质感是"媒介的底色"，不随天气、季节、时段变化 —— 它就像画这张画的纸。
 *
 * ★★ 确定性约束（门禁 ⑭ 铁律）★★
 *   噪点必须**逐像素确定**：同一坐标永远得到同一个噪点值。
 *   所以这里用基于整数坐标的哈希伪随机（见 `hashNoise`），
 *   绝不碰 `Math.random` —— 否则静态层两次烘焙的噪点不一样，
 *   直画路径 ≠ 离屏缓存路径，门禁 ⑭ 会假红。
 * ===========================================================================
 */

import { BAND, DESIGN_H, DESIGN_W, TOKENS, alpha, type LayerStack } from '@scene/renderer'

export const L10_ID = 'l10-paper'

/** 噪点单元格边长（设计 px）。越小越细，但越小也越"脏"；4 是水彩纸颗粒的甜点值 */
const NOISE_CELL = 4
/** 噪点最大透明度。极低，只做"纸的肌理"，绝不喧宾夺主 */
const NOISE_ALPHA_MAX = 0.045

export function registerL10(stack: LayerStack): void {
  stack.add({
    id: L10_ID,
    band: BAND.PAPER,
    sortY: 0,
    static: true,
    draw: drawL10,
  })
}

function drawL10(ctx: CanvasRenderingContext2D): void {
  drawAmberWash(ctx)
  drawPaperNoise(ctx)
}

/**
 * 暖琥珀渐变遮罩：上浅下略深，中心留一点"被灯照透"的亮。
 *
 * ★ 刻意用极低透明度（两端都 ≤ 0.06）：这是"遮罩"不是"染色"，
 *   不能把奶油底压成土黄，也不能盖掉窗光、壁灯的层次。
 */
function drawAmberWash(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, DESIGN_H)
  g.addColorStop(0, alpha(TOKENS.cPaperAmber, 0.05))
  g.addColorStop(0.5, alpha(TOKENS.cPaperAmber, 0.02))
  g.addColorStop(1, alpha(TOKENS.cPaperAmber, 0.06))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, DESIGN_W, DESIGN_H)
}

/**
 * 水彩纸噪点：按 NOISE_CELL 网格铺一层半透明小颗粒。
 *
 * ★ 性能：390×844 ÷ 4 ≈ 20,540 个单元格，每个一格 `fillRect`。
 *   这是**静态层**（`static: true`），烘焙一次进离屏缓存，不每帧重画 ——
 *   所以 2 万个 fillRect 只发生一次，运行时零开销。
 *
 * ★ 确定性：噪声值由 `hashNoise(x, y)` 决定，与帧号、时间、随机种子无关。
 */
function drawPaperNoise(ctx: CanvasRenderingContext2D): void {
  const cols = Math.ceil(DESIGN_W / NOISE_CELL)
  const rows = Math.ceil(DESIGN_H / NOISE_CELL)

  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const n = hashNoise(cx, ry)
      if (n < 0.5) continue // 一半的格子留空，颗粒才"疏"而不是"满"
      // n ∈ [0.5, 1) → 映射到 [0, NOISE_ALPHA_MAX] 的透明度
      const a = ((n - 0.5) * 2) * NOISE_ALPHA_MAX
      ctx.fillStyle = alpha(TOKENS.cPaperGrain, a)
      ctx.fillRect(cx * NOISE_CELL, ry * NOISE_CELL, NOISE_CELL, NOISE_CELL)
    }
  }
}

/**
 * 整数坐标 → [0, 1) 的确定性伪随机。
 *
 * ★ 用两个大质数 + 位运算把 (x, y) 搅成"看起来随机、但完全可复现"的值。
 *   同一坐标永远同一结果 —— 这是门禁 ⑭（直画 ≡ 离屏缓存）的根基。
 */
function hashNoise(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  h = h ^ (h >>> 16)
  return (h >>> 0) / 4294967296
}
