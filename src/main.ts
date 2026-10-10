/**
 * 小卜 · 唯一入口   src/main.ts
 * ---------------------------------------------------------------------------
 * 【启动契约】首帧必须同步渲染
 *   bootSequence() 里的每一步都不许 await 网络。第一个像素用的是内置配置，
 *   远端配置晚到了再"悄悄换挡"，用户全程无感（规划 §5 / Checklist A2–A6）。
 *
 * 【两条防崩底线约束 —— CI 门禁扫描，违反即构建失败】
 *   门禁 ⑨  catch 块禁止出 UI
 *           本文件及全仓任何 catch 内，不许出现 alert / confirm / Toast /
 *           showModal / showToast。用户永远不该看见"操作失败，请重试"。
 *           错误只走 @shared/errors/handle → 需要安抚时，由小卜的气泡开口。
 *   门禁 ⑩  禁止使用 LocalStorage 持久化上报队列
 *           埋点只在内存数组里缓冲；上报失败即丢，不落 localStorage /
 *           IndexedDB / Preferences，不建任何重试队列。
 * ---------------------------------------------------------------------------
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import { bootSequence } from '@bootstrap/bootSequence'
import { handle } from '@shared/errors/handle'

// ── ① 同步启动：先拿到配置（内置 / 缓存），派生 UI 状态，再挂载 ────────────
//    注意：这里刻意不 await。远端配置在 bootSequence 内部以 void 方式发起。
bootSequence()

// ── ② 挂载 ────────────────────────────────────────────────────────────────
const app = createApp(App)
app.use(createPinia())

// 全局兜底：Vue 组件内抛出的异常统一收敛，绝不冒泡成白屏
app.config.errorHandler = (err, _instance, _info) => {
  // ★ 门禁 ⑨：这里只记日志 + 脱敏埋点 + 分类降级，不许出现任何 UI 调用
  handle(err, 'vue.errorHandler')
}

app.mount('#app')

// ── ③ 原生层的裸异常也要接住 ──────────────────────────────────────────────
window.addEventListener('error', (e) => {
  // ★ 门禁 ⑨：同上。事件循环里的错误最容易变成"白屏 + 用户一脸懵"
  handle(e.error ?? e, 'window.onerror')
})

window.addEventListener('unhandledrejection', (e) => {
  // ★ 门禁 ⑨：未处理的 Promise rejection 是弱网下的常客，必须被接住
  handle(e.reason, 'unhandledrejection')
})

// ── ④ 首帧已出，撤掉 HTML 里的暖色遮罩（不是"加载页"，只是一层呼吸圆点） ──
requestAnimationFrame(() => {
  document.getElementById('boot-veil')?.classList.add('gone')
})
