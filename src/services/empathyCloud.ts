/**
 * 小卜 · 共情对话云端客户端   src/services/empathyCloud.ts
 * ===========================================================================
 * 「陪你说说话」的云端那半条腿。★ 与 `llm.ts`（解读）是**两条独立链路**：
 *   · 端点不同：这里是 `/api/chat`，解读是 `/api/reading`
 *   · 隐私模型不同：解读出端只有枚举；这里在**用户显式同意**下才带原话
 *   · 默认状态不同：解读默认可用；这里默认**关闭**（config.features.empathyCloud.enabled=false）
 *
 * ── 四道闸门（任一不过 ⇒ 连请求都不发，直接用本地回应）──────────────────────
 *   ① consent === 'on'                     用户显式同意（可随时改回 off）
 *   ② features.empathyCloud.enabled        配置总开关（默认 false）
 *   ③ killSwitch.disableLlm / 成本熔断     服务端一键停用 + 当日花超自动熔断
 *   ④ 每用户日额度 quota.llmDailyFreePerUser（本地软计数，真实额度由服务端兜底）
 *
 * ── 唯一出口永不变 ──────────────────────────────────────────────────────────
 *   `requestCloudEmpathy()` **永不抛**：返回 string = 云端回应；
 *   返回 null = 用本地回应（调用方的默认分支，也是绝大多数情况）。
 *
 * ★ 门禁⑨：catch 内只 logger.warn，绝不弹 UI、绝不冒泡
 * ★ 门禁⑩：额度计数只在内存，绝不碰任何持久化存储
 * ★ 门禁⑦：本文件不在 src/services/track 目录内，且埋点只走枚举，不带文本
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { currentConfig } from '@bootstrap/bootSequence'
import { isLlmCircuitBlown, recordLlmCost, trackApiCall } from '@services/track'
import { isEmpathySafe } from '@core/empathy/empathy'
import { buildEmpathyPayload, serializeEmpathyPayload } from '@core/empathy/payload'
import type { CloudConsent } from '@core/empathy/consent'
import type { MoodTone } from '@core/reading'

/**
 * 出网基址。★ 真机 / 生产必须用 VITE_API_BASE 给绝对地址 ——
 * Capacitor 里相对路径会打到 capacitor://localhost，命中不了自家后端。
 * Web 开发留空即可，由 Vite dev 代理转发（见 vite.config.ts 的 server.proxy）。
 */
const API_BASE = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 对话网关：路径里**不含任何密钥**（Key 只在服务端 .env 里） */
const CHAT_ENDPOINT = `${API_BASE}/api/chat`

/** 与解读同尺子：超时即回落本地，不让用户干等 */
const CHAT_TIMEOUT_MS = 6000

export interface EmpathyCloudOptions {
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
// 每用户日额度（内存软计数；独立于解读额度，各自算各自的）
// ───────────────────────────────────────────────────────────────────────────

let quotaDay = ''
let quotaUsed = 0

function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

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
 * 云端共情此刻是否可用（闸门②③④；**不含** consent —— 那是调用方按用户显隐决定的第一道）。
 */
export function isEmpathyCloudEnabled(now = Date.now()): boolean {
  const cfg = currentConfig()
  if (!cfg.features.empathyCloud.enabled) return false
  if (cfg.killSwitch.disableLlm) return false
  if (isLlmCircuitBlown()) return false
  return quotaAllows(now)
}

// ───────────────────────────────────────────────────────────────────────────
// 响应解析（任何一点不合格都当"云端不可用"，回落本地）
// ───────────────────────────────────────────────────────────────────────────

export interface ParsedCloudEmpathy {
  reply: string
  /** 本次花费（分）；0 = 后端没给 */
  cents: number
}

/**
 * 解析云端回应。
 * ★ 与本地同一把尺子：过 `isEmpathySafe`（非空 / ≤34 字 / 无禁词）才接受。
 *   云端文案是**面向用户**的，这条线不能只靠服务端自觉 —— 客户端再守一道。
 */
export function parseCloudEmpathy(raw: unknown): ParsedCloudEmpathy | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const reply = typeof r.reply === 'string' ? r.reply.trim() : ''
  if (!isEmpathySafe(reply)) return null
  const cents = typeof r.cents === 'number' && r.cents > 0 ? r.cents : 0
  return { reply, cents }
}

// ───────────────────────────────────────────────────────────────────────────
// 唯一出口
// ───────────────────────────────────────────────────────────────────────────

/**
 * 向云端要一句共情回应。
 *
 * @returns 云端回应；`null` = 用本地回应（含以下全部情形：未同意 / 开关关闭 /
 *          停用 / 熔断 / 额度用尽 / 无 fetch / 空文本 / 超时 / 非 2xx /
 *          非法 JSON / 命中禁词）。**调用方只需 `cloud ?? localReply`。**
 */
export async function requestCloudEmpathy(
  input: { text: string; mood?: MoodTone | null; turns: number; consent: CloudConsent },
  opts: EmpathyCloudOptions = {},
): Promise<string | null> {
  // ① 同意闸门：没点过「好」⇒ 一个字节都不出端（隐私关键断言由单测钉住）
  if (input.consent !== 'on') return null

  // ② 配置 / 停用 / 熔断 / 日额度
  const nowFn = opts.now ?? Date.now
  if (!isEmpathyCloudEnabled(nowFn())) return null

  // ③ 传输可用性
  const doFetch = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!doFetch) return null

  // ④ 空文本没有必要出端（纯空白也算空）
  if (!String(input.text ?? '').trim()) return null
  const payload = buildEmpathyPayload({ text: input.text, mood: input.mood, turns: input.turns })

  const url = opts.url ?? CHAT_ENDPOINT
  const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS
  // ★ 出端载荷逐字段构造（text / mood / turns），不含任何旁路字段
  const body = serializeEmpathyPayload(payload)

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

    const parsed = parseCloudEmpathy(raw)
    if (!parsed) return null

    // 成功才算一次额度 + 打点 + 记成本（失败不占额度，用户下次仍可试）
    quotaUsed += 1
    trackApiCall('EMPATHY')
    if (parsed.cents > 0) recordLlmCost(parsed.cents)
    return parsed.reply
  } catch (e) {
    // ★ 门禁⑨：超时 / 断网 / 任何异常都静默回落本地，绝不弹 UI、绝不冒泡
    logger.warn('[empathy] cloud chat unavailable, fall back to local', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：清空额度计数（跨用例隔离） */
export function __test_resetEmpathyCloud(): void {
  quotaDay = ''
  quotaUsed = 0
}
