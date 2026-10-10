/**
 * 小卜 · 设备端本地存储   src/store/localStore.ts
 * ===========================================================================
 * 这是 `core/persist.ts` 里 `LocalPort` 的**真实现**。
 *
 * ★ 全仓唯一允许出现 `localStorage` 的文件 —— 由 `ci/gates/13-no-idb.mjs` 守着。
 *   这么做的理由：`localStorage` 是 WebView 里最容易被随手滥用的东西
 *   （同步、阻塞主线程、Android 上是整文件重写），
 *   把它关进一个文件里，就没人能在渲染循环里顺手写它了。
 *
 * ── 「禁用高并发 LocalStorage 与 IndexedDB」的两半落法 ──────────────────────
 *   · **禁 IndexedDB**：全仓一个字面量都不许有（门禁⑬ grep `indexedDB` / `idb`）。
 *     我们不需要它：数据量以"几十条记忆 + 十几个倒计时"计，键值库足够。
 *   · **禁高并发写**：真正的防线不在这里，在 `core/persist.ts` 的写预算
 *     （合并窗口 + 每分钟上限 + 单键上限）。这个文件只负责"一次写一个键"。
 *
 * ── 为什么原生端走 Capacitor Preferences 而不是 localStorage ──────────────
 *   Capacitor 的 WebView `localStorage` 在 Android 上位于 app 的 WebView 数据目录里，
 *   系统清理存储、WebView 数据被回收时**可能一起没掉**。
 *   `@capacitor/preferences` 原生端落在 `SharedPreferences` / `UserDefaults`，
 *   稳定性明显更好 —— 而记忆锚点是不能丢的（它不是缓存，是用户的东西）。
 *
 * ★ 三条实现纪律（对应 LocalPort 的契约）
 *   ① 任何方法都**永不抛异常**，读失败返回 {}，写失败静默吞掉
 *   ② 不做 JSON 解析的"修复"：解析失败的键当不存在，不猜
 *   ③ 不写任何日志到用户可见处（只有 logger.warn，且只在彻底不可用时一次）
 * ===========================================================================
 */

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { logger } from '@shared/logger'
import type { LocalPort } from '@core/persist'

/** 原生端 = Preferences；Web 端 = localStorage。判定只在建端口时做一次。 */
function isNative(): boolean {
  try {
    return typeof Capacitor?.isNativePlatform === 'function' && Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** 原生端实现（Preferences 是异步的，正好符合 LocalPort 的签名） */
function nativePort(): LocalPort {
  return {
    async loadAll() {
      try {
        const { keys } = await Preferences.keys()
        const out: Record<string, unknown> = {}
        for (const key of keys ?? []) {
          const { value } = await Preferences.get({ key })
          if (value == null) continue
          try {
            out[key] = JSON.parse(value)
          } catch {
            // ③ 不猜：解析不出来就当这个键不存在
          }
        }
        return out
      } catch (e) {
        logger.warn('[store] Preferences.keys 失败，按全新用户处理', e)
        return {}
      }
    },
    async save(key, value) {
      try {
        await Preferences.set({ key, value })
      } catch (e) {
        // ① 静默吞掉：写不进去不是用户需要知道的事
        logger.warn(`[store] Preferences.set(${key}) 失败（已丢弃）`, e)
      }
    },
    async remove(key) {
      try {
        await Preferences.remove({ key })
      } catch (e) {
        logger.warn(`[store] Preferences.remove(${key}) 失败（已丢弃）`, e)
      }
    },
  }
}

/** Web 端实现。★ 只有这个文件能用 localStorage */
function webPort(): LocalPort {
  const ls = (): Storage | null => {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null
    } catch {
      // 隐私模式 / 被策略禁用时访问 localStorage 会抛
      return null
    }
  }

  return {
    async loadAll() {
      const s = ls()
      if (!s) return {}
      const out: Record<string, unknown> = {}
      try {
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i)
          if (!key) continue
          const raw = s.getItem(key)
          if (raw == null) continue
          try {
            out[key] = JSON.parse(raw)
          } catch {
            /* ③ 不猜 */
          }
        }
      } catch (e) {
        logger.warn('[store] localStorage 读取失败，按全新用户处理', e)
      }
      return out
    },
    async save(key, value) {
      const s = ls()
      if (!s) return
      try {
        s.setItem(key, value)
      } catch (e) {
        // ① 配额满 / 被禁用 —— 静默丢弃。写预算已经把它压到很低频，
        //    真到这一步说明情况异常，但绝不是用户的错。
        logger.warn(`[store] localStorage.setItem(${key}) 失败（已丢弃）`, e)
      }
    },
    async remove(key) {
      const s = ls()
      if (!s) return
      try {
        s.removeItem(key)
      } catch (e) {
        logger.warn(`[store] localStorage.removeItem(${key}) 失败（已丢弃）`, e)
      }
    },
  }
}

/**
 * 建一个设备端存储端口。
 * ★ 这个函数本身也不抛 —— 最坏情况退到 `core/persist.ts` 的 `createMemoryPort()`，
 *   也就是"本次运行不落盘"。用户照常能占卜，只是下次开机东西不在。
 */
export function createDevicePort(): LocalPort {
  try {
    return isNative() ? nativePort() : webPort()
  } catch (e) {
    logger.warn('[store] 建立存储端口失败（本次运行不落盘）', e)
    return {
      async loadAll() {
        return {}
      },
      async save() {},
      async remove() {},
    }
  }
}
