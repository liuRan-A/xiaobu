#!/usr/bin/env node
// ===========================================================================
// 小卜 · CI 总入口   ci/ci.mjs
// ---------------------------------------------------------------------------
// 一条命令跑完「lint → 单测 → 十四道门禁」，且**全程不依赖任何 shell**。
//
// 为什么不直接用 `npm run ci`：
//   Windows PowerShell 默认执行策略会拦下 npm.ps1，报
//   "File ...npm.ps1 cannot be loaded because running scripts is disabled on this system"，
//   于是最常见的那种开发终端里 `npm run ci` 根本起不来 —— 而这跟门禁脚本毫无关系，
//   门禁本身早就是零 shell 的 Node 脚本了，只差一个同样跨 shell 的总入口。
//
// 做法：用 process.execPath 直接调本地二进制，不靠 && 串命令、不读 npm、
//       不需要任何执行策略放行。PowerShell / cmd / Git Bash / Linux CI 表现一致。
//
// 用法：node ci/ci.mjs
// 退出码：0 = 全绿；1 = 任一步失败（照 `&&` 语义，失败即停，不浪费后面的时间）
// ===========================================================================
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './gates/lib.mjs'

const NODE = process.execPath
const bin = (...p) => path.join(REPO_ROOT, 'node_modules', ...p)

/** 与 package.json 的 lint / test / gates 三条脚本等价 */
const STEPS = [
  ['lint', bin('eslint', 'bin', 'eslint.js'), ['src', 'tests', 'scripts', '--max-warnings', '0']],
  ['test', bin('vitest', 'vitest.mjs'), ['run']],
  ['gates', path.join(REPO_ROOT, 'ci', 'gates', 'run-all.mjs'), []],
]

console.log('══ 小卜 · CI：lint → 单测 → 十四道门禁 ══')

let failed = null
for (const [name, script, args] of STEPS) {
  console.log('')
  console.log(`── ${name} ─────────────────────────────`)
  if (!existsSync(script)) {
    console.log(`✗ 找不到 ${path.relative(REPO_ROOT, script)}`)
    console.log('  先装依赖：npm install')
    process.exit(1)
  }
  // 直接用 node 跑脚本文件，比调 node_modules/.bin 下的 shim 更稳
  // （Windows 上那些 shim 是 .cmd / .ps1，正撞上要绕开的执行策略）
  const r = spawnSync(NODE, [script, ...args], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (r.error) {
    console.log(`✗ ${name} 无法启动：${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) {
    failed = name
    break
  }
}

console.log('')
console.log('══════════════════════════════════════════════════')
if (failed !== null) {
  console.log(`✗ CI 未通过：${failed} 失败 —— 阻断发布`)
  process.exit(1)
}
console.log('✓ CI 全绿：lint / 单测 / 十四道门禁 全部通过')
process.exit(0)
