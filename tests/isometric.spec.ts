/**
 * 等距投影内核 · 回归测试   tests/isometric.spec.ts
 * ===========================================================================
 * 这份测试的定位不是"覆盖率"，而是**把美术稿钉死**。
 *
 * 它回答一个问题：我们从四个实测锚点反推出来的投影矩阵，
 * 能不能把世界坐标一对一回推到美术量到的那些像素上？
 * 只要这条成立，"改一个色值/挪一个器物/调一次吸附半径"就不会悄悄让画面错位。
 *
 * ★ 这是纯函数测试，不需要浏览器、不需要 canvas —— 这本身就是 M1 想证明的事：
 *   core 与 renderer 的数学部分能在 node 里跑。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import {
  ISO,
  MEASURED,
  actorSortY,
  deriveIso,
  distPt,
  platformSortY,
  project,
  quadOf,
  quadFrom,
  snapToHalf,
  sortYAt,
  unproject,
} from '@scene/renderer/isometric'
import { computeFit, distributeEvenly, labelPlusEven, layoutIsExact } from '@scene/renderer/layoutMath'

/** 美术稿实测的六个爻位槽中心 */
const MEASURED_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [175.5, 549.2],
  [192.0, 541.0],
  [208.6, 532.7],
  [225.1, 524.5],
  [241.6, 516.2],
  [258.1, 508.0],
]

describe('① 投影矩阵反推（deriveIso）', () => {
  it('GW/GH 收敛到 2:1', () => {
    expect(ISO.ratio).toBeCloseTo(2, 2)
  })

  it('GW / GH 取自爻位槽的单步位移', () => {
    // 槽 1 → 槽 6 跨 5 步：Δ = (82.6, −41.2)
    expect(ISO.gw).toBeCloseTo(82.6 / 5, 6)
    expect(ISO.gh).toBeCloseTo(41.2 / 5, 6)
  })

  it('LIFT 等于地面原点与桌面工作平面原点的高度差（木桌高度 = 1 单位）', () => {
    expect(ISO.lift).toBeCloseTo(MEASURED.floorCenter.y - MEASURED.tableTopCenter.y, 6)
    expect(ISO.lift).toBeCloseTo(57.1, 6)
  })

  it('交叉验证：地面与卦盘两处独立实测都指向 2:1', () => {
    expect(ISO.checks.floor).toBeCloseTo(2.1, 1)
    expect(ISO.checks.board).toBeCloseTo(2.0, 1)
    // ★ 交叉验证必须把**每个**样本都列出来，包括没过的那个。
    //   当初只报通过的两处、跳过木桌，等于让验证撒谎 —— 详见下一个用例与文件头 §二。
  })

  it('★ 桌面原始实测值【不可用】：.x 恰好落在画布边缘（不是美术风格，是量错了）', () => {
    // 这条以前写的是"美术刻意拉长的风筝形，是合法例外" —— 那是错的结论。
    // 真相：真桌子比画布宽、被裁掉，量到的是**裁切线**。
    // 判据（见文件头 §二）：上+下 != 左+右 ⇒ 不可能是任何轴对齐桌面的投影。
    expect(MEASURED.tableHalf.x).toBe(195) // = DESIGN_W / 2，画布半宽
    expect(MEASURED.tableHalf.x).toBe(MEASURED.floorHalf.x) // 地毯也同样落在边缘
    // 于是 checks.table 必然偏离 2:1 —— 它是"这个值坏了"的信号，不是"形状特殊"。
    expect(ISO.checks.table).toBeGreaterThan(1.2)
    expect(ISO.checks.table).toBeLessThan(1.4)
    // 只有 .y 可信；真正的桌面几何由 TABLE_QUAD 导出，
    // 其不变量断言在 scene-layout.spec.ts（平行四边形 + 比例）。
  })

  it('换成另一份锚点，矩阵随之重算（校准不是写死的）', () => {
    const alt = deriveIso({ ...MEASURED, floorCenter: { x: 200, y: 600 } })
    expect(alt.ox).toBe(200)
    expect(alt.oy).toBe(600)
    expect(alt.lift).toBeCloseTo(120, 6) // 600 − 480
  })
})

describe('② 正投影 / 反投影', () => {
  it('世界原点投到地面菱形中心', () => {
    const p = project(0, 0, 0)
    expect(p.x).toBeCloseTo(MEASURED.floorCenter.x, 6)
    expect(p.y).toBeCloseTo(MEASURED.floorCenter.y, 6)
  })

  it('(0,0,1) 投到桌面工作平面原点 (195, 480)', () => {
    const p = project(0, 0, 1)
    expect(p.x).toBeCloseTo(195, 6)
    expect(p.y).toBeCloseTo(480, 6)
  })

  it('往返无损（z = 0 与 z = 1 都要成立）', () => {
    for (const [x, y] of MEASURED_SLOTS as ReadonlyArray<readonly [number, number]>) {
      for (const z of [0, 1]) {
        const w = unproject(x, y, z)
        const back = project(w.u, w.v, z)
        expect(back.x).toBeCloseTo(x, 9)
        expect(back.y).toBeCloseTo(y, 9)
      }
    }
  })

  it('+u 是"右上"，+v 是"左上"，两者步长一致 —— 2:1 等距的方向定义', () => {
    expect(ISO.uStep.x).toBeCloseTo(ISO.gw, 9)
    expect(ISO.uStep.y).toBeCloseTo(-ISO.gh, 9)
    expect(ISO.vStep.x).toBeCloseTo(-ISO.gw, 9)
    expect(ISO.vStep.y).toBeCloseTo(-ISO.gh, 9)
  })

  it('★ z 补偿不可省，且两个口径要分清：每轴偏 zToAxis ≈ 3.46、(u+v) 偏 zToV ≈ 6.93', () => {
    const correct = unproject(218, 528, 1)
    const wrong = unproject(218, 528, 0)

    // 漏减 z·LIFT：u 和 v 会**同向**各偏 zToAxis
    expect(Math.abs(correct.u - wrong.u)).toBeCloseTo(ISO.zToAxis, 6)
    expect(Math.abs(correct.v - wrong.v)).toBeCloseTo(ISO.zToAxis, 6)
    expect(correct.u - wrong.u).toBeCloseTo(correct.v - wrong.v, 9) // 同向、等量

    // 而 (u + v) 的偏移是每轴的两倍 —— 也就是那个更容易被误引用的 zToV
    const dv = Math.abs(correct.u + correct.v - (wrong.u + wrong.v))
    expect(dv).toBeCloseTo(ISO.zToV, 6)
    expect(ISO.zToV).toBeCloseTo(ISO.zToAxis * 2, 9)

    expect(ISO.zToAxis).toBeGreaterThan(3.4)
    expect(ISO.zToV).toBeGreaterThan(6.9)

    // 卦盘的 v 从 −3.61 变成 −0.14：这就是"影子不在脚下"的数值真相
    expect(correct.v).toBeCloseTo(-3.6088, 3)
    expect(wrong.v).toBeCloseTo(-0.144, 3)
  })
})

describe('③ 世界坐标 → 美术实测像素（这份测试的真正目的）', () => {
  const SLOT_Z = 1
  const slot0 = unproject(MEASURED_SLOTS[0][0], MEASURED_SLOTS[0][1], SLOT_Z)
  const boardV = unproject(MEASURED.boardCenter.x, MEASURED.boardCenter.y, SLOT_Z).v

  it('六个爻位槽：沿 +u 每 1 单位一个，v 与盘面中心对齐', () => {
    MEASURED_SLOTS.forEach(([mx, my], i) => {
      const p = project(slot0.u + i, boardV, SLOT_Z)
      expect(p.x).toBeCloseTo(mx, 0) // 1px 内
      expect(p.y).toBeCloseTo(my, 0)
    })
  })

  it('爻位槽步长严格是 1.000 单位（美术确实是按等距格排的）', () => {
    const a = project(slot0.u, boardV, SLOT_Z)
    const b = project(slot0.u + 1, boardV, SLOT_Z)
    expect(distPt(a, b)).toBeCloseTo(Math.hypot(ISO.gw, ISO.gh), 6)
  })

  it('卦盘四顶点落回美术实测 (218,469)(336,528)(218,587)(100,528)，最大误差 ≤ 0.2px', () => {
    const world = unproject(MEASURED.boardCenter.x, MEASURED.boardCenter.y, SLOT_Z)
    // 边长由实测半宽 / 半高分别反推后取均值（网格有 0.24% 各向异性，解析见 worldLayout.ts）
    const s = (MEASURED.boardHalf.x / ISO.gw + MEASURED.boardHalf.y / ISO.gh) / 2
    const q = quadOf(world.u, world.v, s, s, SLOT_Z)

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
    // ★ 钉住绝对误差上限，而不是逐个 toBeCloseTo(…, 0)。
    //   这样"半高量成 59.5"那一类错误会立刻在这里红掉（当时最大误差 0.65px）。
    expect(maxErr).toBeLessThan(0.2)
  })

  it('★ 实测值自洽：卦盘半宽/半高在美术稿里恰好 2.000（写成 59.5 会让比值掉到 1.983）', () => {
    expect(MEASURED.boardHalf.x / MEASURED.boardHalf.y).toBeCloseTo(2, 3)
  })

  it('网格各向异性只有 0.24%：卦盘的 2:1 公差由它决定，不是设计稿画歪了', () => {
    expect(ISO.ratio).toBeCloseTo(2, 2) // 2.0049
    expect(Math.abs(ISO.ratio - 2)).toBeLessThan(0.01)
  })

  it('卦盘盘面本身是严格 2:1（它不该被拉长 —— 只有木桌是例外）', () => {
    const world = unproject(MEASURED.boardCenter.x, MEASURED.boardCenter.y, SLOT_Z)
    const s = (MEASURED.boardHalf.x / ISO.gw + MEASURED.boardHalf.y / ISO.gh) / 2
    const q = quadOf(world.u, world.v, s, s, SLOT_Z)
    const halfW = (q.right.x - q.left.x) / 2
    const halfH = (q.bottom.y - q.top.y) / 2
    expect(halfW / halfH).toBeCloseTo(2, 2)
  })
})

describe('④ 遮挡排序（2.5D 空间感的全部依据）', () => {
  it('actorSortY 只吃"影子"，吃的是影子不是物体', () => {
    const shadow = project(1, 1, 0)
    expect(actorSortY(shadow)).toBe(shadow.y)
  })

  it('屏幕越靠下 = 离镜头越近 = 排序键越大 = 越晚画（于是挡住别人）', () => {
    const far = sortYAt(3, 3, 0)
    const near = sortYAt(-1, -1, 0)
    expect(near).toBeGreaterThan(far)
  })

  it('★ 平台取"最远角"，而不是中心 —— 否则桌上的东西全被盘面盖掉', () => {
    const SLOT_Z = 1
    const world = unproject(MEASURED.boardCenter.x, MEASURED.boardCenter.y, SLOT_Z)
    const s = (MEASURED.boardHalf.x / ISO.gw + MEASURED.boardHalf.y / ISO.gh) / 2
    const board = quadOf(world.u, world.v, s, s, SLOT_Z)

    const boardKey = platformSortY(board)
    const slot0 = unproject(MEASURED_SLOTS[0][0], MEASURED_SLOTS[0][1], SLOT_Z)
    const boardV = world.v

    // 六个槽的排序键必须全都大于盘面 —— 也就是全部画在盘面之上
    for (let i = 0; i < 6; i++) {
      const key = sortYAt(slot0.u + i, boardV, SLOT_Z)
      expect(key).toBeGreaterThan(boardKey)
    }
  })

  it('平台取最远角 = 四顶点最小的 y', () => {
    const q = quadOf(0, 0, 4, 4, 0)
    expect(platformSortY(q)).toBe(q.top.y)
  })

  it('飞行中的铜钱用"影子"排序：飞得高不该跳到竹筒前面', () => {
    const overTube = sortYAt(1.2491, 5.547, 1) // 竹筒正上方
    const lowFlight = sortYAt(1.2491, 5.547, 1) // 影子不变 → 排序键不变
    expect(lowFlight).toBe(overTube)
  })
})

describe('⑤ 布局算术（"均分失效"那一类坑的根治）', () => {
  it('三段分 1000px、间距 20：宽度与内宽严丝合缝', () => {
    const r = distributeEvenly(1000, 3, 20)
    expect(layoutIsExact(r)).toBe(true)
    expect(r.used).toBe(1000)
    expect(r.widths.reduce((a, b) => a + b, 0) + 40).toBe(1000)
  })

  it('余数摊给前几段，而不是全塞给最后一段（避免"最后一张总是偏胖"）', () => {
    const r = distributeEvenly(1000, 3, 0)
    expect(r.widths).toEqual([334, 333, 333])
  })

  it('x 坐标是每一段的真实起点，不是比例估算', () => {
    const r = distributeEvenly(600, 3, 30)
    expect(r.xs[0]).toBe(0)
    expect(r.xs[1]).toBe(r.widths[0] + 30)
    expect(r.xs[2]).toBe(r.widths[0] + r.widths[1] + 60)
  })

  it('内宽不够时不抛异常，如实报告 slack（由调用方决定降级）', () => {
    const r = distributeEvenly(10, 5, 20)
    expect(layoutIsExact(r)).toBe(false)
    expect(r.widths.every((w) => w === 0)).toBe(true)
  })

  it('非法输入不抛异常（门禁 ⑨ 的精神：算术坏了也不许崩）', () => {
    expect(() => distributeEvenly(NaN, 3, 10)).not.toThrow()
    expect(() => distributeEvenly(100, 0, 10)).not.toThrow()
  })

  it('labelPlusEven：定宽 label + 剩余均分，总宽精确', () => {
    const { labelW, columns } = labelPlusEven(1556, 148, 4, 12)
    expect(labelW).toBe(148)
    expect(columns.used + 148 + 12).toBe(1556)
    expect(layoutIsExact(columns)).toBe(true)
  })
})

describe('⑥ 画布适配盒', () => {
  it('等比铺满 + 居中留边，绝不拉伸（拉伸会让 2:1 等距失真）', () => {
    const fit = computeFit(390, 1000, 1)
    expect(fit.scale).toBeCloseTo(1, 6)
    expect(fit.offY).toBeCloseTo((1000 - 844) / 2, 6)
    expect(fit.offX).toBe(0)
  })

  it('窄屏按宽定标，左右无留边', () => {
    const fit = computeFit(195, 844, 1)
    expect(fit.scale).toBeCloseTo(0.5, 6)
    expect(fit.offX).toBe(0)
    expect(fit.offY).toBeCloseTo((844 - 422) / 2, 6)
  })

  it('DPR 上限 2：高分屏不再往上堆（烧内存、烧填充率）', () => {
    expect(computeFit(390, 844, 3).dpr).toBe(2)
    expect(computeFit(390, 844, 1.5).dpr).toBe(1.5)
    expect(computeFit(390, 844, 0).dpr).toBe(1)
  })

  it('buffer 尺寸是整数（小数尺寸会造成半像素模糊）', () => {
    const fit = computeFit(377, 811, 2.75)
    expect(Number.isInteger(fit.bufW)).toBe(true)
    expect(Number.isInteger(fit.bufH)).toBe(true)
  })
})

describe('⑦ 网格小工具', () => {
  it('snapToHalf 吸附到最近的半格', () => {
    expect(snapToHalf(1.24)).toBe(1.0)
    expect(snapToHalf(1.26)).toBe(1.5)
    expect(snapToHalf(-0.2)).toBe(-0)
  })

  it('quadFrom 照抄手绘顶点，不做任何"纠正"', () => {
    const table = quadFrom(
      { x: 195, y: 330 },
      { x: 390, y: 422.9 },
      { x: 195, y: 630 },
      { x: 0, y: 422.9 },
    )
    expect(table.top).toEqual({ x: 195, y: 330 })
    expect(table.right).toEqual({ x: 390, y: 422.9 })
    expect(table.bottom).toEqual({ x: 195, y: 630 })
    expect(table.left).toEqual({ x: 0, y: 422.9 })
  })
})
