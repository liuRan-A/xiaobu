#!/usr/bin/env node
/**
 * 小卜 · node 侧场景渲染   scripts/preview-scene.mjs
 * ===========================================================================
 * 把 M1 场景画成 PNG，**不开浏览器、不装 Chromium**。
 *
 * 为什么值得存在：
 *   ① 视觉回归。美术改稿 / 调色 / 改排序，跑一次就能看到"整间屋子"长什么样，
 *      比在真机上翻来覆去切页面快得多。
 *   ② 它同时是"渲染核心零 DOM 依赖"的证明：能在这里跑通，就说明
 *      isometric / LayerStack / L1–L9 没有偷偷访问 window / document。
 *   ③ 它把 M1 的"可以跑"从"能编译"变成"能出图"——编译过不等于画得对。
 *
 * 依赖：@napi-rs/canvas（原生 canvas，无需浏览器）。
 *   本项目**不把它写进 dependencies** —— 它是开发期的看图工具，不该进移动端 bd。
 *   所以它装在隔离的 node 工作区里，本脚本按下面的顺序去找：
 *     1. 项目自己的 node_modules（有人本地装了就直接用）
 *     2. $WB_CANVAS_HOME（默认 ~/.workbuddy/binaries/node/workspace）
 *   两处都没有 → 打印一句安装提示后**正常退出（exit 0）**。
 *   ★ 看图工具缺失不该阻断任何构建 —— 这跟防崩底线是同一条原则。
 *
 * 用法：npm run preview:scene
 * ===========================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(root, 'preview')

// ── 1. 找 @napi-rs/canvas ─────────────────────────────────────────────────
function loadCanvas() {
  const candidates = [
    join(root, 'package.json'),
    join(process.env.WB_CANVAS_HOME ?? join(homedir(), '.workbuddy', 'binaries', 'node', 'workspace'), 'package.json'),
  ]
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor)
      return { mod: req('@napi-rs/canvas'), from: anchor }
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

const loaded = loadCanvas()
if (!loaded) {
  process.stderr.write(
    '[preview] 跳过：未找到 @napi-rs/canvas（node 侧看图工具，不参与 app 打包）。\n' +
      '          安装方式（隔离工作区，不污染本项目）：\n' +
      '            cd ~/.workbuddy/binaries/node/workspace && npm i @napi-rs/canvas\n' +
      '          或在本项目本地安装：npm i -D @napi-rs/canvas\n',
  )
  process.exit(0)
}
const { createCanvas } = loaded.mod

// ── 2. 用 esbuild 把 TS 场景打成一份 node 能读的 ESM ──────────────────────
//    esbuild 是 vite 的既有依赖，不额外引入；tsconfig 里的 @scene/* 别名它自己会读。
const { build } = await import('esbuild')
const bundlePath = join(root, '.preview-build', 'scene.mjs')

await build({
  entryPoints: [join(root, 'scripts', 'scene-preview-entry.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'warning',
  // vite 特有的编译期常量，在 node 里要显式给值，否则 import.meta.env 会炸
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.env.DEV': 'true',
    'import.meta.env.MODE': '"preview"',
  },
})

const { createSceneStack, DESIGN_W, DESIGN_H, TOKENS } = await import(
  pathToFileURL(bundlePath).href
)

// ── 3. 渲染 ───────────────────────────────────────────────────────────────
//    2x 出图：设计基准是 390×844，放大到 780×1688 才看得清桌面上的细节。
const SCALE = 2
const canvas = createCanvas(DESIGN_W * SCALE, DESIGN_H * SCALE)
const ctx = canvas.getContext('2d')
ctx.scale(SCALE, SCALE)

const stack = createSceneStack()
const frame = { t: 0, dt: 16, n: 1 }
stack.render(ctx, frame)

mkdirSync(OUT_DIR, { recursive: true })
const outFile = join(OUT_DIR, 'm1-scene.png')
writeFileSync(outFile, canvas.toBuffer('image/png'))

// ── 4. 一句体检报告：第一笔是不是奶油底？有没有图层被隔离？ ────────────────
const dead = stack.quarantined()
process.stdout.write(
  `[preview] 已出图 ${DESIGN_W}×${DESIGN_H} @${SCALE}x → ${outFile}\n` +
    `[preview] 底色 token = ${TOKENS.cCream}（第一笔必须是它，否则就是白屏前兆）\n` +
    (dead.length ? `[preview] ⚠ 被隔离的图层：${dead.join(', ')}\n` : '[preview] ✓ 九个图层全部正常绘制\n'),
)
