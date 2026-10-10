#!/usr/bin/env node
/**
 * 小卜 · 渲染冒烟（门禁⑭本体）   scripts/scene-smoke.mjs
 * ===========================================================================
 * 回答一个 preview:scene 回答不了的问题：
 *   「同一场戏，走离屏缓存路径（真机路径）和直画路径，画出来的是**同一间屋子**吗？」
 *
 * ── 为什么必须有这道门（2026-10-10 事故复盘）──────────────────────────────
 *   LayerStack.ensureCache 曾给每趟烘焙画布铺不透明奶油底，blit 用 drawImage
 *   不透明贴回 —— GRADE 趟最后贴回时把整个房间盖成一片奶油色。真机上"小屋消失"，
 *   而全仓 572 条单测全绿（jsdom 没有真实 canvas，离屏缓存路径从未被走过）；
 *   preview:scene 也抓不到 —— 它调 stack.render(ctx, frame) 不传 fit，
 *   走的恰恰是没 bug 的直画路径。
 *
 *   本脚本把两条路径都跑一遍，并逐锚点比对：
 *     · 路径 A：stack.render(ctx, frame)            —— 直画（单测同款）
 *     · 路径 B：stack.render(ctx, frame, fit)       —— 离屏缓存 + blit（真机同款）
 *   断言：
 *     ① B 路径每个锚点都不得是奶油底（本场戏真的画了）
 *     ② A、B 两路锚点颜色一致（缓存合成不改变画面）
 *     ③ 没有任何图层被隔离（quarantined 为空）
 *
 * 依赖：@napi-rs/canvas（同 preview:scene，装在隔离工作区，不进 app 依赖）。
 * ===========================================================================
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── 1. 找 @napi-rs/canvas（同 preview-scene.mjs 的两处查找顺序） ──────────
function loadCanvas() {
  const candidates = [
    join(root, 'package.json'),
    join(process.env.WB_CANVAS_HOME ?? join(homedir(), '.workbuddy', 'binaries', 'node', 'workspace'), 'package.json'),
  ]
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor)
      return req('@napi-rs/canvas')
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

const { createCanvas } = loadCanvas() ?? {}
if (!createCanvas) {
  process.stderr.write(
    '[smoke] ✗ 未找到 @napi-rs/canvas —— 渲染冒烟无法执行。\n' +
      '        这不是"可选工具缺席"：门禁⑭守的是真机渲染路径，工具缺失必须补装：\n' +
      '          cd ~/.workbuddy/binaries/node/workspace && npm i @napi-rs/canvas\n',
  )
  process.exit(1) // ★ 门禁语义：守不住的门必须响，不静默放行
}

// ── 1.5 document 垫片：让离屏缓存路径真正跑起来 ──────────────────────────
// ★ 没有这一步，本门禁是假的：LayerStack.createCanvas 走 document.createElement，
//   node 里没有 document → 返回 null → ensureCache 静默降级为直画 ——
//   于是"fit 路径"和"直画路径"是同一条路，比对永远相等，门禁永远绿。
//   垫片只实现 createElement('canvas')，别的一概不给（也不该给）。
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement(tag) {
      if (tag === 'canvas') return createCanvas(1, 1)
      return undefined
    },
  }
}

// ── 2. esbuild 打包场景（同 preview-scene.mjs；esbuild 是 vite 既有依赖） ──
const { build } = await import('esbuild')
const bundlePath = join(root, '.preview-build', 'scene-smoke.mjs')

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
    'import.meta.env.MODE': '"smoke"',
  },
})

const { createSceneStack, DESIGN_W, DESIGN_H, TOKENS, computeFit } = await import(
  pathToFileURL(bundlePath).href
)

// ── 3. 双路径渲染 ─────────────────────────────────────────────────────────
const frame = { t: 0, dt: 16, n: 1 }

/** 路径 A：直画（无 fit） */
function renderDirect() {
  const canvas = createCanvas(DESIGN_W, DESIGN_H)
  const ctx = canvas.getContext('2d')
  const stack = createSceneStack()
  stack.render(ctx, frame)
  return { ctx, stack }
}

/** 路径 B：fit（离屏缓存 + blit）—— 完整复刻 CanvasRenderer.renderOnce 的变换 */
function renderWithFit() {
  const fit = computeFit(DESIGN_W, DESIGN_H, 1) // scale=1、off=0，但会走 ensureCache/blit
  const canvas = createCanvas(fit.bufW, fit.bufH)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(fit.dpr, 0, 0, fit.dpr, 0, 0)
  ctx.fillStyle = TOKENS.cCream
  ctx.fillRect(0, 0, fit.cssW, fit.cssH)
  const stack = createSceneStack()
  ctx.save()
  ctx.translate(fit.offX, fit.offY)
  ctx.scale(fit.scale, fit.scale)
  stack.render(ctx, frame, fit)
  ctx.restore()
  return { ctx, stack }
}

const direct = renderDirect()
const fitted = renderWithFit()

// ── 4. 锚点采样与断言 ─────────────────────────────────────────────────────
function px(ctx, x, y) {
  const d = ctx.getImageData(x, y, 1, 1).data
  return [d[0], d[1], d[2]]
}

const CREAM = [253, 249, 246] // TOKENS.cCream #fdf9f6 的 rgb

/**
 * 场景锚点（设计像素）。每个锚点都有明确的"它不该是奶油色"的理由：
 *   · wall   — L1 墙面渐变（暖米，b 通道差 ≥ 30）
 *   · table  — L3 木桌顶面（暖木，与奶油差一个色相）
 *   · board  — L6 卦盘盘面
 *   · deck   — L4 牌堆顶面（鼠尾草绿 cSage，g>r 是它的特征）
 *   · carpet — L2 毛毡地毯中心
 * ★ 选点原则：落在该图层**必然覆盖**的实心区域，避开描边/渐变端点。
 */
const ANCHORS = [
  { name: 'wall', x: 195, y: 150 },
  { name: 'table', x: 195, y: 480 },
  { name: 'board', x: 218, y: 528 },
  { name: 'deck', x: 195, y: 700 },
  { name: 'carpet', x: 110, y: 620 },
]

const fails = []

for (const a of ANCHORS) {
  const A = px(direct.ctx, a.x, a.y)
  const B = px(fitted.ctx, a.x, a.y)

  // ① B 路径（真机路径）不得是奶油底
  const diffCream = Math.max(Math.abs(B[0] - CREAM[0]), Math.abs(B[1] - CREAM[1]), Math.abs(B[2] - CREAM[2]))
  if (diffCream < 12) {
    fails.push(`✗ [${a.name}] fit 路径画出了奶油底 rgb(${B}) —— 场景在真机路径上消失（2026-10-10 GRADE blit 事故同款症状）`)
  }

  // ② 两路一致（缓存合成不得改变画面；容差 6 吃掉抗锯齿抖动）
  const diff = Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2]))
  if (diff > 6) {
    fails.push(`✗ [${a.name}] 直画 rgb(${A}) ≠ fit 路径 rgb(${B})（最大通道差 ${diff} > 6）—— 离屏缓存合成改变了画面`)
  }
}

// ③ 图层隔离必须为空
const dead = [...direct.stack.quarantined(), ...fitted.stack.quarantined()]
if (dead.length > 0) {
  fails.push(`✗ 有图层被隔离：${dead.join(', ')}（连续抛错被 LayerStack 永久停画）`)
}

// ── 5. 报告 ───────────────────────────────────────────────────────────────
if (fails.length > 0) {
  process.stderr.write(
    `[smoke] ✗ 渲染冒烟未通过（${fails.length} 条）：\n` + fails.map((f) => `  ${f}`).join('\n') + '\n',
  )
  process.exit(1)
}

process.stdout.write(
  `[smoke] ✓ 双路径渲染冒烟通过：${ANCHORS.length} 个锚点 直画 ≡ 离屏缓存，无图层隔离\n` +
    `        守住的回归：GRADE 烘焙不透明底 blit 盖屋（2026-10-10）\n`,
)
