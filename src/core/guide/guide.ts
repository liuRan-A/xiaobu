/**
 * 小卜 · 私语式引导   src/core/guide/guide.ts
 * ===========================================================================
 * 战略原文（一、零门槛体验与微引导）：
 *   「**小卜的私语式引导**：绝对不弹说明书或生硬的文字教程。首次进入某区域时，
 *     小卜（AI）用气泡**逐步**引导操作（如：'点一下这叠牌，在心里默念你的问题'）。
 *     **只教操作，上手即淡出，绝不教算命**。」
 *   「**UI 呈现的极致温柔**：用情绪语言替代冰冷的菜单。」
 *   「选择玩法时，视觉设计成'翻开手账'或'小卜抽出锦囊'，**绝不使用系统默认的列表**。」
 *
 * ── 这份文件把"三句口号"变成了可执行约束 ───────────────────────────────────
 *   ① 「逐步」→ 一段引导是 `GuideStep[]`，每步 `waitFor` 一个具体动作。
 *      做完就跳到下一步；**全部做完即整段消失**，不留任何"已完成"痕迹。
 *   ② 「上手即淡出」→ 每个 step 的 `autoHideMs` 到点只是**淡出**。
 *      到点没做 ≠ 失败，没有红色、没有震动、没有"操作失败"。
 *      淡出后若用户还是不动，由 `ritual` 的温柔引导（20s）再接一次，不是这里循环催。
 *   ③ 「绝不教算命」→ `FORBIDDEN_COPY` + 单测把整张文案表扫一遍。
 *      文案里**不许出现任何解释牌意、卦意、吉凶、运势的词**。
 *      注意：`卦` / `爻` 这两个字是**允许**的 —— 它们是这个功能自己的名词
 *      （用户说的就是"掷一卦"），禁止的是**解释它们如何预示未来**。
 *
 * ── 还有一条更隐蔽的约束：面向用户的词表里不许出现玩法行话 ──────────────────
 *   内部 id 可以叫 `LIUYAO` / `TAROT`，但**用户看到的字里不许出现**"塔罗区""六爻区"
 *   —— 那是产品结构，不是用户的世界。分区名用「木桌竹案」「角落地毯」（见 roomZone）。
 *   由 `tests/copy-compliance.spec.ts` 一并断言。
 * ===========================================================================
 */

import { PERSIST_KEYS, type PersistedStore } from '@core/persist'
import type { ZoneId } from '@core/room/roomZone'
import type { Pt } from '@core/ritual/flight'

// ───────────────────────────────────────────────────────────────────────────
// 约束常量（先声明，再写文案 —— 免得写完了才发现放不下）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 气泡单行最多几个字。
 * ★ 取值依据：气泡最大宽度 300pt，正文 15pt，中文标点算全角
 *   ⇒ 一行约 19 字，两行 38，留出标点与断行余量取 34。
 *   **超过就必须拆成两句** —— 一个需要用户读三行的气泡，已经不是"私语"了。
 */
export const MAX_GUIDE_CHARS = 34

/** 气泡自动淡出的默认时长。战略原文的语气是"说完就走"，不是"等你回应"。 */
export const GUIDE_AUTO_HIDE_MS = 5000

/**
 * ★ 禁止出现在**面向用户的文案**里的词。
 *   分成两组，理由不同：
 *   · 第一组是**合规红线**（§7.2 拒绝贩卖焦虑）：预测未来、吉凶、开运化解 ——
 *     这些词一出现，产品就从"陪你梳理此刻"变成"算命"，商店审核也会卡。
 *   · 第二组是**行话**：正位 / 逆位 / 牌意 / 爻辞 / 五行 / 八字 ——
 *     它们要求用户先学会一套术语才能听懂，与"零门槛"直接冲突。
 */
export const FORBIDDEN_COPY =
  /吉|凶|血光|运势|运程|开运|化解|改运|转运|预测|预言|命中注定|灵验|算命|命理|风水|正位|逆位|牌意|寓意|爻辞|卦辞|五行|八字|生辰|抽签算/

/** 面向用户的结构词也不许出现 —— 那是我们的目录名，不是用户的世界 */
export const FORBIDDEN_STRUCTURE_WORDS = /塔罗区|六爻区|玩法|模块|入口|菜单项|Tab/

// ───────────────────────────────────────────────────────────────────────────
// 类型
// ───────────────────────────────────────────────────────────────────────────

/** 这一步在等哪个动作完成。完成即整段引导淡出（不等自动隐藏） */
export type GuideWaitFor =
  | 'none'
  | 'tap-deck'
  | 'pick-spread'
  | 'draw-card'
  | 'pick-mood'
  | 'pick-focus'
  | 'place-item'
  | 'toss'
  | 'pick-memory'
  | 'place-memory'
  | 'set-countdown'

export interface GuideStep {
  /** 气泡里的那句话（≤ MAX_GUIDE_CHARS） */
  text: string
  /** 气泡尾巴指向的位置（设计像素） */
  at: Pt
  waitFor: GuideWaitFor
  /** 到点淡出。★ 淡出 ≠ 失败 */
  autoHideMs: number
}

export const GUIDE_KEYS = [
  'FIRST_LAUNCH',
  'TAROT_ENTER',
  'TAROT_PICK',
  'TAROT_DRAW',
  'LIUYAO_ENTER',
  'LIUYAO_MOOD',
  'LIUYAO_FOCUS',
  'LIUYAO_PLACE',
  'LIUYAO_TOSS',
  'MEMORY_OFFER',
  'MEMORY_PLACE',
  'COUNTDOWN_SET',
] as const
export type GuideKey = (typeof GUIDE_KEYS)[number]

// ───────────────────────────────────────────────────────────────────────────
// 文案表
// ───────────────────────────────────────────────────────────────────────────

const s = (text: string, at: Pt, waitFor: GuideWaitFor = 'none', autoHideMs = GUIDE_AUTO_HIDE_MS): GuideStep => ({
  text,
  at,
  waitFor,
  autoHideMs,
})

/**
 * 全表。
 *
 * ★ 每一句都遵守同一条写法：**主语是"你"，动词是操作，宾语是眼前能看见的东西。**
 *   不解释规则、不给建议、不提结果。读完之后用户知道"手该放哪"，仅此而已。
 */
export const GUIDES: Record<GuideKey, readonly GuideStep[]> = {
  // 第一次打开：只告诉用户"这里有两块地方"，不解释任何玩法
  FIRST_LAUNCH: [
    s('我在。这里什么都不用急。', { x: 120, y: 470 }),
    s('想看看牌，就去毯子那边；想掷一卦，就去桌子那边。', { x: 195, y: 520 }),
  ],

  TAROT_ENTER: [
    s('毯子很软，坐下来就行。', { x: 195, y: 650 }),
    s('点一下这叠牌，在心里默念你的问题。', { x: 195, y: 700 }, 'tap-deck', 8000),
  ],

  TAROT_PICK: [
    s('选一个你想用的方式。', { x: 195, y: 650 }),
    s('不挑也行，第一次可以只翻一张。', { x: 195, y: 690 }, 'pick-spread'),
  ],

  TAROT_DRAW: [
    s('一张一张地翻。', { x: 195, y: 700 }),
    s('翻开几张，我们就看几张。', { x: 195, y: 740 }, 'draw-card', 8000),
  ],

  LIUYAO_ENTER: [
    s('这张桌子陪了你很久了。', { x: 195, y: 380 }),
    s('先把手里的事放下，再开始。', { x: 195, y: 420 }, 'none', 6000),
  ],

  LIUYAO_MOOD: [
    s('今天心里是什么感觉？', { x: 195, y: 400 }),
    s('选一个最接近的就行。', { x: 195, y: 440 }, 'pick-mood'),
  ],

  LIUYAO_FOCUS: [
    s('想聊的是哪一类事？', { x: 195, y: 400 }),
    s('不确定就选「说不上来」。', { x: 195, y: 440 }, 'pick-focus'),
  ],

  LIUYAO_PLACE: [
    s('把你手里的东西，搁到顺手的地方。', { x: 195, y: 560 }),
    s('窗边、桌上、毯边，哪儿都行。', { x: 195, y: 600 }, 'place-item', 8000),
  ],

  LIUYAO_TOSS: [
    s('放好了就轻轻往上拨一下。', { x: 200, y: 360 }),
    s('它自己会落。', { x: 200, y: 400 }, 'toss'),
  ],

  MEMORY_OFFER: [
    s('这几样东西，想带走哪一件？', { x: 120, y: 470 }),
    s('不带走也完全可以。', { x: 120, y: 510 }, 'pick-memory'),
  ],

  MEMORY_PLACE: [
    s('在小屋里找个位置放下它。', { x: 195, y: 700 }),
    s('以后点它，它会说话。', { x: 195, y: 740 }, 'place-memory', 8000),
  ],

  COUNTDOWN_SET: [
    s('想给哪件事定个日子？', { x: 150, y: 300 }),
    // ★ 不许说"我会提醒你" —— "提醒"是任务管理器的语言，而且它把归零说成了一次**通知**。
    //   归零实际是**馈赠**：沙漏静静落完，一件东西悄悄出现在它旁边，没有任何文字提示。
    s('到了那天，我会留一件东西给你。', { x: 150, y: 340 }, 'set-countdown'),
  ],
}

export function guideFor(key: GuideKey): readonly GuideStep[] {
  return GUIDES[key] ?? []
}

export function guideStepAt(key: GuideKey, index: number): GuideStep | null {
  return GUIDES[key]?.[index] ?? null
}

/** 某一步做完了 → 下一步；做完了 → null（整段引导淡出） */
export function advance(key: GuideKey, index: number, did: GuideWaitFor): number | null {
  const step = guideStepAt(key, index)
  if (!step) return null
  // ★ 严格匹配：只有"这一步在等的那个动作"才推进。
  //   宽松匹配（比如任何点击都算）会让第二句话还没看清就跳走 —— 那才是真的在催。
  if (step.waitFor !== did) return index
  return index + 1 < guideFor(key).length ? index + 1 : null
}

/**
 * 到点自动推进。
 *
 * ★ 只有 `waitFor === 'none'` 的"纯叙述步"才会因为超时前进。
 *   等具体动作的步（'tap-deck' / 'place-item' …）**超时只是淡出，不前进** ——
 *   用户没那一下就是没那一下，把"没做"当成"跳过"会让后面的引导指着一个
 *   还不存在的界面说话（例如牌还没翻开就开始讲怎么收牌）。
 */
export function advanceOnTimeout(key: GuideKey, index: number): number | null {
  const step = guideStepAt(key, index)
  if (!step) return null
  if (step.waitFor !== 'none') return index
  return index + 1 < guideFor(key).length ? index + 1 : null
}

// ───────────────────────────────────────────────────────────────────────────
// "首次进入"的记忆
// ───────────────────────────────────────────────────────────────────────────

/** 首次进入某区域 → 该区域的首次引导 key。别的 key 由各自的流程显式触发。 */
export const ZONE_GUIDE: Record<ZoneId, GuideKey> = {
  TAROT: 'TAROT_ENTER',
  LIUYAO: 'LIUYAO_ENTER',
}

export function loadSeen(store: PersistedStore): GuideKey[] {
  const raw = store.get<unknown>(PERSIST_KEYS.guide, [])
  if (!Array.isArray(raw)) return []
  const valid = new Set<string>(GUIDE_KEYS)
  return raw.filter((k): k is GuideKey => typeof k === 'string' && valid.has(k))
}

export function markSeen(seen: readonly GuideKey[], key: GuideKey): GuideKey[] {
  return seen.includes(key) ? [...seen] : [...seen, key]
}

/**
 * 该不该弹这段引导。
 * ★ 只有"首次"才弹 —— 见过一次就永不再弹。
 *   不做"三天后再提醒一次"，也不做"你好像又忘了"。
 *   让一个已经会的人再看一遍说明，是把他当新人，这本身就是一种冒犯。
 */
export function shouldShow(key: GuideKey, seen: readonly GuideKey[]): boolean {
  return !seen.includes(key)
}

/** 首次进入某区域时该弹哪个（顺手封装，免得调用方自己查表） */
export function zoneGuideFor(zone: ZoneId, seen: readonly GuideKey[]): GuideKey | null {
  const key = ZONE_GUIDE[zone]
  return key && shouldShow(key, seen) ? key : null
}

export function saveSeen(store: PersistedStore, seen: readonly GuideKey[]): void {
  store.set(PERSIST_KEYS.guide, seen)
}
