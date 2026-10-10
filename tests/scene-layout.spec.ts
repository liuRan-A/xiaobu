/**
 * 场景装配 · 回归测试   tests/scene-layout.spec.ts
 * ===========================================================================
 * 三件事：
 *   ① 世界布局（worldLayout）不能偏离美术稿 —— 每个器物的世界坐标都必须能
 *      还原成美术量到的那个像素。
 *   ② **和仪式状态机对得上**：worldLayout 算出来的爻位槽中心，
 *      必须与 core/machine/ritualMachine 里那份 SLOT_CENTERS 一致。
 *      这是"渲染"与"玩法"之间唯一的共享几何 —— 一旦漂移，
 *      就会出现"看着吸到了，其实算法认为没吸到"这种最难查的 bug。
 *   ③ 整间屋子能用桩上下文画一遍而不抛异常，并且第一笔永远是奶油底。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  BOARD,
  COIN_IDLE_PX,
  SLOT_COUNT,
  SLOT_V,
  SORT,
  TABLE_QUAD,
  TUBE,
  TUBE_PX,
  boardQuad,
  createSceneStack,
  slotCenterPx,
  slotU,
  tubeFootPx,
} from '@scene/layers'
import { BAND, ISO, MEASURED, project, quadOf, unproject } from '@scene/renderer'
import { SLOT_CENTERS } from '@core/machine/ritualMachine'
import { logger } from '@shared/logger'
import { makeStubCtx } from './stub-ctx'

const MEASURED_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [175.5, 549.2],
  [192.0, 541.0],
  [208.6, 532.7],
  [225.1, 524.5],
  [241.6, 516.2],
  [258.1, 508.0],
]

describe('① 世界布局 ↔ 美术实测像素', () => {
  it('六个爻位槽中心落回实测像素（1px 内）', () => {
    expect(SLOT_COUNT).toBe(6)
    MEASURED_SLOTS.forEach(([mx, my], i) => {
      const p = slotCenterPx(i)
      expect(p.x).toBeCloseTo(mx, 0)
      expect(p.y).toBeCloseTo(my, 0)
    })
  })

  it('爻位槽的 v 与盘面中心严格对齐（设计意图：一排等距的槽）', () => {
    expect(SLOT_V).toBeCloseTo(BOARD.v, 9)
  })

  it('爻位槽沿 +u 每 1 单位一个', () => {
    expect(slotU(1) - slotU(0)).toBeCloseTo(1, 9)
    expect(slotU(5) - slotU(0)).toBeCloseTo(5, 9)
  })

  it('卦盘四顶点落回实测 (218,469)(336,528)(218,587)(100,528)，最大误差 ≤ 0.2px', () => {
    const q = boardQuad()
    const target: ReadonlyArray<readonly [keyof typeof q, number, number]> = [
      ['top', 218, 469],
      ['right', 336, 528],
      ['bottom', 218, 587],
      ['left', 100, 528],
    ]
    let maxErr = 0
    for (const [corner, mx, my] of target) {
      maxErr = Math.max(maxErr, Math.abs(q[corner].x - mx), Math.abs(q[corner].y - my))
    }
    // ★ 这里守的是"半高一旦被量错，取均值会把左右顶点各推偏 0.65px"那条教训。
    //   左右顶点离中心最远，误差是放大的，所以必须用绝对误差上限钉住。
    expect(maxErr).toBeLessThan(0.2)
  })

  it('竹筒与两枚铜钱的世界坐标都能还原回美术给的像素', () => {
    const foot = tubeFootPx()
    expect(foot.x).toBeCloseTo(TUBE_PX.x + TUBE_PX.w / 2, 6)
    expect(foot.y).toBeCloseTo(TUBE_PX.y + TUBE_PX.h, 6)

    COIN_IDLE_PX.forEach((px, i) => {
      const back = project(unproject(px.x, px.y, 1).u, unproject(px.x, px.y, 1).v, 1)
      expect(back.x).toBeCloseTo(px.x, 6)
      expect(back.y).toBeCloseTo(px.y, 6)
      expect(SORT.coins[i]).toBeCloseTo(px.y, 1)
    })
  })

  it('★ 木桌顶面必须是"轴对齐桌面的投影"：平行四边形 + 2:1 等距', () => {
    // 这条测试以前是反着写的 —— 它曾把"手绘风筝形"钉死为正确行为。
    // 那是个错误：等距 2.5D 里任何轴对齐刚体平面投影出来必然是平行四边形，
    // 且半宽/半高 = GW/GH。旧值违反这条（y 差 114.2px = 2×LIFT），
    // 根因是左右顶点被量在了画布边缘（x=0 / 390）。详见 worldLayout.ts。

    // ① 平行四边形恒等式：上 + 下 == 左 + 右
    expect(TABLE_QUAD.top.x + TABLE_QUAD.bottom.x).toBeCloseTo(
      TABLE_QUAD.left.x + TABLE_QUAD.right.x,
      6,
    )
    expect(TABLE_QUAD.top.y + TABLE_QUAD.bottom.y).toBeCloseTo(
      TABLE_QUAD.left.y + TABLE_QUAD.right.y,
      6,
    )

    // ② 上下顶点（可信锚点）必须原样保留
    expect(TABLE_QUAD.top).toEqual({ x: 195, y: 330 })
    expect(TABLE_QUAD.bottom).toEqual({ x: 195, y: 630 })

    // ③ 半宽/半高 == 网格比例
    const halfW = TABLE_QUAD.right.x - TABLE_QUAD.top.x
    const halfH = (TABLE_QUAD.bottom.y - TABLE_QUAD.top.y) / 2
    expect(halfW / halfH).toBeCloseTo(ISO.ratio, 6)

    // ④ 中点 == 独立实测的 tableTopCenter（两条互不相关的测量互相印证）
    expect((TABLE_QUAD.top.y + TABLE_QUAD.bottom.y) / 2).toBeCloseTo(
      MEASURED.tableTopCenter.y,
      6,
    )
  })

  it('★ 卦盘必须完整落在桌面内（这次才终于成立）', () => {
    // 这是 M1 遗留的那个"卦盘探出桌面 32.8px"，根因是桌面量窄了、不是卦盘错。
    const bq = boardQuad()
    const poly = [TABLE_QUAD.top, TABLE_QUAD.right, TABLE_QUAD.bottom, TABLE_QUAD.left]
    for (const [name, p] of [
      ['上(远)', bq.top],
      ['右', bq.right],
      ['下(近)', bq.bottom],
      ['左', bq.left],
    ] as const) {
      let sawPos = false
      let sawNeg = false
      for (let i = 0; i < 4; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % 4]
        const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
        if (cr > 1e-9) sawPos = true
        if (cr < -1e-9) sawNeg = true
      }
      expect(sawPos && sawNeg, `卦盘${name}顶点探出了桌面`).toBe(false)
    }
  })
})

describe('② 渲染几何 ↔ 仪式算法（唯一的共享契约）', () => {
  it('worldLayout 的槽心与 ritualMachine.SLOT_CENTERS 一致（2px 内）', () => {
    expect(SLOT_CENTERS).toHaveLength(SLOT_COUNT)
    SLOT_CENTERS.forEach((c, i) => {
      const p = slotCenterPx(i)
      expect(Math.abs(p.x - c.x)).toBeLessThan(2)
      expect(Math.abs(p.y - c.y)).toBeLessThan(2)
    })
  })
})

describe('③ 遮挡排序（STAGE 趟）', () => {
  const order = createSceneStack().drawOrder('STAGE')
  const at = (id: string): number => order.indexOf(id)

  it('八个 STAGE 图层齐全', () => {
    expect(order).toHaveLength(9)
    for (const id of ['l4-tube', 'l4-coin-0', 'l4-coin-1', 'l4-deck', 'l4-timepiece', 'l4-memory', 'l5-plant', 'l6-board', 'l7-xiaobu']) {
      expect(order).toContain(id)
    }
  })

  it('★ 卦盘先于落在它上面的铜钱（平台取最远角这条规则的实测价值）', () => {
    // coin-1 影子 y = 476 > 盘面最远角 468.8 → 必须画在盘面之后
    expect(at('l6-board')).toBeLessThan(at('l4-coin-1'))
  })

  it('桌上的道具按"离镜头远近"排：竹筒 → 近铜钱 → 远铜钱', () => {
    expect(at('l4-tube')).toBeLessThan(at('l4-coin-0'))
    expect(at('l4-coin-0')).toBeLessThan(at('l4-coin-1'))
  })

  it('小卜守在桌缘最前，最后画（于是他挡住桌角）', () => {
    expect(at('l7-xiaobu')).toBeGreaterThan(at('l6-board'))
    expect(at('l7-xiaobu')).toBeGreaterThan(at('l4-coin-1'))
  })
})

describe('④ 三趟结构与固定层级', () => {
  const stack = createSceneStack()

  it('BACKDROP 按 L 号固定：空间 → 毛毡 → 木桌 → 角落茶几', () => {
    expect(stack.drawOrder('BACKDROP')).toEqual(['l1-space', 'l2-felt', 'l3-table', 'l4-tea-table'])
  })

  it('GRADE 固定在最后：暖纱 → 暖光暗角 → 纸张质感', () => {
    expect(stack.drawOrder('GRADE')).toEqual(['l8-warm-veil', 'l9-grade', 'l10-paper'])
  })

  it('每个注册项都有唯一且可读的 id（日志与埋点靠它定位）', () => {
    const ids = ['BACKDROP', 'STAGE', 'GRADE'].flatMap((p) => stack.drawOrder(p as 'STAGE'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^l\d+-/.test(id))).toBe(true)
  })
})

describe('⑤ 天气红线（门禁 ⑥ 的运行时锚点）', () => {
  const stack = createSceneStack()

  it('天气只能碰 L8 / L9 两个图层，别的它够不到', () => {
    const ids = stack.atmosphereTargets().map((i) => i.id)
    expect(ids).toEqual(['l8-warm-veil', 'l9-grade'])
  })

  it('L1–L7 的 band 一律不在天气白名单内', () => {
    const w = stack.atmosphereTargets().map((i) => i.band)
    expect(w).toEqual([BAND.VEIL, BAND.VIGNETTE])
    for (const t of stack.atmosphereTargets()) {
      expect(t.band).toBeGreaterThanOrEqual(BAND.VEIL)
    }
  })
})

describe('⑥ 整间屋子画一遍（冒烟 + 防崩底线）', () => {
  it('用桩上下文渲染不抛异常', () => {
    const stack = createSceneStack()
    const { ctx } = makeStubCtx()
    expect(() => stack.render(ctx, { t: 0, dt: 16, n: 1 })).not.toThrow()
  })

  it('★ 渲染的第一笔是"整块设计画布 + 奶油色" —— 绝不白屏的实弹防线', () => {
    const stack = createSceneStack()
    const { ctx, fills } = makeStubCtx()
    stack.render(ctx, { t: 0, dt: 16, n: 1 })

    expect(fills.length).toBeGreaterThan(0)
    const first = fills[0]
    expect(first.args).toEqual([0, 0, 390, 844])
    expect(first.style.toLowerCase()).toBe('#fdf9f6')
  })

  it('即使每个图层都抛异常，render 也不抛、仍然画了奶油底，并在 3 次后隔离该层', () => {
    const stack = createSceneStack()
    const { ctx, fills } = makeStubCtx()
    const ids = ['BACKDROP', 'STAGE', 'GRADE'].flatMap((p) =>
      stack.drawOrder(p as 'STAGE'),
    )
    // 让所有图层都炸
    for (const id of ids) {
      const item = stack.get(id)
      if (item) {
        item.draw = () => {
          throw new Error('boom')
        }
      }
    }

    // 故意制造异常 → 静音日志，让 CI 输出里"该红的用例"不被 stack 淹没。
    // 断言用 quarantined()，不用日志（日志只是给人看的）。
    logger.setQuiet(true)
    try {
      expect(() => stack.render(ctx, { t: 0, dt: 16, n: 1 })).not.toThrow()
      expect(fills[0].style.toLowerCase()).toBe('#fdf9f6')

      // 连续 MAX_FAILS = 3 次后全部被隔离，之后不再重试
      for (let i = 0; i < 3; i++) stack.render(ctx, { t: 0, dt: 16, n: i + 2 })
      expect(stack.quarantined().sort()).toEqual([...ids].sort())
    } finally {
      logger.setQuiet(false)
    }
  })
})

describe('⑦ 几何一致性补强', () => {
  it('quadOf 生成的盘面宽高比严格 2:1', () => {
    const q = quadOf(BOARD.u, BOARD.v, BOARD.w, BOARD.d, BOARD.z)
    const halfW = (q.right.x - q.left.x) / 2
    const halfH = (q.bottom.y - q.top.y) / 2
    expect(halfW / halfH).toBeCloseTo(2, 2)
  })

  it('竹筒底面圆心 = 竹筒外接框的下边中点', () => {
    expect(TUBE.z).toBe(1)
    expect(tubeFootPx().x).toBeCloseTo(124, 3)
    expect(tubeFootPx().y).toBeCloseTo(424, 3)
  })
})
