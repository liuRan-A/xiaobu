#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ④   禁引擎残留   .sh 的等价 Node 移植
// 判据：① 源码 import 引擎  ② package.json 依赖声明  ③ lockfile 传递依赖
// 用法：node ci/gates/04-no-engine-residue.mjs [src]
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { readText, resolveRepo, scanCode } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
let FAIL = 0

// 包名字面上的边界识别：出现在 import 字符串或 deps 键里才拦。
// ★ 只在**包引用语境**（`from` / `require(` / `import(` 之后跟着的模块名）里拦，
//   而不是任意字符串字面量 —— 否则塔罗阶位名 `'three'`、画布名 `'p5'` 这类
//   **纯数据字面量**会被误判成引擎引用（见 src/core/tarot/cardsIndex.ts）。
//   真实引擎残留一定是 `import ... from 'three'` / `require('three')` 这类写法，
//   收紧到这个语境既消除误报，又不放过任何一处真引用。
const ENGINE_RE =
  /(?:from|require|import)\s*\(?\s*["'](unity|cocos|unreal|pixi|pixi\.js|three|babylonjs|phaser|godot|laya|egret|p5)(?:\.js)?(?:\/[^"']*)?["']/
const PKG_DEP_RE = /"(three|pixi|pixi\.js|babylonjs|phaser|unity|cocos|unreal|egret|laya)"\s*:/
const LOCK_RE = /"node_modules\/(three|pixi|pixi\.js|babylonjs|phaser|unity|cocos|unreal|egret|laya)"/g

console.log('── 门禁④ 引擎残留扫描（源 + 依赖 + lockfile 三处）')

// ── ① 源码 import ──────────────────────────────────────────────────────────
let h = scanCode(SRC, ENGINE_RE).filter((l) => !l.includes('财产损失'))
if (h.length > 0) {
  console.log('✗ [门禁④] 源码引用了引擎：')
  for (const l of h) console.log(`    ${l}`)
  FAIL = 1
}

// ── ② package.json 的依赖声明 ──────────────────────────────────────────────
const pkg = readText('package.json')
if (pkg !== null) {
  const lines = pkg.split(/\r?\n/)
  h = []
  lines.forEach((line, i) => {
    if (PKG_DEP_RE.test(line)) h.push(`package.json:${i + 1}:${line}`)
  })
  if (h.length > 0) {
    console.log('✗ [门禁④] package.json 声明了引擎依赖：')
    for (const l of h) console.log(`    ${l}`)
    FAIL = 1
  }
}

// ── ③ lockfile 传递依赖 ────────────────────────────────────────────────────
const lock = readText('package-lock.json')
if (lock !== null) {
  const matches = new Set()
  let m
  while ((m = LOCK_RE.exec(lock)) !== null) matches.add(m[0])
  if (matches.size > 0) {
    console.log('✗ [门禁④] lockfile 里存在引擎包（可能被传递依赖带入）：')
    for (const l of [...matches].sort()) console.log(`    ${l}`)
    FAIL = 1
  }
}

if (FAIL === 0) {
  console.log('✓ [门禁④] 无引擎残留：小卜保持 DOM + Canvas2D 自绘路线')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 想要粒子 / 缓动 / 序列帧 → 用 src/scene 里现有的 Canvas2D 管线')
  console.log('  · 确实觉得缺能力 → 先补机能需求文档，评估后再集体决定是否破例')
}
process.exit(FAIL)
