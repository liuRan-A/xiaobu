<script setup lang="ts">
/**
 * 小卜 · 翻书启动流   src/ui/components/IntroBook.vue
 * ===========================================================================
 * AppState.Intro_Book：一本旧书盖在小屋上。翻页后白光漫反射，切入 Room_Main。
 *
 *   · 拖拽书页向左 → 贝塞尔卷曲（rotateY 绕书脊 + 双面 + 明暗渐变）
 *   · 长按书页 600ms → 自动翻页
 *   · 松手过半（0.55）→ 翻完；否则回弹
 *   · 翻完 → 纸张沙沙声（WebAudio 程序化合成，0 包体）→ 白光升起 → emit('entered')
 *
 * ★ 首帧铁律：本组件是纯 DOM overlay，挂载即可见 —— 不碰 bootSequence 的同步时序，
 *   底下 Canvas 照常首帧画出小屋（被书盖住而已）。JS 全挂时书还在，奶油底兜底不变。
 *
 * ★ 视觉：旧书 = 黄昏紫布面 + 烫金褪色书名 + 纸页奶白；所有质感纯 CSS 渐变，0 图片。
 * ===========================================================================
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { clampProgress, flipEase, progressFromDrag, shouldCommitFlip } from '@ui/introFlip'
import { playPaperRustle } from '@ui/paperSound'
import { logger } from '@shared/logger'

const emit = defineEmits<{ entered: [] }>()

/** 翻页进度 0..1（0 合上，1 翻完） */
const progress = ref(0)
const dragging = ref(false)
/** 翻完后的白光漫反射 0..1 */
const veil = ref(0)
/** 翻完了（不再接受输入） */
const finished = ref(false)

const bookEl = ref<HTMLElement | null>(null)

let startX = 0
let pageWidth = 300
let longPressTimer: ReturnType<typeof setTimeout> | null = null
let rafId: number | null = null

/** 卷曲角：0（合上）→ -180（翻过书脊）。rotateY 绕左缘书脊 */
const angle = computed(() => -progress.value * 180)
/** 页面明暗：翻得越立起来，正面越背光 */
const frontShade = computed(() => Math.sin(progress.value * Math.PI) * 0.38)
const backShade = computed(() => Math.sin((1 - progress.value) * Math.PI) * 0.3)

function pageWidthOf(): number {
  const el = bookEl.value
  return el ? el.getBoundingClientRect().width : 300
}

function onPointerDown(ev: PointerEvent): void {
  if (finished.value || dragging.value) return
  dragging.value = true
  startX = ev.clientX
  pageWidth = pageWidthOf()
  try {
    ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
  } catch {
    /* 捕获失败不影响拖拽 */
  }
  // 长按自动翻页：按住不动 600ms 也算"想翻"
  longPressTimer = setTimeout(() => {
    if (dragging.value && !finished.value) completeFlip()
  }, 600)
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value || finished.value) return
  progress.value = progressFromDrag(startX, ev.clientX, pageWidth)
}

function onPointerUp(): void {
  if (!dragging.value || finished.value) return
  dragging.value = false
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  if (shouldCommitFlip(progress.value)) completeFlip()
  else cancelFlip()
}

function onPointerCancel(): void {
  if (!dragging.value) return
  dragging.value = false
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  cancelFlip()
}

/** 翻完：贝塞尔收尾 + 纸声 + 白光 + 交棒 */
function completeFlip(): void {
  if (finished.value) return
  finished.value = true
  playPaperRustle()
  animateTo(1, 420, () => {
    // 白光漫反射升起，盖住"书 → 小屋"的切换，然后交棒
    animateVeil(350, () => {
      emit('entered')
    })
  })
}

/** 回弹：不够半页，纸页落回 */
function cancelFlip(): void {
  animateTo(0, 300, () => {
    finished.value = false
  })
}

function animateTo(target: number, ms: number, onDone: () => void): void {
  if (rafId !== null) cancelAnimationFrame(rafId)
  const from = progress.value
  const t0 = performance.now()
  const step = (now: number): void => {
    const t = clampProgress((now - t0) / ms)
    progress.value = from + (target - from) * flipEase(t)
    if (t < 1) rafId = requestAnimationFrame(step)
    else {
      rafId = null
      try {
        onDone()
      } catch (e) {
        // ★ 门禁 ⑨：交棒出错也不能把用户留在白屏上 —— 直接放行进屋
        logger.warn('[intro] 翻页收尾异常（放行进屋）', e)
        emit('entered')
      }
    }
  }
  rafId = requestAnimationFrame(step)
}

function animateVeil(ms: number, onDone: () => void): void {
  const t0 = performance.now()
  const step = (now: number): void => {
    const t = clampProgress((now - t0) / ms)
    veil.value = t
    if (t < 1) requestAnimationFrame(step)
    else onDone()
  }
  requestAnimationFrame(step)
}

onBeforeUnmount(() => {
  if (longPressTimer !== null) clearTimeout(longPressTimer)
  if (rafId !== null) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="intro" role="dialog" aria-label="翻开小卜">
    <!-- 羊皮暗房：书背后的环境光 -->
    <div class="intro__room" />

    <div ref="bookEl" class="book" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel">
      <!-- 底页：翻开后露出的衬页 -->
      <div class="page page--under">
        <span class="under__mark">小 卜</span>
        <span class="under__note">陪着你，慢慢来。</span>
      </div>

      <!-- 活动页：正面封面 / 背面衬页，绕书脊卷曲 -->
      <div class="page page--live" :style="{ transform: `rotateY(${angle}deg)` }">
        <div class="face face--front" :style="{ filter: `brightness(${1 - frontShade})` }">
          <span class="cover__title">小卜</span>
          <span class="cover__sub">一本关于陪伴的小书</span>
          <span class="cover__orn">✦</span>
        </div>
        <div class="face face--back" :style="{ filter: `brightness(${1 - backShade})` }">
          <span class="back__text">今天，也翻开了。</span>
        </div>
      </div>

      <!-- 书脊阴影 -->
      <div class="book__spine" />
    </div>

    <p class="intro__hint">轻轻向左拖动书页，或长按</p>

    <!-- 白光漫反射：盖住"书 → 小屋"的换景 -->
    <div class="intro__veil" :style="{ opacity: veil }" />
  </div>
</template>

<style scoped>
.intro {
  position: absolute;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  /* 暗房底：比小屋暗一档，让书"亮"出来 */
  background: radial-gradient(120% 90% at 50% 38%, #4a3d63 0%, #33294a 58%, #241d38 100%);
}

/* 旧书：布面精装，书页微厚 */
.book {
  position: relative;
  width: min(62vw, 250px);
  aspect-ratio: 3 / 4;
  perspective: 1400px;
  cursor: grab;
  touch-action: none;
}

.book:active {
  cursor: grabbing;
}

.page {
  position: absolute;
  inset: 0;
  border-radius: 6px 14px 14px 6px;
}

/* 底页（衬页）：翻开后露出来 */
.page--under {
  background: linear-gradient(160deg, var(--c-cream-warm), var(--c-wood-tag));
  box-shadow: inset 0 0 40px rgba(122, 92, 66, 0.18);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.under__mark {
  font-size: 22px;
  letter-spacing: 0.5em;
  margin-left: 0.5em;
  color: var(--c-ink);
}

.under__note {
  font-size: 12px;
  color: var(--c-ink-2);
}

/* 活动页：双面，绕左缘书脊旋转 */
.page--live {
  transform-origin: left center;
  transform-style: preserve-3d;
  will-change: transform;
}

.face {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  backface-visibility: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

/* 封面：黄昏紫布面 + 褪色烫金 */
.face--front {
  background: linear-gradient(150deg, var(--c-dusk) 0%, var(--c-dusk-deep) 70%, var(--c-dusk-hill) 100%);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}

.cover__title {
  font-size: 30px;
  letter-spacing: 0.4em;
  margin-left: 0.4em;
  color: var(--c-gold);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.12);
}

.cover__sub {
  font-size: 11px;
  color: rgba(232, 199, 127, 0.75);
}

.cover__orn {
  font-size: 14px;
  color: rgba(232, 199, 127, 0.6);
}

/* 封面背面：纸页 */
.face--back {
  transform: rotateY(180deg);
  background: linear-gradient(200deg, var(--c-cream-warm), var(--c-cream));
  box-shadow: inset 0 0 30px rgba(122, 92, 66, 0.14);
}

.back__text {
  font-size: 13px;
  color: var(--c-ink-2);
}

/* 书脊：一条深色缝，暗示"这是本装订的书" */
.book__spine {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 8px;
  border-radius: 6px 0 0 6px;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.28), rgba(0, 0, 0, 0));
  pointer-events: none;
}

.intro__hint {
  font-size: 12px;
  letter-spacing: 0.12em;
  color: rgba(232, 199, 127, 0.65);
}

/* 白光：奶白偏暖，像窗光瞬间灌满 */
.intro__veil {
  position: absolute;
  inset: 0;
  z-index: 70;
  background: radial-gradient(100% 100% at 50% 45%, #fffdf8 0%, var(--c-sunbeam-soft) 100%);
  pointer-events: none;
}
</style>
