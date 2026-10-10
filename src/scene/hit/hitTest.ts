/**
 * 小卜 · 场景命中测试   src/scene/hit/hitTest.ts
 * ===========================================================================
 * 战略原文（M2 开发任务书 · 边界②）：
 *   「**core 不认识像素。** 引擎要知道"这个点戳到了哪枚铜钱"，
 *     但它不许 import scene。所以几何判定由外部注入：
 *     `hitTest: (p) => EngineHit`。scene 层实现它，engine 只消费语义结果。」
 *
 * 这个文件就是那一半。它把**设计像素坐标**翻译成 `EngineHit` 的七个语义之一，
 * 于是引擎永远不需要知道"铜钱画在椭圆还是矩形里"。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  一、为什么判定顺序本身就是需求
 * ───────────────────────────────────────────────────────────────────────────
 * 命中是一串 if-else，**顺序错了就是 bug**，而且是最难自查的那一类。这里从
 * "用户此刻想干什么"倒推，得到一条固定的优先级：
 *
 *   记忆锚点 > 倒计时摆件 > 铜钱 > 竹筒 > 牌堆 > 放置锚点 > 什么都不是
 *
 *   · **记忆锚点必须最前。** 摆件是**放在锚点上**的（茶几、木桌、窗边都是锚点）。
 *     如果锚点先判，用户点自己那盆绿植会被判成"点到了茶几" → 进塔罗流程；
 *     而他想的是"我想看看这盆绿植是哪天来的"。语义被吃掉，用户只会觉得
 *     "这东西点了没反应"。所以**越具体、越属于用户的东西越先判**。
 *   · **铜钱在竹筒之前。** 铜钱会被拖到竹筒口上方（反悔/收筒），两者重叠时，
 *     用户按住的显然是那枚**可拿走的**铜钱。而且引擎只在 `pressHit.kind === 'coin'`
 *     时才把 LONG_PRESS 转给仪式机（否则 coinId = -1 会污染仪式上下文）——
 *     顺序反了，掷币就永远起不来。
 *   · **锚点最后。** 它是"一片可以放东西的区域"，比具体物件更虚；只在什么都没
 *     戳到时才代表用户的意图（"我想在这儿放东西 / 我想去那片地"）。
 *   · **牌堆在锚点之前**：牌堆压在茶几上，戳到牌自然是想翻牌。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  二、两条硬约束
 * ───────────────────────────────────────────────────────────────────────────
 *  ① **绝不抛异常。** 脏采样（NaN / ±Infinity）在设计坐标里是可能出现的
 *     （见 `roomZone.ts` 那段 NaN 的留档：`Math.hypot(NaN, …) > r` 是 false，
 *     半径筛选拦不住它）。这里在入口一次性挡掉，返回 `{ kind: 'none' }`。
 *     理由和那边一样：命中判定出错不该让整个房间静止。
 *  ② **并列取下标更小者。** 复用 `nearestCenter`，于是"并列容差只有一份"——
 *     爻位槽、房间锚点、这里的物件命中用的都是同一套规则。
 *     摇摆不定比选错一格更糟：用户会觉得界面在抖。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  三、它不认识"手感"
 * ───────────────────────────────────────────────────────────────────────────
 * 每个可点物件都有一对**互相矛盾**的尺寸：视觉尺寸与可点域尺寸。
 * 铜钱视觉半径 11pt，但手指的接触面远大于它 —— 按视觉尺寸判命中，
 * 掷币会变成"抽奖"（规范 §8.3 已经把这条教训写进爻位槽那一节）。
 * 所以本文件里的半径一律是**可点域**，取值见下方常量，且由单测钉住
 * "两个相邻可点域不重叠"这种结构性性质。
 * ===========================================================================
 */

import { ANCHORS } from '@core/room/roomZone'
import { nearestCenter } from '@core/ritual/slotResolver'
import type { Pt } from '@core/ritual/flight'
import type { EngineHit } from '@core/engine'
import { COIN_IDLE_PX, TUBE_PX } from '@scene/layers/worldLayout'
import type { Vec2 } from '@scene/renderer'

// ───────────────────────────────────────────────────────────────────────────
// 可点域半径（pt）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 铜钱的可点半径。
 *
 * ★ 为什么不是视觉半径 11：一枚躺平的铜钱画出来只有 22 × 11pt，
 *   按它判命中等于要求用户"用指尖对准一个米粒"。
 *   取 18 的**上界由现实决定**：两枚待机铜钱中心相距 43.3pt
 *   （`COIN_IDLE_PX`：(196,452) 与 (232,476)），
 *   18 + 18 = 36 < 43.3，于是两个可点域**不重叠**、不存在歧义；
 *   再放大到 22 就会重叠，用户按哪一枚变得取决于亚像素。
 *   这个不等式由单测钉住 —— 以后谁想把这个数改大，测试会先说话。
 */
export const COIN_TOUCH_R_PT = 18

/**
 * 记忆锚点（摆件）的可点半径。
 * 摆件比铜钱小（是"小东西"而不是"道具"），但人有记忆、会照着位置去点，
 * 所以给到 16 —— 视觉上约 24pt 宽，可点域比它大一圈，手感是"点得到"。
 */
export const MEMORY_TOUCH_R_PT = 16

/**
 * 倒计时摆件（沙漏 / 日历）的可点半径。
 * 它比摆件大一号（是个"摆件形态的钟"），且是**全屏唯一入口**，
 * 点不中就永远设不了倒计时 —— 所以给到 18。
 */
export const TIMEPIECE_TOUCH_R_PT = 18

/**
 * 竹筒可点域的外扩量（pt）。
 *
 * ★ 竹筒是唯一用矩形判定的物件：它**立着**（外接框 44 × 50pt），
 *   用圆判会把两个上角切掉 —— 而用户戳的恰恰是"筒口那两个角"。
 *   外扩 8 是为了补上筒身右侧阴影延伸到的那一点，也把 44pt 可点宽度
 *   抬到 60pt，符合可点区域要求。
 */
export const TUBE_TOUCH_PAD_PT = 8

/**
 * 牌堆的可点半径。牌堆是一叠牌（不是一张），所以比单件大。
 * ★ M2 现状：设计稿里**还没有牌堆**（"角落茶几"是同一批待补的美术稿）。
 *   在它到位之前 `deck` 恒为 null，戳地毯走 `zoneAt` 兜底 → 同样进塔罗区，
 *   用户完全无感。字段先留着，是为了让"牌堆落地时该返回什么"有明确答案，
 *   而不是让下一个人去猜"点毯子应该走哪条路"。
 */
export const DECK_TOUCH_R_PT = 34

// ───────────────────────────────────────────────────────────────────────────
// 输入：场景里此刻有什么
// ───────────────────────────────────────────────────────────────────────────

/** 一个可命中的圆形物件（摆件 / 倒计时摆件 / 牌堆都用它） */
export interface HitCircle {
  id: string
  at: Vec2
  /** 可点半径（pt）。不传则用该类物件的默认半径 */
  r?: number
}

/**
 * 命中判定需要的**全部动态信息**。
 *
 * ★ 为什么用"传进来"而不是"模块里读全局变量"：
 *   铜钱在飞、摆件刚被放下、倒计时刚被收走 —— 这些每一帧都在变。
 *   做成参数之后，这个函数在 node 里可以用任意状态组合跑测试，
 *   而不需要模拟一个真的 Canvas。检查"竹筒被拿走时戳原位置会怎样"
 *   这种边界，只值一行测试代码。
 */
export interface SceneHitState {
  /** 铜钱当前落点（设计像素，含飞行中）；顺序 = coinId */
  coins: readonly Vec2[]
  /** 竹筒此刻是否能被戳（被拿起 / 收进筒时不参与命中） */
  tubeVisible: boolean
  /** 牌堆（美术稿到位前恒 null） */
  deck: HitCircle | null
  /** 已放置的记忆锚点 */
  memory: readonly HitCircle[]
  /** 已设定的倒计时摆件 */
  timepiece: readonly HitCircle[]
}

/**
 * 开场状态：桌面两枚待机铜钱、竹筒在场、没有摆件、没有倒计时、没有牌堆。
 * ★ 它是 `Scene` 的**初值**，不是"永远的真值" —— 之后由场景层每帧刷新。
 */
export function idleHitState(): SceneHitState {
  return {
    coins: COIN_IDLE_PX.map((p) => ({ x: p.x, y: p.y })),
    tubeVisible: true,
    deck: null,
    memory: [],
    timepiece: [],
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 判定
// ───────────────────────────────────────────────────────────────────────────

/** 空命中 —— 只有这一处构造，调用方不必自己拼字面量 */
const NOTHING: EngineHit = { kind: 'none' }

/**
 * 从一组圆里挑出被点中的那个。
 *
 * ★ 分两步而不是一步：**先按各自半径筛，再比最近**。
 *   反过来（先比最近再看半径）会有一个反直觉的 bug —— 最近的物件恰好
 *   在域外时，会把域内更远的那个也一起否掉，表现为"明明点在大物件上却没事发生"。
 *   `resolveAnchor` 里记着同一条教训，两处刻意写成同一个形状。
 */
function pickCircle(p: Pt, list: readonly HitCircle[], defaultR: number): HitCircle | null {
  const centers: Pt[] = []
  const map: HitCircle[] = []

  for (const it of list) {
    const r = it.r ?? defaultR
    if (Math.hypot(p.x - it.at.x, p.y - it.at.y) > r) continue
    centers.push(it.at)
    map.push(it)
  }

  if (centers.length === 0) return null

  const { index, distance } = nearestCenter(p, centers)
  const hit = map[index]
  // 出口兜底：nearestCenter 理论上只返回合法下标，但 NaN 会把 distance 变成 NaN，
  // 而 `NaN < Infinity - eps` 是 false —— 于是 index 停在 -1。挡一次，绝不让
  // 一次脏采样变成 undefined 往外冒。
  if (!hit || !Number.isFinite(distance)) return null
  return hit
}

/** 点在竹筒的外接框（含外扩）里？ */
function inTube(p: Pt): boolean {
  const pad = TUBE_TOUCH_PAD_PT
  const x0 = TUBE_PX.x - pad
  const y0 = TUBE_PX.y - pad
  const x1 = TUBE_PX.x + TUBE_PX.w + pad
  const y1 = TUBE_PX.y + TUBE_PX.h + pad
  return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1
}

/**
 * 点在哪个放置锚点的吸附域里？并列取下标更小者。
 *
 * ★ 用锚点自己的 `radius`（44 / 52）而不是另定一个可点半径：
 *   "能戳到"和"松手会吸过去"必须是同一个范围。两个数一旦分开，
 *   会出现"戳这里有反应、但东西放不上"的错位感；也会让
 *   `room-anchor.spec.ts` 那条"锚点必须落在自己声明的分区内"的保证失效。
 */
function pickAnchor(p: Pt): (typeof ANCHORS)[number] | null {
  const centers: Pt[] = []
  const map: Array<(typeof ANCHORS)[number]> = []

  for (const a of ANCHORS) {
    if (Math.hypot(p.x - a.at.x, p.y - a.at.y) > a.radius) continue
    centers.push(a.at)
    map.push(a)
  }

  if (centers.length === 0) return null

  const { index, distance } = nearestCenter(p, centers)
  const hit = map[index]
  if (!hit || !Number.isFinite(distance)) return null
  return hit
}

/**
 * 设计像素点 → 语义命中。**纯函数**：同一个 (p, state) 永远同一个结果。
 */
export function hitTestAt(p: Pt, state: SceneHitState): EngineHit {
  // ★ 入口防护：脏坐标一个物件都不可能命中。见文件头 §二·①
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return NOTHING

  // ① 记忆锚点 —— 最具体、最私人，且它盖在锚点上面
  const mem = pickCircle(p, state.memory, MEMORY_TOUCH_R_PT)
  if (mem) return { kind: 'memory', id: mem.id }

  // ② 倒计时摆件
  const tp = pickCircle(p, state.timepiece, TIMEPIECE_TOUCH_R_PT)
  if (tp) return { kind: 'timepiece', id: tp.id }

  // ③ 铜钱（coinId = 在下标里）
  const coinIdx = coinIndexAt(p, state.coins)
  if (coinIdx >= 0) return { kind: 'coin', coinId: coinIdx }

  // ④ 竹筒
  if (state.tubeVisible && inTube(p)) return { kind: 'tube' }

  // ⑤ 牌堆
  const deck = state.deck
  if (deck && Math.hypot(p.x - deck.at.x, p.y - deck.at.y) <= (deck.r ?? DECK_TOUCH_R_PT)) {
    return { kind: 'deck' }
  }

  // ⑥ 放置锚点
  const anchor = pickAnchor(p)
  if (anchor) return { kind: 'anchor', id: anchor.id }

  return NOTHING
}

/** 单独拆出来是因为引擎只在硬币上才有 LONG_PRESS 语义，这个下标要准 */
function coinIndexAt(p: Pt, coins: readonly Vec2[]): number {
  const centers: Pt[] = []
  const idx: number[] = []

  coins.forEach((c, i) => {
    if (Math.hypot(p.x - c.x, p.y - c.y) > COIN_TOUCH_R_PT) return
    centers.push(c)
    idx.push(i)
  })

  if (centers.length === 0) return -1

  const { index, distance } = nearestCenter(p, centers)
  const hit = idx[index]
  if (hit === undefined || !Number.isFinite(distance)) return -1
  return hit
}

// ───────────────────────────────────────────────────────────────────────────
// 给引擎用的闭包（`EngineOptions.hitTest` 要的就是这个形状）
// ───────────────────────────────────────────────────────────────────────────

export type SceneHitStateGetter = () => SceneHitState

/**
 * 包一个 `(p) => EngineHit`。
 *
 * ★ 每次调用都**重新取一次状态**，绝不缓存：铜钱每一帧都在新的位置上，
 *   缓存一次就等于"从第一帧起，命中判定永远停在开场那两枚铜钱上"，
 *   表现为"掷币之后再想拖铜钱就没反应了"。
 *   这条被单测专门钉了一句（改状态 → 再查 → 结果必须跟着变）。
 *
 * ★ getState 抛异常时返回"没戳到"：命中测试是**最外层**的输入，这里崩了
 *   用户的手势会全程丢失，而且没有任何地方能告诉他。
 */
export function createSceneHitTest(getState: SceneHitStateGetter): (p: Pt) => EngineHit {
  return (p: Pt): EngineHit => {
    let state: SceneHitState
    try {
      state = getState()
    } catch {
      return NOTHING
    }
    return hitTestAt(p, state)
  }
}
