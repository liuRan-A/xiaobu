/**
 * 小卜 · 场景世界布局   src/scene/layers/worldLayout.ts
 * ===========================================================================
 * 这里是"东西摆在哪"的唯一真源。两个原则：
 *
 *   ① **凡是有像素实测值的东西，从像素反推世界坐标**，而不是手抄小数。
 *      比如竹筒：美术给了底心 (124, 424)，那就 unproject(124, 424, z=1)，
 *      代码里永远看不到 1.2492 / 5.5470 这种数 —— 换美术稿时只改像素。
 *   ② **凡是有网格语义的东西，用网格坐标**。六爻位槽是"沿 +u 每 1 单位一个"，
 *      这是设计意图；用 unproject 反推只是为了让它们落在美术稿的位置上。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 桌面的尺寸是怎么定下来的（曾经定错过，留档）
 * ───────────────────────────────────────────────────────────────────────────
 * 早期版本把桌面四顶点"照抄美术实测"，结果是一张**风筝形**，并把它当成美术取舍。
 * 后来证明那是**测量错误**：左右顶点量在了画布边缘（x=0 / x=390），
 * 真桌子比画布宽、被裁掉了，量到的其实是裁切线（详见 renderer/isometric.ts §二）。
 *
 * 现在：桌面是**网格上的正方形**，由"可信的上下顶点 + 中心 x + 网格比例"导出。
 * 判据（两个都必须满足）：
 *   ① 上 + 下 == 左 + 右（平行四边形恒等式）
 *   ② 半宽 / 半高 == ISO.ratio
 * 这两条现在由 `npm run check:art`（门禁⑫）自动守着，不用再靠人眼。
 * ===========================================================================
 */

import {
  ISO,
  MEASURED,
  quadFrom,
  quadOf,
  platformSortY,
  project,
  sortYAt,
  unproject,
  type Quad,
  type Vec2,
} from '@scene/renderer'

// ───────────────────────────────────────────────────────────────────────────
// 平面高度
// ───────────────────────────────────────────────────────────────────────────

/** 木桌顶面所在的世界高度。1 单位 = ISO.lift = 57.1px。 */
export const TABLE_Z = 1

/** 地板/地毯所在的世界高度 */
export const FLOOR_Z = 0

// ───────────────────────────────────────────────────────────────────────────
// 木桌（网格正方形 —— 由可信锚点 + 网格比例导出，见上方注释）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 桌身厚度（左右两侧受光面的下沿外扩像素）。
 * 对照设计稿目测约 34px —— 太薄会读成"一块纸板"，太厚会把桌面顶起。
 */
export const TABLE_APRON = 34

/**
 * 木桌顶面四顶点。
 *
 * ⚠⚠ 这组值曾经是"照抄美术实测"，**是错的**，2026-10-09 已定位并留档。
 *
 * 【怎么发现的】等距 2.5D 有一条硬约束：**任何轴对齐的刚体平面，投影出来必然是
 *   平行四边形**，且半宽/半高必须 = GW/GH（≈2.0049）。拿旧值一验：
 *       上 + 下 = (390, 960)   左 + 右 = (390, 845.8)   ← y 差 114.2px
 *   不是平行四边形 ⇒ 这四点不可能来自任何真实的桌面几何 ⇒ 一定是量错了。
 *   而且 y 差 114.2 = 2 × LIFT（57.1）—— 左右顶点整体"高了恰好 1 个桌高"。
 *
 * 【错在哪】旧值左右顶点在 x = 0 / x = 390，**恰好是画布左右边缘**。
 *   真桌子比画布宽，视觉上被裁掉了，量到的是"裁切线"而不是桌角。
 *   于是半宽被低估了 105.7px/侧（195 → 应为 300.7），后果是：
 *       · 卦盘看起来探出桌面右缘 32.8px（所有人以为是卦盘写错了）
 *       · 摆件与影子的落点也跟着偏
 *
 * 【为什么能确定是"左右"错、不是"上下"错】
 *   ① 上/下顶点的中点是 y = 480，而**独立实测**的 tableTopCenter.y 也是 480
 *      —— 两条互不相关的测量互相印证，说明竖直方向是对的。
 *      顺带一提 LIFT = floorCenter.y − tableTopCenter.y 就是靠这条推出来的。
 *   ② left.x / right.x 落在画布边缘这件事本身不携带任何艺术信息。
 *   所以修法是：**钉住可信的上下顶点 + 中心 x，半宽由网格比例反推**。
 *
 * 【现在的取值】半高 150 → 半宽 = 150 × ISO.ratio = 300.73。
 *   桌面横跨 x ∈ [−105.7, 495.7]（比画布宽，会被裁 —— 这是正常的）。
 *
 * ★ 下次再出现这类问题，不用手工推：跑 `npm run check:art`（门禁⑫）。
 *   它会把每个平面的"像素长宽比 vs 网格比例"列出来，并检查平行四边形恒等式。
 */
const TABLE_CX = MEASURED.tableTopCenter.x // 195 —— 可信（两条独立测量印证）
const TABLE_CY = MEASURED.tableTopCenter.y // 480
const TABLE_HALF_H = MEASURED.tableHalf.y // 150 —— 可信（上 330 / 下 630）
/** ★ MEASURED.tableHalf.x（195）不可信，故不使用；半宽由半高 × 网格比例反推 */
const TABLE_HALF_W = TABLE_HALF_H * ISO.ratio

export const TABLE_QUAD: Quad = quadFrom(
  { x: TABLE_CX, y: TABLE_CY - TABLE_HALF_H }, // 上（最远角）
  { x: TABLE_CX + TABLE_HALF_W, y: TABLE_CY }, // 右
  { x: TABLE_CX, y: TABLE_CY + TABLE_HALF_H }, // 下（最近角）
  { x: TABLE_CX - TABLE_HALF_W, y: TABLE_CY }, // 左
)

// ───────────────────────────────────────────────────────────────────────────
// 卦盘与六爻位槽
// ───────────────────────────────────────────────────────────────────────────

/**
 * 卦盘：中心由实测像素反推；边长由实测半宽 / 半高两个方向反解后取均值。
 *
 * 两次反解本应同解 —— 美术稿的卦盘在**像素上是严格 2:1 的**（半宽 118 / 半高 59
 * = 2.0000），但我们标定出的网格是 2.0049（等距网格本身有 0.24% 的各向异性，
 * 见 isometric.ts §一·①），所以两个方向解出的 S 天然差 0.24%：
 *      从半宽： 118 / 16.52 = 7.143
 *      从半高：  59 /  8.24 = 7.160
 * 取均值把这点各向异性对半摊给两个方向，四个顶点的最大误差 0.14px —— 这是
 * 在"网格各向异性"这个前提下的最优解，也是本文件唯一一处允许"取均值"的地方。
 *
 * ★ 取均值的前提是两次测量都可信。这里踩过一次坑：半高曾被量成 59.5，
 *   两个 S 差到 1.1%，取均值后把左右顶点各推偏 0.65px（左右顶点离中心最远，
 *   误差是放大的）。修复方式不是改算法，而是把测量值改对 ——
 *   并由 tests 的"卦盘四顶点落回实测"用例长期钉住。
 */
const BOARD_S_FROM_W = MEASURED.boardHalf.x / ISO.gw // 118 / 16.52 = 7.143
const BOARD_S_FROM_H = MEASURED.boardHalf.y / ISO.gh // 59 / 8.24 = 7.160

export const BOARD: Readonly<{ u: number; v: number; w: number; d: number; z: number }> = (() => {
  const c = unproject(MEASURED.boardCenter.x, MEASURED.boardCenter.y, TABLE_Z)
  const s = (BOARD_S_FROM_W + BOARD_S_FROM_H) / 2
  return Object.freeze({ u: c.u, v: c.v, w: s, d: s, z: TABLE_Z })
})()

/** 卦盘四顶点（严格 2:1，走网格 —— 它是矩形平面，没有理由手绘） */
export function boardQuad(): Quad {
  return quadOf(BOARD.u, BOARD.v, BOARD.w, BOARD.d, BOARD.z)
}

/**
 * ★ 卦盘的**命中椭圆**（设计 pt）。
 *
 * 掷币的"有没有落盘"、落点预示环、涟漪的形状全都用它。它与 `boardQuad()` 不是同一件东西：
 *   · `boardQuad()` 是**画出来的木板**（网格投影，严格 2:1，四个顶点）；
 *   · `BOARD_ELLIPSE` 是**玩法判定域**，取美术实测的半宽 / 半高（118 × 59）。
 *
 * ★ 为什么判定用椭圆而不是那块矩形板：
 *   规范 §10 有一条硬验收 ——「卦盘命中判定是椭圆，不是矩形（四角应判为未命中）」。
 *   用外接矩形的话，四个角上明明落在木桌上的位置会被判成"落盘了"，
 *   用户看到币掉在盘外却被告知落进了盘里 —— 这是**手感层面最难解释的一种不一致**。
 *
 * ★ 数值直接取 `MEASURED`，不手抄：美术稿一改，画出来的板和判定域一起动。
 *   `tests/flight.spec.ts` 里那条写死的 BOARD 就是这三个数，
 *   所以"判定域与美术稿脱节"会立刻红。
 */
export const BOARD_ELLIPSE = Object.freeze({
  cx: MEASURED.boardCenter.x,
  cy: MEASURED.boardCenter.y,
  rx: MEASURED.boardHalf.x,
  ry: MEASURED.boardHalf.y,
})

/**
 * ★ 六爻位槽：**沿 +u 每 1 单位一个，v 与盘面中心严格对齐**。
 *   设计意图本身就是这样（"一排等距的槽"），实测值恰好验证了这一点：
 *   六个槽的实测 v 全部 ≈ −3.6088，与盘面中心 v 只差 0.0001。
 *   实测步长 1.000002 单位 —— 也就是美术在画的时候确实是按等距格排的。
 */
export const SLOT_COUNT = MEASURED.slotCount
export const SLOT_DU = 1
export const SLOT_V = BOARD.v
const SLOT_DERIVED = unproject(MEASURED.slotFirst.x, MEASURED.slotFirst.y, TABLE_Z)
export const SLOT_U0 = SLOT_DERIVED.u

/** 第 i 个爻位槽的世界 u */
export function slotU(i: number): number {
  return SLOT_U0 + i * SLOT_DU
}

/** 第 i 个爻位槽的中心（设计像素） —— M2 的吸附判定就是拿它比距离 */
export function slotCenterPx(i: number): Vec2 {
  return project(slotU(i), SLOT_V, TABLE_Z)
}

/** 全部六个槽心（顺序 = 从近到远，也是本卦从初爻到上爻的顺序） */
export function slotCentersPx(): Vec2[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => slotCenterPx(i))
}

/** 爻位槽的网格尺寸：1 × 1 单位 */
export const SLOT_SIZE = { u: 1, d: 1 }

// ───────────────────────────────────────────────────────────────────────────
// 竹筒
// ───────────────────────────────────────────────────────────────────────────

/** 美术实测的竹筒外接框（含筒口） */
export const TUBE_PX = { x: 102, y: 374, w: 44, h: 50 }

/**
 * 竹筒筒身高度（不含筒口椭圆）。
 * ★ 定义放在这里而不是 L4Props：筒口的屏幕位置 = 底心往上这么多，
 *   而"筒口在哪"是**玩法要用**的（反悔判定以它为圆心、补币从它滚出来），
 *   不只是画图用的。两边各写一份 42 的话，改一次美术稿就会错位 —— 而且是
 *   那种"画面上对得上、判定却在旁边"的错位，肉眼极难发现。
 */
export const TUBE_BARREL_H_PX = 42

/** 竹筒口中心（设计 pt）—— 反悔半径的圆心、补币动画的起点 */
export const TUBE_MOUTH_PX = Object.freeze({
  x: TUBE_PX.x + TUBE_PX.w / 2,
  y: TUBE_PX.y + TUBE_PX.h - TUBE_BARREL_H_PX,
})

/** 竹筒底面圆心（世界）—— 由底心像素反推 */
export const TUBE = (() => {
  const c = unproject(TUBE_PX.x + TUBE_PX.w / 2, TUBE_PX.y + TUBE_PX.h, TABLE_Z)
  return Object.freeze({ u: c.u, v: c.v, z: TABLE_Z })
})()

/** 竹筒在桌面上的影子（接触点） */
export function tubeFootPx(): Vec2 {
  return project(TUBE.u, TUBE.v, TABLE_Z)
}

// ───────────────────────────────────────────────────────────────────────────
// 铜钱
// ───────────────────────────────────────────────────────────────────────────

/** 一枚铜钱躺平时的外径（设计像素）—— 等距下是 2:1 的椭圆：rx = r，ry = r / 2 */
export const COIN_RADIUS = 11
export const COIN_VISUAL_RY = COIN_RADIUS / 2

/**
 * 待机时躺在桌面上的两枚铜钱（第三枚在竹筒里 —— 桌面上永远刚好三枚）。
 * ★ 位置从美术实测像素反推，与竹筒、卦盘共用同一套表平面。
 */
export const COIN_IDLE_PX: readonly Vec2[] = Object.freeze([
  { x: 196, y: 452 },
  { x: 232, y: 476 },
])

export const COINS_IDLE = COIN_IDLE_PX.map((p) => unproject(p.x, p.y, TABLE_Z))

// ───────────────────────────────────────────────────────────────────────────
// 场景陈设（纯像素铺陈，不参与网格 —— 它们是"布景"，不是"玩法物件"）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 墙与地板的分界（踢脚线）。
 *
 * ★ 这个值必须**高于木桌的远角**（TABLE_QUAD.top.y = 330），否则桌子的后角
 *   会扎进墙里 —— 视觉上就是"桌子悬在墙上"，整个空间立刻失效。
 *   设计稿实测交界线约在 y ≈ 250，这里取 248 留 82px 余量。
 *   曾误写成 340（比桌角低 10px），出图后一眼就是"桌子浮着"。
 */
export const WALL_BASE_Y = 248

/**
 * 地板上那道"等距光毯"的半径（世界单位）。
 * 与 FELT 毛毡是两件东西：光毯是地面受光形成的一圈亮，质地极淡，
 * 它让地板读起来是"一个平面"而不是一条渐变色带。
 */
export const FLOOR_SHEEN_UNITS = 11.4

/** 暖窗：房间里唯一的光源 */
export const WINDOW_PX = { x: 32, y: 42, w: 154, h: 172 }
/** 窗玻璃的分带：上段是暮色天光，下段是落日带 */
export const WINDOW_SPLIT = 0.62

/** 壁灯（补充光源，避免右侧死黑） */
export const LAMP_PX = { x: 330, y: 150, r: 17 }

/**
 * 毛毡地毯：椭圆 + 同心环 + 绒点。
 * ★ 尺寸对照设计稿：它几乎铺满整个可见地面并**在画面下沿之外继续延伸**，
 *   所以 cy + ry 会大于设计高度 844 —— 这是对的，不是越界。
 *   早先 ry = 128 太扁，读出来像"地上摊了一张纸"。
 */
export const FELT = { cx: 195, cy: 700, rx: 190, ry: 182, rings: 3, tufts: 36 }

/** 窗边小盆栽（坐在桌面右后角） */
export const PLANT_PX = { cx: 330, baseY: 468, potW: 36, potH: 44 }

/** 小卜：白色猫形灵兽，守在桌面左缘外 */
export const XIAOBU_PX = { cx: 54, baseY: 528, w: 40, h: 78 }

/**
 * 塔罗牌堆（一叠牌）落点。★ M3 混合渲染：这是**程序化骨架**，卡背贴图到位后
 * 只替换顶面绘制，几何与命中不变。落在茶几锚点（TEA_TABLE = {195, 738}）上，
 * 属于"地毯上的纯像素布景"，排序键直接用底座 y（同 plant / xiaobu）。
 *
 * 尺寸：塔罗牌竖版 2:3，这里取 52×72（略小于真人比例，是"玩具盒"的微缩感）。
 */
export const DECK_PX = Object.freeze({
  cx: 195,
  baseY: 738,
  w: 52,
  h: 72,
})

/**
 * 角落茶几（M3 第二步 · 程序化骨架）。
 *
 * ★ 它是塔罗区的**承载物**：牌堆就铺在它顶面上（`DECK_PX` 与它中心重合）。
 *   与中央木桌是两类东西 —— 木桌是"竹案"（六爻区），茶几是"牌桌"（塔罗区），
 *   更小、更矮、更圆，读作"摆在角落的小圆几"。
 *
 * ★ 落在地毯上（FELT 覆盖 y 518–882，茶几 baseY 738 在范围内），
 *   纯像素布景，用 `BAND.TABLE` 进 BACKDROP（在牌堆/铜钱之前画）。
 *
 * 尺寸：小圆几，桌面直径约 84px，矮脚。
 * ★ 桌面是"躺平的圆"，投影到 2:1 等距下必然是**椭圆**：
 *   椭圆宽 = topW（84），椭圆半高 = topW/4（21）—— 与木桌 / 卦盘同一套等距比例，
 *   这样它才和周围的刚体平面站在同一个视角里（旧值 40 会画成近乎正圆，穿帮）。
 */
export const TEA_TABLE_PX = Object.freeze({
  cx: 195,
  baseY: 738,
  topW: 84, // 桌面直径（椭圆宽）
  topH: 21, // 桌面椭圆半高（等距 2:1 = topW/4）
  legH: 26, // 桌腿高度
})

/**
 * 沙漏摆件（M3 第三步 · 程序化骨架）。
 *
 * ★ 它是**倒计时**的可视化：`countdownOrnaments` 每个元素画一个沙漏，
 *   位置由倒计时的 `at`（锚点坐标）决定 —— 所以沙漏没有固定坐标，
 *   尺寸是"单个沙漏画多大"的模板。★ 沙流走**程序化粒子**，绝不逐帧位图（OOM 红线）。
 *
 * 尺寸：竖长玻璃沙漏，总高约 56px，上下两球 + 中腰。
 */
export const HOURGLASS_PX = Object.freeze({
  w: 26, // 玻璃球最大宽度
  h: 56, // 总高
  waist: 6, // 中腰宽度
})

// ───────────────────────────────────────────────────────────────────────────
// 遮挡排序键（LayerStack 只用这些，别在 painter 里临时算）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 桌面上物件的影子 y。注意 z 传 TABLE_Z —— 这是"把高度补掉"的落点，
 *   漏了它，桌上所有物件都会被排到桌子后面去。
 */
export function tableTopSortY(u: number, v: number): number {
  return sortYAt(u, v, TABLE_Z)
}

export const SORT = {
  /** 木桌（BACKDROP 内的固定层，给出来只是为了让"平台取最远角"这条规则可读） */
  table: platformSortY(TABLE_QUAD),
  /** 卦盘：平台 → 取最远角，保证所有铜钱都排在它之后 */
  board: platformSortY(boardQuad()),
  /** 竹筒：按它在桌面上的影子 */
  tube: tableTopSortY(TUBE.u, TUBE.v),
  /** 待机铜钱 */
  coins: COINS_IDLE.map((c) => tableTopSortY(c.u, c.v)),
  /** 盆栽（纯像素布景，用底座 y） */
  plant: PLANT_PX.baseY,
  /** 小卜（纯像素布景，用脚底 y） */
  xiaobu: XIAOBU_PX.baseY,
  /** 塔罗牌堆（纯像素布景，落在茶几上，用底座 y） */
  deck: DECK_PX.baseY,
} as const

/** 第 i 个爻位槽的排序键 —— M2 落位铜钱用 */
export function slotSortY(i: number): number {
  return tableTopSortY(slotU(i), SLOT_V)
}
