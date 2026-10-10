/**
 * 小卜 · 渲染层级栈   src/scene/renderer/LayerStack.ts
 * ===========================================================================
 * 它只负责一件事：**决定谁画在谁上面**。这是"2.5D 微缩世界"空间感的全部地基。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 一、为什么不是"按 L1–L9 顺序一路画下去"
 * ───────────────────────────────────────────────────────────────────────────
 * L1–L9 是**美术分层**（背景→前景），对静止的场景完全够用。但只要有东西会动，
 * 静态层号就不够了：一枚在空中飞的铜钱，该画在竹筒前面还是后面？
 *
 * 答案是"看它此刻在哪"—— 所以需要**深度排序**。做法是画家算法：
 *
 *     按「物体地面接触点（影子）的屏幕 y」升序绘制。
 *     屏幕越靠下 = 离镜头越近 = 越晚画 = 挡住别人。
 *
 * 于是整个渲染被拆成三趟（Pass）：
 *
 *   ┌ BACKDROP · 固定顺序 ──── L1 空间 → L2 毛毡 → L3 木桌
 *   │  ↳ 全部 static，整趟烘焙进一张离屏 canvas，每帧只 blit 一次
 *   │
 *   ├ STAGE   · 深度排序 ──── L4 竹筒/铜钱 · L5 盆栽 · L6 卦盘 · L7 小卜
 *   │  ↳ 每帧排序 + 每帧重画（会动的东西都在这）
 *   │
 *   └ GRADE   · 固定顺序 ──── L8 暖纱 → L9 暖光 / 暗角
 *      ↳ 调色层，永远在最上面
 *
 * 三趟之间不可交换：GRADE 必须在 STAGE 之后（暖纱要罩住铜钱），
 * BACKDROP 必须在 STAGE 之前（桌子要在铜钱下面）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 二、平台的排序键特例（这一条搞错了，桌上所有东西都会被桌子盖住）
 * ───────────────────────────────────────────────────────────────────────────
 * 物体用影子 y 排序（isometric.actorSortY）。但"平躺的大平面"（卦盘、地面）
 * 不能这么做 —— 它自己就横跨几百像素，一个中心点代表不了它。
 * 所以平台取**四顶点里最靠上（离镜头最远）**的那个：platformSortY()。
 *
 * 验证：卦盘最远角 y = 469，六个爻位槽 y ∈ [508, 549.2] —— 全部 > 469，
 * 于是所有铜钱都排在卦盘之后被画，也就是画在盘面上。✓
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 三、防崩设计（本文件是门禁 ⑨ 的第一道实弹防线）
 * ───────────────────────────────────────────────────────────────────────────
 *   ① 每帧第一件事：把整块画布铺成奶油色 #FDF9F6。
 *      → 即使一个图层都没画出来、即使全部抛异常，用户看到的也是暖奶油色，
 *        **永远不白屏**。（这是用户明确要求的"底层静默降级"落点）
 *   ② 每个图层的 draw 单独 try/catch，**互不牵连**：一层挂了，其余照画。
 *   ③ 连续失败 MAX_FAILS 次的图层被**永久隔离**（dead），不再尝试、不再刷日志。
 *      → 坏掉一个粒子层，不该把整个房间拖垮，也不该每帧刷屏。
 *   ④ catch 内**只调 handle()**，绝不 alert / Toast / showModal（门禁 ⑨）。
 *   ⑤ 渲染入口整体再包一层 catch —— 兜底逻辑自己崩了也不能冒泡。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 四、离屏缓存（性能与"崩溃恢复"共用的一个机制）
 * ───────────────────────────────────────────────────────────────────────────
 * 背景那三层的渐变、纹理点、木纹线，每帧重画一次是纯浪费（帧预算的大头）。
 * 它们声明 `static: true` 后会被烘焙进一张离屏 canvas，每帧只 blit 一次 ——
 * 60fps 的余量就是这么省出来的。
 *
 * 而崩溃恢复（白皮书 §3 · fatal 分支）里的"清离屏缓存"，清的正是这张：
 * 调用 `invalidateCache()` → 下一帧重新烘焙 → 视觉上等价于"房间淡入回来"。
 * 一个机制同时服务性能与恢复，不用维护两套。
 * ===========================================================================
 */

import { TOKENS } from './tokens.gen'
import { DESIGN_W, DESIGN_H } from './isometric'
import type { FitBox } from './layoutMath'
import { handle } from '@shared/errors/handle'
import { logger } from '@shared/logger'

// ───────────────────────────────────────────────────────────────────────────
// 图层带（= 设计稿的 L1–L9，一一对应，改编号要同步改美术稿说明）
// ───────────────────────────────────────────────────────────────────────────

export const BAND = {
  /** L1 空间：墙 / 暖窗 / 壁灯 / 地板 */
  SPACE: 1,
  /** L2 毛毡地毯与地板 */
  FELT: 2,
  /** L3 木桌（顶面 + 左右受光面 + 木纹 + 光池） */
  TABLE: 3,
  /** L4 竹筒与铜钱 */
  PROPS: 4,
  /** L5 窗边小盆栽 */
  PLANT: 5,
  /** L6 卦盘与六爻位槽 */
  BOARD: 6,
  /** L7 小卜 */
  XIAOBU: 7,
  /** L8 全局暖色薄纱 —— ★ 天气可写 */
  VEIL: 8,
  /** L9 暖光强化与暗角 —— ★ 天气可写 */
  VIGNETTE: 9,
  /** L10 纸张质感（暖琥珀遮罩 + 水彩噪点）—— 媒介底色，非天气可写 */
  PAPER: 10,
} as const

export type Band = (typeof BAND)[keyof typeof BAND]

export const BAND_LABEL: Readonly<Record<Band, string>> = Object.freeze({
  [BAND.SPACE]: 'L1 空间',
  [BAND.FELT]: 'L2 毛毡地毯',
  [BAND.TABLE]: 'L3 木桌',
  [BAND.PROPS]: 'L4 竹筒与铜钱',
  [BAND.PLANT]: 'L5 窗边盆栽',
  [BAND.BOARD]: 'L6 卦盘与爻位槽',
  [BAND.XIAOBU]: 'L7 小卜',
  [BAND.VEIL]: 'L8 暖色薄纱',
  [BAND.VIGNETTE]: 'L9 暖光与暗角',
  [BAND.PAPER]: 'L10 纸张质感',
})

// ───────────────────────────────────────────────────────────────────────────
// 渲染趟
// ───────────────────────────────────────────────────────────────────────────

export const PASS = {
  BACKDROP: 'BACKDROP',
  STAGE: 'STAGE',
  GRADE: 'GRADE',
} as const

export type PassId = (typeof PASS)[keyof typeof PASS]

/** band 内固定顺序 / depth 按影子 y 排序 */
export type SortMode = 'band' | 'depth'

export interface PassSpec {
  id: PassId
  mode: SortMode
  label: string
}

/** ★ 顺序即语义：BACKDROP → STAGE → GRADE，不可交换 */
export const PASSES: readonly PassSpec[] = Object.freeze([
  { id: PASS.BACKDROP, mode: 'band', label: '背景 · 空间 / 毛毡 / 木桌' },
  { id: PASS.STAGE, mode: 'depth', label: '舞台 · 道具 / 卦盘 / 角色（按影子排序）' },
  { id: PASS.GRADE, mode: 'band', label: '调色 · 暖纱 / 暖光 / 暗角' },
])

/** band → 默认归属哪一趟。个别物件可用 item.pass 覆盖（如飞行中的铜钱提到 GRADE 前）。 */
export function defaultPass(band: Band): PassId {
  if (band <= BAND.TABLE) return PASS.BACKDROP
  if (band >= BAND.VEIL) return PASS.GRADE
  return PASS.STAGE
}

// ───────────────────────────────────────────────────────────────────────────
// 天气写入白名单（门禁 ⑥ 的代码锚点）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★★ 红线（架构文档 §8.3.6 / 白皮书 §5 门禁 ⑥）★★
 * 天气模块**只允许**写入 L8 暖纱与 L9 暖光暗角 —— 也就是粒子的浓淡与滤镜的色温。
 * 它绝不允许影响六爻与 AI 解卦；这两件事在 cc 上不共享任何数据结构。
 *
 * 把白名单写在渲染栈里，是为了让门禁脚本有一个可 grep 的锚点：
 * 一旦有人想从 weather 去改 L1–L7，`atmosphereOnly` 会立刻挡回来，
 * 而 gate 02-weather-oneway.mjs 会在 CI 里扫源码。
 */
const WEATHER_WRITABLE: ReadonlySet<Band> = new Set<Band>([BAND.VEIL, BAND.VIGNETTE])

export function isWeatherWritable(band: Band): boolean {
  return WEATHER_WRITABLE.has(band)
}

// ───────────────────────────────────────────────────────────────────────────
// 帧上下文与渲染项
// ───────────────────────────────────────────────────────────────────────────

export interface Frame {
  /** 自渲染器启动起累计时间（ms）—— 所有呼吸 / 光尘 / 涟漪都吃它，别用 Date.now() */
  t: number
  /** 距上一帧（ms），已 clamp 到 [0, 64]，防后台回来时数值跳变 */
  dt: number
  /** 帧序号 */
  n: number
}

export interface RenderItem {
  /** 场景名，出现在日志里（枚举式，不含任何用户数据） */
  id: string
  band: Band
  /** 缺省由 band 推断；显式指定可让物件跨趟（谨慎使用） */
  pass?: PassId
  /** ★ 地面接触点（影子）的设计 y —— STAGE 内排序的唯一依据 */
  sortY: number
  /** 离其所在平面的高度（设计 px）。只用于同 sortY 时的稳定排序，不参与遮挡。 */
  z?: number
  /** ★ 静态层：整层烘焙进离屏缓存，每帧只 blit */
  static?: boolean
  visible?: boolean
  draw: (ctx: CanvasRenderingContext2D, frame: Frame) => void
}

interface Slot {
  item: RenderItem
  pass: PassId
  fails: number
  dead: boolean
  seq: number
}

/** 连续失败到这个次数就永久隔离该图层 —— 坏一层，不拖垮整间屋子 */
const MAX_FAILS = 3

interface CacheEntry {
  canvas: HTMLCanvasElement
  sig: string
}

// ───────────────────────────────────────────────────────────────────────────
// 渲染栈
// ───────────────────────────────────────────────────────────────────────────

export class LayerStack {
  private slots: Slot[] = []
  private seq = 0
  private dirty = true
  private caches = new Map<PassId, CacheEntry>()
  private ordered: Slot[] = []

  // ── 挂载 / 卸载 ─────────────────────────────────────────────────────────

  add(item: RenderItem): void {
    if (!item || typeof item.id !== 'string' || !item.id) {
      logger.warn('[layerstack] rejected item without id')
      return
    }
    if (this.slots.some((s) => s.item.id === item.id)) {
      // 重名直接覆盖：便于热重载 / 重复注册而不产生幽灵图层
      this.slots = this.slots.filter((s) => s.item.id !== item.id)
    }
    const pass = item.pass ?? defaultPass(item.band)
    this.slots.push({ item, pass, fails: 0, dead: false, seq: this.seq++ })
    this.dirty = true
    this.invalidateCache(pass)
  }

  addMany(items: readonly RenderItem[]): void {
    for (const it of items) this.add(it)
  }

  remove(id: string): void {
    const slot = this.slots.find((s) => s.item.id === id)
    if (!slot) return
    this.slots = this.slots.filter((s) => s.item.id !== id)
    this.dirty = true
    this.invalidateCache(slot.pass)
  }

  clear(): void {
    this.slots = []
    this.dirty = true
    this.caches.clear()
  }

  get(id: string): RenderItem | undefined {
    return this.slots.find((s) => s.item.id === id)?.item
  }

  setVisible(id: string, visible: boolean): void {
    const slot = this.slots.find((s) => s.item.id === id)
    if (!slot) return
    slot.item.visible = visible
    // 只有静态层才需要重建缓存 —— 动态层的显隐每帧都变，重建会杀掉帧率
    if (slot.item.static) this.invalidateCache(slot.pass)
  }

  /** 供测试与调试：当前各趟的绘制顺序（图层 id） */
  drawOrder(pass?: PassId): string[] {
    this.sortIfNeeded()
    return this.ordered
      .filter((s) => !pass || s.pass === pass)
      .filter((s) => !s.dead && s.item.visible !== false)
      .map((s) => s.item.id)
  }

  /** 已被隔离的图层（连续失败 MAX_FAILS 次）—— 埋点与健康页会读它 */
  quarantined(): string[] {
    return this.slots.filter((s) => s.dead).map((s) => s.item.id)
  }

  /** ★ 天气模块唯一允许触碰的图层集合（门禁 ⑥ 的运行时锚点） */
  atmosphereTargets(): RenderItem[] {
    return this.slots.filter((s) => isWeatherWritable(s.item.band)).map((s) => s.item)
  }

  get size(): number {
    return this.slots.length
  }

  // ── 缓存 ───────────────────────────────────────────────────────────────

  /** ★ 崩溃恢复调用它：下一帧重新烘焙背景，视觉上等价于"房间淡入回来" */
  invalidateCache(pass?: PassId): void {
    if (pass) this.caches.delete(pass)
    else this.caches.clear()
  }

  // ── 排序 ───────────────────────────────────────────────────────────────

  private sortIfNeeded(): void {
    if (!this.dirty && this.ordered.length === this.slots.length) return

    const passIndex = new Map<PassId, number>(PASSES.map((p, i) => [p.id, i]))
    const mode = new Map<PassId, SortMode>(PASSES.map((p) => [p.id, p.mode]))

    this.ordered = [...this.slots].sort((a, b) => {
      const pa = passIndex.get(a.pass) ?? 99
      const pb = passIndex.get(b.pass) ?? 99
      if (pa !== pb) return pa - pb

      // depth 趟：影子 y 升序 —— 屏幕越靠下越晚画，于是挡住别人
      if (mode.get(a.pass) === 'depth') {
        if (a.item.sortY !== b.item.sortY) return a.item.sortY - b.item.sortY
        if (a.item.band !== b.item.band) return a.item.band - b.item.band
        const za = a.item.z ?? 0
        const zb = b.item.z ?? 0
        if (za !== zb) return za - zb
      }

      // band 趟：固定按 L 号
      if (a.item.band !== b.item.band) return a.item.band - b.item.band
      return a.seq - b.seq
    })

    this.dirty = false
  }

  // ── 渲染 ───────────────────────────────────────────────────────────────

  /**
   * 主渲染入口。
   * @param fit 提供时启用离屏缓存（真机 / 浏览器）；缺省时全量直画（单测环境）。
   *
   * ★ 本函数**永不抛异常**，也**永不弹任何 UI**（门禁 ⑨）。
   */
  render(ctx: CanvasRenderingContext2D, frame: Frame, fit?: FitBox): void {
    try {
      // ① ★ 防崩第一道实弹防线：先把整块设计画布铺成奶油色。
      //    后面无论发生什么（图层全挂 / 缓存建不出来 / 排序炸了），
      //    用户看到的都是暖奶油 #FDF9F6 —— 绝不是白屏。
      ctx.fillStyle = TOKENS.cCream
      ctx.fillRect(0, 0, DESIGN_W, DESIGN_H)

      this.sortIfNeeded()

      for (const spec of PASSES) {
        const list = this.ordered.filter((s) => s.pass === spec.id)
        if (list.length === 0) continue

        // 整趟都是静态层 → 烘焙一次，之后每帧只 blit
        const cacheable = !!fit && list.every((s) => s.item.static === true)
        if (cacheable && fit) {
          const canvas = this.ensureCache(spec.id, list, fit)
          if (canvas) {
            this.blit(ctx, canvas, fit)
            continue
          }
          // 建不出缓存（离屏 canvas 不可用）→ 静默降级为直画，不报错
        }

        for (const slot of list) this.paint(ctx, slot, frame)
      }
    } catch (e) {
      // ★ 门禁 ⑨：渲染入口的兜底 catch —— 只记日志，不弹 UI，不冒泡。
      //   奶油底色已在 ① 铺好，用户至少看到的是小屋的暖色。
      handle(e, 'scene.render')
    }
  }

  // ── 内部 ───────────────────────────────────────────────────────────────

  /** 单图层绘制：一层挂了，其余照画；连续挂 MAX_FAILS 次则永久隔离 */
  private paint(ctx: CanvasRenderingContext2D, slot: Slot, frame: Frame): void {
    if (slot.dead || slot.item.visible === false) return
    try {
      slot.item.draw(ctx, frame)
      if (slot.fails > 0) slot.fails = 0 // 恢复即清零，不累计历史
    } catch (e) {
      slot.fails += 1
      // ★ 门禁 ⑨：catch 内只记日志。绝无 alert / Toast / showModal。
      handle(e, 'scene.render')
      if (slot.fails >= MAX_FAILS) {
        slot.dead = true
        // 隔离 + 该趟缓存作废（否则缓存里会永远缺这一层）
        this.invalidateCache(slot.pass)
        logger.warn('[layerstack] layer quarantined after repeated failures:', slot.item.id)
      }
    }
  }

  private cacheSig(fit: FitBox): string {
    return `${fit.bufW}x${fit.bufH}@${fit.dpr}/${fit.scale.toFixed(4)}/${fit.offX.toFixed(2)}/${fit.offY.toFixed(2)}`
  }

  private ensureCache(pass: PassId, list: Slot[], fit: FitBox): HTMLCanvasElement | null {
    const sig = this.cacheSig(fit)
    const hit = this.caches.get(pass)
    if (hit && hit.sig === sig) return hit.canvas

    const canvas = createCanvas(fit.bufW, fit.bufH)
    if (!canvas) return null

    const cctx = canvas.getContext('2d')
    if (!cctx) return null

    // 离屏画布用与主画布**完全一致**的变换，这样 blit 时只需原样贴回
    cctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0)
    // ★ 这里**不许**铺奶油底！烘焙画布必须保持透明：
    //   blit 用 drawImage 原样贴回，GRADE 趟（L8/L9 调色层）如果带着不透明的
    //   奶油底贴回去，会把下面 BACKDROP/STAGE 刚画好的整个房间盖成一片奶油色
    //   —— 表现就是"整屏只有一层暖纱渐变，小屋消失"。
    //   奶油兜底已由两处负责：renderOnce 的整屏铺底 + render() 第①步的设计画布铺底。
    cctx.translate(fit.offX, fit.offY)
    cctx.scale(fit.scale, fit.scale)

    // 静态层不依赖时间，用零帧烘焙 —— 保证同一份输入永远产出同一张图
    const bakeFrame: Frame = { t: 0, dt: 0, n: 0 }
    for (const slot of list) this.paint(cctx, slot, bakeFrame)

    this.caches.set(pass, { canvas, sig })
    return canvas
  }

  private blit(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, fit: FitBox): void {
    ctx.save()
    ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0)
    ctx.drawImage(canvas, 0, 0, fit.cssW, fit.cssH)
    ctx.restore()
  }
}

/**
 * 离屏 canvas 的稳妥创建。
 * 单测 / 无 DOM 环境下返回 null → 调用方静默降级为直画。
 * ★ 这里刻意不 try/catch 到 UI：拿不到离屏画布只是少一层性能优化，用户无感。
 */
function createCanvas(w: number, h: number): HTMLCanvasElement | null {
  try {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.floor(w))
    c.height = Math.max(1, Math.floor(h))
    return c
  } catch {
    return null
  }
}
