/**
 * 小卜 · 六爻「三枚一掷」与本地成卦   src/core/liuyao/castLine.ts
 * ===========================================================================
 * 架构文档 §16.3 登记的 M2 缺口，本文件是它的实现。
 *
 * ── 三枚一掷 ────────────────────────────────────────────────────────────
 * 一次掷 = 三枚铜钱各翻一面：
 *   · 背（阳面）记 3，字（阴面）记 2；
 *   · 三枚之和 ∈ {6,7,8,9}：
 *       6 = 三字（老阴）  7 = 一背两字（少阳）
 *       8 = 两背一字（少阴） 9 = 三背（老阳）
 *   · 概率 1/8 : 3/8 : 3/8 : 1/8 —— 老阴 / 老阳（动爻）真实存在。
 *     ★ M1 占位实现（`Math.random() < 0.5 ? 7 : 8`）的实质缺陷是
 *       "变爻永远掷不出来"：卦象永远是静卦，变卦机制形同虚设。
 *
 * ── 本地成卦 ────────────────────────────────────────────────────────────
 * 六爻 → 本卦 / 变卦（King Wen 序号 1–64）：
 *   · 少阳 7 / 少阴 8 定卦身；老阳 9 / 老阴 6 是动爻（变卦时翻转该爻）；
 *   · lines[0] = 初爻（自下而上）；下卦 = lines[0..2]，上卦 = lines[3..5]；
 *   · 爻位二进制：阳 = 1（7/9），阴 = 0（8/6）；
 *     卦代码 = 初位 + 2×中位 + 4×上位（坤0 震1 坎2 兑3 艮4 离5 巽6 乾7）。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * · 纯本地真随机（rand 注入，默认 Math.random）；天气 / 开发模式 / 网络都进不来
 *   —— 这与 ritualMachine 头部的"不看天气不看开发模式"是同一条禁令的领域侧。
 * · 本文件不 import 任何机器与引擎的实现（只 import type）—— 它是被消费的内核。
 * ===========================================================================
 */

import type { LineValue } from '@core/machine/ritualMachine'
import type { HexagramRef } from '@core/reading'

/** 一枚铜钱的朝向：字面（阴）= 2，背面（阳）= 3 */
export type CoinFace = 2 | 3
export type Rand = () => number

export const FACE_ZI = 2 as const // 字面（阴）
export const FACE_BACK = 3 as const // 背面（阳）

/** 掷一枚：公平铜钱，背 / 字各 1/2。rand ∈ [0,1) */
export function tossCoin(rand: Rand = Math.random): CoinFace {
  return rand() < 0.5 ? FACE_BACK : FACE_ZI
}

/** 一次掷出三枚（顺序即掷出顺序，求和与顺序无关） */
export function tossThreeCoins(rand: Rand = Math.random): [CoinFace, CoinFace, CoinFace] {
  return [tossCoin(rand), tossCoin(rand), tossCoin(rand)]
}

/** 三枚面值求和 → 一爻。越界说明调用方造了非法铜钱（编程错误，直接抛） */
export function lineValueOfCoins(coins: readonly CoinFace[]): LineValue {
  const sum = coins[0] + coins[1] + coins[2]
  if (sum !== 6 && sum !== 7 && sum !== 8 && sum !== 9) {
    throw new Error(`[liuyao] 三枚铜钱之和越界: ${sum}`)
  }
  return sum
}

export interface CastResult {
  coins: [CoinFace, CoinFace, CoinFace]
  value: LineValue
}

/** 「三枚一掷」：一次调用 = 掷三枚 → 一爻（1/8 : 3/8 : 3/8 : 1/8） */
export function castLine(rand: Rand = Math.random): CastResult {
  const coins = tossThreeCoins(rand)
  return { coins, value: lineValueOfCoins(coins) }
}

/** 只取爻值 —— 给 ritualMachine.setCastLine / 默认实现用 */
export function castLineValue(rand: Rand = Math.random): LineValue {
  return castLine(rand).value
}

// ── 本地成卦：六爻 → 本卦 / 变卦 ──────────────────────────────────────────

/**
 * King Wen 六十四卦序表。下标 = 上卦代码 × 8 + 下卦代码。
 * 行列序一致：坤0 震1 坎2 兑3 艮4 离5 巽6 乾7。
 * ★ 表值经过 64 卦互异 + 对照卦名校验（泰 11 / 否 12 / 既济 63 / 未济 64 …）。
 */
const KING_WEN: readonly number[] = [
  /* 上坤 0 */ 2, 24, 7, 19, 15, 36, 46, 11,
  /* 上震 1 */ 16, 51, 40, 54, 62, 55, 32, 34,
  /* 上坎 2 */ 8, 3, 29, 60, 39, 63, 48, 5,
  /* 上兑 3 */ 45, 17, 47, 58, 31, 49, 28, 43,
  /* 上艮 4 */ 23, 27, 4, 41, 52, 22, 18, 26,
  /* 上离 5 */ 35, 21, 64, 38, 56, 30, 37, 14,
  /* 上巽 6 */ 20, 42, 59, 61, 53, 50, 57, 9,
  /* 上乾 7 */ 12, 25, 6, 10, 33, 13, 44, 1,
]

type Bit = 0 | 1

function yangAt(v: LineValue): Bit {
  return v === 7 || v === 9 ? 1 : 0
}

/** 卦代码 = 初位 + 2×中位 + 4×上位（bits 自下而上） */
function trigramCode(bits: readonly Bit[]): number {
  return bits[0] + 2 * bits[1] + 4 * bits[2]
}

function hexagramOf(bits: readonly Bit[]): number {
  return KING_WEN[trigramCode([bits[3], bits[4], bits[5]]) * 8 + trigramCode([bits[0], bits[1], bits[2]])]
}

/**
 * 六爻 → HexagramRef（本卦 / 变卦 / 动爻位）。
 * lines[0] = 初爻。少于六爻是调用方的 bug（CAST 只在第六爻落定后进入），直接抛。
 * ★ 只产出卦序号与动爻位置 —— 爻值与解读文案不出端（HexagramRef 的契约）。
 */
export function buildHexagram(lines: readonly LineValue[]): HexagramRef {
  if (lines.length !== 6) {
    throw new Error(`[liuyao] buildHexagram 需要六爻，收到 ${lines.length}`)
  }
  const bits: Bit[] = lines.map(yangAt)
  const primary = hexagramOf(bits)

  const moving: number[] = []
  lines.forEach((v, i) => {
    if (v === 6 || v === 9) moving.push(i)
  })

  let changed: number | null = null
  if (moving.length > 0) {
    const flipped: Bit[] = bits.map((b, i) => (moving.includes(i) ? ((b ^ 1) as Bit) : b))
    changed = hexagramOf(flipped)
  }

  return { primary, changed, moving }
}
