<script setup lang="ts">
/**
 * 小卜 · 悬浮球   src/ui/components/XiaobuOrb.vue
 * ===========================================================================
 * 小卜的**形态二**：全局悬浮球（FloatingOrb）。
 *
 *   · 微呼吸光效（CSS 动画，纯代码 0 包体）
 *   · 停留在 App 内屏幕边缘，可拖拽更换位置
 *   · 点击随时弹出小卜对话输入框（占位面板）
 *   · 弹出面板里可以「让小卜回桌边」→ 形态一
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★ 合规红线（不可逾越）★★
 * 本组件**只在 App 内部的 DOM 层**渲染（#ui-overlay 里的一个绝对定位元素）。
 * 绝不使用系统悬浮窗（Android SYSTEM_ALERT_WINDOW / iOS 越界窗口）——
 * 小卜离开画面就真的看不见了，这才是"陪伴但不打扰"的边界。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 拖拽 vs 点击的区分：位移 ≥ 6px 算拖拽（松手只吸附），否则算点击（弹对话）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ORB_MARGIN_PX, ORB_RADIUS_PX, useXiaobuFormStore } from '@store/xiaobuForm'
import { useAppFlowStore } from '@store/appFlow'
import { designToScreen, computeFit } from '@scene/renderer'
import { resetXiaobuPos, setXiaobuVisible, xiaobuAt } from '@scene/layers'
import { currentConfig } from '@bootstrap/bootSequence'
import { openEmpathy, sendEmpathy, setConsent } from '@ui/empathyChat'
import { logger } from '@shared/logger'

const store = useXiaobuFormStore()
const flow = useAppFlowStore()

const dragging = ref(false)
const pressStart = ref<{ x: number; y: number } | null>(null)
let moved = false

/** 飞入中：球的位置变化走 CSS 过渡（拖拽时则直接跟手，不加过渡） */
const flying = ref(false)

const orbStyle = computed(() => ({
  left: `${store.orb.x - ORB_RADIUS_PX}px`,
  top: `${store.orb.y - ORB_RADIUS_PX}px`,
  width: `${ORB_RADIUS_PX * 2}px`,
  height: `${ORB_RADIUS_PX * 2}px`,
}))

function onPointerDown(ev: PointerEvent): void {
  dragging.value = true
  moved = false
  pressStart.value = { x: ev.clientX, y: ev.clientY }
  try {
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  } catch {
    /* 捕获失败不影响拖拽（多数情况本来就在元素上） */
  }
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value || !pressStart.value) return
  const dx = ev.clientX - pressStart.value.x
  const dy = ev.clientY - pressStart.value.y
  if (Math.hypot(dx, dy) >= 6) moved = true
  if (moved) store.moveOrb({ x: ev.clientX, y: ev.clientY }, viewport())
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging.value || !pressStart.value) return
  dragging.value = false

  if (moved) {
    // 拖拽：松手吸附到最近的边缘
    store.snapOrbToEdge(viewport())
  } else {
    // 点击：弹/收对话
    store.toggleChat()
  }
  pressStart.value = null
  void ev
}

function onPointerCancel(): void {
  if (!dragging.value) return
  dragging.value = false
  pressStart.value = null
  if (moved) store.snapOrbToEdge(viewport())
}

/** 让小卜回桌边（形态一）。Canvas 侧复位在这里顺手做 —— UI → scene 的唯一出口 */
function backToRoom(): void {
  store.backToRoom()
  setXiaobuVisible(true)
  resetXiaobuPos()
}

// ── 启动流 · 小卜飞入（阶段 C）────────────────────────────────────────────
//   翻完书（白光盖屏的幕间）：
//   ① 画布侧小卜隐藏，球出现在屏幕右缘
//   ② 白光淡出，球带 CSS 过渡飞向桌边站位
//   ③ 到位后化回实体（画布侧复位），整个"飞入并落地"闭环完成

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight }
}

/** 小卜桌边站位的屏幕坐标（设计 → viewport px）。拿不到 canvas 时返回 null */
function homeScreenPos(): { x: number; y: number } | null {
  try {
    const c = document.querySelector('canvas')
    if (!c) return null
    const rect = c.getBoundingClientRect()
    const fit = computeFit(rect.width, rect.height, window.devicePixelRatio || 1)
    const at = xiaobuAt()
    const sp = designToScreen(at.x, at.y - 24, fit)
    return { x: rect.left + sp.x, y: rect.top + sp.y }
  } catch (e) {
    logger.warn('[orb] 站位换算失败（跳过飞入，直接落地）', e)
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function flyIn(): Promise<void> {
  const vp = viewport()
  // ① 幕间：画布藏起来，球从右缘出现
  setXiaobuVisible(false)
  resetXiaobuPos()
  store.becomeOrb({ x: vp.w - ORB_MARGIN_PX - ORB_RADIUS_PX, y: vp.h * 0.42 }, vp)

  // ② 飞向桌边：CSS 过渡接管 left/top（拖拽用的是直接赋值，互不干扰）
  await nextTick()
  flying.value = true
  const target = homeScreenPos()
  if (target) store.moveOrb(target, vp)
  await sleep(1050) // 过渡 950ms + 余量

  // ③ 落地：化回实体
  flying.value = false
  store.backToRoom()
  setXiaobuVisible(true)
  resetXiaobuPos()
  flow.markFlyInDone()
}

watch(
  () => flow.flyInPending,
  (v) => {
    if (v) void flyIn()
  },
)

// ── 共情对话 · 低语卡（本地为底 + 云端可选）─────────────────────────────────
//   面板一开就读一次同意、种一句开场；关面板即清空本轮（不做聊天记录流）

const consentAsked = ref(false)

/** 同意行：仅在云端通道开启 + 尚未同意 + 本轮还没选过时出现（不新建设置页） */
const showConsent = computed(
  () =>
    currentConfig().features.empathyCloud.enabled &&
    store.cloudConsent === 'off' &&
    !consentAsked.value,
)

watch(
  () => store.chatOpen,
  (open) => {
    if (open) openEmpathy()
    else store.clearTurn()
  },
)

function onInput(ev: Event): void {
  store.setDraft((ev.target as HTMLInputElement).value)
}

function onSend(): void {
  void sendEmpathy(store.draft)
}

function onConsent(choice: 'off' | 'on'): void {
  consentAsked.value = true
  setConsent(choice)
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') store.toggleChat(false)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <!-- 球体：v-show 由 store.mode 驱动；room 态下完全不占事件 -->
  <div v-show="store.mode === 'orb'" class="orb-layer">
    <button
      class="orb"
      :class="{ 'orb--dragging': dragging, 'orb--flying': flying }"
      :style="orbStyle"
      aria-label="小卜悬浮球"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
    >
      <span class="orb__glow" />
      <span class="orb__core">🐱</span>
    </button>

    <!-- 对话低语卡：点球弹出。上一句用户原话（淡色）+ 小卜一句回应，后到替换先到 -->
    <div v-if="store.chatOpen" class="orb-chat" :style="{ top: `${store.orb.y - 90}px` }">
      <div class="orb-chat__bubble">
        <p v-if="store.latest.mine" class="orb-chat__mine">{{ store.latest.mine }}</p>
        <p class="orb-chat__reply">{{ store.typing ? '……' : store.latest.reply }}</p>
      </div>

      <!-- 首次同意行：让小卜想得更远（会把你说的话发给它）。★ 独立同意通道，不进解读白名单 -->
      <div v-if="showConsent" class="orb-chat__consent">
        <p class="orb-chat__consent-text">让小卜想得更远（会把你说的话发给它）</p>
        <div class="orb-chat__consent-row">
          <button class="orb-chat__consent-btn orb-chat__consent-btn--on" @click="onConsent('on')">好</button>
          <button class="orb-chat__consent-btn" @click="onConsent('off')">先这样</button>
        </div>
      </div>

      <div class="orb-chat__row">
        <input
          class="orb-chat__input"
          type="text"
          placeholder="跟小卜说句话…"
          :value="store.draft"
          @input="onInput"
          @keydown.enter.prevent="onSend"
        />
        <button class="orb-chat__send" aria-label="发送" @click="onSend">➤</button>
      </div>
      <button class="orb-chat__back" @click="backToRoom">让小卜回桌边</button>
    </div>
  </div>
</template>

<style scoped>
.orb-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.orb {
  position: absolute;
  border: none;
  padding: 0;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, #ffffff, var(--c-cream-warm) 58%, var(--c-matcha));
  box-shadow: 0 3px 14px rgba(122, 92, 66, 0.22);
  cursor: grab;
  pointer-events: auto;
  touch-action: none;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.orb--dragging {
  cursor: grabbing;
  transform: scale(1.08);
}

/* 飞入：left/top 走贝塞尔过渡（拖拽时不加此类，位置直接跟手） */
.orb--flying {
  cursor: default;
  transition:
    left 950ms cubic-bezier(0.35, 0.1, 0.3, 1),
    top 950ms cubic-bezier(0.35, 0.1, 0.3, 1);
}

/* 微呼吸光效：外圈柔光缓慢涨缩，周期 3.1s 与屋内呼吸同拍 */
.orb__glow {
  position: absolute;
  inset: -7px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 200, 140, 0.4), rgba(255, 200, 140, 0));
  animation: orb-breathe 3.1s ease-in-out infinite;
}

.orb__core {
  font-size: 20px;
  line-height: 1;
}

@keyframes orb-breathe {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.94);
  }
  50% {
    opacity: 1;
    transform: scale(1.06);
  }
}

/* 对话占位面板：跟随球的纵向位置，横向靠屏幕内侧 */
.orb-chat {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: min(300px, calc(100vw - 48px));
  padding: 12px;
  border-radius: var(--r-card);
  background: linear-gradient(135deg, var(--c-wood-tag), var(--c-cream-warm));
  box-shadow: 0 4px 18px rgba(122, 92, 66, 0.2);
  pointer-events: auto;
  z-index: 41;
}

.orb-chat__bubble {
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 用户上一句：淡色、靠右，像余音 */
.orb-chat__mine {
  margin: 0;
  align-self: flex-end;
  max-width: 88%;
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-ink-2);
  opacity: 0.7;
  text-align: right;
}

/* 小卜的回应：主色、靠左，一句 ≤34 字 */
.orb-chat__reply {
  margin: 0;
  align-self: flex-start;
  max-width: 92%;
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-ink);
}

/* 首次同意行 */
.orb-chat__consent {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 12px;
  background: rgba(66, 60, 82, 0.05);
}

.orb-chat__consent-text {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--c-ink-2);
}

.orb-chat__consent-row {
  display: flex;
  gap: 8px;
}

.orb-chat__consent-btn {
  flex: 1;
  height: 30px;
  border: 1px solid rgba(66, 60, 82, 0.12);
  border-radius: 999px;
  background: var(--c-cream);
  color: var(--c-ink-2);
  font-size: 12px;
  cursor: pointer;
}

.orb-chat__consent-btn--on {
  background: var(--c-matcha);
  color: var(--c-ink);
  border-color: transparent;
}

.orb-chat__row {
  display: flex;
  gap: 8px;
}

.orb-chat__input {
  flex: 1;
  height: 36px;
  border: 1px solid rgba(66, 60, 82, 0.12);
  border-radius: 999px;
  padding: 0 14px;
  background: var(--c-cream);
  font-size: 13px;
  color: var(--c-ink);
  outline: none;
}

.orb-chat__send {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: var(--c-matcha);
  cursor: pointer;
}

.orb-chat__back {
  margin-top: 8px;
  width: 100%;
  height: 30px;
  border: none;
  background: none;
  color: var(--c-ink-2);
  font-size: 12px;
  cursor: pointer;
}
</style>
