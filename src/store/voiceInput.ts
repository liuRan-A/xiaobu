/**
 * 小卜 · 语音输入状态   src/store/voiceInput.ts
 * ===========================================================================
 * 「按住说话」这条交互的**唯一真相**。UI（HudOverlay.vue）只读它、编排层
 * （ui/voiceInput.ts）只写它 —— 没有第二份状态散落在组件里。
 *
 *   · held       —— 手指现在是不是按着（驱动按钮的按压态与文案）
 *   · recording  —— 麦克风现在是不是在录（与 held 不完全同步：未同意时不录）
 *   · consent    —— 音频出端同意的**镜像**（真源在引擎持久化里，这里只给 UI 一个反应式读点）
 *   · consentAsked —— 本轮是否已经问过（问过就不再自动弹同意行）
 *   · hint       —— 一句柔和的提示（同意提示 / 没听清 / 太短 …），空串 = 不显示
 *   · busy       —— 正在等云端听写（驱动"小卜在听…"的轻指示）
 *   · heard      —— 刚听到的一句（编排层写入；组件 watch 到它就去开小卜对话并发送）
 *
 * ★ 为什么 `heard` 要经由 store 而不是直接调场景层：
 *   "开小卜对话"要切到悬浮球（涉及 scene 层的可见性），那是**组件**才该做的事。
 *   编排层只负责"听到了什么"，组件负责"怎么把它端到用户面前"，
 *   于是编排层保持零 DOM，可以在 node 里被单测。
 * ===========================================================================
 */
import { defineStore } from 'pinia'

export type VoiceConsentMirror = 'off' | 'on'

export const useVoiceInputStore = defineStore('voiceInput', {
  state: () => ({
    /** 手指是否按着「按住说话」 */
    held: false,
    /** 麦克风是否正在录音（未同意时不录，此时 held=true 而 recording=false） */
    recording: false,
    /** 音频出端同意镜像。★ 真源在引擎持久化里 */
    consent: 'off' as VoiceConsentMirror,
    /** 本轮是否已经问过同意（问过就不再自动弹同意行） */
    consentAsked: false,
    /** 一句柔和提示（空串 = 不显示） */
    hint: '',
    /** 正在等云端听写 */
    busy: false,
    /** 刚听到的一句（编排层写入，组件消费后清空） */
    heard: '',
  }),

  actions: {
    setHeld(v: boolean): void {
      this.held = v === true
    },

    setRecording(v: boolean): void {
      this.recording = v === true
    },

    /** 同步语音同意镜像（真源在引擎持久化） */
    setConsent(c: VoiceConsentMirror): void {
      this.consent = c === 'on' ? 'on' : 'off'
    },

    setConsentAsked(v: boolean): void {
      this.consentAsked = v === true
    },

    setHint(t: string): void {
      this.hint = String(t ?? '')
    },

    setBusy(v: boolean): void {
      this.busy = v === true
    },

    setHeard(t: string): void {
      this.heard = String(t ?? '')
    },

    /** 收起一轮（松手后 / 离开小屋时）。★ 不动 consent —— 那是长期偏好，不随一轮清掉 */
    reset(): void {
      this.held = false
      this.recording = false
      this.hint = ''
      this.busy = false
    },
  },
})
