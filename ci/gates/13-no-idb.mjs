#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑬   禁 IndexedDB；localStorage 收口到一个文件   .sh 的等价 Node 移植
// 用法：node ci/gates/13-no-idb.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync } from 'node:fs'
import { resolveRepo, scanCode } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
const ALLOWED_STORE = 'src/store/localStore.ts'
let FAIL = 0

function report(title, hits) {
  console.log(`✗ [门禁⑬] ${title}`)
  for (const l of hits) console.log(`    ${l}`)
  FAIL = 1
}

console.log(`── 门禁⑬ 扫描范围：${SRC}`)

// ── ① 禁 IndexedDB（含包装库）─────────────────────────────────────────────
let h = scanCode(SRC, /indexedDB|IndexedDB|IDBFactory|IDBDatabase|webkitIndexedDB|mozIndexedDB/)
if (h.length > 0) report('出现 IndexedDB（字面禁令）：', h)

h = scanCode(SRC, /(from|require\()\s*['"]idb['"]|['"]idb\/['"]/)
if (h.length > 0) report('import 了 idb 包装库：', h)

// ── ② sessionStorage 一律不许 ──────────────────────────────────────────────
h = scanCode(SRC, /sessionStorage/)
if (h.length > 0) {
  report('使用了 sessionStorage —— 记忆锚点必须活在两次启动之间，不能用会话级存储', h)
}

// ── ③ localStorage 只能出现在那一个收口文件里 ──────────────────────────────
h = scanCode(SRC, /localStorage/).filter((l) => !l.startsWith(`${ALLOWED_STORE}:`))
if (h.length > 0) report(`直接碰了 localStorage —— 只允许 ${ALLOWED_STORE}`, h)

// ── ④ 正向校验：收口文件必须存在且真的实现了两端（固定用真实仓库 src）─────
const REPO_SRC = 'src'
const storeAbs = resolveRepo(`${REPO_SRC}/store/localStore.ts`)
if (!existsSync(storeAbs)) {
  console.log(`✗ [门禁⑬] 找不到 ${REPO_SRC}/store/localStore.ts —— 存储收口层不见了（谁能碰 localStorage 就没定义了）`)
  FAIL = 1
} else {
  const store = readFileSync(storeAbs, 'utf8')
  if (!store.includes('localStorage')) {
    console.log(`✗ [门禁⑬] ${REPO_SRC}/store/localStore.ts 里没有 localStorage —— Web 端实现是不是被删了？`)
    FAIL = 1
  }
  if (!store.includes('@capacitor/preferences')) {
    console.log(`✗ [门禁⑬] ${REPO_SRC}/store/localStore.ts 没有走 Capacitor Preferences —— 原生端会退回 WebView 的 localStorage`)
    FAIL = 1
  }
}

// ── ⑤ 正向校验：写预算必须还在 ─────────────────────────────────────────────
const persistAbs = resolveRepo(`${REPO_SRC}/core/persist.ts`)
const persist = existsSync(persistAbs) ? readFileSync(persistAbs, 'utf8') : null
for (const key of ['maxWritesPerMinute', 'coalesceMs', 'maxBytesPerKey']) {
  if (persist === null || !persist.includes(key)) {
    console.log(`✗ [门禁⑬] ${REPO_SRC}/core/persist.ts 里没有 ${key} —— 写预算缺了一角，"禁高频写"就只剩一句口号`)
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log(`✓ [门禁⑬] 存储收口正确：无 IndexedDB / 无 sessionStorage / localStorage 仅 ${ALLOWED_STORE} 一处`)
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 要持久化的东西 → 通过 core/persist.ts 的 PersistedStore（它带写预算）')
  console.log('  · 需要新的存储后端 → 在 core/persist.ts 加端口方法，在 src/store/localStore.ts 实现它')
  console.log('  · 注释里可以随便提这些名字，门禁只看代码行')
}
process.exit(FAIL)
