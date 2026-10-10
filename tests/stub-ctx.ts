/**
 * 测试用 Canvas 上下文桩   tests/stub-ctx.ts
 * ===========================================================================
 * 一个"什么都接受、什么都不做、把调用记下来"的 2D context。
 *
 * 为什么用 Proxy 而不是手写 40 个空方法：
 *   painter 会用到 fill / stroke / createLinearGradient / ellipse / clip …
 *   手写一份清单，以后 painter 加一个新 API 就要回来补一次 —— 这是"测试脚手架
 *   成为维护负担"的典型路径。Proxy 让 stub 对新增 API 免疫。
 *
 * ★ 它同时记录每次 fillRect 时的 fillStyle，用来验证"绝不白屏"这条底线：
 *   渲染的第一笔必须是整块设计画布 + 奶油色。
 * ===========================================================================
 */

export interface FillRecord {
  /** 那一刻的 fillStyle */
  style: string
  args: number[]
}

export interface StubCtx {
  ctx: CanvasRenderingContext2D
  /** 被调用过的方法名，按顺序 */
  calls: string[]
  /** 每一次 fillRect 及其当时的 fillStyle */
  fills: FillRecord[]
}

export function makeStubCtx(): StubCtx {
  const calls: string[] = []
  const fills: FillRecord[] = []
  const store: Record<string, unknown> = {}
  const gradient = { addColorStop: () => undefined }

  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key === 'symbol') return undefined
        if (key in store) return store[key]

        const name = String(key)
        return (...args: unknown[]) => {
          calls.push(name)
          if (name === 'fillRect') {
            fills.push({ style: String(store.fillStyle ?? ''), args: args.map(Number) })
          }
          if (name.startsWith('create')) return gradient
          return undefined
        }
      },
      set(_target, key, value) {
        if (typeof key === 'string') store[key] = value
        return true
      },
      has: () => true,
    },
  ) as unknown as CanvasRenderingContext2D

  return { ctx, calls, fills }
}
