/**
 * 小卜 · 监控埋点   src/services/track/index.ts
 * ===========================================================================
 * 这是 §Q·⑦「禁监控载荷含隐私字段」与门禁⑩「禁止持久化上报队列」的落点。
 *
 * ── 四条铁律（门禁⑩ 会直接 grep 本目录）──────────────────────────────────────
 *   ① **内存缓冲**：埋点只在 `pending` 数组里攒着，sendBeacon 返回 false 直接丢整批。
 *      本目录内**禁止**任何落盘式存储（瞬时存储 / 本地数据库 / 偏好存储均不可）。
 *   ② **不阻塞线程、不挂定时器、不做补偿**：上报是 fire-and-forget，
 *      周期 flush 由 `src/store/engineHost.ts` 在外面用定时器驱动（本目录不碰定时器）。
 *   ③ **失败即丢**：不建补偿队列、不另起请求兜底。一旦 sendBeacon 失败，本批丢弃。
 *   ④ **载荷只有枚举与数值**：绝不出现任何自由文本（对话 / 卦象 / 设备明文 ID）。
 *
 * ── 四类埋点（门禁⑦ 之外的产品诉求）────────────────────────────────────────
 *   · ERROR     崩溃率          —— 来自 @shared/errors/handle 的脱敏分诊
 *   · API_CALL  接口调用量       —— 远端配置 / 解卦网关等真实出网处
 *   · LLM_COST  大模型成本熔断   —— recordLlmCost 累计，超阈值触发 blown
 *   · FUNNEL    六爻 / 塔罗流失节点 —— 每个环节到达都打点，下一步没到即流失
 *
 * ★ 本模块**永不抛异常**：任何一步失败都只静默丢弃（try/catch），绝不冒泡到调用方
 *   （engine / handle 里调 track 也不该因此崩）。
 * ===========================================================================
 */
import { currentConfig } from '@bootstrap/bootSequence'

/** 上报端点：自家后端代理，路径里**不含任何密钥**（密钥在服务端） */
const TRACK_ENDPOINT = '/api/track'

/** 事件大类 */
export type TrackName = 'ERROR' | 'API_CALL' | 'LLM_COST' | 'FUNNEL'

/**
 * 六爻 / 塔罗完整环节的流失节点。
 * ★ 命名即语义：每个名字代表"用户走到了这一步"。后端拿同一会话的相邻两点，
 *   就能算出"在哪一个环节掉队了"——这是「流失节点」埋点的全部含义。
 */
export type FunnelName =
  | 'LIUYAO_ENTER'
  | 'LIUYAO_MOOD'
  | 'LIUYAO_FOCUS'
  | 'LIUYAO_PLACE'
  | 'LIUYAO_CAST'
  | 'LIUYAO_READING'
  | 'LIUYAO_MEMORY'
  | 'TAROT_ENTER'
  | 'TAROT_PICK'
  | 'TAROT_DRAW'
  | 'TAROT_READING'
  | 'TAROT_MEMORY'
  // 共情对话（本地为底 + 云端可选）。★ 只记"走到了哪一步"，永不记文本
  | 'EMPATHY_OPEN'
  | 'EMPATHY_SEND'
  | 'EMPATHY_REPLY_LOCAL'
  | 'EMPATHY_REPLY_CLOUD'
  | 'EMPATHY_CONSENT_ON'

/**
 * ★ 载荷形状即隐私边界：只有枚举与数值。
 *   任何会带出"用户在想什么 / 问了什么 / 设备在哪"的字段，都不允许出现在这里。
 */
export interface TrackEvent {
  name: TrackName
  /** 枚举字符串（来自 handle.ts 的 Scope），非自由文本 */
  scope?: string
  /** 错误分类（来自 handle.ts 的 ErrorKind），非自由文本 */
  kind?: string
  /** 流失节点 */
  node?: FunnelName
  ok?: 0 | 1
  /** 大模型成本（分） */
  cents?: number
  count?: number
  /** 成本熔断是否触发 */
  blown?: 0 | 1
}

// ───────────────────────────────────────────────────────────────────────────
// 内存缓冲（门禁⑩：绝不落盘）
// ───────────────────────────────────────────────────────────────────────────

/** 待上报批次。★ 唯一真源，不出现在任何持久化存储里 */
let pending: TrackEvent[] = []

/** 进程内累计的大模型当日成本（熔断用；非上报队列，只是运行期计数器） */
let llmCostToday = 0
/** 成本熔断是否已触发（一旦触发，网关应软禁用后续大模型调用） */
let circuitBlown = false

/** 可注入传输（测试用）；缺省走 sendBeacon */
type Transport = (events: readonly TrackEvent[]) => void
let transport: Transport | null = null

export function setTrackTransport(fn: Transport | null): void {
  transport = fn
}

/**
 * 把一批事件送出去。
 * ★ 门禁⑩ 要求：只走 sendBeacon，失败即丢，无回退 fetch。
 *   sendBeacon 是同步的、非阻塞的——它会在浏览器空闲时发，不会拖住主线程。
 */
function emit(events: readonly TrackEvent[]): void {
  if (events.length === 0) return
  if (transport) {
    try {
      transport(events)
    } catch {
      // ★ 门禁⑨：注入的传输器（测试/自定义）抛错也静默丢弃，绝不冒泡到调用方
    }
    return
  }
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return
  try {
    const blob = new Blob([JSON.stringify({ events })], { type: 'application/json' })
    navigator.sendBeacon(TRACK_ENDPOINT, blob)
  } catch {
    // ★ 门禁⑨：传输失败静默丢弃，不抛、不弹、不影响主流程
  }
}

/** 压入一条事件（含采样与批量阈值判断） */
function push(ev: TrackEvent): void {
  try {
    const cfg = currentConfig().monitor
    if (!cfg.trackEnabled) return
    // 采样：sampleRate < 1 时按概率丢弃（低配机/弱网省流量）
    if (cfg.sampleRate < 1 && Math.random() > cfg.sampleRate) return
    pending.push(ev)
    if (pending.length >= cfg.batchMaxCount) flushTrack()
  } catch {
    // ★ 门禁⑨：配置读不到也绝不能让 track 自己崩
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 对外埋点
// ───────────────────────────────────────────────────────────────────────────

/** 六爻 / 塔罗流失节点打点 */
export function trackFunnel(node: FunnelName): void {
  push({ name: 'FUNNEL', node })
}

/** 崩溃 / 异常分诊打点（脱敏：只有 kind + scope 枚举） */
export function trackError(scope: string, kind: string): void {
  push({ name: 'ERROR', scope, kind, ok: 0 })
}

/** 接口调用量打点（真实出网处调用，name 为接口枚举） */
export function trackApiCall(name: string): void {
  push({ name: 'API_CALL', scope: name, count: 1 })
}

/**
 * 大模型成本熔断计数。
 * ★ 每次拿到响应带上「花费（分）」调用一次；一旦累计超过
 *   `quota.llmGlobalDailyCircuit`，置熔断并上报 LLM_COST(blown=1)。
 *   网关应轮询 `isLlmCircuitBlown()`，为 true 时软禁用后续调用（与 killSwitch.disableLlm 同源）。
 */
export function recordLlmCost(cents: number): void {
  try {
    llmCostToday += cents
    const limit = currentConfig().quota.llmGlobalDailyCircuit
    if (!circuitBlown && limit > 0 && llmCostToday >= limit) {
      circuitBlown = true
      push({ name: 'LLM_COST', cents: llmCostToday, blown: 1 })
    }
  } catch {
    // ★ 门禁⑨：配置读不到也不能让计费逻辑把主流程带崩
  }
}

/** 当前是否处于成本熔断态（网关据此软禁用） */
export function isLlmCircuitBlown(): boolean {
  return circuitBlown
}

/**
 * 同步上报。★ 门禁⑩：本函数不阻塞、无定时补偿。
 *   由外部（engineHost 的定时器 / 切后台）按节奏调用。
 */
export function flushTrack(): void {
  if (pending.length === 0) return
  const batch = pending
  pending = []
  emit(batch)
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：清空缓冲与熔断态、重置注入传输 */
export function __test_resetTrack(): void {
  pending = []
  llmCostToday = 0
  circuitBlown = false
  transport = null
}

/** 测试：当前缓冲条数 */
export function __test_pendingCount(): number {
  return pending.length
}
