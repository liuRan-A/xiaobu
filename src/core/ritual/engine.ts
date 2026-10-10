/**
 * 小卜 · 掷币仪式引擎   src/core/ritual/engine.ts
 * ===========================================================================
 * `core/ritual/index.ts` 里写着本目录"还不在"的两块，这是第二块：
 *
 *   · gesture.ts  —— 长按 / 上滑 / 快甩 / 摇晃 的手势谓词（已在 core/gesture.ts）
 *   · engine.ts   —— **RitualEngine：把状态机（core/machine）与上面两块缝起来** ← 本文件
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  它到底缝了什么（三根线，一根都不多）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① **状态机 → 画面**：`ritualMachine` 只发 `SceneCommand`（`coin:lift` /
 *      `slot:breathe` / `tube:shake` …），它不知道屏幕长什么样。
 *      本文件是那些指令的**唯一消费者**，把它们翻译成"这一帧该画什么"（`view()`）。
 *
 *   ② **时间 → 落定**：状态机在 TOSS 态**等一个 `LANDED` 事件**才进 PLACE，
 *      但"币什么时候落地"只有轨迹知道。所以由本文件按 `solveToss` 解出的时长
 *      到点上报 —— 这是整个仪式里唯一一处"画面回头驱动玩法"的地方，
 *      也是它必须住在 core 而不是 scene 的原因：这条时间线要能被断言。
 *
 *   ③ **松手 → 结局**：PLACE 段的松手有三种结局（吸附 / 反悔 / 留在原处），
 *      状态机自己判不了 —— 它不知道手指在哪，也不知道竹筒在屏幕的哪个位置。
 *      判定用 `resolveDrop()`（与爻位槽共用同一套"最近中心点"内核），
 *      结果再喂回状态机。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  两条边界（写下来是为了防止它慢慢变成一坨）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · **它不认识像素，只认识坐标。** 铜钱的家、竹筒口、卦盘椭圆都由场景层
 *     通过 `configure()` 喂进来。core 里出现 196 / 452 / 118 这类美术数字即为违规
 *     （ESLint 禁令 1 拦不住数据，所以这条靠人守 —— 但它是硬的）。
 *   · **它自己不发 UI。** 没有任何 alert / Toast（门禁 ⑨）。触感是"取走即清"的
 *     一次性信号（`consumeHaptic()`），由场景层决定要不要真的震 ——
 *     这样在浏览器 / 单测环境里它天然是空操作，不需要分支。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ★ 一个刻意的简化：没有"三枚铜钱定一爻"
 * ═══════════════════════════════════════════════════════════════════════════
 * 规范写的是"三枚铜钱定一爻"，也就是一爻要掷三次。而 M1 的 `castLineImpl`
 * 是占位实现（一次落位出一爻），本文件跟着它走：**一枚币 = 一爻**。
 * 这件事在快照里是看得出来的（`lines.length` 与落位次数 1:1），
 * 所以不需要额外标记 —— 等 `core/liuyao/castLine.ts` 到位时，
 * 这里要改的只有"落位后是否回 IDLE"，而不是整套时间线。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import {
  ritualMachine,
  SLOT_CENTERS,
  type RitualCtx,
  type RitualState,
  type SceneCommand,
} from '@core/machine/ritualMachine'
import {
  CURSOR_OFFSET_PT,
  CUP_ROLL_OUT_DELAY_MS,
  CUP_ROLL_OUT_MS,
  CUP_SHAKE_DECAY_MS,
  COIN_LIFT_DY,
  COIN_LIFT_SCALE,
  COIN_SETTLED_PT,
  COIN_IDLE_PT,
  COIN_PRESELECT_SCALE,
  DIM_OTHERS_ALPHA,
  DIM_OTHERS_SCALE,
  MS,
  TH,
} from './thresholds'
import { predictRingAt, solveToss, type Bounds, type Ellipse, type Pt, type TossTrajectory } from './flight'
import {
  easeOutCubic,
  flightLifetimeMs,
  sampleFlight,
  spinSquashX,
  type FlightPlay,
} from './flightPlay'
import { resolveDrop, resolveSlot } from './slotResolver'

// ───────────────────────────────────────────────────────────────────────────
// 对外形状
// ───────────────────────────────────────────────────────────────────────────

/** 触感档位 —— 只有"做成了"才有，否定性反馈一律不震（规范 §2.2 五） */
export type HapticCue = 'light' | 'medium'

/** 爻位下标（六爻，初爻到上爻） */
export type SlotIndex = 0 | 1 | 2 | 3 | 4 | 5

export interface RitualEngineConfig {
  /**
   * 每枚铜钱在桌面上的"家"（设计 pt）。
   * ★ 必须由场景层给 —— core 不许知道美术像素（见文件头 §二）。
   *   长度同时决定"桌上有几枚"，所以它也是 `view().drawCoins` 的长度。
   */
  coinHome?: readonly Pt[]
  /** 竹筒口中心（设计 pt）。反悔判定与"补出一枚"的起点都要它 */
  cup?: Pt
  /** 卦盘命中椭圆。null / 不传 = 这一局不判落盘（币落在桌上，走温柔回路） */
  board?: Ellipse | null
  /** 画布边界（落点钳制用） */
  bounds?: Bounds
  /** 随机源（自旋抖动）。测试注入固定值即可复现 */
  rand?: () => number
}

export interface LaunchInput {
  /** 释放方向（未归一化，屏幕坐标 y 向下） */
  dir: Pt
  /** 手势净位移（pt） */
  displacePt: number
  /** 释放速度（pt/s） */
  releaseV: number
  /** 出手点。缺省 = 手上的位置 → 家 */
  from?: Pt
}

/**
 * 一帧的仪式画面。
 *
 * ★ 它是一个**纯数据快照**，不是"渲染指令"。scene 层拿到它之后
 *   完全可以什么都不画（比如 2D context 拿不到时），而仪式照常推进 ——
 *   这条解耦让"低端机降级"不需要动 core 一个字节。
 */
export interface RitualView {
  state: RitualState
  /** 手上 / 空中的那枚铜钱；-1 = 没有 */
  coinId: number
  /** 它此刻的位置。null = 没有正在被摆弄的币 */
  coinAt: Pt | null
  coinScale: number
  /** 自旋造成的横向压缩（1 = 摊平）。★ 翻滚的币是"变窄"，不是在屏幕上打转 */
  coinSquashX: number
  coinAlpha: number
  /** 其余两枚压暗 8% */
  dimOthers: boolean
  /** 飞行取点与残留（含 3 段拖尾、2 圈涟漪）。null = 不在飞行 */
  flight: FlightPlay | null
  /** ★ 落点（涟漪的圆心）。**不是** `flight.at` —— 那是币此刻的位置，还在动 */
  landingAt: Pt | null
  /** 落点预示环画在哪（轨迹与盘面椭圆的最近交点） */
  predictAt: Pt | null
  /** 拾起光环 / 柔紫投影的强度 0..1（手上才亮，飞出去就交给拖尾了） */
  halo: number
  glow: boolean
  breathe: boolean
  /** 选位段闲着超过 8s → 呼吸加快到 2.4s（引导态 B） */
  breatheFast: boolean
  /** 正在预备吸附的槽（≤44pt）；-1 = 没有 */
  armedSlot: number
  /** 六个槽上各停着哪枚铜钱（-1 = 空）—— 与 `ritualMachine.ctx.slotCoins` 同一份 */
  slots: readonly number[]
  /** 每个槽的"吸过去"缓动进度 0..1（1 = 已停稳；空槽为 -1） */
  slotEase: readonly number[]
  /** 每枚铜钱要不要交给 L4 的待机图层画（true = 它就在家里待着） */
  onTable: readonly boolean[]
  /** 每枚铜钱此刻该画在哪；null = 这一帧不画它（在槽里 / 在筒里 / 由 L4 画） */
  drawCoins: readonly (Pt | null)[]
  /** 每枚"补出来"的进度 0..1（1 = 已回到桌上） */
  rollOut: readonly number[]
  /** 竹筒震颤包络 0..1 —— 衰减曲线在 core，逐帧的正负交替在 scene */
  tubeShake: number
  /** 六音上行的当前音级 0..5 */
  cadenceStep: number
  /** 铜钱的家（scene 画接触影要用） */
  coinHome: readonly Pt[]
  /** 竹筒口（scene 画补币的起点要用） */
  cup: Pt
}

/** 松手结局 —— ★ 三种，**没有"失败"这一种** */
export type DropResult = 'snap' | 'revoke' | 'stay'

const DEFAULT_HOME: readonly Pt[] = Object.freeze([
  { x: 0, y: 0 },
  { x: 0, y: 0 },
])

/** 一枚"正在回家 / 正在回筒"的铜钱 */
interface ReturnTrack {
  coinId: number
  from: Pt
  to: Pt
  at: number
  ms: number
  /** 弧顶高度（pt）—— 回位 6、回筒 14。回筒要高一些，才读得出"被吸进筒口" */
  arc: number
  /** true = 终点是筒口，到了就"进筒"（此后由补币动画接管） */
  intoCup: boolean
}

// ───────────────────────────────────────────────────────────────────────────
// 引擎
// ───────────────────────────────────────────────────────────────────────────

export class RitualEngine {
  private now = 0

  private home: readonly Pt[] = DEFAULT_HOME
  private cup: Pt = { x: 0, y: 0 }
  private board: Ellipse | null = null
  private bounds: Bounds = { w: 390, h: 844 }
  private rand: () => number = Math.random

  /** 正在被摆弄的那枚铜钱（拾起 / 飞行 / 选位）；-1 = 空手 */
  private lifted = -1
  /** 拾起开始的时刻（1.0 → 1.15 的抬起缓动要它） */
  private liftAt = 0
  /** 跟着手指的位置（已含"指针上方 22pt"的偏移） */
  private carried: Pt | null = null
  /** 从"抬起位置"过渡到"跟手位置"的起点与时刻 —— 不做这一步，币会在起手瞬间跳 22pt */
  private blendFrom: Pt | null = null
  private blendAt = -1

  /** 这一掷的轨迹 */
  private traj: TossTrajectory | null = null
  private launchAt = 0
  /** 这一次拾起最终**掷出去了**（而不是半途松手 / 反悔） */
  private launched = false
  private landedFired = false

  /** 回位 / 回筒中的那一枚 */
  private ret: ReturnTrack | null = null

  private glow = false
  private breathe = false
  private armedSlot = -1
  /** 每个槽的落定时刻（-Infinity = 空槽）—— 只服务 120ms 吸附缓动 */
  private slotSettledAt: number[] = SLOT_CENTERS.map(() => -Infinity)
  /** 每枚铜钱"进筒"的结束时刻（-1 = 在桌上） */
  private goneUntil: number[] = []
  /** 每枚铜钱"开始滚出来"的时刻（-1 = 不需要） */
  private rollFrom: number[] = []
  private shakeAt = -1
  private cadence = 0
  private haptic: HapticCue | null = null
  /**
   * 最近一次"用户真的动了"的时刻。
   * ★ 只服务一件事：选位段空闲 `TH.PLACE_GUIDE_MS`(8s) 之后把空槽呼吸从 4s 加快到 2.4s。
   *   它与仪式机里那条 `guide('PLACE_IDLE')` 用**同一个阈值**，
   *   所以"小卜开口"和"槽开始催"必然同时发生 —— 两个节奏各走各的会显得很吵。
   */
  private lastActAt = 0

  constructor(cfg: RitualEngineConfig = {}) {
    this.configure(cfg)
  }

  /** 场景层在挂载时喂几何。★ 可以在任何时刻重喂（旋转 / 换美术稿） */
  configure(cfg: RitualEngineConfig): void {
    if (cfg.coinHome && cfg.coinHome.length > 0) this.home = cfg.coinHome.map((p) => ({ x: p.x, y: p.y }))
    if (cfg.cup) this.cup = { ...cfg.cup }
    if (cfg.board !== undefined) this.board = cfg.board
    if (cfg.bounds) this.bounds = { ...cfg.bounds }
    if (cfg.rand) this.rand = cfg.rand
    this.goneUntil = this.home.map(() => -1)
    this.rollFrom = this.home.map(() => -1)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ① 状态机 → 画面：指令汇
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 接 `ritualMachine.setCommandSink()` 的输出。
   *
   * ★ 这里**不许抛**。它是状态机 entry/exit 里的同步调用 —— 抛出去会让
   *   `createMachine` 的转移中途断掉，机器停在一个既不是旧态也不是新态的地方。
   *   那比"动画少画一帧"糟糕一万倍，所以整段包一层。
   */
  handleCommand(cmd: SceneCommand): void {
    try {
      this.lastActAt = this.now
      this.apply(cmd)
    } catch (e) {
      // ★ 门禁 ⑨：只记日志，绝不弹 UI
      logger.warn('[ritual] 场景指令处理异常（已忽略）', e)
    }
  }

  private apply(cmd: SceneCommand): void {
    switch (cmd.type) {
      case 'coin:lift':
        this.lifted = cmd.coinId
        this.liftAt = this.now
        this.carried = null
        this.blendFrom = null
        this.blendAt = -1
        this.traj = null
        this.launched = false
        this.landedFired = false
        this.armedSlot = -1
        this.ret = null
        return

      case 'coin:fly': {
        // ★ `arc > 0` 是 TOSS 的起手指令，但它的 from/to 是占位值 (0,0) ——
        //   真正的轨迹由 `launch()` 用引擎的手势数据解。这里只处理"跟手"那一支。
        if (cmd.arc > 0) return
        if (this.lifted < 0) return
        // ★ 坐标必须有限。放进来的 NaN 会**污染整条混算**：即使混合进度是 0，
        //   `from + (NaN - from) * 0` 仍然是 NaN（NaN 乘 0 不等于 0），
        //   于是币被画到 (NaN, NaN)，命中层也跟着拿到 NaN。
        //   脏输入的正确处理是"这一帧不动"，而不是"动到一个不存在的地方"。
        if (!Number.isFinite(cmd.to?.x) || !Number.isFinite(cmd.to?.y)) return
        // 第一帧拖动：记下此刻铜钱在哪，好让"抬到指针上方 22pt"这个位移是**渐变**的
        if (this.blendAt < 0) {
          this.blendFrom = this.coinPos()
          this.blendAt = this.now
        }
        this.carried = { x: cmd.to.x, y: cmd.to.y - CURSOR_OFFSET_PT }
        return
      }

      case 'slot:snap': {
        const slot = Math.floor(cmd.slot)
        if (slot >= 0 && slot < this.slotSettledAt.length) this.slotSettledAt[slot] = this.now
        const coin = Math.floor(cmd.coinId)
        if (coin >= 0 && coin < this.goneUntil.length) {
          // 落一枚，竹筒补一枚：延迟 400ms 之后滚出，滚 220ms
          this.rollFrom[coin] = this.now + CUP_ROLL_OUT_DELAY_MS
          this.goneUntil[coin] = this.now + CUP_ROLL_OUT_DELAY_MS + CUP_ROLL_OUT_MS
        }
        // 手里那枚交出去了
        this.lifted = -1
        this.carried = null
        this.blendFrom = null
        this.blendAt = -1
        this.traj = null
        this.launched = false
        this.landedFired = false
        this.armedSlot = -1
        return
      }

      case 'board:glow':
        this.glow = cmd.on
        return

      case 'slot:breathe':
        this.breathe = cmd.on
        return

      case 'tube:shake':
        this.shakeAt = this.now
        return

      case 'sonic:cadence':
        this.cadence = cmd.step
        return

      case 'haptic':
        if (cmd.kind !== 'none') this.haptic = cmd.kind
        return

      // coin:drop 只是"离开 LIFT"这件事的通报，是掷出去还是半途松手由
      // launch() 有没有被调用决定 —— 见 frame() 的第 ② 步。所以这里不处理。
      case 'coin:drop':
      default:
        return
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ② 起手与松手（场景层转交的手势）
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 起手：解一条抛物线，之后每一帧按它取点。
   *
   * ★ 为什么不由 `coin:fly` 的指令来解：那条指令诞生于状态机，而状态机**故意**
   *   不认识手势的力度与方向（它只认"够不够力"这个布尔）。力度数据在
   *   `Engine.onToss(ev)` 里，所以由场景层把它转到这里。
   *
   * ★ 关于时钟：`launch()` 发生在两帧之间，所以记的是**上一帧**的时刻。
   *   下一帧算出的 elapsed 会多出一个 dt（≤16ms），表现为"出手晚了一帧"——
   *   肉眼不可见，而换来的是与渲染器**只有一条时间轴**（不用拉起第二个时钟）。
   */
  launch(input: LaunchInput): void {
    if (this.lifted < 0) return
    this.lastActAt = this.now
    const from = input.from ?? this.carried ?? this.homeOf(this.lifted)

    this.traj = solveToss({
      from,
      dir: input.dir,
      displacePt: input.displacePt,
      releaseV: input.releaseV,
      board: this.board,
      bounds: this.bounds,
      rand: this.rand,
    })
    this.launchAt = this.now
    this.launched = true
    this.landedFired = false
    // 币出手了：不再跟手，位置完全交给轨迹
    this.carried = null
    this.blendFrom = null
    this.blendAt = -1
    this.armedSlot = -1
  }

  /**
   * 选位段松手。
   *
   * ★ 三种结局的**顺序**是需求，不是偏好（`resolveDrop` 里写死了）：
   *   先判吸附、再判反悔。两者判定域若重叠，宁可让用户落位成功，
   *   也不要"我明明放在格子上了，它却作废了"。
   *
   * ★ 判定半径 44 / 28 与爻位槽共用 `resolveSlot`，
   *   于是"在卦盘上学到的手感，到了别处是同一个手感"。
   *
   * ★★ **判的是"币在哪"，不是"手指在哪"**（这里曾经判错，是一个真的差一格）★★
   *   铜钱是按规范画在指针**上方 22pt** 的（`CURSOR_OFFSET_PT`，手感需要，否则
   *   手指会盖住币）。而六个爻位槽相邻只差 18.46pt —— 两者同量级，于是
   *   "手指在槽 i 底下 22pt"这个位置，到 **槽 i−1** 的距离是 21.5pt，
   *   到槽 i 的是 22pt：按手指判会吸到**隔壁那一格**。
   *   用户看到的是"币明明压在 3 号格上，它跳到了 2 号"。这类 bug 在真机上
   *   只会被描述成"吸得不准"，几乎不可能归因到 22pt 偏移。
   *
   *   所以判定点用 `this.carried`（币真正被画出来的地方），只在没有跟手位置时
   *   （掷出后没拖就松手）退回调用方给的指针点。
   *   这样还额外买到一条**不变量**：`view().armedSlot` 高亮的那个槽，
   *   就是松手会落进去的那个槽 —— 两者现在是同一个 `resolveSlot` 的同一个入参。
   */
  drop(at: Pt): DropResult {
    if (ritualMachine.state !== 'PLACE') return 'stay'
    if (this.lifted < 0) return 'stay'
    this.lastActAt = this.now

    const p = this.carried ?? at
    const occupied = ritualMachine.ctx.slotCoins.map((c) => c >= 0)
    const out = resolveDrop(p, SLOT_CENTERS, occupied, this.cup)

    if (out.kind === 'snap') {
      const slot = out.slot
      if (slot < 0 || slot >= SLOT_CENTERS.length) return 'stay'
      ritualMachine.send({ type: 'SNAP', slot: slot as SlotIndex })
      return 'snap'
    }

    if (out.kind === 'revoke') {
      // ★ 反悔 = 飞回筒口 → 进筒 → 补出一枚。不扣次数、不计失败、不留痕迹。
      const coin = this.lifted
      const from = this.coinPos() ?? p
      ritualMachine.send({ type: 'RECALL' })
      this.ret = {
        coinId: coin,
        from,
        to: { ...this.cup },
        at: this.now,
        ms: MS.flyBackToCup,
        arc: 14,
        intoCup: true,
      }
      this.clearHand()
      return 'revoke'
    }

    // 「停在别处：不弹回、不报错、保持可拖动」—— 什么都不做就是正确行为
    return 'stay'
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ③ 心跳
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 每帧一次。
   *
   * ★ 必须与画面同一个节奏（场景层把它挂在 `CanvasRenderer.onFrame` 上）：
   *   落定时间线比画面快或慢一帧，就会看到"币停在半空 / 尾巴先落地"。
   *
   * @param now 单调毫秒。★ 传渲染器的 `frame.t`（自启动累计），
   *            不要传墙上时钟 —— 落定判定和墙上时钟没有关系。
   */
  frame(now: number): void {
    try {
      this.tick(now)
    } catch (e) {
      // ★ 门禁 ⑨：时间线出错只是这一帧的动画不对，仪式本身继续。
      logger.warn('[ritual] 帧推进异常（已忽略）', e)
    }
  }

  private tick(now: number): void {
    const t = Number.isFinite(now) ? now : this.now
    this.now = t
    const st = ritualMachine.state

    // ── ① 回位 / 回筒走完 ────────────────────────────────────────────────
    const r = this.ret
    if (r && t - r.at >= r.ms) {
      this.ret = null
      if (r.intoCup) this.sendIntoTube(r.coinId, t)
    }

    // ── ② 半途松手（拾起了但没掷出去）→ 180ms 缓动落回原位 ────────────────
    // ★ 判据是 `launched` 而不是状态迁移的顺序：状态机的 exit 与 entry
    //   谁先谁后是实现细节，而"onToss 有没有被调用过"是确定的。
    if (this.ret === null && this.lifted >= 0 && !this.launched && (st === 'IDLE' || st === 'CAST')) {
      const coin = this.lifted
      const from = this.coinPos() ?? this.homeOf(coin)
      this.ret = { coinId: coin, from, to: this.homeOf(coin), at: t, ms: MS.fallBack, arc: 6, intoCup: false }
      this.clearHand()
    }

    // ── ③ 掷出去的币：飞到点就上报 LANDED（TOSS → PLACE 的唯一入口）──────
    const traj = this.traj
    if (traj && this.launched && !this.landedFired && t - this.launchAt >= traj.totalMs) {
      this.landedFired = true
      if (st === 'TOSS') {
        ritualMachine.send({ type: 'LANDED', landingPt: { ...traj.landing } })
        // 落盘那一下是"做成了"，所以有触感；未落盘面上则**什么都不给**
        if (traj.hit) this.haptic = 'light'
      }
    }

    // ── ④ 飞行被打断（进后台 / 反悔）：不判失败，也不留着半条轨迹 ──────────
    if (traj && t - this.launchAt > flightLifetimeMs(traj) && st !== 'TOSS' && st !== 'PLACE') {
      this.traj = null
      this.launched = false
    }

    // ── ⑤ 预备吸附：≤44pt 时该槽描边提亮 + 币给 1.08 ─────────────────────
    this.armedSlot = -1
    if (st === 'PLACE' && this.carried) {
      const occupied = ritualMachine.ctx.slotCoins.map((c) => c >= 0)
      const probe = resolveSlot(this.carried, SLOT_CENTERS, { occupied })
      if (probe.armed) this.armedSlot = probe.index
    }

    // ── ⑥ 补币滚完了就把它交还给桌面 ──────────────────────────────────────
    for (let i = 0; i < this.goneUntil.length; i++) {
      if (this.goneUntil[i] >= 0 && t >= this.goneUntil[i]) {
        this.goneUntil[i] = -1
        this.rollFrom[i] = -1
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ④ 对外投影
  // ─────────────────────────────────────────────────────────────────────────

  /** 这一帧该画什么 */
  view(): RitualView {
    const st = ritualMachine.state
    const ctx: RitualCtx = ritualMachine.ctx
    const coinId = this.activeCoinId()

    const traj = this.traj
    const flight = traj ? sampleFlight(traj, this.now - this.launchAt) : null
    const flying = !!flight && st === 'TOSS'

    const slots: number[] = [...ctx.slotCoins]
    const slotEase = slots.map((c, i) =>
      c < 0 ? -1 : clamp01((this.now - this.slotSettledAt[i]) / MS.snap),
    )

    const coinAt = coinId >= 0 ? this.coinPos() : null
    const onTable: boolean[] = []
    const drawCoins: (Pt | null)[] = []
    const rollOut: number[] = []
    for (let i = 0; i < this.home.length; i++) {
      if (i === coinId) {
        // 手上 / 空中 / 回位中的那一枚：由"空中铜钱"图层画
        onTable.push(false)
        drawCoins.push(coinAt)
        rollOut.push(1)
        continue
      }
      const f = this.coinFrameOf(i)
      onTable.push(f.onTable)
      drawCoins.push(f.at)
      rollOut.push(f.roll)
    }

    return {
      state: st,
      coinId,
      coinAt,
      coinScale: this.coinScaleOf(st, flying),
      coinSquashX: flying && flight ? spinSquashX(flight.spinRad) : 1,
      coinAlpha: this.coinAlphaNow(),
      dimOthers: (st === 'LIFT' || st === 'TOSS') && coinId >= 0,
      flight,
      landingAt: traj && (st === 'TOSS' || st === 'PLACE') ? { ...traj.landing } : null,
      predictAt: traj && st === 'TOSS' ? predictRingAt(traj, this.board) : null,
      halo: this.haloK(st),
      glow: this.glow,
      breathe: this.breathe,
      breatheFast: st === 'PLACE' && this.now - this.lastActAt > TH.PLACE_GUIDE_MS,
      armedSlot: this.armedSlot,
      slots,
      slotEase,
      onTable,
      drawCoins,
      rollOut,
      tubeShake: this.tubeShakeNow(),
      cadenceStep: this.cadence,
      coinHome: this.home,
      cup: { ...this.cup },
    }
  }

  /**
   * 活着的铜钱位置 —— 发布给命中层（`engineHost.setLiveCoins`）。
   *
   * ★ 下标必须与 `coinId` 一一对应：命中层是用下标回答"戳到了第几枚"的。
   * ★ 在筒里的那枚报"筒口"而不是"家"：报家会让一个**空位置**看上去有币，
   *   报筒口则意味着"长按竹筒也能拿一枚" —— 后者不但没错，反而更符合直觉。
   */
  liveCoins(): Pt[] {
    return this.home.map((h, i) => {
      const f = this.coinFrameOf(i)
      if (f.at) return f.at
      // 在某个槽里 → 币就在槽心上
      const slot = ritualMachine.ctx.slotCoins.indexOf(i)
      if (slot >= 0) return { ...SLOT_CENTERS[slot] }
      // 在筒里 / 还没滚出来 → 报筒口
      if (f.roll < 1) return { ...this.cup }
      return { ...h }
    })
  }

  /** 取走这一帧的触感信号（一次性）。★ 取走即清，免得同一帧震两次 */
  consumeHaptic(): HapticCue | null {
    const h = this.haptic
    this.haptic = null
    return h
  }

  /** 测试与调试用：现在手上有币吗、轨迹还活着吗 */
  inspect(): { lifted: number; launched: boolean; hasTraj: boolean; returning: boolean } {
    return {
      lifted: this.lifted,
      launched: this.launched,
      hasTraj: this.traj !== null,
      returning: this.ret !== null,
    }
  }

  /**
   * 复位。
   * ★ 状态机的 ctx 由 `ritualMachine.reset()` 管，这里只管**自己这一份**。
   *   两件事都要做，缺一个就会出现"币的位置对了但格子还占着"这类半复位。
   */
  reset(): void {
    this.now = 0
    this.lifted = -1
    this.liftAt = 0
    this.carried = null
    this.blendFrom = null
    this.blendAt = -1
    this.traj = null
    this.launchAt = 0
    this.launched = false
    this.landedFired = false
    this.ret = null
    this.glow = false
    this.breathe = false
    this.armedSlot = -1
    this.slotSettledAt = SLOT_CENTERS.map(() => -Infinity)
    this.goneUntil = this.home.map(() => -1)
    this.rollFrom = this.home.map(() => -1)
    this.shakeAt = -1
    this.cadence = 0
    this.haptic = null
    this.lastActAt = 0
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 内部
  // ─────────────────────────────────────────────────────────────────────────

  private clearHand(): void {
    this.lifted = -1
    this.carried = null
    this.blendFrom = null
    this.blendAt = -1
    this.traj = null
    this.launched = false
    this.landedFired = false
    this.armedSlot = -1
  }

  private homeOf(i: number): Pt {
    const h = this.home[i]
    return h ? { ...h } : { x: 0, y: 0 }
  }

  /** 正在被摆弄的铜钱编号：回位中的优先（那时候 `lifted` 已经清空了） */
  private activeCoinId(): number {
    return this.ret ? this.ret.coinId : this.lifted
  }

  /**
   * 铜钱此刻该画在哪。
   *
   * 四段优先级，顺序即语义：
   *   ① 回位 / 回筒中 → 走那条插值（它已经把 `lifted` 交还了，所以必须排最前）
   *   ② 跟手 → `carried`，并从"抬起时的位置"用 120ms 混过来（否则起手瞬间跳 22pt）
   *   ③ 在空中 → 轨迹取点
   *   ④ 刚拾起还没拖 → 原地浮起 5pt
   */
  private coinPos(): Pt | null {
    if (this.ret) return this.retPos(this.now)
    const coin = this.lifted
    if (coin < 0) return null

    const target = this.carried
    if (!target) {
      const st = ritualMachine.state
      if (st === 'TOSS' && this.traj) return sampleFlight(this.traj, this.now - this.launchAt).at
      if (st === 'PLACE' && this.traj) return sampleFlight(this.traj, this.now - this.launchAt).at
      // 还没拖动：原地抬起 COIN_LIFT_DY(5pt)
      const h = this.homeOf(coin)
      const p = st === 'LIFT' ? easeOutCubic((this.now - this.liftAt) / MS.lift) : 1
      return { x: h.x, y: h.y - COIN_LIFT_DY * p }
    }

    if (this.blendAt < 0 || !this.blendFrom) return { ...target }
    const p = easeOutCubic((this.now - this.blendAt) / MS.lift)
    if (p >= 1) return { ...target }
    return {
      x: this.blendFrom.x + (target.x - this.blendFrom.x) * p,
      y: this.blendFrom.y + (target.y - this.blendFrom.y) * p,
    }
  }

  /** 半途松手后的落回原位 / 反悔后的飞回筒口 */
  private retPos(t: number): Pt | null {
    const r = this.ret
    if (!r) return null
    const p = clamp01((t - r.at) / r.ms)
    const e = easeOutCubic(p)
    return {
      x: r.from.x + (r.to.x - r.from.x) * e,
      y: r.from.y + (r.to.y - r.from.y) * e - r.arc * Math.sin(Math.PI * p),
    }
  }

  /** 某一枚铜钱这一帧的"交给谁画" */
  private coinFrameOf(i: number): { onTable: boolean; at: Pt | null; roll: number } {
    const active = this.activeCoinId()
    if (active === i) return { onTable: false, at: this.coinPos(), roll: 1 }

    // 在某个槽里 → 由"落位铜钱"图层画，这里不画
    if (ritualMachine.ctx.slotCoins.indexOf(i) >= 0) return { onTable: false, at: null, roll: 1 }

    const gone = this.goneUntil[i] ?? -1
    if (gone < 0) return { onTable: true, at: null, roll: 1 }

    // 在筒里（还没开始滚）
    const from = this.rollFrom[i] ?? -1
    if (from < 0 || this.now < from) return { onTable: false, at: null, roll: 0 }

    // 正在滚出来：从筒口滑到家里，带一点弧
    const p = clamp01((this.now - from) / CUP_ROLL_OUT_MS)
    const h = this.homeOf(i)
    const e = easeOutCubic(p)
    return {
      onTable: false,
      at: {
        x: this.cup.x + (h.x - this.cup.x) * e,
        y: this.cup.y + (h.y - this.cup.y) * e - 7 * Math.sin(Math.PI * p),
      },
      roll: p,
    }
  }

  /** 落一枚进筒 → 竹筒补一枚（等 400ms，滚 220ms） */
  private sendIntoTube(coin: number, t: number): void {
    if (coin < 0 || coin >= this.goneUntil.length) return
    this.rollFrom[coin] = t + CUP_ROLL_OUT_DELAY_MS
    this.goneUntil[coin] = t + CUP_ROLL_OUT_DELAY_MS + CUP_ROLL_OUT_MS
  }

  private coinScaleOf(st: RitualState, flying: boolean): number {
    if (this.activeCoinId() < 0) return 1
    if (flying || st === 'TOSS') return COIN_LIFT_SCALE
    if (st === 'LIFT') {
      // 1.00 → 1.15，120ms
      const p = easeOutCubic((this.now - this.liftAt) / MS.lift)
      return 1 + (COIN_LIFT_SCALE - 1) * p
    }
    if (st === 'PLACE') return this.armedSlot >= 0 ? COIN_PRESELECT_SCALE : COIN_LIFT_SCALE
    return COIN_LIFT_SCALE
  }

  private coinAlphaNow(): number {
    const r = this.ret
    if (!r || !r.intoCup) return 1
    // 进筒的最后 25% 渐隐 —— 币是"被筒口收进去"的，不是穿模进去的
    const p = clamp01((this.now - r.at) / r.ms)
    return p <= 0.75 ? 1 : Math.max(0, 1 - (p - 0.75) / 0.25)
  }

  private tubeShakeNow(): number {
    if (this.shakeAt < 0) return 0
    const p = (this.now - this.shakeAt) / CUP_SHAKE_DECAY_MS
    if (p < 0 || p >= 1) return 0
    const k = 1 - p
    return k * k
  }

  /**
   * 光环 / 柔紫投影的强度。
   * ★ 只有"在手上"才亮 —— 飞出去之后币的视觉重心是拖尾，再叠一圈光环会糊成一团。
   *   选位段重新拖起来时又亮回来（那次也是"拿在手上"）。
   */
  private haloK(st: RitualState): number {
    if (this.activeCoinId() < 0) return 0
    if (st === 'LIFT') {
      return this.carried ? 1 : easeOutCubic((this.now - this.liftAt) / MS.lift)
    }
    if (st === 'PLACE') return this.carried ? 1 : 0
    return 0
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 小工具
// ───────────────────────────────────────────────────────────────────────────

/**
 * 落点预示环的位置 —— ★ 直接用 `flight.ts` 的 `predictRingAt()`，不在这里再写一遍。
 *
 * 那条"没掷中时落在离盘心最近的位置"的规则（用户看到的是"差一点"而不是"没中"）
 * 已经在 flight.ts 里实现并有单测守着。复制一份到这里，两份会慢慢漂移，
 * 而漂移的表现是"预示环和实际落点对不上"—— 那是手感 bug 里最难归因的一种。
 */

/** 未落位的币与已落位的币的相对尺寸 —— 场景层画"槽里的币"时要用到 */
export const SETTLED_COIN_SCALE = COIN_SETTLED_PT / COIN_IDLE_PT

/** 被压暗的那两枚的透明度 / 缩放（场景层画待机币时用） */
export const DIM_OTHERS = Object.freeze({ alpha: DIM_OTHERS_ALPHA, scale: DIM_OTHERS_SCALE })

/** 反悔判定的半径（pt）—— 与爻位槽共用同一组阈值，导出只是为了让 UI 有话可说 */
export const REVOKE_RADIUS_PT = TH.REVOKE_PT

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
