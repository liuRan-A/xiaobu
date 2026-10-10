/**
 * 小卜 · 启动时序   src/bootstrap/bootSequence.ts
 * ---------------------------------------------------------------------------
 * 这是整份工程最不能出错的一段代码。它的形状由三条时序锁定：
 *
 *   t = 0 ms     mountApp() —— 用内置配置**同步**渲染第一帧（暖黄黄昏小屋）
 *   t = 0 + ε    同步读缓存配置，命中就静默换挡（< 30 ms，用户无感）
 *   t = 0 + 异步  void 拉远端配置 —— 不 await、不阻塞首帧、失败静默
 *
 * ★ 铁律一：本函数必须是同步的。首帧路径上不许出现任何 await。
 * ★ 铁律二：拉取失败走四层兜底（有缓存 → 字段非法只丢该字段 → 无缓存 → schemaVersion 越界整份丢），
 *           终态永远是"能玩的黄昏小屋"，绝不白屏、绝不卡死。
 * ★ 铁律三：失败**不重试**。配置晚 10 分钟到没有任何损失，
 *           为它起重试循环只会把弱网耗电带进来。
 *
 * 【防崩门禁】⑨ catch 块禁止出 UI ／ ⑩ 禁止使用 LocalStorage 持久化上报队列
 *   —— 本文件内的 catch 同样只记日志，不弹任何提示。
 * ---------------------------------------------------------------------------
 */
import { BUILT_IN_CONFIG, validateConfig, type XiaobuConfig } from './builtinConfig'
import { loadRemoteConfig } from './remoteConfig'
import { logger } from '@shared/logger'

/** 当前生效的配置（进程内唯一）。UI 侧通过订阅拿它的投影。 */
let activeConfig: XiaobuConfig = BUILT_IN_CONFIG as XiaobuConfig

const listeners = new Set<(c: XiaobuConfig) => void>()

/** 读当前配置 —— 只读，别改它；要改配置只能走 applyConfig() */
export function currentConfig(): Readonly<XiaobuConfig> {
  return activeConfig
}

/** 订阅配置换挡（UI / Scene 用它在配置到位后静默刷新表现层） */
export function onConfigChanged(fn: (c: XiaobuConfig) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 唯一的配置写入点。
 * ★ 只更新可热切换项（天气开关 / 额度 / 埋点参数），**不重挂场景、不打断动画**。
 */
export function applyConfig(next: XiaobuConfig): void {
  activeConfig = next
  for (const fn of listeners) {
    try {
      fn(next)
    } catch (e) {
      // ★ 门禁 ⑨：catch 内不许出 UI。某个订阅者出错，不能影响其他订阅者。
      logger.warn('[bootstrap] config listener failed', e)
    }
  }
}

// ── 缓存读写（M1 用内存镜像占位；D9 换成 @capacitor/preferences 的同步预载镜像） ──
// ★ 门禁 ⑩ 的关注点是"**上报**队列不许持久化"，配置缓存本身是可以落盘的 —— 两者别混。

let cacheMirror: XiaobuConfig | null = null

function readConfigCacheSync(): XiaobuConfig | null {
  return cacheMirror
}

/** 由 D9 的 remoteConfig.ts 在拿到合法配置后调用 */
export function writeConfigCache(c: XiaobuConfig): void {
  cacheMirror = c
}

/**
 * 启动序列 —— 同步返回，副作用在函数内自行发起。
 * @returns 首帧应该使用的配置（永远非空）
 */
export function bootSequence(): Readonly<XiaobuConfig> {
  // ① t = 0：先把内置配置落到生效位。首帧立刻能画，不等任何人。
  applyConfig(BUILT_IN_CONFIG as XiaobuConfig)

  // ② 同步读缓存（陈旧也先用），命中就换挡。这一步是同步的，耗时 < 1ms。
  try {
    const cached = readConfigCacheSync()
    if (cached) {
      const valid = validateConfig(cached)
      if (valid) applyConfig(valid)
      else logger.warn('[bootstrap] cached config invalid, fallback to builtin')
    }
  } catch (e) {
    // ★ 门禁 ⑨：catch 内不许出 UI —— 缓存坏了不是用户的问题，静默用内置配置
    logger.warn('[bootstrap] read cache failed', e)
  }

  // ③ 异步拉远端：void 调用，不 await。M1 阶段先用本地占位，D9 换成 GET /api/config。
  void bootstrapRemoteConfig()

  return activeConfig
}

/**
 * 异步拉取远端配置。
 * M1 只写"失败路径"的骨架 —— 因为它才是要守住的那条路。
 */
async function bootstrapRemoteConfig(): Promise<void> {
  // 急停开关优先级最高：服务端一键关掉远端配置能力，客户端连请求都不发
  if (activeConfig.killSwitch.forceSpringOnly) return

  try {
    // D9：冷启动拉远端配置。loadRemoteConfig 内部自带四层兜底与门禁⑨静默降级，
    // 这里不再额外 try/catch 也能守住；外层 catch 仅为防御性兜底，不弹 UI。
    await loadRemoteConfig()
  } catch (e) {
    // ★ 四层兜底的落点：有缓存用缓存（上面已应用）→ 字段非法只丢该字段 →
    //   无缓存用 BUILT_IN_CONFIG（当前生效值）→ schemaVersion 越界整份丢弃。
    // ★ 门禁 ⑨：只记一条 warn，**不 throw、不弹提示、不显示"配置获取失败"**
    logger.warn('[bootstrap] remote config degraded, keep current', e)
  }
}
