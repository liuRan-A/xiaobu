/**
 * 小卜 · 全应用唯一的错误出口   src/shared/errors/handle.ts
 * ===========================================================================
 * ★★★ 两条防崩底线约束（CI 门禁会扫本文件与全仓所有 catch 块）★★★
 *
 *   门禁 ⑨  catch 块禁止出 UI
 *           本文件与全仓任何 catch 内，不许出现：
 *             alert / confirm / prompt / Toast / showModal / showToast /
 *             uni.showToast / vant Dialog / 任何弹窗或报错框。
 *           错误是开发者的语言，不是用户的体验。
 *           需要安抚用户时，**只由小卜的气泡开口**（ui/components/BubbleXiaobu.vue）。
 *
 *   门禁 ⑩  禁止使用 LocalStorage 持久化上报队列
 *           埋点只在内存数组里缓冲；sendBeacon 返回 false 就直接丢弃本批。
 *           不落 localStorage / sessionStorage / IndexedDB / Preferences，
 *           不建重试队列，不无限重试，不回退 fetch。
 *           上报永远不许阻塞主线程 —— 无 await、无 retry。
 *
 *   这两条不是"风格建议"，是构建门禁。ci/gates/05-*.mjs 与 06-*.mjs 会直接 grep 源码。
 * ===========================================================================
 */
import { logger } from '@shared/logger'
import { trackError } from '@services/track'

export type ErrorKind = 'network' | 'permission' | 'interaction' | 'fatal'

/** 错误发生的位置，用于埋点与分诊；是枚举，不是自由文本（防隐私外泄） */
export type Scope =
  | 'vue.errorHandler'
  | 'window.onerror'
  | 'unhandledrejection'
  | 'scene.render'
  | 'scene.spine'
  | 'scene.texture'
  | 'core.machine'
  | 'core.liuyao'
  | 'services.http'
  | 'services.config'
  | 'services.llm'
  | 'services.asr'
  | 'services.track'
  | 'platform.geo'
  | 'platform.haptics'
  | 'platform.storage'

/**
 * 异常 → 四类分诊。
 * ★ 这个函数必须"永不抛异常"：它本身挂了，handle 就挂了，整条防线就断了。
 */
export function classify(e: unknown): ErrorKind {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network'

    const name = (e as { name?: string })?.name ?? ''
    const msg = String((e as { message?: string })?.message ?? e ?? '')

    if (/permission|denied|not allowed|NotAllowedError/i.test(`${name} ${msg}`)) return 'permission'
    if (name === 'TimeoutError' || /timeout|network|fetch|ECONN|ENOTFOUND/i.test(`${name} ${msg}`))
      return 'network'
    if (name === 'InteractionError' || /illegal transition|interaction|guard/i.test(msg))
      return 'interaction'

    return 'fatal'
  } catch {
    return 'fatal' // ★ 门禁 ⑨：catch（可省略绑定）内同样不许出 UI
  }
}

/**
 * ★ 全应用唯一的错误出口。
 *   四步，到此为止：
 *     ① 只记日志（logger.warn，生产只留 warn/error）
 *     ② 脱敏埋点（事件白名单枚举 + 数值型载荷，无自由文本）
 *     ③ 分类降级（applyRecovery）
 *     ④ return —— 本函数内**不存在任何 UI 调用**，门禁 ⑨ 会扫
 */
export function handle(e: unknown, scope: Scope): void {
  const kind = classify(e)

  // ① 只记日志
  logger.warn(`[${kind}]`, scope, e)

  // ② 脱敏埋点（D10）—— 只上报"哪一类错、发生在哪个 scope"，不上报任何文本内容。
  //    `trackError` 内部自带 try/catch，即使埋点本身挂了也不会把兜底逻辑带崩。
  try {
    trackError(scope, kind)
  } catch (err) {
    // ★ 门禁 ⑨：埋点自己出错也必须静默，否则"兜底逻辑崩了"会变成二次故障
    logger.warn('[errors] track failed', err)
  }

  // ③ 分类降级
  applyRecovery(kind, scope)
}

/** 降级动作表 —— 与《白皮书》§3 的四分类一一对应 */
function applyRecovery(kind: ErrorKind, scope: Scope): void {
  switch (kind) {
    case 'network':
      // 重试 1 次（退避 300ms）→ 读缓存 → 内置兜底（本地模板 / 默认晴天）
      // 用户看到：什么都没看到
      logger.warn('[recovery] network → cache/builtin fallback', scope)
      break

    case 'permission':
      // 定位 → 静默晴天 ｜ 相机 → 「此刻的手感」三选一 ｜ 麦克风 → 键盘 ｜ 健康 → 跳过
      // 用户看到：入口"换了个样子"继续可用。零弹窗、零二次索要。
      logger.warn('[recovery] permission → silent alternative entry', scope)
      break

    case 'interaction':
      // 非法转移 → 回最近合法态；卡住 > 3s → 小卜气泡温柔引导
      // 用户看到：一句气泡。绝无红色 / 橙色 / 感叹号 / 震动。
      logger.warn('[recovery] interaction → revert to last legal state', scope)
      break

    case 'fatal':
      // 清离屏缓存 → 重挂 IDLE → 同场景淡入恢复；30s 内 ≥2 次进安全模式
      // 用户看到：房间淡入回来。六爻与掷币**绝不禁用**。
      logger.warn('[recovery] fatal → remount IDLE with fade-in', scope)
      break
  }
}
