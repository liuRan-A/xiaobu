/**
 * 小卜 · 卡背烘焙   scripts/export-cardback.mjs
 * ===========================================================================
 * 把**程序化卡背**（drawDeckTop，落日山丘 × 玄学稿）烘成 512×709 WebP 资产，
 * 写入 `src/assets/tarot/back.webp` —— 贴图阶段的"同稿自产"测试资产。
 *
 * 为什么要有这一步（不只是为了省美术预算）：
 *   ① 它把「WebP → TexLoader → drawImage → 门禁②红线」整条链**真实跑通一遍**，
 *     美术真稿到位时只是"换个同名文件"，不会临场踩出管线 bug。
 *   ② 程序化稿就是用户逐轮确认过的视觉定稿 —— 自产贴图 100% 保真、零沟通损耗。
 *   ③ 产物直接受门禁②的塔罗红线检验（≤100KB / ≤768px），管线是否可信当场见分晓。
 *
 * ★ 尺寸 512×709：卡背设计比例 52:72，512/52 ≈ 9.85 倍 → 72×9.85 ≈ 709。
 *   贴图会被 drawImage 原样铺回 52×72 的牌面，所以比例必须与设计稿一致。
 * ===========================================================================
 */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// ── 1. 打包入口（与 scene-smoke 同款配置） ──────────────────────────────────
await build({
  entryPoints: [join(root, 'scripts/scene-preview-entry.ts')],
  outfile: join(root, '.preview-build/cardback.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'silent',
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.env.DEV': 'true',
    'import.meta.env.MODE': '"bake"',
  },
})

const req = createRequire(
  process.env.WB_CANVAS_HOME ?? join(homedir(), '.workbuddy/binaries/node/workspace/package.json'),
)
const { createCanvas } = req('@napi-rs/canvas')

const { drawDeckTop } = await import(
  'file://' + join(root, '.preview-build/cardback.mjs').replace(/\\/g, '/')
)

// ── 2. 按设计比例烘焙 ───────────────────────────────────────────────────────
const W = 512
const SCALE = W / 52 // 卡背设计宽 52
const H = Math.round(72 * SCALE) // ≈ 709，保持 52:72
const RADIUS = Math.round(6 * SCALE) // 圆角同步放大，铺回小牌面时比例不变

const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
drawDeckTop(ctx, 0, 0, W, H, RADIUS, 1, 0)

// ── 3. 编码 WebP，质量自适应到 ≤100KB（门禁②塔罗红线） ────────────────────
const OUT = join(root, 'src/assets/tarot/back.webp')
mkdirSync(dirname(OUT), { recursive: true })

const LIMIT = 100 * 1024
let quality = 90
let buf
for (;;) {
  buf = await canvas.encode('webp', quality) // @napi-rs/canvas 的 encode 是异步的
  if (buf.length <= LIMIT || quality <= 40) break
  quality -= 6
}

if (buf.length > LIMIT) {
  process.stderr.write(`[cardback] ✗ webp ${buf.length}B > ${LIMIT}B（即使 quality 40）—— 检查画面复杂度\n`)
  process.exit(1)
}

writeFileSync(OUT, buf)
const kb = (statSync(OUT).size / 1024).toFixed(1)
process.stdout.write(
  `[cardback] ✓ ${OUT}\n` +
    `          ${W}×${H}（52:72 同比放大） quality=${quality} ${kb}KB ≤ 100KB 红线 ✓\n` +
    `          美术真稿到位后：同名覆盖此文件即可，管线零改动\n`,
)
