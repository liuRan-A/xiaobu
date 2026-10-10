<script setup lang="ts">
/**
 * 小卜 · HUD 系统层   src/ui/components/HudOverlay.vue
 * ===========================================================================
 * 系统 UI 层（DOM overlay）。四块 + 两个全屏页：
 *
 *   ① 顶部栏     —— 真实时钟 + 引擎里最近的一条等待日子；头像连点 5 次 = 开发者模式触发区（保留）
 *   ② 悬浮提示卡 —— 点击唤起小卜对话（小卜化球 + 弹输入框）
 *   ③ 底部输入区 —— 造牌（→ 塔罗）/ 按住说话（接讯飞听写，音频出端需独立同意）/ 唤醒小卜
 *   ④ 底部导航栏 —— 小屋 / 占卜 / 记忆
 *   ⑤ 占卜页     —— 六爻 / 塔罗两个入口；点击回小屋并进入对应流程
 *   ⑥ 记忆页     —— 屋里摆件的清单与低语（只读；回看低语仍要回屋点它）
 *
 * ★ 形态联动（§四·形态二）：切到占卜/记忆页 → 小卜化悬浮球；回小屋 → 变回实体。
 *
 * ★ pointer-events 策略：容器 none，可点的块 auto —— 空白区域穿透给 canvas 掷币。
 *
 * ★ 诚实原则：拿不到结果就如实说"没听清" ——「按住说话」不做假的识别结果。
 *   录音要先经用户单独同意（音频出端独立通道），拿到识别文本后交给小卜对话。
 * ===========================================================================
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppFlowStore, type AppTab } from '@store/appFlow'
import { ORB_MARGIN_PX, ORB_RADIUS_PX, useXiaobuFormStore } from '@store/xiaobuForm'
import { useVoiceInputStore } from '@store/voiceInput'
import { useWeatherStore } from '@store/weather'
import { useAudioStore } from '@store/audio'
import { getEngine } from '@store/engineHost'
import { resetXiaobuPos, setXiaobuVisible } from '@scene/layers'
import { currentConfig } from '@bootstrap/bootSequence'
import { recallOf, type MemoryKind } from '@core/memory/memoryAnchor'
import { sendEmpathy } from '@ui/empathyChat'
import { startVoice, finishVoice, setVoiceConsent, resetVoiceInput } from '@ui/voiceInput'
import { logger } from '@shared/logger'

const flow = useAppFlowStore()
const xiaobu = useXiaobuFormStore()
const voice = useVoiceInputStore()
const weather = useWeatherStore()
const audio = useAudioStore()

// ── 顶栏天气小签（只读投影；拿不到 / 过期时为空串，什么都不提）─────────────
//   ★ 天气是"替用户看一眼窗外"，不给预报/行话；陈旧时尾随一个淡淡的记号。
const weatherLine = computed(() => {
  if (!weather.visible) return ''
  const t = weather.tempText
  const base = t ? `${weather.label} · ${t}` : weather.label
  return weather.stale ? `${base} ·` : base
})

// ── ① 顶栏：真实时钟 + 等待的日子 ──────────────────────────────────────────

const clock = ref(formatClock())
const waitLine = ref('今天没有等待的日子')

function formatClock(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 时钟与倒计时每 30s 刷新一次（倒计时以"日"为单位，30s 足够新鲜） */
let hudTimer: ReturnType<typeof setInterval> | null = null

function refreshWaitLine(): void {
  try {
    const items = getEngine().snapshot().countdown.items
    const next = items[0]
    waitLine.value = next ? `「${next.title}」${next.caption}` : '今天没有等待的日子'
  } catch (e) {
    logger.warn('[hud] 读取倒计时失败（保持上一句）', e)
  }
}

onMounted(() => {
  hudTimer = setInterval(() => {
    clock.value = formatClock()
    refreshWaitLine()
  }, 30_000)
  refreshWaitLine()
})

onBeforeUnmount(() => {
  if (hudTimer !== null) clearInterval(hudTimer)
})

// ── 形态联动：小卜去别的页化球，回小屋变实体 ────────────────────────────────

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight }
}

/** 小卜化球（右缘中部）。已在球态则只换位置 */
function xiaobuToOrb(): void {
  if (xiaobu.mode === 'room') {
    setXiaobuVisible(false)
    const vp = viewport()
    xiaobu.becomeOrb({ x: vp.w - ORB_MARGIN_PX - ORB_RADIUS_PX, y: vp.h * 0.42 }, vp)
  }
}

/** 小卜回屋变实体 */
function xiaobuToRoom(): void {
  if (xiaobu.mode === 'orb') {
    xiaobu.backToRoom()
    setXiaobuVisible(true)
    resetXiaobuPos()
  }
}

// ── ④ 导航切换 ─────────────────────────────────────────────────────────────

function switchTab(tab: AppTab): void {
  if (flow.activeTab === tab) return
  flow.switchTab(tab)
  if (tab === 'home') {
    xiaobuToRoom()
  } else {
    // 离开小屋：停掉可能还按着的录音编排，别让一次按住跨页挂在那
    resetVoiceInput()
    xiaobuToOrb()
  }
}

// ── ⑤ 占卜页：回小屋 + 进对应流程 ──────────────────────────────────────────

function pickDivine(zone: 'LIUYAO' | 'TAROT'): void {
  switchTab('home')
  try {
    const e = getEngine()
    // ★ 只在待机态才送进区事件：流程中间切页再点入口，状态机会拒绝（不打断原则）
    if (e.roomState === 'ROOM') e.enterZone(zone)
  } catch (err) {
    logger.warn('[hud] 进入占卜流程失败（已忽略）', err)
  }
}

// ── ⑥ 记忆页：屋里摆件的只读清单 ───────────────────────────────────────────

const KIND_ICON: Readonly<Record<MemoryKind, string>> = {
  plant: '🌿',
  stone: '🪨',
  lantern: '🏮',
  shell: '🐚',
  bell: '🔔',
  candle: '🕯️',
  seed: '🌰',
  ticket: '🎫',
}

/** 打开记忆页时取一次引擎数据（engine.boot 完成后才有内容；取到空就如实显示空屋） */
const dataStamp = ref(0)
watch(
  () => flow.activeTab,
  (t) => {
    if (t === 'memory') dataStamp.value++
  },
)

const memoryPage = computed(() => {
  void dataStamp.value
  try {
    const snap = getEngine().snapshot()
    return {
      summary: snap.memory.summary,
      items: snap.memory.items.map((m) => {
        const r = recallOf(m)
        return { id: m.id, icon: KIND_ICON[m.kind] ?? '🌿', date: r.date, tail: r.tail }
      }),
      countdowns: snap.countdown.items,
    }
  } catch (e) {
    logger.warn('[hud] 读取记忆失败（显示空屋）', e)
    return { summary: '小屋里还空着。', items: [], countdowns: [] }
  }
})

// ── ② 提示卡 / 输入区右侧：唤起小卜对话 ────────────────────────────────────

function wakeXiaobu(): void {
  xiaobuToOrb()
  xiaobu.toggleChat(true)
}

// ── ③ 造牌：回小屋进塔罗 ───────────────────────────────────────────────────

function craftCard(): void {
  pickDivine('TAROT')
}

// ── ③ 按住说话：接讯飞听写（音频出端走独立同意通道）────────────────────────
//   按住 → 录制；松手 → 听写；拿到那句 → 交给小卜对话。没同意时只显示同意行。

/** 同意行：仅在语音开关开启 + 尚未同意 + 还没问过时出现 */
const showVoiceConsent = computed(
  () =>
    currentConfig().features.voiceInput.enabled && voice.consent === 'off' && !voice.consentAsked,
)

/** 按钮文案：听写中 > 录制中 > 待机 */
const speakLabel = computed(() => {
  if (voice.busy) return '小卜在听…'
  if (voice.held && voice.recording) return '听着呢…'
  return '按住说话'
})

function speakDown(): void {
  startVoice()
}

function speakUp(): void {
  void finishVoice()
}

function onVoiceConsent(choice: 'off' | 'on'): void {
  setVoiceConsent(choice)
}

/**
 * 听到一句 ⇒ 端到用户面前：切球 + 开小卜对话 + 发送。
 * ★ 先 `await nextTick()`：让 panel 打开引发的 `openEmpathy()` 先落地，
 *   再发送 —— 否则 openEmpathy 会自增会话序号，把刚发出的那轮听写作废。
 */
watch(
  () => voice.heard,
  async (t) => {
    if (!t) return
    const said = t
    voice.setHeard('')
    wakeXiaobu()
    await nextTick()
    await sendEmpathy(said)
  },
)

// ── ① 头像：隐藏开发者模式触发区（DevPanel 未接入前只留触发计数） ────────────

let avatarTaps = 0
function onAvatarTap(): void {
  avatarTaps++
  if (avatarTaps >= 5) {
    avatarTaps = 0
    logger.log('[hud] 开发者模式触发（DevPanel 尚未接入，预留）')
  }
}
</script>

<template>
  <div class="hud">
    <!-- ⑤⑥ 全屏页：占卜 / 记忆（盖住场景与提示卡，顶栏导航保留） -->
    <transition name="pagefade">
      <section v-if="flow.activeTab === 'divine'" class="hud-page">
        <h2 class="page__title">想问点什么？</h2>
        <button class="divine-card" @click="pickDivine('LIUYAO')">
          <span class="divine-card__icon">🪙</span>
          <span class="divine-card__name">摇三枚铜钱</span>
          <span class="divine-card__sub">心里存一件事，回小屋摇一卦</span>
        </button>
        <button class="divine-card" @click="pickDivine('TAROT')">
          <span class="divine-card__icon">🌙</span>
          <span class="divine-card__name">抽一张牌</span>
          <span class="divine-card__sub">看看今天的心境走向</span>
        </button>
      </section>

      <section v-else-if="flow.activeTab === 'memory'" class="hud-page">
        <h2 class="page__title">小屋里的记忆</h2>
        <p class="memory__summary">{{ memoryPage.summary }}</p>
        <ul class="memory__list">
          <li v-for="it in memoryPage.items" :key="it.id" class="memory__item">
            <span class="memory__icon">{{ it.icon }}</span>
            <span class="memory__body">
              <span class="memory__tail">{{ it.tail }}</span>
              <span class="memory__date">{{ it.date }}</span>
            </span>
          </li>
        </ul>
        <div v-if="memoryPage.countdowns.length" class="memory__waits">
          <span class="memory__waits-title">还在等的</span>
          <span v-for="c in memoryPage.countdowns" :key="c.id" class="memory__wait">
            「{{ c.title }}」{{ c.caption }}
          </span>
        </div>
        <p class="memory__hint">点一下屋里的它们，会说话。</p>
      </section>
    </transition>

    <!-- ① 顶部栏 -->
    <header class="hud__topbar">
      <div class="topbar__left">
        <span class="topbar__time">{{ clock }}</span>
        <span class="topbar__countdown">· {{ waitLine }}</span>
        <span v-if="weatherLine" class="topbar__weather">· {{ weatherLine }}</span>
      </div>
      <div class="topbar__right">
        <button
          class="topbar__icon"
          :aria-label="audio.muted ? '打开声音' : '静音'"
          @click="audio.toggle()"
        >
          {{ audio.muted ? '🔇' : '🔊' }}
        </button>
        <button class="topbar__icon" aria-label="设置">⚙</button>
        <button class="topbar__avatar" aria-label="用户头像" @click="onAvatarTap">🙂</button>
      </div>
    </header>

    <!-- ② 悬浮提示卡（小屋页才有） -->
    <aside v-show="flow.activeTab === 'home'" class="hud__hintcard" @click="wakeXiaobu">
      <span class="hintcard__text">今天也辛苦了，要不要一起坐坐？</span>
    </aside>

    <!-- ③ 底部输入区（小屋页才有） -->
    <footer v-show="flow.activeTab === 'home'" class="hud__input-wrap">
      <!-- 语音同意行：仅在语音开启 + 未同意 + 没问过时出现（音频出端独立通道） -->
      <div v-if="showVoiceConsent" class="voice-consent">
        <span class="voice-consent__text">说话要先把声音发给小卜听写，愿意吗？</span>
        <div class="voice-consent__acts">
          <button class="voice-consent__btn" @click="onVoiceConsent('off')">先不用</button>
          <button class="voice-consent__btn voice-consent__btn--on" @click="onVoiceConsent('on')">好</button>
        </div>
      </div>

      <!-- 诚实提示：没听清 / 不支持 / 已送出（拿不到就如实说） -->
      <p v-if="voice.hint" class="voice-hint">{{ voice.hint }}</p>

      <div class="hud__input">
        <button class="input__action" aria-label="造牌" @click="craftCard">🂠</button>
        <button
          class="input__speak"
          :class="{ 'input__speak--held': voice.held, 'input__speak--rec': voice.recording }"
          aria-label="按住说话"
          @pointerdown.prevent="speakDown"
          @pointerup="speakUp"
          @pointercancel="speakUp"
          @pointerleave="speakUp"
        >
          <span class="input__speak-dot" />{{ speakLabel }}
        </button>
        <button class="input__action" aria-label="唤醒小卜" @click="wakeXiaobu">🐱</button>
      </div>
    </footer>

    <!-- ④ 底部导航栏 -->
    <nav class="hud__tabbar">
      <button class="tabbar__item" :class="{ 'tabbar__item--active': flow.activeTab === 'home' }" @click="switchTab('home')">
        <span class="tabbar__icon">🏠</span>
        <span class="tabbar__label">小屋</span>
      </button>
      <button class="tabbar__item" :class="{ 'tabbar__item--active': flow.activeTab === 'divine' }" @click="switchTab('divine')">
        <span class="tabbar__icon">🔮</span>
        <span class="tabbar__label">占卜</span>
      </button>
      <button class="tabbar__item" :class="{ 'tabbar__item--active': flow.activeTab === 'memory' }" @click="switchTab('memory')">
        <span class="tabbar__icon">🌙</span>
        <span class="tabbar__label">记忆</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/* ── 骨架容器：铺满，但默认穿透（不抢 canvas 手势） ── */
.hud {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: env(safe-area-inset-top, 0) env(safe-area-inset-right, 0)
    env(safe-area-inset-bottom, 0) env(safe-area-inset-left, 0);
}

/* 每个可交互块显式接管点击 */
.hud__topbar,
.hud__hintcard,
.hud__input-wrap,
.hud__tabbar {
  pointer-events: auto;
  position: relative;
  z-index: 2;
}

/* ── ⑤⑥ 全屏页 ── */
.hud-page {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 72px 22px 120px;
  overflow-y: auto;
  /* 羊皮底：全屏页盖住 canvas，但保留顶栏/导航（z 更高） */
  background: linear-gradient(180deg, var(--c-cream-warm) 0%, var(--c-cream) 40%, var(--c-wood-tag) 100%);
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pagefade-enter-active {
  transition: opacity 240ms ease-out;
}

.pagefade-enter-from {
  opacity: 0;
}

.page__title {
  font-size: 18px;
  color: var(--c-ink);
  margin: 4px 0 2px;
}

/* 占卜入口卡 */
.divine-card {
  border: 1px solid rgba(66, 60, 82, 0.08);
  border-radius: var(--r-card);
  background: var(--c-cream-warm);
  box-shadow: 0 2px 10px rgba(122, 92, 66, 0.1);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  cursor: pointer;
  text-align: left;
}

.divine-card__icon {
  font-size: 24px;
}

.divine-card__name {
  font-size: 15px;
  color: var(--c-ink);
}

.divine-card__sub {
  font-size: 12px;
  color: var(--c-ink-2);
}

/* 记忆页 */
.memory__summary {
  font-size: 13px;
  color: var(--c-ink-2);
}

.memory__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.memory__item {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: var(--r-card);
  background: var(--c-cream-warm);
  box-shadow: 0 2px 8px rgba(122, 92, 66, 0.08);
}

.memory__icon {
  font-size: 20px;
}

.memory__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.memory__tail {
  font-size: 13px;
  color: var(--c-ink);
}

.memory__date {
  font-size: 11px;
  color: var(--c-ink-2);
}

.memory__waits {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.memory__waits-title {
  font-size: 12px;
  color: var(--c-ink-2);
}

.memory__wait {
  font-size: 13px;
  color: var(--c-ink);
}

.memory__hint {
  margin-top: auto;
  font-size: 11px;
  color: var(--c-ink-2);
}

/* ── ① 顶部栏 ── */
.hud__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  /* 半透明奶油，压一层柔和下阴影，让顶栏浮在场景上 */
  background: linear-gradient(180deg, rgba(253, 249, 246, 0.85), rgba(253, 249, 246, 0));
}

.topbar__left {
  display: flex;
  align-items: baseline;
  gap: 8px;
  color: var(--c-ink);
}

.topbar__time {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.topbar__countdown {
  font-size: 12px;
  color: var(--c-ink-2);
}

/* 天气小签：与倒计时同层同调，只多一个字号的轻重差别 */
.topbar__weather {
  font-size: 12px;
  color: var(--c-ink-2);
  opacity: 0.85;
}

.topbar__right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.topbar__icon,
.topbar__avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid rgba(66, 60, 82, 0.08);
  background: var(--c-cream-warm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  cursor: pointer;
}

.topbar__avatar {
  background: var(--c-matcha);
}

/* ── ② 悬浮提示卡（羊皮纸质感） ── */
.hud__hintcard {
  align-self: center;
  max-width: 300px;
  margin-top: 8px;
  padding: 12px 18px;
  border-radius: var(--r-bubble);
  /* 羊皮纸：暖米底 + 极淡的旧纸纹理感（纯色渐变，0 图片） */
  background: linear-gradient(135deg, var(--c-wood-tag), var(--c-cream-warm));
  box-shadow: 0 2px 12px rgba(122, 92, 66, 0.14);
  cursor: pointer;
}

.hintcard__text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-ink);
}

/* ── ③ 底部输入区 ── */
.hud__input-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0 12px;
}

/* 语音独立同意行：羊皮纸小卡，和输入条同一层视觉 */
.voice-consent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-radius: var(--r-bubble);
  background: linear-gradient(135deg, var(--c-wood-tag), var(--c-cream-warm));
  box-shadow: 0 2px 12px rgba(122, 92, 66, 0.14);
}

.voice-consent__text {
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-ink);
}

.voice-consent__acts {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.voice-consent__btn {
  padding: 6px 16px;
  border: 1px solid rgba(66, 60, 82, 0.12);
  border-radius: 999px;
  background: var(--c-cream);
  color: var(--c-ink-2);
  font-size: 13px;
  cursor: pointer;
}

.voice-consent__btn--on {
  background: var(--c-matcha);
  color: var(--c-ink);
  border-color: transparent;
}

/* 诚实提示：拿不到结果就说没听清，不编 */
.voice-hint {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  color: var(--c-ink-2);
}

.hud__input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 999px;
  background: var(--c-cream-warm);
  box-shadow: 0 2px 14px rgba(122, 92, 66, 0.16);
}

.input__action {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: var(--c-matcha);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.input__speak {
  flex: 1 1 auto;
  height: 40px;
  border: none;
  border-radius: 999px;
  background: var(--c-cream);
  color: var(--c-ink-2);
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 160ms ease-out;
}

.input__speak--held {
  background: var(--c-matcha);
  color: var(--c-ink);
}

/* 真在录：点一下红，给"它在听"的实感（拿不到麦克风时不会到这态） */
.input__speak--rec {
  background: var(--c-matcha);
  color: var(--c-ink);
}

.input__speak--rec .input__speak-dot {
  background: #d9534f;
  opacity: 1;
}

.input__speak-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-charcoal-warm);
  opacity: 0.5;
}

/* ── ④ 底部导航栏 ── */
.hud__tabbar {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 10px 0 calc(10px + env(safe-area-inset-bottom, 0));
  margin: 8px 12px 0;
  border-radius: 20px;
  background: rgba(253, 249, 246, 0.9);
  box-shadow: 0 -1px 0 rgba(122, 92, 66, 0.08);
}

.tabbar__item {
  flex: 1;
  border: none;
  background: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 4px 0;
  cursor: pointer;
  color: var(--c-ink-2);
}

.tabbar__item--active {
  color: var(--c-ink);
}

.tabbar__icon {
  font-size: 20px;
  line-height: 1;
}

.tabbar__label {
  font-size: 11px;
}
</style>
