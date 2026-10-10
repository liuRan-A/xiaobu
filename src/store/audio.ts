/**
 * 小卜 · 背景音状态   src/store/audio.ts
 * ===========================================================================
 * 背景环境音的**唯一真相**（给 UI 用的反应式投影）：
 *
 *   · `muted`  —— 用户是否关掉了环境音。真源在引擎持久化（记住长期选择），
 *                 这里的 state 只是给 HUD 一个反应式读点。
 *   · `ready`  —— 装配层是否已经"装过一次"（幂等；避免重复挂 pointerdown 监听）。
 *
 * ★ 三条纪律
 *   ① **播放器只被这一层驱动**：UI / 装配层都通过它开关，不直接碰 @audio。
 *   ② **到点不抛**：读引擎、写偏好、切静音全部 try/catch + logger.warn（门禁⑨），
 *      最坏情况是"没有背景音"，绝不弹 UI、绝不影响任何玩法。
 *   ③ **默认不静音**：环境音是氛围的一部分，默认开着；用户点一下即永久关掉。
 *
 * ★ 与语音/共情同意同路：三者都是"用户的长期选择"，都经引擎持有的 PersistedStore
 *   落盘（见 core/persist.ts 的 PERSIST_KEYS）。
 * ===========================================================================
 */
import { defineStore } from 'pinia'
import { logger } from '@shared/logger'
import { getEngine } from '@store/engineHost'
import { installAmbientAudio, setAmbientMuted } from '@audio'

export const useAudioStore = defineStore('audio', {
  state: () => ({
    /** 是否静音（真源在引擎持久化里） */
    muted: false,
    /** 是否已经装过播放器（幂等标记） */
    ready: false,
  }),

  actions: {
    /**
     * 装配一次背景音。★ 幂等、非阻塞、永不抛。
     * 顺序：先把持久化的静音偏好同步进播放器，再装（装的动作会尝试一次播放）。
     */
    start(): void {
      if (this.ready) return
      this.ready = true
      this.syncFromEngine()
      setAmbientMuted(this.muted)
      installAmbientAudio()
    },

    /** 从引擎读一次静音偏好（冷启动 / 面板打开时同步） */
    syncFromEngine(): void {
      try {
        this.muted = getEngine().getAudioMuted()
      } catch (e) {
        // ★ 门禁⑨：读不到就按默认（不静音）处理，绝不弹 UI
        logger.warn('[audio] 读取静音偏好失败（按默认处理）', e)
      }
    },

    /** 设置静音。★ 立即生效 + 写回持久化（下一次 flush 落盘） */
    setMuted(v: boolean): void {
      this.muted = v === true
      setAmbientMuted(this.muted)
      try {
        getEngine().setAudioMuted(this.muted)
      } catch (e) {
        logger.warn('[audio] 写静音偏好失败（本次仍生效）', e)
      }
    },

    /** 一键静音 / 取消静音 */
    toggle(): void {
      this.setMuted(!this.muted)
    },
  },
})
