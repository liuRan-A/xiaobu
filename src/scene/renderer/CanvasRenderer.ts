/**
 * 小卜 · 画布渲染器   src/scene/renderer/CanvasRenderer.ts
 * ===========================================================================
 * CanvasRenderer 是"画布的所有者"，不是"画面的作者"。它的职责严格限定为五件：
 *
 *   ① 拿到 2D context（拿不到就静默退回 DOM 奶油底，不报错）
 *   ② 维护适配盒（等比铺满 + 居中留边 + DPR 上限 2），响应 resize
 *   ③ 驱动 rAF 主循环，并 clamp dt（防后台回来时数值跳变导致动画瞬移）
 *   ④ 前后台自动暂停 / 恢复（省电，也让"回到前台"这一帧不抖）
 *   ⑤ 兜住一切异常 —— catch 里只调 handle()，绝不弹 UI（门禁 ⑨）
 *
 * 画面内容它一概不碰：那属于 scene/layers/ 的 L1–L9。
 * 这个分工让"改画面"与"改画布"互不干扰，也让渲染器能在离屏环境里被替换掉。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 防崩要点（对应用户明确要求的"底层静默降级"）
 * ───────────────────────────────────────────────────────────────────────────
 *   · context 拿不到 → 静默 return，DOM 层的 #FDF9F6 兜住，**不白屏、不弹窗**
 *   · resize / rAF 内任何异常 → handle() 记一条，循环继续跑下一帧
 *   · 单帧耗时超过 40ms 连续 30 帧 → 自动降档（关掉缓存的每帧重建、减粒子）
 *     ★ 这条只降"表现"，**绝不降"能不能玩"**：六爻与掷币永远可用
 *   · stop() 幂等：重复调用、未初始化时调用都安全
 * ===========================================================================
 */

import { LayerStack, type Frame } from './LayerStack'
import { computeFit, type FitBox } from './layoutMath'
import { DESIGN_W, DESIGN_H } from './isometric'
import { TOKENS } from './tokens.gen'
import { handle } from '@shared/errors/handle'
import { logger } from '@shared/logger'

export interface CanvasRendererOptions {
  /** 目标图层栈（缺省自建一个空的，便于早期冒烟测试） */
  stack?: LayerStack
  /** 帧率上限。默认 60；低端档由降档逻辑自动压到 30。 */
  fpsCap?: number
  /**
   * 每帧一次，**在绘制之前**。
   *
   * ★ 为什么挂在渲染器上，而不是让调用方自己再开一个 rAF：
   *   两个循环同频不同相，状态就会比画面快或慢一帧 —— 表现为"拖到香炉旁
   *   松手了，东西却停在上一帧的位置"。一个心跳同时推状态与画面，天然对齐。
   *   额外的收益是：低端档把帧率压到 30 时，状态推进也只有 30Hz，
   *   不会出现"画面卡但逻辑照跑"的资源错配。
   *
   * ★ **冷启动那次同步首帧不会调它**（那一刻还没有 t 可言）——
   *   否则引擎会先收到一个 `now = 0`，把倒计时的日历日算到 1970 年。
   *   回调拿到的 `frame.t` 是"自启动以来的累计毫秒"，**只给动画用**；
   *   玩法要的是墙上时钟，由引擎自己的时钟给（见 `store/engineHost.ts`）。
   */
  onFrame?: (frame: Frame) => void
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D | null = null
  private stack: LayerStack
  private fit: FitBox

  private rafId = 0
  private running = false
  private disposed = false

  private startedAt = 0
  /** 上一帧的**累计时间**（ms）。存累计值而不是时间戳，dt 就是一次减法。 */
  private prevElapsed = 0
  private frameNo = 0
  /** 是否已经按适配盒写过一次 canvas.width/height（canvas 默认 300×150，必须写一次） */
  private sized = false
  /** 上一帧的原始时间戳，只用于帧率节流 */
  private lastTickTs = 0

  private fpsCap: number
  private minFrameMs: number
  private onFrame: ((frame: Frame) => void) | null

  /** 连续超预算帧计数 —— 只用来降表现档，绝不改变玩法 */
  private slowStreak = 0
  /** 降档后的粒子倍率（1 = 全量，0.35 = 省电档） */
  private quality = 1

  constructor(canvas: HTMLCanvasElement, opts: CanvasRendererOptions = {}) {
    this.canvas = canvas
    this.stack = opts.stack ?? new LayerStack()
    this.fpsCap = opts.fpsCap ?? 60
    this.minFrameMs = 1000 / this.fpsCap
    this.onFrame = opts.onFrame ?? null
    this.fit = computeFit(0, 0, 1)
  }

  get layerStack(): LayerStack {
    return this.stack
  }

  get fitBox(): FitBox {
    return this.fit
  }

  /** 当前表现档位（1 = 全量）。埋点只上报数字，不上报任何画面内容。 */
  get qualityLevel(): number {
    return this.quality
  }

  // ── 生命周期 ───────────────────────────────────────────────────────────

  start(): void {
    if (this.disposed || this.running) return

    this.ctx = this.canvas.getContext('2d', { alpha: false })
    if (!this.ctx) {
      // ★ 拿不到 2D context 是完全可能的（极低内存、特殊 WebView）。
      //   这不是用户的错误，也绝不该弹窗 —— DOM 层的奶油底色已经兜住了。
      logger.warn('[renderer] 2d context unavailable; DOM cream background stands in')
      return
    }

    this.resize()

    // ★ 先同步画一帧：不等 rAF。冷启动的"第一眼"必须是黄昏小屋，
    //   而不是一帧黑/白 —— 这是 M1 出口条件（真机 ≤ 1.8s 看见小屋）的关键一步。
    //   live = false：这一帧没有有效时间戳，不驱动状态推进（见 onFrame 的说明）。
    this.renderOnce(0, false)

    this.startedAt = nowMs()
    this.prevElapsed = 0
    this.running = true
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.stack.clear()
    this.ctx = null
  }

  /**
   * 进后台：停 rAF。省电，也避免回前台那一帧的 dt 巨大。
   * ★ 画面内容保留（不清屏）—— 回前台第一帧直接覆盖，不会闪一下。
   */
  pause(): void {
    this.stop()
  }

  /** 回前台：重算适配盒（可能发生了分屏 / 旋转）+ 恢复循环 */
  resume(): void {
    if (this.disposed || this.running || !this.ctx) return
    this.resize()
    this.lastTickTs = 0
    this.running = true
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** 供外部在容器尺寸变化时调用（Capacitor 的 resize / 旋转 / 分屏） */
  resize(): void {
    if (this.disposed) return
    try {
      const cssW = this.canvas.clientWidth || DESIGN_W
      const cssH = this.canvas.clientHeight || DESIGN_H
      const next = computeFit(cssW, cssH, window.devicePixelRatio || 1)

      const changed =
        next.bufW !== this.fit.bufW ||
        next.bufH !== this.fit.bufH ||
        Math.abs(next.scale - this.fit.scale) > 1e-6 ||
        Math.abs(next.offX - this.fit.offX) > 0.5 ||
        Math.abs(next.offY - this.fit.offY) > 0.5

      this.fit = next
      // ★ 首次必须写一次：canvas 的默认尺寸是 300 × 150，不写就是一张小画布
      if (!changed && this.sized) return
      this.sized = true

      this.canvas.width = next.bufW
      this.canvas.height = next.bufH
      // 尺寸变了 → 离开屏缓存重建（否则会贴上一张旧尺寸的图）
      this.stack.invalidateCache()
    } catch (e) {
      // ★ 门禁 ⑨：resize 失败只记日志。下一帧仍会用旧适配盒继续画。
      handle(e, 'scene.render')
    }
  }

  /** ★ 崩溃恢复入口：清离屏缓存 → 同场景重新烘焙（白皮书 §3 · fatal 分支） */
  recoverFromCrash(): void {
    this.stack.invalidateCache()
    this.quality = 1
    this.slowStreak = 0
  }

  // ── 主循环 ─────────────────────────────────────────────────────────────

  private tick = (ts: number): void => {
    if (this.disposed || !this.running) return

    const elapsed = ts - this.lastTickTs
    // 帧率上限（低端档 30fps 时靠这里节流，而不是靠 requestAnimationFrame 的默认节奏）
    if (this.lastTickTs > 0 && elapsed < this.minFrameMs) {
      this.rafId = requestAnimationFrame(this.tick)
      return
    }
    this.lastTickTs = ts

    const t0 = nowMs()
    this.renderOnce(ts)
    const cost = nowMs() - t0

    // ★ 降档只针对"表现"：帧预算长期超支就减少粒子和缓存重建，
    //   但六爻与掷币的可用性**一个字节都不动**。
    if (cost > 40) {
      this.slowStreak += 1
      if (this.slowStreak > 30) {
        this.degrade()
        this.slowStreak = 0
      }
    } else if (this.slowStreak > 0) {
      this.slowStreak -= 1
    }

    this.rafId = requestAnimationFrame(this.tick)
  }

  /**
   * @param ts 高精度时间戳；传 0 表示"立刻同步画一帧"（冷启动首帧用）
   * @param live 是否是一次真实的心跳帧。false = 冷启动同步帧：照常画，但不推状态
   */
  private renderOnce(ts: number, live = true): void {
    const ctx = this.ctx
    if (!ctx) return

    try {
      const t = this.startedAt > 0 ? Math.max(0, ts - this.startedAt) : 0
      // ★ dt 必须 clamp：进后台再回来时，两帧之间可能隔了几十秒，
      //   不夹住的话呼吸动画会"瞬移"一下 —— 用户会觉得画面被"抽"了一帧。
      const dt = Math.max(0, Math.min(t - this.prevElapsed, 64))
      this.prevElapsed = t
      this.frameNo += 1

      const frame: Frame = { t, dt, n: this.frameNo }

      // ★ 推状态放在绘制之前：这一帧画出来的必须是这一帧算完的样子。
      //   单独包一层 catch —— 回调里是引擎的心跳，它自己已经全程兜底了；
      //   万一将来有人往里加了一句会抛的代码，也绝不能连带把画面丢掉。
      if (live && this.onFrame) {
        try {
          this.onFrame(frame)
        } catch (e) {
          handle(e, 'scene.render')
        }
      }

      // ① 整屏奶油底（在**屏幕坐标系**下先铺满，含留边区域）
      //    ★ 这是"绝不白屏"的最后一道实弹防线：此后无论发生什么，底都是暖的。
      ctx.setTransform(this.fit.dpr, 0, 0, this.fit.dpr, 0, 0)
      ctx.fillStyle = TOKENS.cCream
      ctx.fillRect(0, 0, this.fit.cssW, this.fit.cssH)

      // ② 切到设计坐标系（390 × 844），交付给 LayerStack
      ctx.save()
      ctx.translate(this.fit.offX, this.fit.offY)
      ctx.scale(this.fit.scale, this.fit.scale)
      this.stack.render(ctx, frame, this.fit)
      ctx.restore()
    } catch (e) {
      // ★ 门禁 ⑨：catch 内禁止出 UI。渲染失败保留上一帧，用户不会看到报错。
      handle(e, 'scene.render')
    }
  }

  private degrade(): void {
    if (this.quality <= 0.35) {
      // 已经到最低档：再把帧率上限压到 30，画面照旧稳定
      if (this.fpsCap > 30) {
        this.fpsCap = 30
        this.minFrameMs = 1000 / 30
        logger.warn('[renderer] degraded: fps cap -> 30')
      }
      return
    }
    this.quality = 0.35
    logger.warn('[renderer] degraded: particle quality -> 0.35')
  }
}

/** 单调时钟 —— 不用 Date.now()，避免系统时间被改动导致动画跳变 */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
