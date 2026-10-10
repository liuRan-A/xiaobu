/**
 * 小卜 · 应用引擎   src/core/engine.ts
 * ===========================================================================
 * 顶层编排：把**空间分区**、**牌阵引擎**、**记忆锚点**、**倒计时**、
 * **手势识别**和**两台状态机**缝成一件能跑的东西。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  一、它拥有什么（"唯一真相"清单）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · `roomMachine`   —— 流程（ROOM / 翻开手账 / 掷币 / 解读 / 放东西 / 等日子）
 *   · `ritualMachine` —— 仪式四态（只在流程的 RITUAL 段工作）
 *   · `GestureRecognizer` —— 原始采样 → 语义手势
 *   · 已放置的记忆锚点、已设定的倒计时、已看过的引导 —— 都经 `PersistedStore`
 *   · 当前那一段气泡引导的游标
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  二、两条边界（这两条决定了这个文件为什么长这样）
 * ═══════════════════════════════════════════════════════════════════════════
 *  ① **手指落在画布上 → 走 engine；手指落在面板上 → UI 直接调方法。**
 *     掷币、拖摆件这类"在等距场景里拖东西"的交互，需要屏幕坐标 → 世界语义的换算，
 *     必须由 engine 统一路由（否则每个组件都要认识两台状态机）。
 *     而"翻开手账里点了第 3 页""心情选了'有点累'"这类**离散选择**，
 *     UI 直接调 `pickSpread('crossroads-two')` 就行 —— 没必要伪造一个 TAP 事件
 *     再让 engine 反推它点的是哪一页。少一层猜测，就少一类 bug。
 *
 *  ② **core 不认识像素。** 引擎要知道"这个点戳到了哪枚铜钱"，
 *     但它不许 import scene（ESLint 禁令 1）。所以几何判定由外部注入：
 *     `hitTest: (p) => EngineHit`。scene 层实现它，engine 只消费语义结果。
 *     好处是这台引擎在 node 里可以用一个假的 hitTest 完整跑通全流程 ——
 *     单测因此能覆盖"拖到香炉旁再松手"这种交互，而不需要真机。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  三、防崩三件事（与全局底线一致）
 * ═══════════════════════════════════════════════════════════════════════════
 *   · 任何一步抛异常都**不冒泡**：catch 里只 logger.warn，然后退回安全分支
 *   · 任何一步都不弹 UI：没有 alert / Toast / 红色提示（门禁 ⑨）
 *   · 落盘永远低频：`store.set()` 只标脏，`flush()` 由这里按预算调（门禁 ⑬）
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { trackFunnel } from '@services/track'
import { createMemoryPort, PersistedStore, PERSIST_KEYS, type LocalPort } from '@core/persist'
import { GestureRecognizer, type GestureEvent, type PointerSample } from '@core/gesture'
import { roomMachine, canShowCountdown, type RoomEvent, type RoomState } from '@core/machine/roomMachine'
import { ritualMachine, setCastCollector, type RitualState } from '@core/machine/ritualMachine'
import { buildHexagram } from '@core/liuyao/castLine'
import { TH } from '@core/ritual/thresholds'
import type { Pt } from '@core/ritual/flight'
import { getAnchor, placeAt, zoneAt, type AnchorId, type ZoneId } from '@core/room/roomZone'
import {
  SPREADS,
  buildReadingPlan,
  getSpread,
  spreadsByTier,
  toListItem,
  type ReadingPlan,
  type SpreadConfig,
  type SpreadListItem,
} from '@core/spread'
import {
  MOOD_TONES,
  buildLiuyaoRequest,
  buildTarotRequest,
  type FocusId,
  type HexagramRef,
  type MoodTone,
  type ReadingRequest,
} from '@core/reading'
import {
  MEMORY_OFFER_MAX,
  draftMemory,
  loadMemory,
  placeMemory,
  recallOf,
  roomSummary,
  saveMemory,
  suggestMemoryItems,
  toOffers,
  type MemoryItem,
  type MemoryKind,
  type MemoryOffer,
  type MemorySource,
  type Recall,
} from '@core/memory/memoryAnchor'
import {
  addCountdown,
  loadCountdowns,
  makeKeepsake,
  parseLocalDay,
  saveCountdowns,
  tickCountdowns,
  toView,
  type Countdown,
  type CountdownView,
  type LocalDay,
} from '@core/countdown/countdown'
import {
  advance,
  advanceOnTimeout,
  guideStepAt,
  loadSeen,
  markSeen,
  saveSeen,
  shouldShow,
  zoneGuideFor,
  type GuideKey,
  type GuideWaitFor,
} from '@core/guide/guide'
import { loadConsent, saveConsent, type CloudConsent } from '@core/empathy/consent'
import { loadVoiceConsent, saveVoiceConsent, type VoiceConsent } from '@core/voice/consent'
import { loadAudioMuted, saveAudioMuted } from '@core/audio/prefs'

// ───────────────────────────────────────────────────────────────────────────
// 记忆浮现卡 · 呈现相位与降帧
// ───────────────────────────────────────────────────────────────────────────
//
// ★ 为什么这里要有一套**独立于 roomMachine 的相位**：
//   roomMachine 的 MEMORY_RECALL 管的是「现在在回看哪一条记忆」（流程态）；
//   而卡片的「淡入 / 常驻 / 淡出」是另一件事（呈现态）。
//   两者必须分开 —— 否则「淡出还没播完就被强制退回 ROOM」会硬切，
//   而我们要的是「点卡片外 → 优雅淡出 → 再退回待机」。
//
// ★ 相位纯时间驱动，不碰 DOM / 动画 API：
//   推进全在 `tickCard()` 里按 `now - cardPhaseAt` 算，于是同一套逻辑在 node 单测里
//   用注入的 now 就能完整验证，不需要真机、不需要 rAF。

/** 浮现卡淡入时长（ms）—— 与《记忆锚点浮现卡-UI与交互动效规范》同一份，改一处改两处 */
export const MEMORY_CARD_APPEAR_MS = 360
/** 浮现卡淡出时长（ms） */
export const MEMORY_CARD_FADE_MS = 320

/** 浮现卡的呈现相位 */
export type MemoryCardPhase = 'hidden' | 'appearing' | 'shown' | 'fading'

// ───────────────────────────────────────────────────────────────────────────
// 命中判定的语义结果（由 scene 层实现）
// ───────────────────────────────────────────────────────────────────────────

export type EngineHit =
  /** 戳到了第 coinId 枚铜钱 */
  | { kind: 'coin'; coinId: number }
  /** 戳到了竹筒 */
  | { kind: 'tube' }
  /** 戳到了牌堆（塔罗区） */
  | { kind: 'deck' }
  /** 戳到了某个放置锚点（含它附近） */
  | { kind: 'anchor'; id: AnchorId }
  /** 戳到了某件已放好的记忆锚点 */
  | { kind: 'memory'; id: string }
  /** 戳到了倒计时摆件（沙漏 / 日历） */
  | { kind: 'timepiece'; id: string }
  /** 什么都没戳到 */
  | { kind: 'none' }

export interface EngineOptions {
  /** 存储端口。缺省用内存端口 —— 引擎因此**永不因存储失败而不可用** */
  port?: LocalPort
  /** 屏幕点 → 语义命中。缺省恒返回 none（node 里跑流程用） */
  hitTest?: (p: Pt) => EngineHit
  /** 当前时刻（ms）。注入是为了单测确定性 */
  now?: () => number
  /** 抽第 index 张牌时翻出的牌（牌库下标）。缺省按序 0,1,2… */
  drawCard?: (spread: SpreadConfig, index: number) => number
  /** 掷出时通知画面起飞（Scene 接它做动画）。缺省空实现 */
  onToss?: (ev: GestureEvent) => void
  /**
   * 选位段（PLACE）松手时把落点交出去。
   *
   * ★ 为什么这件事不能由 engine 自己判：判"吸附 / 反悔 / 留在原处"需要**竹筒在
   *   屏幕上的位置**（反悔半径 40pt 是绕筒口算的），而 core 不认识美术像素。
   *   爻位槽的中心 engine 是有的（`SLOT_CENTERS`），卦盘与竹筒没有。
   *   所以这里只交出坐标，判定与结局由场景侧的 `RitualEngine.drop()` 做。
   *
   * ★ 缺省空实现 = 不判吸附。那样松手之后币就留在原地，仪式**仍然可玩**
   *   （用户可以把每一枚都放在盘面上），只是不会自动归位到槽里。
   *
   * ★ 这里交出的是**指针**位置，而 `RitualEngine.drop()` 优先按"币画在哪"判
   *   （币在指针上方 22pt，两者差得比槽间距还大）。交出指针仍然必要：
   *   掷出之后没拖就直接松手时，币还没有跟手位置，只能拿它兜底。
   */
  onRitualRelease?: (at: Pt) => void
}

// ───────────────────────────────────────────────────────────────────────────
// 快照（给 Vue 消费；引擎内部状态一律不直接暴露）
// ───────────────────────────────────────────────────────────────────────────

export interface GuideView {
  key: GuideKey
  step: number
  text: string
  at: Pt
  autoHideMs: number
}

export interface EngineSnapshot {
  room: RoomState
  ritual: RitualState
  zone: ZoneId | null
  guide: GuideView | null
  spreads: {
    hot: SpreadListItem[]
    advanced: SpreadListItem[]
    pickedId: string | null
    drawn: number
    count: number
    /** 已翻开的牌（牌库下标，按翻开顺序） */
    deck: number[]
  }
  liuyao: {
    tone: MoodTone | null
    focus: FocusId | null
    anchorId: string | null
    placed: boolean
  }
  reading: {
    plan: ReadingPlan | null
    request: ReadingRequest | null
  }
  memory: {
    items: MemoryItem[]
    offers: MemoryOffer[]
    recall: Recall | null
    summary: string
  }
  countdown: {
    items: CountdownView[]
    /** 已经到过日子的个数（不是"逾期"） */
    arrivedCount: number
  }
  /** 浮现卡的呈现态 —— 独立暴露给 Scene 做淡入/淡出与降帧 */
  memoryCard: {
    /** hidden / appearing / shown / fading */
    phase: MemoryCardPhase
    /** 卡片开启时为 true —— Scene 据此降低渲染帧率（省电防卡顿） */
    reducedMotion: boolean
  }
  hexagram: HexagramRef | null
}

// ───────────────────────────────────────────────────────────────────────────
// 引擎
// ───────────────────────────────────────────────────────────────────────────

export class Engine {
  private readonly store: PersistedStore
  private readonly hitTest: (p: Pt) => EngineHit
  private readonly nowFn: () => number
  private readonly drawCardFn: (spread: SpreadConfig, index: number) => number
  private readonly onToss: (ev: GestureEvent) => void
  private readonly onRitualRelease: (at: Pt) => void
  private readonly rec = new GestureRecognizer()

  /** 已放置的记忆锚点 */
  private memory: MemoryItem[] = []
  /** 已设定的倒计时 */
  private countdowns: Countdown[] = []
  /** 正在回看的那条记忆 */
  private recalled: MemoryItem | null = null
  /** 解读层用的载荷 */
  private reading: { plan: ReadingPlan | null; request: ReadingRequest | null } = { plan: null, request: null }
  /** 这一次解读结束的时刻（记忆锚点记的是"那次占卜发生在哪一天"） */
  private readAt = 0
  /** 最近一次交互时刻，用于仪式机的温柔引导 */
  private lastAct = 0
  /** 手指按下时命中的东西 —— 抬手时判 TAP 要用 */
  private pressHit: EngineHit = { kind: 'none' }
  /** 正在等待放置的摆件 */
  private pendingDraft: MemoryItem | null = null
  /** 浮现卡的呈现相位（独立于 roomMachine 的流程态，专管淡入/淡出） */
  private cardPhase: MemoryCardPhase = 'hidden'
  /** 进入当前相位的时刻（ms），用于淡入/淡出计时 */
  private cardPhaseAt = 0

  // 非阻塞气泡引导（不改变流程状态，故不放进 roomMachine）
  private guide: GuideView | null = null
  private guideShownAt: number | null = null
  /** 首启引导（由 roomMachine 的 GUIDE 态驱动）的计时：步签名 + 起算时刻 */
  private firstGuideSig = ''
  private firstGuideShownAt: number | null = null
  /** 上一次房间状态，用来检测"刚进入某态" */
  private prevRoom: RoomState = 'BOOT'
  /** 上一次已落盘的"看过哪些引导"数量 —— 只在变化时写，避免每帧标脏 */
  private lastSeenLen = -1

  constructor(opts: EngineOptions = {}) {
    this.store = new PersistedStore(opts.port ?? createMemoryPort())
    this.hitTest = opts.hitTest ?? (() => ({ kind: 'none' }))
    this.nowFn = opts.now ?? (() => Date.now())
    this.drawCardFn = opts.drawCard ?? ((_s, i) => i)
    this.onToss = opts.onToss ?? (() => {})
    this.onRitualRelease = opts.onRitualRelease ?? (() => {})
    // ★ 两台机器都是模块级单例，ctx 里的数组会跨实例串味 ——
    //   建引擎时先 reset 一次，回到干净态（理由见 createMachine.initialCtx）
    roomMachine.reset()
    ritualMachine.reset()
    // ★ 三枚一掷的收口：仪式机进 CAST 时把六爻交到这里 → 本地建卦
    //   （buildHexagram，纯由爻值算出）→ castDone 送房间机进解读。
    //   这是 ritualMachine CAST 段 TODO(D7) 在引擎侧的落点：卦象只由本地爻值决定，
    //   天气、开发模式、网络状态都不得参与（与 ritualMachine 头部约束同一条）。
    setCastCollector((lines) => {
      if (lines.length < 6) return // 不可达：CAST 只在第六爻落定后进入；防御而已
      this.castDone(buildHexagram(lines))
    })
  }

  // ── 生命周期 ──

  /** 启动。★ 内部不 await 网络、不等配置；存储读不到就是全新用户 */
  async boot(): Promise<void> {
    try {
      await this.store.load()
      this.memory = loadMemory(this.store)
      this.countdowns = loadCountdowns(this.store)
      roomMachine.ctx.seenGuides = loadSeen(this.store)
    } catch (e) {
      // ★ 门禁 ⑨：catch 内不许出 UI。读不到就按全新用户跑，房间照样能进。
      logger.warn('[engine] 启动读取失败，按全新用户处理', e)
    }
    roomMachine.ctx.now = this.nowFn()
    roomMachine.send({ type: 'BOOT_READY' })
    this.syncDerived()
  }

  get roomState(): RoomState {
    return roomMachine.state
  }

  get ritualState(): RitualState {
    return ritualMachine.state
  }

  // ── 手指输入（画布上） ──

  pointerDown(s: PointerSample): void {
    this.lastAct = s.t
    this.pressHit = this.safeHit({ x: s.x, y: s.y })
    this.dispatch(this.rec.down(s))
  }

  pointerMove(s: PointerSample): void {
    this.lastAct = s.t
    this.dispatch(this.rec.move(s))
  }

  pointerUp(s: PointerSample): void {
    this.lastAct = s.t
    this.dispatch(this.rec.up(s))
  }

  pointerCancel(t: number): void {
    this.dispatch(this.rec.cancel(t))
  }

  /** 加速度（单位 g）。★ 摇晃只在仪式段有意义，其它状态直接忽略 */
  motion(g: number, t: number): void {
    this.dispatch(this.rec.motion(g, t))
  }

  // ── 心跳 ──

  /**
   * 每帧一次。
   * ★ 顺序有意如此：先处理手势（用户的意图优先），再处理时间带来的事
   *   （倒计时归零、引导超时、落盘）。反过来会让"用户正在拖东西"和
   *   "倒计时跳出来"在同一帧里抢焦点，而那一刻用户的手是放在屏幕上的。
   */
  tick(now = this.nowFn()): void {
    roomMachine.ctx.now = now

    // ① 长按到点的回应（按住不动也要有反馈）
    this.dispatch(this.rec.tick(now))

    // ② 倒计时（纯本地日历日运算）
    this.tickCountdowns(now)

    // ②b 之前被占卜/解读打断、排着队的归零事件，回到 ROOM 时补上
    this.drainDueQueue()

    // ③ 仪式机的温柔引导
    if (roomMachine.state === 'RITUAL') {
      ritualMachine.send({ type: 'TICK', idleMs: Math.max(0, now - this.lastAct) })
    } else {
      roomMachine.send({ type: 'TICK', now })
    }

    // ④ 首启引导的超时（这一段由 roomMachine 驱动，所以超时要翻译成它的事件）
    this.tickFirstGuide(now)

    // ⑤ 气泡引导的超时
    this.tickGuide(now)

    // ⑤b 浮现卡相位推进（淡入 → 常驻 → 淡出退场）。先于 syncDerived，
    //    这样同一帧里淡出结束就能把 roomState 一起退回 ROOM。
    this.tickCard(now)

    // ⑥ 低频落盘（受写预算约束，超预算自动顺延到下一次）
    void this.store.flush(now)

    this.syncDerived()
  }

  /** 切后台 / 退出前调一次 —— 忽略合并窗口，尽量把脏数据落下去 */
  async flush(): Promise<void> {
    await this.store.flush(this.nowFn(), true)
  }

  // ── 面板上的离散选择（UI 直接调，不伪造 TAP） ──

  enterZone(zone: ZoneId): void {
    this.endFirstGuide()
    // ★ 流失埋点：进入六爻 / 塔罗流程的起点
    if (zone === 'LIUYAO') trackFunnel('LIUYAO_ENTER')
    else if (zone === 'TAROT') trackFunnel('TAROT_ENTER')
    this.whisper(zoneGuideFor(zone, roomMachine.ctx.seenGuides))
    this.send({ type: 'ENTER_ZONE', zone })
  }

  leaveZone(): void {
    this.send({ type: 'LEAVE_ZONE' })
  }

  pickSpread(id: string): void {
    if (!getSpread(id)) return
    this.noteAction('pick-spread')
    trackFunnel('TAROT_PICK')
    this.send({ type: 'PICK_SPREAD', spreadId: id })
    this.whisper('TAROT_DRAW')
  }

  drawCard(): void {
    this.noteAction('draw-card')
    trackFunnel('TAROT_DRAW')
    this.send({ type: 'DRAW_CARD' })
  }

  readDone(): void {
    this.readAt = this.nowFn()
    this.send({ type: 'READ_DONE' })
  }

  pickMood(tone: MoodTone): void {
    if (!MOOD_TONES.includes(tone)) return
    this.noteAction('pick-mood')
    trackFunnel('LIUYAO_MOOD')
    this.send({ type: 'PICK_MOOD', tone })
    this.whisper('LIUYAO_FOCUS')
    void this.rememberAffinity({ tone })
  }

  /** 把道具放到锚点上（六爻流程的 PLACE_ITEM 步）。★ 放不放得中都成功 */
  placeItem(anchorId: AnchorId | null, at: Pt): void {
    this.noteAction('place-item')
    trackFunnel('LIUYAO_PLACE')
    this.send({ type: 'PLACE_ITEM', anchorId, at })
  }

  pickFocus(focus: FocusId): void {
    this.noteAction('pick-focus')
    trackFunnel('LIUYAO_FOCUS')
    this.send({ type: 'PICK_FOCUS', focus })
    this.whisper('LIUYAO_PLACE')
  }

  /** 仪式结束（由 RITUAL 段的路由调用，也可被 UI 在降级路径上直接调） */
  castDone(hexagram: HexagramRef): void {
    trackFunnel('LIUYAO_CAST')
    this.send({ type: 'RITUAL_CAST_DONE', hexagram })
  }

  offerMemory(kind: MemoryKind): void {
    this.noteAction('pick-memory')
    this.pendingDraft = this.buildDraft(kind)
    this.send({ type: 'OFFER_MEMORY', kind })
    this.whisper('MEMORY_PLACE')
  }

  skipMemory(): void {
    this.pendingDraft = null
    this.send({ type: 'SKIP_MEMORY' })
  }

  /** 在小屋的某处放下手里的摆件。★ 放到空地上也成功，没有失败分支 */
  placeMemoryAt(p: Pt): void {
    this.noteAction('place-memory')
    const draft = this.pendingDraft

    if (!draft) {
      this.send({ type: 'PLACE_MEMORY', anchorId: null, at: p })
      return
    }

    try {
      // ★ 倒计时摆件也占锚点（它也是放在屋里的东西），所以一起传进去算占用
      const placed = placeMemory(draft, p, { placed: [...this.memory, ...this.countdowns], now: this.nowFn() })
      this.memory = saveMemory(this.store, [...this.memory, placed.item])
      this.send({ type: 'PLACE_MEMORY', anchorId: placed.item.anchorId, at: placed.item.at })
    } catch (e) {
      // ★ 门禁 ⑨：catch 内不许出 UI。放不下就当作没放，流程继续。
      logger.warn('[engine] 摆件放置失败，静默跳过', e)
      this.send({ type: 'PLACE_MEMORY', anchorId: null, at: p })
    }
    this.pendingDraft = null
  }

  recallMemory(id: string): void {
    const item = this.memory.find((m) => m.id === id) ?? null
    this.recalled = item
    if (item) {
      // ★ 进入「浮现」相位：卡片从这一刻开始淡入。相位独立于 MEMORY_RECALL 流程态 ——
      //   流程态管「在回看哪条记忆」，相位管「卡片画到哪一步」。点别的摆件时
      //   RECALL_MEMORY 会再发一次，这里把相位重新置回 appearing 即可重新浮现。
      this.cardPhase = 'appearing'
      this.cardPhaseAt = this.nowFn()
      this.send({ type: 'RECALL_MEMORY', id })
    }
    // ★ 找不到那件摆件：不抛、不弹、不进任何流程态；卡片保持 hidden。
  }

  /**
   * 收起浮现卡。★ 不是瞬间消失：先切到「淡出」相位，由 `tickCard()` 在淡出播完后
   *   才真正把 recalled 清空、向 roomMachine 发 CLOSE_RECALL 退回 ROOM。
   *   这样「点卡片外」得到的是优雅淡出，而不是硬切 —— 与「零门槛、情绪语言」一致。
   */
  closeRecall(): void {
    if (this.cardPhase === 'hidden') return
    this.cardPhase = 'fading'
    this.cardPhaseAt = this.nowFn()
  }

  openCountdown(): void {
    this.endFirstGuide()
    this.send({ type: 'OPEN_COUNTDOWN' })
    this.whisper('COUNTDOWN_SET')
  }

  /** 设定一个倒计时。`target` 传 'YYYY-MM-DD'；格式不对就当没设定（不报错） */
  setCountdown(input: { title: string; target: string; anchorId?: AnchorId | null; at?: Pt }): boolean {
    this.noteAction('set-countdown')
    const target: LocalDay | null = parseLocalDay(input.target)
    if (!target || !input.title.trim()) {
      this.send({ type: 'CANCEL_COUNTDOWN' })
      return false
    }
    const anchorId = input.anchorId ?? 'WINDOW_SILL'
    const at = input.at ?? getAnchor(anchorId)?.at ?? { x: 0, y: 0 }
    const { items, added } = addCountdown(this.countdowns, {
      title: input.title,
      target,
      anchorId,
      at,
      now: this.nowFn(),
    })
    this.countdowns = items
    saveCountdowns(this.store, items)
    if (!added) {
      this.send({ type: 'CANCEL_COUNTDOWN' })
      return false
    }
    this.send({ type: 'SET_COUNTDOWN', id: added.id })
    return true
  }

  cancelCountdown(): void {
    this.send({ type: 'CANCEL_COUNTDOWN' })
  }

  ackDue(): void {
    this.send({ type: 'ACK_DUE' })
  }

  // ── 快照 ──

  snapshot(): EngineSnapshot {
    const ctx = roomMachine.ctx
    const spread = ctx.spread.id ? getSpread(ctx.spread.id) : null
    const tone: MoodTone = ctx.liuyao.tone ?? 'CALM'
    // ★ 候选与"那次占卜是什么"绑定：同一个卦象/同一个翻牌数，推荐同一批摆件。
    //   随机抽奖会让"我抽到的是绿植"变成运气，而这里要的是"被看见"。
    const seed = ctx.hexagram?.primary ?? ctx.spread.drawn
    const offers = toOffers(suggestMemoryItems(tone, seed, MEMORY_OFFER_MAX), tone)

    return {
      room: roomMachine.state,
      ritual: ritualMachine.state,
      zone: ctx.zone,
      guide: this.guideView,
      spreads: {
        hot: spreadsByTier('hot').map((s) => toListItem(s)),
        advanced: spreadsByTier('advanced').map((s) => toListItem(s)),
        pickedId: ctx.spread.id,
        drawn: ctx.spread.drawn,
        count: spread?.count ?? 0,
        deck: [...ctx.spread.deck],
      },
      liuyao: {
        tone: ctx.liuyao.tone,
        focus: ctx.liuyao.focus,
        anchorId: ctx.liuyao.anchorId,
        placed: ctx.liuyao.at !== null,
      },
      reading: { plan: this.reading.plan, request: this.reading.request },
      memory: {
        items: [...this.memory],
        offers,
        recall: this.recalled ? recallOf(this.recalled) : null,
        summary: roomSummary(this.memory),
      },
      countdown: {
        items: this.countdowns.map((c) => toView(c, this.nowFn())),
        arrivedCount: this.countdowns.filter((c) => c.firedAt !== null).length,
      },
      memoryCard: {
        phase: this.cardPhase,
        reducedMotion: this.cardPhase !== 'hidden',
      },
      hexagram: ctx.hexagram,
    }
  }

  /** 引导视图 —— 两条来源（引擎的上下文气泡 / 状态机的首启引导）在这里合一 */
  get guideView(): GuideView | null {
    if (this.guide) return { ...this.guide, at: { ...this.guide.at } }
    const g = roomMachine.ctx.guide
    if (!g.key || g.step === null) return null
    const step = guideStepAt(g.key, g.step)
    if (!step) return null
    return { key: g.key, step: g.step, text: step.text, at: step.at, autoHideMs: step.autoHideMs }
  }

  /** 测试与调试用：内存里现在有多少东西、还有多少待落盘 */
  inspect(): { memory: number; countdown: number; pendingWrites: number } {
    return {
      memory: this.memory.length,
      countdown: this.countdowns.length,
      pendingWrites: this.store.pendingCount,
    }
  }

  /** 测试用：取出当前那件等着被放置的摆件（不放置时 null） */
  get pendingMemory(): MemoryItem | null {
    return this.pendingDraft
  }

  /**
   * 只读视图：屋里已经放好的摆件。
   *
   * ★ 为什么要有它，而不是让场景层去调 `snapshot()`：
   *   命中测试（"这一点戳到了哪盆绿植"）**每次按下**都要问一次，
   *   而 `snapshot()` 会顺手把牌阵清单、候选摆件、解读载荷全算一遍 ——
   *   那是给 Vue 渲染用的完整投影，代价不该压在输入路径上。
   *   这里只交出引擎已经持有的数组（上层自己浅拷贝），零计算。
   */
  get memoryAnchors(): readonly MemoryItem[] {
    return this.memory
  }

  /** 只读视图：屋里已经摆好的倒计时摆件（沙漏 / 日历） */
  get countdownOrnaments(): readonly Countdown[] {
    return this.countdowns
  }

  /**
   * 卡片开启时为 true —— Scene 据此降低渲染帧率（省电防卡顿）。
   *
   * ★ 由 Engine 统一接管「要不要降帧」：浮现卡是小屋里的临时覆盖层，
   *   它出现时底层的呼吸 / 微光等持续动画可以放慢甚至暂停，既省电又不打断回看。
   *   Scene 只需每帧读这一个布尔，不必自己再去判断流程态。
   */
  get renderReduced(): boolean {
    return this.cardPhase !== 'hidden'
  }

  // ── 内部：事件分发 ──

  private dispatch(events: readonly GestureEvent[]): void {
    for (const ev of events) {
      try {
        this.handleGesture(ev)
      } catch (e) {
        // ★ 门禁 ⑨：一个手势处理出错，不能影响这一帧的其它手势，更不能弹 UI
        logger.warn('[engine] 手势处理异常（已忽略）', e)
      }
    }
    this.syncDerived()
  }

  private handleGesture(ev: GestureEvent): void {
    const inRitual = roomMachine.state === 'RITUAL'

    switch (ev.type) {
      case 'LONG_PRESS': {
        if (!inRitual) return
        // ★ 只有戳到铜钱才转给仪式机 —— 否则 coinId = -1 会污染仪式机的上下文
        if (this.pressHit.kind !== 'coin') return
        ritualMachine.send({ type: 'LONG_PRESS', coinId: this.pressHit.coinId, heldMs: ev.heldMs })
        return
      }
      case 'DRAG': {
        if (!inRitual) return
        ritualMachine.send({ type: 'DRAG', point: ev.at })
        return
      }
      case 'RELEASE': {
        // ★ 六爻流程的"把竹筒搁下"也是一次拖拽松手：先判它，再判掷币。
        //   两个状态互斥（PLACE_ITEM 与 RITUAL 不会同时成立），所以顺序不影响正确性，
        //   写在这里只是为了让"松手 = 落下"这条语义在代码里一眼可见。
        if (roomMachine.state === 'PLACE_ITEM') {
          const out = placeAt(ev.at)
          this.placeItem(out.kind === 'anchor' ? out.id : null, out.at)
          return
        }
        if (!inRitual) return
        const before = ritualMachine.state
        ritualMachine.send({ type: 'RELEASE', distancePt: ev.distancePt, dir: ev.dir })

        // ★ 掷出：LIFT → TOSS 的那一次，通知画面起飞
        if (before === 'LIFT' && ritualMachine.state === 'TOSS') {
          this.onToss(ev)
          return
        }

        // ★ 选位段松手：三种结局（吸附 / 反悔 / 留在原处）交给场景侧判 ——
        //   它才知道竹筒在屏幕上哪里。★ 判在 send 之后：PLACE 不声明 RELEASE，
        //   所以状态不变；而若上面那次已经变成了 TOSS，这里就不会误触。
        if (ritualMachine.state === 'PLACE') {
          try {
            this.onRitualRelease(ev.at)
          } catch (e) {
            // ★ 门禁 ⑨：吸附判定出错只是"这一下没吸住"，币留在原地，仪式继续
            logger.warn('[engine] 落位判定异常（已忽略）', e)
          }
        }
        return
      }
      case 'TAP': {
        this.handleTap(ev.at)
        return
      }
      case 'SHAKE': {
        // ★ 摇晃 = 拿起来 + 掷出去。刻意**不新增**仪式事件：
        //   仪式机因此只有三个手指输入（长按 / 拖拽 / 释放），
        //   而"三种掷出手势"在语义上收敛成同一段动画 —— 用户看到的完全一样。
        if (!inRitual) return
        // ★ 只有 IDLE 才允许起一掷。曾经这里无条件调 onToss，于是"在选位段晃一下手机"
        //   会**再起一条轨迹**：画面上同时存在两枚在飞的币，而玩法上什么都没发生
        //   （PLACE 不声明 LONG_PRESS / RELEASE，两个事件都被静默忽略）。
        //   动画比玩法多跑了一次 —— 这类不一致最难查，因为两边单独看都是对的。
        // ★ 用局部变量读一次状态，不用 `ritualMachine.state !== 'IDLE'` 直接挡：
        //   `state` 是属性访问，TS 会在 `if (…) return` 之后把它**收窄成 'IDLE'**，
        //   而收窄不会因为中间调了一次 `send()` 就失效（属性访问的收窄不随函数调用重置）。
        //   于是下面那句 `=== 'TOSS'` 会被判为"两个类型没有交集"而编译不过 ——
        //   它是**假警报**，但假警报多了就会有人去写 `as`，那才是真的危险。
        const st = ritualMachine.state
        if (st !== 'IDLE') return
        ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: TH.LONG_PRESS_MS })
        ritualMachine.send({ type: 'RELEASE', distancePt: TH.SWIPE_MIN_PT, dir: { x: 0, y: -1 } })
        if (ritualMachine.state === 'TOSS') this.onToss(ev)
        return
      }
      case 'PRESS':
      case 'CANCEL':
      default:
        return
    }
  }

  /** 画布上的轻点 —— 只处理"进场景"这一类语义；面板里的点击由 UI 直接调方法 */
  private handleTap(at: Pt): void {
    this.endFirstGuide()
    // ★ 浮现卡开启时，任何轻点都只做一件事：把卡收起（优雅淡出回待机）。
    //   不进分区、不切到别的摆件 —— 卡片外的整片区域就是"关闭"。
    //   这与战略原文「点击卡片外区域，卡片优雅淡出，重新回到待机态」逐字对齐。
    if (roomMachine.state === 'MEMORY_RECALL') {
      this.closeRecall()
      return
    }
    const hit = this.safeHit(at)

    switch (hit.kind) {
      case 'memory':
        this.recallMemory(hit.id)
        return
      case 'timepiece':
        this.openCountdown()
        return
      case 'deck':
        this.enterZone('TAROT')
        return
      case 'tube':
        this.enterZone('LIUYAO')
        return
      case 'anchor': {
        // ★ 必须按**锚点自己的分区**进，不能一律进 LIUYAO。
        //   `TEA_TABLE`（茶几）的 zone 是 TAROT —— 它是塔罗的牌桌。
        //   曾经这里写死成 'LIUYAO'，于是"在茶几上点一下"会被送进六爻流程，
        //   用户看到的是"我在毯子这边点了，结果它让我选心情"。
        //   兜底顺序：锚点声明的分区 → 该点的几何分区 → 木桌。
        const z = getAnchor(hit.id)?.zone ?? zoneAt(at) ?? 'LIUYAO'
        this.enterZone(z)
        return
      }
      case 'coin': {
        // 待机时点铜钱 = 想掷币：先把他领到六爻流程的第一步
        if (roomMachine.state === 'ROOM') this.enterZone('LIUYAO')
        return
      }
      default: {
        // 什么都没戳到 → 按分区判定。★ 这是"随便点一下也有回应"的兜底，
        //   但**不会**因为点在空地上就弹任何提示。
        const z = zoneAt(at)
        if (z) this.enterZone(z)
        return
      }
    }
  }

  // ── 内部：倒计时 ──

  private tickCountdowns(now: number): void {
    const res = tickCountdowns(this.countdowns, now)
    if (res.fired.length === 0) return

    const keepsakeOf = new Map<string, string>()
    for (const c of res.fired) {
      try {
        const anchor = getAnchor(c.anchorId ?? 'WINDOW_SILL')
        const keepsake = makeKeepsake({
          countdown: c,
          now,
          tone: roomMachine.ctx.liuyao.tone ?? 'CALM',
          fallbackAt: anchor?.at ?? { x: 0, y: 0 },
          placed: this.memory,
        })
        this.memory = saveMemory(this.store, [...this.memory, keepsake])
        keepsakeOf.set(c.id, keepsake.id)
      } catch (e) {
        // ★ 门禁 ⑨：纪念品造不出来也不能打断"到日子了"这件事本身
        logger.warn('[engine] 纪念品创建失败（倒计时照常标记为已触发）', e)
      }
    }

    this.countdowns = res.items.map((c) => {
      const id = keepsakeOf.get(c.id)
      return id ? { ...c, keepsakeId: id } : c
    })
    saveCountdowns(this.store, this.countdowns)

    for (const c of res.fired) {
      if (canShowCountdown(roomMachine.state)) this.send({ type: 'COUNTDOWN_FIRED', id: c.id })
      else if (!roomMachine.ctx.dueQueue.includes(c.id)) roomMachine.ctx.dueQueue.push(c.id)
    }
  }

  /**
   * 把排队中的归零事件补上。
   *
   * ★ 为什么需要它：`tickCountdowns` 只在**当前能展示**（ROOM）时才发事件，
   *   否则只入队。而 `firedAt` 一旦写上，`isDue` 就再也不成立了 ——
   *   也就是说**没有人会再为它发一次事件**。如果不显式排空队列，
   *   那次归零就会被永远留在队列里：用户等了一个月的日子，静默消失。
   */
  private drainDueQueue(): void {
    if (!canShowCountdown(roomMachine.state)) return
    const id = roomMachine.ctx.dueQueue[0]
    if (!id) return
    this.send({ type: 'COUNTDOWN_FIRED', id })
  }

  /**
   * 首启引导的计时。
   * ★ 它必须走状态机（`GUIDE_STEP_TIMEOUT`），不能在 engine 里自己把状态清掉 ——
   *   否则 roomMachine 会永远停在 GUIDE 态，之后所有 `ENTER_ZONE` 都被它静默忽略，
   *   表现为"第一次打开时怎么点都没反应"。
   */
  private tickFirstGuide(now: number): void {
    if (roomMachine.state !== 'GUIDE') {
      this.firstGuideSig = ''
      this.firstGuideShownAt = null
      return
    }
    const g = roomMachine.ctx.guide
    if (!g.key || g.step === null) return
    const step = guideStepAt(g.key, g.step)
    if (!step) return

    const sig = `${g.key}:${g.step}`
    if (sig !== this.firstGuideSig) {
      // 换了新的一句：重新起算（不然第二步会继承第一步已经走完的时间，立刻超时）
      this.firstGuideSig = sig
      this.firstGuideShownAt = now
      return
    }
    if (this.firstGuideShownAt !== null && now - this.firstGuideShownAt >= step.autoHideMs) {
      this.firstGuideShownAt = null
      this.firstGuideSig = ''
      this.send({ type: 'GUIDE_STEP_TIMEOUT' })
    }
  }

  /**
   * 首启引导期间用户做了任何真实操作 → 引导立刻让路。
   *
   * ★ 这是"零门槛"的关键一条：**引导绝不能挡住操作**。
   *   如果 roomMachine 停在 GUIDE 态，`ENTER_ZONE` 是未声明事件、会被静默忽略 ——
   *   用户的第一次点击就会毫无反应，而他会以为是卡了。
   */
  private endFirstGuide(): void {
    if (roomMachine.state === 'GUIDE') this.send({ type: 'GUIDE_DONE' })
  }

  // ── 内部：气泡引导 ──

  private whisper(key: GuideKey | null): void {
    if (!key) return
    if (!shouldShow(key, roomMachine.ctx.seenGuides)) return
    const step = guideStepAt(key, 0)
    if (!step) return
    this.guide = { key, step: 0, text: step.text, at: step.at, autoHideMs: step.autoHideMs }
    this.guideShownAt = null
  }

  /** 用户做了某个动作 → 推进当前引导；做完了就收，并记入 seenGuides */
  private noteAction(did: GuideWaitFor): void {
    // ★ 兜底：任何一个真实动作都先让首启引导让路
    this.endFirstGuide()
    const g = this.guide
    if (!g) return
    const step = guideStepAt(g.key, g.step)
    if (!step || step.waitFor !== did) return
    this.stepGuide(did)
  }

  private tickGuide(now: number): void {
    const g = this.guide
    if (!g) return
    if (this.guideShownAt === null) {
      this.guideShownAt = now
      return
    }
    if (now - this.guideShownAt < g.autoHideMs) return

    // ★ 到点只做两件事：纯叙述步往后走；等动作的步**直接淡出**。
    //   淡出不等于失败，也不再重来 —— 用户已经会了，或者他现在不想做。
    const next = advanceOnTimeout(g.key, g.step)
    if (next === null || next === g.step) {
      this.finishGuide()
      return
    }
    const step = guideStepAt(g.key, next)
    if (!step) {
      this.finishGuide()
      return
    }
    this.guide = { key: g.key, step: next, text: step.text, at: step.at, autoHideMs: step.autoHideMs }
    this.guideShownAt = now
  }

  private stepGuide(did: GuideWaitFor): void {
    const g = this.guide
    if (!g) return
    const next = advance(g.key, g.step, did)
    if (next === null) {
      this.finishGuide()
      return
    }
    const step = guideStepAt(g.key, next)
    if (!step) {
      this.finishGuide()
      return
    }
    this.guide = { key: g.key, step: next, text: step.text, at: step.at, autoHideMs: step.autoHideMs }
    this.guideShownAt = null
  }

  private finishGuide(): void {
    const g = this.guide
    this.guide = null
    this.guideShownAt = null
    if (!g) return
    // ★ 只改内存；落盘由 syncDerived() 统一按"数量变了才写"来处理
    roomMachine.ctx.seenGuides = markSeen(roomMachine.ctx.seenGuides, g.key)
  }

  // ── 内部：派生状态同步（进入某态时算一次该态需要的东西） ──

  /**
   * 推进浮现卡相位。★ 纯时间驱动，不碰 DOM：
   *   appearing 满 APPEAR_MS → shown；fading 满 FADE_MS → hidden + 真正退场。
   *   两段时长与《记忆锚点浮现卡-UI与交互动效规范》逐字对齐。
   */
  private tickCard(now: number): void {
    if (this.cardPhase === 'appearing' && now - this.cardPhaseAt >= MEMORY_CARD_APPEAR_MS) {
      this.cardPhase = 'shown'
    } else if (this.cardPhase === 'fading' && now - this.cardPhaseAt >= MEMORY_CARD_FADE_MS) {
      this.cardPhase = 'hidden'
      this.recalled = null
      // ★ 此刻才真正退场：roomMachine 回到 ROOM，快照里的 recall 随之清空。
      this.send({ type: 'CLOSE_RECALL' })
    }
  }

  private syncDerived(): void {
    const state = roomMachine.state

    // 「看过哪些引导」只在**数量变化**时标脏 —— 否则每帧都 set 一次，
    // 虽然写预算会把它合并，但脏键列表会被无意义地反复刷新
    const seenLen = roomMachine.ctx.seenGuides.length
    if (seenLen !== this.lastSeenLen) {
      this.lastSeenLen = seenLen
      saveSeen(this.store, roomMachine.ctx.seenGuides)
    }

    // 刚进入 READING：按牌阵结构（或六爻维度）算一次解读载荷
    if (state === 'READING' && this.prevRoom !== 'READING') {
      this.reading = this.buildReading()
      // ★ 流失埋点：走到"解读"这一步。用 ctx 判当前是塔罗还是六爻
      trackFunnel(roomMachine.ctx.spread?.id ? 'TAROT_READING' : 'LIUYAO_READING')
    }

    // 刚进入 MEMORY_OFFER：把候选摆件的私语递出去（幂等）
    if (state === 'MEMORY_OFFER' && this.prevRoom !== 'MEMORY_OFFER') {
      this.whisper('MEMORY_OFFER')
      // ★ 流失埋点：走到"记忆锚点"这一步
      trackFunnel(roomMachine.ctx.spread?.id ? 'TAROT_MEMORY' : 'LIUYAO_MEMORY')
    }

    this.prevRoom = state
  }

  private buildReading(): { plan: ReadingPlan | null; request: ReadingRequest | null } {
    const ctx = roomMachine.ctx
    const spread = ctx.spread.id ? getSpread(ctx.spread.id) : null

    if (spread) {
      const plan = buildReadingPlan(spread, ctx.spread.drawn, ctx.spread.deck)
      return { plan, request: buildTarotRequest(plan, ctx.liuyao.tone ?? 'CALM') }
    }

    if (ctx.hexagram) {
      return {
        plan: null,
        request: buildLiuyaoRequest({
          focus: ctx.liuyao.focus ?? 'UNSURE',
          mood: ctx.liuyao.tone ?? 'CALM',
          anchorId: (ctx.liuyao.anchorId as AnchorId | null) ?? null,
          hexagram: ctx.hexagram,
        }),
      }
    }

    return { plan: null, request: null }
  }

  private buildDraft(kind: MemoryKind): MemoryItem {
    const ctx = roomMachine.ctx
    const now = this.nowFn()
    const source: MemorySource = ctx.hexagram
      ? { kind: 'liuyao', hexagram: ctx.hexagram.primary, focus: ctx.liuyao.focus ?? undefined }
      : {
          kind: 'tarot',
          spreadId: ctx.spread.id ?? SPREADS[0]?.id ?? 'daily-single',
          cards: [...ctx.spread.deck],
        }

    return draftMemory({
      kind,
      tone: ctx.liuyao.tone ?? 'CALM',
      source,
      readAt: this.readAt || now,
      now,
    })
  }

  /** 口味余温：只用来让下次少问一步。★ 不参与任何占卜结果 */
  private async rememberAffinity(v: { tone?: MoodTone; focus?: FocusId }): Promise<void> {
    const prev = this.store.get<Record<string, unknown>>(PERSIST_KEYS.affinity, {})
    this.store.set(PERSIST_KEYS.affinity, { ...prev, ...v })
  }

  private send(e: RoomEvent): void {
    roomMachine.ctx.now = this.nowFn()
    roomMachine.send(e)
    this.syncDerived()
  }

  private safeHit(p: Pt): EngineHit {
    try {
      return this.hitTest(p)
    } catch (e) {
      logger.warn('[engine] hitTest 异常（当作没戳到）', e)
      return { kind: 'none' }
    }
  }

  // ── 共情对话 · 云端同意（与 guide / affinity 同路：经引擎持有的 PersistedStore）──
  /** 读云端同意。★ 默认 'off'；UI 打开对话面板时同步一次，用于决定是否显示同意行 */
  getEmpathyConsent(): CloudConsent {
    return loadConsent(this.store)
  }

  /** 写云端同意。★ 由用户在低语卡里显式点选，下一次 flush 落盘；绝不在此处替用户做主 */
  setEmpathyConsent(c: CloudConsent): void {
    saveConsent(this.store, c)
  }

  // ── 语音输入 · 音频出端同意（与共情同意各管各的，见 core/voice/consent.ts）──
  /** 读语音同意。★ 默认 'off'；UI 首次按住说话时同步一次，用于决定是否显示同意行 */
  getVoiceConsent(): VoiceConsent {
    return loadVoiceConsent(this.store)
  }

  /** 写语音同意。★ 由用户在同意行里显式点选，下一次 flush 落盘；绝不在此处替用户做主 */
  setVoiceConsent(c: VoiceConsent): void {
    saveVoiceConsent(this.store, c)
  }

  // ── 背景音 · 静音偏好（与语音/共情同意同路：经引擎持有的 PersistedStore）──
  /** 读静音偏好。★ 默认 false（声音开着）；冷启动时装配层同步一次 */
  getAudioMuted(): boolean {
    return loadAudioMuted(this.store)
  }

  /** 写静音偏好。★ 由用户在 HUD 上显式点选，下一次 flush 落盘 */
  setAudioMuted(muted: boolean): void {
    saveAudioMuted(this.store, muted)
  }

  /** 抽牌：把"牌库里第几张"交给外部（洗牌逻辑在别处），这里只管顺序 */
  drawIndexFor(spread: SpreadConfig | null, index: number): number {
    return spread ? this.drawCardFn(spread, index) : index
  }
}
