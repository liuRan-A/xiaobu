#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁总闸   ci/gates/run-all.mjs   （run-all.sh 的等价 Node 移植）
// ---------------------------------------------------------------------------
// 十四道门禁，任一失败即阻断发布。`npm run ci` 会调它。
// 用法：node ci/gates/run-all.mjs      环境变量 SRC(默认 src) 透传给每道门禁
// 退出码：0 = 全绿；1 = 有失败 / 超时
// ===========================================================================
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './lib.mjs'

const GATES_DIR = path.join(REPO_ROOT, 'ci', 'gates')
const SRC = process.env.SRC ?? 'src'
const TIME_LIMIT_S = 90

const GATES = [
  [1, '01-bundle-size.mjs', '包体硬门禁（APK ≤ 30 MB / dist 增量预算）'],
  [2, '02-no-uncompressed-png.mjs', '禁未压缩 / 超大位图（须登记）'],
  [3, '03-no-season-leak.mjs', '禁四季素材泄漏进生产包'],
  [4, '04-no-engine-residue.mjs', '禁引擎残留'],
  [5, '05-no-weather-key.mjs', '禁天气 API Key 进产物'],
  [6, '06-weather-oneway.mjs', '核心逻辑不得反向依赖天气'],
  [7, '07-track-payload.mjs', '监控载荷无隐私字段'],
  [8, '08-no-key-in-config.mjs', 'config 无密钥'],
  [9, '09-no-ui-in-catch.mjs', 'catch 块禁止出 UI'],
  [10, '10-no-persist-queue.mjs', '禁止持久化上报队列'],
  [11, '11-token-fresh.mjs', 'Token 产物新鲜'],
  [12, '12-art-geometry.mjs', '美术实测值与投影自洽'],
  [13, '13-no-idb.mjs', '禁 IndexedDB / localStorage 收口'],
  [14, '14-render-smoke.mjs', '渲染冒烟（双路径像素一致，守真机画面）'],
]

const CIRCLES = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭']
const circle = (n) => CIRCLES[n - 1] ?? '⑮'

let FAILED = 0
let PENDING = 0
const PENDING_LIST = []

console.log('╔══════════════════════════════════════════════════╗')
console.log('║  小卜 · CI 门禁（十四道，任一失败即阻断发布）      ║')
console.log('╚══════════════════════════════════════════════════╝')

const START = Date.now()

for (const [no, file, name] of GATES) {
  console.log('')
  console.log(`── 门禁${circle(no)} ${name} ─────────────────────────────`)
  const abs = path.join(GATES_DIR, file)
  if (!existsSync(abs)) {
    console.log('· 未实现（待补）')
    PENDING += 1
    PENDING_LIST.push(`${circle(no)} ${name}`)
    continue
  }
  const r = spawnSync('node', [abs, SRC], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (r.status !== 0) FAILED += 1
}

const ELAPSED = Math.round((Date.now() - START) / 1000)

console.log('')
console.log('══════════════════════════════════════════════════')
console.log(`  门禁总耗时 ${ELAPSED}s（Q1 上限 ${TIME_LIMIT_S}s）`)

// Q1：跑不完的门禁等于没有门禁
if (ELAPSED > TIME_LIMIT_S) {
  console.log(`✗ 门禁总耗时 ${ELAPSED}s > ${TIME_LIMIT_S}s —— 超时即失去保护能力，先优化脚本`)
  console.log('   典型原因：在循环里起了子进程。改成一次扫描读完（见 ⑨ / ⑬）')
  FAILED += 1
}

if (FAILED === 0) {
  if (PENDING > 0) {
    console.log(`✓ 已实现的门禁全过（另有 ${PENDING} 道待实现，明确计入待办，未静默跳过：）`)
    for (const p of PENDING_LIST) console.log(`    ☐ ${p}`)
  } else {
    console.log('✓ 门禁全绿（十四道全部通过）—— 允许进入下一里程碑')
  }
  process.exit(0)
} else {
  console.log(`✗ ${FAILED} 道门禁未通过 —— 阻断发布`)
  process.exit(1)
}
