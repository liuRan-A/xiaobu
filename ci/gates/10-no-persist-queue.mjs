#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑩   禁止使用持久化上报队列   .sh 的等价 Node 移植
// 用法：node ci/gates/10-no-persist-queue.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { isDir, scan } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
let FAIL = 0

const TRACK_DIRS = [`${SRC}/services/track`]
const RE_PERSIST = /localStorage|sessionStorage|indexedDB|IndexedDB|@capacitor\/preferences|Preferences\.(set|get)/
const RE_BLOCKING = /\bawait\b|setInterval|retry|backoff|flushQueue|pendingQueue/
const RE_QUEUE_NAME = /(persist|save|store)[A-Za-z]*Queue|reportQueue|trackQueue|offlineQueue/

for (const dir of TRACK_DIRS) {
  if (!isDir(dir)) continue

  // ① 禁止任何形式的持久化存储（本目录全部文件，不剔除注释 —— 与原脚本一致）
  let h = scan(dir, RE_PERSIST)
  if (h.length > 0) {
    console.log(`✗ [门禁⑩] ${dir} 内出现持久化存储 —— 上报队列禁止落盘`)
    for (const l of h) console.log(`    ${l}`)
    FAIL = 1
  }

  // ② 禁止重试循环 / await 阻塞
  h = scan(dir, RE_BLOCKING)
  if (h.length > 0) {
    console.log(`✗ [门禁⑩] ${dir} 内出现 await / 定时重试 / 队列重放 —— 上报必须 fire-and-forget`)
    for (const l of h) console.log(`    ${l}`)
    FAIL = 1
  }
}

// ③ 全仓范围：禁止任何"持久化上报队列"的命名出现
const h3 = scan(SRC, RE_QUEUE_NAME)
if (h3.length > 0) {
  console.log('✗ [门禁⑩] 全仓出现持久化上报队列命名')
  for (const l of h3) console.log(`    ${l}`)
  FAIL = 1
}

// ④ 正向校验：上报必须走 sendBeacon
const trackDir = `${SRC}/services/track`
if (isDir(trackDir)) {
  if (scan(trackDir, /sendBeacon/).length === 0) {
    console.log('✗ [门禁⑩] services/track/ 里没有 sendBeacon —— 上报必须走它（失败即丢，无回退）')
    FAIL = 1
  }
  const fallback = scan(trackDir, /fetch\(.*track|fetch\(.*\/api\/track/)
  if (fallback.length > 0) {
    console.log('✗ [门禁⑩] 上报回退到了 fetch —— sendBeacon 返回 false 就该丢弃本批')
    for (const l of fallback) console.log(`    ${l}`)
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁⑩] 上报路径干净：内存缓冲 + sendBeacon，无持久化、无重试、无阻塞')
} else {
  console.log('')
  console.log('修复方式：tracker 只保留内存数组 + sendBeacon；失败直接丢弃整批，不做任何补偿。')
}
process.exit(FAIL)
