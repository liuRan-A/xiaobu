/**
 * 小卜 · 双形态状态   src/store/xiaobuForm.ts
 * ===========================================================================
 * 「屋内实体 ⇄ 悬浮球」的**唯一真相**。两个形态、一条切换路径：
 *
 *   · room —— 屋内实体：坐在桌边呼吸（Canvas L7 画）
 *   · orb  —— 悬浮球：App 内 DOM 层的边缘小球（XiaobuOrb.vue 画）
 *
 * ★ 合规红线（架构文档 §合规）：悬浮球**只在 App 内部的 DOM 层实现**，
 *   绝不申请系统悬浮窗权限（Android SYSTEM_ALERT_WINDOW / iOS 任何越界窗口）。
 *   这个 store 永远不会、也不需要知道"窗口"以外的任何东西。
 *
 * ★ 为什么是 Pinia 而不是模块级变量：悬浮球的坐标要被**两个渲染世界**读 ——
 *   Canvas（决定 L7 画不画）与 DOM（球画在哪、对话弹在哪）。
 *   响应式让两边各自 watch，不需要任何一方去"拉"对方。
 * ===========================================================================
 */
import { defineStore } from 'pinia'

export type XiaobuMode = 'room' | 'orb'

/** 球停靠边距（viewport px）：贴边留一点呼吸 */
export const ORB_MARGIN_PX = 16

export const useXiaobuFormStore = defineStore('xiaobuForm', {
  state: () => ({
    mode: 'room' as XiaobuMode,
    /** 球心位置（viewport px）。room 态下无意义，但保留最后位置以便回到同一处 */
    orb: { x: 0, y: 0 },
    /** 小卜对话输入框是否弹出（点球开、点外收） */
    chatOpen: false,
    /** 输入框草稿（v-model）。★ 上限 200，与服务端 /api/chat 契约同一把尺子 */
    draft: '',
    /**
     * 低语卡：用户上一句 + 小卜的一句回应。
     * ★ 不做聊天记录流 —— 后到的替换先到的（「同一时刻只有一处气泡」）。
     */
    latest: { mine: '', reply: '' },
    /** 云端同意镜像。★ 真源在引擎持久化里，这里只给 UI 一个反应式读点 */
    cloudConsent: 'off' as 'off' | 'on',
    /** 小卜"正在想"：仅在等云端回应的短暂窗口为真（本地回应是同步的，不会看到它） */
    typing: false,
  }),

  actions: {
    /**
     * 化球。`drop` 是松手时的 viewport 坐标 —— 球从手指松开的地方出现，
     * 随即吸附到最近的左右边缘（规范：「停留在 App 内屏幕边缘」）。
     */
    becomeOrb(drop: { x: number; y: number }, viewport: { w: number; h: number }): void {
      this.mode = 'orb'
      this.chatOpen = false
      this.orb = clampToEdge(drop, viewport)
    },

    /** 回屋。★ 画布侧的复位（setXiaobuVisible / resetXiaobuPos）由调用方顺手做 ——
     *  store 不 import scene（保持 store 不认识渲染层的边界） */
    backToRoom(): void {
      this.mode = 'room'
      this.chatOpen = false
      this.clearTurn()
    },

    /** 拖球：实时跟随（已 clamp 在视口内），松手时再调 snapToEdge */
    moveOrb(p: { x: number; y: number }, viewport: { w: number; h: number }): void {
      if (this.mode !== 'orb') return
      this.orb = clampToViewport(p, viewport)
    },

    /** 松手吸附：吸附到最近的左右边缘，纵向保持 */
    snapOrbToEdge(viewport: { w: number; h: number }): void {
      if (this.mode !== 'orb') return
      this.orb = clampToEdge(this.orb, viewport)
    },

    toggleChat(open?: boolean): void {
      if (this.mode !== 'orb') return
      this.chatOpen = open ?? !this.chatOpen
    },

    /** 草稿写入（v-model）。★ 这里也截到 200 —— 不让用户打出根本不发的东西 */
    setDraft(v: string): void {
      this.draft = String(v ?? '').slice(0, 200)
    },

    /** 写入一轮低语：用户原话 + 小卜回应（同帧替换，永远只留最近一句） */
    setReply(mine: string, reply: string): void {
      this.latest = { mine: String(mine ?? ''), reply: String(reply ?? '') }
    },

    /** 同步云端同意镜像（真源在引擎持久化） */
    setConsent(c: 'off' | 'on'): void {
      this.cloudConsent = c === 'on' ? 'on' : 'off'
    },

    /** 小卜"正在想"的轻指示开关 */
    setTyping(v: boolean): void {
      this.typing = v === true
    },

    /** 清空本轮（收起输入框 / 回屋时）。★ 不动 cloudConsent —— 那是长期偏好，不随一轮清掉 */
    clearTurn(): void {
      this.draft = ''
      this.latest = { mine: '', reply: '' }
      this.typing = false
    },
  },
})

/** 视口内 clamp（拖动中：哪儿都能去，但不出屏） */
function clampToViewport(p: { x: number; y: number }, v: { w: number; h: number }): { x: number; y: number } {
  const r = ORB_RADIUS_PX
  return {
    x: Math.min(Math.max(p.x, ORB_MARGIN_PX + r), Math.max(ORB_MARGIN_PX + r, v.w - ORB_MARGIN_PX - r)),
    y: Math.min(Math.max(p.y, ORB_MARGIN_PX + r), Math.max(ORB_MARGIN_PX + r, v.h - ORB_MARGIN_PX - r)),
  }
}

/** 边缘吸附（松手：x 吸到最近的左右边，y 保持并 clamp） */
function clampToEdge(p: { x: number; y: number }, v: { w: number; h: number }): { x: number; y: number } {
  const inner = clampToViewport(p, v)
  const lo = ORB_MARGIN_PX + ORB_RADIUS_PX
  // ★ 超窄视口兜底：右缘坐标不允许小于左缘（否则"吸附"会把球推到屏幕外）
  const right = Math.max(v.w - ORB_MARGIN_PX - ORB_RADIUS_PX, lo)
  return { x: inner.x <= (lo + right) / 2 ? lo : right, y: inner.y }
}

/** 球半径（viewport px）。DOM 尺寸的一半，clamp 用 */
export const ORB_RADIUS_PX = 24
