/**
 * 小卜 · 触感   src/scene/ritual/haptics.ts
 * ===========================================================================
 * 规范 §2.2 五：「**只有"做成了"才震**」。
 * 参数（lift 12ms / toss 8ms / land 18ms / snap 10ms）与档位（LIGHT / MEDIUM）
 * 都在 `core/ritual/thresholds.ts` 的 `HAPTIC_MS` / `HAPTIC_STYLE` 里 ——
 * 这里只负责把它交给平台。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ★ 为什么触感走到场景层才落地，而不是 core 自己震
 * ───────────────────────────────────────────────────────────────────────────
 *  core 是零依赖的（ESLint 禁令 1 明确禁止 `@capacitor/*`）。
 *  所以 `RitualEngine` 只产出一个"取走即清"的信号（`consumeHaptic()`），
 *  要不要真的震、怎么震，由这一层决定。收益是：**在 node 单测与浏览器里，
 *  触感天然是空操作**，不需要任何 `if (isTest)` 分支 —— 那类分支是"测试环境
 *  与真机行为不一致"最常见的来源。
 *
 *  ★ 平台判断必须在调插件**之前**：Capacitor 的 web 实现虽然没有副作用，
 *  但它是异步的，会在 DevTools 里刷出一串"未处理的 promise"噪音。
 *  能判断就判断，是零成本的。
 * ===========================================================================
 */

import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { HapticCue } from '@core/ritual/engine'

/**
 * 震一下。
 * ★ 本函数**永不抛、永不返回错误** —— 触感是锦上添花，
 *   拿不到（无马达、权限、WebView 不支持）就是没有，不该影响任何流程。
 */
export function pulseHaptic(cue: HapticCue): void {
  try {
    if (!Capacitor.isNativePlatform()) return
    const style = cue === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light
    void Haptics.impact({ style }).catch(() => {
      /* 插件层失败：静默。门禁 ⑨ 的精神 —— 触感失败不该有任何用户可见反应 */
    })
  } catch {
    /* 连导入失败都兜住：触感永远不能成为崩溃源 */
  }
}
