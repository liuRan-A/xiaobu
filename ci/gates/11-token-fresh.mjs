#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑪   Token 产物必须新鲜   .sh 的等价 Node 移植
// ---------------------------------------------------------------------------
// 做法：备份产物 → 重新生成 → 与备份比对。任何失败路径都要把备份写回。
// 用法：node ci/gates/11-token-fresh.mjs [SRC]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './lib.mjs'

const GEN = path.join(REPO_ROOT, 'src/scene/renderer/tokens.gen.ts')

if (!existsSync(GEN)) {
  console.log(`✗ [门禁⑪] 产物不存在：${GEN}`)
  console.log('  → 跑一次 `npm run tokens` 并提交产物（它必须进仓库，否则 CI 无法比对）。')
  process.exit(1)
}

const backup = readFileSync(GEN, 'utf8') // 内存备份，等价 cp gen bak

// 生成器在"读不到真源 / 解析出 0 个 token"时会静默跳过并保留旧产物。
const r = spawnSync('node', ['scripts/export-tokens.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' })
const genRc = r.status ?? 1
if (genRc !== 0) {
  console.log(`✗ [门禁⑪] 导出脚本执行失败（退出码 ${genRc}）`)
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).slice(0, 12)
  for (const l of out) console.log(l)
  writeFileSync(GEN, backup) // trap restore
  process.exit(1)
}

const after = readFileSync(GEN, 'utf8')
if (after !== backup) {
  console.log('✗ [门禁⑪] Token 产物已过期')
  console.log('')
  console.log('  tokens.css 与 tokens.gen.ts 不一致。修复方式：')
  console.log('      npm run tokens    # 重新生成 src/scene/renderer/tokens.gen.ts')
  console.log('')
  console.log('  ★ 不要手改 tokens.gen.ts —— 下次生成会覆盖它。改色值请改：')
  console.log('      src/ui/styles/tokens.css')
  for (const l of simpleDiff(backup, after)) console.log(l)
  writeFileSync(GEN, backup) // trap restore
  process.exit(1)
}

const count = (after.match(/^  [a-zA-Z]/gm) || []).length
console.log(`✓ [门禁⑪] Token 产物新鲜（${count} 个 token，与 tokens.css 一致）`)
process.exit(0)

/** 极简逐行 diff（最多 24 行），等价 `diff <(cat bak) <(cat gen) | head -24` */
function simpleDiff(a, b) {
  const la = a.split(/\r?\n/)
  const lb = b.split(/\r?\n/)
  const out = []
  const n = Math.max(la.length, lb.length)
  for (let i = 0; i < n && out.length < 24; i += 1) {
    if (la[i] !== lb[i]) {
      if (la[i] !== undefined) out.push(`- ${la[i]}`)
      if (lb[i] !== undefined) out.push(`+ ${lb[i]}`)
    }
  }
  return out
}
