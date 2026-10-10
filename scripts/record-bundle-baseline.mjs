#!/usr/bin/env node
// ===========================================================================
// 小卜 · 记录包体基线   scripts/record-bundle-baseline.mjs
// ---------------------------------------------------------------------------
// 门禁① 的 dist 增量预算需要一个"上次有多大"的基准。
//
// 为什么刻意做成**手动**命令而不是每次 build 自动更新：
//   如果构建自动写基线，那"这次涨了多少"永远相对上一次构建，
//   而 M3 加美术是分几十次小步进行的 —— 每步 +200 KB、基线每次都被刷新，
//   于是**增量门禁恒为 0**，走' 三个月回头一看包体翻了五倍。
//   手动的关键是让开发者**看着数字做一次决定**：接受这 200 KB，或先压图。
//
// 用法：npm run bundle:baseline
//   打印当前 dist 体积并写入 dist/.bundle-baseline
// ===========================================================================
import fs from 'node:fs'
import path from 'node:path'

const DIST = 'dist'
// ★ 基线绝不放在 dist 内：那样它会被 walk() 计进 dist 体积，导致每次都虚增，
//   而"每次都涨一点"会让门禁在半年后彻底失去可信度。
const BASE = '.bundle-baseline'

function walk(dir) {
  let total = 0
  let count = 0
  if (!fs.existsSync(dir)) return { total, count }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const sub = walk(p)
      total += sub.total
      count += sub.count
    } else if (e.isFile()) {
      total += fs.statSync(p).size
      count += 1
    }
  }
  return { total, count }
}

const prev = fs.existsSync(BASE) ? Number(String(fs.readFileSync(BASE, 'utf8')).trim()) || 0 : null
const { total, count } = walk(DIST)

if (count === 0) {
  console.error('✗ dist 不存在或为空 —— 先 npm run build')
  process.exit(1)
}

const kb = (b) => (b / 1024).toFixed(1)

console.log(`dist 当前：${kb(total)} KB（${count} 个文件）`)
if (prev !== null) {
  const grow = total - prev
  const sign = grow >= 0 ? '+' : ''
  console.log(`基线旧值：${kb(prev)} KB   增量：${sign}${kb(grow)} KB`)
}

fs.writeFileSync(BASE, String(total), 'utf8')
console.log(`✓ 已写入基线 ${total} → ${BASE}`)
console.log('  下次 npm run gates 时，门禁① 会以这个值为基准比对增量。')
