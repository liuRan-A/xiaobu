/**
 * 小卜 · 掷币仪式主状态机   src/core/machine/ritualMachine.ts
 * ===========================================================================
 *   IDLE ──LONG_PRESS──▶ LIFT ──RELEASE(够力)──▶ TOSS ──LANDED──▶ PLACE ──SNAP──▶ IDLE
 *                                 │                                │
 *                                 └──RELEASE(不够力)──▶ IDLE        └──RECALL──▶ IDLE
 *   第 6 枚落定 → CAST（瞬态，收束六音后交解读页）
 *
 * ★★★ 三个"不"（已写成单测断言，改代码前先看这里）★★★
 *   不判失败  —— 非法转移 / 不足阈值 / 未落盘，只 logger.warn，回最近合法态，
 *                绝不产生任何用户可见反馈（无红色、无震动、无提示条）。
 *   不消费次数 —— RECALL（拖回竹筒）/ 短按 / 半途松手，一律作废但**不计失败、不进冷却**。
 *   不看天气、不看开发模式 —— 输入只有手势与时间，输出只有场景指令。
 *                仪式机的行为，不该因为下雨或开了 DevPanel 而有任何差别。
 *
 * ★★★ 防崩门禁 ★★★
 *   ⑨ catch 块禁止出 UI         —— 本文件内不得出现任何 alert / Toast / showModal
 *   ⑩ 禁止 LocalStorage 持久化上报队列 —— 埋点只走内存缓冲
 *   ★ 额外：本文件内禁止出现 isDevMode / devStore / config.features / weather / localStorage。
 *     ESLint 与 ci/gates 会拦；这条约束是"开发模式绝不能改变仪式行为"的落点。
 * ===========================================================================
 */
import { createMachine, type Vec2 } from './createMachine'
import { logger } from '@shared/logger'
import { TH } from '@core/ritual/thresholds'
import { castLineValue } from '@core/liuyao/castLine'

// ── 阈值：全部来自 core/ritual/thresholds.ts（规范 §2.2 的唯一数值来源）──
//   ★ 这里只做"别名再导出"，不重新定义数字 —— 否则又变成两处各写一份。
//     规范原文：「阈值常量（全部集中在这里，方便调参；不许散落在表现层）」。
export const MIN_HOLD_MS = TH.LONG_PRESS_MS // 拾起阈值：触到就回应，不必等满
export const TOSS_MIN_PT = TH.SWIPE_MIN_PT // 上滑掷出阈值
export const SNAP_RADIUS_PT = TH.SNAP_PT // 吸附半径（落定）
export const RECALL_RADIUS_PT = TH.REVOKE_PT // 反悔半径（拖回竹筒作废）
export const SETTLE_MS = TH.SETTLE_MS // 落盘后静止多久自动进选位

/**
 * IDLE 静默多久 → 小卜说一句。
 * ★ 规范 §5 引导态 A 定的是 **20s**，且明确"不催、不倒数、不闪红" ——
 *   早先这里写成 3s，3 秒就开口会显得在催，与"把卡住翻译成我陪着你"相悖。
 */
export const QUIET_HINT_MS = TH.IDLE_GUIDE_MS
export const PLACE_IDLE_HINT_MS = TH.PLACE_GUIDE_MS

// ── 状态与事件 ──────────────────────────────────────────────────────────────
export type RitualState = 'IDLE' | 'LIFT' | 'TOSS' | 'PLACE' | 'CAST'

/** 一爻：老阴 6 / 少阴 8 / 少阳 7 / 老阳 9（三枚铜钱定一爻） */
export type LineValue = 6 | 7 | 8 | 9

export type RitualEvent =
  | { type: 'LONG_PRESS'; coinId: number; heldMs: number }
  | { type: 'DRAG'; point: Vec2 } // 仅更新表现，不迁移
  | { type: 'RELEASE'; distancePt: number; dir: Vec2 }
  | { type: 'LANDED'; landingPt: Vec2 }
  | { type: 'SNAP'; slot: 0 | 1 | 2 | 3 | 4 | 5 }
  | { type: 'RECALL' } // 拖回竹筒 → 作废但不失败
  | { type: 'TICK'; idleMs: number } // 驱动温柔引导
  | { type: 'CAST_DONE' }

export interface RitualCtx {
  /** 已落定的爻（长度 0–5；第 6 枚落定即进入 CAST） */
  lines: LineValue[]
  /**
   * 六个爻位槽上各停着哪一枚铜钱（-1 = 空槽）。
   *
   * ★ 它是**占位判定**的唯一依据，取代了早期那句 `slot < lines.length` 的近似。
   *   为什么必须换成真表：`lines.length` 只知道"落了几爻"，不知道"落在哪一格"——
   *   用户把第一枚放在第 4 槽时，旧近似会认为 0–0 号槽被占，于是
   *   · 第 4 槽在**视觉上已经有一颗币**，玩法上却判为空；
   *   · 0 号槽**视觉上空的**，玩法上却"这里有人了"。
   *   两种错都表现为"它明明在那儿，却说我放不了"，或者"空的格子放不进去"。
   *   放进 ctx 而不是做成注入式全局：它是**这一场仪式**的状态，
   *   必须跟着 `reset()` / `initialCtx` 一起回到干净态（否则上一局的币会留在格子上）。
   */
  slotCoins: number[]
  /** 当前被持有的铜钱下标；-1 表示空手 */
  holdingCoin: number
  /** 当前吸附中的爻位；-1 表示未指向任何槽 */
  hoverSlot: number
  /** 桌面剩余铜钱数：桌面上永远"刚好三枚"（落一枚，竹筒补一枚） */
  coinsOnTable: number
  /** 最近一次落盘的时间戳，用于 SETTLE_MS 判定 */
  settledAt: number
  /** 六音上行的当前音级 0–5 */
  cadenceStep: number
}

/** 场景指令出口 —— 只发指令，不碰 DOM / Vue 对象 */
export type SceneCommand =
  | { type: 'coin:lift'; coinId: number }
  | { type: 'coin:drop'; coinId: number }
  | { type: 'coin:fly'; from: Vec2; to: Vec2; arc: number }
  | { type: 'board:glow'; on: boolean }
  | { type: 'slot:breathe'; on: boolean }
  | { type: 'slot:snap'; slot: number; coinId: number }
  | { type: 'tube:shake' }
  | { type: 'sonic:cadence'; step: number }
  | { type: 'haptic'; kind: 'light' | 'medium' | 'none' }

export type CommandSink = (cmd: SceneCommand) => void

/** 由 ritualEngine 注入的场景指令通道（M2 接入；M1 用空实现保证可跑） */
let emit: CommandSink = () => {}

export function setCommandSink(fn: CommandSink): void {
  emit = fn
}

// ── 内部小工具（纯函数，可单测） ───────────────────────────────────────────

/** nearest-slot: 以 28pt 为落定半径，找最近爻位；都不在范围内返回 -1 */
function nearestSlot(point: Vec2, centers: Vec2[]): number {
  let best = -1
  // ★ 显式标 number：SNAP_RADIUS_PT 现在是 TH.SNAP_PT（`as const` ⇒ 字面量类型 28），
  //   不标注的话这里会被推成 `28`，下面的 bestDist = d 直接编译不过。
  let bestDist: number = SNAP_RADIUS_PT
  centers.forEach((c, i) => {
    const d = Math.hypot(point.x - c.x, point.y - c.y)
    if (d <= bestDist) {
      bestDist = d
      best = i
    }
  })
  return best
}

/**
 * 三枚铜钱 → 一爻。★ 真实现住在 `core/liuyao/castLine.ts`（三枚各翻一面求和，
 * 1/8 : 3/8 : 3/8 : 1/8，老阴 / 老阳 = 动爻）。M1 占位（只有 7/8，变爻永远
 * 掷不出来）已被替换。`setCastLine` 保留给单测注入确定性序列 ——
 * 运行时谁也不许调它（天气 / 开发模式同样不许改这个值）。
 */
let castLineImpl: () => LineValue = () => castLineValue()

export function setCastLine(fn: () => LineValue): void {
  castLineImpl = fn
}

/**
 * 成卦收口：CAST 进入时把六爻交出去。
 * ★ 状态机自己不建卦（它只认手势与时间）；由引擎（engine.ts 构造时）注入
 *   `buildHexagram(lines) → castDone()`，卦象才算得出来、房间机才进得了解读。
 *   M1 时这里是 TODO(D7)，现在由这条缝接通 —— 机器依旧零业务、可独立单测。
 */
export type CastCollector = (lines: readonly LineValue[]) => void
let castCollector: CastCollector = () => {}

export function setCastCollector(fn: CastCollector): void {
  castCollector = fn
}

/** 温柔引导：只发一条"该说话了"的信号，台词由 UI 层决定（气泡文案库在 ui 侧） */
export type GuideKind = 'IDLE_QUIET' | 'PLACE_IDLE'
let guide: (kind: GuideKind) => void = () => {}

export function setGuide(fn: (kind: GuideKind) => void): void {
  guide = fn
}

// ── 状态机本体 ──────────────────────────────────────────────────────────────

/**
 * 六爻位槽中心 —— 与设计稿等距坐标一致，沿 u 轴每步 (±16.5, −8.25)。
 *
 * ★ 位置必须在本文件靠前处（在 `ritualMachine` 之前）：`initialRitualCtx()`
 *   会用它造出空槽表，而 `createMachine({ ctx: initialRitualCtx() })` 是**模块求值期**
 *   就执行的 —— 表放在下面会撞 TDZ（`Cannot access 'SLOT_CENTERS' before initialization`），
 *   而且报错发生在 import 阶段，整个模块直接加载失败，比运行时 bug 更难定位。
 */
export const SLOT_CENTERS: Vec2[] = [
  { x: 175.5, y: 549.2 },
  { x: 192.0, y: 541.0 },
  { x: 208.6, y: 532.7 },
  { x: 225.1, y: 524.5 },
  { x: 241.6, y: 516.2 },
  { x: 258.1, y: 508.0 },
]

/**
 * ★ 初始上下文工厂 —— 理由同 roomMachine：
 *   `lines` 是数组，若直接把字面量给 `ctx`，它就成了模块级单例，
 *   上一个引擎实例掷出的爻会留给下一个（单测表现为"单跑绿、连跑红"）。
 */
export function initialRitualCtx(): RitualCtx {
  return {
    lines: [],
    // ★ 每个引擎实例一份新的空槽表。写成模块级常量会让上一局的六枚币留在格子上 ——
    //   与 `lines` 是同一类坑，所以两件事必须在同一个工厂里做。
    slotCoins: SLOT_CENTERS.map(() => -1),
    holdingCoin: -1,
    hoverSlot: -1,
    coinsOnTable: 3,
    settledAt: 0,
    cadenceStep: 0,
  }
}

export const ritualMachine = createMachine<RitualState, RitualCtx, RitualEvent>({
  initial: 'IDLE',

  ctx: initialRitualCtx(),
  initialCtx: initialRitualCtx,

  onWarn: (msg, detail) => {
    // ★ 门禁 ⑨：非法转移只记一条 warn。不弹窗、不震动、不改变画面。
    logger.warn('[ritual]', msg, detail)
  },

  states: {
    /**
     * IDLE —— 待机
     * 画面：三枚铜钱静躺筒前，卦盘六槽全空、不发光；小卜守在桌缘随呼吸起伏。
     * 屏幕上一个字都没有。3 秒没动静，小卜才从气泡里轻轻说一句，5 秒自己收回。
     */
    IDLE: {
      entry: (ctx) => {
        ctx.holdingCoin = -1
        ctx.hoverSlot = -1
        ctx.coinsOnTable = 3
      },
      on: {
        LONG_PRESS: (ctx, e) => {
          // 不足阈值：静默回位，不报错、不计失败
          if (e.heldMs < MIN_HOLD_MS) return 'IDLE'
          ctx.holdingCoin = e.coinId
          return 'LIFT'
        },
        TICK: (_ctx, e) => (e.idleMs > QUIET_HINT_MS ? (guide('IDLE_QUIET'), 'IDLE') : 'IDLE'),
      },
    },

    /**
     * LIFT —— 拾起
     * 画面：被拾那枚放大 1.15、上浮 5pt，脚下留柔紫投影，四周漫开暖金柔光（是「光」不是「高亮框」）；
     *      另两枚压暗 8%；小卜抬头，视线一路跟着铜钱走。零文字。
     */
    LIFT: {
      entry: (ctx) => {
        emit({ type: 'coin:lift', coinId: ctx.holdingCoin })
        emit({ type: 'haptic', kind: 'light' })
      },
      on: {
        DRAG: (_ctx, e) => {
          // 仅更新表现层：拖拽不产生状态迁移
          emit({ type: 'coin:fly', from: { x: 0, y: 0 }, to: e.point, arc: 0 })
          return 'LIFT'
        },
        RELEASE: (ctx, e) => {
          // 够力 → 掷；不够力 → 180ms 缓动落回原位（作废，但不计失败）
          if (Math.abs(e.distancePt) >= TOSS_MIN_PT) return 'TOSS'
          ctx.holdingCoin = -1
          return 'IDLE'
        },
        RECALL: (ctx) => {
          // ★ 拖回竹筒：作废但不失败。不扣次数、不进冷却、不留任何痕迹。
          ctx.holdingCoin = -1
          return 'IDLE'
        },
      },
      exit: () => emit({ type: 'coin:drop', coinId: -1 }),
    },

    /**
     * TOSS —— 掷盘
     * 画面：铜钱拖着暖金尾迹沿圆弧飞出并自旋；竹筒高频轻颤（±1.5pt）、弹起 4 粒木屑、
     *      周围扬起一圈金色粒子。落盘激起两圈涟漪，弹跳一次后停住。落盘声每次随机 ±2 半音。
     */
    TOSS: {
      entry: (_ctx, e) => {
        if (e.type === 'RELEASE') {
          const arc = Math.abs(e.distancePt) / 2 // 弧高随力度增长，手感可学
          emit({ type: 'coin:fly', from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, arc })
        }
        emit({ type: 'tube:shake' })
        emit({ type: 'haptic', kind: 'medium' })
      },
      on: {
        LANDED: (ctx) => {
          ctx.settledAt = Date.now()
          return 'PLACE'
        },
        // 飞行中被打断（比如进后台）：当作作废处理，不判失败
        RECALL: (ctx) => {
          ctx.holdingCoin = -1
          return 'IDLE'
        },
      },
    },

    /**
     * PLACE —— 选位
     * 画面：卦盘整体提亮 6% + 柔紫外晕；六爻位槽变柔紫底 + 细描边缓慢呼吸；
     *      已落过位的槽上放着铜钱、不再高亮。拖到 28pt 以内被「吸」过去，120ms 缓动轻轻落定。
     *      六次落位音一次比一次高，串成一小段旋律。
     */
    PLACE: {
      entry: () => {
        emit({ type: 'board:glow', on: true })
        emit({ type: 'slot:breathe', on: true })
      },
      on: {
        DRAG: (ctx, e) => {
          // 最近中心点吸附：命中就高亮，离开就熄灭（纯表现，不迁移）
          const slot = nearestSlot(e.point, SLOT_CENTERS)
          ctx.hoverSlot = slot
          // ★ 选位段**也要**发"跟手"指令，与 LIFT 段同一条（`arc: 0`）。
          //   漏了它的后果不是"少一个高亮"，而是整条落位链路断掉：
          //   引擎的 `carried`（币现在被拿在哪）只能从这条指令更新，没有它
          //   · 币会死死钉在落点上，手指拖多远都不动；
          //   · `view().armedSlot` 永远是 -1（预备吸附高亮从不出现）；
          //   · `drop()` 判的是"币在哪" ⇒ 吸附与反悔**都判不出来**，
          //     松手永远只能得到「停在别处」。
          //   这是"画面对了、但玩法没反应"的典型：单看动画像没接完，其实是没接线。
          emit({ type: 'coin:fly', from: { x: 0, y: 0 }, to: e.point, arc: 0 })
          return 'PLACE'
        },
        SNAP: (ctx, e) => {
          // 该槽已被占：静默忽略（不是失败，只是"这里有人了"）
          // ★ 判据是**真占位表**，不是"落了几爻" —— 见 RitualCtx.slotCoins 的说明
          if (isSlotOccupied(ctx, e.slot)) return 'PLACE'

          ctx.lines.push(castLineImpl())
          ctx.slotCoins[e.slot] = ctx.holdingCoin
          ctx.cadenceStep = ctx.lines.length - 1
          emit({ type: 'slot:snap', slot: e.slot, coinId: ctx.holdingCoin })
          emit({ type: 'sonic:cadence', step: ctx.cadenceStep })
          emit({ type: 'haptic', kind: 'light' })

          if (ctx.lines.length >= 6) return 'CAST'

          // 本爻落定 → 回 IDLE 等下一枚（竹筒会悄悄补出一枚，桌上永远刚好三枚）
          ctx.holdingCoin = -1
          ctx.hoverSlot = -1
          return 'IDLE'
        },
        RECALL: (ctx) => {
          // ★ 拖回竹筒作废：不计失败、不扣次数
          ctx.holdingCoin = -1
          ctx.hoverSlot = -1
          return 'IDLE'
        },
        TICK: (_ctx, e) =>
          e.idleMs > PLACE_IDLE_HINT_MS ? (guide('PLACE_IDLE'), 'PLACE') : 'PLACE',
      },
      exit: () => {
        emit({ type: 'board:glow', on: false })
        emit({ type: 'slot:breathe', on: false })
      },
    },

    /**
     * CAST —— 成卦（瞬态）
     * 第 6 枚落定后的收束：六音上行 → 本地算出本卦/变卦 → 把卦象交给 UI 层。
     * ★ 卦象由本地算法决定，天气、开发模式、网络状态都不得参与。
     */
    CAST: {
      entry: (ctx) => {
        // ★ 成卦 = 纯本地：六爻在手，卦象由 `buildHexagram`（core/liuyao）算出，
        //   经 castCollector 交给引擎送房间机。埋点只上报卦象序号，
        //   不上报爻值、不上报任何解读文案。
        castCollector([...ctx.lines])
        emit({ type: 'sonic:cadence', step: 5 })
      },
      on: {
        CAST_DONE: (ctx) => {
          ctx.lines = []
          // ★ 成卦之后六个槽才清空。**不能**在 IDLE.entry 里清 ——
          //   每落一枚都会回 IDLE，在那儿清等于"刚放上去就没了"。
          ctx.slotCoins = SLOT_CENTERS.map(() => -1)
          ctx.cadenceStep = 0
          return 'IDLE'
        },
      },
    },
  },
})

/** 六爻位槽中心 —— ★ 定义在文件靠前的「状态机本体」一节（TDZ 原因见那里） */

/**
 * 该槽上是不是已经有币。
 *
 * ★ 读的是 `ctx.slotCoins`（真占位表），不再是"落了几爻"的近似。
 *   近似版本在这里留过一句话：「M2 接入真实占位表后替换」—— 现在替换完了，
 *   而替换它的理由不是"更精确"，是**旧写法会让视觉与判定互相矛盾**：
 *   用户把第一枚落在第 4 槽，旧写法认为 0 号槽被占、4 号槽是空的，
 *   于是画面上第 4 槽明明白白躺着一枚币，玩法却说他"放不进去"。
 */
function isSlotOccupied(ctx: RitualCtx, slot: number): boolean {
  const i = Math.floor(slot)
  if (!Number.isFinite(i) || i < 0 || i >= ctx.slotCoins.length) return true // 越界一律当"占着"，宁可拒绝也不越界
  return ctx.slotCoins[i] >= 0
}

/**
 * 六个槽里还有哪些是空的 —— 它同时是"该不该进 CAST"的判据。
 * ★ 与 `ctx.lines.length >= 6` 是等价的，但用它可以一眼看出两边不会打架。
 */
export function openSlotCount(ctx: RitualCtx): number {
  return ctx.slotCoins.filter((c) => c < 0).length
}

export { nearestSlot }
