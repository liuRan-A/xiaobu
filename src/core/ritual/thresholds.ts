/**
 * 小卜 · 掷币仪式阈值总表   src/core/ritual/thresholds.ts
 * ===========================================================================
 * ★ 本文件是《掷币仪式四态-交互动效 Brief》§2.2 + §3 的**唯一数值来源**。
 *   规范原文：「阈值常量（全部集中在这里，方便调参；**不许散落在表现层**）」。
 *
 * 为什么这条纪律值钱：
 *   手感参数天生要反复调。散落在 draw 函数里 → 改一次要 grep 全仓、还容易漏；
 *   集中在这里 → 调参就是改一个数字，并且能一眼看出"哪些是物理、哪些是美术"。
 *
 * 分层（★ 与文件里实际的小节一一对应，别再让标题和内容对不上）：
 *   §一 手势判定      —— 什么算"长按成功"、什么算"掷出去"（语义阈值）
 *   §二 飞行时长与拖尾 —— 时长钳制、弹跳、3 段残影
 *   §三 表现参数      —— 缩放 / 透明度 / 涟漪 / 木屑 / 光环
 *   §四 六音上行      —— 五声音阶与播放倍速
 *   §五 触感          —— 只有"做成了"才震
 *   §六 指针手势识别  —— 采样容差、轻点判定、速度窗口（原始 → 语义的桥）
 *
 * ★ 硬约束：本文件（以及整个 core/）不得 import vue / pinia / @capacitor /
 *   @scene / @ui / @store —— 它必须能在 node 里直接单测。ESLint 会拦。
 * ===========================================================================
 */

// ───────────────────────────────────────────────────────────────────────────
// 一、手势判定
// ───────────────────────────────────────────────────────────────────────────

export const TH = {
  /** 判定「拾起成功」的长按时长（ms）。到点就有触感 —— 触到就回应，不必等满 */
  LONG_PRESS_MS: 180,

  /** 待机多久没操作 → 温柔引导 A「还没想好吗？先深呼吸一次。」 */
  IDLE_GUIDE_MS: 20_000,

  /** 选位态空闲多久 → 温柔引导 B「它该睡在哪一格？」 */
  PLACE_GUIDE_MS: 8_000,

  /** 上滑位移阈值（pt）—— 三种掷出手势之一 */
  SWIPE_MIN_PT: 60,

  /** 释放速度阈值（pt/s）—— 三种掷出手势之二 */
  RELEASE_V_MIN: 480,

  /** 释放方向与垂线的夹角上限（度）—— 太横的甩不算"掷"，避免误触 */
  RELEASE_ANGLE_MAX: 40,

  /** 晃动手机加速度阈值（g）—— 三种掷出手势之三 */
  SHAKE_G: 1.6,

  /** 晃动需持续多久才算数（ms） */
  SHAKE_HOLD_MS: 80,

  // ── 物理 ────────────────────────────────────────────────────────────────
  /** 屏幕空间重力（pt/s²）。★ 不是真实重力，是"看起来对"的手感值 */
  GRAVITY: 2600,

  /** 出射速度双向钳制（pt/s） */
  V0_MIN: 420,
  V0_MAX: 1500,

  /** v0 = k1·|手势位移| + k2·|释放速度| —— 位移与速度共同决定力度 */
  V0_K_DISPLACE: 6.2,
  V0_K_RELEASE: 0.85,

  /** 自旋角速度（度/秒），落定时再叠加 ±SPIN_JITTER_DPS */
  SPIN_DPS: 760,
  SPIN_JITTER_DPS: 60,

  /** 弹跳高度衰减系数：h₁ = 0.35 · h₀，只弹一次 */
  BOUNCE_DECAY: 0.35,

  /** 静止判定：|v| < 40 pt/s 且 t > 0.55s */
  SETTLE_V_PT_S: 40,
  SETTLE_MIN_MS: 550,

  /** 落定后停留多久自动进「选位」（ms） */
  SETTLE_MS: 1200,

  // ── 落位判定：三个半径，三个语义，别混 ───────────────────────────────────
  /** 吸附落定半径（pt）—— 松手在这个范围内就"吸"过去 */
  SNAP_PT: 28,
  /**
   * 预备吸附半径（pt）—— 拖进这个范围该槽描边提亮、铜钱给 1.08 预备缩放。
   * ★ 它必须 > SNAP_PT：有效交互带 44pt 满足可点区域要求，
   *   而落定仍要求 28pt，于是"看着吸上了但其实还没到"这种暧昧态才有落点。
   */
  PRESELECT_PT: 44,
  /** 反悔半径（pt）—— 拖到竹筒这么近松手 = 作废（不扣次数、不计失败） */
  REVOKE_PT: 40,

  /** 后台超过这么久回前台：仪式归零重开，**不提示** */
  COIN_MEMORY_5MIN: 5 * 60_000,
} as const

// ───────────────────────────────────────────────────────────────────────────
// 二、飞行时长与拖尾
// ───────────────────────────────────────────────────────────────────────────

/**
 * 飞行时长区间（ms）。
 *
 * ★ 这里有一个必须交代清楚的设计取舍：
 *   抛物线**形状**由物理决定（v0 / 方向 / 重力）—— 这样弧线看起来是对的；
 *   但**时长**要钳在这个区间 —— 因为纯物理算出来的 T，最小力度只有 323ms
 *   （像被烫了一下），最大力度 884ms（刚好在区间内）。
 *   所以：shape 交给物理，duration 交给人手。规范 §3③ 写的「T ∈ [550,900]ms
 *   由手势速度决定」正是这个意思 —— 它约束的是时长，不是轨迹。
 */
export const FLIGHT_MS_MIN = 550
export const FLIGHT_MS_MAX = 900

/** 单次弹跳时长（ms） */
export const BOUNCE_MS = 180

/**
 * 弹跳高度衰减系数：h₁ = 0.35 · h₀，只弹一次。
 * ★ 放在顶层而不是只留在 TH 里 —— flight.ts 要直接乘它，走 TH.BOUNCE_DECAY 也行，
 *   但顶层常量能被 tree-shake 得更干净，参数名也更短。
 *   曾经只写了 TH.BOUNCE_DECAY 而忘顶层导出，结果 `undefined * number = NaN`，
 *   弹跳高度静默变成 NaN（图上看不出、算不出，只有断言能抓到）。
 */
export const BOUNCE_DECAY = TH.BOUNCE_DECAY

/** 拖尾：**3 段残影，不是粒子系统**（1 次绘制 × 3 个 alpha） */
export const TRAIL_SEGMENTS = 3
/** 每段残影的滞后（ms） */
export const TRAIL_LAG_MS = [24, 48, 72] as const
/** 每段残影的不透明度 */
export const TRAIL_ALPHA = [0.18, 0.12, 0.07] as const
/** 拖尾三层递减半径（pt） */
export const TRAIL_R_PT = [9, 4.5, 2.4] as const

/** 涟漪：**2 个描边椭圆，不做逐帧扩散纹理** */
export const RIPPLE_RINGS = 2
export const RIPPLE_MS = 420
export const RIPPLE_ALPHA_FROM = 0.35

/**
 * 涟漪的起止半径（pt，取横向半轴）。
 *
 * ★ 从"一枚铜钱那么大"涨到"卦盘三成宽"，上限刻意卡在 64：
 *   卦盘半宽 118，涨到 64 时直径 128 —— 刚好铺满盘面又不越出盘边。
 *   越过盘边的涟漪会画到木桌上，读起来像"水漫出来"，与"落在盘上"矛盾。
 * ★ 2:1 由 `flattenRy()` 给，不手写 ry —— 等距下的圆投影永远是椭圆。
 */
export const RIPPLE_RX_FROM = 12
export const RIPPLE_RX_TO = 64

/**
 * 两圈涟漪之间的延时（ms）。
 *
 * ★ 为什么要错开而不是同时画两圈：同心的两个椭圆同时扩散，看起来是**一个粗描边**；
 *   错开 140ms（= RIPPLE_MS 的 1/3）才有"一圈推着一圈"的水面感。
 *   140 这个值的来历：小于 80ms 人眼分辨不出两圈，大于 260ms 第一圈已经消失，
 *   中间只剩一圈 —— 都不成立。
 */
export const RIPPLE_STAGGER_MS = 140

/** 竹筒震颤 + 筒口木屑（复用同一粒子池，不新开系统） */
export const CUP_SHAKE_HZ = 60
export const CUP_SHAKE_AMP_PT = 1.5
export const CUP_SHAKE_DECAY_MS = 260
export const CHIP_COUNT = 5
export const CHIP_LIFE_MS = 620

/** 新币滚出：上一枚落位后延迟这么久，竹筒滚出一枚补足桌面（桌面永远三枚） */
export const CUP_ROLL_OUT_DELAY_MS = 400
/** 补币滚动时长（ms） */
export const CUP_ROLL_OUT_MS = 220

/** 盘面落点预示环：r 30×15pt 虚线，脉冲周期 1.2s */
export const PREDICT_RING_RX = 30
export const PREDICT_RING_RY = 15
export const PREDICT_RING_PULSE_MS = 1200

// ───────────────────────────────────────────────────────────────────────────
// 三、表现参数
// ───────────────────────────────────────────────────────────────────────────

/** 拖动中铜钱中心相对指针的偏移：**在指针上方 22pt，避免被手指遮住**（手感关键） */
export const CURSOR_OFFSET_PT = 22

/** 拾起：scale 1.15、上浮 5pt */
export const COIN_LIFT_SCALE = 1.15
export const COIN_LIFT_DY = 5
/** 按下瞬间的预备反馈：scale 1.00 → 1.03，80ms */
export const COIN_PRESS_SCALE = 1.03
/**
 * 拖到爻位槽吸附域内（≤ PRESELECT_PT）时铜钱的"预备缩放"。
 *
 * ★ 它比 COIN_LIFT_SCALE(1.15) **小**，这是刻意的：1.08 是"它准备落下了"，
 *   而不是"它又变大了一点"。手上 26pt / 待机 24pt / 落位 20pt —— 1.08 正好
 *   是"26 往 20 走的第一步"，视觉上读作**在往槽里沉**。
 *   若这里用 1.15，用户看到的是"它要飞走了"，与"吸住"完全相反。
 */
export const COIN_PRESELECT_SCALE = 1.08

/** 待机铜钱外径（pt）—— 视觉尺寸，2:1 椭圆 */
export const COIN_IDLE_PT = 24
/** 已落位铜钱固定为 20×20，被拖那枚 26×26 */
export const COIN_SETTLED_PT = 20
export const COIN_CARRY_PT = 26

/** 其余两枚被压暗到 82% */
export const DIM_OTHERS_ALPHA = 0.82
export const DIM_OTHERS_SCALE = 0.98

/** 接触影不透明度 */
export const SHADOW_ALPHA_IDLE = 0.12
export const SHADOW_ALPHA_LIFT = 0.2
/** 拾起时铜钱浮起 → 影子跟着收缩 */
export const SHADOW_SHRINK_AIRBORNE = 0.86

/**
 * 自旋时铜钱最窄能压到多少（横向比例，1 = 完全摊平）。
 *
 * ★ 一枚翻滚的铜钱在 2:1 等距投影下**不是"在屏幕上打转"**，而是**变窄** ——
 *   立起来的那一瞬间它只剩一条侧边。所以自旋用 `|cos θ|` 压缩横向半径，
 *   而不是 `ctx.rotate()`（rotate 画出来是俯视视角里的一只转盘，完全穿帮）。
 *
 * ★ 下限 0.12 而不是 0：压到 0 会让币在那一帧**彻底消失**（一帧的闪烁），
 *   而 0.12 ≈ 一枚铜钱侧边的厚度（币厚约 1.3pt / 直径 22pt）。
 *   留下的这条窄椭圆，正好读作"立起来的币"，比消失自然得多。
 */
export const COIN_EDGE_SQUASH_MIN = 0.12

/** 选位：盘面提亮 6% + 三层外晕 */
export const PLACE_BRIGHTEN_PCT = 6
export const PLACE_HALO_R = [124, 132, 143] as const
export const PLACE_HALO_ALPHA = [0.06, 0.07, 0.22] as const

/** 空槽呼吸：底 20%、描边 1.5pt；周期 4s，引导态 B 下加快到 2.4s */
export const SLOT_FILL_ALPHA = 0.2
export const SLOT_STROKE_PT = 1.5
export const SLOT_BREATH_MS = 4000
export const SLOT_BREATH_FAST_MS = 2400
export const SLOT_BREATH_ALPHA = [0.16, 0.24] as const

/** 拾起时铜钱外圈柔紫光环：r 18 → 21、α 0 → 0.22 */
export const HALO_R_IDLE = 18
export const HALO_R_LIFT = 21
export const HALO_ALPHA_LIFT = 0.22

/** 拾起时的柔紫椭圆投影 96×30 */
export const LIFT_SHADOW_RX = 48
export const LIFT_SHADOW_RY = 15

/** 小卜：拾起时头部跟随，滞后 90ms、偏移上限 ±6pt（不转整身） */
export const PET_LOOK_LAG_MS = 90
export const PET_LOOK_MAX_OFFSET_PT = 6
/** 选位时退半步让开卦盘：x −12pt、scale 0.96 */
export const PET_PET_RETREAT_DX = -12
export const PET_RETREAT_SCALE = 0.96
/** 落盘后延迟 400ms 抬头，持续 900ms */
export const PET_LOOK_AFTER_LAND_DELAY_MS = 400
export const PET_LOOK_AFTER_LAND_MS = 900
/** 卦成表演时长 */
export const PET_CAST_MS = 1600

/** 动画时长 */
export const MS = {
  /** 按下预备（scale → 1.03） */
  press: 80,
  /** 拾起抬起（scale → 1.15、y −5pt） */
  lift: 120,
  /** 松手未达阈值：落回原位 */
  fallBack: 180,
  /** 未落盘：滚回桌面 */
  rollBack: 260,
  /** 反悔：飞回筒口 */
  flyBackToCup: 200,
  /** 吸附落定 */
  snap: 120,
  /** 盘面提亮 */
  boardLightUp: 240,
  /** 提示条 cross-fade */
  hintFade: 300,
  /** 卦成全屏暖光上扬 */
  castWarmUp: 400,
  /** 卦成后进解读页 */
  castToResult: 1200,
} as const

// ───────────────────────────────────────────────────────────────────────────
// 四、六音上行 · 五声音阶（本产品的"成就感时刻"）
// ───────────────────────────────────────────────────────────────────────────

/**
 * ★ 五声音阶而非半音阶：半音阶走 6 个半音只跨一个三全音，听感"悬在半空"；
 *   五声走完落在高八度主音上，**自然收束** —— 用户听到的是一句完整的上行旋律。
 *
 * 实现：**只打包一条 180ms 的叮**，播放时按 `rate = f_n / f_1` 变速。
 *      副产物为零，且音程天然准。
 */
export const PENTATONIC_HZ = [587, 659, 740, 880, 988, 1175] as const // D5 E5 F#5 A5 B5 D6

/** 第 n 枚落位（n 从 1 数）应播的播放倍速 */
export function pentatonicRate(nth: number): number {
  const i = Math.max(0, Math.min(PENTATONIC_HZ.length - 1, nth - 1))
  return PENTATONIC_HZ[i] / PENTATONIC_HZ[0]
}

// ───────────────────────────────────────────────────────────────────────────
// 五、触感档位（只有"做成了"才有触感 —— 否定性反馈一律不震动）
// ───────────────────────────────────────────────────────────────────────────

export const HAPTIC_MS = {
  /** 拾起成功 */
  lift: 12,
  /** 掷出确认（更短） */
  toss: 8,
  /** 落盘 */
  land: 18,
  /** 爻位落定 */
  snap: 10,
} as const

export type HapticStyle = 'LIGHT' | 'MEDIUM'

export const HAPTIC_STYLE = {
  lift: 'LIGHT',
  toss: 'LIGHT',
  land: 'MEDIUM',
  snap: 'LIGHT',
} as const satisfies Record<keyof typeof HAPTIC_MS, HapticStyle>

// ───────────────────────────────────────────────────────────────────────────
// 六、指针手势识别（原始采样 → 语义手势）
// ───────────────────────────────────────────────────────────────────────────
// ★ 与 §一 的分工：
//   §一 是**语义**阈值（"多快算掷出去"）—— 属于仪式；
//   §六 是**采样**阈值（"多少位移还算按住没动"）—— 属于手势识别器。
//   两者都由 `core/gesture.ts` 消费，也都要集中在这里 ——
//   散到手势识别器内部的话，调手感就得去读那个类了。

/**
 * 长按期间允许的位移（pt）。
 *
 * ★ 为什么需要一个"容差"而不是位移 == 0 才算长按：
 *   手指按在玻璃上**一定**会抖，通常是 1–4pt。要求完全不动，等于要求用户
 *   按得比机器还稳 —— 长按成功率会低到用户以为是应用卡了。
 *   取值 8pt 的依据：小于它，指针还在同一枚铜钱（直径 22pt）的覆盖内，
 *   用户主观上"没动"；大于它，用户主观上已经在拖了，此时该转成拖拽而不是长按。
 */
export const POINTER_LONG_PRESS_TOL_PT = 8

/** 算作"轻点"的最长按住时长（ms）。超过它就既不是轻点、也还没到长按 ⇒ 什么都不算 */
export const TAP_MAX_MS = 220

/** 算作"轻点"的最大位移（pt）—— 与长按容差同源，理由一致 */
export const TAP_MAX_MOVE_PT = 8

/**
 * 估算释放速度的时间窗口（ms）。
 *
 * ★ 为什么不用"最后两个采样点"：
 *   触摸屏在抬手前最后几毫秒常给出一个位置几乎不动的采样（手指已离屏的残帧），
 *   用它算速度会得到接近 0 —— 于是"明明甩得很用力"却判成没甩出去。
 *   取最近 60ms 的窗口并且**用首尾两点**算平均速度，比瞬时速度稳得多。
 */
export const VELOCITY_WINDOW_MS = 60

/**
 * 采样最大间隔（ms）。超过它的两个采样点之间**不计算速度**。
 *
 * ★ 场景：App 切到后台再回来，或以 30fps 掉帧严重时，
 *   `pointermove` 之间可能隔几百毫秒。此时用首尾两点算出来的"速度"
 *   其实是"这段时间平均挪了多少 / 0.4 秒"，数值既无意义又可能极大，
 *   会让一次普通的拖动被判成猛烈甩出。
 *   宁可放弃这一段的力度信息（退回 V0_MIN），也不要掷出一个不受控的力度。
 */
export const MAX_SAMPLE_GAP_MS = 120

/** 手势采样环形缓冲的容量（够 1 秒 60fps 还多） */
export const GESTURE_BUFFER_SIZE = 96

/**
 * 两次"摇晃"事件之间的冷却（ms）。
 *
 * ★ 不设冷却会怎样：一次真实的晃手会持续 300–600ms，
 *   期间加速度每一帧都超阈值 —— 于是 60fps 下连发几十个 SHAKE，
 *   竹筒会被"晃"出几十枚铜钱。
 *   冷却值取 700ms（略大于规范给的 SHAKE_HOLD_MS 叠加实际晃手时长），
 *   于是**一次晃手 = 一次掷出**，符合直觉。
 */
export const SHAKE_COOLDOWN_MS = 700
