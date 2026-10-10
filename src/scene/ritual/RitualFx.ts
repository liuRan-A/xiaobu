/**
 * 小卜 · 掷币动效层   src/scene/ritual/RitualFx.ts
 * ===========================================================================
 * 这一层是"掷币这条支线在真机上真正跑起来"的那块胶水。它一共做四件事：
 *
 *   ① 装配：建一个 `RitualEngine`，把三条几何（铜钱的家 / 竹筒口 / 卦盘椭圆）
 *      喂给它 —— core 不许知道美术像素，所以这件事只能在场景层做。
 *   ② 注册 8 个动效图层进渲染栈（1 盘面 + 6 落位币 + 1 空中币）。
 *      它们的排序键全部来自 `worldLayout`，所以与既有图层自动咬合，不需要人工指定层级。
 *   ③ 接住两条**只有场景层知道**的回调：
 *        · `Engine.onToss`        → `engine.launch()`（力度与方向在 GestureEvent 里）
 *        · `Engine.onRitualRelease` → `engine.drop()`（竹筒在屏幕哪里只有这里知道）
 *   ④ 每帧一次：推进时间线 → 把 `view()` 落到画面与命中层上。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ★ 为什么每帧要做这三件"看起来多余"的事
 * ───────────────────────────────────────────────────────────────────────────
 *   · `setVisible(L4_COIN_ID(i), onTable[i])`
 *     待机铜钱由 L4 画；一旦被拿起 / 在空中 / 落进槽里，就必须由动效层接手。
 *     不切换的话会**画两枚**（原地一枚 + 空中一枚），而两枚的呼吸相位还不一样 ——
 *     看上去像"重影"，很难联想到是"两个图层都在画同一个东西"。
 *   · `setLiveCoins(...)`
 *     命中层的"铜钱在哪"是**每帧重算**的真源。不喂的话，一枚已经落进槽里的币，
 *     点击判定还停在它原来待机的位置 —— 用户点它没反应，点空地反而"戳到了币"。
 *   · `setTubeShake / setCoinDim`
 *     竹筒震颤与"另两枚压暗"是既有图层的**表现态**，不是新图层。
 *     为它们各开一个图层会让排序键多两份，而收益为零。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ★ 逐帧的"正负交替"为什么在这里而不在 core
 * ───────────────────────────────────────────────────────────────────────────
 * 规范要的是"竹筒高频轻颤 ±1.5pt"。直觉写法是 `sin(2π·60·t)`，但**那是错的**：
 * 60Hz 的正弦在 60fps 下每帧采到的是 sin(2πn) = 0 —— **抖幅恒为零，画面完全静止**。
 * 这是一个"照抄参数就会失效"的经典陷阱，而且它在 120Hz 设备上又正常，
 * 于是表现为"我的手机不抖，你的抖"。
 *
 * 所以：**包络（衰减曲线）在 core —— 它有时间语义、要能被断言；
 * 波形（正负）在这一层 —— 它只需要一个不会退化成常数的交替**。
 * 用逐帧取反（`frame.n % 2`）保证任何刷新率下都抖得起来。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { BAND, DESIGN_W, DESIGN_H, type Frame, type LayerStack } from '@scene/renderer'
import {
  BOARD_ELLIPSE,
  COIN_IDLE_PX,
  L4_COIN_ID,
  TUBE_MOUTH_PX,
  setCoinDim,
  setTubeShake,
  slotSortY,
} from '@scene/layers'
import { setCommandSink, SLOT_CENTERS } from '@core/machine/ritualMachine'
import { CUP_SHAKE_AMP_PT } from '@core/ritual/thresholds'
import { RitualEngine, type RitualView } from '@core/ritual/engine'
import type { Pt } from '@core/ritual/flight'
import type { GestureEvent } from '@core/gesture'
import {
  AIR_COIN_SORT_Y,
  BOARD_FX_SORT_Y,
  drawAirCoin,
  drawArmedSlot,
  drawBoardGlow,
  drawPredictRing,
  drawRipples,
  drawSettledCoin,
  drawSlotBreath,
  drawTrail,
  rollOutScale,
} from './draw'
import { pulseHaptic } from './haptics'

/** 图层 id —— 前缀 `rfx` (ritual fx)，与 L1–L9 的命名空间分开，一眼能看出是谁加的 */
export const RFX_BOARD = 'rfx-board'
export const RFX_AIR = 'rfx-air'
export const RFX_SLOT = (i: number): string => `rfx-slot-${i}`

export interface RitualFxOptions {
  /** 目标渲染栈（`createSceneStack()` 的产物） */
  stack: LayerStack
  /**
   * 每帧把"活着的铜钱位置"交出去。
   * ★ 用回调注入而不是这里直接 import `@store/engineHost`：
   *   这一层属于"画面"，不该知道"引擎怎么装配"。
   *   副作用是它也因此能在 node 里被构造（单测），只要传一个空函数。
   */
  onLiveCoins?: (coins: readonly Pt[]) => void
}

export interface RitualFx {
  /** 便于 DevPanel / 测试直接读它（**不要**用它做画面决策，画面只认 view()） */
  readonly engine: RitualEngine
  /** 接 `setCommandSink`（仪式机的指令出口）：开始收场景指令 */
  attach(): void
  /** 卸载：断开指令汇、把表现态复位（否则下一块画布会继承竹筒的抖幅） */
  detach(): void
  /** 接 `Engine.onToss` */
  onToss(ev: GestureEvent): void
  /** 接 `Engine.onRitualRelease` */
  onDrop(at: Pt): void
  /** 接 `CanvasRenderer.onFrame`（★ 在绘制之前） */
  onFrame(frame: Frame): void
}

export function createRitualFx(opts: RitualFxOptions): RitualFx {
  const { stack, onLiveCoins } = opts

  const engine = new RitualEngine({
    // ★ 三条几何都由场景层给：core 里出现 196 / 452 / 382 这类美术数字即为违规
    coinHome: COIN_IDLE_PX,
    cup: TUBE_MOUTH_PX,
    board: BOARD_ELLIPSE,
    bounds: { w: DESIGN_W, h: DESIGN_H },
  })

  /** 当前帧的画面投影。★ `onFrame` 先刷新它，图层再读 —— 于是"这一帧画的"就是"这一帧算的" */
  let view: RitualView = engine.view()
  /** 竹筒这一帧的交替符号（+1 / −1）。见文件头关于 60Hz 的说明 */
  let shakeSign = 1

  registerLayers(stack)

  return {
    engine,

    attach(): void {
      setCommandSink((cmd) => engine.handleCommand(cmd))
    },

    detach(): void {
      // ★ 断开指令汇：不做这一步，卸载后仍有指令被送进一个已经没人看的引擎
      setCommandSink(() => {})
      engine.reset()
      view = engine.view()
      setTubeShake(0, 0)
      setCoinDim(false)
      for (let i = 0; i < COIN_IDLE_PX.length; i++) stack.setVisible(L4_COIN_ID(i), true)
    },

    onToss(ev: GestureEvent): void {
      // ★ 力度与方向只在这一刻存在（状态机故意不认它们），所以必须由这里转交
      engine.launch({
        dir: ev.dir,
        displacePt: ev.distancePt,
        releaseV: ev.speedPtS,
      })
    },

    onDrop(at: Pt): void {
      try {
        engine.drop(at)
      } catch (e) {
        // ★ 门禁 ⑨：判不出结局只是"这一下没吸住"，币留在原地，仪式继续
        logger.warn('[rfx] 落位判定异常（已忽略）', e)
      }
    },

    onFrame(frame: Frame): void {
      try {
        // ① 时间线（含"到点上报 LANDED"）—— 必须先于取 view()
        engine.frame(frame.t)
        view = engine.view()

        // ② 表现态落到既有图层
        shakeSign = frame.n % 2 === 0 ? 1 : -1
        setTubeShake(CUP_SHAKE_AMP_PT * view.tubeShake * shakeSign)
        setCoinDim(view.dimOthers)
        for (let i = 0; i < view.onTable.length; i++) {
          stack.setVisible(L4_COIN_ID(i), view.onTable[i] === true)
        }

        // ③ 命中层的真源：铜钱此刻到底在哪
        onLiveCoins?.(engine.liveCoins())

        // ④ 触感：**取走即清空**的一次性信号。
        //   core 不发震动（它不认识平台），只登记"该震一下，轻的还是中的"；
        //   由这里取走并交给 haptics 层 —— 于是 node 单测里 `consumeHaptic()`
        //   照样有返回值可断言，而浏览器与 node 上 `pulseHaptic` 天然是空操作，
        //   不需要在 core 里写任何 `if (isTest)` 分支。
        const cue = engine.consumeHaptic()
        if (cue) pulseHaptic(cue)
      } catch (e) {
        // ★ 门禁 ⑨：动效层的任何异常都不该影响这一帧的其余图层
        logger.warn('[rfx] 帧推进异常（已忽略）', e)
      }
    },
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 图层注册
  // ─────────────────────────────────────────────────────────────────────────

  function registerLayers(target: LayerStack): void {
    // ── 盘面：提亮 / 呼吸 / 预示环 / 涟漪 ──────────────────────────────────
    //  排序键 SORT.board + 0.5 —— 在卦盘之后、在最近的爻位槽之前（见 draw.ts）
    target.add({
      id: RFX_BOARD,
      band: BAND.BOARD,
      sortY: BOARD_FX_SORT_Y,
      z: 0,
      draw: (ctx, frame) => {
        // ① 盘面提亮 + 柔紫外晕。★ 只在选位态亮 —— 掷币飞行途中亮起来会抢掉拖尾的注意力
        if (view.glow) drawBoardGlow(ctx, 1)
        // ② 空槽呼吸（已落过位的槽不呼吸）
        if (view.breathe) drawSlotBreath(ctx, view.slotEase, frame.t, view.breatheFast)
        // ③ 预备吸附的槽：比呼吸更亮、且不摆动
        if (view.armedSlot >= 0) drawArmedSlot(ctx, view.armedSlot, 1)
        // ④ 落点预示环（币还在空中时告诉用户"会落在哪"）
        if (view.predictAt) drawPredictRing(ctx, view.predictAt, frame.t)
        // ⑤ 落盘涟漪：圆心是**落点**，不是币此刻的位置
        if (view.landingAt) drawRipples(ctx, view.landingAt, view.flight)
      },
    })

    // ── 六个爻位槽上的铜钱 ────────────────────────────────────────────────
    //  ★ 一个槽一个图层：排序键就能直接用 `slotSortY(i)`（worldLayout 给的），
    //    六个槽 y ∈ [508, 549] 全部大于卦盘最远角 469 —— 于是它们自动画在盘面上。
    //    合成一个图层也可以，但那样就得手写"整层取哪个 y"，
    //    而任何一次"取平均 / 取最大"都会让最靠前的那个槽偶尔钻到盘子下面。
    for (let i = 0; i < SLOT_CENTERS.length; i++) {
      target.add({
        id: RFX_SLOT(i),
        band: BAND.PROPS,
        sortY: slotSortY(i),
        z: 0,
        draw: (ctx, frame) => {
          if ((view.slots[i] ?? -1) < 0) return
          drawSettledCoin(ctx, i, frame.t, view.slotEase[i] ?? 1)
        },
      })
    }

    // ── 手上 / 空中 / 正在滚出来的铜钱 ────────────────────────────────────
    //  ★ sortY = AIR_COIN_SORT_Y（一个极大的常数）：飞行的币永远在桌面之上，
    //    按它的 y 排序会让它半路"从卦盘后面钻出来"（见 draw.ts 的说明）。
    target.add({
      id: RFX_AIR,
      band: BAND.PROPS,
      sortY: AIR_COIN_SORT_Y,
      z: 0,
      draw: (ctx, frame) => {
        // ① 3 段拖尾先画（在币身后）
        drawTrail(ctx, view.flight)
        // ② 手上 / 空中的那一枚（含光环、柔紫投影、翻滚压缩）
        if (view.coinAt) {
          drawAirCoin(ctx, view.coinAt, frame.t, {
            scale: view.coinScale,
            squashX: view.coinSquashX,
            alpha: view.coinAlpha,
            halo: view.halo,
          })
        }
        // ③ 正从竹筒滚出来的那一枚（"落一枚，竹筒补一枚"）
        for (let i = 0; i < view.drawCoins.length; i++) {
          if (i === view.coinId) continue // 手上那枚上面已经画过
          const p = view.drawCoins[i]
          if (!p) continue
          drawAirCoin(ctx, p, frame.t, {
            scale: rollOutScale(view.rollOut[i] ?? 1),
            squashX: 1,
            alpha: 1,
            halo: 0,
          })
        }
      },
    })
  }
}
