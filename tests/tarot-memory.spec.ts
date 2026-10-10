/**
 * 小卜 · OOM 防崩测试   tests/tarot-memory.spec.ts
 * ===========================================================================
 * 对应真机回归 R10（低端机 2GB RAM 连续操作）的自动化兜底。
 *
 * ── 验什么 ──────────────────────────────────────────────────────────────────
 *   M3 混合渲染里，塔罗牌卡背 / 卡面用 WebP 贴图。最危险的不是"加载慢"，
 *   而是"连续切牌时每次重新解码" —— 50 次切牌 = 50 份 RGBA 位图常驻内存，
 *   低端机上直接 OOM（进程被杀，任何容错都救不回）。
 *
 *   所以这里断言的**不是**"加载成功"，而是：
 *   ① 同一张牌（同一 URL）在 LRU 容量内**只解码一次**（decodes 不随切换次数增长）
 *   ② 缓存项数有硬上界（size() ≤ maxEntries），不随切换线性增长
 *   ③ 加载失败时静默返回 null（走程序化占位），**不抛异常**（门禁⑨）
 *   ④ LRU 淘汰确实发生：塞满后淘汰最久未用，容量不回弹
 * ===========================================================================
 */
import { describe, it, expect } from 'vitest'
import { createTexLoader, type TexLoader } from '@services/tex'

/** 伪造解码源：每个"解码成功"都记一笔，等价于一次位图分配 */
function makeCountingDecode() {
  let calls = 0
  const decode = async (url: string): Promise<unknown> => {
    calls += 1
    // 返回一个带 url 标记的假 source（等价于解码出的 bitmap 对象）
    return { __tex: url }
  }
  return { decode, calls: () => calls }
}

describe('OOM 防崩 · 连续切牌内存平稳', () => {
  it('R10-1 同一张牌在容量内只解码一次，decodes 不随切换次数增长', async () => {
    const { decode, calls } = makeCountingDecode()
    const tex: TexLoader = createTexLoader({ decode, maxEntries: 16 })

    // 模拟连续切换 50 次，每次都 ensure 同一批牌（3 张核心牌来回切）
    const deck = ['/tarot/back.webp', '/tarot/fool.webp', '/tarot/magician.webp']
    for (let i = 0; i < 50; i += 1) {
      await tex.ensure(deck[i % deck.length])
    }

    // ★ 关键断言：不管切多少次，每张牌只解码一次（共 3 次），而非 50 次
    expect(calls()).toBe(3)
    expect(tex.size()).toBe(3)
    expect(tex.decodes).toBe(3)
  })

  it('R10-2 缓存项数有硬上界，不随切换线性增长', async () => {
    const { decode } = makeCountingDecode()
    const maxEntries = 8
    const tex: TexLoader = createTexLoader({ decode, maxEntries })

    // 切 40 张不同的牌，远超容量
    for (let i = 0; i < 40; i += 1) {
      await tex.ensure(`/tarot/card-${i}.webp`)
    }

    // ★ 缓存永远不会超过容量上限，内存有界
    expect(tex.size()).toBeLessThanOrEqual(maxEntries)
  })

  it('R10-3 LRU 淘汰：塞满后淘汰最久未用，容量不回弹', async () => {
    const { decode } = makeCountingDecode()
    const tex: TexLoader = createTexLoader({ decode, maxEntries: 4 })

    // 先塞满 4 张
    await tex.ensure('/a.webp')
    await tex.ensure('/b.webp')
    await tex.ensure('/c.webp')
    await tex.ensure('/d.webp')
    expect(tex.size()).toBe(4)

    // 再访问 a（把它变"最近使用"），然后塞入第 5 张 e，应淘汰 b（最久未用）
    await tex.ensure('/a.webp')
    await tex.ensure('/e.webp')

    expect(tex.size()).toBe(4)
    expect(tex.isReady('/a.webp')).toBe(true) // a 被保住
    expect(tex.isReady('/b.webp')).toBe(false) // b 被淘汰
  })

  it('R10-4 加载失败静默降级：返回 null，不抛异常、不崩', async () => {
    const decode = async (url: string): Promise<unknown> => {
      if (url.includes('broken')) throw new Error('network down')
      return { __tex: url }
    }
    const tex: TexLoader = createTexLoader({ decode })

    // 失败必须静默：返回 null，不 throw
    const failed = await tex.ensure('/tarot/broken.webp')
    expect(failed).toBeNull()
    expect(tex.isReady('/tarot/broken.webp')).toBe(false)

    // 成功的仍正常
    const ok = await tex.ensure('/tarot/fool.webp')
    expect(ok).not.toBeNull()
  })

  it('R10-5 并发 ensure 同一 URL 只解码一次（loading 去重）', async () => {
    const { decode, calls } = makeCountingDecode()
    const tex: TexLoader = createTexLoader({ decode })

    // 同一张牌并发请求 10 次，应只解码 1 次
    await Promise.all(
      Array.from({ length: 10 }, () => tex.ensure('/tarot/back.webp')),
    )

    expect(calls()).toBe(1)
  })
})
