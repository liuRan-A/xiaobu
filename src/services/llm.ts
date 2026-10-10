/**
 * 小卜 · 云端解读客户端   src/services/llm.ts
 * ===========================================================================
 * 解读链路的第三段：**先本地、再云端、失败回落本地**。
 *   · 本地模板（core/readingCopy）**永远**是可用态，云端只是更好看的那一版
 *   · 本模块只有一个出口 `requestCloudReading()`，它**永不抛异常**：
 *     返回 `ReadingCopy` = 云端可用；返回 `null` = 用本地模板（调用方的默认分支）
 *
 * ── 后端在哪 ────────────────────────────────────────────────────────────────
 *   真后端在仓库内 `server/`（FastAPI，当前为桩响应）。地址由 **VITE_API_BASE** 决定：
 *
 *     · Web 开发（默认）：留空 → 请求打相对路径 `/api/reading`，
 *       由 vite.config.ts 的 server.proxy 转发到本地 FastAPI（无跨域）。
 *     · 真机 / 生产：**必须**填绝对地址（如 https://api.example.com）。
 *       因为 App 跑在 capacitor://localhost 里，相对路径会打到 WebView 自己身上，
 *       永远命中不了自家后端。
 *
 *     POST {VITE_API_BASE}/api/reading
 *     Content-Type: application/json
 *     Body:  serializeForNetwork(req)  →  { kind, dims, structure }
 *                                   ★ 只发白名单枚举，用户的原话(localOnly)永不出端
 *     Resp:  { title?, subtitle?, sections:[{ key?, label, body }], summary?, moodLabel?, cents? }
 *            ★ title / subtitle 允许缺省 —— 卦名与牌阵名只有客户端的内容表里有，
 *              缺省时由调用方沿用本地标题（见 SheetResult 的合并）。
 *
 * ── 三道闸门（任一不过 ⇒ 连请求都不发，直接回落本地）────────────────────────
 *   ① killSwitch.disableLlm      服务端一键停用云端 AI
 *   ② 成本熔断 isLlmCircuitBlown 当日全局花超上限（见 services/track）
 *   ③ 每用户日额度 quota.llmDailyFreePerUser（本地软计数，真实额度由服务端兜底）
 *
 * ── 边界（与全仓一致）────────────────────────────────────────────────────────
 *   · 门禁⑨：catch 内只 logger.warn，绝不弹 UI、绝不冒泡
 *   · 门禁⑬：额度计数只在内存里，绝不碰 localStorage / IndexedDB
 *   · 不阻塞首帧：调用方（SheetResult）先渲染本地文案，云端到了再静默替换
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { currentConfig } from '@bootstrap/bootSequence'
import { isLlmCircuitBlown, recordLlmCost, trackApiCall } from '@services/track'
import { serializeForNetwork, type ReadingRequest } from '@core/reading'
import { FORBIDDEN_COPY } from '@core/guide/guide'
import type { CopySection, ReadingCopy } from '@core/readingCopy'

/**
 * 出网基址。★ 真机 / 生产必须用 VITE_API_BASE 给绝对地址 ——
 * Capacitor 里相对路径会打到 capacitor://localhost，永远命中不了自家后端。
 * Web 开发留空即可，由 Vite dev 代理转发（见 vite.config.ts 的 server.proxy）。
 */
const API_BASE = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 解读网关：路径里**不含任何密钥**（Key 只在服务端 .env 里） */
const READING_ENDPOINT = `${API_BASE}/api/reading`

/** 解读比拉配置慢，但也不该让用户干等；超时即回落本地模板 */
const READING_TIMEOUT_MS = 6000

export interface LlmOptions {
  /** 端点覆盖（测试用） */
  url?: string
  /** 超时覆盖（测试用） */
  timeoutMs?: number
  /** fetch 注入（测试 / SSR 环境） */
  fetchImpl?: typeof fetch
  /** 当前时刻注入（测试用日额度跨天） */
  now?: () => number
}

// ───────────────────────────────────────────────────────────────────────────
// 每用户日额度（内存软计数；真实额度由服务端兜底，本地只为省掉无谓请求）
// ───────────────────────────────────────────────────────────────────────────

let quotaDay = ''
let quotaUsed = 0

function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 额度闸门：跨天自动归零；额度非正数视为"云端不可用" */
function quotaAllows(now: number): boolean {
  const limit = currentConfig().quota.llmDailyFreePerUser
  if (!(limit > 0)) return false
  const key = dayKey(now)
  if (key !== quotaDay) {
    quotaDay = key
    quotaUsed = 0
  }
  return quotaUsed < limit
}

/**
 * 云端 AI 此刻是否可用（三道闸门）。
 * ★ 只是"要不要发请求"的预判；真正的失败（超时 / 结构非法）由 requestCloudReading 兜。
 */
export function isLlmEnabled(now = Date.now()): boolean {
  const cfg = currentConfig()
  if (cfg.killSwitch.disableLlm) return false
  if (isLlmCircuitBlown()) return false
  return quotaAllows(now)
}

// ───────────────────────────────────────────────────────────────────────────
// 响应解析（结构校验；任何一点不合格都当作"云端不可用"，回落本地）
// ───────────────────────────────────────────────────────────────────────────

export interface ParsedCloudReading {
  copy: ReadingCopy
  /** 本次花费（分）；0 = 后端没给 */
  cents: number
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseSections(v: unknown): CopySection[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: CopySection[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null
    const s = raw as Record<string, unknown>
    const label = asStr(s.label)
    const body = asStr(s.body)
    // 空标签 / 空正文一律视为脏数据 —— 宁可回落本地，也不给用户看半截话
    if (!label || !body) return null
    out.push({ key: asStr(s.key) || String(out.length + 1), label, body })
  }
  return out
}

/**
 * 把云端响应解析成与本地同形的 `ReadingCopy`。
 * ★ 结构必须与 `interpretLocally()` 的输出一致 —— 两边同形，SheetResult 不必写两套渲染。
 * ★ `title` / `subtitle` / `summary` / `moodLabel` 允许缺省（空串）：卦名、牌阵名只存在
 *   客户端的内容表里，服务端这一版给不出。缺省由调用方沿用本地值（见 SheetResult）。
 *   唯一硬要求是 **sections 非空且每段 label / body 都非空** —— 否则整份丢弃。
 * ★ 语气红线：命中禁词的响应整份丢弃（回落本地合规文案）。云端文案是**面向用户**的，
 *   这条线不能只靠服务端自觉 —— 客户端再守一道，代价是几行代码。
 */
export function parseCloudReading(raw: unknown): ParsedCloudReading | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const sections = parseSections(r.sections)
  if (!sections) return null

  const copy: ReadingCopy = {
    title: asStr(r.title),
    subtitle: asStr(r.subtitle),
    sections,
    summary: asStr(r.summary),
    moodLabel: asStr(r.moodLabel),
  }

  const visible = `${copy.title}${copy.subtitle}${copy.summary}${copy.sections
    .map((s) => s.label + s.body)
    .join('')}`
  if (FORBIDDEN_COPY.test(visible)) return null

  const cents = typeof r.cents === 'number' && r.cents > 0 ? r.cents : 0
  return { copy, cents }
}

// ───────────────────────────────────────────────────────────────────────────
// 唯一出口
// ───────────────────────────────────────────────────────────────────────────

/**
 * 向云端要一份解读。
 *
 * @returns 云端解读（结构化，与本地同形）；`null` = 用本地模板（含以下全部情形：
 *          云端被停用 / 熔断 / 额度用尽 / 无 fetch / 超时 / 非 2xx / 非法 JSON /
 *          结构不合格 / 命中禁词）。**调用方只需 `cloud ?? localCopy`。**
 */
export async function requestCloudReading(
  req: ReadingRequest,
  opts: LlmOptions = {},
): Promise<ReadingCopy | null> {
  const nowFn = opts.now ?? Date.now

  // ① 三道闸门：任一不过就不发请求
  if (!isLlmEnabled(nowFn())) return null

  // ② 传输可用性
  const doFetch = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!doFetch) return null

  const url = opts.url ?? READING_ENDPOINT
  const timeoutMs = opts.timeoutMs ?? READING_TIMEOUT_MS
  // ★ 出端载荷只有白名单字段（kind / dims / structure）——localOnly 里的用户原话被剥掉
  const body = serializeForNetwork(req)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!res.ok) return null

    let raw: unknown
    try {
      raw = await res.json()
    } catch {
      return null
    }

    const parsed = parseCloudReading(raw)
    if (!parsed) return null

    // ③ 成功才算一次额度 + 打点 + 记成本（失败不占额度，用户下次仍可试）
    quotaUsed += 1
    trackApiCall('READING')
    if (parsed.cents > 0) recordLlmCost(parsed.cents)
    return parsed.copy
  } catch (e) {
    // ★ 门禁⑨：超时 / 断网 / 任何异常都静默回落本地模板，绝不弹 UI、绝不冒泡
    logger.warn('[llm] cloud reading unavailable, fall back to local', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：清空额度计数（跨用例隔离） */
export function __test_resetLlm(): void {
  quotaDay = ''
  quotaUsed = 0
}
