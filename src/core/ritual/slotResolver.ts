/**
 * 小卜 · 爻位吸附求解器   src/core/ritual/slotResolver.ts
 * ===========================================================================
 * 规范原文（交互动效 Brief §3④）：
 *
 *   「**等距轴上的吸附判定（本页最容易被忽略的落地难点）**
 *     六个爻位槽沿等距地板轴排开，**相邻槽心只差约 15pt**。这意味着：
 *       · 单个槽的视觉尺寸只有约 73 × 10pt
 *       · 如果按"矩形热区 ≥ 44pt"来做，一个热区会**同时覆盖相邻三个槽**，
 *         命中率反而崩掉
 *
 *     正确做法：不做矩形命中，做**最近中心点判定**。
 *       1. 计算指针到六个空槽中心的距离
 *       2. 取最近的槽
 *       3. 距离 ≤ 44pt → 触发"预备吸附"高亮；≤ 28pt → 落定
 *
 *     这样"有效交互带"达到 44pt（符合可点区域要求），同时**天然不会歧义**。
 *     这是 390pt 宽度下唯一能同时满足命中率与视觉细槽的方案。」
 *
 * ── 为什么这个文件值得单独存在 ────────────────────────────────────────────
 * 这是"手感"与"数学"的交界处，也是最容易写错、且写错了极难在真机上定位的地方：
 *   槽只有 73 × 10pt，而可点区域要做 44pt —— 两者差 3 倍多。
 * 把它抽成纯函数，就能在 node 里用确定性的坐标断言（规范 §8.3 给了用例），
 * 而不是"在手机上试半天，感觉好像行"。
 *
 * ★ 零依赖纯函数：不碰 DOM / Canvas / Vue。命中判定一律在**屏幕空间**做，
 *   这样"44pt"对用户永远是同一个手感，与物体在场景里的网格尺寸无关。
 * ===========================================================================
 */

import { TH } from './thresholds'
import type { Pt } from './flight'

/** 爻位槽视觉尺寸（pt）—— 73 × 10。写在这里是为了让"为什么不能做矩形热区"有据可查。 */
export const SLOT_VISUAL_PT = { w: 73, h: 10 } as const

/**
 * "并列"的判定容差（pt）。
 *
 * ★ 为什么需要它：两个槽的**几何**中点，在浮点里算出来的距离差约 1e-14，
 *   用严格 `<` 比较时结果取决于最后一位是 0 还是 1 —— 也就是**同一个输入
 *   有时选槽 0、有时选槽 1**。这在真机上表现为"界面在抖"，
 *   比"选错一格"更让人不安心。
 *
 * 1e-6 pt 远低于感知阈值（人眼分不出百万分之一 pt），但远高于浮点噪声，
 * 于是"并列取下标更小者"变成**结构上成立**的性质，而不是运气。
 */
export const SLOT_TIE_EPS_PT = 1e-6

export interface SlotProbe {
  /** 最近的可用槽下标；-1 表示一个可用的都没有 */
  index: number
  /** 到该槽心的距离（pt）。无可用槽时为 Infinity */
  distance: number
  /** 预备吸附：≤ PRESELECT_PT(44) —— 该槽描边提亮、铜钱给 1.08 预备缩放 */
  armed: boolean
  /** 可以落定：≤ SNAP_PT(28) —— 松手就吸附过去 */
  snapped: boolean
}

export interface ResolveOptions {
  /** 每个槽是否已被占用（长度 = centers.length）。已占的槽不参与吸附 */
  occupied?: readonly boolean[]
}

/**
 * ★ 通用的「最近中心点」内核。
 *
 * 抽出来是为了让**并列容差只有一处** —— 爻位槽、房间锚点、牌位吸附都要这套逻辑，
 * 各写一份的结果必然是"三处的容差慢慢漂移"，而漂移的后果是某处开始抖、
 * 某处不抖，排查时根本想不到是容差的问题。
 *
 * 语义（三处共享，改这里就是改全局）：
 *   · 只有"明显更近"（差 > eps）才换目标 ⇒ 并列时稳定返回**下标更小**的那个
 *   · 被占用的位置直接跳过（不是"距离算大一点"，是根本不参与）
 *   · 找不到任何可用位置时返回 { index: -1, distance: Infinity }
 */
export function nearestCenter(
  p: Pt,
  centers: readonly Pt[],
  opts: { occupied?: readonly boolean[]; eps?: number } = {},
): { index: number; distance: number } {
  const eps = opts.eps ?? SLOT_TIE_EPS_PT
  let index = -1
  let distance = Infinity

  for (let i = 0; i < centers.length; i++) {
    if (opts.occupied?.[i]) continue
    const c = centers[i]
    const d = Math.hypot(p.x - c.x, p.y - c.y)
    if (d < distance - eps) {
      distance = d
      index = i
    }
  }

  return { index, distance }
}

/**
 * 最近中心点判定。
 *
 * ★ 并列时取**下标更小**的那个（严格 `<` 比较）。
 *   规范 §8.3 用例 5：指针落在槽 1 与槽 2 正中（各距 7.5pt）时
 *   **必须返回一个确定的槽，不能返回两个** —— 手感上"摇摆不定"比"选错一格"更糟，
 *   因为用户会觉得界面在抖。
 */
export function resolveSlot(
  p: Pt,
  centers: readonly Pt[],
  opts: ResolveOptions = {},
): SlotProbe {
  const { occupied } = opts
  // ★ 核心判定走公共内核 nearestCenter —— 并列容差与"跳过已占用"只有一处实现
  const { index, distance } = nearestCenter(p, centers, { occupied })

  return {
    index,
    distance,
    armed: index >= 0 && distance <= TH.PRESELECT_PT,
    snapped: index >= 0 && distance <= TH.SNAP_PT,
  }
}

/**
 * 最近的**空**槽下标（温柔引导 B 用：小卜轻举前爪指向最近的空槽）。
 * 返回 -1 表示六槽已满。
 *
 * ★ 注意它**只指方向，不替用户选** ——
 *   规范 §5 引导态 B 的禁止项：「不自动吸附、不弹层解释规则、不给出"推荐爻位"」。
 */
export function nearestEmptySlot(
  p: Pt,
  centers: readonly Pt[],
  occupied: readonly boolean[],
): number {
  return resolveSlot(p, centers, { occupied }).index
}

/** 全部空槽的 { 下标, 中心 } —— 空槽渲染、呼吸循环都吃它 */
export function emptySlots(
  centers: readonly Pt[],
  occupied: readonly boolean[],
): Array<{ index: number; center: Pt }> {
  const out: Array<{ index: number; center: Pt }> = []
  for (let i = 0; i < centers.length; i++) {
    if (!occupied[i]) out.push({ index: i, center: centers[i] })
  }
  return out
}

/** 离指针最近的空槽中心（找不到就退回整盘的几何中心，永远有东西可指） */
export function nearestEmptyCenter(
  p: Pt,
  centers: readonly Pt[],
  occupied: readonly boolean[],
): Pt {
  const i = nearestEmptySlot(p, centers, occupied)
  if (i >= 0) return centers[i]
  // 六槽已满（理论上不会走到：第 6 枚落位即 CAST）
  if (centers.length === 0) return p
  let sx = 0
  let sy = 0
  for (const c of centers) {
    sx += c.x
    sy += c.y
  }
  return { x: sx / centers.length, y: sy / centers.length }
}

/**
 * 松手时的四种结局判定（规范 §5 引导态 C / D）。
 * 顺序有意如此：**先判吸附，再判反悔** ——
 * 卦盘与竹筒的判定区若重叠，宁可让用户落位成功，也不要莫名其妙作废。
 */
export type DropOutcome =
  | { kind: 'snap'; slot: number }
  | { kind: 'revoke' }
  | { kind: 'stay' }

export function resolveDrop(
  p: Pt,
  centers: readonly Pt[],
  occupied: readonly boolean[],
  cupCenter: Pt,
): DropOutcome {
  const probe = resolveSlot(p, centers, { occupied })
  if (probe.snapped) return { kind: 'snap', slot: probe.index }

  const dCup = Math.hypot(p.x - cupCenter.x, p.y - cupCenter.y)
  if (dCup <= TH.REVOKE_PT) return { kind: 'revoke' }

  // 「停在别处：不弹回、不报错、保持可拖动」
  return { kind: 'stay' }
}
