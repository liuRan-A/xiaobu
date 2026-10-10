/**
 * 小卜 · 牌面运行时加载   tests/tarot-card-faces.spec.ts
 * ===========================================================================
 * `services/tex/cardFaces.ts` 的回归钉 —— 它是「78 张牌面」与「渲染层」之间
 * 唯一的那道门。tarot-assets.spec.ts 已经钉住了**路径怎么算**（tarotPath），
 * 本文件钉住**路径怎么被用**：牌 id → 主包静态 / CDN 派生 → 解码 → 有界缓存。
 *
 * ── 验什么 ──────────────────────────────────────────────────────────────────
 *   ① 主包牌面：resolveCardFaceUrl 命中静态导入 URL，decode 拿到的就是它
 *   ② 按需牌面：resolveCardFaceUrl 由 cdnBase 派生（含 ondemand 目录），decode 拿到该 URL
 *   ③ cdnBase 为空 → 按需牌面解析为 null（不发起解码）⇒ 程序化占位；主包不受影响
 *   ④ 未知牌 id → null（永不抛），不发起解码
 *   ⑤ 解码失败 → null（门禁⑨：静默降级，绝不抛）
 *   ⑥ 有界：连续加载远超容量上限的不同牌面，缓存项数不越界（OOM 红线）
 *   ⑦ 同牌重复加载只解码一次（LRU 去重）
 * ===========================================================================
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadCardFace,
  resolveCardFaceUrl,
  isCardFaceLoaded,
  __test_resetCardFaces,
  __test_cardFaceCacheSize,
  __test_cardFaceDecodes,
} from '@services/tex'
import { CORE_FACE_URLS, cdnFaceUrl } from '@services/tex/tarotPath'
import { getCardBySlug } from '@core/tarot/cardsIndex'
import { currentConfig, applyConfig } from '@bootstrap/bootSequence'
import type { XiaobuConfig } from '@bootstrap/builtinConfig'

/** 伪造解码：每次调用记一笔（等价于一次位图分配），URL 含 'BROKEN' 则失败 */
function makeDecode() {
  let calls = 0
  const urls: string[] = []
  const decode = async (url: string): Promise<unknown> => {
    calls += 1
    urls.push(url)
    if (url.includes('BROKEN')) throw new Error('network down')
    return { __tex: url }
  }
  return { decode, calls: () => calls, urls: () => urls }
}

beforeEach(() => __test_resetCardFaces())

// ───────────────────────────────────────────────────────────────────────────
// ① 主包牌面
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · 主包静态路径', () => {
  it('resolveCardFaceUrl(主包牌 id) = 静态导入 URL（转载零请求）', () => {
    const fool = getCardBySlug('the-fool')!
    expect(resolveCardFaceUrl(fool.id)).toBe(CORE_FACE_URLS['the-fool'])
  })

  it('loadCardFace(主包牌) → 就绪；decode 收到的正是静态 URL；同牌只解码一次', async () => {
    const { decode, calls, urls } = makeDecode()
    const fool = getCardBySlug('the-fool')!

    const first = await loadCardFace(fool.id, { decode, maxEntries: 8 })
    expect(first).not.toBeNull()
    expect(isCardFaceLoaded(fool.id)).toBe(true)

    // 反复取同一张：命中缓存，不再解码
    await loadCardFace(fool.id)
    await loadCardFace(fool.id)
    expect(calls()).toBe(1)
    expect(urls()[0]).toBe(CORE_FACE_URLS['the-fool'])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② 按需牌面（CDN 派生）
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · 按需 CDN 路径', () => {
  it('resolveCardFaceUrl(按需牌 id) = cdnBase × ondemand × 文件名', () => {
    const sun = getCardBySlug('the-sun')!
    const base = String(currentConfig().assets.cdnBase).replace(/\/+$/, '')
    const url = resolveCardFaceUrl(sun.id)

    expect(url).not.toBeNull()
    expect(url).toBe(cdnFaceUrl('the-sun'))
    expect(url!.startsWith(base)).toBe(true)
    expect(url!).toContain('tarot/faces/ondemand/')
    expect(url!.endsWith('the-sun.webp')).toBe(true)
  })

  it('loadCardFace(按需牌) 把 CDN URL 交给 decode', async () => {
    const { decode, urls } = makeDecode()
    const sun = getCardBySlug('the-sun')!

    const src = await loadCardFace(sun.id, { decode })
    expect(src).not.toBeNull()
    expect(urls()).toEqual([cdnFaceUrl('the-sun')])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ cdnBase 为空 → 按需牌面降级（主包不受影响）
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · cdnBase 为空时降级', () => {
  it('按需牌解析/加载均为 null（不发起解码）；主包牌仍可用', async () => {
    const original = currentConfig()
    const { decode, calls } = makeDecode()
    try {
      applyConfig({
        ...original,
        assets: { ...original.assets, cdnBase: '' },
      } as XiaobuConfig)

      const sun = getCardBySlug('the-sun')!
      expect(resolveCardFaceUrl(sun.id)).toBeNull()
      expect(await loadCardFace(sun.id, { decode })).toBeNull()
      expect(isCardFaceLoaded(sun.id)).toBe(false)
      // ★ 拿不到基址就**根本不该**发起解码 —— 连一个字节都不出网
      expect(calls()).toBe(0)

      // 主包牌面不受 cdnBase 影响
      const fool = getCardBySlug('the-fool')!
      expect(resolveCardFaceUrl(fool.id)).toBe(CORE_FACE_URLS['the-fool'])
      expect(await loadCardFace(fool.id, { decode })).not.toBeNull()
    } finally {
      applyConfig(original as XiaobuConfig)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ 未知牌 id
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · 未知牌 id', () => {
  it('解析 / 加载 / 就绪查询全部返回 null|false，且不发起解码（永不抛）', async () => {
    const { decode, calls } = makeDecode()
    expect(resolveCardFaceUrl('nope-99')).toBeNull()
    expect(resolveCardFaceUrl('')).toBeNull()
    expect(await loadCardFace('nope-99', { decode })).toBeNull()
    expect(isCardFaceLoaded('nope-99')).toBe(false)
    expect(calls()).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ⑤ 解码失败 → 静默降级
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · 解码失败静默降级（门禁⑨）', () => {
  it('decode 抛错 → loadCardFace 返回 null，不抛、不崩', async () => {
    const decode = async (url: string): Promise<unknown> => {
      if (url.includes('the-sun')) throw new Error('boom')
      return { __tex: url }
    }
    const sun = getCardBySlug('the-sun')!
    const fool = getCardBySlug('the-fool')!

    const failed = await loadCardFace(sun.id, { decode })
    expect(failed).toBeNull()
    expect(isCardFaceLoaded(sun.id)).toBe(false)

    // 同一次失败不影响其它牌
    const ok = await loadCardFace(fool.id)
    expect(ok).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ⑥⑦ 有界缓存（OOM 红线）
// ───────────────────────────────────────────────────────────────────────────

describe('牌面加载 · 有界缓存', () => {
  it('连续加载远超容量的按需牌面，缓存项数不越界', async () => {
    const { decode } = makeDecode()
    const maxEntries = 8
    // 用 50 个不同的按需牌 id 撑爆容量（78 张里取 50 张）
    const ids = [
      ...Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, '0')}`),
      ...Array.from({ length: 28 }, (_, i) => `wands-${String(i + 1).padStart(2, '0')}`),
    ]
    // 首调用注入 decode 与容量（单例只认第一次）
    await loadCardFace(ids[0], { decode, maxEntries })
    for (const id of ids.slice(1)) await loadCardFace(id)

    expect(__test_cardFaceCacheSize()).toBeLessThanOrEqual(maxEntries)
    // 至少这次会话确实解码了多张（证明确实在加载，而不是全被挡掉）
    expect(__test_cardFaceDecodes()).toBeGreaterThan(1)
  })
})
