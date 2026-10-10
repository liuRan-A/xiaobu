/**
 * 小卜 · 应用顶层流   src/store/appFlow.ts
 * ===========================================================================
 * 「应用此刻在哪个世界」的唯一真相。两个相位：
 *
 *   intro-book —— 翻书启动流：一本旧书盖在场景上，翻开它才进屋
 *   room-main  —— 2.5D 微缩小屋（主页）
 *
 * ★ 为什么不放进 roomMachine：roomMachine 管的是**屋内玩法流程**
 *   （占卜 / 记忆 / 倒计时），翻书是**进屋之前**的事 —— 屋里发生什么它一概不知。
 *   两台机器在"翻完书"这一点上单向交接一次，之后互不相认。
 *
 * ★ 冷启动默认 intro-book（《总成指令》§二）。不持久化、不跳过：
 *   翻书是仪式感的一部分，每次打开都翻。
 * ===========================================================================
 */
import { defineStore } from 'pinia'

export type AppPhase = 'intro-book' | 'room-main'

/** 底部导航的三个 tab。home = 2.5D 小屋，divine / memory = 全屏页 */
export type AppTab = 'home' | 'divine' | 'memory'

export const useAppFlowStore = defineStore('appFlow', {
  state: () => ({
    phase: 'intro-book' as AppPhase,
    /** 当前 tab。★ 相位是"在哪个世界"，tab 是"那个世界里的哪一页" */
    activeTab: 'home' as AppTab,
    /**
     * 小卜飞入待执行标志。
     * IntroBook 翻完 → beginRoomMain() 置 true；XiaobuOrb 看到它执行飞入序列后清掉。
     * 用标志而不是直接调用：store 不 import 组件，组件自己 watch —— 依赖方向干净。
     */
    flyInPending: false,
  }),

  actions: {
    /** 书翻完了：进屋 + 通知小卜飞入 */
    beginRoomMain(): void {
      if (this.phase === 'room-main') return
      this.phase = 'room-main'
      this.flyInPending = true
    },

    /** 小卜飞入序列完成（由 XiaobuOrb 调） */
    markFlyInDone(): void {
      this.flyInPending = false
    },

    /**
     * 切 tab（幂等）。★ 小卜的形态联动（去别的页化球、回小屋变实体）
     * **不在这里做** —— store 不 import scene，由 HUD 组件 watch 后调 scene setters。
     */
    switchTab(tab: AppTab): void {
      if (this.phase !== 'room-main') return // 书还没翻完，导航不可用
      this.activeTab = tab
    },
  },
})
