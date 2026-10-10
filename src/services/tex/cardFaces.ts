/**
 * 小卜 · 牌面运行时加载   src/services/tex/cardFaces.ts
 * ===========================================================================
 * 把「78 张塔罗牌面」从**一堆资产**变成「牌 id → 一张可绘制的解码贴图」的那一步。
 *
 * ── 两条取 URL 的路，在这里统一收口 ─────────────────────────────────────────
 *   · 主包样张（core）：`faceUrl()` 命中静态导入的打包 URL —— 转载零网络请求
 *   · 按需牌面（ondemand）：`faceUrl()` 由 `config.assets.cdnBase` 派生 CDN URL
 *   本文件**不判断该走哪条**，只把 `faceUrl()` 的结果交给 TexLoader —— 双路径的
 *   分叉只存在于 `tarotPath.ts` 一处。这里再写一份必然漂移。
 *
 * ── 唯一出口永不变 ──────────────────────────────────────────────────────────
 *   `loadCardFace(id)` **永不抛**：返回 TexSource = 就绪；返回 null = 未就绪
 *   （未知牌 id / cdnBase 为空 / 解码失败）⇒ 调用方走**程序化占位** ——
 *   这正是贴图层一贯的降级契约（见 `loader.ts` 头注）。
 *
 * ★ 有界：底层 TexLoader 是 LRU（容量上限 + 同 URL 只解码一次），
 *   连切 50 张牌内存平稳 —— OOM 红线由 tests/tarot-memory.spec.ts 钉住。
 * ★ 门禁⑨：catch 内只 logger.warn，绝不弹 UI、绝不冒泡。
 * ★ 门禁⑤⑧：本文件不含任何硬编码域名 —— CDN 基址只从 config 派生。
 * ===========================================================================
 */
import { logger } from '@shared/logger'
import { getCard } from '@core/tarot/cardsIndex'
import { createTexLoader, type TexLoader, type TexLoaderOptions, type TexSource } from './loader'
import { faceUrl } from './tarotPath'

/**
 * 模块级单例：78 张牌面共用一个有界缓存。
 * ★ 与 Scene.vue 里加载卡背的那个加载器**各管各的**（卡背 1 张、牌面 78 张，
 *   两边的热区与容量诉求不同，合并没有任何好处，反而互相挤占 LRU）。
 */
let loader: TexLoader | null = null

function getLoader(opts?: TexLoaderOptions): TexLoader {
  if (loader === null) loader = createTexLoader(opts)
  return loader
}

/**
 * 牌 id → 牌面 URL。
 * @returns 主包静态 URL / CDN 派生 URL；未知牌 id 或按需牌面拿不到基址时 = null
 */
export function resolveCardFaceUrl(id: string): string | null {
  const card = getCard(id)
  if (!card) return null
  return faceUrl(card.slug)
}

/**
 * 确保某张牌的牌面就绪。
 *
 * @returns 解码后的贴图；`null` = 未就绪（未知牌 / cdnBase 为空 / 解码失败），
 *          调用方据此走程序化占位。**永不抛。**
 * @param opts 仅首次调用生效（决定单例加载器的 decode / 容量），测试注入用
 */
export async function loadCardFace(id: string, opts?: TexLoaderOptions): Promise<TexSource | null> {
  const url = resolveCardFaceUrl(id)
  if (!url) return null
  try {
    return await getLoader(opts).ensure(url)
  } catch (e) {
    // ★ 门禁⑨：解码 / 网络异常静默回落程序化占位，绝不弹 UI
    logger.warn('[tex] 牌面加载异常（回落程序化占位）', e)
    return null
  }
}

/** 该牌面是否已就绪（不触发加载）—— 供渲染层决定这一帧画贴图还是画占位 */
export function isCardFaceLoaded(id: string): boolean {
  const url = resolveCardFaceUrl(id)
  if (!url || loader === null) return false
  return loader.isReady(url)
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：丢弃当前加载器（跨用例隔离 —— 每个用例可注入自己的 decode） */
export function __test_resetCardFaces(): void {
  loader = null
}

/** 测试：当前缓存项数（断言有界） */
export function __test_cardFaceCacheSize(): number {
  return loader?.size() ?? 0
}

/** 测试：累计解码次数（断言同牌只解码一次） */
export function __test_cardFaceDecodes(): number {
  return loader?.decodes ?? 0
}
