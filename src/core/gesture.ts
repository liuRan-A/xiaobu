/**
 * 小卜 · 指针手势识别   src/core/gesture.ts
 * ===========================================================================
 * 职责：把**原始的指针/传感器采样**翻译成**语义手势**。
 *
 *   原始（平台相关）                     语义（平台无关，可单测）
 *   ─────────────────────────           ──────────────────────────
 *   pointerdown / pointermove / up  →   PRESS / DRAG / TAP / RELEASE
 *   requestAnimationFrame 的心跳    →   LONG_PRESS（到点就回应）
 *   devicemotion 的加速度           →   SHAKE
 *
 * ── 为什么要单独一层 ────────────────────────────────────────────────────────
 *   手势里最容易出错的两件事，都只在这一层能解决：
 *   ① **长按 vs 拖拽的分界**。手指按在玻璃上一定会抖 1–4pt。
 *      要求"完全不动"才成长按，成功率会低到用户以为应用卡了。
 *   ② **释放速度的估算**。抬手前最后几毫秒常有"手指已离屏"的残帧，
 *      用它算速度会得到 ≈0，于是"明明甩得很用力"却判成没甩出去。
 *
 *   这两件事的修法都是"取窗口 / 加容差"，属于**数值细节**，
 *   必须能在 node 里用确定的采样序列断言 —— 不能靠"在手机上试半天"。
 *
 * ── 三个不变量（写成单测） ──────────────────────────────────────────────────
 *   · 一次按下最多产生**一个** LONG_PRESS（到点后就不再重复）
 *   · 一次按下最多产生**一个** TAP 或 **一个** RELEASE，不会都发
 *   · 采样间隔 > MAX_SAMPLE_GAP_MS 时速度按 0 处理，绝不掷出一个失控力度
 *
 * ★ 本文件零依赖、无 DOM、无时钟 —— 时间全部由传入的 `t` 决定。
 *   这样"模拟一次 3 秒的长按"就是三行代码，而不是等三秒。
 * ===========================================================================
 */

import {
  GESTURE_BUFFER_SIZE,
  MAX_SAMPLE_GAP_MS,
  POINTER_LONG_PRESS_TOL_PT,
  SHAKE_COOLDOWN_MS,
  TAP_MAX_MOVE_PT,
  TAP_MAX_MS,
  TH,
  VELOCITY_WINDOW_MS,
} from '@core/ritual/thresholds'
import { angleFromVerticalDeg, hypot, type Pt } from '@core/ritual/flight'

// ───────────────────────────────────────────────────────────────────────────
// 输入 / 输出
// ───────────────────────────────────────────────────────────────────────────

/** 一个原始指针采样。t 由调用方给（毫秒，单调递增） */
export interface PointerSample {
  /** 触点 id —— 多指时用来区分；单指固定 0 */
  id: number
  x: number
  y: number
  t: number
}

export type GestureName = 'PRESS' | 'LONG_PRESS' | 'DRAG' | 'TAP' | 'RELEASE' | 'SHAKE' | 'CANCEL'

/**
 * ★ 用一个**扁平**的事件结构，而不是按 type 分叉的联合。
 *   理由：消费方（engine）只在几个固定位置读几个字段，
 *   扁平结构让它不必为每个分支写类型收窄；而"哪些字段在哪个 type 下有意义"
 *   由下面每个字段的注释说清（并有单测覆盖）。
 *   少写的那几十行类型体操，换来的是这一层更容易被读懂。
 */
export interface GestureEvent {
  type: GestureName
  /** 触点 id；SHAKE 用 -1（它不是某个触点产生的） */
  pointerId: number
  /** 当前位置（屏幕坐标） */
  at: Pt
  t: number
  /** 自按下以来的净位移（pt） */
  distancePt: number
  /** 释放/拖动方向（单位向量，屏幕坐标 y 向下） */
  dir: Pt
  /** 估算速度（pt/s），沿释放方向 */
  speedPtS: number
  /** 与垂线的夹角（度）。0 = 正上，40 = 斜上，90 = 横划 */
  angleFromVerticalDeg: number
  /** 长按已持续多久（ms）—— LONG_PRESS / RELEASE 时有意义 */
  heldMs: number
  /**
   * 是否构成"掷出"。
   * ★ 规范给的三种掷出手势（上滑位移 / 释放速度 / 摇晃）在这里收敛成一个布尔：
   *   **位移够 或 速度够**，且**方向够"往上"**。
   *   把它放在识别层而不是状态机里，是为了让"什么算掷出"只有一个定义处。
   */
  fling: boolean
}

export interface GestureOptions {
  longPressMs: number
  longPressTolPt: number
  tapMaxMs: number
  tapMaxMovePt: number
  swipeMinPt: number
  releaseVMin: number
  releaseAngleMax: number
  /** 拖动事件的最小位移增量（pt）—— 免得原地微抖也刷 DRAG */
  dragEpsPt: number
}

export const DEFAULT_GESTURE_OPTIONS: GestureOptions = {
  longPressMs: TH.LONG_PRESS_MS,
  longPressTolPt: POINTER_LONG_PRESS_TOL_PT,
  tapMaxMs: TAP_MAX_MS,
  tapMaxMovePt: TAP_MAX_MOVE_PT,
  swipeMinPt: TH.SWIPE_MIN_PT,
  releaseVMin: TH.RELEASE_V_MIN,
  releaseAngleMax: TH.RELEASE_ANGLE_MAX,
  dragEpsPt: 1,
}

// ───────────────────────────────────────────────────────────────────────────
// 识别器
// ───────────────────────────────────────────────────────────────────────────

interface ActivePointer {
  start: Pt
  startT: number
  last: PointerSample
  /** 净位移的峰值（不是末值）—— 用户拖远了又拖回来，末位移会很小，
   *  但那显然算"拖过"，不该被判成轻点 */
  peakMovePt: number
  longPressFired: boolean
}

export class GestureRecognizer {
  private readonly opts: GestureOptions
  private active: ActivePointer | null = null
  /** 当前触点的采样缓冲（尾部即最新） */
  private samples: PointerSample[] = []
  /** 摇晃：超过阈值的起始时刻 */
  private shakeSince: number | null = null
  private shakeLastFired: number | null = null

  constructor(opts: Partial<GestureOptions> = {}) {
    this.opts = { ...DEFAULT_GESTURE_OPTIONS, ...opts }
  }

  get isPressed(): boolean {
    return this.active !== null
  }

  /** 按下 */
  down(sample: PointerSample): GestureEvent[] {
    // 已有触点却来了第二个 down：当作前一个被系统取消（多指、手掌误触都走这里）
    const out: GestureEvent[] = this.active ? this.cancel(sample.t) : []

    this.active = {
      start: { x: sample.x, y: sample.y },
      startT: sample.t,
      last: sample,
      peakMovePt: 0,
      longPressFired: false,
    }
    this.samples = [sample]

    out.push(this.build('PRESS', sample, 0, { x: 0, y: 0 }, 0))
    return out
  }

  /** 移动。同时承担"长按到点"的判定 —— 用户按住不动时要能收到回应 */
  move(sample: PointerSample): GestureEvent[] {
    const a = this.active
    if (!a || sample.id !== a.last.id) return []

    this.push(sample)
    a.last = sample

    const dx = sample.x - a.start.x
    const dy = sample.y - a.start.y
    const movePt = hypot({ x: dx, y: dy })
    if (movePt > a.peakMovePt) a.peakMovePt = movePt

    const out: GestureEvent[] = []
    const heldMs = sample.t - a.startT

    // ① 长按到点：到点就回应一次（★ 只回应一次）
    if (!a.longPressFired && heldMs >= this.opts.longPressMs && a.peakMovePt <= this.opts.longPressTolPt) {
      a.longPressFired = true
      out.push(this.build('LONG_PRESS', sample, heldMs, { x: 0, y: 0 }, 0))
    }

    // ② 已经算在拖拽里了：发 DRAG 让表现层跟随
    if (a.peakMovePt > this.opts.longPressTolPt) {
      const { dir, speed } = this.velocity()
      out.push(this.build('DRAG', sample, heldMs, dir, speed))
    }

    return out
  }

  /**
   * 抬手。
   * ★ TAP 与 RELEASE **互斥**：短按且几乎没动 → TAP；其余 → RELEASE。
   *   两个都发会让状态机收到"点了一下"又"甩了一下"，行为不可预测。
   */
  up(sample: PointerSample): GestureEvent[] {
    const a = this.active
    if (!a) return []
    // 抬手事件的 id 与最后一次 move 一致；若不一致，说明这个 up 属于一个陌生触点
    if (sample.id !== a.last.id) return []

    this.push(sample)
    const out: GestureEvent[] = []
    const heldMs = sample.t - a.startT
    const dx = sample.x - a.start.x
    const dy = sample.y - a.start.y
    const movePt = hypot({ x: dx, y: dy })
    const peak = Math.max(a.peakMovePt, movePt)

    const dir: Pt = movePt > 1e-9 ? { x: dx / movePt, y: dy / movePt } : { x: 0, y: 0 }
    const { speed } = this.velocity()

    const isTap = heldMs <= this.opts.tapMaxMs && peak <= this.opts.tapMaxMovePt

    if (isTap) {
      out.push(this.build('TAP', sample, heldMs, { x: 0, y: 0 }, 0))
    } else {
      const angle = angleFromVerticalDeg(dir)
      // ★ 判"掷出"的两个条件缺一不可：够力（位移 或 速度）**且**方向够上。
      //   少了方向这一条，用户横着划一下就会把币丢出去 —— 那是最招人烦的一种误触。
      const enough = movePt >= this.opts.swipeMinPt || speed >= this.opts.releaseVMin
      const fling = enough && angle <= this.opts.releaseAngleMax
      out.push(this.build('RELEASE', sample, heldMs, dir, speed, fling, angle))
    }

    this.resetPointer()
    return out
  }

  /** 系统取消（来电、手势返回、多指接管）。★ 取消不是失败，调用方应静默回位 */
  cancel(t: number): GestureEvent[] {
    const a = this.active
    if (!a) return []
    const ev = this.build('CANCEL', a.last, t - a.startT, { x: 0, y: 0 }, 0)
    this.resetPointer()
    return [ev]
  }

  /**
   * 心跳。用于「按住不动」时也能收到 LONG_PRESS ——
   * ★ 只在真的按着的时候才有意义；没按着时它是空操作（不会凭空产生事件）。
   */
  tick(now: number): GestureEvent[] {
    const a = this.active
    if (!a || a.longPressFired) return []
    if (now - a.startT < this.opts.longPressMs) return []
    if (a.peakMovePt > this.opts.longPressTolPt) return []

    a.longPressFired = true
    return [this.build('LONG_PRESS', a.last, now - a.startT, { x: 0, y: 0 }, 0)]
  }

  /**
   * 摇晃（加速度模长，单位 g）。
   *
   * ★ 两个条件缺一不可：**幅度够** + **持续够**。
   *   只看幅度会被"走路时手机晃一下"误触发；只看持续则永远不触发。
   *   再加**冷却**，把一次晃手收敛成一个事件（详见 SHAKE_COOLDOWN_MS）。
   */
  motion(g: number, t: number): GestureEvent[] {
    if (!Number.isFinite(g) || g < TH.SHAKE_G) {
      this.shakeSince = null
      return []
    }

    if (this.shakeSince === null) this.shakeSince = t
    if (t - this.shakeSince < TH.SHAKE_HOLD_MS) return []
    if (this.shakeLastFired !== null && t - this.shakeLastFired < SHAKE_COOLDOWN_MS) return []

    this.shakeLastFired = t
    this.shakeSince = t // 重新起算，避免冷却结束后立刻又发一个
    return [
      {
        type: 'SHAKE',
        pointerId: -1,
        at: { x: 0, y: 0 },
        t,
        distancePt: 0,
        dir: { x: 0, y: -1 }, // 摇晃在语义上等同于"往上掷"
        speedPtS: 0,
        angleFromVerticalDeg: 0,
        heldMs: TH.SHAKE_HOLD_MS,
        fling: true,
      },
    ]
  }

  /** 前后台切换、进后台等场景调用 —— 丢弃所有中间态，不发任何事件 */
  reset(): void {
    this.resetPointer()
    this.shakeSince = null
    this.shakeLastFired = null
  }

  // ── 内部 ──

  private resetPointer(): void {
    this.active = null
    this.samples = []
  }

  private push(s: PointerSample): void {
    this.samples.push(s)
    if (this.samples.length > GESTURE_BUFFER_SIZE) {
      this.samples.splice(0, this.samples.length - GESTURE_BUFFER_SIZE)
    }
  }

  /**
   * 估算释放速度（pt/s）。
   *
   * ★ 两条规则：
   *   ① 取最近 `VELOCITY_WINDOW_MS` 的窗口，用**首尾两点**算平均速度
   *      —— 不用瞬时速度，因为它对最后那个残帧极度敏感。
   *   ② 窗口内最大间隔若 > `MAX_SAMPLE_GAP_MS`（掉帧 / 卡顿 / 刚从后台回来），
   *      **返回 0**：宁可让这次判成"力度不足"（币按最小力度落盘，用户看得到结果），
   *      也不要扔出一个不受控的力度（币飞出屏幕）。
   */
  private velocity(): { dir: Pt; speed: number } {
    const n = this.samples.length
    if (n < 2) return { dir: { x: 0, y: 0 }, speed: 0 }

    const last = this.samples[n - 1]
    let first = this.samples[0]
    let maxGap = 0
    for (let i = n - 1; i > 0; i--) {
      const gap = this.samples[i].t - this.samples[i - 1].t
      if (gap > maxGap) maxGap = gap
      if (last.t - this.samples[i - 1].t > VELOCITY_WINDOW_MS) break
      first = this.samples[i - 1]
    }

    if (maxGap > MAX_SAMPLE_GAP_MS) return { dir: { x: 0, y: 0 }, speed: 0 }

    const dt = last.t - first.t
    if (dt <= 0) return { dir: { x: 0, y: 0 }, speed: 0 }

    const dx = last.x - first.x
    const dy = last.y - first.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return { dir: { x: 0, y: 0 }, speed: 0 }

    return { dir: { x: dx / d, y: dy / d }, speed: (d / dt) * 1000 }
  }

  private build(
    type: GestureName,
    s: PointerSample,
    heldMs: number,
    dir: Pt,
    speed: number,
    fling = false,
    angleOverride?: number,
  ): GestureEvent {
    const a = this.active
    const dx = a ? s.x - a.start.x : 0
    const dy = a ? s.y - a.start.y : 0
    const distancePt = a ? Math.hypot(dx, dy) : 0
    return {
      type,
      pointerId: s.id,
      at: { x: s.x, y: s.y },
      t: s.t,
      distancePt,
      dir: { ...dir },
      speedPtS: speed,
      angleFromVerticalDeg: angleOverride ?? (type === 'RELEASE' ? angleFromVerticalDeg(dir) : 0),
      heldMs: Math.max(0, heldMs),
      fling,
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 便利：把一段采样序列一次跑完（单测与回放调试用）
// ───────────────────────────────────────────────────────────────────────────

export interface SampleScript {
  id: number
  pts: ReadonlyArray<Pt>
  /** 每步之间的间隔（ms） */
  stepMs: number
  startT: number
}

/** 把一条轨迹喂给识别器，收齐全部事件。★ 回放用，不参与产品路径 */
export function replay(
  rec: GestureRecognizer,
  script: SampleScript,
): GestureEvent[] {
  const out: GestureEvent[] = []
  const pts = script.pts
  if (pts.length === 0) return out

  let t = script.startT
  out.push(...rec.down({ id: script.id, x: pts[0].x, y: pts[0].y, t }))
  for (let i = 1; i < pts.length; i++) {
    t += script.stepMs
    const last = i === pts.length - 1
    const sample = { id: script.id, x: pts[i].x, y: pts[i].y, t }
    out.push(...(last ? rec.up(sample) : rec.move(sample)))
  }
  return out
}
