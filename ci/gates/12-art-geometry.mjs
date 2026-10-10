#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑫   美术实测值必须与等距投影自洽   .sh 的等价 Node 移植
// 做法：执行 node scripts/check-art-geometry.mjs，透传结论。
// 用法：node ci/gates/12-art-geometry.mjs
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './lib.mjs'

const r = spawnSync('node', ['scripts/check-art-geometry.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
const rc = r.status ?? 1

if (rc === 0) {
  if (out.includes('已知问题')) {
    const m = out.match(/已知问题 [0-9]+ 条/)
    const n = m ? (m[0].match(/[0-9]+/) || ['?'])[0] : '?'
    console.log(`✓ [门禁⑫] 美术几何自洽（另有 ${n} 条已登记项未清 —— 见 worldLayout.ts）`)
  } else {
    console.log('✓ [门禁⑫] 美术几何自洽（所有刚体平面均满足 2:1 等距）')
  }
  process.exit(0)
}

console.log('✗ [门禁⑫] 美术实测值与等距投影不自洽')
console.log('')
const idx = out.search(/══ 结论/)
const tail = idx >= 0 ? out.slice(idx) : out
for (const l of tail.split(/\r?\n/).slice(0, 30)) console.log(l)
console.log('')
console.log('  排查入口：npm run check:art')
console.log('  说明：新加的平面（地毯 / 蒲团 / 香炉 / 台阶…）在等距投影下')
console.log('        半宽/半高必须 = GW/GH；若确属软物体，请登记到')
console.log('        scripts/check-art-geometry.mjs 的 KNOWN_ISSUES 并写清理由。')
process.exit(1)
