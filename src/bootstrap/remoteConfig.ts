/**
 * 小卜 · 远端配置拉取   src/bootstrap/remoteConfig.ts
 * ---------------------------------------------------------------------------
 * D9 落点：App 冷启动时从自家后端代理拉取 /api/config。
 *
 * ★ 三条铁律（与 bootSequence 同步）：
 *   ① 失败**不重试** —— 配置晚 10 分钟到没有任何损失，起重试循环只会把弱网耗电带进来。
 *   ② 任何一步失败都**静默降级**到当前生效配置（门禁⑨：不抛、不弹 UI）。
 *   ③ 四层兜底：有缓存 → 字段非法只丢该字段 → 无缓存用内置 → schemaVersion 越界整份丢。
 *
 * ★ 端点只暴露公开开关与额度（天气开关 / 开发者白名单 / 云端四季 CDN / 每日 AI 额度上限），
 *   不携带任何密钥（密钥在服务端代理里）。这与 config.json 的红线条一致。
 * ---------------------------------------------------------------------------
 */
import { logger } from '@shared/logger'
import { validateConfig, type XiaobuConfig } from './builtinConfig'
import { applyConfig, writeConfigCache } from './bootSequence'

/** 远端配置端点：自家后端代理，路径里不含任何密钥（密钥在服务端） */
const REMOTE_CONFIG_URL = '/api/config'

/** 拉取超时（ms）。弱网下等太久只会耗电，没有收益 */
const FETCH_TIMEOUT_MS = 3000

/** 拉取失败的统一错误类型（仅用于内部区分，对外仍静默） */
export class RemoteConfigError extends Error {}

/**
 * 拉取远端配置（带超时）。
 * ★ 只在「成功且通过结构校验」时返回 XiaobuConfig；任何一点不合格都 throw，
 *   交给 `loadRemoteConfig` 走四层兜底静默降级。
 *
 * @param opts.fetchImpl 注入用（测试 / SSR 环境）
 * @param opts.url       端点覆盖（测试用）
 * @param opts.timeoutMs 超时覆盖（测试用）
 */
export async function fetchRemoteConfig(
  opts: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<XiaobuConfig> {
  const url = opts.url ?? REMOTE_CONFIG_URL
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const doFetch = opts.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // 远端配置非核心路径，不强制缓存（避免拿到过期的 killSwitch）
      cache: 'no-store',
    })
  } catch (e) {
    clearTimeout(timer)
    throw new RemoteConfigError(`fetch failed: ${String(e)}`)
  }
  clearTimeout(timer)

  if (!res.ok) {
    throw new RemoteConfigError(`bad status ${res.status}`)
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    throw new RemoteConfigError(`bad json: ${String(e)}`)
  }

  const valid = validateConfig(raw)
  if (!valid) {
    throw new RemoteConfigError('remote config failed schema validation')
  }
  return valid
}

/**
 * 拉取 + 应用 + 写缓存。★ 任何一步失败都静默降级到当前生效配置（门禁⑨），绝不抛。
 *
 * 成功路径：
 *   · `applyConfig(valid)` —— 热切换天气 / 额度 / 埋点参数，不打断动画、不重挂场景
 *   · `writeConfigCache(valid)` —— 落缓存镜像，供下次首帧同步换挡（bootSequence 第②步）
 */
export async function loadRemoteConfig(
  opts: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  try {
    const valid = await fetchRemoteConfig(opts)
    if (!valid) return
    applyConfig(valid)
    writeConfigCache(valid)
  } catch (e) {
    // ★ 四层兜底的落点 + 门禁⑨：只记一条 warn，不弹、不 throw
    //   此时 bootSequence 已应用过内置/缓存配置，用户看到的仍是能玩的黄昏小屋。
    logger.warn('[remote-config] degraded, keep current effective config', e)
  }
}
