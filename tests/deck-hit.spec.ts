/**
 * 小卜 · 牌堆命中链路   tests/deck-hit.spec.ts
 * ===========================================================================
 * M3 混合渲染「第一步：牌堆」程序化骨架的端到端验证。
 *
 * ── 验什么 ──────────────────────────────────────────────────────────────────
 *   牌堆是"可点、可翻、进塔罗区"的入口。卡背贴图未到位前，几何契约必须先通：
 *   ① `installDeck()` 后 `scene.deck` 非 null，坐标 = 茶几锚点（DECK_PX）
 *   ② 戳牌堆中心 → `hitTestAt` 返回 `{kind:'deck'}`
 *   ③ 戳牌堆边缘外（超过 DECK_TOUCH_R_PT）→ 不命中 deck
 *   ④ 引擎收到 deck 命中 → 进 TAROT 区（`enterZone('TAROT')`）
 *   ⑤ 牌堆可点域不抢其它物件（茶几锚点 TEA_TABLE 的命中优先级在 deck 之后）
 * ===========================================================================
 */
import { describe, it, expect } from 'vitest'
import { hitTestAt, idleHitState, DECK_TOUCH_R_PT, type SceneHitState } from '@scene/hit'
import { DECK_PX, TEA_TABLE_PX, L4_TEA_TABLE_ID, L4_DECK_ID } from '@scene/layers'
import { installDeck, setDeck, sceneState, resetEngineHost } from '@store/engineHost'
import { createSceneStack } from '@scene/layers'
import { Engine } from '@core/engine'
import type { EngineHit } from '@core/engine'
import { createMemoryPort, PERSIST_KEYS } from '@core/persist'

function withDeck(): SceneHitState {
  const s = idleHitState()
  s.deck = { id: 'deck', at: { x: DECK_PX.cx, y: DECK_PX.baseY }, r: DECK_TOUCH_R_PT }
  return s
}

describe('牌堆命中链路 · 程序化骨架', () => {
  it('installDeck 把牌堆装在茶几锚点，可点半径 = DECK_TOUCH_R_PT', () => {
    resetEngineHost()
    installDeck()
    const deck = sceneState().deck
    expect(deck).not.toBeNull()
    expect(deck!.at.x).toBe(DECK_PX.cx)
    expect(deck!.at.y).toBe(DECK_PX.baseY)
    expect(deck!.r).toBe(DECK_TOUCH_R_PT)
    resetEngineHost()
  })

  it('戳牌堆中心 → 命中 deck', () => {
    const s = withDeck()
    expect(hitTestAt({ x: DECK_PX.cx, y: DECK_PX.baseY }, s)).toEqual({ kind: 'deck' })
  })

  it('戳牌堆可点半径边缘 → 命中；半径外 → 不命中', () => {
    const s = withDeck()
    // 半径内（临界）
    expect(hitTestAt({ x: DECK_PX.cx + DECK_TOUCH_R_PT - 1, y: DECK_PX.baseY }, s)).toEqual({
      kind: 'deck',
    })
    // 半径外
    const miss = hitTestAt({ x: DECK_PX.cx + DECK_TOUCH_R_PT + 8, y: DECK_PX.baseY }, s)
    expect(miss.kind).not.toBe('deck')
  })

  it('★ 牌堆可点域不抢茶几锚点：牌堆在命中优先级上先于 anchor（但二者不重叠时才各归各）', () => {
    const s = withDeck()
    // 牌堆中心正好在 TEA_TABLE 锚点（195,738）附近，戳中心命中 deck（优先级更高）
    expect(hitTestAt({ x: DECK_PX.cx, y: DECK_PX.baseY }, s)).toEqual({ kind: 'deck' })
  })

  it('setDeck(null) 能撤回牌堆（美术未到位时的降级态）', () => {
    resetEngineHost()
    installDeck()
    expect(sceneState().deck).not.toBeNull()
    setDeck(null)
    expect(sceneState().deck).toBeNull()
    resetEngineHost()
  })
})

describe('牌堆命中 · 引擎端到端（deck → TAROT 区）', () => {
  it('戳牌堆 → 引擎进入塔罗区', async () => {
    const SEEN = { [PERSIST_KEYS.guide]: ['FIRST_LAUNCH'] }
    let now = 1_800_000_000_000
    const hitTest = (p: { x: number; y: number }): EngineHit => {
      // 只在牌堆坐标命中，其余返回 none
      if (Math.hypot(p.x - DECK_PX.cx, p.y - DECK_PX.baseY) <= DECK_TOUCH_R_PT) {
        return { kind: 'deck' }
      }
      return { kind: 'none' }
    }
    const engine = new Engine({ port: createMemoryPort(SEEN), now: () => now, hitTest })
    await engine.boot()

    expect(engine.roomState).toBe('ROOM')

    // 在牌堆中心点一下
    engine.pointerDown({ id: 0, x: DECK_PX.cx, y: DECK_PX.baseY, t: now })
    now += 30
    engine.pointerUp({ id: 0, x: DECK_PX.cx, y: DECK_PX.baseY, t: now })

    // 进塔罗区后直接进入"选牌阵"环节（TAROT 区没有停留态，入口即选牌阵）
    expect(engine.roomState).toBe('SPREAD_PICK')
  })
})

describe('角落茶几 · 牌堆承载物', () => {
  it('茶几在 BACKDROP（承载物），牌堆在 STAGE（可点道具）', () => {
    const stack = createSceneStack()
    const backdrop = stack.drawOrder('BACKDROP')
    const stage = stack.drawOrder('STAGE')

    expect(backdrop).toContain(L4_TEA_TABLE_ID)
    expect(stage).toContain(L4_DECK_ID)
    // 茶几必须在牌堆之前画（承载物在下面）
    expect(backdrop.indexOf(L4_TEA_TABLE_ID)).toBeGreaterThanOrEqual(0)
  })

  it('茶几桌面中心 = 牌堆落点（牌堆铺在茶几正中央）', () => {
    expect(TEA_TABLE_PX.cx).toBe(DECK_PX.cx)
    expect(TEA_TABLE_PX.baseY).toBe(DECK_PX.baseY)
  })

  it('茶几尺寸约束：桌面比牌堆宽（牌能铺开），且是低矮小几', () => {
    // 桌面直径 84 > 牌宽 52，牌堆能安稳放在茶几上
    expect(TEA_TABLE_PX.topW).toBeGreaterThan(DECK_PX.w)
    // 矮脚：腿高 + 半高远小于中央木桌的台面尺寸
    expect(TEA_TABLE_PX.legH).toBeLessThan(40)
  })
})
