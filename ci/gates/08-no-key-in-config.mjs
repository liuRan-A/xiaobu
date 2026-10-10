#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑧   禁密钥进入 config.json 或客户端产物   .sh 的等价 Node 移植
// 用法：node ci/gates/08-no-key-in-config.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync } from 'node:fs'
import { isDir, listFiles, resolveRepo } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
const CFG_ABS = resolveRepo(`${SRC}/config/config.json`)
const CFG_ARG = `${SRC}/config/config.json`
let FAIL = 0

console.log('── 门禁⑧ 密钥扫描（config.json + dist 产物）')

// ── ① config.json 里的密钥键名 + 高熵值 ────────────────────────────────────
if (existsSync(CFG_ABS)) {
  const lines = readFileSync(CFG_ABS, 'utf8').split(/\r?\n/)
  const RE_KEY = /(signKey|cdnSecret|apiKey|api_key|secret|password|passwd|token|privateKey|SECRET)/
  const RE_ENTROPY = /"[^"]*"[ \t]*:[ \t]*"[A-Za-z0-9_/+.-]{24,}"/
  const RE_URL = /"(https?:\/\/|\/)/

  const keyHits = []
  const entropyHits = []
  lines.forEach((line, i) => {
    const at = `${CFG_ARG}:${i + 1}:`
    if (RE_KEY.test(line)) keyHits.push(at + line)
    if (RE_ENTROPY.test(line) && !RE_URL.test(line)) entropyHits.push(at + line)
  })

  if (keyHits.length > 0) {
    console.log('✗ [门禁⑧] config.json 出现密钥类字段：')
    for (const l of keyHits) console.log(`    ${l}`)
    FAIL = 1
  }
  if (entropyHits.length > 0) {
    console.log('✗ [门禁⑧] config.json 出现高熵值（疑似密钥）：')
    for (const l of entropyHits) console.log(`    ${l}`)
    FAIL = 1
  }
  console.log('  · config.json 键名 / 值 entropy 已扫')
} else {
  console.log(`  · 无 ${CFG_ARG}，跳过`)
}

// ── ② dist 产物（JS bundle 与内联 JSON）───────────────────────────────────
if (isDir('dist')) {
  const RE_DIST = /(signKey|cdnSecret|apiKey|api_key|privateKey|SECRET_KEY)/g
  const hits = []
  for (const { display, native } of listFiles('dist', {})) {
    let text
    try {
      text = readFileSync(native, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      RE_DIST.lastIndex = 0
      const m = RE_DIST.exec(line)
      if (m) hits.push(`${display}:${i + 1}:${m[0]}`)
    })
    if (hits.length >= 20) break
  }
  const shown = hits.slice(0, 20)
  if (shown.length > 0) {
    console.log('✗ [门禁⑧] 产物中出现密钥字段名：')
    for (const l of shown) console.log(`    ${l}`)
    FAIL = 1
  }
  console.log('  · dist 产物已扫')
}

// ── ③ 正向校验：内置配置里不许有密钥字段（schema 层）──────────────────────
const builtinAbs = resolveRepo(`${SRC}/bootstrap/builtinConfig.ts`)
if (existsSync(builtinAbs)) {
  const RE_BUILTIN = /^\s*(secret|apiKey|api_key|signKey|cdnSecret)\s*:/
  const hits = []
  readFileSync(builtinAbs, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (RE_BUILTIN.test(line)) hits.push(`${SRC}/bootstrap/builtinConfig.ts:${i + 1}:${line}`)
    })
  if (hits.length > 0) {
    console.log('✗ [门禁⑧] builtinConfig.ts 定义了密钥字段 —— 默认值会随产物被打出去：')
    for (const l of hits) console.log(`    ${l}`)
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁⑧] config 与产物均无密钥：只有开关 / 数值 / URL 三类值')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 签名 / 鉴权一律走服务端；客户端只见已经签好的临时 URL')
  console.log('  · CDN 资源用公开可读的分包 + 时间戳校验，不用 secret 签名')
  console.log('  · config.json 里永远只放：布尔开关、数字配额、公开 URL')
}
process.exit(FAIL)
