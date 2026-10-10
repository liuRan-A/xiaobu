/**
 * 小卜 · 语音听写云端客户端   src/services/asr.ts
 * ===========================================================================
 * 「按住说话」的云端那半条腿。★ 与 `llm.ts`（解读）/ `empathyCloud.ts`（共情）
 * 是**第三条独立链路**：
 *   · 端点不同：这里是 `/api/asr`，解读是 `/api/reading`，共情是 `/api/chat`
 *   · 出端物不同：这里出的是**录音音频**（在用户显式同意下），另两条出的是枚举 / 原话
 *   · 默认状态不同：这里默认**关闭**（config.features.voiceInput.enabled 可关；
 *     且仍需用户对**音频**单独点头 —— 见 core/voice/consent.ts）
 *
 * ── 四道闸门（任一不过 ⇒ 连请求都不发，直接回落"没听清"）────────────────────
 *   ① consent === 'on'                    用户对音频出端的显式同意（可随时改回 off）
 *   ② features.voiceInput.enabled         配置总开关
 *   ③ killSwitch.disableLlm / 成本熔断    服务端一键停用 + 当日花超自动熔断
 *   ④ 每用户日额度（本地软计数，独立于解读/共情，真实额度由服务端兜底）
 *
 * ── 唯一出口永不变 ──────────────────────────────────────────────────────────
 *   `requestSpeechText()` **永不抛**：返回 string = 识别出的那句话；
 *   返回 null = 没听清（调用方的默认分支，也是绝大多数失败情形）。
 *
 * ★ 门禁⑧：本文件**不得**出现任何密钥字段名（Key 只在服务端 .env 里）。
 * ★ 门禁⑨：catch 内只 logger.warn，绝不弹 UI、绝不冒泡。
 * ★ 门禁⑩ / ⑬：额度计数只在内存，绝不碰任何持久化存储。
 * ===========================================================================
 */

import { logger } from '@shared/logger'
import { currentConfig } from '@bootstrap/bootSequence'
import { isLlmCircuitBlown, recordLlmCost, trackApiCall } from '@services/track'
import { buildVoicePayload, serializeVoicePayload } from '@core/voice/payload'
import { isVoiceTextUsable, normalizeVoiceText } from '@core/voice/voice'

/**
 * 出网基址。★ 真机 / 生产必须用 VITE_API_BASE 给绝对地址 ——
 * Capacitor 里相对路径会打到 capacitor://localhost，命中不了自家后端。
 * Web 开发留空即可，由 Vite dev 代理转发（见 vite.config.ts 的 server.proxy）。
 */
const API_BASE = String(import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 听写网关：路径里**不含任何密钥**（讯飞 Key 只在服务端 .env 里） */
const ASR_ENDPOINT = `${API_BASE}/api/asr`

/** 听写要比解读多一些余量（音频上传 + 服务端转写），但仍不让用户干等 */
const ASR_TIMEOUT_MS = 8000

export interface AsrOptions {
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
// 每用户日额度（内存软计数；独立于解读 / 共情的额度，各自算各自的）
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
 * 云端听写此刻是否可用（闸门②③④；**不含** consent —— 那是调用方按用户显隐决定的第一道）。
 */
export function isAsrEnabled(now = Date.now()): boolean {
  const cfg = currentConfig()
  if (!cfg.features.voiceInput.enabled) return false
  if (cfg.killSwitch.disableLlm) return false
  if (isLlmCircuitBlown()) return false
  return quotaAllows(now)
}

// ───────────────────────────────────────────────────────────────────────────
// 响应解析（任何一点不合格都当"没听清"，回落 null）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 解析听写响应。
 * ★ 只有 `text` 非空（归一化后）才接受 —— 空串表示服务端也没听清。
 */
export function parseAsr(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const text = normalizeVoiceText(r.text)
  return isVoiceTextUsable(text) ? text : null
}

/** 从响应里安全取出本次花费（分）；非数值一律 0 —— 避免 `any` 断言 */
function centsOf(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0
  const c = (raw as Record<string, unknown>).cents
  return typeof c === 'number' && c > 0 ? c : 0
}

// ───────────────────────────────────────────────────────────────────────────
// 唯一出口
// ───────────────────────────────────────────────────────────────────────────

/**
 * 向云端要一句听写结果。
 *
 * @returns 识别出的那句话（已归一化）；`null` = 没听清（含以下全部情形：
 *          开关关闭 / 停用 / 熔断 / 额度用尽 / 无 fetch / 空音频 / 超时 /
 *          非 2xx / 非法 JSON / 文本为空）。**调用方只需 `text ?? 提示再试一次`。**
 *   ★ 注意：consent 闸门不在本函数内 —— 它是**调用方**的第一道（见 ui/voiceInput.ts），
 *     因为"没同意"时连录制都不该开始，而录制在调用方那边。
 */
export async function requestSpeechText(
  input: { audio: string; format: string; durationMs: number },
  opts: AsrOptions = {},
): Promise<string | null> {
  const nowFn = opts.now ?? Date.now

  // ① 闸门②③④
  if (!isAsrEnabled(nowFn())) return null

  // ② 传输可用性
  const doFetch = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null)
  if (!doFetch) return null

  // ③ 空音频没有必要出端
  if (!String(input.audio ?? '').trim()) return null
  const payload = buildVoicePayload(input)

  const url = opts.url ?? ASR_ENDPOINT
  const timeoutMs = opts.timeoutMs ?? ASR_TIMEOUT_MS
  // ★ 出端载荷逐字段构造（audio / format / durationMs），不含任何旁路字段
  const body = serializeVoicePayload(payload)

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

    const text = parseAsr(raw)
    if (!text) return null

    // 成功才算一次额度 + 打点 + 记成本（失败不占额度，用户下次仍可试）
    quotaUsed += 1
    trackApiCall('ASR')
    const cents = centsOf(raw)
    if (cents > 0) recordLlmCost(cents)
    return text
  } catch (e) {
    // ★ 门禁⑨：超时 / 断网 / 任何异常都静默回落"没听清"，绝不弹 UI、绝不冒泡
    logger.warn('[asr] cloud speech unavailable, fall back to manual', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：清空额度计数（跨用例隔离） */
export function __test_resetAsr(): void {
  quotaDay = ''
  quotaUsed = 0
}
