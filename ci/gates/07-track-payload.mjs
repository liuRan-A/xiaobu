#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑦   禁监控载荷含隐私字段   .sh 的等价 Node 移植
// 用法：node ci/gates/07-track-payload.mjs [src]
//   环境变量：TRACK_SRC(默认 src/services/track)
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveRepo, scanCode } from './lib.mjs'

const TRACK_SRC = process.env.TRACK_SRC ?? 'src/services/track'
let FAIL = 0

const RE_FIELDS = /\b(prompt|completion|transcript|latitude|longitude|city|IDFA|AAID|deviceId|userId|content|text|utterance|question)\b/
const RE_LATLNG = /\b(lat|lng)\b\s*[:=]/
const RE_SPREAD = /\.\.\.(payload|body|data|ctx|snap|result)/

console.log(`── 门禁⑦ 监控载荷隐私扫描（范围 ${TRACK_SRC}）`)

// ── ① 显式隐私字段名 ───────────────────────────────────────────────────────
let h = scanCode(TRACK_SRC, RE_FIELDS)
if (h.length > 0) {
  console.log('✗ [门禁⑦] 监控载荷出现隐私字段名：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ② 缩写形也极易溜进去 ───────────────────────────────────────────────────
h = scanCode(TRACK_SRC, RE_LATLNG)
if (h.length > 0) {
  console.log('✗ [门禁⑦] 出现经纬度缩写字段：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ③ 禁止把整个对象展开进载荷 ─────────────────────────────────────────────
h = scanCode(TRACK_SRC, RE_SPREAD)
if (h.length > 0) {
  console.log('✗ [门禁⑦] 把整个对象展开进上报体（会带出不可控字段）：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ④ 正向校验：TrackEvent 存在且是 interface ──────────────────────────────
const idxAbs = resolveRepo(path.join(TRACK_SRC, 'index.ts'))
if (!existsSync(idxAbs)) {
  console.log(`✗ [门禁⑦] 找不到 ${TRACK_SRC}/index.ts —— 监控层不见了`)
  FAIL = 1
} else {
  const idx = readFileSync(idxAbs, 'utf8')
  for (const f of ['name', 'scope', 'kind', 'node', 'ok', 'cents', 'count', 'blown']) {
    const re = new RegExp(`^[ \\t]+${f}\\??:`, 'm')
    if (!re.test(idx)) {
      console.log(`· [门禁⑦] 提示：TrackEvent 无 ${f} 字段（若是新增字段请确认它不是自由文本）`)
    }
  }
  if (!/interface[ \t]+TrackEvent/.test(idx)) {
    console.log('✗ [门禁⑦] TrackEvent 不是 interface —— 没有类型封闭就等于什么都敢往里放')
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁⑦] 监控载荷干净：仅枚举 + 数值，无任何隐私字段')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 想知道错在哪 → 传错误码（枚举），不要传 error.message')
  console.log('  · 想知道在哪流失 → 传 node 枚举（\'LIUYAO_CAST\'），不要传用户的问题')
  console.log('  · 想看性能 → 传耗时毫秒（数值）')
}
process.exit(FAIL)
