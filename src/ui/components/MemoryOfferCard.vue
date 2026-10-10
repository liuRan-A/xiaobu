<script setup lang="ts">
/**
 * 小卜 · 候选摆件卡   src/ui/components/MemoryOfferCard.vue
 * ===========================================================================
 * MEMORY_OFFER 态：解读听完之后，根据情绪基调（MoodTone）给 2–3 件轻量级摆件，
 * 用户长按其中一件 200ms 启动拖拽 → 摆件出现在画布上手指位置 →
 * 跟随手指 → 松手放下（由 Scene.vue 接管 MEMORY_PLACE pointer）。
 *
 * ★ 战略原文：「用户**亲手拖拽**放置到小屋」—— 长按启动一次手势完成选择+拖拽，
 *   短点候选卡不触发（保留候选信息查看的语义，不打断选择）。
 *
 * ★ 链路：
 *   用户长按候选 200ms → engine.offerMemory(kind) → 进 MEMORY_PLACE
 *   → 把 pointer capture 切到 canvas → dispatch 一次虚拟 pointerdown 给 canvas
 *   → Scene.vue 的 onPointerDown 进入 memoryDrag 分支（见 Scene.vue 头注）
 *
 * ★ 诚实原则：「先不要」按钮和候选卡一样大、一样亮 —— 不给出口的邀请是要求。
 *   战略原文的三条底线之一：「不带走也完全可以」。
 * ===========================================================================
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getEngine } from '@store/engineHost'
import { logger } from '@shared/logger'
import type { MemoryKind } from '@core/memory/memoryAnchor'

// ★ 与 HudOverlay.vue 的 KIND_ICON 保持一致 —— 候选卡用 emoji，画布用程序化画法，
//   两层视觉不必完全一致，但用户能一眼对上"我选的就是这件"
const KIND_EMOJI: Readonly<Record<MemoryKind, string>> = {
  plant: '🌿',
  stone: '🪨',
  lantern: '🏮',
  shell: '🐚',
  bell: '🔔',
  candle: '🕯️',
  seed: '🌰',
  ticket: '🎫',
}

// 候选卡长按阈值 —— 太短会误触（用户只是想看看 whisper），太长会让"启动拖拽"显得迟钝
const LONG_PRESS_MS = 200

const snap = ref(getEngine().snapshot())
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // ★ 摆件拖拽期间状态在变（拖到一半再回来看），所以每 200ms 刷一次
  pollTimer = setInterval(() => {
    try {
      snap.value = getEngine().snapshot()
    } catch (e) {
      logger.warn('[offer-card] 读快照失败（保持上次）', e)
    }
  }, 200)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  // 清掉所有未触发的长按定时器，避免卸载后还能调到 offerMemory
  for (const t of longPressTimers.values()) clearTimeout(t)
  longPressTimers.clear()
})

const offers = computed(() => snap.value.memory.offers)
const visible = computed(() => snap.value.room === 'MEMORY_OFFER')

// ★ 候选卡长按定时器表（按 kind 索引，避免一个候选卡多个 timer 串味）
const longPressTimers = new Map<MemoryKind, ReturnType<typeof setTimeout>>()

function onCandidateDown(kind: MemoryKind, ev: PointerEvent): void {
  // ★ 防止浏览器把长按识别成"上下文菜单"打断我们的 200ms
  ev.preventDefault()

  const timer = setTimeout(() => {
    try {
      // ① 进 MEMORY_PLACE：engine.offerMemory 已建 pendingDraft + 发 OFFER_MEMORY 事件
      getEngine().offerMemory(kind)
      // ② 把指针 capture 切到 canvas：之后 move/up 都到 canvas
      //   ★ 必须切：用户手指物理上还在候选卡 DOM 上，不切的话后续 pointermove
      //   会继续冒到候选卡而不是 canvas，拖拽链路断
      const canvas = document.querySelector('canvas.scene-canvas') as HTMLCanvasElement | null
      if (canvas) {
        try {
          canvas.setPointerCapture(ev.pointerId)
        } catch {
          /* 某些 WebView 不允许跨元素 capture，降级为依赖冒泡 */
        }
        // ③ dispatch 一次虚拟 pointerdown 让 Scene.vue 进入 memoryDrag 分支
        //    ★ 用 PointerEvent 构造，保留原 pointerId 与坐标
        const transfer = new PointerEvent('pointerdown', {
          pointerId: ev.pointerId,
          clientX: ev.clientX,
          clientY: ev.clientY,
          bubbles: true,
          cancelable: true,
        })
        canvas.dispatchEvent(transfer)
      }
    } catch (e) {
      // ★ 门禁 ⑨：offerMemory 失败只记日志，用户那一下没生效但不弹任何提示
      logger.warn('[offer-card] offerMemory 异常（已忽略）', e)
    }
  }, LONG_PRESS_MS)
  longPressTimers.set(kind, timer)
}

function onCandidateUp(kind: MemoryKind): void {
  const t = longPressTimers.get(kind)
  if (t !== undefined) {
    clearTimeout(t)
    longPressTimers.delete(kind)
  }
}

function onSkip(): void {
  try {
    getEngine().skipMemory()
  } catch (e) {
    logger.warn('[offer-card] skipMemory 异常（已忽略）', e)
  }
}
</script>

<template>
  <transition name="offerfade">
    <aside v-if="visible" class="offer-card" aria-label="候选摆件">
      <p class="offer-card__tone">{{ offers[0]?.toneLabel ?? '心里的' }}</p>
      <ul class="offer-card__list">
        <li
          v-for="o in offers"
          :key="o.kind"
          class="offer-card__item"
          @pointerdown="onCandidateDown(o.kind, $event)"
          @pointerup="onCandidateUp(o.kind)"
          @pointercancel="onCandidateUp(o.kind)"
          @pointerleave="onCandidateUp(o.kind)"
        >
          <span class="offer-card__icon">{{ KIND_EMOJI[o.kind] }}</span>
          <span class="offer-card__name">{{ o.name }}</span>
          <span class="offer-card__whisper">{{ o.whisper }}</span>
        </li>
      </ul>
      <button class="offer-card__skip" @click="onSkip">先不要</button>
      <p class="offer-card__hint">长按拖到小屋里</p>
    </aside>
  </transition>
</template>

<style scoped>
/* 铺满父容器（ui-overlay），自身默认穿透 —— 只有候选卡自身接管点击 */
.offer-card {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  pointer-events: none;
}

/* 候选卡本体接管点击 */
.offer-card__list,
.offer-card__item,
.offer-card__skip {
  pointer-events: auto;
}

.offer-card__tone {
  font-size: 13px;
  color: var(--c-ink-2);
  letter-spacing: 0.04em;
}

.offer-card__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 280px;
}

.offer-card__item {
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: auto auto;
  column-gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border-radius: var(--r-card);
  background: linear-gradient(135deg, var(--c-wood-tag), var(--c-cream-warm));
  box-shadow: 0 2px 10px rgba(122, 92, 66, 0.14);
  /* ★ 长按候选卡时禁掉浏览器默认的"上下文菜单" / "选择" */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  cursor: grab;
  touch-action: none;
}

.offer-card__icon {
  grid-row: 1 / 3;
  font-size: 22px;
  line-height: 1;
}

.offer-card__name {
  grid-column: 2;
  font-size: 14px;
  color: var(--c-ink);
}

.offer-card__whisper {
  grid-column: 2;
  font-size: 11px;
  color: var(--c-ink-2);
  line-height: 1.4;
}

.offer-card__skip {
  margin-top: 4px;
  padding: 8px 18px;
  border: 1px solid rgba(66, 60, 82, 0.1);
  border-radius: 999px;
  background: var(--c-cream);
  color: var(--c-ink-2);
  font-size: 13px;
  cursor: pointer;
  /* ★ 「先不要」和候选卡一样亮、一样可点 —— 不给出口的邀请是要求 */
}

.offer-card__hint {
  font-size: 11px;
  color: var(--c-ink-2);
  opacity: 0.7;
  pointer-events: none;
}

/* 淡入淡出 —— 与 MemoryRecallCard 同款 */
.offerfade-enter-active,
.offerfade-leave-active {
  transition: opacity 220ms ease-out;
}

.offerfade-enter-from,
.offerfade-leave-to {
  opacity: 0;
}
</style>
