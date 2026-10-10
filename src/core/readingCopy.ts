/**
 * 小卜 · 本地解读文案组装   src/core/readingCopy.ts
 * ===========================================================================
 * 把「解读载荷」翻成**给用户看的几段话** —— 断网 / 未接云端时的本地兜底。
 *
 * 输入三样（engine 已备好，见 EngineSnapshot.reading 与 .hexagram）：
 *   · `plan`      —— 塔罗按牌阵结构生成的分段计划（含每段的牌位标签与牌库下标）
 *   · `request`   —— 解读请求（三维枚举：focus / mood 等，见 core/reading.ts）
 *   · `hexagram`  —— 六爻本卦 / 变卦 / 动爻位
 *
 * 输出：标题、副标题、分段正文、收束语。SheetResult.vue 直接渲染它。
 *
 * ★ 边界（与全仓一致）：
 *   ① 纯函数、零依赖（只 import 数据表与类型），node 里可直接单测
 *   ② 文案遵守「绝不教算命」：《禁词表》见 guide.ts 的 FORBIDDEN_COPY ——
 *      不预测、不判好坏、不用行话。这里只做**映照**，把卦/牌当作话题的由头
 *   ③ 任何字段缺失都退到温和的兜底句，绝不抛异常、绝不显示空白
 * ===========================================================================
 */

import {
  FOCUS_LABEL,
  MOOD_LABEL,
  type FocusId,
  type HexagramRef,
  type MoodTone,
  type ReadingRequest,
} from '@core/reading'
import type { ReadingPlan } from '@core/spread'
import { hexagramByNumber } from '@core/liuyao/hexagrams'
import { tarotCardAt } from '@core/spread/deck'

export interface CopySection {
  key: string
  label: string
  body: string
}

export interface ReadingCopy {
  title: string
  subtitle: string
  sections: CopySection[]
  /** 收束语（塔罗用；六爻也有） */
  summary: string
  /** 心情标签（可能为空串） */
  moodLabel: string
}

export interface InterpretInput {
  plan: ReadingPlan | null
  request: ReadingRequest | null
  hexagram: HexagramRef | null
}

function moodOf(req: ReadingRequest | null): MoodTone | null {
  const v = req?.dims?.mood
  return typeof v === 'string' && v in MOOD_LABEL ? (v as MoodTone) : null
}

function focusOf(req: ReadingRequest | null): FocusId | null {
  const v = req?.dims?.focus
  return typeof v === 'string' && v in FOCUS_LABEL ? (v as FocusId) : null
}

/** 塔罗的收束语：轻，不裁决，把选择权交回用户 */
function tarotSummary(mood: MoodTone | null): string {
  const head = mood ? `此刻的你，${MOOD_LABEL[mood]}。` : ''
  return `${head}这几张不必全信 —— 挑一句最像你今天样子的，就够了。`
}

/** 六爻的收束语：点出「问的是哪类事」，再交回用户 */
function liuyaoSummary(mood: MoodTone | null, focus: FocusId | null): string {
  const moodLine = mood ? `此刻心里${MOOD_LABEL[mood]}` : '此刻的你'
  const focusLine = focus ? `你问的是${FOCUS_LABEL[focus]}` : '你说不太清在烦什么'
  return `${focusLine}，${moodLine}。卦只是个由头，真正要看的，是你自己。`
}

/**
 * 组装本地解读。
 * ★ 有牌阵计划走塔罗分支；否则有卦象走六爻分支；两者都无 → 一句温柔兜底。
 */
export function interpretLocally(input: InterpretInput): ReadingCopy {
  const mood = moodOf(input.request)

  // ── 塔罗：按牌阵分段，每段 = 牌位标签 + 该位置那张牌的映照 ──
  if (input.plan) {
    const plan = input.plan
    const sections: CopySection[] = plan.sections.map((s) => {
      const card = s.cardIndex == null ? null : tarotCardAt(s.cardIndex)
      const body = card
        ? `「${card.name}」——${card.reading}`
        : '这一张还没翻开，先不急着读它。'
      return { key: `${s.order}-${s.role}`, label: s.label, body }
    })

    return {
      title: plan.title,
      subtitle: plan.subtitle,
      sections,
      summary: tarotSummary(mood),
      moodLabel: mood ? MOOD_LABEL[mood] : '',
    }
  }

  // ── 六爻：单段，本卦 + （有动爻时）变卦的走向提示 ──
  if (input.hexagram) {
    const hex = input.hexagram
    const primary = hexagramByNumber(hex.primary)
    const changed = hex.changed == null ? null : hexagramByNumber(hex.changed)
    const focus = focusOf(input.request)

    let body = primary ? primary.reading : '这一卦的内容还在路上。'
    if (hex.moving.length > 0 && changed) {
      body += `\n这一卦里有 ${hex.moving.length} 处在动 —— 它也许正朝着「${changed.name}」去。`
    }

    return {
      title: primary ? `第 ${hex.primary} 卦 · ${primary.name}` : `第 ${hex.primary} 卦`,
      subtitle: primary ? primary.theme : '慢慢看，不急。',
      sections: [
        {
          key: 'hexagram',
          label: focus ? `关于${FOCUS_LABEL[focus]}` : '这一卦',
          body,
        },
      ],
      summary: liuyaoSummary(mood, focus),
      moodLabel: mood ? MOOD_LABEL[mood] : '',
    }
  }

  // ── 都不在：一句兜底，绝不空白 ──
  return {
    title: '慢慢来',
    subtitle: '有些事，一时半会儿说不清也不要紧。',
    sections: [],
    summary: '先坐一会儿，想好了再说。',
    moodLabel: mood ? MOOD_LABEL[mood] : '',
  }
}
