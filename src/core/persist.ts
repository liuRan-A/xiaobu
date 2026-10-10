/**
 * 小卜 · 低频本地持久化   src/core/persist.ts
 * ===========================================================================
 * 战略原文：
 *   「记忆锚点 …… **纯本地存储（禁用高并发 LocalStorage 与 IndexedDB）**，
 *     绝对不做社交分享。」
 *   「倒计时 …… **纯本地时间戳计算，无网络依赖，绝不允许弹报错**。」
 *
 * ── 「禁用高并发 LocalStorage 与 IndexedDB」怎么落 ──────────────────────────
 *   这句话有两半，落地方式完全不同：
 *
 *   ① **禁 IndexedDB** —— 一个字面约束。全仓不许出现 `indexedDB` / `IDBFactory` /
 *      `idb` 依赖。由 **门禁⑬** 自动拦（本文件里也没有任何浏览器 API）。
 *
 *   ② **禁「高并发」LocalStorage** —— 不是禁 localStorage 本身（它在 Web 端
 *      仍是唯一可用的同步键值库），而是禁**高频写**。WebView 里的 localStorage
 *      是同步的、会阻塞主线程，而且 Android 上是**整文件重写**：
 *      逐帧写 = 每秒把整个 JSON 序列化+落盘几十次 = 掉帧 + 闪存磨损 + OOM 风险。
 *
 *   所以本文件的策略是：**内存是唯一真相，落盘是低频副作用**。
 *     · 读：启动时 `loadAll()` 一次，之后全走内存（同步、零延迟、不可能失败）。
 *     · 写：`set()` 只标脏 + 记账，**不落盘**；由 `flush()` 按预算合并写入。
 *     · 预算：同键合并窗口 `coalesceMs` + 每分钟写入次数上限。
 *     · 兜底：任何一步出错都只 `logger.warn`，内存态保持可用（门禁 ⑨）。
 *
 * ── 为什么 port 定义在 core、实现放在 @store ────────────────────────────────
 *   ESLint 禁令 1：`src/core/**` 零依赖（不许 import @store / @capacitor）。
 *   所以这里只定义**端口** `LocalPort`，真实现（Capacitor Preferences / localStorage）
 *   在 `src/store/localStore.ts`，由应用层（main.ts）注入。
 *   好处意外地大：核心逻辑在 node 里用 `createMemoryPort()` 就能完整跑，
 *   "存储挂了会怎样"因此可以被单测证明，而不是靠人拿手机拔电源试。
 * ===========================================================================
 */

import { logger } from '@shared/logger'

// ───────────────────────────────────────────────────────────────────────────
// 端口
// ───────────────────────────────────────────────────────────────────────────

/**
 * 存储端口。
 * ★ 契约里最重要的一条：**实现必须永不抛异常**。
 *   `loadAll()` 失败返回 `{}`；`save()` / `remove()` 失败静默吞掉。
 *   理由：持久化失败不该让用户损失任何一次占卜 —— 数据丢了是遗憾，闪退是事故。
 */
export interface LocalPort {
  /** 一次性读出全部键值（启动时调一次） */
  loadAll(): Promise<Record<string, unknown>>
  /** 写入单个键（value 为已序列化字符串） */
  save(key: string, value: string): Promise<void>
  /** 删除单个键 */
  remove(key: string): Promise<void>
}

/**
 * 内存端口 —— 测试与"存储彻底不可用"时的兜底实现。
 * 它同时是 `createMemoryPort().dump()` 的取数口，方便断言"到底写了什么"。
 */
export interface MemoryPort extends LocalPort {
  dump(): Record<string, unknown>
  /** 让后续所有写入都失败 —— 用来测"存储挂了核心逻辑还活不活" */
  setBroken(broken: boolean): void
}

// ───────────────────────────────────────────────────────────────────────────
// 键名（集中一处 —— 散落的字符串键名是"改了一半"的经典来源）
// ───────────────────────────────────────────────────────────────────────────

export const PERSIST_KEYS = {
  /** 记忆锚点：用户摆进小屋的物件与当时的记录 */
  memory: 'xiaobu.memory.v1',
  /** 倒计时：用户设定的目标日期 */
  countdown: 'xiaobu.countdown.v1',
  /** 引导：哪些区域/阶段已经看过引导（只在首次出现） */
  guide: 'xiaobu.guide.v1',
  /** 口味的余温：上一次选的心情与问事方向（只用来让下次少问一步，不参与占卜结果） */
  affinity: 'xiaobu.affinity.v1',
  /** 共情对话：云端通道的用户同意（仅在 'on' 时原话才走独立的 /api/chat 出端；默认 'off'） */
  empathyConsent: 'xiaobu.empathy.consent.v1',
  /** 语音输入：音频出端的用户同意（仅在 'on' 时录音才走独立的 /api/asr 出端；默认 'off'） */
  voiceConsent: 'xiaobu.voice.consent.v1',
  /** 背景音：静音偏好（true = 用户关掉了环境音；默认 false） */
  audioMuted: 'xiaobu.audio.muted.v1',
} as const

export type PersistKey = (typeof PERSIST_KEYS)[keyof typeof PERSIST_KEYS]

// ───────────────────────────────────────────────────────────────────────────
// 写预算
// ───────────────────────────────────────────────────────────────────────────

export interface PersistBudget {
  /** 同一个键两次落盘之间的最小间隔（ms）—— 合并窗口 */
  coalesceMs: number
  /** 每分钟最多落盘多少次（所有键合计）—— 硬上限 */
  maxWritesPerMinute: number
  /** 单键载荷上限（字节）。超过就整键丢弃并记账，不做截断 */
  maxBytesPerKey: number
}

/**
 * ★ 默认预算的取值理由：
 *   · coalesceMs 1500 —— 用户连点几下、连续放两个摆件，都合并成一次写。
 *   · 12 次/分 —— 即使活跃操作，也远低于"让人感觉到卡"的量级；
 *     这个上限的真正作用是**兜住意外**（比如某个循环里误调 set）。
 *   · 64 KB/键 —— 记忆锚点按每条 ~200 字节算，够存 300 多条，
 *     超出说明是程序写错了（比如把整张牌库塞进来了），宁可丢也不要撑爆配额。
 */
export const PERSIST_BUDGET: PersistBudget = {
  coalesceMs: 1500,
  maxWritesPerMinute: 12,
  maxBytesPerKey: 64 * 1024,
}

export interface PersistStats {
  /** 成功落盘次数 */
  writes: number
  /** 因超预算/超大小/端口报错而被丢弃的写入次数 */
  dropped: number
  /** 因载荷超限被整键淘汰的键（去重） */
  oversize: string[]
  /** 最近一次成功落盘的时刻 */
  lastWriteAt: number
}

// ───────────────────────────────────────────────────────────────────────────
// 带预算的存储
// ───────────────────────────────────────────────────────────────────────────

/**
 * 用法：
 * ```ts
 * const store = new PersistedStore(port)
 * await store.load()                     // 启动时一次
 * store.set(PERSIST_KEYS.memory, items)  // 想写就写，不关心落盘
 * await store.flush(now)                 // 定时 / 切后台 / 退出前
 * ```
 */
export class PersistedStore {
  private readonly port: LocalPort
  private readonly budget: PersistBudget
  /** 内存真相 —— 读永远走这里 */
  private data: Record<string, unknown> = {}
  /** 待落盘的键 */
  private dirtyKeys = new Set<string>()
  /** 每个键最近一次落盘时刻 */
  private readonly lastWriteAt = new Map<string, number>()
  /** 滑动窗口内的落盘时刻 */
  private writeWindow: number[] = []
  private stats: PersistStats = { writes: 0, dropped: 0, oversize: [], lastWriteAt: 0 }
  private loaded = false

  constructor(port: LocalPort, budget: PersistBudget = PERSIST_BUDGET) {
    this.port = port
    this.budget = budget
  }

  /** 启动时读一次。★ 失败不抛、不阻塞：读不到就是全新用户 */
  async load(): Promise<void> {
    try {
      const raw = await this.port.loadAll()
      // 只收白名单里的键 —— 端口实现可能顺手带来了别人的数据
      for (const k of Object.values(PERSIST_KEYS)) {
        if (raw && Object.prototype.hasOwnProperty.call(raw, k)) this.data[k] = raw[k]
      }
      this.loaded = true
    } catch (e) {
      // ★ 门禁 ⑨：catch 内不许出 UI。读不到存储 = 全新用户，不是错误。
      logger.warn('[persist] loadAll 失败，按全新用户处理', e)
    }
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  /** 同步读。永远不返回 undefined（有 fallback），永远不抛 */
  get<T>(key: string, fallback: T): T {
    const v = this.data[key]
    return v === undefined ? fallback : (v as T)
  }

  has(key: string): boolean {
    return this.data[key] !== undefined
  }

  /**
   * 标脏。**不落盘**。
   * @returns 是否被接受。false 有两个原因：载荷超限、或序列化失败。
   *          两种情况都只记账 + warn，调用方不需要做任何补救 ——
   *          内存态已经更新了，用户这一局完全正常。
   */
  set(key: string, value: unknown): boolean {
    let serialized: string
    try {
      serialized = JSON.stringify(value)
    } catch (e) {
      this.stats.dropped++
      logger.warn(`[persist] 键 ${key} 序列化失败，丢弃`, e)
      return false
    }

    const bytes = byteLength(serialized)
    if (bytes > this.budget.maxBytesPerKey) {
      this.stats.dropped++
      if (!this.stats.oversize.includes(key)) this.stats.oversize.push(key)
      logger.warn(`[persist] 键 ${key} 载荷 ${bytes}B 超过上限 ${this.budget.maxBytesPerKey}B，整键丢弃`)
      return false
    }

    this.data[key] = value
    this.dirtyKeys.add(key)
    return true
  }

  /** 删除（也走合并写） */
  remove(key: string): void {
    delete this.data[key]
    this.dirtyKeys.add(key)
  }

  /** 现在可以落盘的键（合并窗口已过 + 还有分钟配额） */
  dirty(now: number): string[] {
    const ready: string[] = []
    for (const k of this.dirtyKeys) {
      const last = this.lastWriteAt.get(k) ?? -Infinity
      if (now - last >= this.budget.coalesceMs) ready.push(k)
    }
    return ready
  }

  /**
   * 落盘。
   * @param now    当前时刻（注入，便于单测）
   * @param force  true = 忽略合并窗口（切后台 / 退出前用）。
   *               ★ 但**仍受分钟配额约束**：配额的意义是保护主线程，
   *                 而"退出前猛写 50 次"正是它要挡的事。
   * @returns 本次真正写成功的键
   */
  async flush(now: number, force = false): Promise<string[]> {
    this.pruneWindow(now)

    const candidates = force ? [...this.dirtyKeys] : this.dirty(now)
    const written: string[] = []

    for (const key of candidates) {
      if (this.writeWindow.length >= this.budget.maxWritesPerMinute) {
        // 配额用尽：保持脏，等下一次 flush。★ 不是错误，只是往后挪。
        logger.warn('[persist] 分钟配额用尽，剩余写入顺延')
        break
      }

      const has = Object.prototype.hasOwnProperty.call(this.data, key)
      try {
        if (has) await this.port.save(key, JSON.stringify(this.data[key]))
        else await this.port.remove(key)
        written.push(key)
        this.dirtyKeys.delete(key)
        this.writeWindow.push(now)
        this.lastWriteAt.set(key, now)
        this.stats.writes++
        this.stats.lastWriteAt = now
      } catch (e) {
        // ★ 门禁 ⑨：catch 内不许出 UI。写失败就保持脏，下次再试；内存态不受影响。
        this.stats.dropped++
        logger.warn(`[persist] 键 ${key} 落盘失败（保持脏，稍后重试）`, e)
      }
    }

    return written
  }

  /** 还剩多少脏键没落盘（给"还有东西没保存"这类内部判断用，不展示给用户） */
  get pendingCount(): number {
    return this.dirtyKeys.size
  }

  getStats(): PersistStats {
    return { ...this.stats, oversize: [...this.stats.oversize] }
  }

  /** 60s 滑动窗口 —— 用注入的 now，不用 Date.now()，否则单测没法确定性地测配额 */
  private pruneWindow(now: number): void {
    const cutoff = now - 60_000
    this.writeWindow = this.writeWindow.filter((t) => t > cutoff)
  }
}

/** UTF-8 字节数。用 Buffer / TextEncoder 均可，优先 TextEncoder（浏览器与 node 都有） */
export function byteLength(s: string): number {
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length
  } catch {
    /* 退到下面的估算 */
  }
  // 极少走到：退化估算，宁可高估（高估只会更早丢弃，不会撑爆配额）
  return s.length * 3
}

/** 建一个内存端口。测试与"存储彻底不可用"的兜底都用它。 */
export function createMemoryPort(seed: Record<string, unknown> = {}): MemoryPort {
  const data: Record<string, unknown> = { ...seed }
  let broken = false

  const parse = (v: unknown): unknown => {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }

  return {
    async loadAll() {
      if (broken) throw new Error('memory port broken')
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) out[k] = parse(v)
      return out
    },
    async save(key, value) {
      if (broken) throw new Error('memory port broken')
      data[key] = value
    },
    async remove(key) {
      if (broken) throw new Error('memory port broken')
      delete data[key]
    },
    dump() {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) out[k] = parse(v)
      return out
    },
    setBroken(v: boolean) {
      broken = v
    },
  }
}
