<script setup lang="ts">
/**
 * 小卜 · 唯一根组件   src/App.vue
 * ---------------------------------------------------------------------------
 * z 轴从下到上：
 *   z-0   Canvas 场景（2.5D 微缩世界）
 *   z-10  DOM overlay（HUD / 悬浮球 / 气泡 / 解读页都挂在这里）
 *   z-60  翻书启动流（盖住一切，翻完才揭）
 *   z-80  换景白光（书 → 小屋的漫反射过渡）
 *
 * ★ 本组件内不写业务逻辑、不发任何请求、不读天气、不读开发模式。
 * ★ 界面的"容错出口"只有一处：ui/components/BubbleXiaobu.vue
 *   （门禁 ⑨：任何 catch 都不许自己弹 UI，一律交给气泡）
 * ---------------------------------------------------------------------------
 */
import { ref } from 'vue'
import Scene from '@scene/Scene.vue'
import HudOverlay from '@ui/components/HudOverlay.vue'
import XiaobuOrb from '@ui/components/XiaobuOrb.vue'
import IntroBook from '@ui/components/IntroBook.vue'
import MemoryOfferCard from '@ui/components/MemoryOfferCard.vue'
import MemoryRecallCard from '@ui/components/MemoryRecallCard.vue'
import SheetResult from '@ui/components/SheetResult.vue'
import { useAppFlowStore } from '@store/appFlow'
import '@ui/styles/tokens.css' // 设计 Token：Canvas 与 DOM 共用同一份常量（规划 §6）

const flow = useAppFlowStore()

/** 换景白光：true = 盖屏；fading = 从盖屏淡出到 0 */
const roomVeil = ref(false)
const roomVeilFading = ref(false)

/**
 * 书翻完了（IntroBook 的白光已升满，盖住了切换瞬间）：
 * 幕间换景 —— 卸书、显屋，白光从盖屏淡出，小卜随后飞入。
 */
function onBookEntered(): void {
  flow.beginRoomMain()
  roomVeil.value = true
  // 双 rAF：确保"opacity:1 的初始帧"先上屏，淡出过渡才不会丢
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      roomVeilFading.value = true
    })
  })
  // 淡出 700ms + 余量，撤掉白光层
  setTimeout(() => {
    roomVeil.value = false
    roomVeilFading.value = false
  }, 900)
}
</script>

<template>
  <div class="app-root">
    <!-- z-0 · 2.5D 微缩世界：Canvas2D 自研渲染，只画，不做决定 -->
    <Scene />

    <!-- z-10 · DOM overlay：全应用唯一的 UI 容错出口将在 D8 挂到这里 -->
    <div id="ui-overlay" class="ui-overlay">
      <!-- M3 阶段 A：主页 HUD 骨架（顶栏 / 提示卡 / 输入区 / 底部导航） -->
      <HudOverlay />
      <!-- 阶段 B：小卜悬浮球（App 内 DOM 层，绝不申请系统悬浮窗权限） -->
      <XiaobuOrb />
      <!-- 共创摆件链路 P0 · 候选摆件卡（MEMORY_OFFER 态）+ 浮现卡（MEMORY_RECALL 态） -->
      <MemoryOfferCard />
      <MemoryRecallCard />
      <!-- 解读层（READING 态）· 骨架：结构先立，文案待本地/云端接入 -->
      <SheetResult />
      <!-- 后续预留：
           <BubbleXiaobu />← 温柔容错气泡
           <DevPanel />    ← 仅 devMode 动态 import，生产包中不存在
      -->
    </div>

    <!-- z-60 · 翻书启动流：冷启动默认相位，翻完即卸 -->
    <IntroBook v-if="flow.phase === 'intro-book'" @entered="onBookEntered" />

    <!-- z-80 · 换景白光：书翻完后从盖屏淡出，露出小屋 -->
    <div v-if="roomVeil" class="room-veil" :class="{ 'room-veil--fading': roomVeilFading }" />
  </div>
</template>

<style scoped>
.app-root {
  position: fixed;
  inset: 0;
  /* ★ 防崩：容器自带暖奶油底色。即使 Canvas 初始化失败，也绝不会是纯白 */
  background: var(--c-cream, #fdf9f6);
  overflow: hidden;
  /* 手势全部交给 Canvas 自研处理，禁掉浏览器默认滚动/缩放 */
  touch-action: none;
}

.ui-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  /* 默认穿透：只有气泡/面板自身接管点击，避免 overlay 抢走掷币手势 */
  pointer-events: none;
}

.room-veil {
  position: absolute;
  inset: 0;
  z-index: 80;
  pointer-events: none;
  background: radial-gradient(100% 100% at 50% 45%, #fffdf8 0%, var(--c-sunbeam-soft, #ffeed2) 100%);
  opacity: 1;
}

.room-veil--fading {
  transition: opacity 700ms ease-out;
  opacity: 0;
}
</style>
