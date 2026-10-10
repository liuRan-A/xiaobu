/**
 * 小卜 · 引擎装配   src/store/engineHost.ts
 * ===========================================================================
 * 这里是"三样东西第一次见面"的地方，也只做这一件事：
 *
 *   · `core/engine`    —— 流程、仪式、手势、记忆、倒计时的编排者（纯 TS）
 *   · `store/localStore` —— 设备端存储端口（原生 Preferences / Web localStorage）
 *   · `scene/hit`      —— 屏幕坐标 → 语义命中的几何翻译
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  为什么需要一个 host，而不是在 Scene.vue 里 new 一个
 * ───────────────────────────────────────────────────────────────────────────
 *  命中测试需要的东西（这台引擎）与渲染需要的东西（那块画布）**不是同一个生命周期**：
 *    · 画布在 Scene.vue 挂载时才有，切页面就没了；
 *    · 引擎从 App 启动到退出**只有一个**，而且面板上的按钮（"翻开手账第 3 页"）
 *      也要调它 —— 那些按钮不在 Scene 里，拿不到 `defineExpose` 出去的东西。
 *  所以引擎必须由这一层持有，Scene 只是它的**输入与心跳的搬运工**。
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  四条纪律
 * ───────────────────────────────────────────────────────────────────────────
 *  ① **只有一个实例。** 两台状态机是模块级单例，建第二个引擎会把 `ctx` 串味
 *     （`Engine` 构造函数里那句 reset 就是为了兜住这件事）。
 *  ② **boot 只做一次。** 重复 boot 会重放 `BOOT_READY`，虽然被状态机静默忽略，
 *     但"每次进页面都读一遍磁盘"没有意义。
 *  ③ **命中测试永不缓存位置。** 活物件的坐标每帧都在变，所以取状态的函数
 *     在**每次判定时**重算一次 —— 缓存一次就等于"从第一帧起，铜钱永远停在原位"。
 *  ④ **抛异常不冒泡。** host 里所有对外函数都不许抛：最坏情况是"引擎没起来"，
 *     那也只是没有交互，画布照常显示黄昏小屋 —— 绝不能白屏。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { flushTrack } from '@services/track'
import { currentConfig } from '@bootstrap/bootSequence'
import { Engine, type EngineOptions } from '@core/engine'
import type { GestureEvent } from '@core/gesture'
import { createDevicePort } from '@store/localStore'
import { createSceneHitTest, idleHitState, type HitCircle, type SceneHitState, DECK_TOUCH_R_PT } from '@scene/hit'
import { DECK_PX } from '@scene/layers'
import type { Pt } from '@core/ritual/flight'

/** 场景层"此刻有什么"。★ 命中测试每次判定都读它，所以它必须是活的唯一真源 */
const scene: SceneHitState = idleHitState()

/** 起飞回调（场景层接它做铜钱飞行动画）。缺省空实现 —— 没有动画也要能正常掷 */
let tossHandler: (ev: GestureEvent) => void = () => {}

/**
 * 选位段松手的回调（场景层接它判"吸附 / 反悔 / 留在原处"）。
 *
 * ★ 与 `tossHandler` 成对：两者都是"**core 判不了、只有场景层知道**"的事 ——
 *   起飞要的是手势力度，落位要的是竹筒在屏幕上的位置（反悔半径绕筒口算）
 *   以及"币被画在指针上方 22pt"这个表现层的偏移。
 *   缺省空实现时仪式仍然可玩（币留在松手的地方），只是不会自动归位到爻位槽。
 */
let ritualReleaseHandler: (at: Pt) => void = () => {}

let engine: Engine | null = null
let booted = false

// ───────────────────────────────────────────────────────────────────────────
// 埋点周期上报（门禁⑩：services/track 内禁 setInterval，所以定时器挂在这里）
// ───────────────────────────────────────────────────────────────────────────

let trackTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动埋点周期上报。
 * ★ 门禁⑩ 要求 track 目录内**无 setInterval**，所以定时器只能在外层（host）驱动。
 * ★ 守卫：测试环境下（`import.meta.env.MODE === 'test'`）不挂定时器，
 *   避免 vitest 跑出后台悬挂的计时器、拖慢或污染用例。
 * ★ 切后台 / 页面隐藏时按 `monitor.flushOnBackground` 立即补报一次。
 */
export function startTrackFlush(): void {
  if (trackTimer !== null) return
  if (import.meta.env.MODE === 'test') return

  const interval = currentConfig().monitor.batchIntervalMs || 300000
  trackTimer = setInterval(() => {
    try {
      flushTrack()
    } catch (e) {
      // ★ 门禁⑨：上报失败静默丢弃，绝不冒泡
      logger.warn('[host] track flush failed', e)
    }
  }, interval)

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && currentConfig().monitor.flushOnBackground) {
        try {
          flushTrack()
        } catch (e) {
          logger.warn('[host] track flush (background) failed', e)
        }
      }
    })
  }
}

/** 停止周期上报（测试 / 卸载清理用） */
export function stopTrackFlush(): void {
  if (trackTimer !== null) {
    clearInterval(trackTimer)
    trackTimer = null
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 场景层写入：活着的道具位置
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把场景层当前的活物件位置推进来。
 *
 * ★ 用**局部更新**（只传你要改的字段）而不是整份覆盖：
 *   铜钱由动画层每帧刷新，而竹筒是否在场由仪式状态决定 ——
 *   要求两边每次都交出一整份状态，必然出现"其中一边忘了带上另一个字段"
 *   导致竹筒突然消失或铜钱回到桌面。局部更新让每个来源只管自己那一份。
 */
export function syncSceneActors(next: Partial<SceneHitState>): void {
  if (next.coins) scene.coins = next.coins
  if (typeof next.tubeVisible === 'boolean') scene.tubeVisible = next.tubeVisible
  if (next.deck !== undefined) scene.deck = next.deck
  if (next.memory) scene.memory = next.memory
  if (next.timepiece) scene.timepiece = next.timepiece
}

/** 铜钱当前位置（设计像素）—— 一行便捷写法，省得调用方拼 Partial */
export function setLiveCoins(coins: readonly Pt[]): void {
  scene.coins = coins.map((c) => ({ x: c.x, y: c.y }))
}

/** 竹筒在场与否（被拿起、被收进筒时传 false） */
export function setTubeVisible(visible: boolean): void {
  scene.tubeVisible = visible
}

/** 牌堆（美术稿到位前传 null） */
export function setDeck(deck: HitCircle | null): void {
  scene.deck = deck
}

/**
 * 把牌堆装进命中状态（M3 程序化骨架）。
 *
 * ★ 牌堆是**静态布景**（不像铜钱每帧变、竹筒随仪式变），所以只在 boot 时
 *   装一次。可点几何锚定 `DECK_PX`（茶几锚点），半径取 `DECK_TOUCH_R_PT`（34pt，
 *   见 hitTest 注释：牌堆是一叠牌，比单件大）。
 * ★ 这是"命中链路打通"的关键一步：戳牌堆 → `hitTest` 返回 `{kind:'deck'}`
 *   → 引擎进塔罗区。卡背贴图到位前，这个几何契约就已经生效。
 */
export function installDeck(): void {
  scene.deck = {
    id: 'deck',
    at: { x: DECK_PX.cx, y: DECK_PX.baseY },
    r: DECK_TOUCH_R_PT,
  }
}

/** 读一份当前场景状态 —— 给需要画"可点提示"的地方用（画的时候自己浅拷贝） */
export function sceneState(): SceneHitState {
  return scene
}

// ───────────────────────────────────────────────────────────────────────────
// 引擎单例
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把"屋里已经有什么"从引擎同步进命中状态。
 *
 * ★ 摆件与倒计时摆件是**引擎持有的**（它们要落盘、会被上限裁剪、归零时还会
 *   多出一件纪念品），所以不能让场景层去维护第二份 —— 那就成了两个真相。
 *   这里反向从引擎读，代价是遍历一次数组（上限 120 + 12）。
 */
function refreshPersistentActors(): void {
  if (!engine) return
  scene.memory = engine.memoryAnchors.map((m) => ({ id: m.id, at: { ...m.at } }))
  scene.timepiece = engine.countdownOrnaments.map((c) => ({ id: c.id, at: { ...c.at } }))
}

/**
 * 取引擎（没有就现建一个）。
 * ★ 建实例本身不读磁盘、不 await 任何东西 —— 所以它可以被同步调用，
 *   也可以被面板按钮直接调用而不必先 boot。
 */
export function getEngine(): Engine {
  if (engine) return engine

  const opts: EngineOptions = {
    port: createDevicePort(),
    // ★ 每次判定重算一次状态：见文件头 §四·③。摆件/倒计时也在这一刻从引擎取，
    //   于是"刚放下一盆绿植，马上点它"这条路径不需要任何人记得刷新。
    hitTest: createSceneHitTest(() => {
      refreshPersistentActors()
      return scene
    }),
    onToss: (ev) => {
      try {
        tossHandler(ev)
      } catch (e) {
        // ★ 门禁 ⑨：动画起不来只是没有动画，掷币本身照常进行，不弹 UI
        logger.warn('[host] 起飞回调异常（已忽略）', e)
      }
    },
    onRitualRelease: (at) => {
      try {
        ritualReleaseHandler(at)
      } catch (e) {
        // ★ 门禁 ⑨：判不出落点只是"这一下没吸住"，币留在原地，仪式继续
        logger.warn('[host] 落位回调异常（已忽略）', e)
      }
    },
  }

  engine = new Engine(opts)
  return engine
}

/** 启动：读一次本地，然后进房间。★ 存储读不到就是全新用户，绝不因此不可用 */
export async function bootEngine(): Promise<Engine> {
  const e = getEngine()
  if (!booted) {
    booted = true
    await e.boot()
    // 引擎起来了，挂上埋点周期上报（测试环境下内部自动跳过定时器）
    startTrackFlush()
    // M3：装上牌堆命中几何（静态布景，boot 时装一次）
    installDeck()
  }
  refreshPersistentActors()
  return e
}

/**
 * 每帧一次的心跳。
 *
 * ★ 时刻由引擎**自己的时钟**给（`Engine.tick()` 的缺省参数是 `nowFn`），
 *   这里刻意不转发渲染器的 `frame.t` —— 那是"自启动以来的累计毫秒"，
 *   在开机头两秒约等于 0，喂给倒计时会把日历日算到 1970 年。
 *   两个时间是两种东西：`frame.t` 给动画，墙上时钟给玩法。
 *
 * ★ 顺序与 `Engine.tick` 内部一致（手势 → 时间 → 落盘），这里只额外做一件收尾：
 *   把引擎里的摆件重新同步给命中状态，让**这一帧之后**的输入看到的是最新的屋子。
 */
export function tickEngine(): void {
  if (!engine) return
  engine.tick()
  refreshPersistentActors()
}

/** 切后台 / 卸载前调一次：忽略合并窗口，尽量把脏数据落下去。★ 永不抛 */
export async function flushEngine(): Promise<void> {
  try {
    await engine?.flush()
    // 顺手把埋点缓冲也带出去（切后台正是 flushOnBackground 的时机）
    flushTrack()
  } catch (e) {
    logger.warn('[host] 落盘失败（已忽略）', e)
  }
}

/** 场景层注册起飞回调（铜钱飞行动画）。重复注册以后者为准 */
export function setTossHandler(fn: ((ev: GestureEvent) => void) | null): void {
  tossHandler = fn ?? (() => {})
}

/** 场景层注册"选位段松手"回调。重复注册以后者为准 */
export function setRitualReleaseHandler(fn: ((at: Pt) => void) | null): void {
  ritualReleaseHandler = fn ?? (() => {})
}

/**
 * 测试用：把 host 退回未启动状态。
 * ★ 存在的理由是 `Engine` 的两台状态机是**模块级单例** ——
 *   不重置就会让上一个用例的流程状态漏进下一个，表现为"单独跑绿、一起跑红"。
 */
export function resetEngineHost(): void {
  engine = null
  booted = false
  stopTrackFlush()
  tossHandler = () => {}
  ritualReleaseHandler = () => {}
  const fresh = idleHitState()
  scene.coins = fresh.coins
  scene.tubeVisible = fresh.tubeVisible
  scene.deck = fresh.deck
  scene.memory = fresh.memory
  scene.timepiece = fresh.timepiece
}
