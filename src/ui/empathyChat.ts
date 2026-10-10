/**
 * 小卜 · 共情对话编排   src/ui/empathyChat.ts
 * ===========================================================================
 * 把「一次对话」串起来的那根线。沿用 `src/ui/paperSound.ts` / `introFlip.ts`
 * 的范式：ui 下的纯 TS 模块，不写模板，只做编排。
 *
 * ── 一次「低语」的完整时序（先本地、再云端、失败不回落也不打断）────────────
 *   ① 用户发送
 *   ② **同帧**渲染本地回应（零延迟、断网可用、永远有话说）
 *   ③ 若「同意 + 云端可用（开关/停用/熔断/额度）」⇒ 后台请求云端
 *   ④ 回来时用 `seq` 守卫：只在"还是这一轮对话"时静默替换，避免跨轮串话
 *
 * ── 三条边界 ────────────────────────────────────────────────────────────────
 *   · 不做聊天记录流：store.latest 永远只有"最近一句"（后到替换先到）
 *   · 埋点只记枚举（EMPATHY_*），永不含文本（门禁⑦）
 *   · catch 内只 logger.warn（门禁⑨）
 * ===========================================================================
 */
import { useXiaobuFormStore } from '@store/xiaobuForm'
import { getEngine } from '@store/engineHost'
import { replyLocally, isEmpathySafe } from '@core/empathy/empathy'
import { requestCloudEmpathy, isEmpathyCloudEnabled } from '@services/empathyCloud'
import { trackFunnel } from '@services/track'
import { logger } from '@shared/logger'

/** 本会话第几轮（只为让本地选句随轮次变化，不含任何内容） */
let turnCount = 0
/** 会话序号：每一次"拥有回应的那一轮"自增一次，用于丢弃过期云端的回应 */
let sessionSeq = 0

/** 打开对话面板时调：重置轮次、种一句开场、同步同意镜像 */
export function openEmpathy(): void {
  const store = useXiaobuFormStore()
  turnCount = 0
  sessionSeq++ // 作废上一会话尚未回来的云端请求
  syncConsent(store)

  // 开场白：没有上一句话时，小卜先说一句（从本地句池取，确定性）
  if (!store.latest.reply) {
    const seed = replyLocally({ text: '', mood: null, turn: 0 })
    store.setReply('', seed.text)
  }
  trackFunnel('EMPATHY_OPEN')
}

/**
 * 关闭对话面板时调：作废在途的云端请求、清轮次。
 * ★ 自增 seq 后，任何"迟到"的云端回应都会在会话守卫处被丢弃 ——
 *   不会写进已收起的面板，重开时也不会看到上一会话的回复（防跨会话串话）。
 */
export function closeEmpathy(): void {
  turnCount = 0
  sessionSeq++
}

/**
 * 用户发一句。★ 永不抛、永远先给出回应（本地那句一定在）。
 */
export async function sendEmpathy(text: string): Promise<void> {
  const store = useXiaobuFormStore()
  const mine = String(text ?? '').trim()
  if (!mine) return

  const turn = turnCount++
  // ② 先本地：同帧渲染，零延迟。这条路径永远成立，与网络无关。
  const local = replyLocally({ text: mine, mood: null, turn })
  store.setReply(mine, local.text)
  store.setDraft('')
  trackFunnel('EMPATHY_SEND')

  // ③ 云端是可选增强：未同意 / 开关关闭 / 停用 / 熔断 / 额度用尽时到此为止
  //    ★ 这里一并看 isEmpathyCloudEnabled()：闸门不过时连 typing 都不显示，观感上"就像本地的"
  if (store.cloudConsent !== 'on' || !isEmpathyCloudEnabled()) {
    trackFunnel('EMPATHY_REPLY_LOCAL')
    return
  }

  const seq = ++sessionSeq
  store.setTyping(true)
  let cloud: string | null = null
  try {
    cloud = await requestCloudEmpathy({ text: mine, mood: null, turns: turn, consent: 'on' })
  } finally {
    store.setTyping(false)
  }

  // ④ 会话守卫：期间用户又发了一句 / 重开了面板 ⇒ 丢弃这次过期回应
  if (seq !== sessionSeq) return

  if (cloud && isEmpathySafe(cloud)) {
    store.setReply(mine, cloud)
    trackFunnel('EMPATHY_REPLY_CLOUD')
  } else {
    trackFunnel('EMPATHY_REPLY_LOCAL')
  }
}

/**
 * 用户在同意行里做选择。
 * ★ 只有 'on' 时才把原话交给云端；'off'（先这样）保持本地为底。
 */
export function setConsent(choice: 'off' | 'on'): void {
  const store = useXiaobuFormStore()
  const c = choice === 'on' ? 'on' : 'off'
  store.setConsent(c)
  try {
    // 真源在引擎持久化里；写失败也只 warn —— 本轮内存镜像已生效
    getEngine().setEmpathyConsent(c)
  } catch (e) {
    logger.warn('[empathy] 保存云端同意失败（本轮内存态仍生效）', e)
  }
  if (c === 'on') trackFunnel('EMPATHY_CONSENT_ON')
}

/** 从引擎持久化同步同意镜像到 store（打开面板时调一次） */
function syncConsent(store: ReturnType<typeof useXiaobuFormStore>): void {
  try {
    store.setConsent(getEngine().getEmpathyConsent())
  } catch (e) {
    logger.warn('[empathy] 读取云端同意失败（按默认 off 处理）', e)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 测试辅助（仅测试用，不影响产品路径）
// ───────────────────────────────────────────────────────────────────────────

/** 测试：重置会话/轮次计数（跨用例隔离） */
export function __test_resetEmpathyChat(): void {
  turnCount = 0
  sessionSeq = 0
}
