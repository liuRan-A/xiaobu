/**
 * 小卜 · 分级日志   src/shared/logger.ts
 * 生产只允许 warn / error（门禁 ①：产物里出现 console.log 即失败）。
 * 这个文件是唯一允许直接调 console 的地方。
 *
 * ★ 这里也是"防崩底线"的一部分：日志只往 console 走，
 *   **绝不写 localStorage、绝不弹 UI**（门禁 ⑤ / ⑥）。渲染层出错的唯一动作
 *   就是计数 + 这里 warn 一次，然后静默降级。
 *
 * `setQuiet(true)` 供测试与压测使用：故意制造大量图层异常时，
 * 让 CI 日志保持可读（否则"该红"的用例会被淹没在 stack 里）。
 */

const isProd = import.meta.env.PROD

let quiet = false

export const logger = {
  /** 只在开发期输出 */
  log(...args: unknown[]): void {
    // eslint-disable-next-line no-console -- 本文件是全仓唯一允许直接调 console 的地方（见文件头）
    if (!isProd && !quiet) console.log(...args)
  },

  /** 降级、非法转移、兜底 —— 生产也保留，用于排查但不打扰用户 */
  warn(...args: unknown[]): void {
    if (!quiet) console.warn(...args)
  },

  /** 致命崩溃、需要上报的异常 */
  error(...args: unknown[]): void {
    if (!quiet) console.error(...args)
  },

  /**
   * 静音 / 恢复。只影响输出，不影响计数与隔离逻辑 ——
   * 测试里断言"图层被隔离"请查 LayerStack.quarantined()，而不是查日志。
   */
  setQuiet(v: boolean): void {
    quiet = v
  },

  get isQuiet(): boolean {
    return quiet
  },
}
