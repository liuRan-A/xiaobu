<script setup lang="ts">
/**
 * 小卜 · 解读页（骨架）   src/ui/components/SheetResult.vue
 * ===========================================================================
 * READING 态：掷完六爻 / 抽完牌之后，解读层**从下方轻轻上浮**。
 *   六爻 = 一段话；塔罗 = 按牌阵结构分段（`ReadingPlan.sections`）。
 *
 * ★ 文案来源是"先本地、再云端"：
 *   · 进入 READING 立刻用**本地模板**（core/readingCopy）渲染，首帧不等网络
 *   · 同时异步向云端（services/llm）要一份更好的；拿到且仍是这一次解读 → 静默替换
 *   · 云端被停用 / 超时 / 结构不合格 → 静默留在本地模板，用户无感
 *
 * ★ 它接上的是一条**断掉的闭环**：进入 READING 后引擎只发了 `reading:open`，
 *   之前无人渲染、也无人调 `readDone()`，流程会停在这里。本组件是那个消费者。
 *
 * ★ 边界（与全仓一致）：
 *   ① catch 内只 logger.warn，绝不弹 UI（门禁 ⑨）
 *   ② 不读天气 / 不读开发模式；只读引擎快照
 *   ③ 快照读取失败时保持上一次内容，页面不闪、不白
 * ===========================================================================
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getEngine } from '@store/engineHost'
import { logger } from '@shared/logger'
import { interpretLocally, type ReadingCopy } from '@core/readingCopy'
import { requestCloudReading } from '@services/llm'

const snap = ref(getEngine().snapshot())
let pollTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  pollTimer = setInterval(() => {
    try {
      snap.value = getEngine().snapshot()
    } catch (e) {
      // ★ 门禁 ⑨：读快照失败只记日志，保持上一帧内容
      logger.warn('[reading-sheet] 读快照失败（保持上次）', e)
    }
  }, 200)
})

onBeforeUnmount(() => {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
})

/** 只在 READING 态显示 */
const visible = computed(() => snap.value.room === 'READING')

/** 本地解读文案：断网兜底，也是首帧文案（不等网络） */
const localCopy = computed(() =>
  interpretLocally({
    plan: snap.value.reading.plan,
    request: snap.value.reading.request,
    hexagram: snap.value.hexagram,
  }),
)

/**
 * 云端解读（到了才有值）；为 null 时整份用本地模板。
 * ★ 云端只覆盖它**给了值**的字段：卦名 / 牌阵名只存在客户端的内容表里，
 *   服务端给不出标题，所以 title / subtitle 为空时沿用本地 —— 否则联网成功反而
 *   把"第 11 卦 · 泰"弄丢成一句泛泛的话，那是最刺眼的回退。
 */
const cloudCopy = ref<ReadingCopy | null>(null)

/** 解析序号：只认"还是这一次解读"的云端响应，早退 / 下一局都不覆盖 */
let cloudSeq = 0

const copy = computed<ReadingCopy>(() => {
  const local = localCopy.value
  const cloud = cloudCopy.value
  if (!cloud) return local
  return {
    title: cloud.title || local.title,
    subtitle: cloud.subtitle || local.subtitle,
    sections: cloud.sections,
    summary: cloud.summary || local.summary,
    moodLabel: cloud.moodLabel || local.moodLabel,
  }
})

/**
 * 进入 READING 就向云端要一版更细的解读。
 * ★ 以 `room === 'READING'` 的**边沿**为触发点（而非 request 对象），
 *   避免快照每 200ms 轮询重建对象时反复发请求。
 * ★ requestCloudReading 永不抛；成功才替换，失败静默留在本地。
 */
watch(
  () => snap.value.room === 'READING',
  (on) => {
    cloudSeq += 1
    cloudCopy.value = null
    if (!on) return
    const req = snap.value.reading.request
    if (!req) return
    const seq = cloudSeq
    void requestCloudReading(req)
      .then((cloud) => {
        if (seq !== cloudSeq || !cloud) return
        cloudCopy.value = cloud
      })
      .catch((e) => {
        // ★ 门禁 ⑨：云端异常只记日志，本地模板继续兜着，不弹任何提示
        logger.warn('[reading-sheet] 云端解读异常（已回落本地）', e)
      })
  },
  { immediate: true },
)

const title = computed(() => copy.value.title)
const subtitle = computed(() => copy.value.subtitle)
const sections = computed(() => copy.value.sections)
const summary = computed(() => copy.value.summary)

/** 塔罗没翻满时如实说明"翻几张看几张" —— 这不是失败态 */
const partialHint = computed(() => {
  const plan = snap.value.reading.plan
  if (!plan) return ''
  return plan.drawn > 0 && plan.drawn < plan.sections.length ? '翻几张，我们就看几张。' : ''
})

function onDone(): void {
  try {
    getEngine().readDone()
  } catch (e) {
    // ★ 门禁 ⑨：推进失败只记日志；用户再点一次即可，不弹任何提示
    logger.warn('[reading-sheet] readDone 异常（已忽略）', e)
  }
}
</script>

<template>
  <transition name="sheetup">
    <section v-if="visible" class="sheet-result" aria-label="解读">
      <div class="sheet-result__panel">
        <header class="sheet-result__head">
          <h2 class="sheet-result__title">{{ title }}</h2>
          <p class="sheet-result__subtitle">{{ subtitle }}</p>
        </header>

        <div class="sheet-result__body">
          <div v-for="s in sections" :key="s.key" class="sheet-result__section">
            <p class="sheet-result__label">{{ s.label }}</p>
            <p v-if="s.body" class="sheet-result__text">{{ s.body }}</p>
            <!-- 兜底：正文缺失时也给一句，绝不空白 -->
            <p v-else class="sheet-result__text sheet-result__text--placeholder">慢慢来，这一句还在路上。</p>
          </div>
          <p v-if="summary" class="sheet-result__summary">{{ summary }}</p>
          <p v-if="partialHint" class="sheet-result__hint">{{ partialHint }}</p>
        </div>

        <button class="sheet-result__done" @click="onDone">看完了</button>
      </div>
    </section>
  </transition>
</template>

<style scoped>
/* 铺满父容器（ui-overlay），自身默认穿透；只有面板本体接管点击 */
.sheet-result {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  pointer-events: none;
  z-index: 4;
}

/* 解读面板：从下方上浮的羊皮纸底，与全屏页/提示卡同一套质感 */
.sheet-result__panel {
  pointer-events: auto;
  max-height: 62%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px calc(20px + env(safe-area-inset-bottom, 0));
  border-radius: 20px 20px 0 0;
  background: linear-gradient(180deg, var(--c-cream-warm) 0%, var(--c-cream) 100%);
  box-shadow: 0 -4px 24px rgba(122, 92, 66, 0.18);
}

.sheet-result__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sheet-result__title {
  font-size: 18px;
  color: var(--c-ink);
  margin: 0;
}

.sheet-result__subtitle {
  font-size: 12px;
  color: var(--c-ink-2);
  margin: 0;
}

.sheet-result__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding-right: 2px;
}

.sheet-result__section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.sheet-result__label {
  font-size: 13px;
  color: var(--c-ink);
  letter-spacing: 0.02em;
  margin: 0;
}

.sheet-result__text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--c-ink);
  margin: 0;
  /* 正文里用 \n 分段（如六爻的动爻提示），保留换行 */
  white-space: pre-line;
}

.sheet-result__text--placeholder {
  color: var(--c-ink-2);
  opacity: 0.7;
}

.sheet-result__summary {
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-ink-2);
  margin: 2px 0 0;
  padding-top: 10px;
  border-top: 1px solid rgba(66, 60, 82, 0.08);
}

.sheet-result__hint {
  font-size: 11px;
  color: var(--c-ink-2);
  opacity: 0.8;
  margin: 0;
}

.sheet-result__done {
  margin-top: 2px;
  padding: 11px 18px;
  border: none;
  border-radius: 999px;
  background: var(--c-matcha);
  color: var(--c-ink);
  font-size: 14px;
  cursor: pointer;
}

/* 上浮入场 / 落下出场 */
.sheetup-enter-active,
.sheetup-leave-active {
  transition: opacity 300ms ease-out;
}

.sheetup-enter-active .sheet-result__panel,
.sheetup-leave-active .sheet-result__panel {
  transition: transform 300ms ease-out;
}

.sheetup-enter-from,
.sheetup-leave-to {
  opacity: 0;
}

.sheetup-enter-from .sheet-result__panel,
.sheetup-leave-to .sheet-result__panel {
  transform: translateY(24px);
}
</style>
