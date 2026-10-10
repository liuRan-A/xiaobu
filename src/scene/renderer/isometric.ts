/**
 * 小卜 · 等距 2.5D 投影内核   src/scene/renderer/isometric.ts
 * ===========================================================================
 * ★ 纯函数、零依赖、不碰 DOM —— 因此能在 node 里直接单测（tests/isometric.spec.ts）。
 *   这是 M1 敢说"core 与 renderer 都能脱离浏览器验证"的底气。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 一、从设计稿四点反推投影矩阵（这一段是本文档存在的理由）
 * ───────────────────────────────────────────────────────────────────────────
 * 设计基准坐标系 390 × 844（美术稿的绝对像素）。实测锚点：
 *
 *   A  地面菱形中心   (195, 537.1)   ← 定义为世界原点 (0, 0, 0)
 *   B  木桌顶面中心   (195, 480.0)   ← 桌面即 z = 1 平面
 *   C  卦盘菱形中心   (218, 528.0)   ← 落在桌面上（z = 1）
 *   D  竹筒底心       (124, 424.0)   ← 落在桌面上（z = 1）
 *
 * 目标投影式（2:1 等距，屏幕 y 轴向下）：
 *
 *     x = ox + (u − v) · GW
 *     y = oy − (u + v) · GH − z · LIFT
 *
 * ① 求 GW / GH —— 用"六爻位槽"这组最硬的数据（6 个槽等距排布，误差最小）：
 *      槽 1 (175.5, 549.2) → 槽 6 (258.1, 508.0)，跨 5 步
 *      Δ = (82.6, −41.2)  →  单步 (16.52, −8.24)
 *      ⇒ GW = 16.52   GH = 8.24
 *      ⇒ GW / GH = 2.004  —— 2:1 成立，脚本可用
 *
 * ② 交叉验证（两处独立数据必须同解，否则说明设计稿画歪了）：
 *      地面菱形  半宽 195 / 半高  92.9  → 2.099   ← 软边手绘地毯，容忍 4.7%
 *      卦盘菱形  半宽 118 / 半高  59    → 2.000   ← 上下顶点实测 469 / 587，半高正好 59
 *    两次都落在 2:1 ±5% 内 ⇒ GW/GH 可信。
 *    反过来用 GW/GH 解尺寸：卦盘 = 7.15 × 7.15 单位，地面 ≈ 11.8 × 11.8 单位，
 *    与实测像素一一对得上（见 §四的回归数据）。
 *
 *    ★ 第三个被量到的平面是**木桌**，而它**没通过**这条验证（1.300 —— 离 2.0049 太远）。
 *      当时的处理是"跳过它、只报通过的两个"，这是错的：跳过失败样本等于让验证撒谎。
 *      真相是桌面的左右顶点量在了**画布边缘**（x=0 / 390），量到的是裁切线而不是桌角；
 *      桌面上那个"卦盘探出桌面"的怪现象，根源就在这里，而不是卦盘。
 *      结论：**交叉验证必须把每个样本都列出来，包括没过的**。
 *      这条现在由 `npm run check:art` / 门禁⑫ 守着 —— 见本文件 §四 与 worldLayout.ts。
 *
 *    ★ 一个吃过亏的细节：`boardHalf.y` 曾被量成 59.5（真值 59）。
 *      误差只有 0.5px，肉眼完全看不出，但它让"半宽/半高"从 2.000 掉到 1.983，
 *      于是"两个方向反解出的 S"开始打架，代码取均值后把卦盘左右两个顶点
 *      各推偏 0.65px —— 而左右顶点离中心最远，误差是**放大**的。
 *      结论：**同一物理量的两次测量取均值，只在两次都可信时成立；
 *      任何一方量错，均值会把两边一起带偏。** 所以 §四必须有一条顶点回归测试钉住它。
 *
 * ③ 求 OY 与 LIFT：
 *      OY   = A.y = 537.1（地面原点）
 *      LIFT = A.y − B.y = 57.1 px / 单位高度  ⇒  木桌高度 = 1 单位
 *    LIFT 是把"高度"从"平面位移"里拆出来的唯一参数。没有它，桌面上的东西会被
 *    当成"更靠近镜头"，遮挡关系就全乱了。
 *
 * ④ 反求世界坐标（把美术量到的像素喂回网格）：
 *      du = (x − ox) / GW = u − v
 *      dv = (oy − y − z·LIFT) / GH = u + v        ← 注意先把高度补掉
 *      ⇒ u = (du + dv) / 2        v = (dv − du) / 2
 *    ★ 这个 z 补偿是本文档最容易写错的一行，而且有**两种口径**，别混：
 *        · (u + v) 偏移  = LIFT / GH        ≈ 6.93 单位   ← 变量是 u+v，不是 u 或 v
 *        · u、v 各偏移    = LIFT / (2·GH)    ≈ 3.46 单位   ← 那个 /2 来自上面的 /2
 *      漏掉 z·LIFT 的后果：桌面上所有东西的 u、v 各偏 3.46 个单位
 *      （卦盘的 v 从 −3.61 变成 −0.14），表现为"影子不在脚下"。
 *      写代码时请用 ISO.zToAxis 而不是 ISO.zToV —— zToV 只是给调试读数用的。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 二、手绘四边形（quadFrom）与它踩过的那个坑
 * ───────────────────────────────────────────────────────────────────────────
 * 数学事实：**任何**矩形平面在等距投影下都是 2:1 的菱形，比例由 GW/GH 唯一决定，
 * 与矩形的长宽比无关。想让桌面"看起来更深"，换比例是没用的 ——
 * 想要更深的桌面，只能把桌子做大（菱形跟着变大），形状不变。
 *
 * 所以下面这条判据是**零成本的**，请对每一个实测平面都跑一遍：
 *     ① 平行四边形恒等式：上 + 下 == 左 + 右（向量和）
 *     ② 半宽 / 半高 == GW/GH
 * 两条都不满足的四边形，**不可能是任何轴对齐平面的投影** —— 它是错的，不是"风格"。
 *
 * ⚠ 这一段以前写的是反面结论，留档免得重犯：
 *   桌面四顶点曾经是"照抄美术实测"的
 *         左 (0, 422.9)  上 (195, 330)  右 (390, 422.9)  下 (195, 630)
 *   当时发现它"两条对角线中点不重合"（横对角线中点 y=422.9、纵对角线中点 y=480），
 *   于是把它解释成**美术刻意拉长的风筝形**，还写了"上半 2:1、下半拉长"的合理性说明。
 *   **那是错的。** 真相是左右顶点量在了**画布边缘**（x=0 / x=390）——
 *   真桌子比画布宽，视觉上被裁掉了，量到的是裁切线而不是桌角。
 *   验一下就知道：上+下 = (390, 960)，左+右 = (390, 845.8)，y 差 114.2px = 恰好 2×LIFT。
 *
 *   错误代价（很有代表性）：症状是"**卦盘探出了桌面**"，
 *   于是大家去查卦盘尺寸、查 boardHalf、查 z 补偿 —— 全查错了地方。
 *   真正的根因是一组实测像素，而它没有任何一条断言在守。
 *
 *   教训：**"不符合等距"的第一嫌疑人永远是"测量错了"，不是"美术风格如此"。**
 *   要确认是风格，得有人能在美术稿上指出那条被拉长的边；
 *   指不出来，就是量错了。现在这条由 `npm run check:art` / 门禁⑫ 守着。
 *
 * 三个构造函数的分工（仍然成立）：
 *   · `quadOf()`    —— 网格平面（卦盘、桌面、地面）。数学上严格 2:1。
 *   · `quadFrom()`  —— 手绘四边形。**只在美术确实手绘、且你能指出理由时**使用。
 *   · `stylizedDiamond()` —— 对称但比例自定义的手绘菱形（备用）。
 *
 * ── 一个必须交代清楚的细节：桌面的"工作平面"在哪 ──────────────────────────
 * 道具（竹筒 / 铜钱 / 卦盘）要落在桌面上，就必须有一个明确的平面原点。
 * 我们取**顶面纵对角线的中点 (195, 480)** 作为 z = 1 平面的原点，理由是它是
 * 桌面的视觉中心，而不是那个不对中的几何重心 (195, 451.45)。
 * ★ 注意：这个中点正好等于 MEASURED.tableTopCenter.y，
 *   也就是 LIFT 的来源 —— 换句话说，桌面的竖直位置被两条独立测量互相印证过；
 *   当年量错的是**水平**那一维（左右顶点），不是竖直。
 *
 * 于是 LIFT = 537.1 − 480 = 57.1 px。这个值同时是"木桌高度"这一世界概念的定义。
 * 校验（全部落在美术稿实测像素上，误差 < 1px）：
 *   卦盘中心 (218, 528) → u = −2.2165, v = −3.6088
 *   槽 1     (175.5, 549.2) → u = −4.7892
 *   槽 6     (258.1, 508.0) → u = +0.2108   （与槽 1 相差整整 5.000 单位 ✓）
 *   竹筒底心 (124, 424) → u = 1.2492, v = 5.5470
 * 且桌面上所有物件的屏幕范围都落在桌面之内 ⇒ 视觉上"就摆在桌上"。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 三、单位与阈值的口径（M2 会用到，先在此定死）
 * ───────────────────────────────────────────────────────────────────────────
 *   · 距离阈值（SNAP_RADIUS_PT = 28pt 等）**一律是设计像素**，不是世界单位。
 *     命中判定一律在 `project()` 之后的屏幕空间做 —— 这样"28pt"对用户是同一
 *     个手感，与物体在场景里的网格尺寸无关。
 *   · 网格单位 → 像素：横向 1 单位 = unitW = 33.04 px，纵向 1 单位 = unitH = 16.48 px。
 *   · 世界单位 → 高度像素：1 单位 = LIFT = 57.1 px。
 * ===========================================================================
 */

export interface Vec2 {
  x: number
  y: number
}

/** 设计基准分辨率（美术稿尺寸）。所有 draw 函数都在这个坐标系里作画。 */
export const DESIGN_W = 390
export const DESIGN_H = 844

// ───────────────────────────────────────────────────────────────────────────
// 一、实测锚点（改美术稿 → 只改这里，整个世界自动重新校准）
// ───────────────────────────────────────────────────────────────────────────

export interface MeasuredAnchors {
  /** A · 地面菱形中心 → 世界原点 (0,0,0) */
  floorCenter: Vec2
  /**
   * B · 桌面工作平面原点 → 世界 (0,0,1)。
   * ★ 取顶面**纵对角线的中点** (195, 480)，不是几何重心 (195, 451.45)。
   *   LIFT = floorCenter.y − 本值 = 57.1px，即"木桌高度"这一世界概念的定义。
   */
  tableTopCenter: Vec2
  /** C · 卦盘菱形中心（在桌面上） */
  boardCenter: Vec2
  /**
   * C · 卦盘菱形半宽 / 半高 —— 用于交叉验证 2:1。
   * ★ (118, 59)：上下顶点实测 469 / 587 ⇒ 半高正好 59，比值 2.0000（严格 2:1）。
   *   曾误记为 59.5（比值掉到 1.983），详见文件头 §一·② 的复盘。
   */
  boardHalf: Vec2
  /** A · 地面菱形半宽 / 半高 */
  floorHalf: Vec2
  /**
   * 木桌顶面半宽 / 半高。
   * ⚠ **.x 不可用于标定**：它恰好等于画布半宽，说明量到的是裁切线而非桌角。
   *   只有 .y（150，由上 330 / 下 630 得到）是可信的。
   *   需要桌面尺寸时用 .y × ISO.ratio，不要读 .x。详见文件头 §二。
   *   本字段只把这份"已知不可用"记进 checks 供人核对，绝不参与 GW/GH 推导。
   */
  tableHalf: Vec2
  /** D · 竹筒底心（在桌面上） */
  tubeBase: Vec2
  /** 爻位槽首 / 末中心 —— GW/GH 的唯一来源 */
  slotFirst: Vec2
  slotLast: Vec2
  slotCount: number
}

export const MEASURED: Readonly<MeasuredAnchors> = Object.freeze({
  floorCenter: { x: 195, y: 537.1 },
  tableTopCenter: { x: 195, y: 480.0 },
  boardCenter: { x: 218, y: 528.0 },
  boardHalf: { x: 118, y: 59 },
  floorHalf: { x: 195, y: 92.9 },
  /**
   * ⚠ 桌面半宽 .x（195）**不可用于标定** —— 它恰好等于画布半宽，
   *   说明量的是"被画布裁掉的边"而不是桌角。详见 §一·② 与 worldLayout.ts。
   *   .y（150）是可信的（上 330 / 下 630，且中点被 tableTopCenter 独立印证）。
   *   需要桌面的可用尺寸时，请用半高 × ISO.ratio，**不要**直接读 .x。
   */
  tableHalf: { x: 195, y: 150 },
  tubeBase: { x: 124, y: 424.0 },
  slotFirst: { x: 175.5, y: 549.2 },
  slotLast: { x: 258.1, y: 508.0 },
  slotCount: 6,
})

// ───────────────────────────────────────────────────────────────────────────
// 二、推导出的投影矩阵
// ───────────────────────────────────────────────────────────────────────────

export interface IsoCalibration {
  /** 世界原点的屏幕 x（= 地面菱形中心 x） */
  ox: number
  /** 世界原点的屏幕 y（= 地面菱形中心 y） */
  oy: number
  /** 每单位 u / v 的屏幕 x 分量 */
  gw: number
  /** 每单位 u / v 的屏幕 y 分量 */
  gh: number
  /** 每单位 z（高度）的屏幕 y 抬升，px */
  lift: number
  /** gw / gh —— 必须 ≈ 2，否则不是 2:1 等距 */
  ratio: number
  /** 沿 +u 走一格的屏幕位移（向右上） */
  uStep: Vec2
  /** 沿 +v 走一格的屏幕位移（向左上） */
  vStep: Vec2
  /** 一个 1×1 单位地面格的像素尺寸（等距菱形：宽 2·gw，高 2·gh） */
  unitW: number
  unitH: number
  /** 交叉验证：三处实测菱形的宽高比，应都收敛到 2 */
  checks: { floor: number; board: number; table: number }
  /**
   * ★ 反求世界坐标时 z 的补偿强度。两个口径，务必别混（文件头 §一·④）：
   *   · zToV    = lift / gh      —— 每单位 z 让 **(u + v)** 变化多少单位
   *                                 （等价于屏幕 y 抬升 lift px）
   *   · zToAxis = lift / (2·gh)  —— 每单位 z 让 **u 与 v 各自** 变化多少单位（同向）
   *   那个 2 来自 unproject 里的 `(du + dv)/2`、`(dv − du)/2`。
   *   本项目：zToV ≈ 6.93，zToAxis ≈ 3.46。想让"漏减 z 会偏多少"的断言/日志
   *   读数正确，用 zToAxis；zToV 只适合描述整体沿对角线的滑动量。
   */
  zToV: number
  zToAxis: number
}

/**
 * ★ 反推投影矩阵。所有下游算法（project / unproject / 遮挡 / 吸附）都吃它的输出。
 *   把实测锚点换成新美术稿的值，整个世界自动重新校准 —— 这是"手感可调"的前提。
 */
export function deriveIso(m: MeasuredAnchors = MEASURED): IsoCalibration {
  // ① GW / GH：来自爻位槽的单步位移（设计稿里最规整的一组数据）
  const steps = Math.max(1, m.slotCount - 1)
  const stepX = (m.slotLast.x - m.slotFirst.x) / steps
  const stepY = (m.slotLast.y - m.slotFirst.y) / steps

  const gw = Math.abs(stepX)
  const gh = Math.abs(stepY)

  // ② LIFT：地面原点与桌面中心的屏幕 y 之差 = 木桌高度对应的像素
  const lift = m.floorCenter.y - m.tableTopCenter.y

  return {
    ox: m.floorCenter.x,
    oy: m.floorCenter.y,
    gw,
    gh,
    lift,
    ratio: gw / gh,
    uStep: { x: gw, y: -gh },
    vStep: { x: -gw, y: -gh },
    unitW: gw * 2,
    unitH: gh * 2,
    /**
     * 三个平面的"像素半宽/半高"。**三个都要看，包括没过的那个** ——
     * table 期望 ≈ ratio，实测 1.300，是"实测值有错"的信号（见 §一·②）。
     * 完整的体检（含平行四边形恒等式）跑 `npm run check:art`。
     */
    checks: {
      floor: m.floorHalf.x / m.floorHalf.y,
      board: m.boardHalf.x / m.boardHalf.y,
      table: m.tableHalf.x / m.tableHalf.y,
    },
    zToV: lift / gh,
    // ▲ 注意这个 2：unproject 把 dv 一分为二给 u 和 v，所以每轴的实际偏移是 zToV 的一半。
    zToAxis: lift / (2 * gh),
  }
}

/** 校准后的投影矩阵（模块加载时算一次，之后只读） */
export const ISO: Readonly<IsoCalibration> = Object.freeze(deriveIso())

// ───────────────────────────────────────────────────────────────────────────
// 三、正投影 / 反投影
// ───────────────────────────────────────────────────────────────────────────

/** 世界 (u, v, z) → 设计坐标像素 */
export function project(u: number, v: number, z = 0, iso: IsoCalibration = ISO): Vec2 {
  return {
    x: iso.ox + (u - v) * iso.gw,
    y: iso.oy - (u + v) * iso.gh - z * iso.lift,
  }
}

/**
 * 设计坐标像素 → 世界 (u, v)。
 * ★ z 必须传对该点所在平面的高度：桌面上的东西传 1，地面上的东西传 0。
 *   漏传会让 u、v **各**偏 ISO.zToAxis ≈ 3.46 个单位
 *   （等价于 (u+v) 偏 ISO.zToV ≈ 6.93；两个口径的区别见文件头 §一·④）。
 */
export function unproject(
  x: number,
  y: number,
  z = 0,
  iso: IsoCalibration = ISO,
): { u: number; v: number } {
  const du = (x - iso.ox) / iso.gw // = u − v
  const dv = (iso.oy - y - z * iso.lift) / iso.gh // = u + v（先补掉高度）
  return { u: (du + dv) / 2, v: (dv - du) / 2 }
}

/** 高度 → 屏幕 y 抬升（px）。z 用世界单位，1 单位 = 木桌高度。 */
export function liftPx(z: number, iso: IsoCalibration = ISO): number {
  return z * iso.lift
}

/** 世界 (u, v) 在给定平面上的屏幕位置 —— 也是该物体的"影子"落点 */
export function shadowOf(u: number, v: number, planeZ = 0, iso: IsoCalibration = ISO): Vec2 {
  return project(u, v, planeZ, iso)
}

// ───────────────────────────────────────────────────────────────────────────
// 四、地面四边形（等距菱形）
// ───────────────────────────────────────────────────────────────────────────

/** 等距菱形的四个顶点，命名按屏幕方位 —— 排序与描边都吃它的语义 */
export interface Quad {
  top: Vec2
  right: Vec2
  bottom: Vec2
  left: Vec2
}

/**
 * 一个 w × d 单位的地面矩形在平面 z 上的四顶点。
 * w = d 时是正菱形；卦盘、地面都是正方形，木桌**不走这里**（见 stylizedDiamond）。
 */
export function quadOf(
  u: number,
  v: number,
  w: number,
  d: number,
  z = 0,
  iso: IsoCalibration = ISO,
): Quad {
  const hu = w / 2
  const hv = d / 2
  return {
    bottom: project(u - hu, v - hv, z, iso),
    right: project(u + hu, v - hv, z, iso),
    top: project(u + hu, v + hv, z, iso),
    left: project(u - hu, v + hv, z, iso),
  }
}

/** 菱形中心（= 四顶点均值，用于放文字与高光） */
export function quadCenter(q: Quad): Vec2 {
  return {
    x: (q.top.x + q.bottom.x + q.left.x + q.right.x) / 4,
    y: (q.top.y + q.bottom.y + q.left.y + q.right.y) / 4,
  }
}

/**
 * ★ 手绘四边形：直接给四个屏幕顶点。
 *   用途：形状确实由美术**手绘/手动调整**、不遵守 2:1 时，显式声明，
 *   走这里意味着"我知道它不守等距投影，而且我能指出理由"，代码里一眼可辨。
 *
 * ⚠ 使用前请先过文件头 §二 的两条判据（平行四边形 + 半宽/半高 = GW/GH）。
 *   "指不出理由"的不守等距，几乎都是**测量错了**，不是美术取舍 ——
 *   木桌顶面就是这么被误判成风筝形、进而让"卦盘探出桌面"背了很久的黑锅。
 */
export function quadFrom(top: Vec2, right: Vec2, bottom: Vec2, left: Vec2): Quad {
  return { top, right, bottom, left }
}

/**
 * 对称但比例自定义的手绘菱形（备用；木桌不用它，因为木桌连对称性都不满足）。
 * cx/cy 是中心，halfW/halfH 是半宽/半高。
 */
export function stylizedDiamond(cx: number, cy: number, halfW: number, halfH: number): Quad {
  return {
    top: { x: cx, y: cy - halfH },
    right: { x: cx + halfW, y: cy },
    bottom: { x: cx, y: cy + halfH },
    left: { x: cx - halfW, y: cy },
  }
}

/** 四边形描边路径（不含 fill / stroke，交给调用方决定） */
export function quadPath(ctx: CanvasRenderingContext2D, q: Quad): void {
  ctx.beginPath()
  ctx.moveTo(q.top.x, q.top.y)
  ctx.lineTo(q.right.x, q.right.y)
  ctx.lineTo(q.bottom.x, q.bottom.y)
  ctx.lineTo(q.left.x, q.left.y)
  ctx.closePath()
}

/** 在四边形边 A→B 上按比例 t 取点（木纹、光池、描边都靠它） */
export function lerpPt(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** 沿四边形的一对边生成第 t 条"平行切分线"（木纹线家族） */
export function sliceLine(q: Quad, t: number): [Vec2, Vec2] {
  return [lerpPt(q.top, q.right, t), lerpPt(q.left, q.bottom, t)]
}

// ───────────────────────────────────────────────────────────────────────────
// 五、遮挡排序（LayerStack 的唯一排序依据）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 物体：用它**地面接触点（影子）**的屏幕 y 当排序键，升序绘制。
 *   屏幕越靠下 = 离镜头越近 = 越晚画 = 挡住别人。
 *
 * ★ 关键约束：只吃影子，不吃物体本身的高度。
 *   一枚飞在空中的铜钱，不应该因为"飞得高"就跳到竹筒前面去 ——
 *   飞行高度只改它画在哪，不改它和别人的前后关系。M2 的抛物线与落盘涟漪都靠这条。
 *
 * ★ 平台类（平躺的大平面）不要用这个函数，用 platformSortY()。
 */
export function actorSortY(shadow: Vec2): number {
  return shadow.y
}

/**
 * ★ 平台：取四顶点中**最靠上**（屏幕 y 最小 = 离镜头最远）的那个作为排序键。
 *   这样任何站在它上面的物体（影子的 y 必然更大）都会排在它之后被画 ——
 *   也就是"画在它上面"。卦盘必须先于所有铜钱，靠的就是这一行。
 *
 *   验证：卦盘最远角 y = 469；六个爻位槽的 y ∈ [508, 549.2]，全部 > 469 ✓
 */
export function platformSortY(q: Quad): number {
  return Math.min(q.top.y, q.right.y, q.bottom.y, q.left.y)
}

/** 直接由世界坐标拿排序键（平地上的道具、角色用这个） */
export function sortYAt(u: number, v: number, planeZ = 0, iso: IsoCalibration = ISO): number {
  return actorSortY(shadowOf(u, v, planeZ, iso))
}

// ───────────────────────────────────────────────────────────────────────────
// 六、网格工具
// ───────────────────────────────────────────────────────────────────────────

/** 沿 +u 推进 n 格后的世界坐标（爻位槽、地面格都走它，别手算 16.52 这类数） */
export function stepU(u: number, v: number, n = 1): { u: number; v: number } {
  return { u: u + n, v }
}

/** 沿 +v 推进 n 格 */
export function stepV(u: number, v: number, n = 1): { u: number, v: number } {
  return { u, v: v + n }
}

/** 屏距（设计像素）—— 吸附 / 点击命中判定用它 */
export function distPt(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 把点吸附到最近的半格交叉点（M2 手势微调会用） */
export function snapToHalf(n: number): number {
  return Math.round(n * 2) / 2
}
