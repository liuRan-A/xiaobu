/**
 * 六爻「三枚一掷」与本地成卦   tests/liuyao-cast.spec.ts
 * ===========================================================================
 * 对应架构文档 §16.3 的 M2 最高优先级缺口：
 *   · M1 占位 `castLineImpl` 只有 7/8 —— 变爻（老阴 6 / 老阳 9）永远掷不出来，
 *     变卦机制形同虚设。本文件钉住真三枚一掷的概率形状与成卦正确性。
 *   · 卦象只能由本地爻值算出（buildHexagram）—— 天气 / 开发模式 / 网络都进不来。
 *   · 机器侧：六次落定 → CAST → 六爻交给收集器 → CAST_DONE 清盘回 IDLE。
 *   · 引擎侧：收集器 → buildHexagram → castDone → 房间机进 READING（D7 缺口接通）。
 * ===========================================================================
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildHexagram,
  castLine,
  castLineValue,
  tossCoin,
  FACE_BACK,
  FACE_ZI,
} from '@core/liuyao/castLine'
import {
  MIN_HOLD_MS,
  TOSS_MIN_PT,
  ritualMachine,
  setCastCollector,
  setCastLine,
  setCommandSink,
} from '@core/machine/ritualMachine'
import { roomMachine } from '@core/machine/roomMachine'
import { Engine } from '@core/engine'
import { createMemoryPort } from '@core/persist'

// ── 确定性随机源 ──────────────────────────────────────────────────────────

/** 循环序列：castLine 每次恰好消费 3 个 rand 调用 */
function seq(...rs: number[]): () => number {
  let i = 0
  return () => rs[i++ % rs.length]
}

/** 线性同余发生器：可复现的"真随机"，分布测试用它 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// ── 机器测试的驾驶工具 ────────────────────────────────────────────────────

/** 完整一掷：长按拾起 → 上滑掷出 → 落盘 → 吸进爻位槽 */
function tossOne(slot: number) {
  ritualMachine.send({ type: 'LONG_PRESS', coinId: 0, heldMs: MIN_HOLD_MS })
  ritualMachine.send({ type: 'RELEASE', distancePt: TOSS_MIN_PT, dir: { x: 0, y: -1 } })
  ritualMachine.send({ type: 'LANDED', landingPt: { x: 200, y: 530 } })
  return ritualMachine.send({ type: 'SNAP', slot: slot as 0 | 1 | 2 | 3 | 4 | 5 })
}

beforeEach(() => {
  // 仪式机是模块级单例：每个用例从干净态出发；指令通道与收集器静音
  setCommandSink(() => {})
  setCastCollector(() => {})
  ritualMachine.reset()
})

// ── 一、铜钱与三枚一掷 ────────────────────────────────────────────────────

describe('三枚一掷 · 铜钱面值与概率', () => {
  it('一枚铜钱：rand<0.5 翻出背面（阳=3），否则字面（阴=2）', () => {
    expect(tossCoin(() => 0.25)).toBe(FACE_BACK)
    expect(tossCoin(() => 0.75)).toBe(FACE_ZI)
  })

  it('面值映射：三背=9 老阳 / 三字=6 老阴 / 两背一字=8 少阴 / 一背两字=7 少阳', () => {
    expect(castLine(seq(0.1, 0.2, 0.3))).toEqual({ coins: [3, 3, 3], value: 9 })
    expect(castLine(seq(0.9, 0.8, 0.7))).toEqual({ coins: [2, 2, 2], value: 6 })
    expect(castLine(seq(0.1, 0.2, 0.9))).toEqual({ coins: [3, 3, 2], value: 8 })
    expect(castLine(seq(0.1, 0.9, 0.8))).toEqual({ coins: [3, 2, 2], value: 7 })
  })

  it('分布 1/8 : 3/8 : 3/8 : 1/8 —— 老阴老阳真实可达（M1 占位永远掷不出）', () => {
    const rand = lcg(42)
    const N = 16000
    const count: Record<number, number> = { 6: 0, 7: 0, 8: 0, 9: 0 }
    for (let i = 0; i < N; i++) count[castLineValue(rand)]++

    const p = (v: number) => count[v] / N
    // 16000 次下 1/8 的标准误 ≈ 0.0026，给 ±0.02 的宽容带
    expect(p(6)).toBeGreaterThan(0.105)
    expect(p(6)).toBeLessThan(0.145)
    expect(p(9)).toBeGreaterThan(0.105)
    expect(p(9)).toBeLessThan(0.145)
    // 3/8 同理
    expect(p(7)).toBeGreaterThan(0.355)
    expect(p(7)).toBeLessThan(0.405)
    expect(p(8)).toBeGreaterThan(0.355)
    expect(p(8)).toBeLessThan(0.405)
    expect(count[6] + count[7] + count[8] + count[9]).toBe(N)
  })
})

// ── 二、本地成卦 ──────────────────────────────────────────────────────────

describe('buildHexagram · 六爻 → 本卦/变卦', () => {
  it('六少阳 = 乾（1），无动爻 → 变卦 null', () => {
    expect(buildHexagram([7, 7, 7, 7, 7, 7])).toEqual({ primary: 1, changed: null, moving: [] })
  })

  it('六少阴 = 坤（2）', () => {
    expect(buildHexagram([8, 8, 8, 8, 8, 8]).primary).toBe(2)
  })

  it('泰（11）与否（12）—— 初爻在下，爻序不可颠倒', () => {
    expect(buildHexagram([7, 7, 7, 8, 8, 8]).primary).toBe(11) // 下乾上坤 = 地天泰
    expect(buildHexagram([8, 8, 8, 7, 7, 7]).primary).toBe(12) // 下坤上乾 = 天地否
  })

  it('乾上爻动（老阳 9）→ 变卦 夬（43），动爻位 [5]', () => {
    expect(buildHexagram([7, 7, 7, 7, 7, 9])).toEqual({ primary: 1, changed: 43, moving: [5] })
  })

  it('泰初爻动 → 变卦 升（46），动爻位 [0]', () => {
    expect(buildHexagram([9, 7, 7, 8, 8, 8])).toEqual({ primary: 11, changed: 46, moving: [0] })
  })

  it('六爻全老阳 → 本卦乾、动爻全开、变卦坤（2）', () => {
    expect(buildHexagram([9, 9, 9, 9, 9, 9])).toEqual({
      primary: 1,
      changed: 2,
      moving: [0, 1, 2, 3, 4, 5],
    })
  })

  it('不足六爻是调用方的 bug：直接抛（CAST 只在第六爻落定后进入，正常流程到不了）', () => {
    expect(() => buildHexagram([7, 7, 7, 7, 7])).toThrow()
  })
})

// ── 三、仪式机集成 ────────────────────────────────────────────────────────

describe('ritualMachine · 三枚一掷接入', () => {
  it('六次落定 → CAST，六爻按落定顺序交给收集器；CAST_DONE 清盘回 IDLE', () => {
    setCastLine(() => 9)
    let captured: readonly number[] | null = null
    setCastCollector((lines) => {
      captured = [...lines]
    })

    for (let slot = 0; slot < 6; slot++) {
      expect(tossOne(slot)).toBe(slot === 5 ? 'CAST' : 'IDLE')
    }
    expect(ritualMachine.state).toBe('CAST')
    expect(captured).toEqual([9, 9, 9, 9, 9, 9])

    ritualMachine.send({ type: 'CAST_DONE' })
    expect(ritualMachine.state).toBe('IDLE')
    expect(ritualMachine.ctx.lines).toEqual([])
    expect(ritualMachine.ctx.slotCoins).toEqual([-1, -1, -1, -1, -1, -1])
  })

  it('默认实现 = 真三枚一掷：值域不出 {6,7,8,9}，变爻在 60 掷内必然出现', () => {
    // ★ rand 生成器必须建在闭包外 —— 写成 `castLineValue(lcg(7))` 会让
    //   每一掷都从同一种子重新开始，60 掷掷出 60 个一模一样的爻
    const rand = lcg(7)
    setCastLine(() => castLineValue(rand))
    const seen = new Set<number>()
    for (let slot = 0; slot < 60; slot++) {
      tossOne(slot % 6)
      // 每逢 CAST（第 6 枚）→ CAST_DONE 回 IDLE，让循环可以一直掷下去
      if (ritualMachine.state === 'CAST') ritualMachine.send({ type: 'CAST_DONE' })
      ritualMachine.ctx.lines.forEach((v) => seen.add(v))
    }
    expect([...seen].every((v) => v === 6 || v === 7 || v === 8 || v === 9)).toBe(true)
    // (3/4)^60 ≈ 3e-8：不出现老阴/老阳的概率可忽略
    expect(seen.has(6) || seen.has(9)).toBe(true)
  })
})

// ── 四、引擎收口 ──────────────────────────────────────────────────────────

describe('engine · 三枚一掷 → 本地建卦 → 房间机进解读', () => {
  it('六爻掷完，buildHexagram 的卦象直达 READING（D7 缺口接通）', async () => {
    // 见过首启引导 → boot 后直接 ROOM；boot 全程本地，无网络
    const engine = new Engine({ port: createMemoryPort({ 'xiaobu.guide.v1': ['FIRST_LAUNCH'] }) })
    await engine.boot()

    // 与 guide-gesture-room.spec 同一条进仪式的路：进分区 → 心情 → 方向 → 放下道具
    roomMachine.send({ type: 'ENTER_ZONE', zone: 'LIUYAO' })
    expect(roomMachine.send({ type: 'PICK_MOOD', tone: 'ANXIOUS' })).toBe('FOCUS_PICK')
    expect(roomMachine.send({ type: 'PICK_FOCUS', focus: 'CAREER' })).toBe('PLACE_ITEM')
    expect(roomMachine.send({ type: 'PLACE_ITEM', anchorId: null, at: { x: 300, y: 300 } })).toBe('RITUAL')

    setCastLine(() => 7) // 六少阳 = 乾（1），无动爻
    for (let slot = 0; slot < 6; slot++) tossOne(slot)

    expect(ritualMachine.state).toBe('CAST')
    expect(roomMachine.state).toBe('READING')
    expect(roomMachine.ctx.hexagram).toEqual({ primary: 1, changed: null, moving: [] })
  })
})
