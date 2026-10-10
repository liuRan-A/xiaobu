/**
 * 小卜 · 房间主流程状态机   src/core/machine/roomMachine.ts
 * ===========================================================================
 * 这是**顶层流程**：从打开 App 到放好一件东西、到某个日子到来。
 * 掷币仪式的四态不在这个文件里 —— 它是下一层的 `ritualMachine`，
 * 由 engine 在 `RITUAL` 这一段转发事件（见下方「与仪式机的关系」）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  文字版状态转移图（与 docs《系统架构文档-v2》§3 同一份，改一处要改两处）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   ┌────────┐  BOOT_READY（首次）   ┌────────┐
 *   │  BOOT  ├─────────────────────▶│ GUIDE  │  小卜私语气泡，逐步、上手即淡出
 *   └───┬────┘                      └───┬────┘
 *       │ BOOT_READY（见过）             │ GUIDE_DONE / GUIDE_ACTION（做完即淡出）
 *       │                               │
 *       ▼                               ▼
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │                              ROOM                                    │
 *   │  房间待机。可进入四条支线：                                           │
 *   └──┬───────────────┬──────────────────┬──────────────────┬─────────────┘
 *      │ ENTER_ZONE    │ ENTER_ZONE       │ OPEN_COUNTDOWN   │ RECALL_MEMORY
 *      │ TAROT         │ LIUYAO           │                  │
 *      ▼               ▼                  ▼                  ▼
 *  ┌────────────┐  ┌───────────┐   ┌───────────────┐  ┌──────────────┐
 *  │SPREAD_PICK │  │MOOD_PICK  │   │COUNTDOWN_SET  │  │MEMORY_RECALL │
 *  │翻开手账     │  │今天什么感觉│   │给一件事定日子  │  │点一下它      │
 *  └─────┬──────┘  └─────┬─────┘   └───────┬───────┘  └──────┬───────┘
 *        │PICK_SPREAD    │PICK_MOOD          │SET/CANCEL       │CLOSE
 *        ▼               ▼                   └────▶ ROOM ◀────┘
 *  ┌────────────┐  ┌───────────┐
 *  │SPREAD_DRAW │  │FOCUS_PICK │
 *  │一张张翻     │  │想聊哪类事  │
 *  └─────┬──────┘  └─────┬─────┘
 *        │ 翻满 / READ_DONE │PICK_FOCUS
 *        │               ▼
 *        │         ┌───────────┐
 *        │         │PLACE_ITEM │  拖到 窗边 / 木桌 / 香炉旁
 *        │         └─────┬─────┘
 *        │               │PLACE_ITEM（放下即进，无失败态）
 *        │               ▼
 *        │         ┌───────────┐
 *        │         │  RITUAL   │◀── 四态子机：IDLE→LIFT→TOSS→PLACE→CAST
 *        │         └─────┬─────┘
 *        │               │RITUAL_CAST_DONE
 *        ▼               ▼
 *   ┌────────────────────────────┐
 *   │         READING            │  解读（本地优先，网络降级成本地模板）
 *   └─────────────┬──────────────┘
 *                 │ READ_DONE
 *                 ▼
 *   ┌────────────────────────────┐   OFFER_MEMORY   ┌──────────────┐
 *   │       MEMORY_OFFER         ├─────────────────▶│ MEMORY_PLACE │
 *   │ 这几样东西，想带走哪一件？    │                  │拖到小屋某处   │
 *   └─────────────┬──────────────┘                  └──────┬───────┘
 *                 │ SKIP_MEMORY（不带走也完全可以）          │ PLACE_MEMORY
 *                 └──────────────────┬──────────────────────┘
 *                                    ▼
 *                                  ROOM
 *
 *   并行的第三条线（不打断任何流程）：
 *     任意时刻 → 引擎每 tick 查一次倒计时（**纯本地时间戳**）
 *     若某个已归零且未发过纪念品，且当前状态是 ROOM
 *        → COUNTDOWN_FIRED → COUNTDOWN_DUE（特殊记忆锚点 + 专属纪念品）→ ACK_DUE → ROOM
 *     ★ 不打断：正在占卜/正在看解读时，归零事件**排队**，等回到 ROOM 再出现。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  与仪式机的关系
 * ═══════════════════════════════════════════════════════════════════════════
 *   · 本机只负责"**什么时候可以掷币**"（进入 / 离开 RITUAL 段）。
 *   · 手指事件由 engine 直接转发给 `ritualMachine`，但**仅当**
 *     `roomMachine.state === 'RITUAL'` —— 在翻开手账时手指乱划不该触发掷币。
 *   · 仪式机不认识本机，本机也不认识仪式机的内部状态 —— 只有一个汇合点：
 *     `RITUAL_CAST_DONE`（卦象算完了）。这样两台机器的单测可以完全独立。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  四条"不"（与 ritualMachine 同款，写进单测）
 * ═══════════════════════════════════════════════════════════════════════════
 *   ① 不判失败 —— 全部非法转移只 logger.warn，回最近合法态，零用户可见反馈
 *   ② 不打断 —— 读解读时倒计时归零不弹、不抢焦点，排队等 ROOM
 *   ③ 不困住 —— 每个支线都有 `LEAVE_ZONE`（或等价出口），用户随时能走
 *   ④ 不静默丢数据 —— 中途离开只丢"这一次未完成的流程"，不丢已落成的记忆与倒计时
 * ===========================================================================
 */

import { createMachine } from './createMachine'
import { logger } from '@shared/logger'
import type { GuideKey, GuideWaitFor } from '@core/guide/guide'
import { advance, advanceOnTimeout } from '@core/guide/guide'
import type { ZoneId } from '@core/room/roomZone'
import type { FocusId, HexagramRef, MoodTone } from '@core/reading'
import type { MemoryKind } from '@core/memory/memoryAnchor'
import type { Pt } from '@core/ritual/flight'

// ───────────────────────────────────────────────────────────────────────────
// 状态与事件
// ───────────────────────────────────────────────────────────────────────────

export type RoomState =
  | 'BOOT'
  | 'GUIDE'
  | 'ROOM'
  // 塔罗支线
  | 'SPREAD_PICK'
  | 'SPREAD_DRAW'
  // 六爻支线
  | 'MOOD_PICK'
  | 'FOCUS_PICK'
  | 'PLACE_ITEM'
  | 'RITUAL'
  // 汇合
  | 'READING'
  | 'MEMORY_OFFER'
  | 'MEMORY_PLACE'
  | 'MEMORY_RECALL'
  | 'COUNTDOWN_SET'
  | 'COUNTDOWN_DUE'

/** 支线里的"随时能走"出口 —— 这四个状态都声明 LEAVE_ZONE → ROOM */
export const INTERRUPTIBLE: readonly RoomState[] = [
  'SPREAD_PICK',
  'SPREAD_DRAW',
  'MOOD_PICK',
  'FOCUS_PICK',
  'PLACE_ITEM',
  'RITUAL',
  'READING',
  'MEMORY_OFFER',
  'MEMORY_PLACE',
  'MEMORY_RECALL',
  'COUNTDOWN_SET',
]

export type RoomEvent =
  | { type: 'BOOT_READY' }
  | { type: 'GUIDE_STEP_TIMEOUT' }
  | { type: 'GUIDE_ACTION'; did: GuideWaitFor }
  | { type: 'GUIDE_DONE' }
  | { type: 'ENTER_ZONE'; zone: ZoneId }
  | { type: 'LEAVE_ZONE' }
  | { type: 'BACK_TO_ROOM' }
  // 塔罗
  | { type: 'PICK_SPREAD'; spreadId: string }
  | { type: 'DRAW_CARD' }
  | { type: 'READ_DONE' }
  // 六爻
  | { type: 'PICK_MOOD'; tone: MoodTone }
  | { type: 'PICK_FOCUS'; focus: FocusId }
  | { type: 'PLACE_ITEM'; anchorId: string | null; at: Pt }
  | { type: 'RITUAL_CAST_DONE'; hexagram: HexagramRef }
  // 记忆锚点
  | { type: 'OFFER_MEMORY'; kind: MemoryKind }
  | { type: 'SKIP_MEMORY' }
  | { type: 'PLACE_MEMORY'; anchorId: string | null; at: Pt }
  | { type: 'RECALL_MEMORY'; id: string }
  | { type: 'CLOSE_RECALL' }
  // 倒计时
  | { type: 'OPEN_COUNTDOWN' }
  | { type: 'SET_COUNTDOWN'; id: string }
  | { type: 'CANCEL_COUNTDOWN' }
  | { type: 'COUNTDOWN_FIRED'; id: string }
  | { type: 'ACK_DUE' }
  | { type: 'TICK'; now: number }

// ───────────────────────────────────────────────────────────────────────────
// 上下文
// ───────────────────────────────────────────────────────────────────────────

export interface GuideCursor {
  key: GuideKey | null
  /** 当前第几句（0 起）；null 表示整段已结束 */
  step: number | null
  shownAt: number
}

export interface SpreadProgress {
  id: string | null
  /** 已翻开几张 */
  drawn: number
  /** 翻出来的牌（牌库下标） */
  deck: number[]
}

export interface LiuyaoProgress {
  tone: MoodTone | null
  focus: FocusId | null
  /** 道具被放到了哪个锚点；null = 用户放在了空地上（正常） */
  anchorId: string | null
  at: Pt | null
}

export interface RoomCtx {
  now: number
  zone: ZoneId | null
  /** 当前气泡引导的游标 */
  guide: GuideCursor
  /** 已经看过的引导（"首次"只出现一次的依据） */
  seenGuides: GuideKey[]
  spread: SpreadProgress
  liuyao: LiuyaoProgress
  hexagram: HexagramRef | null
  /** 用户点名要带走的那件摆件 */
  pendingKind: MemoryKind | null
  /** 正在回看的那条记忆 */
  recalledId: string | null
  /** ★ 已归零、但还没展示的倒计时（不打断原则的落点） */
  dueQueue: string[]
}

/** 场景/UI 指令出口 —— 与 ritualMachine 同款，只发指令，不碰 DOM */
export type RoomCommand =
  | { type: 'guide:show'; key: GuideKey; step: number; text: string; at: Pt; autoHideMs: number }
  | { type: 'guide:hide' }
  | { type: 'zone:focus'; zone: ZoneId }
  | { type: 'panel:open'; panel: RoomState }
  | { type: 'panel:close'; panel: RoomState }
  | { type: 'spread:dealt'; spreadId: string; count: number }
  | { type: 'card:reveal'; index: number; order: number }
  | { type: 'reading:open'; kind: 'tarot' | 'liuyao' }
  | { type: 'memory:offer'; kinds: readonly MemoryKind[] }
  | { type: 'memory:placed'; kind: MemoryKind; anchorId: string | null }
  | { type: 'memory:recall'; id: string }
  | { type: 'memory:close' }
  | { type: 'countdown:open' }
  | { type: 'countdown:set'; id: string }
  | { type: 'countdown:due'; id: string }
  | { type: 'countdown:closed' }

export type CommandSink = (cmd: RoomCommand) => void

let emit: CommandSink = () => {}

export function setRoomCommandSink(fn: CommandSink): void {
  emit = fn
}

// ───────────────────────────────────────────────────────────────────────────
// 引导游标的小工具（纯函数，可单测）
// ───────────────────────────────────────────────────────────────────────────

/** 把引导游标推进到下一句；整段结束时把 step 置 null 并记入 seenGuides */
function cursorDone(ctx: RoomCtx): void {
  const key = ctx.guide.key
  if (key && !ctx.seenGuides.includes(key)) ctx.seenGuides.push(key)
  ctx.guide = { key: null, step: null, shownAt: 0 }
  emit({ type: 'guide:hide' })
}

function cursorShow(ctx: RoomCtx, key: GuideKey, step: number, now: number): void {
  ctx.guide = { key, step, shownAt: now }
}

// ───────────────────────────────────────────────────────────────────────────
// 状态机本体
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 初始上下文工厂。
 *   必须由它产出、而不是写一个对象字面量给 `ctx` ——
 *   否则 `seenGuides` / `dueQueue` / `deck` 这几个数组会变成**模块级单例**，
 *   上一个引擎实例攒下的引导记录会留给下一个（单测里表现为"单跑绿、连跑红"）。
 *   配合 `createMachine` 的 `initialCtx`，`roomMachine.reset()` 就能真正回到干净态。
 */
export function initialRoomCtx(): RoomCtx {
  return {
    now: 0,
    zone: null,
    guide: { key: null, step: null, shownAt: 0 },
    seenGuides: [],
    spread: { id: null, drawn: 0, deck: [] },
    liuyao: { tone: null, focus: null, anchorId: null, at: null },
    hexagram: null,
    pendingKind: null,
    recalledId: null,
    dueQueue: [],
  }
}

export const roomMachine = createMachine<RoomState, RoomCtx, RoomEvent>({
  initial: 'BOOT',

  ctx: initialRoomCtx(),
  initialCtx: initialRoomCtx,

  onWarn: (msg, detail) => {
    // ★ 门禁 ⑨：非法转移只记一条 warn。不弹窗、不震动、不改变画面。
    logger.warn('[room]', msg, detail)
  },

  states: {
    /**
     * BOOT —— 起帧
     * 画面：房间直接可见（不等网络、不等配置）。首帧就能看见小屋，这是"不白屏"的落点。
     */
    BOOT: {
      on: {
        // 首次启动（没见过 FIRST_LAUNCH）→ 先让小卜说两句；否则直接进房间
        BOOT_READY: (ctx) => (ctx.seenGuides.includes('FIRST_LAUNCH') ? 'ROOM' : 'GUIDE'),
      },
    },

    /**
     * GUIDE —— 首次私语（只出现一次）
     * 画面：小卜站在桌缘，气泡里逐句念。**没有任何"跳过/下一步/我知道了"按钮** ——
     *      它自己会淡出，用户也可以直接去操作。
     */
    GUIDE: {
      entry: (ctx) => {
        cursorShow(ctx, 'FIRST_LAUNCH', 0, ctx.now)
      },
      on: {
        GUIDE_STEP_TIMEOUT: (ctx) => {
          const key = ctx.guide.key
          const step = ctx.guide.step
          if (!key || step === null) return 'ROOM'
          const next = advanceOnTimeout(key, step)
          if (next === null) {
            cursorDone(ctx)
            return 'ROOM'
          }
          cursorShow(ctx, key, next, ctx.now)
          return 'GUIDE'
        },
        GUIDE_ACTION: (ctx, e) => {
          const key = ctx.guide.key
          const step = ctx.guide.step
          // ★ 用户在引导期间做的任何一个真实操作，都直接结束引导 —— 上手即淡出
          if (!key || step === null) return 'ROOM'
          const next = advance(key, step, e.did)
          if (next === null) {
            cursorDone(ctx)
            return 'ROOM'
          }
          cursorShow(ctx, key, next, ctx.now)
          return 'GUIDE'
        },
        GUIDE_DONE: (ctx) => {
          cursorDone(ctx)
          return 'ROOM'
        },
      },
      exit: (ctx) => {
        if (ctx.guide.key === 'FIRST_LAUNCH') cursorDone(ctx)
      },
    },

    /**
     * ROOM —— 房间待机
     * 画面：小屋完整可见，小卜在呼吸，桌上的东西都在原处。
     *      这是绝大多数时间的状态，也是"零门槛"落点：**进来就有地方可看**。
     */
    ROOM: {
      entry: (ctx) => {
        ctx.zone = null
        ctx.guide = { key: null, step: null, shownAt: 0 }
        emit({ type: 'guide:hide' })
      },
      on: {
        ENTER_ZONE: (ctx, e) => {
          ctx.zone = e.zone
          emit({ type: 'zone:focus', zone: e.zone })
          // 塔罗从"翻开手账"进，六爻从"先说说今天"进 —— 两边第一步不同
          return e.zone === 'TAROT' ? 'SPREAD_PICK' : 'MOOD_PICK'
        },
        OPEN_COUNTDOWN: () => 'COUNTDOWN_SET',
        RECALL_MEMORY: (ctx, e) => {
          ctx.recalledId = e.id
          emit({ type: 'memory:recall', id: e.id })
          return 'MEMORY_RECALL'
        },
        // ★ 只有 ROOM 声明了它 —— 于是"不打断"是由状态机保证的，不是靠调用方自觉
        COUNTDOWN_FIRED: (ctx, e) => {
          if (!ctx.dueQueue.includes(e.id)) ctx.dueQueue.push(e.id)
          return 'COUNTDOWN_DUE'
        },
        TICK: (ctx, e) => {
          ctx.now = e.now
          return 'ROOM'
        },
      },
    },

    /**
     * SPREAD_PICK —— 翻开手账选牌阵
     * 画面：手账在毯子上摊开，每一页是一个牌阵；不是系统列表。
     *      第一行真名（大字、深色），第二行温柔的解释（小字、浅色）。
     */
    SPREAD_PICK: {
      entry: () => emit({ type: 'panel:open', panel: 'SPREAD_PICK' }),
      on: {
        PICK_SPREAD: (ctx, e) => {
          ctx.spread = { id: e.spreadId, drawn: 0, deck: [] }
          return 'SPREAD_DRAW'
        },
        LEAVE_ZONE: () => 'ROOM',
      },
      exit: () => emit({ type: 'panel:close', panel: 'SPREAD_PICK' }),
    },

    /**
     * SPREAD_DRAW —— 一张一张翻
     * 画面：牌背整齐，翻开的牌按 spreads.json 的 order 落到各自牌位。
     *      ★ 翻几张就看几张：不"必须翻满"，翻不动了直接去解读。
     */
    SPREAD_DRAW: {
      entry: (ctx) => {
        if (ctx.spread.id) emit({ type: 'spread:dealt', spreadId: ctx.spread.id, count: 0 })
      },
      on: {
        DRAW_CARD: (ctx) => {
          const order = ctx.spread.drawn
          ctx.spread.deck.push(order)
          ctx.spread.drawn += 1
          emit({ type: 'card:reveal', index: order, order: order + 1 })
          return 'SPREAD_DRAW'
        },
        READ_DONE: () => 'READING',
        LEAVE_ZONE: () => 'ROOM',
      },
    },

    /**
     * MOOD_PICK —— 今天心里是什么感觉
     * 画面：六个词，没有进度、没有分数、没有"请选择"的冷灰占位。
     *      这是六爻的第一维，也是**记忆锚点要用的那一维**。
     */
    MOOD_PICK: {
      entry: () => emit({ type: 'panel:open', panel: 'MOOD_PICK' }),
      on: {
        PICK_MOOD: (ctx, e) => {
          ctx.liuyao.tone = e.tone
          return 'FOCUS_PICK'
        },
        LEAVE_ZONE: () => 'ROOM',
      },
      exit: () => emit({ type: 'panel:close', panel: 'MOOD_PICK' }),
    },

    /**
     * FOCUS_PICK —— 想聊的是哪一类事
     * 画面：七个选项，最后一个是「说不上来」。★ 它和别的选项一样大、一样亮。
     */
    FOCUS_PICK: {
      entry: () => emit({ type: 'panel:open', panel: 'FOCUS_PICK' }),
      on: {
        PICK_FOCUS: (ctx, e) => {
          ctx.liuyao.focus = e.focus
          return 'PLACE_ITEM'
        },
        LEAVE_ZONE: () => 'ROOM',
      },
      exit: () => emit({ type: 'panel:close', panel: 'FOCUS_PICK' }),
    },

    /**
     * PLACE_ITEM —— 把竹筒搁到顺手的地方
     * 画面：三个锚点各自有一点极淡的光；拖过去轻轻吸住。
     *      ★ 放到空地上也完全可以，那就落在空地上，没有任何提示。
     */
    PLACE_ITEM: {
      on: {
        PLACE_ITEM: (ctx, e) => {
          ctx.liuyao.anchorId = e.anchorId
          ctx.liuyao.at = e.at
          return 'RITUAL'
        },
        LEAVE_ZONE: () => 'ROOM',
      },
    },

    /**
     * RITUAL —— 掷币（四态子机）
     * 画面：完全交给 ritualMachine。本机在这里**不做任何决定**。
     */
    RITUAL: {
      on: {
        RITUAL_CAST_DONE: (ctx, e) => {
          ctx.hexagram = e.hexagram
          return 'READING'
        },
        LEAVE_ZONE: () => 'ROOM',
      },
      exit: () => {
        // ★ 提前离开（比如中途退出）不判失败，也不留半截卦象
        emit({ type: 'panel:close', panel: 'RITUAL' })
      },
    },

    /**
     * READING —— 解读
     * 画面：解读层从下方轻轻上浮，六爻是"一段话"，塔罗是按牌阵结构分段。
     *      ★ 断网时这里是本地模板文案，视觉与文案长度都保持同构 —— 用户看不出降级。
     */
    READING: {
      entry: (ctx) => {
        emit({ type: 'reading:open', kind: ctx.hexagram ? 'liuyao' : 'tarot' })
      },
      on: {
        READ_DONE: () => 'MEMORY_OFFER',
        LEAVE_ZONE: () => 'ROOM',
        TICK: (ctx, e) => {
          ctx.now = e.now
          return 'READING'
        },
      },
    },

    /**
     * MEMORY_OFFER —— 想带走哪一件
     * 画面：2–3 件轻量摆件浮在小卜手边；**必须有"不带走"这个出口**，
     *      而且它和其余选项一样显眼 —— 不给出口的邀请是要求。
     */
    MEMORY_OFFER: {
      on: {
        OFFER_MEMORY: (ctx, e) => {
          ctx.pendingKind = e.kind
          return 'MEMORY_PLACE'
        },
        SKIP_MEMORY: (ctx) => {
          ctx.pendingKind = null
          return 'ROOM'
        },
      },
    },

    /**
     * MEMORY_PLACE —— 亲手放
     * 画面：物件跟着手指，落在哪就是哪。★「亲手」是这段的全部意义，
     *      所以这里**没有"自动摆放"这个分支**，也没有"位置不对"这种判定。
     */
    MEMORY_PLACE: {
      on: {
        PLACE_MEMORY: (ctx, e) => {
          // ★ 这里只报"放好了 + 放在哪"。id 由 engine 生成（它才知道 store 与 draft）——
          //   状态机不该假装知道自己没造过的东西。
          if (ctx.pendingKind) {
            emit({ type: 'memory:placed', kind: ctx.pendingKind, anchorId: e.anchorId })
          }
          ctx.pendingKind = null
          return 'ROOM'
        },
        SKIP_MEMORY: (ctx) => {
          ctx.pendingKind = null
          return 'ROOM'
        },
      },
    },

    /**
     * MEMORY_RECALL —— 点一下它，它说话
     * 画面：日期 + 当时那句话，低语卡浮在小卜旁边；点别处就收起来。
     *      ★ 不是弹窗：不遮住小屋、不需要点"确定"。
     */
    MEMORY_RECALL: {
      on: {
        RECALL_MEMORY: (ctx, e) => {
          ctx.recalledId = e.id
          emit({ type: 'memory:recall', id: e.id })
          return 'MEMORY_RECALL'
        },
        CLOSE_RECALL: (ctx) => {
          ctx.recalledId = null
          emit({ type: 'memory:close' })
          return 'ROOM'
        },
      },
      exit: () => emit({ type: 'memory:close' }),
    },

    /**
     * COUNTDOWN_SET —— 给一件事定个日子
     * 画面：沙漏/日历摆件被拿在手里，拨到一个日子。没有计时器、没有"还剩"。
     */
    COUNTDOWN_SET: {
      entry: () => emit({ type: 'countdown:open' }),
      on: {
        SET_COUNTDOWN: (_ctx, e) => {
          emit({ type: 'countdown:set', id: e.id })
          return 'ROOM'
        },
        CANCEL_COUNTDOWN: () => 'ROOM',
      },
      exit: () => emit({ type: 'countdown:closed' }),
    },

    /**
     * COUNTDOWN_DUE —— 那一天到了
     * 画面：沙漏静静落完，一件专属纪念品出现在它旁边（如褪色的船票）。
     *      ★ 这是**馈赠**不是**通知**：没有"提醒"两个字，没有"已逾期"。
     *      ★ 从 dueQueue 里出一件；队列里还有别的，就继续留在这个态。
     */
    COUNTDOWN_DUE: {
      entry: (ctx) => {
        const id = ctx.dueQueue[0]
        if (id) emit({ type: 'countdown:due', id })
      },
      on: {
        ACK_DUE: (ctx) => {
          ctx.dueQueue.shift()
          return ctx.dueQueue.length > 0 ? 'COUNTDOWN_DUE' : 'ROOM'
        },
      },
    },
  },
})

// ───────────────────────────────────────────────────────────────────────────
// 给 engine 用的判定
// ───────────────────────────────────────────────────────────────────────────

/** 手指事件该不该转给仪式机 —— ★ 只有 RITUAL 段才转 */
export function acceptsPointer(state: RoomState): boolean {
  return state === 'RITUAL'
}

/** 倒计时归零现在能不能展示 —— ★ 只有 ROOM 能，其余状态排队 */
export function canShowCountdown(state: RoomState): boolean {
  return state === 'ROOM'
}

/** 这是不是一条"随时能走"的支线 */
export function isInterruptible(state: RoomState): boolean {
  return INTERRUPTIBLE.includes(state)
}
