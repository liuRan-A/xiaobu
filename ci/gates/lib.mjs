// ===========================================================================
// 小卜 · 门禁共享工具   ci/gates/lib.mjs
// ---------------------------------------------------------------------------
// 把各道 .sh 门禁里反复出现的动作抽到这里：
//   · 从 import.meta.url 推出仓库根（等价 .sh 的 ROOT="$(cd .../../.. && pwd)"）
//   · 递归遍历 + 按扩展名过滤（排除 node_modules）
//   · 把路径统一成正斜杠
//   · 复刻 `grep -rnE ... | grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'` 的行为
//
// ★ 路径为何要用「原始根字符串」拼：门禁② 的展示路径 / 白名单比对都要求
//   用**传进来的那个根**（相对或绝对原样）拼相对子路径，而不是 path.relative。
//   这样 `src/assets` → `src/assets/tarot/back.webp`，与 .sh 的 find 输出一致。
// ===========================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（本文件位于 ci/gates/ 下） */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 反斜杠 → 正斜杠（Windows 原生路径 → 展示路径） */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** 把（可能相对的）根解析成绝对原生路径 */
export function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p)
}

/** 目录是否存在 */
export function isDir(p) {
  try {
    return statSync(resolveRepo(p)).isDirectory()
  } catch {
    return false
  }
}

/** 文件是否存在 */
export function isFile(p) {
  try {
    return statSync(resolveRepo(p)).isFile()
  } catch {
    return false
  }
}

/** 读文本，失败返回 null */
export function readText(p) {
  try {
    return readFileSync(resolveRepo(p), 'utf8')
  } catch {
    return null
  }
}

const DEFAULT_EXCLUDE_DIRS = ['node_modules']

/**
 * 递归遍历，返回相对 rootAbs 的路径（用 `/` 分隔）。
 * exts 为 null 时不按扩展名过滤（复刻 `grep -rn` 不带 --include 的行为）。
 */
export function walkRelative(rootAbs, { exts = null, excludeDirs = DEFAULT_EXCLUDE_DIRS } = {}) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const dirRel = stack.pop()
    const dirAbs = dirRel ? path.join(rootAbs, dirRel) : rootAbs
    let entries
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (excludeDirs.includes(e.name)) continue
        stack.push(rel)
      } else if (e.isFile()) {
        if (exts && !exts.some((x) => rel.toLowerCase().endsWith(x))) continue
        out.push(rel)
      }
    }
  }
  out.sort()
  return out
}

/**
 * 列出一个根下的文件，返回 { display, native }。
 * display 用**原始根字符串**（\→/）拼相对子路径，与 .sh 的 find/grep 输出一致。
 */
export function listFiles(rootRaw, opts = {}) {
  const rootAbs = resolveRepo(rootRaw)
  const rootDisp = toPosix(rootRaw).replace(/\/+$/, '')
  return walkRelative(rootAbs, opts).map((rel) => ({
    display: `${rootDisp}/${rel}`,
    native: path.join(rootAbs, rel),
  }))
}

/** 复刻 grep -rnE 的输出：`${display}:${lineno}:${content}`（不带注释剔除） */
export function scan(rootRaw, regex, opts = {}) {
  const out = []
  for (const { display, native } of listFiles(rootRaw, opts)) {
    const text = readText(native)
    if (text === null) continue
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) out.push(`${display}:${i + 1}:${lines[i]}`)
    }
  }
  return out
}

// 等价 `grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)'`：整行注释不参与匹配
const COMMENT_OUT_RE = /:[0-9]+:\s*(\/\/|\*|\/\*)/

export function isCommentOutput(line) {
  return COMMENT_OUT_RE.test(line)
}

/** 整行注释过滤：`.ts/.vue/.js` 默认扩展名 */
export function scanCode(rootRaw, regex, opts = {}) {
  const { exts = ['.ts', '.vue', '.js'] } = opts
  return scan(rootRaw, regex, { exts }).filter((l) => !isCommentOutput(l))
}

/** 跨多个根扫描 */
export function scanMany(roots, regex, opts = {}) {
  const out = []
  for (const r of roots) out.push(...scan(r, regex, opts))
  return out
}

/** 整行注释（源码行本身）—— 用于逐行窗口扫描（门禁⑨） */
const COMMENT_LINE_RE = /^\s*(\/\/|\*|\/\*)/

export function isCommentLine(line) {
  return COMMENT_LINE_RE.test(line)
}

/** 字节 → 人类可读（复刻 01 里的 human()） */
export function human(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** awk 'printf "%d", b/1024' —— 向零截断 */
export function floorDiv(a, b) {
  return Math.floor(a / b)
}
