#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑨   catch 块禁止出 UI   .sh 的等价 Node 移植
// ---------------------------------------------------------------------------
// 逐行窗口扫描：每遇到 `catch (...)` 就把窗口设为 行号 + 12；之后凡在窗口内、
// 且非整行注释、且命中 UI 出口正则的行即为违规。
// 用法：node ci/gates/09-no-ui-in-catch.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync } from 'node:fs'
import { isCommentLine, listFiles, resolveRepo } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
let FAIL = 0

// 出现在 catch 窗口内即违规的 UI 出口（用 [()] / [.] 字符类，避开转义坑）
const BANNED = /alert\s*[()]|confirm\s*[()]|prompt\s*[()]|showModal|showToast|uni\.showToast|Toast\.|Dialog\.|window\.alert/
const WINDOW = 12
const CATCH_RE = /catch\s*[({]/

console.log('── 门禁⑨ catch 块禁止出 UI 扫描')

const hits = []
for (const { display, native } of listFiles(SRC, { exts: ['.ts', '.vue', '.js'] })) {
  let text
  try {
    text = readFileSync(native, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  let window = -1
  for (let idx = 0; idx < lines.length; idx += 1) {
    const fnr = idx + 1
    const line = lines[idx]
    if (CATCH_RE.test(line)) window = fnr + WINDOW
    if (fnr <= window && !isCommentLine(line) && BANNED.test(line)) {
      hits.push(`${display}:${fnr}: ${line}`)
    }
  }
}

if (hits.length > 0) {
  console.log('✗ [门禁⑨] catch 块内出现 UI 调用：')
  for (const l of hits) console.log(`    ${l}`)
  FAIL = 1
}

// 反过来：确保唯一错误出口真的存在且没被绕过
// ★ 刻意用固定的 src 而不是 $SRC —— $SRC 可能是探针传入的临时目录
const handleAbs = resolveRepo('src/shared/errors/handle.ts')
let ok = false
if (existsSync(handleAbs)) {
  ok = readFileSync(handleAbs, 'utf8').includes('export function handle')
}
if (!ok) {
  console.log('✗ [门禁⑨] 找不到唯一错误出口 src/shared/errors/handle.ts')
  FAIL = 1
}

if (FAIL === 0) {
  console.log('✓ [门禁⑨] catch 块干净：全仓无异常直出 UI')
} else {
  console.log('')
  console.log('修复方式：把 catch 内的 UI 调用删掉，改走 @shared/errors/handle(e, scope);')
  console.log('         需要安抚用户时，由小卜的气泡开口（ui/components/BubbleXiaobu.vue）。')
}
process.exit(FAIL)
