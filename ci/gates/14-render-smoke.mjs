#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑭   渲染冒烟   .sh 的等价 Node 移植
// 做法：执行 node scripts/scene-smoke.mjs，透传退出码。
// 用法：node ci/gates/14-render-smoke.mjs
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './lib.mjs'

const r = spawnSync('node', ['scripts/scene-smoke.mjs'], { cwd: REPO_ROOT, stdio: 'inherit' })
process.exit(r.status ?? 1)
