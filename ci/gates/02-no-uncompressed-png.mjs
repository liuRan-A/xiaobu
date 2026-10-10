#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ②   禁未压缩 / 超大位图（白名单除外）   .sh 的等价 Node 移植
// ---------------------------------------------------------------------------
// 判据（任一命中即阻断）：
//   ① 单文件字节超上限（通用 200KB / 塔罗牌 100KB）
//   ② 位图单边像素超上限（通用 2048 / 塔罗牌 768）——读 PNG/JPEG/WebP/GIF 头
//   ③ 未被 ci/art-whitelist.txt 登记
//   ④ WebP 总量超 WEBP_TOTAL_MAX_KB（默认 2048）
// 用法：node ci/gates/02-no-uncompressed-png.mjs [src]
//   环境变量：ART_MAX_BYTES(204800) ART_MAX_EDGE(2048)
//            TAROT_MAX_BYTES(102400) TAROT_MAX_EDGE(768) WEBP_TOTAL_MAX_KB(2048)
//            WHITELIST(ci/art-whitelist.txt) SCAN_ROOTS("src/assets src/scene public assets")
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { floorDiv, listFiles, resolveRepo, toPosix } from './lib.mjs'

process.argv[2] // 兼容 $1

const ART_MAX_BYTES = Number(process.env.ART_MAX_BYTES ?? 204800)
const ART_MAX_EDGE = Number(process.env.ART_MAX_EDGE ?? 2048)
const TAROT_MAX_BYTES = Number(process.env.TAROT_MAX_BYTES ?? 102400)
const TAROT_MAX_EDGE = Number(process.env.TAROT_MAX_EDGE ?? 768)
const WEBP_TOTAL_MAX_KB = Number(process.env.WEBP_TOTAL_MAX_KB ?? 2048)
const WHITELIST = process.env.WHITELIST ?? 'ci/art-whitelist.txt'
const SCAN_ROOTS = (process.env.SCAN_ROOTS ?? 'src/assets src/scene public assets')
  .split(/\s+/)
  .filter(Boolean)
let FAIL = 0

const BITMAP_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

// ── 只读前 4096 字节拿真实宽高（字节序是本函数的全部难点）──────────────────
function bitmapSize(native) {
  let buf
  try {
    buf = readFileSync(native)
  } catch {
    return [0, 0]
  }
  const b = buf.subarray(0, 4096)
  const n = b.length
  if (n < 24) return [0, 0]
  const g = (i) => b[i] ?? 0
  const u32be = (o) => ((g(o) * 256 + g(o + 1)) * 256 + g(o + 2)) * 256 + g(o + 3)

  // PNG：89 50 4E 47 …（IHDR 为大端）
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return [u32be(16), u32be(20)]

  // GIF："GIF8"，宽高 16 位小端，位于第 6..9 字节
  if (b[0] === 71 && b[1] === 73 && b[2] === 70 && b[3] === 56) {
    return [g(6) + g(7) * 256, g(8) + g(9) * 256]
  }

  // WebP："RIFF"…"WEBP"
  if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) {
    // VP8X：画布宽/高**减一**存 24 位小端（第 24..29 字节）
    if (b[12] === 86 && b[13] === 80 && b[14] === 56 && b[15] === 88) {
      return [
        g(24) + g(25) * 256 + g(26) * 65536 + 1,
        g(27) + g(28) * 256 + g(29) * 65536 + 1,
      ]
    }
    // VP8 有损：宽高在第 26..29 字节（16 位小端，取低 14 位）
    if (b[12] === 86 && b[13] === 80 && b[14] === 56 && b[15] === 32) {
      return [(g(26) + g(27) * 256) & 16383, (g(28) + g(29) * 256) & 16383]
    }
    // VP8L 无损是位打包的 —— 返回 0 0，由字节上限兜底
    return [0, 0]
  }

  // JPEG：FF D8 FF，扫第一个 SOF 段（FF C0..CF，排除 DHT/JPG/DAC）
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) {
    let i = 2
    while (i < n - 9) {
      if (b[i] === 255) {
        const m = b[i + 1]
        if ([255, 216, 217, 1, 208, 209, 210, 211, 212, 213, 214, 215, 196, 200, 204, 218].includes(m)) {
          i += 2
          continue
        }
        if (m >= 192 && m <= 207) return [g(i + 7) + g(i + 8) * 256, g(i + 5) + g(i + 6) * 256]
        const seg = g(i + 2) * 256 + g(i + 3)
        if (seg < 2) return [0, 0]
        i += 2 + seg
      } else {
        i += 1
      }
    }
    return [0, 0]
  }

  return [0, 0]
}

// ── 白名单（整路径相等 或 路径前缀 `entry/`）────────────────────────────────
const wlEntries = []
if (existsSync(resolveRepo(WHITELIST))) {
  for (let line of readFileSync(resolveRepo(WHITELIST), 'utf8').split(/\r?\n/)) {
    line = line.split('#')[0].replace(/\s+/g, '')
    if (!line) continue
    wlEntries.push(toPosix(line))
  }
}
function whitelisted(display) {
  for (const e of wlEntries) {
    if (display === e || display.startsWith(`${e}/`)) return true
  }
  return false
}

console.log(
  `── 门禁② 位图资产扫描  通用≤${floorDiv(ART_MAX_BYTES, 1024)}KB / 塔罗牌≤${floorDiv(TAROT_MAX_BYTES, 1024)}KB·≤${TAROT_MAX_EDGE}px / WebP总量≤${WEBP_TOTAL_MAX_KB}KB / 需登记于 ${WHITELIST}`,
)

let found = 0
let webpTotal = 0
for (const root of SCAN_ROOTS) {
  for (const { display, native } of listFiles(root, { exts: BITMAP_EXTS })) {
    found += 1
    let sz = 0
    try {
      sz = statSync(native).size
    } catch {
      /* 忽略 */
    }
    const [w, h] = bitmapSize(native)
    const edge = Math.max(w, h)
    let bad = ''
    const isTarot = /tarot/i.test(display)

    if (isTarot) {
      if (sz > TAROT_MAX_BYTES) {
        bad += ` 塔罗牌体积 ${(sz / 1024).toFixed(1)}KB > ${floorDiv(TAROT_MAX_BYTES, 1024)}KB`
      }
      if (edge > TAROT_MAX_EDGE) {
        bad += ` 塔罗牌单边 ${edge}px > ${TAROT_MAX_EDGE}px（限 512×768）`
      }
    } else {
      if (sz > ART_MAX_BYTES) {
        bad += ` 体积 ${(sz / 1024).toFixed(1)}KB > ${floorDiv(ART_MAX_BYTES, 1024)}KB`
      }
      if (edge > ART_MAX_EDGE) {
        bad += ` 单边 ${edge}px > ${ART_MAX_EDGE}px（解码后约 ${((w * h * 4) / 1048576).toFixed(1)} MB 内存）`
      }
    }

    if (!whitelisted(display)) bad += ` 未在 ${WHITELIST} 登记`

    // WebP 总量累计
    if (/\.webp$/i.test(display)) webpTotal += sz

    if (bad !== '') {
      console.log(`✗ [门禁②] ${display}:${bad}`)
      FAIL = 1
    } else {
      console.log(`  · ${display} —— ${(sz / 1024).toFixed(1)}KB ${w}x${h} 已登记 ✓`)
    }
  }
}

if (found === 0) {
  console.log('  · 仓库内暂无位图资产（M3 加图前这道门禁是空的，加上后它是主防线）')
}

// ── WebP 总量红线（M3 聚合约束，独立于单张）────────────────────────────────
if (webpTotal > 0) {
  const webpTotalKb = floorDiv(webpTotal, 1024)
  console.log(`  · WebP 资源总量 ${(webpTotal / 1024).toFixed(1)} KB`)
  if (webpTotalKb > WEBP_TOTAL_MAX_KB) {
    console.log(`✗ [门禁②] WebP 总量 ${webpTotalKb} KB > ${WEBP_TOTAL_MAX_KB} KB —— 触发 2MB 聚合红线`)
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁②] 位图资产合规：单张体积 / 像素 / 塔罗专属 / WebP总量 / 登记 全过')
} else {
  console.log('')
  console.log('修复方式（按顺序）：')
  console.log('  1. 先降像素再压字节 —— 降一半边长 = 省 75% 内存，比任何压缩都有效')
  console.log('  2. alpha 通道只在真正需要处保留；能用 webp 就别用 png')
  console.log('  3. 序列帧（沙漏沙流）必须走程序化绘制或粒子，不放逐帧位图')
  console.log('  4. 塔罗牌：卡背卡面 ≤ 100KB、≤ 512×768，其余牌面走 CDN 按需加载')
  console.log('  5. WebP 总量 ≤ 2MB：超出则把按需牌面挪出主包（faces/ondemand → CDN）')
  console.log(`  6. 确实要进主包且超限：在 ${WHITELIST} 加一行并在 PR 说明体积账`)
}
process.exit(FAIL)
