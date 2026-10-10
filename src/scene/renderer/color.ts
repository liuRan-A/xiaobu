/**
 * 小卜 · 颜色运算   src/scene/renderer/color.ts
 * ===========================================================================
 * 只做三件事：解析颜色、加透明度、按比例混色。
 *
 * ★ 存在的理由：让 painter 里**不出现散落的 `rgba(110, 82, 56, 0.18)` 字面值**。
 *   半透明色同样是从 token 派生的 —— 否则改了接触影的主色，
 *   还得满仓库去找那个手写的 rgba。
 *
 * ★ 本文件所有函数都保证**永不抛异常**（门禁 ⑨ 的精神：颜色解析失败也不许崩，
 *   退回奶油色继续画）。一个坏色值不该让整间屋子消失。
 * ===========================================================================
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const RGB_FN = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i

/** 解析 `#rgb` / `#rrggbb` / `rgb(...)` / `rgba(...)`；无法识别时返回奶油色 */
export function parseColor(color: string): Rgb {
  const s = (color ?? '').trim()

  const m6 = HEX6.exec(s)
  if (m6) {
    return {
      r: parseInt(m6[1], 16),
      g: parseInt(m6[2], 16),
      b: parseInt(m6[3], 16),
    }
  }

  const m3 = HEX3.exec(s)
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
    }
  }

  const mf = RGB_FN.exec(s)
  if (mf) return { r: Number(mf[1]), g: Number(mf[2]), b: Number(mf[3]) }

  return { r: 253, g: 249, b: 246 } // 奶油底 —— 兜底也不许难看
}

/** `alpha('#6e5238', 0.18)` → `'rgba(110, 82, 56, 0.18)'` */
export function alpha(color: string, a: number): string {
  const { r, g, b } = parseColor(color)
  const k = clamp01(a)
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${k})`
}

/** 线性混色：t = 0 取 a，t = 1 取 b */
export function mix(a: string, b: string, t: number): string {
  const A = parseColor(a)
  const B = parseColor(b)
  const k = clamp01(t)
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k)
  return `rgb(${ch(A.r, B.r)}, ${ch(A.g, B.g)}, ${ch(A.b, B.b)})`
}

/** 提亮（amount > 0）或压暗（amount < 0），幅度 0–1 */
export function shade(color: string, amount: number): string {
  return amount < 0 ? mix(color, '#000000', -amount) : mix(color, '#ffffff', amount)
}

/** 转成等距椭圆用的 2:1 半径（一枚躺平的圆，在 2:1 投影下压扁一半） */
export function flattenRy(rx: number): number {
  return rx / 2
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}
