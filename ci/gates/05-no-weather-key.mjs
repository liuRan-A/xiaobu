#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑤   禁天气 API Key 进客户端产物   .sh 的等价 Node 移植
// 用法：node ci/gates/05-no-weather-key.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync } from 'node:fs'
import { isCommentOutput, resolveRepo, scanMany } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
let FAIL = 0

const EXTS = ['.ts', '.vue', '.js', '.json', '.html']
const ROOTS = [SRC, 'dist']

function scanTargets(regex) {
  return scanMany(ROOTS, regex, { exts: EXTS }).filter((l) => !isCommentOutput(l))
}

const RE_VENDOR = /X-QW-Api-Key|devapi\.qweather|heweather\.key|weatherapi\.com\?key=|openweathermap\.org\/data\/[^"]*appid=/
const RE_HIGHENTROPY = /(apikey|api_key|api-key|token|secret)[^a-z0-9]{0,3}\s*[:=]\s*["']?[0-9a-fA-F]{32}/i

console.log('── 门禁⑤ 天气密钥扫描（src + dist 产物）')

// ── ① Key header / 厂商开发域 ──────────────────────────────────────────────
let h = scanTargets(RE_VENDOR)
if (h.length > 0) {
  console.log('✗ [门禁⑤] 出现天气厂商 Key 或开发域 —— 鉴权必须经过后端代理：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ② 32 位十六进制高熵串 + key 上下文（大小写不敏感）──────────────────────
h = scanTargets(RE_HIGHENTROPY)
if (h.length > 0) {
  console.log('✗ [门禁⑤] 疑似 32 位天气 Key：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ③ 正向校验：天气开关必须存在 ───────────────────────────────────────────
const cfgAbs = resolveRepo(`${SRC}/config/config.json`)
if (existsSync(cfgAbs)) {
  const cfg = readFileSync(cfgAbs, 'utf8')
  if (!/"enabled"/.test(cfg)) {
    console.log('✗ [门禁⑤] config.json 没有天气开关 —— Key 一旦泄露无法秒级止血')
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁⑤] 天气密钥干净：无 Key 字面量、无开发域、且具备秒级开关')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · Key 只放服务端，客户端只见自家 /api/weather')
  console.log('  · 客户端只收 WeatherSnapshot（降级码 1/2/3 + 归一化氛围值）')
  console.log('  · 本地开发走 Vite dev 代理，别把 Key 写进 config.json')
}
process.exit(FAIL)
