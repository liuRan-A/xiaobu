/**
 * 小卜 · 78 张牌面工程管线   tests/tarot-assets.spec.ts
 * ===========================================================================
 * M3 混合渲染「第四步：牌面素材管线」的回归钉。
 *
 * ── 为什么这层要单独钉 ──────────────────────────────────────────────────────
 *   牌面走**两条完全不同的取 URL 路径**（主包静态导入 / CDN 派生），
 *   且素材体积直接顶在门禁②的红线上（单张 ≤100KB·768px、WebP 总量 ≤2048KB）。
 *   一旦有人手滑把 78 张全塞进主包、或把某张图导出成 800px，本文件先红，
 *   而不是等到 CI 门禁才红 —— 报错点离改动点最近。
 *
 * ── 验什么 ──────────────────────────────────────────────────────────────────
 *   ① 索引：78 张（22 大 + 56 小），id / slug 全表唯一，查表函数可预期
 *   ② 路径：主包命中走静态 URL；未命中走 cdnBase 派生；cdnBase 为空 → null
 *   ③ manifest 与实际文件一致：存在、字节数吻合、≤100KB·≤768px、slug 能回到索引
 *   ④ 贴图位状态机：喂入/撤下/清空，且 drawCardFace 两条路径都不抛（门禁⑨）
 * ===========================================================================
 */
import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  CARDS,
  MAJOR_ARCANA,
  MINOR_ARCANA,
  SUITS,
  CARD_COUNT,
  MAJOR_COUNT,
  MINOR_PER_SUIT,
  getCard,
  getCardBySlug,
  cardsOfSuit,
} from '@core/tarot/cardsIndex'
import { CORE_FACE_URLS, isCoreFace, faceFileName, cdnFaceUrl, faceUrl } from '@services/tex/tarotPath'
import {
  setCardFaceTex,
  cardFaceTexReady,
  clearCardFaceTex,
  drawCardFace,
} from '@scene/layers'
import { currentConfig, applyConfig } from '@bootstrap/bootSequence'
import type { XiaobuConfig } from '@bootstrap/builtinConfig'
import type { TexSource } from '@services/tex'
import manifest from '@assets/tarot/manifest.json'
import { makeStubCtx } from './stub-ctx'

const ROOT = path.resolve(__dirname, '..')
/** 门禁② 红线（与 ci/gates/02-no-uncompressed-png.mjs 同源） */
const MAX_BYTES = 102_400
const MAX_EDGE = 768

interface FaceEntry {
  id: string
  slug: string
  file: string
  core: boolean
  bytes: number
  w: number
  h: number
}
const FACES = (manifest as unknown as { faces: FaceEntry[] }).faces
const DIRS = (manifest as unknown as { dirs: { core: string; ondemand: string } }).dirs

// ───────────────────────────────────────────────────────────────────────────
// ① 索引
// ───────────────────────────────────────────────────────────────────────────

describe('78 张牌索引 · cardsIndex', () => {
  it('总数 78 = 大阿卡纳 22 + 小阿卡纳 4 组 × 14', () => {
    expect(CARD_COUNT).toBe(78)
    expect(CARDS.length).toBe(78)
    expect(MAJOR_COUNT).toBe(22)
    expect(MAJOR_ARCANA.length).toBe(22)
    expect(MINOR_PER_SUIT).toBe(14)
    expect(SUITS.length).toBe(4)
    expect(MINOR_ARCANA.length).toBe(4 * 14)
  })

  it('id 与 slug 全表唯一（查表契约的前提）', () => {
    const ids = new Set(CARDS.map((c) => c.id))
    const slugs = new Set(CARDS.map((c) => c.slug))
    expect(ids.size).toBe(78)
    expect(slugs.size).toBe(78)
  })

  it('大阿卡纳：arcana=major、suit=null、num 恰好是 0..21', () => {
    for (const c of MAJOR_ARCANA) {
      expect(c.arcana).toBe('major')
      expect(c.suit).toBeNull()
      expect(c.id).toBe(`major-${String(c.num).padStart(2, '0')}`)
    }
    expect([...MAJOR_ARCANA.map((c) => c.num)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 22 }, (_, i) => i),
    )
  })

  it('小阿卡纳：每组 14 张、num 恰好是 1..14、id = `<suit>-<两位序号>`', () => {
    for (const suit of SUITS) {
      const group = cardsOfSuit(suit)
      expect(group.length).toBe(14)
      expect(group.every((c) => c.suit === suit && c.arcana === 'minor')).toBe(true)
      expect([...group.map((c) => c.num)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 14 }, (_, i) => i + 1),
      )
      for (const c of group) expect(c.id).toBe(`${suit}-${String(c.num).padStart(2, '0')}`)
    }
  })

  it('查表：id / slug 双向命中，未知键返回 null（永不抛）', () => {
    expect(getCard('major-00')?.slug).toBe('the-fool')
    expect(getCardBySlug('the-fool')?.id).toBe('major-00')
    expect(getCardBySlug('wands-ace')?.id).toBe('wands-01')
    // 同一张牌，两条路径拿到同一个对象
    expect(getCard('major-00')).toBe(getCardBySlug('the-fool'))
    // 未知 / 空键 → null，不是异常
    expect(getCard('nope')).toBeNull()
    expect(getCard('')).toBeNull()
    expect(getCardBySlug('nope')).toBeNull()
    expect(getCardBySlug('')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ② 路径解析
// ───────────────────────────────────────────────────────────────────────────

describe('牌面路径 · tarotPath', () => {
  it('CORE_FACE_URLS 的键 = manifest 里 core=true 的 slug，且 URL 非空且互异', () => {
    const coreSlugs = FACES.filter((f) => f.core).map((f) => f.slug).sort()
    expect(Object.keys(CORE_FACE_URLS).sort()).toEqual(coreSlugs)
    const urls = Object.values(CORE_FACE_URLS)
    expect(urls.every((u) => typeof u === 'string' && u.length > 0)).toBe(true)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('主包牌面：isCoreFace=true，faceUrl 命中静态导入（转载零请求）', () => {
    for (const slug of Object.keys(CORE_FACE_URLS)) {
      expect(isCoreFace(slug)).toBe(true)
      expect(faceUrl(slug)).toBe(CORE_FACE_URLS[slug])
    }
  })

  it('非主包牌面：isCoreFace=false，faceUrl = cdnBase × ondemand 目录 × 文件名', () => {
    const slug = 'the-sun'
    expect(isCoreFace(slug)).toBe(false)
    expect(faceFileName(slug)).toBe('the-sun.webp')

    const base = String(currentConfig().assets.cdnBase).replace(/\/+$/, '')
    expect(cdnFaceUrl(slug)).toBe(`${base}/${DIRS.ondemand}the-sun.webp`)
    expect(faceUrl(slug)).toBe(cdnFaceUrl(slug))
    // ★ 路径里不得出现硬编码域名 —— 前缀必须完全等于 config 里的 cdnBase
    expect(faceUrl(slug)!.startsWith(base)).toBe(true)
  })

  it('cdnBase 为空 → 按需牌面取不到 URL（null），走程序化占位', () => {
    const original = currentConfig()
    try {
      applyConfig({
        ...original,
        assets: { ...original.assets, cdnBase: '' },
      } as XiaobuConfig)
      expect(cdnFaceUrl('the-sun')).toBeNull()
      expect(faceUrl('the-sun')).toBeNull()
      // 主包牌面不受 cdnBase 影响，仍可用
      expect(faceUrl('the-fool')).toBe(CORE_FACE_URLS['the-fool'])
    } finally {
      applyConfig(original as XiaobuConfig)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ③ manifest ↔ 实际文件一致
// ───────────────────────────────────────────────────────────────────────────

describe('manifest 与实际文件一致 · 体积/像素红线', () => {
  it('每条登记：文件存在、字节数吻合、≤100KB、单边 ≤768px、slug 能回到索引', () => {
    for (const f of FACES) {
      const abs = path.join(ROOT, 'src', 'assets', DIRS.core, f.file)
      expect(fs.existsSync(abs), `缺失文件：${abs}`).toBe(true)
      expect(fs.statSync(abs).size, `字节数与 manifest 不符：${f.file}`).toBe(f.bytes)

      expect(f.bytes, `${f.file} 超过 100KB 红线`).toBeLessThanOrEqual(MAX_BYTES)
      expect(f.w, `${f.file} 宽超 768px`).toBeLessThanOrEqual(MAX_EDGE)
      expect(f.h, `${f.file} 高超 768px`).toBeLessThanOrEqual(MAX_EDGE)

      const card = getCardBySlug(f.slug)
      expect(card, `manifest 里的 slug 不在 78 张索引里：${f.slug}`).not.toBeNull()
      expect(card!.id).toBe(f.id)
    }
  })

  it('主包牌面数 = CORE_FACE_URLS 条数（登记齐了，没有"声明了却没导入"的漏网）', () => {
    expect(FACES.filter((f) => f.core).length).toBe(Object.keys(CORE_FACE_URLS).length)
  })

  it('WebP 总量 ≤ 2048KB（门禁②的第二道红线，防素材把账顶爆）', () => {
    const total = FACES.reduce((sum, f) => sum + f.bytes, 0)
    expect(total).toBeLessThanOrEqual(2048 * 1024)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// ④ 贴图位状态机（L4Props）
// ───────────────────────────────────────────────────────────────────────────

describe('牌面贴图位 · L4Props', () => {
  beforeEach(() => clearCardFaceTex())

  it('未喂贴图 → 程序化占位路径也不抛（门禁⑨）', () => {
    const { ctx } = makeStubCtx()
    expect(cardFaceTexReady('major-00')).toBe(false)
    expect(() => drawCardFace(ctx, 'major-00', 10, 20, 52, 78, 6)).not.toThrow()
  })

  it('喂入 → 就绪；撤下（null）→ 回落占位；就绪路径 drawImage 不抛', () => {
    const { ctx, calls } = makeStubCtx()
    const fake = { __tex: 'the-fool' } as unknown as TexSource

    setCardFaceTex('major-00', fake)
    expect(cardFaceTexReady('major-00')).toBe(true)
    drawCardFace(ctx, 'major-00', 0, 0, 52, 78, 6)
    expect(calls).toContain('drawImage')

    setCardFaceTex('major-00', null)
    expect(cardFaceTexReady('major-00')).toBe(false)
  })

  it('clearCardFaceTex 清空全部', () => {
    setCardFaceTex('major-00', { __tex: 'a' } as unknown as TexSource)
    setCardFaceTex('major-17', { __tex: 'b' } as unknown as TexSource)
    expect(cardFaceTexReady('major-00')).toBe(true)
    expect(cardFaceTexReady('major-17')).toBe(true)
    clearCardFaceTex()
    expect(cardFaceTexReady('major-00')).toBe(false)
    expect(cardFaceTexReady('major-17')).toBe(false)
  })
})
