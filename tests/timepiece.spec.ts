/**
 * 小卜 · 沙漏摆件（M3 第三步）   tests/timepiece.spec.ts
 * ===========================================================================
 * 沙漏是倒计时的"实物化身"。验证三件事：
 *   ① 渲染层：`setTimepieces` / `timepieceCount` 正确驱动沙漏数量与位置
 *   ② 层级：沙漏渲染项在 STAGE 趟（有高度，随摆件一起遮挡排序）
 *   ③ 命中链路：倒计时摆件命中 → openCountdown → COUNTDOWN_SET
 * ===========================================================================
 */
import { describe, it, expect, afterEach } from 'vitest'
import { setTimepieces, timepieceCount, L4_TIMEPIECE_ID } from '@scene/layers'
import { createSceneStack } from '@scene/layers'
import { Engine } from '@core/engine'
import type { EngineHit } from '@core/engine'
import { createMemoryPort, PERSIST_KEYS } from '@core/persist'

afterEach(() => {
  setTimepieces([])
})

describe('沙漏摆件 · 渲染层', () => {
  it('setTimepieces 驱动沙漏数量，timepieceCount 可读', () => {
    setTimepieces([])
    expect(timepieceCount()).toBe(0)

    setTimepieces([{ x: 110, y: 226 }, { x: 400, y: 500 }])
    expect(timepieceCount()).toBe(2)

    setTimepieces([])
    expect(timepieceCount()).toBe(0)
  })

  it('沙漏渲染项注册在 STAGE 趟', () => {
    const stack = createSceneStack()
    const stage = stack.drawOrder('STAGE')
    expect(stage).toContain(L4_TIMEPIECE_ID)
  })
})

describe('沙漏摆件 · 命中链路（timepiece → COUNTDOWN_SET）', () => {
  it('戳倒计时摆件 → 打开倒计时设置面板', async () => {
    const SEEN = { [PERSIST_KEYS.guide]: ['FIRST_LAUNCH'] }
    let now = 1_800_000_000_000
    const hitTest = (p: { x: number; y: number }): EngineHit => {
      // 沙漏摆件落在窗边锚点 (110, 226)
      if (Math.hypot(p.x - 110, p.y - 226) <= 40) return { kind: 'timepiece', id: 'c1' }
      return { kind: 'none' }
    }
    const engine = new Engine({ port: createMemoryPort(SEEN), now: () => now, hitTest })
    await engine.boot()

    expect(engine.roomState).toBe('ROOM')

    engine.pointerDown({ id: 0, x: 110, y: 226, t: now })
    now += 30
    engine.pointerUp({ id: 0, x: 110, y: 226, t: now })

    expect(engine.roomState).toBe('COUNTDOWN_SET')
  })
})
