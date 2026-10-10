/**
 * 小卜双形态生命周期（阶段 B）测试
 * ───────────────────────────────────────────────────────────────────────────
 * 三块被测物，全部零 DOM / 零 canvas：
 *   ① xiaobuDrag 纯判定 —— 命中 / 拖动阈值 / 松手结局
 *   ② xiaobuForm store —— 化球 / 回屋 / 拖球 / 边缘吸附
 *   ③ L7 setter —— 可见性与位置（画布侧形态跟随）
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  dropOutcome,
  followDrag,
  hitXiaobu,
  isDrag,
  XIAOBU_DRAG_THRESHOLD_PT,
  XIAOBU_ORB_DISTANCE_PT,
} from '@scene/xiaobuDrag'
import { ORB_RADIUS_PX, useXiaobuFormStore } from '@store/xiaobuForm'
import { resetXiaobuPos, setXiaobuPos, setXiaobuVisible, xiaobuAt, xiaobuVisibleNow } from '@scene/layers'
import { XIAOBU_PX } from '@scene/layers'

const HOME = { x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY }

describe('① xiaobuDrag · 拖拽判定（纯函数）', () => {
  it('按在小卜身体中部 → 命中；偏出触摸半径 → 不命中', () => {
    expect(hitXiaobu({ x: HOME.x, y: HOME.y - 24 })).toBe(true)
    expect(hitXiaobu({ x: HOME.x + 29, y: HOME.y - 24 })).toBe(true) // 半径内边缘
    expect(hitXiaobu({ x: HOME.x + 45, y: HOME.y - 24 })).toBe(false) // 明显偏外
  })

  it('位移 < 阈值算点一下，≥ 阈值才算拖动', () => {
    expect(isDrag(HOME, { x: HOME.x + XIAOBU_DRAG_THRESHOLD_PT - 1, y: HOME.y })).toBe(false)
    expect(isDrag(HOME, { x: HOME.x + XIAOBU_DRAG_THRESHOLD_PT, y: HOME.y })).toBe(true)
  })

  it('松手离原位近 → 回桌边；拖出足够远 → 化悬浮球', () => {
    expect(dropOutcome(HOME, { x: HOME.x + XIAOBU_ORB_DISTANCE_PT - 5, y: HOME.y })).toBe('back')
    expect(dropOutcome(HOME, { x: HOME.x + XIAOBU_ORB_DISTANCE_PT + 20, y: HOME.y })).toBe('orb')
    // 原地按一下就松手：回桌边（不切形态）
    expect(dropOutcome(HOME, HOME)).toBe('back')
  })

  it('followDrag 原样放行（越界语义由 dropOutcome 决定，拖动中不打断）', () => {
    const p = { x: -999, y: 9999 }
    expect(followDrag(p)).toEqual(p)
  })
})

describe('② xiaobuForm store · 形态状态机', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始态：屋内实体，对话收起', () => {
    const s = useXiaobuFormStore()
    expect(s.mode).toBe('room')
    expect(s.chatOpen).toBe(false)
  })

  it('化球：吸附到最近边缘（松手在左半屏 → 贴左缘）', () => {
    const s = useXiaobuFormStore()
    s.becomeOrb({ x: 100, y: 300 }, { w: 390, h: 844 })
    expect(s.mode).toBe('orb')
    expect(s.orb.x).toBe(16 + ORB_RADIUS_PX) // 左缘
    expect(s.orb.y).toBe(300) // 纵向保持
  })

  it('化球：松手在右半屏 → 贴右缘', () => {
    const s = useXiaobuFormStore()
    s.becomeOrb({ x: 320, y: 500 }, { w: 390, h: 844 })
    expect(s.orb.x).toBe(390 - 16 - ORB_RADIUS_PX)
  })

  it('拖球实时跟随且不出屏；room 态下 moveOrb 是空操作', () => {
    const s = useXiaobuFormStore()
    s.becomeOrb({ x: 195, y: 400 }, { w: 390, h: 844 })
    s.moveOrb({ x: -50, y: 2000 }, { w: 390, h: 844 })
    expect(s.orb.x).toBeGreaterThanOrEqual(16 + ORB_RADIUS_PX)
    expect(s.orb.y).toBeLessThanOrEqual(844 - 16 - ORB_RADIUS_PX)

    s.backToRoom()
    const frozen = { ...s.orb }
    s.moveOrb({ x: 10, y: 10 }, { w: 390, h: 844 })
    expect(s.orb).toEqual(frozen) // 回屋后球坐标冻结
  })

  it('对话开关只在球态生效；回屋清对话', () => {
    const s = useXiaobuFormStore()
    s.toggleChat() // room 态：空操作
    expect(s.chatOpen).toBe(false)

    s.becomeOrb({ x: 100, y: 300 }, { w: 390, h: 844 })
    s.toggleChat()
    expect(s.chatOpen).toBe(true)

    s.backToRoom()
    expect(s.chatOpen).toBe(false)
    expect(s.mode).toBe('room')
  })

  it('吸附兜底：超窄视口也不出屏', () => {
    const s = useXiaobuFormStore()
    s.becomeOrb({ x: 195, y: 400 }, { w: 30, h: 844 }) // 视口比球还窄
    expect(s.orb.x).toBeGreaterThanOrEqual(16 + ORB_RADIUS_PX)
  })
})

describe('③ L7 setter · 画布侧形态跟随', () => {
  it('默认可见、站在美术稿站位', () => {
    resetXiaobuPos()
    setXiaobuVisible(true)
    expect(xiaobuVisibleNow()).toBe(true)
    expect(xiaobuAt()).toEqual({ x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY })
  })

  it('化球隐藏；拖拽喂位置；复位回站位', () => {
    resetXiaobuPos()
    setXiaobuPos({ x: 200, y: 600 })
    expect(xiaobuAt()).toEqual({ x: 200, y: 600 })

    setXiaobuVisible(false)
    expect(xiaobuVisibleNow()).toBe(false)

    resetXiaobuPos()
    setXiaobuVisible(true)
    expect(xiaobuAt()).toEqual({ x: XIAOBU_PX.cx, y: XIAOBU_PX.baseY })
    expect(xiaobuVisibleNow()).toBe(true)
  })
})
