/**
 * 小卜 · 空间分区与放置锚点   src/core/room/roomZone.ts
 * ===========================================================================
 * 战略原文：
 *   「**空间布局与双核心玩法（动森式分区）**
 *     1. **塔罗区（角落地毯 / 茶几）**：奶油色柔软毛毯。
 *     2. **六爻区（木桌 / 竹案）**：沉稳古意。
 *        ……用户必须先选择【心情】和【问事方向】，再将道具**拖拽放置到预设锚点**
 *        （窗边、木桌、香炉旁），最后掷币。」
 *
 * ── 为什么这些坐标写在 core 而不是 scene ────────────────────────────────────
 *   它们是**玩法语义**（"这里能放东西"），不是美术实现。而且依赖方向必须是
 *   core → scene 单向（ESLint 禁令 1 只禁 core 反向 import scene）。
 *   代价是这里存在一份与 `worldLayout.ts` 平行的像素坐标 —— 这份重复由
 *   `tests/room-anchor.spec.ts` 用真实导入的 TABLE_QUAD / FELT / WINDOW_PX
 *   **交叉校验**：锚点在不在桌上、在不在毯上、跟既有道具会不会撞，全部断言。
 *   于是"两处坐标漂移"不可能悄悄发生。
 *
 * ── 两份坐标不重复的原则 ────────────────────────────────────────────────────
 *   · `worldLayout.ts`（scene）—— "东西画在哪"：等距反投影、遮挡排序键。
 *   · `roomZone.ts`（core）—— "哪里可以交互"：分区、锚点、吸附半径。
 *   二者重合的部分（桌面四边形、地毯椭圆、窗户矩形）只在 scene 定义**一次**，
 *   本文件只引用其**语义位置**（如"桌面中心附近"），不复制顶点。
 * ===========================================================================
 */

import { nearestCenter } from '@core/ritual/slotResolver'
import { TH } from '@core/ritual/thresholds'
import type { Pt } from '@core/ritual/flight'

/**
 * 房间设计画布尺寸。
 * ★ 与 `@scene/renderer` 的 DESIGN_W / DESIGN_H 必须一致 ——
 *   同样由 `tests/room-anchor.spec.ts` 断言，漂移即红。
 */
export const ROOM_W = 390
export const ROOM_H = 844

// ───────────────────────────────────────────────────────────────────────────
// 分区
// ───────────────────────────────────────────────────────────────────────────

export const ZONE_IDS = ['TAROT', 'LIUYAO'] as const
export type ZoneId = (typeof ZONE_IDS)[number]

export interface ZoneDef {
  id: ZoneId
  /** 展示名 —— ★ 用情绪语言，不用玩法行话（不出现"塔罗区/六爻区"这种词） */
  label: string
  /** 小卜的私语（首次进入该区域时，气泡里逐字念出来的那句话） */
  whisper: string
  /** 分区中心（设计像素） */
  focus: Pt
  /** 分区半径（设计像素） */
  radius: number
  /** 玩法归属：只影响去哪套流程，不影响视觉 */
  gameplay: 'tarot' | 'liuyao'
}

/**
 * ★ 两个分区。
 *
 * ── 一个必须先说清楚的现实 ──────────────────────────────────────────────
 *   设计稿里的毛毡地毯**画在木桌底下**（FELT 椭圆 cy=700 ry=182，覆盖 y 518–882，
 *   而木桌占 y 330–630）。也就是说"角落地毯"目前不是独立于桌子的一块地，
 *   而是"同一块地毯，桌前的部分露出来"。
 *
 *   本文件的处理：把**分区定义成以中心点 + 半径判定的圆形交互域**，
 *   而不是肉眼可见的边界。塔罗区落在桌前露出的那半张毯子上（无重叠争议），
 *   六爻区以木桌为心、半径罩住"桌子 + 桌子周围的站位"。
 *
 *   ⚠ 待美术确认（M2 遗留，与 M1 那条几何遗留同一处理方式）：若希望塔罗区
 *   视觉上明确独立（例如真的挪到画面右下角），需要出一张"角落茶几"的稿；
 *   届时只改本文件的 `focus` / `radius`，其余全部代码自动跟随。
 */
export const ZONES: readonly ZoneDef[] = Object.freeze([
  {
    id: 'LIUYAO',
    label: '木桌竹案',
    whisper: '这张桌子陪了你很久了。把手里的东西放下，我们慢慢来。',
    focus: { x: 195, y: 470 },
    radius: 300,
    gameplay: 'liuyao',
  },
  {
    id: 'TAROT',
    label: '角落地毯',
    whisper: '毯子很软，坐下来就行。牌就在手边，不着急碰它。',
    focus: { x: 195, y: 745 },
    radius: 130,
    gameplay: 'tarot',
  },
])

/**
 * 判定某个点属于哪个分区。
 *
 * ★ 重叠时**半径更小的那个胜出**（更具体的分区优先）。
 *   理由：塔罗区（r=130，圆心 y=745）与六爻区（r=300，圆心 y=470）
 *   在 **y ∈ [615, 770]** 这一段是**互相重叠**的（桌前沿到桌前那片地毯）。
 *   在这段重叠里，如果按"先声明者胜"或者"最近中心点胜"，
 *   点在地毯上就会被判成六爻区，于是"在地毯上点一下"会触发掷币 ——
 *   用户完全无法理解。所以规则只有一个：**半径小的赢**。
 *   规则写在这里，也写成单测，免得以后有人"顺手"改成别的比较方式。
 */
export function zoneAt(p: Pt): ZoneId | null {
  // ★ 入口防护：非有限坐标不属于任何分区。
  //   不挡会怎样？`Math.hypot(NaN, …)` 是 NaN，而 `NaN > radius` 是 **false** ——
  //   也就是"超出半径就跳过"这一步**拦不住** NaN，它会以"半径合法"的身份留在候选里，
  //   最后按"半径小的赢"胜出 ⇒ 一次脏坐标会被判成**塔罗区**。
  //   这是本文件里第二处同款陷阱（第一处在 resolveAnchor），所以两处现在都有单测。
  //
  //   ★ 关于"现在够不够得着"：眼下的到达路径上，脏坐标在手势层就已经被挡掉了
  //   （`Math.hypot(NaN, …)` 使 `isTap` 为 false，TAP 根本不会产生）。
  //   但那条保证是**间接**的 —— 它依赖手势层的阈值比较恰好对 NaN 为 false，
  //   哪天有人把 `peak <= tapMaxMovePt` 改成别的写法，这里就会重新暴露。
  //   判定函数本身对任何输入都该是安全的，所以挡在自己门口，不依赖上游的巧合。
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null

  let best: ZoneId | null = null
  let bestRadius = Infinity

  for (const z of ZONES) {
    const d = Math.hypot(p.x - z.focus.x, p.y - z.focus.y)
    if (d > z.radius) continue
    if (z.radius < bestRadius) {
      bestRadius = z.radius
      best = z.id
    }
  }

  return best
}

export function getZone(id: ZoneId): ZoneDef | null {
  return ZONES.find((z) => z.id === id) ?? null
}

// ───────────────────────────────────────────────────────────────────────────
// 放置锚点（六爻的道具放置目标 + 塔罗的牌桌）
// ───────────────────────────────────────────────────────────────────────────

export const ANCHOR_IDS = ['WINDOW_SILL', 'TABLE_TOP', 'CENSER_SIDE', 'TEA_TABLE'] as const
export type AnchorId = (typeof ANCHOR_IDS)[number]

export interface AnchorDef {
  id: AnchorId
  /** 展示名（气泡里会念到） */
  label: string
  /** 锚点中心（设计像素）—— 道具被拖到这里会轻轻"吸"过去 */
  at: Pt
  /** 吸附半径（pt）—— 与爻位槽共用"最近中心点"判定与并列容差 */
  radius: number
  /** 能放几个。香炉旁只有一个位置，满了就拒绝（但**不报错**，见 placeAt） */
  capacity: number
  zone: ZoneId | null
  /** 锚点的落点语气（小卜在放置成功后说的一句话） */
  murmur: string
}

/**
 * 四个锚点。
 *
 * ★ 为什么每个都要 `capacity = 1`：
 *   多容量会让"最后一次放置覆盖前一次"变成一个必须解释的行为。
 *   而每个锚点各放一件，语义干净、视觉也读得出来（一把竹筒、一炉香、一张牌）。
 *
 * ★ 坐标是**临时取值**，但被 `tests/room-anchor.spec.ts` 三重约束：
 *   ① 必须落在自己声明的分区内
 *   ② 六爻锚点必须落在木桌顶面四边形内
 *   ③ 任意两个锚点间距 ≥ `ANCHOR_MIN_GAP_PT`（否则吸附判定会互相抢）
 *   改动坐标若违反任一条，测试立刻红 —— 不需要人眼盯着算。
 */
export const ANCHORS: readonly AnchorDef[] = Object.freeze([
  {
    id: 'WINDOW_SILL',
    label: '窗边',
    at: { x: 110, y: 226 },
    radius: 44,
    capacity: 1,
    zone: 'LIUYAO',
    murmur: '放在窗边了。光线会一直照着它。',
  },
  {
    id: 'TABLE_TOP',
    label: '木桌',
    at: { x: 195, y: 612 },
    radius: 44,
    capacity: 1,
    zone: 'LIUYAO',
    murmur: '就放桌上吧，看得见的地方。',
  },
  {
    id: 'CENSER_SIDE',
    label: '香炉旁',
    at: { x: 400, y: 500 },
    radius: 44,
    capacity: 1,
    zone: 'LIUYAO',
    murmur: '挨着香炉。这里安静。',
  },
  {
    id: 'TEA_TABLE',
    label: '茶几',
    at: { x: 195, y: 738 },
    radius: 52,
    capacity: 1,
    zone: 'TAROT',
    murmur: '铺在茶几上了，慢慢翻。',
  },
])

/** 任意两锚点的最小间距（设计像素）—— 小于它，两个锚点的吸附域就会互相抢 */
export const ANCHOR_MIN_GAP_PT = 88

export function getAnchor(id: AnchorId): AnchorDef | null {
  return ANCHORS.find((a) => a.id === id) ?? null
}

export function anchorIndex(id: AnchorId): number {
  return ANCHORS.findIndex((a) => a.id === id)
}

// ───────────────────────────────────────────────────────────────────────────
// 锚点吸附（与爻位槽共用同一套判定内核）
// ───────────────────────────────────────────────────────────────────────────

export interface AnchorProbe {
  /** 命中的锚点下标；-1 = 附近没有可用锚点 */
  index: number
  /** 锚点 id；null = 没命中 */
  id: AnchorId | null
  distance: number
  /** 预备态：进入吸附域，道具轻微放大提示"这里可以放" */
  armed: boolean
  /** 落定态：松手就吸附过去 */
  snapped: boolean
}

export interface AnchorResolveOptions {
  /** 每个锚点是否已被占满（长度 = ANCHORS.length） */
  full?: readonly boolean[]
  /** 只考虑这些锚点（例如"当前分区里能放的地方"）；缺省 = 全部 */
  allow?: readonly AnchorId[]
}

/**
 * ★ 落定域 / 吸附域的比例 —— 直接沿用规范给爻位槽的那一对阈值（28 / 44）。
 *   复用它而不是另定一个数，是为了让"吸附手感"在**所有可拖拽物之间完全一致**：
 *   用户在卦盘上学会的力度，到了放摆件时应该是同一个力度。
 */
export const ANCHOR_SNAP_RATIO = TH.SNAP_PT / TH.PRESELECT_PT

/**
 * 找最近的可用锚点。
 *
 * ★ 与 `resolveSlot` 完全同源：同样的"最近中心点 + 并列取小下标"，
 *   区别只有半径来自 AnchorDef 而不是全局阈值。
 *   复用 `nearestCenter` 的意义是：**并列容差只有一份**。
 *
 * ★ 一个刻意的设计：**没有可用锚点时不返回错误，返回 index -1**。
 *   调用方（engine）据此走"就地放下"分支 —— 用户想把它放在哪就放在哪。
 *   战略原文的三条底线里有一条是"绝不弹报错"，这里是从源头保证它无从弹起。
 *
 * ★ 脏坐标（NaN / ±Infinity）也必须走"没命中"，**不能抛**。
 *   这一段是被 tests/room-anchor.spec.ts 逼出来的：NaN 有个反直觉的性质 ——
 *   `Math.hypot(NaN, …) > radius` 是 **false**，所以"半径筛选"这一步**拦不住**它，
 *   点会被算进候选；而 `nearestCenter` 里 `NaN < distance - eps` 同样是 false，
 *   于是它返回 `index = -1`，接下来 `map[-1]` 是 undefined、
 *   `ANCHORS[undefined].id` 直接抛 TypeError。
 *   表现是"用户拖了一下摆件，整个房间静止在那一帧"。
 *   两层防护：入口挡一次非有限数，出口再挡一次非法下标 ——
 *   出口那一层是真正兜底的（因为将来可能有人往 map 里加别的路径）。
 */

/** 哨兵：没命中任何锚点。★ 只有这一处构造，调用方不必自己拼字段 */
function noAnchor(): AnchorProbe {
  return { index: -1, id: null, distance: Infinity, armed: false, snapped: false }
}

export function resolveAnchor(p: Pt, opts: AnchorResolveOptions = {}): AnchorProbe {
  const { full, allow } = opts

  // 入口防护：非有限坐标（NaN / ±Infinity）一个锚点都不可能命中
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return noAnchor()

  // 先过滤出"真正参与判定"的锚点：允许的 + 没满的 + 在自身半径内的。
  // ★ 按自身半径先筛再比最近，而不是先比最近再看半径 ——
  //   否则最近的那个刚好在域外时，会白白把一个域内更远的锚点也否掉。
  const centers: Pt[] = []
  const map: number[] = []
  ANCHORS.forEach((a, i) => {
    if (allow && !allow.includes(a.id)) return
    if (full?.[i]) return // 已满：整个锚点不参与（不是"距离算大一点"）
    if (Math.hypot(p.x - a.at.x, p.y - a.at.y) > a.radius) return
    centers.push(a.at)
    map.push(i)
  })

  if (centers.length === 0) return noAnchor()

  const { index, distance } = nearestCenter(p, centers)
  // 出口兜底：nearestCenter 返回 -1（或下标越界）时按"没命中"处理。
  // ★ 这一行不能省，也不能只依赖上面的入口判断 —— 见函数头的 NaN 说明。
  const anchorIdx = map[index]
  const anchor = ANCHORS[anchorIdx]
  if (anchorIdx === undefined || !anchor || !Number.isFinite(distance)) return noAnchor()

  return {
    index: anchorIdx,
    id: anchor.id,
    distance,
    // 走到这里就说明已经落在吸附域内了，所以 armed 恒为 true
    armed: true,
    snapped: distance <= anchor.radius * ANCHOR_SNAP_RATIO,
  }
}

/** 放置结局 —— ★ 三种，**没有"失败"这一种** */
export type PlaceOutcome =
  | { kind: 'anchor'; id: AnchorId; at: Pt }
  | { kind: 'free'; at: Pt }

/**
 * 把坐标夹进房间矩形，非有限值一律落到 (0, 0)。
 *
 * ★ 为什么非要做这一步：坐标一旦是 NaN，`JSON.stringify` 会把它写成 `null`，
 *   写进本地再读回来就是 `at: { x: null, y: null }` ——
 *   于是这条记忆会在加载时被静默丢掉，表现为"我放的东西第二天不见了"，
 *   而日志里一个字都没有（memoryAnchor.draftMemory 的注释里记着同一个坑）。
 *   所以"就地放下"这条路必须产出一个**一定可序列化**的点。
 *   (0, 0) 与 `draftMemory` 的"未放置哨兵坐标"是同一个约定。
 */
function clampToRoom(p: Pt): Pt {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { x: 0, y: 0 }
  return {
    x: Math.min(Math.max(p.x, 0), ROOM_W),
    y: Math.min(Math.max(p.y, 0), ROOM_H),
  }
}

/**
 * 松手 → 决定落在哪里。
 *
 * ★ 落不到锚点上 = **就地放下**，不是失败。
 *   战略原文：「纯本地存储……绝不允许弹报错」「拒绝压力」。
 *   一个"放偏了"的动作，最自然的回应是"那就放这儿吧"，而不是回弹 + 提示。
 *   所以这里连"作废"这个分支都不存在 —— 只要松手，物件就留在用户放的地方。
 */
export function placeAt(p: Pt, opts: AnchorResolveOptions = {}): PlaceOutcome {
  const probe = resolveAnchor(p, opts)
  if (probe.snapped && probe.id) {
    const a = getAnchor(probe.id)
    if (a) return { kind: 'anchor', id: a.id, at: { ...a.at } }
  }
  return { kind: 'free', at: clampToRoom(p) }
}

/** 把已满的锚点算出来 —— 给 `resolveAnchor` 的 `full` 用 */
export function occupancyOf(placed: ReadonlyArray<{ anchorId: AnchorId | null }>): boolean[] {
  const counts: number[] = ANCHORS.map(() => 0)
  for (const item of placed) {
    if (!item.anchorId) continue
    const i = anchorIndex(item.anchorId)
    if (i >= 0) counts[i]++
  }
  return ANCHORS.map((a, i) => counts[i] >= a.capacity)
}

/** 该分区里还有空的锚点（小卜指路用；★ 只指方向，不替用户选） */
export function openAnchorsIn(zone: ZoneId, full: readonly boolean[]): AnchorId[] {
  return ANCHORS.filter((a, i) => a.zone === zone && !full[i]).map((a) => a.id)
}
