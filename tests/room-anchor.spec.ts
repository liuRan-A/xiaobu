/**
 * 房间分区与锚点吸附 · 回归测试   tests/room-anchor.spec.ts
 * ===========================================================================
 * 对应 M2 任务书「二、空间布局与双核心玩法」的：
 *   · 动森式分区（塔罗区 / 六爻区，重叠时半径小的赢）
 *   · 道具拖拽到**预设锚点**（窗边、木桌、香炉旁、茶几）
 *
 * ── 为什么这套用例必须存在 ────────────────────────────────────────────────
 *   锚点坐标住在 `src/core/room/roomZone.ts`，而"东西画在哪"住在
 *   `src/scene/layers/worldLayout.ts` —— 这是**两份平行的像素坐标**，
 *   是刻意的（core 不能被 scene 反向依赖），代价是"漂移不会报编译错"。
 *   所以这里的做法是：**把 scene 的真几何真的 import 进来**，
 *   逐条断言 core 的锚点确实落在桌面内 / 地毯上 / 没跟既有道具撞。
 *   于是"两处坐标漂移"在当前代码库里是不可能悄悄发生的。
 *
 * ── 三个最容易写错、也最难在真机上发现的点 ──────────────────────────────
 *   ① 「吸附域」与「落定域」的比例必须与爻位槽那一套**完全同源**（28/44）——
 *      用户在卦盘上学到的力度，到了放摆件时必须是同一个力度。
 *   ② 没有可用锚点时**不是失败**，是就地放下（`placeAt` 连失败分支都没有）。
 *   ③ 已满 / 未允许的锚点**整个退出判定**，而不是"距离算大一点"——
 *      后者会让一个更远的合法锚点被白白否掉。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  ANCHORS,
  ANCHOR_IDS,
  ANCHOR_MIN_GAP_PT,
  ANCHOR_SNAP_RATIO,
  ROOM_H,
  ROOM_W,
  ZONES,
  anchorIndex,
  getAnchor,
  getZone,
  occupancyOf,
  openAnchorsIn,
  placeAt,
  resolveAnchor,
  zoneAt,
  type AnchorId,
  type AnchorResolveOptions,
} from '@core/room/roomZone'
import { SLOT_TIE_EPS_PT, nearestCenter } from '@core/ritual/slotResolver'
import { TH } from '@core/ritual/thresholds'
import type { Pt } from '@core/ritual/flight'
import {
  COIN_IDLE_PX,
  FELT,
  PLANT_PX,
  TABLE_QUAD,
  TUBE_PX,
  WINDOW_PX,
  XIAOBU_PX,
} from '@scene/layers'
import { DESIGN_H, DESIGN_W, type Quad, type Vec2 } from '@scene/renderer'

// ───────────────────────────────────────────────────────────────────────────
// 几何小工具（测试自带，不依赖被测代码 —— 免得"用错的尺子量错的东西"）
// ───────────────────────────────────────────────────────────────────────────

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

/** 凸四边形内点判定：四个边的叉积同号（Quad 按上→右→下→左 顺序给顶点） */
function inQuad(p: Pt, q: Quad): boolean {
  const ring: Vec2[] = [q.top, q.right, q.bottom, q.left]
  let neg = 0
  let pos = 0
  for (let i = 0; i < 4; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % 4]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross < 0) neg++
    if (cross > 0) pos++
  }
  return neg === 0 || pos === 0
}

const inEllipse = (p: Pt, e: { cx: number; cy: number; rx: number; ry: number }): boolean =>
  ((p.x - e.cx) / e.rx) ** 2 + ((p.y - e.cy) / e.ry) ** 2 <= 1

const anchorAt = (id: AnchorId): Pt => {
  const a = getAnchor(id)
  if (!a) throw new Error(`锚点 ${id} 不存在`)
  return a.at
}

const fullNone = (): boolean[] => ANCHORS.map(() => false)

// ═══════════════════════════════════════════════════════════════════════════
//  ①  分区：两个圆形交互域
// ═══════════════════════════════════════════════════════════════════════════

describe('分区 · zoneAt', () => {
  it('画布尺寸与渲染层一致 —— 漂移即红（含在文件头承诺的交叉校验）', () => {
    expect(ROOM_W).toBe(DESIGN_W)
    expect(ROOM_H).toBe(DESIGN_H)
  })

  it('两个分区都在画布内，且归属明确的玩法', () => {
    for (const z of ZONES) {
      expect(z.focus.x).toBeGreaterThan(0)
      expect(z.focus.x).toBeLessThan(ROOM_W)
      expect(z.focus.y).toBeGreaterThan(0)
      expect(z.focus.y).toBeLessThan(ROOM_H)
      expect(z.radius).toBeGreaterThan(0)
    }
    expect(ZONES.find((z) => z.id === 'TAROT')?.gameplay).toBe('tarot')
    expect(ZONES.find((z) => z.id === 'LIUYAO')?.gameplay).toBe('liuyao')
  })

  it('分区名与私语都不出现玩法行话（"塔罗区 / 六爻区"不许给用户看）', () => {
    for (const z of ZONES) {
      const text = `${z.label}${z.whisper}`
      expect(text).not.toMatch(/塔罗区|六爻区|玩法|模块/)
      expect(z.label).toBeTruthy()
      expect(z.whisper).toBeTruthy()
    }
    expect(ZONES.find((z) => z.id === 'TAROT')?.label).toBe('角落地毯')
    expect(ZONES.find((z) => z.id === 'LIUYAO')?.label).toBe('木桌竹案')
  })

  it('各分区圆心处判定为自己', () => {
    for (const z of ZONES) expect(zoneAt(z.focus)).toBe(z.id)
  })

  it('区域之外返回 null（不是抛异常，也不是默认值）', () => {
    for (const p of [
      { x: 5, y: 5 },
      { x: 385, y: 20 },
      { x: 5, y: 840 },
      { x: 385, y: 840 },
    ]) {
      expect(zoneAt(p)).toBeNull()
    }
  })

  it('★ 脏坐标（NaN / ±Infinity）不属于任何分区 —— 不挡的话它会被判成塔罗区', () => {
    // 这一段是**真踩过的第二个同款陷阱**：
    //   `Math.hypot(NaN, …)` 是 NaN，而 `NaN > radius` 是 false ——
    //   "超出半径就跳过"这一步拦不住 NaN，它会以"半径合法"的身份留在候选里，
    //   最后按"半径小的赢"胜出 ⇒ 一次脏采样把用户送进塔罗流程。
    //   resolveAnchor 里记着同一个坑（第一处），这里补上第二处。
    for (const p of [
      { x: NaN, y: NaN },
      { x: NaN, y: 470 },
      { x: 195, y: NaN },
      { x: Infinity, y: 470 },
      { x: 195, y: -Infinity },
    ]) {
      expect(zoneAt(p), `${JSON.stringify(p)} 被判成了某个分区`).toBeNull()
    }
  })

  it('★ 重叠段里半径小的胜出 —— 地毯上的那一下不能触发掷币', () => {
    const liuyao = getZone('LIUYAO')!
    const tarot = getZone('TAROT')!

    // 先证明这一段**确实重叠**（否则下面那条断言是空的）
    const probe: Pt = { x: 195, y: 700 }
    expect(dist(probe, liuyao.focus)).toBeLessThanOrEqual(liuyao.radius)
    expect(dist(probe, tarot.focus)).toBeLessThanOrEqual(tarot.radius)

    // 重叠 → 半径小的（TAROT）赢。这正是"在地毯上点一下"该有的结果。
    expect(tarot.radius).toBeLessThan(liuyao.radius)
    expect(zoneAt(probe)).toBe('TAROT')

    // 再取重叠段的两端各一个点，规律一致
    expect(zoneAt({ x: 195, y: 620 })).toBe('TAROT')
    expect(zoneAt({ x: 195, y: 765 })).toBe('TAROT')
  })

  it('只落在六爻域内、不在塔罗域内的点 → LIUYAO', () => {
    // 桌面中心附近：距桌心很近，但离地毯圆心 265pt（> 130）→ 只有 LIUYAO 认领
    const p = anchorAt('TABLE_TOP')
    expect(zoneAt(p)).toBe('LIUYAO')
    expect(zoneAt({ x: 195, y: 470 })).toBe('LIUYAO')
  })

  it('getZone 不认识返回 null', () => {
    expect(getZone('TAROT')?.id).toBe('TAROT')
    expect(getZone('NOPE' as never)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ②  锚点几何：与 scene 的真实坐标交叉校验
// ═══════════════════════════════════════════════════════════════════════════

describe('锚点几何 · 与 worldLayout 交叉校验', () => {
  it('M2 要求的四个锚点齐全，id 与顺序稳定', () => {
    expect(ANCHOR_IDS).toEqual(['WINDOW_SILL', 'TABLE_TOP', 'CENSER_SIDE', 'TEA_TABLE'])
    expect(ANCHORS.map((a) => a.id)).toEqual([...ANCHOR_IDS])
    expect(ANCHORS.map((a) => a.label)).toEqual(['窗边', '木桌', '香炉旁', '茶几'])
  })

  it('每个锚点都有归属分区、正半径、容量 1、以及被放下时小卜的一句话', () => {
    for (const a of ANCHORS) {
      // ★ 四个锚点都必须声明分区 —— `AnchorDef.zone` 允许 null 是为了将来
      //   （比如"跨区的临时落点"），但现在一个都不该留空：
      //   没分区的锚点会让"这个分区里还有哪里空着"算不出来。
      expect(a.zone, `${a.id} 没有归属分区`).not.toBeNull()
      expect(a.radius).toBeGreaterThan(0)
      expect(a.capacity).toBe(1)
      expect(a.murmur.length).toBeGreaterThan(0)
      // 私语里不许出现玩法/加载类行话
      expect(a.murmur).not.toMatch(/锚点|吸附|区域|玩法/)
    }
  })

  it('★ 每个锚点必须落在**自己声明的分区**内（约束①，改名/挪坐标都会红）', () => {
    for (const a of ANCHORS) {
      expect(a.zone, `${a.id} 没有分区`).not.toBeNull()
      const zone = a.zone as 'TAROT' | 'LIUYAO'
      expect(zoneAt(a.at), `${a.id} 声明在 ${zone}，但 zoneAt 判成了别的`).toBe(zone)
      // 并且在半径内（zoneAt 的判定依据）
      const def = getZone(zone)!
      expect(dist(a.at, def.focus), `${a.id} 超出 ${zone} 半径`).toBeLessThanOrEqual(def.radius)
    }
  })

  it('六爻的两个锚点（木桌、香炉旁）必须落在**桌面四边形**内', () => {
    // 用 scene 的真实 TABLE_QUAD 判定，不是另抄一组顶点。
    // 曾经桌面四顶点被量错（左右量到了画布边缘），后果是"摆件落在桌子外面"
    // 而没有任何断言在问这件事 —— 这条就是那条缺失的断言。
    for (const id of ['TABLE_TOP', 'CENSER_SIDE'] as const) {
      expect(inQuad(anchorAt(id), TABLE_QUAD), `${id} 不在桌面内`).toBe(true)
    }
  })

  it('茶几锚点必须落在**地毯椭圆**内 —— 牌是铺在毯上的', () => {
    expect(inEllipse(anchorAt('TEA_TABLE'), FELT)).toBe(true)
  })

  it('窗边锚点紧贴窗户下沿（在窗里就挡住光了，离太远又不叫"窗边"）', () => {
    const p = anchorAt('WINDOW_SILL')
    const winBottom = WINDOW_PX.y + WINDOW_PX.h
    expect(p.x).toBeGreaterThan(WINDOW_PX.x)
    expect(p.x).toBeLessThan(WINDOW_PX.x + WINDOW_PX.w)
    expect(p.y).toBeGreaterThan(winBottom) // 在窗下，不在窗上
    expect(p.y - winBottom).toBeLessThan(60) // 但没有离太远
  })

  it('★ 任意两个锚点间距 ≥ ANCHOR_MIN_GAP_PT（否则吸附域互相抢）', () => {
    for (let i = 0; i < ANCHORS.length; i++) {
      for (let j = i + 1; j < ANCHORS.length; j++) {
        const d = dist(ANCHORS[i].at, ANCHORS[j].at)
        expect(d, `${ANCHORS[i].id} ↔ ${ANCHORS[j].id} = ${d.toFixed(1)}`).toBeGreaterThanOrEqual(
          ANCHOR_MIN_GAP_PT,
        )
      }
    }
  })

  it('锚点不与既有道具（竹筒 / 绿植 / 小卜 / 待机铜钱）撞在一起', () => {
    const props: Array<{ name: string; at: Pt }> = [
      { name: '竹筒', at: { x: TUBE_PX.x + TUBE_PX.w / 2, y: TUBE_PX.y + TUBE_PX.h / 2 } },
      { name: '绿植', at: { x: PLANT_PX.cx, y: PLANT_PX.baseY - PLANT_PX.potH / 2 } },
      { name: '小卜', at: { x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY - XIAOBU_PX.h / 2 } },
      ...COIN_IDLE_PX.map((c, i) => ({ name: `待机铜钱${i + 1}`, at: c })),
    ]
    for (const a of ANCHORS) {
      for (const p of props) {
        const d = dist(a.at, p.at)
        expect(d, `${a.id} 与${p.name} 仅相距 ${d.toFixed(1)}pt`).toBeGreaterThan(30)
      }
    }
  })

  it('getAnchor / anchorIndex 与 ANCHORS 一一对应', () => {
    ANCHORS.forEach((a, i) => {
      expect(getAnchor(a.id)?.id).toBe(a.id)
      expect(anchorIndex(a.id)).toBe(i)
    })
    expect(getAnchor('NOPE' as never)).toBeNull()
    expect(anchorIndex('NOPE' as never)).toBe(-1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ③  吸附判定：与爻位槽同一套内核
// ═══════════════════════════════════════════════════════════════════════════

describe('吸附比例 · 与爻位槽同源', () => {
  it('落定域 / 吸附域的比例直接取自爻位槽那对阈值（28 / 44）', () => {
    expect(TH.SNAP_PT).toBe(28)
    expect(TH.PRESELECT_PT).toBe(44)
    expect(ANCHOR_SNAP_RATIO).toBeCloseTo(TH.SNAP_PT / TH.PRESELECT_PT, 12)
    // 落定必须比预备更严格 —— 反过来的话"轻微碰到就吸走"
    expect(TH.SNAP_PT).toBeLessThan(TH.PRESELECT_PT)
  })

  it('★ 手感一致性：凡 radius === PRESELECT_PT 的锚点，吸附阈值就等于 SNAP_PT', () => {
    for (const a of ANCHORS) {
      if (a.radius !== TH.PRESELECT_PT) continue
      expect(a.radius * ANCHOR_SNAP_RATIO, `${a.id}`).toBeCloseTo(TH.SNAP_PT, 9)
    }
  })
})

describe('resolveAnchor · 命中', () => {
  it('正中心 → 距离 0、armed、snapped', () => {
    for (const a of ANCHORS) {
      const p = resolveAnchor(a.at, { full: fullNone() })
      expect(p.id).toBe(a.id)
      expect(p.index).toBe(anchorIndex(a.id))
      expect(p.distance).toBeCloseTo(0, 9)
      expect(p.armed).toBe(true)
      expect(p.snapped).toBe(true)
    }
  })

  it('吸附域内（半径的一半）→ snapped；域边缘（正好 radius）→ 命中但未落定', () => {
    const a = getAnchor('TABLE_TOP')!
    const inside: Pt = { x: a.at.x + a.radius * 0.5, y: a.at.y }
    expect(resolveAnchor(inside, { full: fullNone() }).snapped).toBe(true)

    const edge: Pt = { x: a.at.x + a.radius, y: a.at.y }
    const probe = resolveAnchor(edge, { full: fullNone() })
    expect(probe.id).toBe('TABLE_TOP')
    expect(probe.armed).toBe(true)
    // 边缘等于 radius，严格大于 SNAP 阈值 → 未落定（这正是"松手就原地放下"的边界）
    expect(probe.snapped).toBe(false)
  })

  it('略微超出半径 → 完全未命中（index -1，id null，distance 为 Infinity）', () => {
    const a = getAnchor('TABLE_TOP')!
    const out: Pt = { x: a.at.x + a.radius + 0.5, y: a.at.y }
    const probe = resolveAnchor(out, { full: fullNone() })
    expect(probe.index).toBe(-1)
    expect(probe.id).toBeNull()
    expect(probe.distance).toBe(Number.POSITIVE_INFINITY)
    expect(probe.armed).toBe(false)
    expect(probe.snapped).toBe(false)
  })

  it('★ 已满的锚点整个退出判定 —— 不是"距离算大一点"', () => {
    const near = getAnchor('TABLE_TOP')!
    // 把 TABLE_TOP 标满，指针正停在其中心：卡面上离它 0pt，
    // 但它必须完全不参与，结果就是"附近没有可用锚点"。
    const full = fullNone()
    full[anchorIndex('TABLE_TOP')] = true
    const probe = resolveAnchor(near.at, { full })
    expect(probe.id).toBeNull()
    expect(probe.index).toBe(-1)
    expect(probe.armed).toBe(false)
  })

  it('已满时不会"退而求其次"吸到更远的锚点 —— 半径是硬门，不是排序权重', () => {
    // 指针在 TABLE_TOP 与 CENSER_SIDE 之间偏 TABLE_TOP 22pt 处：
    // 若 TABLE_TOP 已满，CENSER_SIDE 距此 210+pt，远超其 44pt 半径 → 依然不命中。
    const t = anchorAt('TABLE_TOP')
    const full = fullNone()
    full[anchorIndex('TABLE_TOP')] = true
    const probe = resolveAnchor({ x: t.x + 22, y: t.y }, { full })
    expect(probe.id).toBeNull()
  })

  it('allow 白名单生效：不在名单里的锚点不参与', () => {
    const t = anchorAt('TABLE_TOP')
    const probe = resolveAnchor(t, { full: fullNone(), allow: ['CENSER_SIDE', 'TEA_TABLE'] })
    expect(probe.id).toBeNull()
    // 放进名单立刻命中
    expect(resolveAnchor(t, { full: fullNone(), allow: ['TABLE_TOP'] }).id).toBe('TABLE_TOP')
    // 空名单 = 一个都不许
    expect(resolveAnchor(t, { full: fullNone(), allow: [] }).id).toBeNull()
  })

  it('allow 与 full 叠加：名单内但已满 → 依然不命中', () => {
    const t = anchorAt('TABLE_TOP')
    const full = fullNone()
    full[anchorIndex('TABLE_TOP')] = true
    expect(resolveAnchor(t, { full, allow: ['TABLE_TOP'] }).id).toBeNull()
  })

  it('缺省 options 时视为全部锚点、都没满', () => {
    expect(resolveAnchor(anchorAt('TEA_TABLE')).id).toBe('TEA_TABLE')
    expect(resolveAnchor({ x: 195, y: 470 }).id).toBeNull()
  })

  it('部分 full 数组（长度不足）按"未满"处理，不崩', () => {
    const t = anchorAt('TABLE_TOP')
    expect(resolveAnchor(t, { full: [true] }).id).toBe('TABLE_TOP')
    expect(resolveAnchor(t, { full: [] }).id).toBe('TABLE_TOP')
  })

  it('两锚点域内的点吸到更近的那个（半径先筛、再比最近）', () => {
    // TABLE_TOP(195,612) 与 TEA_TABLE(195,738) 相距 126 —— 两域不相交，
    // 所以取中间点 (195, 700)：距 TEA_TABLE 38（域内 52），距 TABLE_TOP 88（域外 44）→ TEA_TABLE
    const probe = resolveAnchor({ x: 195, y: 700 }, { full: fullNone() })
    expect(probe.id).toBe('TEA_TABLE')
    expect(probe.distance).toBeCloseTo(38, 6)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ④  并列容差只有一份（nearestCenter 共享内核）
// ═══════════════════════════════════════════════════════════════════════════

describe('nearestCenter · 并列容差是唯一实现', () => {
  it('并列（完全等距）时取**下标更小**的那个 —— 手感上"摇摆"比"选错"更糟', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    // 正中间，两边各距 5
    const r = nearestCenter({ x: 5, y: 0 }, centers)
    expect(r.index).toBe(0)
    expect(r.distance).toBeCloseTo(5, 9)
  })

  it('差距在容差之内也算并列 —— 结果同样是下标小的', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    // 距槽 0 为 5.0000005，距槽 1 为 4.9999995 —— 差值 1e-6，不严格小于 eps
    const r = nearestCenter({ x: 5.0000005, y: 0 }, centers)
    expect(r.index).toBe(0)
  })

  it('差距超过容差就按下标大的（真的更近就选它）', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(nearestCenter({ x: 5.1, y: 0 }, centers).index).toBe(1)
  })

  it('occupied 的下标被跳过，哪怕它更近', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    const r = nearestCenter({ x: 1, y: 0 }, centers, { occupied: [true, false] })
    expect(r.index).toBe(1)
    expect(r.distance).toBeCloseTo(9, 9)
  })

  it('全部被占用 / 空数组 → index -1、距离 Infinity（不抛异常）', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    expect(nearestCenter({ x: 0, y: 0 }, centers, { occupied: [true, true] })).toEqual({
      index: -1,
      distance: Number.POSITIVE_INFINITY,
    })
    expect(nearestCenter({ x: 0, y: 0 }, []).index).toBe(-1)
  })

  it('自定义 eps 能放大 / 缩小并列带', () => {
    const centers: Pt[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]
    // 距 0 为 5，距 1 为 5 —— 用一个大 eps，前一个保持优势
    expect(nearestCenter({ x: 5, y: 0 }, centers, { eps: 1 }).index).toBe(0)
    // eps = 0：严格小于才算更近 → 并列时仍保留下标小的
    expect(nearestCenter({ x: 5, y: 0 }, centers, { eps: 0 }).index).toBe(0)
    // 默认 eps 就是共享常量
    expect(SLOT_TIE_EPS_PT).toBeLessThan(0.001)
  })

  it('锚点吸附与爻位槽共用这一份内核（行为一致，不是两份相似实现）', () => {
    // 构造一个"两锚点等距"的场景：把指针放在 TABLE_TOP 与 CENSER_SIDE 的
    // 中点上，此时两者距指针相等 —— 但由于两者半径都是 44、中点距各 116.8pt，
    // 都不在域内，所以正确结果是"都未命中"。
    const mid: Pt = {
      x: (anchorAt('TABLE_TOP').x + anchorAt('CENSER_SIDE').x) / 2,
      y: (anchorAt('TABLE_TOP').y + anchorAt('CENSER_SIDE').y) / 2,
    }
    const near = ANCHORS.filter((a) => dist(a.at, mid) <= a.radius)
    expect(near).toHaveLength(0)
    expect(resolveAnchor(mid, { full: fullNone() }).id).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤  placeAt：三种结局里没有"失败"
// ═══════════════════════════════════════════════════════════════════════════

describe('placeAt · 松手即落定', () => {
  it('吸附域内 → 落到锚点的**规范坐标**（不是松手处，免得摆件歪着）', () => {
    const a = getAnchor('CENSER_SIDE')!
    const p: Pt = { x: a.at.x + 10, y: a.at.y - 6 }
    const out = placeAt(p, { full: fullNone() })
    expect(out.kind).toBe('anchor')
    if (out.kind !== 'anchor') return
    expect(out.id).toBe('CENSER_SIDE')
    expect(out.at).toEqual(a.at)
    expect(out.at).not.toBe(a.at) // 副本，不是引用
  })

  it('★ 不在任何锚点上 → 就地放下（不是失败、不报错、不回弹）', () => {
    const p: Pt = { x: 300, y: 300 }
    const out = placeAt(p, { full: fullNone() })
    expect(out.kind).toBe('free')
    if (out.kind !== 'free') return
    expect(out.at).toEqual(p)
  })

  it('落在吸附域内但未到落定阈 → 也是就地放下（边缘地带不强行吸走）', () => {
    const a = getAnchor('TABLE_TOP')!
    // 距中心 radius * 0.8：在域内（armed），但超过落定阈 0.636 * radius
    const p: Pt = { x: a.at.x + a.radius * 0.8, y: a.at.y }
    expect(resolveAnchor(p, { full: fullNone() }).armed).toBe(true)
    expect(resolveAnchor(p, { full: fullNone() }).snapped).toBe(false)
    expect(placeAt(p, { full: fullNone() })).toEqual({ kind: 'free', at: p })
  })

  it('★ 无论什么输入都有结局 —— 遍历画布网格，永不为空', () => {
    const opts: AnchorResolveOptions = { full: fullNone() }
    let anchored = 0
    let free = 0
    for (let x = 0; x <= ROOM_W; x += 13) {
      for (let y = 0; y <= ROOM_H; y += 13) {
        const out = placeAt({ x, y }, opts)
        expect(out.kind === 'anchor' || out.kind === 'free').toBe(true)
        expect(Number.isFinite(out.at.x) && Number.isFinite(out.at.y)).toBe(true)
        if (out.kind === 'anchor') anchored++
        else free++
      }
    }
    // 绝大多数位置是"就地放下"（锚点只占很小一片），但两个分支都必须出现过
    expect(anchored).toBeGreaterThan(0)
    expect(free).toBeGreaterThan(0)
    expect(free).toBeGreaterThan(anchored)
  })

  it('锚点已满时落上去 = 就地放下，用户的东西不会消失', () => {
    const a = getAnchor('TEA_TABLE')!
    const full = fullNone()
    full[anchorIndex('TEA_TABLE')] = true
    const out = placeAt(a.at, { full })
    expect(out.kind).toBe('free')
    if (out.kind !== 'free') return
    expect(out.at).toEqual(a.at)
  })

  it('★ 坐标是 NaN 时不许抛异常、不许返回 undefined（脏采样不能把引擎带崩）', () => {
    // NaN 在真实链路里是够得着的：指针 x/y 经过一次除以 0 的归一化、
    // 或者从一段损坏的手势缓冲里换算方向，都可能产出 NaN。
    // 到这一步如果抛异常，表现是"用户拖了一下，整个房间静止了"。
    for (const bad of [
      { x: Number.NaN, y: Number.NaN },
      { x: Number.POSITIVE_INFINITY, y: 0 },
      { x: 0, y: Number.NEGATIVE_INFINITY },
    ]) {
      expect(() => resolveAnchor(bad, { full: fullNone() })).not.toThrow()
      expect(() => placeAt(bad, { full: fullNone() })).not.toThrow()

      const probe = resolveAnchor(bad, { full: fullNone() })
      // 判不出来就是"没命中"，绝不能是一个半成品 probe
      expect(probe.index).toBe(-1)
      expect(probe.id).toBeNull()
      expect(probe.armed).toBe(false)
      expect(probe.snapped).toBe(false)

      const out = placeAt(bad, { full: fullNone() })
      expect(out).toBeTruthy()
      expect(out.kind).toBe('free')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑥  占用与"还有哪里空着"
// ═══════════════════════════════════════════════════════════════════════════

describe('occupancyOf / openAnchorsIn', () => {
  it('没放东西时全空', () => {
    expect(occupancyOf([])).toEqual(ANCHORS.map(() => false))
  })

  it('放了就满（capacity 都是 1）', () => {
    const full = occupancyOf([{ anchorId: 'WINDOW_SILL' }, { anchorId: 'TEA_TABLE' }])
    expect(full[anchorIndex('WINDOW_SILL')]).toBe(true)
    expect(full[anchorIndex('TEA_TABLE')]).toBe(true)
    expect(full[anchorIndex('TABLE_TOP')]).toBe(false)
    expect(full[anchorIndex('CENSER_SIDE')]).toBe(false)
  })

  it('anchorId 为 null（就地放下的那些）不占用任何锚点', () => {
    const full = occupancyOf([{ anchorId: null }, { anchorId: null }])
    expect(full).toEqual(ANCHORS.map(() => false))
  })

  it('同一锚点被放两次仍算"满"（不越界、不报错）', () => {
    const full = occupancyOf([{ anchorId: 'TABLE_TOP' }, { anchorId: 'TABLE_TOP' }])
    expect(full[anchorIndex('TABLE_TOP')]).toBe(true)
  })

  it('openAnchorsIn 只返回该分区的空锚点', () => {
    expect(openAnchorsIn('LIUYAO', fullNone())).toEqual(['WINDOW_SILL', 'TABLE_TOP', 'CENSER_SIDE'])
    expect(openAnchorsIn('TAROT', fullNone())).toEqual(['TEA_TABLE'])

    const full = fullNone()
    full[anchorIndex('CENSER_SIDE')] = true
    expect(openAnchorsIn('LIUYAO', full)).toEqual(['WINDOW_SILL', 'TABLE_TOP'])
    expect(openAnchorsIn('TAROT', full)).toEqual(['TEA_TABLE'])

    expect(openAnchorsIn('TAROT', ANCHORS.map(() => true))).toEqual([])
  })

  it('★ 每个分区都至少有一个锚点 —— 不然"小卜指路"会指到空气', () => {
    for (const z of ZONES) {
      expect(openAnchorsIn(z.id, fullNone()).length, `${z.label} 没有可用锚点`).toBeGreaterThan(0)
    }
  })
})
