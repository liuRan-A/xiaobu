#!/usr/bin/env node
/**
 * 小卜 · 美术几何体检   scripts/check-art-geometry.mjs
 * ===========================================================================
 * 回答一个经常在最坏的时刻才被发现的问题：
 *
 *   **"我们实际画出来的这些平面，符合等距投影吗？"**
 *
 * 为什么必须有这个脚本：
 *   等距 2.5D 里，**任何轴对齐的刚体平面，投影出来必然是平行四边形**，
 *   而且半宽 / 半高必然等于 GW/GH（≈2.0049）。这不是风格问题，是数学。
 *   所以只要有一个平面违反它，那个平面就是错的 —— 而且错法可以被指认。
 *
 *   这个坑真实发生过。`TABLE_QUAD` 的左右顶点被量在了**画布边缘**（x=0 / x=390），
 *   桌面因此被量窄了 105.7px/侧，后果是"卦盘看起来探出了桌面"
 *   —— 于是所有人去查卦盘，而根源在一组实测像素。
 *   当时**没有任何一条断言在问"这符合投影吗"**：104 条单测全绿也照样漏。
 *   这个脚本就是那条缺失的断言。
 *
 * 检查对象是**实际用于渲染的四边形**（TABLE_QUAD / boardQuad()），
 * 而不是 MEASURED 里的原始记录 —— 门禁要守的是"画出来的东西"。
 *   原始记录另做一份审计（第二节），用来防止有人再去读那个不可用的值。
 *
 * 用法：npm run check:art
 * 退出码：0 = 全部自洽；1 = 有刚体平面违反投影
 * ===========================================================================
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = join(root, '.preview-build', 'scene.mjs')

const { build } = await import('esbuild')
await build({
  entryPoints: [join(root, 'scripts', 'scene-preview-entry.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'warning',
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.env.DEV': 'true',
    'import.meta.env.MODE': '"geometry"',
  },
})

const { ISO, MEASURED, DESIGN_W, DESIGN_H, TABLE_QUAD, boardQuad } = await import(
  pathToFileURL(bundlePath).href
)

// ── 小工具 ────────────────────────────────────────────────────────────────
const f = (n, d = 2) => n.toFixed(d)
const pct = (a, b) => ((a - b) / b) * 100
const line = (s = '') => process.stdout.write(s + '\n')

/** 由四顶点取"半宽 / 半高"（顶点顺序 top→right→bottom→left） */
function halves(q) {
  return {
    w: (q.right.x - q.left.x) / 2,
    h: (q.bottom.y - q.top.y) / 2,
  }
}

/** 平行四边形判定：top + bottom 是否等于 left + right（向量和的差） */
function parallelogramGap(q) {
  return {
    x: q.top.x + q.bottom.x - (q.left.x + q.right.x),
    y: q.top.y + q.bottom.y - (q.left.y + q.right.y),
  }
}

/** 点在凸四边形内（四边同侧判定）。顶点顺序 top→right→bottom→left */
function insideQuad(q, p) {
  const poly = [q.top, q.right, q.bottom, q.left]
  let sawPos = false
  let sawNeg = false
  for (let i = 0; i < 4; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % 4]
    const cr = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cr > 1e-9) sawPos = true
    if (cr < -1e-9) sawNeg = true
  }
  return !(sawPos && sawNeg)
}

/** 点到四边形边界的最短距离（用于量化"探出多少"） */
function distanceToBoundary(q, p) {
  const poly = [q.top, q.right, q.bottom, q.left]
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < 4; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % 4]
    const vx = b.x - a.x
    const vy = b.y - a.y
    const len2 = vx * vx + vy * vy
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2))
    best = Math.min(best, Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)))
  }
  return best
}

// ── 已知问题白名单 ────────────────────────────────────────────────────────
//   为什么要有白名单：一道永远红的门禁会被无视，但"假装没问题"更糟。
//   所以：已登记的项不阻断，**新出现的不自洽一定阻断**（盯增量）。
//   ★ 每一条都必须写清"为什么先放着"和"谁来收尾"，否则白名单会变成垃圾场。
//   ★ 目前是**空的** —— 桌面问题已修好，门禁处于全硬状态。这是最好的一种状态。
const KNOWN_ISSUES = []

const issues = []
const note = (id, msg) => issues.push({ id, msg })

// ═══════════════════════════════════════════════════════════════════════════
line('')
line('══ 小卜 · 美术几何体检 ═══════════════════════════════════════════════')
line('')
line(`设计基准            ${DESIGN_W} × ${DESIGN_H}`)
line(`网格 GW / GH        ${f(ISO.gw, 5)} / ${f(ISO.gh, 5)}   → 比例 ${f(ISO.ratio, 6)}`)
line(`LIFT（1 单位高度）  ${f(ISO.lift, 3)} px`)
line('')

// ── 一、实际渲染的刚体平面 ────────────────────────────────────────────────
line('── 一、实际渲染的刚体平面（必须是"轴对齐平面的投影"）───────────────')
line('')
line('  两条硬约束：① 上+下 == 左+右（平行四边形）  ② 半宽/半高 == 网格比例')
line('')

const rigidPlanes = [
  { key: 'board', name: '卦盘 boardQuad()', quad: boardQuad() },
  { key: 'table', name: '桌面 TABLE_QUAD', quad: TABLE_QUAD },
]

for (const p of rigidPlanes) {
  const { w, h } = halves(p.quad)
  const r = w / h
  const dev = pct(r, ISO.ratio)
  const gap = parallelogramGap(p.quad)
  const gapMag = Math.hypot(gap.x, gap.y)
  const ratioOk = Math.abs(dev) <= 0.5
  const paraOk = gapMag < 1e-6
  const ok = ratioOk && paraOk

  line(`  ${ok ? '✓' : '✗'} ${p.name}`)
  line(`      半宽 ${f(w)} × 半高 ${f(h)}  → 比例 ${f(r, 4)}  偏差 ${dev >= 0 ? '+' : ''}${f(dev, 2)}%`)
  line(`      平行四边形恒等式残差 ${f(gapMag, 6)} px`)
  if (!ratioOk) {
    note(
      `ratio:${p.key}`,
      `${p.name} 像素长宽比 ${f(r, 4)}，网格要求 ${f(ISO.ratio, 4)}（偏差 ${f(dev, 2)}%）`,
    )
  }
  if (!paraOk) {
    note(
      `parallelogram:${p.key}`,
      `${p.name} 不是平行四边形（残差 ${f(gapMag, 3)}px）—— 不可能是任何轴对齐平面的投影`,
    )
  }
}
line('')

// ── 二、原始实测值的可用性审计（信息性）──────────────────────────────────
line('── 二、MEASURED 原始记录的可用性（信息性，不判定成败）──────────────')
line('')
line('  （有些实测值虽然被记下来了，但**不能用于标定**。这里把它们点名。）')
line('')

const rawAudit = [
  { name: 'boardHalf', half: MEASURED.boardHalf, note: '可用 —— 卦盘小于画布，未被裁切' },
  {
    name: 'tableHalf',
    half: MEASURED.tableHalf,
    note: '★ .x 不可用（= 画布半宽）；仅 .y 可用',
  },
  {
    name: 'floorHalf',
    half: MEASURED.floorHalf,
    note: '.x 同样落在画布边缘；且地毯软边手绘，比例本就不必严格',
  },
]

for (const a of rawAudit) {
  const onEdgeX = Math.abs(a.half.x - DESIGN_W / 2) < 1e-6
  line(
    `  ${onEdgeX ? '⚠' : ' '} ${a.name.padEnd(10)} ${String(a.half.x).padStart(6)} × ${String(a.half.y).padStart(6)}   ${a.note}`,
  )
}
line('')
line('  ⚠ 标记的意思是：该 .x 恰好等于画布半宽。真物体横跨画布时会被画布裁掉，')
line('    量到的"边"其实是**裁切线**，不携带任何艺术信息 —— 不能用来标定。')
line('    桌面的处置见 worldLayout.ts：半宽改由 半高 × 网格比例 反推。')
line('')

// ── 三、卦盘是否完整落在桌面内 ───────────────────────────────────────────
line('── 三、卦盘 vs 桌面：包含关系 ─────────────────────────────────────')
line('')
const bq = boardQuad()
const bCorners = [
  ['上(远)', bq.top],
  ['右', bq.right],
  ['下(近)', bq.bottom],
  ['左', bq.left],
]
line('  卦盘四顶点（屏幕）:')
for (const [n, p] of bCorners) line(`    ${n.padEnd(8)} (${f(p.x, 1)}, ${f(p.y, 1)})`)
line('')
const tableHalves = halves(TABLE_QUAD)
line(
  `  桌面：中心 (${f(MEASURED.tableTopCenter.x, 1)}, ${f(MEASURED.tableTopCenter.y, 1)})，` +
    `半宽 ${f(tableHalves.w, 1)} / 半高 ${f(tableHalves.h, 1)}`,
)
line(
  `        横跨 x ∈ [${f(TABLE_QUAD.left.x, 1)}, ${f(TABLE_QUAD.right.x, 1)}]` +
    '（比画布宽，会被裁 —— 正常）',
)
line('')
const outside = []
for (const [n, p] of bCorners) {
  if (!insideQuad(TABLE_QUAD, p)) {
    outside.push(`${n} 探出 ${f(distanceToBoundary(TABLE_QUAD, p), 1)}px`)
  }
}
if (outside.length) {
  note('board-outside-table', `卦盘探出桌面：${outside.join('；')}`)
  line(`  ✗ ${outside.join('；')}`)
} else {
  line('  ✓ 卦盘完整落在桌面内（与设计稿一致）')
}
line('')

// ── 结论 ──────────────────────────────────────────────────────────────────
line('══ 结论 ═════════════════════════════════════════════════════════════')
line('')

const knownIds = new Set(KNOWN_ISSUES.map((k) => k.id))
const newIssues = issues.filter((i) => !knownIds.has(i.id))
const knownHit = issues.filter((i) => knownIds.has(i.id))

if (knownHit.length) {
  line(`  ⚠ 已知问题 ${knownHit.length} 条（已登记，不阻断）：`)
  for (const k of KNOWN_ISSUES) {
    const hit = knownHit.find((i) => i.id === k.id)
    if (!hit) continue
    line(`      · ${hit.msg}`)
    line(`        为什么先放着：${k.why}`)
    line(`        收尾方式：${k.fix}`)
  }
  line('')
}

if (newIssues.length) {
  line(`  ✗ 新增不自洽 ${newIssues.length} 条（白名单里没有）—— 必须修：`)
  for (const i of newIssues) line(`      · [${i.id}] ${i.msg}`)
  line('')
  line('  改法提示：')
  line('    · 若这个平面是**轴对齐刚体**（桌子 / 台阶 / 箱柜…）→ 它必须满足 2:1 等距，')
  line('      请修正它的实测像素；半宽可以直接由 半高 × ISO.ratio 反推。')
  line('    · 若它确实是**软物体**（软边手绘、允许不成比例）→ 请把它登记到')
  line('      KNOWN_ISSUES 并写清理由与收尾方式。')
  line('')
  process.exit(1)
}

if (knownHit.length) {
  line(`  ✓ 除 ${knownHit.length} 条已登记项外，无新增不自洽。`)
} else {
  line('  ✓ 全部自洽 —— 所有刚体平面都满足 2:1 等距，卦盘完整落在桌面内。')
}
line('')

process.exit(0)
