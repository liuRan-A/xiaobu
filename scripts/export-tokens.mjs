#!/usr/bin/env node
/**
 * 小卜 · 设计 Token 导出器   scripts/export-tokens.mjs
 * ===========================================================================
 * 读 src/ui/styles/tokens.css  →  写 src/scene/renderer/tokens.gen.ts
 *
 * 为什么必须有这个脚本：
 *   Canvas2D 读不到 CSS 变量。如果 scene/ 里手抄一份色值，就出现"同一个 #FFC98C
 *   在两个文件里各写一遍"的局面 —— 美术改一处、忘了另一处，画面就悄悄跑偏，
 *   而且分散在几十个 draw 函数里极难查。所以：**tokens.css 是唯一真源，
 *   本脚本生成 Canvas 侧常量，CI 门禁 ⑪ 校验产物是否新鲜。**
 *
 * 用法：npm run tokens      （prebuild 会自动跑）
 * ===========================================================================
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CSS_PATH = resolve(root, 'src/ui/styles/tokens.css')
const OUT_PATH = resolve(root, 'src/scene/renderer/tokens.gen.ts')

/** `--c-wood-top` → `cWoodTop` */
const camel = (s) => s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())

/** 去掉 `/* ... *\/` 注释，避免把注释里的数字当成值 */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function parseCss(css) {
  const out = new Map()
  const re = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi
  let m
  while ((m = re.exec(stripComments(css))) !== null) {
    const name = camel(m[1].trim())
    const raw = m[2].trim().replace(/^['"]|['"]$/g, '')
    // 数值型：`180ms` / `12px` / `0.085` → 数字（Canvas 侧按设计 px / ms 直接用）
    const num = raw.match(/^(-?\d+(?:\.\d+)?)(px|ms)?$/)
    out.set(name, num ? Number(num[1]) : raw)
  }
  return out
}

function emit(map) {
  const lines = [
    // ★ 不写 `/* eslint-disable */`：产物是纯常量对象，本身就不触发任何规则，
    //   挂一条用不上的 disable 反而会被 `--report-unused-disable-directives` 报 warning。
    '// ===========================================================================',
    '// ★ AUTO-GENERATED —— 由 scripts/export-tokens.mjs 从 src/ui/styles/tokens.css 生成。',
    '//   禁止手改。要改色值改 tokens.css，然后跑 `npm run tokens`。',
    '//   CI 门禁 ⑪ 会把本文件与 tokens.css 重新生成的结果逐字节比对，不一致即阻断发布。',
    '//',
    '//   Canvas 侧与 DOM 侧共用同一份常量，是《规划》§6 的硬要求：',
    '//   「#FDF9F6 这类字面值在代码里出现第二次即视为违规」。',
    '// ===========================================================================',
    '',
    'export const TOKENS = {',
  ]
  for (const [k, v] of map) {
    lines.push(`  ${k}: ${typeof v === 'number' ? v : JSON.stringify(v)},`)
  }
  lines.push('} as const', '', 'export type TokenName = keyof typeof TOKENS', '')
  return lines.join('\n')
}

function main() {
  let css
  try {
    css = readFileSync(CSS_PATH, 'utf8')
  } catch {
    // ★ 静默失败：拿不到真源时保留已有产物，绝不让构建链在"美化文件缺失"这种
    //   非致命问题上断掉。产物不存在时由 TS 编译报错兜住（比这里崩掉更好定位）。
    process.stderr.write(`[tokens] skip: cannot read ${CSS_PATH}\n`)
    return
  }

  const map = parseCss(css)
  if (map.size === 0) {
    process.stderr.write('[tokens] skip: parsed 0 tokens (tokens.css format changed?)\n')
    return
  }

  const next = emit(map)
  let prev = ''
  try {
    prev = readFileSync(OUT_PATH, 'utf8')
  } catch {
    /* 首次生成 */
  }

  if (prev === next) {
    process.stdout.write(`[tokens] up-to-date (${map.size} tokens)\n`)
    return
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, next, 'utf8')
  process.stdout.write(`[tokens] wrote ${map.size} tokens → ${OUT_PATH}\n`)
}

main()
