#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ③   禁四季素材泄漏进生产包   .sh 的等价 Node 移植
// 用法：node ci/gates/03-no-season-leak.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { resolveRepo, scanCode } from './lib.mjs'
import { existsSync, readFileSync } from 'node:fs'

const SRC = process.argv[2] ?? 'src'
const DEFAULT_SEASON = process.env.DEFAULT_SEASON ?? 'spring'
let FAIL = 0

const RE_IMPORT = /(import|from|require\()[^;*]*['"][^'"]*(\/|_)(summer|autumn|winter)(\/|\.|-|_)/
const RE_ASSETS = /['"][^'"]*assets\/[^'"]*(summer|autumn|winter)[^'"]*['"]/
const RE_HARDCODE = /season\s*[:=]\s*['"](summer|autumn|winter)['"]/

console.log(`── 门禁③ 四季素材泄漏扫描（默认季节 = ${DEFAULT_SEASON}，其余须走 CDN 按需加载）`)

// ── ① 静态 import 非默认季节资源 ───────────────────────────────────────────
let h = scanCode(SRC, RE_IMPORT)
if (h.length > 0) {
  console.log('✗ [门禁③] 静态引用了非默认季节资源 —— 四季必须走 CDN 按需拉取：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ② assets 下出现按季节分目录的资源且被 import ──────────────────────────
h = scanCode(SRC, RE_ASSETS)
if (h.length > 0) {
  console.log('✗ [门禁③] 引用了 assets 下的季节资源路径：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ③ 正向校验：CDN 四季资源包的出口必须存在 ──────────────────────────────
const cfgAbs = resolveRepo(`${SRC}/config/config.json`)
if (existsSync(cfgAbs)) {
  const cfg = readFileSync(cfgAbs, 'utf8')
  if (!/"packs"/.test(cfg)) {
    console.log('✗ [门禁③] config.json 缺少 assets.packs —— 四季资源没有合法的按需加载出口')
    FAIL = 1
  }
}

// ── ④ 季节 Switching 必须由配置 / 时间驱动，不许写死 ───────────────────────
h = scanCode(SRC, RE_HARDCODE)
if (h.length > 0) {
  console.log('✗ [门禁③] 季节被写死（应来自日期或远端配置）：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

if (FAIL === 0) {
  console.log('✓ [门禁③] 无四季素材泄漏：静态引用干净，季节切换有合法出口')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 四季贴图放 CDN，地址写进 config.assets.packs（见 bootstrap/builtinConfig.ts）')
  console.log('  · 运行时按月份 + 用户偏好决定拉哪一包；拉不到 → 停在默认季节，绝不留白')
  console.log('  · 主包只留通用层（地板 / 墙 / 小卜本体），那部分与季节无关')
}
process.exit(FAIL)
