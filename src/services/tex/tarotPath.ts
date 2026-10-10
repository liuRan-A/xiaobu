/**
 * 小卜 · 牌面路径解析   src/services/tex/tarotPath.ts
 * ===========================================================================
 * 牌面资产分两类，**取 URL 的方式不同**，这份文件是唯一说清楚这件事的地方：
 *
 *   · 主包牌面（core）：确实进包、随 App 一起下发 —— 必须由 **Vite 静态导入**，
 *     产物里带哈希，转载时零网络请求。就那几张（骨架期的样张），静态登记最省心。
 *   · 按需牌面（ondemand）：78 张里的大多数 —— **不入主包**，走 CDN 按需拉取。
 *     它们的 URL 由 `config.assets.cdnBase` 派生，**本文件里没有任何硬编码域名**
 *     （门禁⑤⑧：配置里只有开关 / 数值 / 公开 URL，绝无密钥）。
 *
 * ★ 为什么主包牌面不能也"由 cdnBase 派生"：
 *   主包资产在打包时才知道最终 URL（文件名含内容哈希）。让它走 CDN 反而要
 *   把哈希写死，等于把构建产物钉进源码 —— 更脆。所以：主包走静态导入，
 *   按需走 CDN，各用各的正确方式。
 *
 * ★ 主包那张清单以 `src/assets/tarot/manifest.json` 为准（由 scripts/bake-tarot-samples.py 生成），
 *   新增主包牌面 = ①烘焙 ②登记白名单 ③在下方的静态导入里加一行。
 * ===========================================================================
 */

import { currentConfig } from '@bootstrap/bootSequence'
import manifest from '@assets/tarot/manifest.json'
// ★ 主包样张：Vite 静态导入 ⇒ 产物内带哈希 URL（转载零请求）。新增主包牌面在此登记。
import foolUrl from '@assets/tarot/faces/core/the-fool.webp'
import moonUrl from '@assets/tarot/faces/core/the-moon.webp'
import starUrl from '@assets/tarot/faces/core/the-star.webp'

export interface FaceManifestEntry {
  readonly id: string
  readonly slug: string
  readonly file: string
  readonly core: boolean
  readonly bytes: number
  readonly w: number
  readonly h: number
}

interface TarotManifest {
  readonly schemaVersion: number
  readonly dirs: { readonly core: string; readonly ondemand: string }
  readonly faces: readonly FaceManifestEntry[]
}

const MF = manifest as unknown as TarotManifest

/** ★ 主包牌面 slug → 打包产物 URL。由上面三个静态导入而来，不在运行时拼装 */
export const CORE_FACE_URLS: Readonly<Record<string, string>> = Object.freeze({
  'the-fool': foolUrl,
  'the-moon': moonUrl,
  'the-star': starUrl,
})

const CORE_SLUGS: ReadonlySet<string> = new Set(
  MF.faces.filter((f) => f.core).map((f) => f.slug),
)
const FILE_BY_SLUG: ReadonlyMap<string, string> = new Map(MF.faces.map((f) => [f.slug, f.file]))

/** 这张牌面是否进主包（决定"静态导入"还是"走 CDN"）。 */
export function isCoreFace(slug: string): boolean {
  return CORE_SLUGS.has(slug)
}

/** 牌面文件名。★ 以 manifest 为准；manifest 里没有则按 `<slug>.webp` 约定推导。 */
export function faceFileName(slug: string): string {
  return FILE_BY_SLUG.get(slug) ?? `${slug}.webp`
}

/**
 * 按需牌面的 CDN URL。
 * ★ 基址来自 `config.assets.cdnBase`（公开 URL），本函数**不含任何硬编码域名**。
 * `cdnBase` 为空 ⇒ 返回 null（调用方走程序化占位，与"贴图未就绪"同一条降级路径）。
 */
export function cdnFaceUrl(slug: string): string | null {
  const base = String(currentConfig().assets.cdnBase ?? '').replace(/\/+$/, '')
  if (!base) return null
  return `${base}/${MF.dirs.ondemand}${faceFileName(slug)}`
}

/**
 * 取一张牌面的 URL：主包命中则回打包产物 URL；否则拼 CDN URL。
 * @returns null = 拿不到（主包声明了却没静态登记 / cdnBase 为空）⇒ 走程序化占位
 */
export function faceUrl(slug: string): string | null {
  const core = CORE_FACE_URLS[slug]
  if (core) return core
  if (isCoreFace(slug)) return null // 声明在主包但没登记静态导入 —— 视为未就绪
  return cdnFaceUrl(slug)
}
