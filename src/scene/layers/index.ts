/**
 * 小卜 · 场景装配   src/scene/layers/index.ts
 * ===========================================================================
 * 把 L1–L9 注册进渲染栈。**这是唯一一处"画面的组成清单"** ——
 * 想知道这个场景有哪些东西、各自在哪一层、什么顺序，看这一个函数就够了。
 *
 * 注册顺序不影响绘制顺序（顺序由 LayerStack 的趟 + 排序键决定），
 * 所以这里按 L 号排列纯粹是为了可读性。
 *
 * ★ 关于"天气能改什么"
 *   本文件里只有 L8 / L9 暴露了写入口（setVeilOpacity / setGrade）。
 *   L1–L7 没有任何对外的可变接口 —— 天气模块在类型层面就够不到它们。
 * ===========================================================================
 */

import { LayerStack } from '@scene/renderer'
import { registerL1 } from './L1Space'
import { registerL2 } from './L2Felt'
import { registerL3 } from './L3Table'
import { registerL4, registerDeck, registerMemoryItem, registerTeaTable, registerTimepiece } from './L4Props'
import { registerL5 } from './L5Plant'
import { registerL6 } from './L6Board'
import { registerL7 } from './L7Xiaobu'
import { registerL8 } from './L8Veil'
import { registerL9 } from './L9Grade'
import { registerL10 } from './L10Paper'

/** 把完整的黄昏小屋注册进给定渲染栈 */
export function registerScene(stack: LayerStack): LayerStack {
  registerL1(stack) // L1 空间：墙 / 暖窗 / 壁灯 / 地板   —— BACKDROP（static）
  registerL2(stack) // L2 毛毡地毯                        —— BACKDROP（static）
  registerL3(stack) // L3 木桌                            —— BACKDROP（static）
  registerTeaTable(stack) // L3b 角落茶几（牌堆承载物）   —— BACKDROP（static）
  registerL4(stack) // L4 竹筒 + 待机铜钱 ×2              —— STAGE（影子排序）
  registerDeck(stack) // L4b 塔罗牌堆（程序化骨架）       —— STAGE（底座 y 排序）
  registerTimepiece(stack) // L4c 沙漏摆件（倒计时可视化）—— STAGE（底座 y 排序）
  registerMemoryItem(stack) // L4d 记忆锚点摆件（共创摆件链路）—— STAGE（at.y 排序）
  registerL5(stack) // L5 窗边小盆栽                      —— STAGE
  registerL6(stack) // L6 卦盘 + 六爻位槽                 —— STAGE（平台取最远角）
  registerL7(stack) // L7 小卜（呼吸中）                  —— STAGE
  registerL8(stack) // L8 暖色薄纱                        —— GRADE（static）★天气可写
  registerL9(stack) // L9 暖光晕 + 暗角                    —— GRADE（static）★天气可写
  registerL10(stack) // L10 纸张质感（琥珀遮罩 + 水彩噪点）—— GRADE（static）非天气可写
  return stack
}

/** 建一个装着完整场景的渲染栈 */
export function createSceneStack(): LayerStack {
  return registerScene(new LayerStack())
}

export { registerL1, registerL2, registerL3, registerL4, registerL5, registerL6, registerL7, registerL8, registerL9, registerL10 }
export { setVeilOpacity, getVeilOpacity } from './L8Veil'
export { setGrade, getGrade } from './L9Grade'
export { drawCoinAt, drawCoinShadow, setTubeShake, setCoinDim, coinIdleAlpha, TUBE_METRICS, L4_COIN_ID, L4_TUBE_ID, registerDeck, L4_DECK_ID, DECK_METRICS, drawDeckTop, setDeckBackTex, deckBackTexReady, setCardFaceTex, cardFaceTexReady, clearCardFaceTex, drawCardFace, registerTeaTable, L4_TEA_TABLE_ID, TEA_TABLE_METRICS, registerTimepiece, L4_TIMEPIECE_ID, setTimepieces, timepieceCount, registerMemoryItem, L4_MEMORY_ID, setMemoryItems, setPendingMemory, memoryItemCount, type MemoryItemView } from './L4Props'
export { withTableClip } from './L3Table'
export { L7_ID, setXiaobuVisible, setXiaobuPos, resetXiaobuPos, xiaobuAt, xiaobuVisibleNow } from './L7Xiaobu'
export { slotGrooveQuad, L6_ID } from './L6Board'
export { roundRect, roundRectTop } from './L1Space'
export * from './worldLayout'
