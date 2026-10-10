/**
 * 小卜 · 贴图加载与降级   src/services/tex/loader.ts
 * ===========================================================================
 * M3 混合渲染的"皮"层：只负责把 WebP 贴图**按需、有界、可降级**地交给场景层，
 * **绝不**参与几何 / 交互 / 物理（那些永远由 Canvas 程序化绘制，见 L4Props）。
 *
 * ── 三条铁律（对应《M3 美术接入规范》§4 / §6）──────────────────────────────
 *   ① **有界缓存（LRU）**：贴图解码后的对象数量有硬上限。连续切 50 次塔罗牌，
 *      内存曲线必须平稳 —— 靠的是"容量上限 + 淘汰最久未用"，而不是无限累积。
 *      OOM 防崩测试（tests/tarot-memory.spec.ts）直接断言这一点。
 *   ② **加载失败无感降级**：加载中 / 加载失败，调用方拿到 `null`（或未就绪），
 *      由它走**程序化占位**（Canvas 画同尺寸轮廓）。本模块**不弹 UI、不抛异常**。
 *      唯一的副作用是 `logger.warn` 一次。
 *   ③ **绝不阻塞主线程 / 不挂定时器 / 不落盘**：异步解码走 Promise；失败即丢，
 *      不建重试队列。这里不碰任何持久化存储（门禁⑩ 的同类约束）。
 *
 * ★ 为什么把"解码后的 bitmap"而不是"URL"当缓存值：
 *   一次解码 = 一份 RGBA 内存。切牌时反复 `new Image()` + 等 onload，
 *   等于每次重解码，50 次就是 50 份。缓存 bitmap 后，同一张牌只解码一次。
 * ===========================================================================
 */
import { logger } from '@shared/logger'

/**
 * 解码后的贴图。★ 用 `HTMLImageElement`（或等价可绘制源）而非二进制，
 *   因为 Canvas 的 `drawImage` 直接吃它，省一层转换。
 *   类型用 `unknown` 收窄到"可 drawImage 的源"，避免强依赖 DOM 类型在 node 测试里炸。
 */
export type TexSource = unknown

/** 单张贴图的加载结果状态：未开始 / 加载中 / 已就绪 / 失败 */
export type TexStatus = 'idle' | 'loading' | 'ready' | 'failed'

interface CacheEntry {
  status: TexStatus
  source: TexSource | null
  lastUsed: number
}

/**
 * 加载选项。
 * @param fetchImpl   注入图片解码函数，测试时替换成假 Image 以统计解码次数。
 * @param maxEntries  LRU 容量上限。默认 32（主包核心牌 + 少量按需，远低于一次切牌会话）。
 */
export interface TexLoaderOptions {
  decode?: (url: string) => Promise<TexSource>
  maxEntries?: number
}

/** 默认解码：用 HTMLImageElement 加载（浏览器 / WebView 环境） */
async function defaultDecode(url: string): Promise<TexSource> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      reject(new Error('no Image constructor'))
      return
    }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`load failed: ${url}`))
    img.src = url
  })
}

/**
 * 有界贴图加载器（单例语义，但允许测试传入独立实例）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────
 *   const tex = createTexLoader()
 *   await tex.prefetch('/assets/tarot/back.webp')       // 进场前预热卡背
 *   const back = tex.get('/assets/tarot/back.webp')     // 同步取（可能 null）
 *   const back2 = await tex.ensure('/assets/tarot/back.webp') // 异步确保就绪
 */
export function createTexLoader(options: TexLoaderOptions = {}): TexLoader {
  return new TexLoader(options)
}

export class TexLoader {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly decode: (url: string) => Promise<TexSource>
  private readonly maxEntries: number
  private decodeCount = 0
  /** ★ LRU 用单调递增访问序号，而非 Date.now()：同毫秒内的多次访问才能严格区分先后 */
  private accessSeq = 0

  constructor(options: TexLoaderOptions = {}) {
    this.decode = options.decode ?? defaultDecode
    this.maxEntries = options.maxEntries ?? 32
  }

  /** 同步取已就绪的贴图；未就绪返回 null（调用方走程序化占位） */
  get(url: string): TexSource | null {
    const e = this.cache.get(url)
    if (!e || e.status !== 'ready' || e.source === null) return null
    e.lastUsed = this.now()
    return e.source
  }

  /** 是否已就绪（不触发加载） */
  isReady(url: string): boolean {
    return this.cache.get(url)?.status === 'ready'
  }

  /** 预热：加载但不要求立即拿到。失败静默（不抛、不弹 UI） */
  async prefetch(url: string): Promise<void> {
    await this.ensure(url)
  }

  /**
   * 确保就绪：已缓存直接返回；未缓存则解码并缓存。失败返回 null。
   *
   * ★ 并发去重：同一 url 在加载中时，复用同一个挂起 Promise（inflight），
   *   不重复解码。这里用 `load()` 统一承载解码，`ensure` 只负责"取或发起"，
   *   避免 ensure ↔ awaitLoad 互相调用导致的递归。
   */
  async ensure(url: string): Promise<TexSource | null> {
    const hit = this.cache.get(url)
    if (hit) {
      hit.lastUsed = this.now()
      if (hit.status === 'ready' && hit.source !== null) return hit.source
      if (hit.status === 'loading') {
        // 加载中：复用挂起的 inflight Promise（若已被并发删除则重试 load）
        const pending = this.inflight.get(url)
        if (pending) return pending
        return this.load(url)
      }
      // failed：下次调用重试（不占缓存，但此刻返回 null）
      return null
    }

    // 未缓存：发起加载（load 内部会写 cache + inflight 去重）
    return this.load(url)
  }

  /** 进行中的加载，用于并发去重 */
  private inflight = new Map<string, Promise<TexSource | null>>()

  /** 真正执行解码并写缓存。★ 只此一处调用 decode，保证"同 url 只解码一次" */
  private async load(url: string): Promise<TexSource | null> {
    const existing = this.inflight.get(url)
    if (existing) return existing

    const entry: CacheEntry = { status: 'loading', source: null, lastUsed: this.now() }
    this.cache.set(url, entry)
    this.evict()

    const p = this.decode(url)
      .then((src) => {
        entry.status = 'ready'
        entry.source = src
        entry.lastUsed = this.now()
        this.decodeCount += 1
        return src as TexSource
      })
      .catch((e) => {
        entry.status = 'failed'
        entry.source = null
        // 失败不占用缓存（下次仍可重试），但保留 failed 状态避免同帧反复重试
        logger.warn('[tex] decode failed, fallback to procedural placeholder', e)
        return null
      })
      .finally(() => {
        this.inflight.delete(url)
      })

    this.inflight.set(url, p)
    return p
  }

  /** LRU 淘汰：超容量时逐出最久未用（且非 loading，避免打断进行中的解码） */
  private evict(): void {
    while (this.cache.size > this.maxEntries) {
      let oldestKey: string | null = null
      let oldest = Infinity
      for (const [k, e] of this.cache) {
        if (e.status === 'loading') continue
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed
          oldestKey = k
        }
      }
      if (oldestKey === null) break // 全是 loading，容量暂时溢出，等下一轮
      this.cache.delete(oldestKey)
    }
  }

  /** 当前缓存项数（供 OOM 测试断言有界） */
  size(): number {
    return this.cache.size
  }

  /** 累计解码次数（供 OOM 测试断言"同牌只解码一次"） */
  get decodes(): number {
    return this.decodeCount
  }

  /** 清空（测试复位用） */
  reset(): void {
    this.cache.clear()
    this.inflight.clear()
    this.decodeCount = 0
  }

  /** 每次访问返回一个严格递增的序号，作为 LRU 的"最近使用"依据 */
  private now(): number {
    this.accessSeq += 1
    return this.accessSeq
  }
}
