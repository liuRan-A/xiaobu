#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ①   包体硬门禁（APK > 30 MB 即阻断）   .sh 的等价 Node 移植
// ---------------------------------------------------------------------------
// 用法：node ci/gates/01-bundle-size.mjs [src]
//   环境变量：APK_MAX_MB(默认30) DIST_HARD_MAX_MB(默认30)
//            DIST_MAX_KB(默认1024) DIST_GROWTH_MAX_KB(默认256)
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, floorDiv, human, walkRelative } from './lib.mjs'

process.argv[2] // 兼容 $1（本门禁不使用 SRC）

const APK_MAX_MB = Number(process.env.APK_MAX_MB ?? 30)
const DIST_HARD_MAX_MB = Number(process.env.DIST_HARD_MAX_MB ?? 30)
const DIST_MAX_KB = Number(process.env.DIST_MAX_KB ?? 1024)
const DIST_GROWTH_MAX_KB = Number(process.env.DIST_GROWTH_MAX_KB ?? 256)
let FAIL = 0

console.log(`── 门禁① 包体扫描（根目录 ${REPO_ROOT}）`)

// ── (a) APK 硬上限：有任何 android APK / AAB 产物都要量 ────────────────────
const apkRoot = path.join(REPO_ROOT, 'android')
const apks = existsSync(apkRoot)
  ? walkRelative(apkRoot, { exts: ['.apk', '.aab'] }).map((r) => path.join(apkRoot, r))
  : []
if (apks.length > 0) {
  for (const f of apks) {
    const sz = statSync(f).size
    const mb = Number((sz / 1048576).toFixed(2))
    if (mb > APK_MAX_MB) {
      console.log(`✗ [门禁①] ${path.basename(f)} = ${mb} MB > ${APK_MAX_MB} MB`)
      FAIL = 1
    } else {
      console.log(`  · ${path.basename(f)} = ${mb} MB / 上限 ${APK_MAX_MB} MB`)
    }
  }
} else {
  console.log('  · 无 APK 产物（未跑 cap build）—— 跳过硬上限，改查 dist 增量')
}

// ── (b) dist 绝对上限 + 增量预算 ───────────────────────────────────────────
const distAbs = path.join(REPO_ROOT, 'dist')
if (existsSync(distAbs) && statSync(distAbs).isDirectory()) {
  let total = 0
  for (const rel of walkRelative(distAbs)) total += statSync(path.join(distAbs, rel)).size
  const totalKb = floorDiv(total, 1024)
  const totalMb = Number((total / 1048576).toFixed(2))
  console.log(`  · dist 总计 ${human(total)}`)

  // ★ 30MB 绝对红线（终极兜底）
  if (totalMb > DIST_HARD_MAX_MB) {
    console.log(`✗ [门禁①] dist ${totalMb} MB > ${DIST_HARD_MAX_MB} MB —— 触发绝对红线，直接阻断构建`)
    FAIL = 1
  }

  // 收紧预算（当前阶段 1MB）
  if (totalKb > DIST_MAX_KB) {
    console.log(`✗ [门禁①] dist ${totalKb} KB > ${DIST_MAX_KB} KB（Web 产物当前阶段收紧预算）`)
    FAIL = 1
  }

  // 增量：与基线文件比
  const baseFile = path.join(REPO_ROOT, '.bundle-baseline')
  if (existsSync(baseFile)) {
    const raw = readFileSync(baseFile, 'utf8').replace(/\s+/g, '')
    const prev = raw === '' ? 0 : Number(raw)
    const grow = total - prev
    if (grow > 0) {
      const growKb = floorDiv(grow, 1024)
      console.log(`  · 相对基线增长 ${human(grow)}（基线 ${human(prev)}）`)
      if (growKb > DIST_GROWTH_MAX_KB) {
        console.log(`✗ [门禁①] 单次增量 ${growKb} KB > ${DIST_GROWTH_MAX_KB} KB`)
        console.log('          美术资源请分批接入（每接一类资源跑一次 npm run ci）')
        console.log(`          确需扩大：更新基线 echo ${total} > ${baseFile}，并在 PR 里说明加的是什么`)
        FAIL = 1
      }
    } else {
      console.log('  · 相对基线未增长')
    }
  } else {
    console.log('  · 无基线 —— 本门禁不做隐形记录（那样增量会恒为 0，看 §M3-A3）')
    console.log('     首次：先跑 npm run bundle:baseline 记下这一版，之后每次都比对')
  }
} else {
  console.log('  · 无 dist 目录 —— 跳过（先跑 npm run build）')
}

if (FAIL === 0) {
  console.log(
    `✓ [门禁①] 包体在预算内（APK ≤ ${APK_MAX_MB} MB / dist 绝对红线 ≤ ${DIST_HARD_MAX_MB} MB / dist 收紧预算 ≤ ${DIST_MAX_KB} KB / 单次增量 ≤ ${DIST_GROWTH_MAX_KB} KB）`,
  )
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 先跑 scripts/ 里的资源检查，找出是哪张图 / 哪个 chunk 变大')
  console.log('  · 美术走 CDN 四季资源包（config.assets.packs），不要进主包')
  console.log('  · 压缩后再放：PNG 需先有损收敛（低色深 / 有损量化）或直接改 webp；SVG 必须过 svgo')
  console.log('  · 纳入 M3 美术接入规范：每加一类资源基线重算一次，不允许累积式增长')
}
process.exit(FAIL)
