<script setup lang="ts">
/**
 * 小卜 · 场景组件   src/scene/Scene.vue
 * ===========================================================================
 * 这一层**只做胶水**，一共六件事：
 *   ① 提供一块铺满的 canvas
 *   ② 装配场景（layers/index 的 L1–L9）→ 交给 CanvasRenderer
 *   ③ 把掷币动效层（`ritual/RitualFx`）挂进同一个渲染栈，并把它的
 *      起飞 / 落位回调交给 `engineHost` —— 那是"画面"与"玩法"握手的唯一接口
 *   ④ 把浏览器的 resize / visibilitychange 转成渲染器的 resize / pause / resume
 *   ⑤ **把画布上的手指与每帧心跳搬运给引擎**（不解读，只搬运）
 *   ⑥ 卸载时干净地 dispose（rAF、监听器、离屏缓存、动效层一个都不留）
 *
 * 画面怎么画、谁盖住谁、坐标怎么换算 —— 一概不在这里。
 *   · 想改"看起来什么样"  → layers/
 *   · 想改"前后关系与适配" → renderer/
 *   · 想改"什么时候画"     → 这里
 *   · 想改"点了算戳到什么" → scene/hit/（命中层）+ core/engine（决定怎么回应）
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  ★ 为什么手指的事情要经过这里
 * ───────────────────────────────────────────────────────────────────────────
 *  引擎要的是**设计坐标**（390 × 844 那张画布上的点），而浏览器给的是
 *  viewport 里的 clientX/Y，中间隔着一层"等比铺满 + 居中留边"的适配盒。
 *  这一层恰好拥有 canvas 元素与 `renderer.fitBox`，所以换算在这里做，
 *  引擎那边永远只看到 0–390 / 0–844 的数字 —— 它从来不知道屏幕有多宽。
 *
 *  ★ 引擎不在这里 new，也不在这里 dispose
 *  它比画布活得久（面板按钮也要用它），由 `@store/engineHost` 持有。
 *  Scene 只负责**喂它**：手势与心跳。这样"切一次页面"不会把用户
 *  刚摆好的东西和正在等的日子一起清掉。
 *
 * ★ 防崩门禁 ⑨：本文件内所有 catch 只调 handle() / logger.warn()，绝不 alert / Toast。
 * ★ 防崩兜底：canvas 的底色写在 CSS 里（--c-cream）。即使 JS 全挂、context 拿不到、
 *   渲染栈一个图层都没画出来，用户看到的也是暖奶油色 —— 绝不会是白屏。
 * ===========================================================================
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { CanvasRenderer, designToScreen, screenToDesign } from '@scene/renderer'
import {
  createSceneStack,
  resetXiaobuPos,
  setCardFaceTex,
  setDeckBackTex,
  setMemoryItems,
  setPendingMemory,
  setXiaobuPos,
  setXiaobuVisible,
  setTimepieces,
  xiaobuAt,
  xiaobuVisibleNow,
} from '@scene/layers'
import { dropOutcome, followDrag, hitXiaobu, isDrag } from '@scene/xiaobuDrag'
import { useXiaobuFormStore } from '@store/xiaobuForm'
import { createRitualFx, type RitualFx } from '@scene/ritual/RitualFx'
import { createTexLoader } from '@services/tex'
import { CORE_FACE_URLS } from '@services/tex/tarotPath'
import { getCardBySlug } from '@core/tarot/cardsIndex'
import backUrl from '@assets/tarot/back.webp'
import { handle } from '@shared/errors/handle'
import { logger } from '@shared/logger'
import {
  bootEngine,
  flushEngine,
  getEngine,
  sceneState,
  setLiveCoins,
  setRitualReleaseHandler,
  setTossHandler,
  tickEngine,
} from '@store/engineHost'
import type { PointerSample } from '@core/gesture'
import type { Pt } from '@core/ritual/flight'
import type { MemoryKind } from '@core/memory/memoryAnchor'

const canvasRef = ref<HTMLCanvasElement | null>(null)

/** 小卜拖拽会话（阶段 B · 双形态）。非 null = 手指正按在小卜身上，事件不再转发引擎 */
let xiaobuDrag: { pointerId: number; start: Pt; last: Pt; moved: boolean } | null = null
/**
 * 摆件拖拽会话（共创摆件链路 · MEMORY_PLACE 态）。
 * 非 null = 用户刚长按完候选卡，手指正带着摆件在小屋里找位置。
 * 与 xiaobuDrag 互斥（同一时刻只能拖一个东西）。
 */
let memoryDrag: { pointerId: number; kind: MemoryKind } | null = null
const xiaobuForm = useXiaobuFormStore()

let renderer: CanvasRenderer | null = null
/** 掷币动效层。★ 与画布同生命周期 —— 它注册进渲染栈，画布没了它就无处可画 */
let ritualFx: RitualFx | null = null
let resizeObserver: ResizeObserver | null = null
/** 当前按在屏幕上的触点 id（-1 = 没有手指）。单指场景，多指时只认第一根 */
let activePointerId = -1

// ───────────────────────────────────────────────────────────────────────────
// 坐标：client 坐标 → 设计坐标
// ───────────────────────────────────────────────────────────────────────────

/**
 * 把一次指针事件换算成设计坐标上的采样。
 *
 * ★ 拿不到适配盒时返回 `null` 而不是 (0,0)：
 *   丢一次事件只是这一次手势没被识别，而伪造一个 (0,0) 会被引擎
 *   当成"用户在左上角按了一下" —— 那是**错误输入**，比没有输入更糟。
 */
function sampleOf(ev: PointerEvent, t: number): PointerSample | null {
  const el = canvasRef.value
  const r = renderer
  if (!el || !r) return null

  // ★ 用 getBoundingClientRect 而不是 offsetX/offsetY：
  //   offsetX 在 pointer capture、系统手势打断、WebView 缩放之后会给出
  //   "相对**事件目标**"的值，而事件目标不一定是 canvas。
  const rect = el.getBoundingClientRect()
  const d: Pt = screenToDesign(ev.clientX - rect.left, ev.clientY - rect.top, r.fitBox)
  return { id: 0, x: d.x, y: d.y, t }
}

/** 采样时刻。★ 用 performance.now()：单调，不会因为用户改了系统时间而让速度变负 */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// ───────────────────────────────────────────────────────────────────────────
// 搬运：指针 → 引擎
// ───────────────────────────────────────────────────────────────────────────

function onPointerDown(ev: PointerEvent): void {
  if (activePointerId !== -1) return // 已经有手指按着，忽略后来者
  const s = sampleOf(ev, nowMs())
  if (!s) return

  // ── 小卜拖拽拦截（阶段 B · 双形态）──────────────────────────────────
  //   按在小卜身上 → 开启拖拽会话，事件**不进引擎**：
  //   形态切换是 UI 层生命周期，不是流程语义（见 xiaobuDrag.ts 头注）。
  if (xiaobuVisibleNow() && hitXiaobu(s, xiaobuAt())) {
    xiaobuDrag = { pointerId: ev.pointerId, start: { x: s.x, y: s.y }, last: { x: s.x, y: s.y }, moved: false }
    try {
      canvasRef.value?.setPointerCapture(ev.pointerId)
    } catch {
      /* 捕获失败不影响拖拽 */
    }
    return
  }

  // ── 摆件拖拽接管（共创摆件链路 · MEMORY_PLACE 态）──────────────────────
  //   用户刚长按完候选卡（MemoryOfferCard.vue 触发 offerMemory 后 dispatch
  //   了一次虚拟 pointerdown 给 canvas）。此时 engine 已进 MEMORY_PLACE 且
  //   pendingDraft 已生成（engine.ts:469-474）。这里开 memoryDrag，摆件落在
  //   手指位置；后续 move/up 由本组件处理，不进 engine.handleGesture
  //   （engine.handleGesture 的 RELEASE 分支没处理 MEMORY_PLACE，所以必须
  //   由 UI 自己接 —— 见计划文件 Step 3）。
  if (memoryDrag === null) {
    try {
      const eng = getEngine()
      if (eng.roomState === 'MEMORY_PLACE') {
        const draft = eng.pendingMemory
        if (draft) {
          memoryDrag = { pointerId: ev.pointerId, kind: draft.kind }
          setPendingMemory({ kind: draft.kind, at: { x: s.x, y: s.y } })
          try {
            canvasRef.value?.setPointerCapture(ev.pointerId)
          } catch {
            /* 捕获失败不影响拖拽 */
          }
          return
        }
      }
    } catch (e) {
      // ★ 门禁 ⑨：进 MEMORY_PLACE 失败只记日志，不会让画布崩
      logger.warn('[scene] 开启摆件拖拽失败（已忽略）', e)
    }
  }

  activePointerId = ev.pointerId

  // ★ setPointerCapture：手指滑出 canvas 边界（滑到留边、滑到系统返回区）时
  //   仍能收到 move/up。不做这一步，一次"往上滑掷币"会在划出画布的瞬间断掉，
  //   表现为"甩到一半就没反应了"。
  try {
    canvasRef.value?.setPointerCapture(ev.pointerId)
  } catch {
    /* 捕获失败不影响后续事件（多数情况本来就还在 canvas 内） */
  }

  try {
    getEngine().pointerDown(s)
  } catch (e) {
    // ★ 门禁 ⑨：输入链上的异常只记日志。用户的这一下没被理解，但他不该看到报错。
    logger.warn('[scene] pointerDown 处理异常（已忽略）', e)
  }
}

function onPointerMove(ev: PointerEvent): void {
  // ── 小卜拖拽中：脚底跟手（设计坐标），不进引擎 ──
  if (xiaobuDrag && ev.pointerId === xiaobuDrag.pointerId) {
    const s = sampleOf(ev, nowMs())
    if (!s) return
    xiaobuDrag.last = { x: s.x, y: s.y }
    if (isDrag(xiaobuDrag.start, xiaobuDrag.last)) xiaobuDrag.moved = true
    setXiaobuPos(followDrag(xiaobuDrag.last))
    return
  }
  // ── 摆件拖拽中：摆件跟手，不进引擎 ──
  if (memoryDrag && ev.pointerId === memoryDrag.pointerId) {
    const s = sampleOf(ev, nowMs())
    if (!s) return
    setPendingMemory({ kind: memoryDrag.kind, at: { x: s.x, y: s.y } })
    return
  }
  if (ev.pointerId !== activePointerId) return
  const s = sampleOf(ev, nowMs())
  if (!s) return
  try {
    getEngine().pointerMove(s)
  } catch (e) {
    logger.warn('[scene] pointerMove 处理异常（已忽略）', e)
  }
}

function onPointerUp(ev: PointerEvent): void {
  // ── 小卜拖拽收尾：回桌边 or 化悬浮球 ──
  if (xiaobuDrag && ev.pointerId === xiaobuDrag.pointerId) {
    const { start, last, moved } = xiaobuDrag
    xiaobuDrag = null
    if (moved) {
      if (dropOutcome(start, last) === 'orb') {
        // 化球：画布侧隐藏；球从手指松开处出现（设计坐标 → viewport px）
        setXiaobuVisible(false)
        const r = renderer
        const rect = canvasRef.value?.getBoundingClientRect()
        if (r && rect) {
          const sp = designToScreen(last.x, last.y, r.fitBox)
          xiaobuForm.becomeOrb({ x: rect.left + sp.x, y: rect.top + sp.y }, { w: window.innerWidth, h: window.innerHeight })
        }
      } else {
        // 拖了又拖回来了：弹回美术稿站位
        resetXiaobuPos()
      }
    } else {
      // 点了一下（没拖动）：不切换形态，弹回原位即可
      resetXiaobuPos()
    }
    return
  }
  // ── 摆件拖拽收尾：落在手指位置（engine 自己 saveMemory + 发 PLACE_MEMORY）──
  if (memoryDrag && ev.pointerId === memoryDrag.pointerId) {
    memoryDrag = null
    const s = sampleOf(ev, nowMs())
    setPendingMemory(null)
    if (s) {
      try {
        // ★ placeMemoryAt 内部走 placeAt + saveMemory + 发 PLACE_MEMORY 退回 ROOM
        //   catch 块内禁出 UI（门禁 ⑨），放不下当没放，流程继续
        getEngine().placeMemoryAt(s)
      } catch (e) {
        logger.warn('[scene] placeMemoryAt 异常（已忽略）', e)
      }
    }
    return
  }
  if (ev.pointerId !== activePointerId) return
  activePointerId = -1
  const s = sampleOf(ev, nowMs())
  if (!s) return
  try {
    getEngine().pointerUp(s)
  } catch (e) {
    logger.warn('[scene] pointerUp 处理异常（已忽略）', e)
  }
}

/**
 * 手势被系统打断（来电、通知下拉、多任务手势）。
 * ★ 必须把 CANCEL 送给引擎，否则它会一直停在"有手指按着"的状态 ——
 *   下一次轻点会被当成"同一根手指没松开"，于是**第一次点击永远没反应**。
 */
function onPointerCancel(ev: PointerEvent): void {
  // 小卜拖拽被系统打断：就地放弃，小卜停在当前位置（回桌边交给下次操作）
  if (xiaobuDrag && ev.pointerId === xiaobuDrag.pointerId) {
    xiaobuDrag = null
    return
  }
  // 摆件拖拽被系统打断：清掉手指上的摆件，流程态保留（用户可重新长按候选）
  if (memoryDrag && ev.pointerId === memoryDrag.pointerId) {
    memoryDrag = null
    setPendingMemory(null)
    return
  }
  if (ev.pointerId !== activePointerId) return
  activePointerId = -1
  try {
    getEngine().pointerCancel(nowMs())
  } catch (e) {
    logger.warn('[scene] pointerCancel 处理异常（已忽略）', e)
  }
}

/**
 * 事件监听统一挂/摘。
 * ★ 逐个列出、不放进数组循环：`addEventListener('pointerdown', fn)` 的重载能让
 *   TS 推断出 `fn` 收的是 `PointerEvent`；一旦装进 `[string, EventListener]` 数组，
 *   类型就退化成"收 Event 的函数"，四个处理函数全部要手写断言 ——
 *   而断言正是"以后签名改了也没人拦"的入口。
 */
function bindPointer(el: HTMLCanvasElement): void {
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerCancel)
}

function unbindPointer(el: HTMLCanvasElement): void {
  el.removeEventListener('pointerdown', onPointerDown)
  el.removeEventListener('pointermove', onPointerMove)
  el.removeEventListener('pointerup', onPointerUp)
  el.removeEventListener('pointercancel', onPointerCancel)
}

// ───────────────────────────────────────────────────────────────────────────
// 摇晃掷币（三种掷出手势之三）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 加速度 → 引擎。
 *
 * ★ `accelerationIncludingGravity` 的模长在**静止时就是 1g**（重力本身）。
 *   直接把它送进去，等于"手机一直处于 1g 的持续加速度"，引擎的
 *   `SHAKE_G = 1.6` 判定会被这个底噪一路顶到临界；所以先减掉 1g 再取绝对值，
 *   得到的是"用户真的晃了多狠"。
 *
 * ★ 这里**不做灵敏度换算，也不做防抖** —— 阈值、持续时长、冷却三件事
 *   都在 `core/gesture.ts` 里（`SHAKE_G` / `SHAKE_HOLD_MS` / `SHAKE_COOLDOWN_MS`）。
 *   放两份必然漂移，而漂移的后果是"晃动有时灵有时不灵"，极难定位。
 *
 * ★ iOS 需要 `DeviceMotionEvent.requestPermission()` 且必须由用户手势触发，
 *   属于 M3 的平台适配；这里在拿不到事件时静默放弃 —— 摇晃只是**三种**
 *   掷出手势之一，上滑与甩出照常可用，所以少一种不构成功能缺失。
 */
function onDeviceMotion(ev: DeviceMotionEvent): void {
  const a = ev.accelerationIncludingGravity
  if (!a) return
  const g = Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0)
  try {
    getEngine().motion(Math.abs(g - 1), nowMs())
  } catch (e) {
    logger.warn('[scene] deviceMotion 处理异常（已忽略）', e)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 画布生命周期
// ───────────────────────────────────────────────────────────────────────────

function onWindowResize(): void {
  // 适配盒重算：DPR / 旋转 / 分屏 / 软键盘弹起都会走到这里
  renderer?.resize()
}

function onVisibilityChange(): void {
  const r = renderer
  if (!r) return
  // ★ 进后台停 rAF：省电，也避开"回前台时两帧间隔几十秒"导致的动画瞬移
  if (document.hidden) {
    r.pause()
    // 顺手把脏数据落下去：用户切走后再回来可能已经是另一天了，
    // 而"关掉前刚放的摆件"必须已经在磁盘上。★ 不 await，切后台不能等 I/O。
    void flushEngine()
  } else {
    r.resume()
  }
}

onMounted(() => {
  const el = canvasRef.value
  if (!el) {
    // 正常渲染流程里不会走到这；走到了也只是没有画面，根容器的奶油底仍然兜住
    logger.warn('[scene] canvas element not mounted; DOM cream background stands in')
    return
  }

  // ── 贴图预热（M3 混合渲染 · 贴图路径）───────────────────────────────────
  //   TexLoader 有界 LRU 加载卡背与主包牌面样张，就绪后喂给 L4Props。
  //   失败/未就绪 → 对应贴图保持缺省 → 走程序化占位（正常路径，非错误）。
  const texLoader = createTexLoader()
  texLoader
    .ensure(backUrl)
    .then((src) => {
      if (src) setDeckBackTex(src)
    })
    .catch((e) => handle(e, 'scene.texture'))

  for (const [slug, url] of Object.entries(CORE_FACE_URLS)) {
    const card = getCardBySlug(slug)
    if (!card) continue
    texLoader
      .ensure(url)
      .then((src) => {
        if (src) setCardFaceTex(card.id, src)
      })
      .catch((e) => handle(e, 'scene.texture'))
  }

  try {
    const stack = createSceneStack()

    // ── 掷币动效接线（顺序有讲究）────────────────────────────────────────
    //   ① 先建动效层：它往 `stack` 里注册 8 个图层。放在 `renderer.start()` 之前，
    //      于是**第一帧就已经有这些图层**，不会出现"第一秒没有涟漪"。
    //   ② `attach()` **先于**任何回调注册：`bootEngine()` 期间仪式机可能同步发指令
    //      （进入 IDLE 的呼吸 / 发光），指令汇还没接上的话那一条就丢了 ——
    //      丢了只是第一帧少画一点，但"能不能接上"不该靠运气。
    //   ③ 两个回调都是"core 判不了、只有场景层知道"的事：
    //      `onToss` 要手势的力度与方向，`onDrop` 要竹筒在屏幕上的位置。
    //   ④ `onLiveCoins` 把"铜钱此刻在哪"每帧喂给命中层 —— 不喂的话，
    //      一枚已落进槽里的币，点击判定还停在它待机的位置。
    ritualFx = createRitualFx({ stack, onLiveCoins: setLiveCoins })
    ritualFx.attach()
    setTossHandler(ritualFx.onToss)
    setRitualReleaseHandler(ritualFx.onDrop)

    renderer = new CanvasRenderer(el, {
      stack,
      // ★ 每帧一次，两件事，顺序固定：
      //   ① `tickEngine()` —— **玩法**心跳。用的是墙上时钟（`Engine` 自己的 nowFn），
      //      因为倒计时要算到"今天"；喂渲染时钟会把日历日算到 1970 年。
      //   ② `ritualFx.onFrame(frame)` —— **画面**心跳。用的是 `frame.t`（自启动累计毫秒），
      //      因为轨迹、拖尾、涟漪都是"这一帧该画成什么样"。
      //      它内部还会在到点时向仪式机上**回**一个 LANDED（唯一一处"画面驱动玩法"），
      //      所以必须在绘制之前跑完 —— 这一帧画出来的才是这一帧算完的样子。
      onFrame: (frame) => {
        tickEngine()
        ritualFx?.onFrame(frame)
        // ★ 沙漏位置每帧同步：倒计时摆件由引擎持有（要落盘），渲染层只画。
        //   `tickEngine` 已把 countdownOrnaments 喂进 scene.timepiece，这里转交给渲染层。
        setTimepieces(sceneState().timepiece.map((t) => ({ x: t.at.x, y: t.at.y })))
        // ★ 摆件每帧同步：记忆锚点由引擎持有（要落盘、有上限、归零会多出纪念品），
        //   渲染层只画。memoryAnchors 是只读视图（零计算），见 engine.ts:652-654
        try {
          const eng = getEngine()
          setMemoryItems(
            eng.memoryAnchors.map((m) => ({ id: m.id, kind: m.kind, at: { x: m.at.x, y: m.at.y } })),
          )
        } catch (e) {
          // ★ 门禁 ⑨：引擎没起来也只是没摆件可画，房间照常显示
          logger.warn('[scene] 同步摆件失败（已忽略）', e)
        }
      },
    })
    renderer.start()

    // ★ 输了：画布先跑起来（用户立刻看见小屋），引擎再异步读磁盘。
    //   反过来的话，一块 5KB 的本地数据会挡住首帧 —— 那是"为了我的记忆，
    //   让你先看两秒白屏"，完全不符合"零门槛"。
    void bootEngine().catch((e) => logger.warn('[scene] 引擎启动失败（房间仍可浏览）', e))

    bindPointer(el)
    window.addEventListener('resize', onWindowResize)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('devicemotion', onDeviceMotion)

    // ResizeObserver 比 window.resize 更准：容器尺寸变化（分屏、WebView 调整）它也能捕到
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onWindowResize)
      resizeObserver.observe(el)
    }
  } catch (e) {
    // ★ 门禁 ⑨：装配失败只记一条日志。画布区域保持 CSS 的奶油底色，不弹任何提示。
    //   致命分支（清离屏缓存 → 重挂）由 shared/errors/handle.ts 的 applyRecovery 接管。
    handle(e, 'scene.render')
  }
})

onBeforeUnmount(() => {
  const el = canvasRef.value
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('devicemotion', onDeviceMotion)
  if (el) unbindPointer(el)
  activePointerId = -1
  xiaobuDrag = null
  memoryDrag = null
  setPendingMemory(null)

  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }

  // ★ 卸载前落盘一次。引擎**不 dispose**（它比画布活得久），
  //   所以这里只交还"我刚放下的东西"，而不是把房间清空。
  void flushEngine()

  // 动效层与画布一起走：它注册在渲染栈里，栈没了它留着只会占内存。
  // ★ 必须**先摘回调再 detach** —— 反过来的话，detach 与摘回调之间那一小段里
  //   若恰好有一次指针事件到达，回调会去调一个已经 reset 过的引擎。
  setTossHandler(null)
  setRitualReleaseHandler(null)
  ritualFx?.detach()
  ritualFx = null

  renderer?.dispose()
  renderer = null
})

/**
 * 供 M2 的仪式引擎与 DevPanel 使用：
 *   Scene 暴露"怎么拿到渲染器"，而不是暴露渲染器本身 ——
 *   后者会在 setup 阶段固化成一个 null 快照。
 */
defineExpose({
  getRenderer: (): CanvasRenderer | null => renderer,
})
</script>

<template>
  <!--
    唯一职责：提供一块铺满、且永远有底色的画布。
    aria-hidden：这是纯装饰性场景，读屏软件不需要它；无障碍内容在 DOM overlay 里。
  -->
  <canvas ref="canvasRef" class="scene-canvas" aria-hidden="true" />
</template>

<style scoped>
.scene-canvas {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: block;
  width: 100%;
  height: 100%;
  /*
   * ★ 自己接手势：Canvas 是手势的唯一入口（App.vue 的 overlay 默认 pointer-events:none）。
   *   touch-action: none 禁掉浏览器的滚动/双击缩放/下拉刷新 —— 否则"上滑掷币"
   *   会被浏览器读成"滚动页面"，手势还没到引擎就被吃掉了。
   */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  /*
   * ★ 防崩第一道防线（写死在 CSS，不依赖任何 JS）：
   *   即使脚本抛错、2D context 拿不到、渲染栈空转，这一层也是暖奶油色。
   *   与 App.vue 的 .app-root、index.html 的 html/body 一起构成三重底色兜底。
   */
  background: var(--c-cream, #fdf9f6);
}
</style>
