/**
 * 翻书启动流（阶段 C）测试 —— 纯逻辑部分
 * ───────────────────────────────────────────────────────────────────────────
 * ① introFlip 纯数学：进度换算 / 提交阈值 / 贝塞尔缓动
 * ② appFlow 相位机：intro-book → room-main 单向交接 + flyInPending 交棒
 * （书页 DOM 动画与 WebAudio 音效在 jsdom 里测不了真实表现，
 *   由浏览器端到端模拟兜底 —— 与门禁⑭「真机路径要真浏览器验」同一思想。）
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { clampProgress, flipEase, progressFromDrag, shouldCommitFlip, FLIP_COMMIT_AT } from '@ui/introFlip'
import { useAppFlowStore } from '@store/appFlow'

describe('① introFlip · 翻页数学（纯函数）', () => {
  it('进度钳制：负数与超 1 都收到 [0,1]，NaN 归 0', () => {
    expect(clampProgress(-0.3)).toBe(0)
    expect(clampProgress(0.42)).toBe(0.42)
    expect(clampProgress(1.7)).toBe(1)
    expect(clampProgress(Number.NaN)).toBe(0)
  })

  it('拖拽换算：向左拖为正方向，拖过一页宽 = 翻完', () => {
    expect(progressFromDrag(300, 300, 300)).toBe(0) // 没动
    expect(progressFromDrag(300, 150, 300)).toBe(0.5) // 拖半页
    expect(progressFromDrag(300, -10, 300)).toBe(1) // 拖过页宽
    expect(progressFromDrag(300, 400, 300)).toBe(0) // 向右回推
    expect(progressFromDrag(300, 0, 0)).toBe(0) // 页宽为 0 的防御
  })

  it('提交阈值：过半（0.55）即翻过去，差一点回弹', () => {
    expect(shouldCommitFlip(FLIP_COMMIT_AT)).toBe(true)
    expect(shouldCommitFlip(FLIP_COMMIT_AT - 0.01)).toBe(false)
    expect(shouldCommitFlip(0.99)).toBe(true)
  })

  it('贝塞尔缓动：起点 0、终点 1、单调、中段偏快（先快后顿）', () => {
    expect(flipEase(0)).toBe(0)
    expect(flipEase(1)).toBe(1)
    expect(flipEase(-1)).toBe(0)
    expect(flipEase(2)).toBe(1)
    // 单调
    for (let i = 1; i < 10; i++) {
      expect(flipEase(i / 10)).toBeGreaterThan(flipEase((i - 1) / 10))
    }
    // t=0.5 时已过半（"先快"）
    expect(flipEase(0.5)).toBeGreaterThan(0.5)
  })
})

describe('② appFlow · 应用相位机', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('冷启动默认 intro-book（不持久化、每次都翻）', () => {
    const s = useAppFlowStore()
    expect(s.phase).toBe('intro-book')
    expect(s.flyInPending).toBe(false)
  })

  it('翻完书：phase → room-main，flyInPending 置 true（交棒给悬浮球）', () => {
    const s = useAppFlowStore()
    s.beginRoomMain()
    expect(s.phase).toBe('room-main')
    expect(s.flyInPending).toBe(true)
  })

  it('幂等：重复 beginRoomMain 不重复触发飞入', () => {
    const s = useAppFlowStore()
    s.beginRoomMain()
    s.markFlyInDone()
    s.beginRoomMain() // 已在 room-main：不能再置 pending
    expect(s.flyInPending).toBe(false)
  })

  it('飞入完成：markFlyInDone 清掉标志', () => {
    const s = useAppFlowStore()
    s.beginRoomMain()
    expect(s.flyInPending).toBe(true)
    s.markFlyInDone()
    expect(s.flyInPending).toBe(false)
    expect(s.phase).toBe('room-main')
  })

  it('导航 tab：进屋后可自由切换，幂等', () => {
    const s = useAppFlowStore()
    s.switchTab('divine') // 书还没翻完：拒绝
    expect(s.activeTab).toBe('home')

    s.beginRoomMain()
    s.switchTab('divine')
    expect(s.activeTab).toBe('divine')
    s.switchTab('memory')
    expect(s.activeTab).toBe('memory')
    s.switchTab('memory') // 幂等
    expect(s.activeTab).toBe('memory')
    s.switchTab('home')
    expect(s.activeTab).toBe('home')
  })
})
