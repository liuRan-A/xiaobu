<script setup lang="ts">
/**
 * 小卜 · 浮现卡   src/ui/components/MemoryRecallCard.vue
 * ===========================================================================
 * MEMORY_RECALL 态：用户点击小屋里的摆件 → 优雅浮现"低语卡"
 *   日期 + 当时那句话（如「2026 年 10 月 10 日，你选择了这盆绿植，决定重新出发」）。
 *
 * ★ 战略原文：「点击摆件，**优雅浮现**当时的记录」—— 不是弹窗、不是模态、不遮小屋。
 *   卡片浮在小卜旁边，**点卡片外的画布任意位置**就优雅淡出回待机。
 *
 * ★ 卡片外的轻点由 engine.handleTap 已处理（engine.ts:772-775 调 closeRecall），
 *   本组件只负责"按 phase 画卡"，不接收任何 pointer 事件 —— 让 canvas 收。
 *
 * ★ 相位（memoryCard.phase）：
 *   hidden → appearing → shown → fading → hidden
 *   时间推进由 engine.tickCard() 在 engine.tick() 内做（按 MEMORY_CARD_APPEAR_MS /
 *   MEMORY_CARD_FADE_MS）。本组件每 100ms 读一次 phase 切 class，CSS transition
 *   做平滑过渡 —— UI 不必自己计算 phaseProgress。
 * ===========================================================================
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getEngine } from '@store/engineHost'
import { logger } from '@shared/logger'
import { MEMORY_CARD_APPEAR_MS, MEMORY_CARD_FADE_MS } from '@core/engine'

const snap = ref(getEngine().snapshot())
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // 相位时间驱动，UI 每 100ms 刷一次（淡入淡出过渡需要更细的采样）
  pollTimer = setInterval(() => {
    try {
      snap.value = getEngine().snapshot()
    } catch (e) {
      logger.warn('[recall-card] 读快照失败（保持上次）', e)
    }
  }, 100)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

const recall = computed(() => snap.value.memory.recall)
const phase = computed(() => snap.value.memoryCard.phase)

/**
 * ★ visible 判定：
 *   - roomState === 'MEMORY_RECALL' 且 recall 非空 → 显卡
 *   - 或 phase !== 'hidden' → 显卡（覆盖淡出过程中状态已切回 ROOM 的瞬间）
 *   两个条件都为否 → 不显
 */
const visible = computed(
  () => (snap.value.room === 'MEMORY_RECALL' || phase.value !== 'hidden') && recall.value !== null,
)

/**
 * ★ 透明度 + 过渡时长 —— 用 CSS transition 做。
 *   时序：appearing(0) → shown(1) → fading(0) → hidden(unmount)
 *   - v-if mount 时 phase = appearing，opacity = 0（element 立即存在但不可见）
 *   - 100~360ms 后 phase 切到 shown，opacity 切到 1 + transition:appear_ms
 *     → CSS 在已有 element 上做 0→1 过渡，淡入完成
 *   - 用户点卡片外 → closeRecall → phase = fading，opacity 切到 0 + transition:fade_ms
 *     → CSS 在 1→0 上做过渡，淡出完成
 *   - 320ms 后 phase = hidden → v-if false → element unmount
 *
 *   ★ opacity 变化触发 CSS transition（element 一直在 DOM 里，所以"上一次 opacity"存在）。
 *   ★ 这里只用 phase 作语义信号，不读时间戳 —— 时间推进已由 engine.tickCard 内部完成。
 */
const opacity = computed(() => {
  switch (phase.value) {
    case 'shown':
      return 1
    case 'appearing':
      // ★ 出场保持 0，等 phase 切到 shown 时 opacity 0→1 触发淡入
      return 0
    case 'fading':
      return 0
    default:
      return 0
  }
})

const transitionMs = computed(() => {
  if (phase.value === 'shown') return MEMORY_CARD_APPEAR_MS
  if (phase.value === 'fading') return MEMORY_CARD_FADE_MS
  return 0
})
</script>

<template>
  <transition name="recallfade">
    <!--
      ★ pointer-events: none（见 style 注释）—— 让 canvas 收 pointer，
      卡片只是"显示在那里"，不抢任何点击。
    -->
    <aside
      v-if="visible && recall"
      class="recall-card"
      :class="`recall-card--${phase}`"
      :style="{ opacity, transition: `opacity ${transitionMs}ms ease-out` }"
      aria-live="polite"
    >
      <p class="recall-card__date">{{ recall.date }}</p>
      <p class="recall-card__line">{{ recall.line }}</p>
      <p class="recall-card__source">{{ recall.sourceType }}</p>
    </aside>
  </transition>
</template>

<style scoped>
/*
 * ★ 卡片浮在小卜旁边，不遮小屋、不抢点击 —— pointer-events: none。
 *   战略原文：「不是弹窗、不是模态、不遮住小屋」
 *   点击卡片外的画布任意位置 → engine.handleTap 调 closeRecall → phase:fading → 淡出。
 */
.recall-card {
  position: absolute;
  left: 50%;
  bottom: 32%;
  transform: translateX(-50%);
  max-width: 280px;
  padding: 14px 18px;
  border-radius: var(--r-bubble);
  /* 羊皮纸：与 hud__hintcard 同款质感，但更小、更靠中下 */
  background: linear-gradient(135deg, var(--c-wood-tag), var(--c-cream-warm));
  box-shadow: 0 2px 12px rgba(122, 92, 66, 0.18);
  pointer-events: none;
  text-align: center;
  z-index: 3;
}

.recall-card--appearing {
  /* 初始 opacity 0，由 .recall-card 的 transition 从 0 过渡到 1（v-if mount 时是 appearing） */
  /* 实际 opacity 由 inline style 注入，这里只负责 class 语义锚点 */
}

.recall-card--shown {
  /* 稳定态，无过渡 */
}

.recall-card--fading {
  /* 淡出态，由 inline style 把 opacity 设回 0 + transition:fade_ms */
}

.recall-card__date {
  font-size: 12px;
  color: var(--c-ink-2);
  letter-spacing: 0.04em;
  margin: 0 0 4px;
}

.recall-card__line {
  font-size: 14px;
  line-height: 1.55;
  color: var(--c-ink);
  margin: 0 0 6px;
}

.recall-card__source {
  font-size: 11px;
  color: var(--c-ink-2);
  opacity: 0.85;
  margin: 0;
}

/* ★ 卡片自身的入场/出场过渡（v-if 控制的 mount/unmount） */
.recallfade-enter-active {
  transition: opacity 120ms ease-out;
}

.recallfade-leave-active {
  transition: opacity 100ms ease-in;
}

.recallfade-enter-from,
.recallfade-leave-to {
  opacity: 0;
}
</style>
