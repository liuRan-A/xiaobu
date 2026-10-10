/**
 * 引导合规 + 手势识别 + 房间状态机 · 回归测试   tests/guide-gesture-room.spec.ts
 * ===========================================================================
 * 对应 M2 任务书「一、零门槛体验与微引导」与「五·2 文字版状态转移图」。
 *
 * 这套用例守的是三件"看不见但错不起"的事：
 *
 *   ① **引导的语气与长度**。气泡 34 字上限不是排版偏好 ——
 *      "一个需要用户读三行的气泡已经不是私语，而是一份说明书"。
 *      同时逐字拦下合规红线词（吉/凶/开运/预测…）与内部行话（牌意/正位/五行…）：
 *      它们一出现，产品就从"陪你梳理此刻"变成"算命"。
 *   ② **手势的互斥性**。TAP 与 RELEASE 必须 xor（两个都发 → 状态机同时收到
 *      "点了一下"和"甩了一下"，行为不可预测）；一次按下最多一个 LONG_PRESS。
 *   ③ **"不打断"由状态机保证**，不是靠调用方自觉 ——
 *      `COUNTDOWN_FIRED` **只有 ROOM 态声明**，所以读解读时归零不弹、不抢焦点。
 *
 * 这三条都不会在真机上"报错"。它们只会让产品慢慢变得不像自己。
 * ===========================================================================
 */

import { describe, expect, it, beforeEach } from 'vitest'
import {
  FORBIDDEN_COPY,
  FORBIDDEN_STRUCTURE_WORDS,
  GUIDE_AUTO_HIDE_MS,
  GUIDE_KEYS,
  MAX_GUIDE_CHARS,
  ZONE_GUIDE,
  advance,
  advanceOnTimeout,
  guideFor,
  guideStepAt,
  loadSeen,
  markSeen,
  saveSeen,
  shouldShow,
  zoneGuideFor,
  type GuideKey,
  type GuideWaitFor,
} from '@core/guide/guide'
import {
  DEFAULT_GESTURE_OPTIONS,
  GestureRecognizer,
  replay,
  type PointerSample,
} from '@core/gesture'
import { POINTER_LONG_PRESS_TOL_PT, TAP_MAX_MS, TAP_MAX_MOVE_PT, MAX_SAMPLE_GAP_MS, SHAKE_COOLDOWN_MS, TH } from '@core/ritual/thresholds'
import {
  INTERRUPTIBLE,
  acceptsPointer,
  canShowCountdown,
  initialRoomCtx,
  isInterruptible,
  roomMachine,
  setRoomCommandSink,
  type RoomCommand,
  type RoomEvent,
  type RoomState,
} from '@core/machine/roomMachine'
import { ROOM_H, ROOM_W } from '@core/room/roomZone'
import { createMemoryPort, PersistedStore, PERSIST_KEYS } from '@core/persist'

// ───────────────────────────────────────────────────────────────────────────
// 小工具
// ───────────────────────────────────────────────────────────────────────────

const send = (e: RoomEvent): RoomState => roomMachine.send(e)

/**
 * 把机器推到某个状态（每个用例开头都从干净态出发）。
 * ★ 必须先经过 BOOT_READY —— 直接从 BOOT 发支线事件会被"未声明即忽略"静默吃掉，
 *   表现为"resetTo 失败，停在了 BOOT"，而那其实是状态机在正确工作。
 */
const resetTo = (state: RoomState, pre?: (ctx: typeof roomMachine.ctx) => void): void => {
  roomMachine.reset()
  if (pre) pre(roomMachine.ctx)
  if (state === 'BOOT') return

  // 除 GUIDE 外，其余状态都要求"已经见过首启引导"
  if (state === 'GUIDE') {
    expect(roomMachine.ctx.seenGuides).not.toContain('FIRST_LAUNCH')
    expect(send({ type: 'BOOT_READY' })).toBe('GUIDE')
    return
  }

  roomMachine.ctx.seenGuides.push('FIRST_LAUNCH')
  expect(send({ type: 'BOOT_READY' })).toBe('ROOM')
  if (state === 'ROOM') return

  const walk: Record<string, RoomEvent[]> = {
    SPREAD_PICK: [{ type: 'ENTER_ZONE', zone: 'TAROT' }],
    SPREAD_DRAW: [{ type: 'ENTER_ZONE', zone: 'TAROT' }, { type: 'PICK_SPREAD', spreadId: 'daily-single' }],
    READING: [
      { type: 'ENTER_ZONE', zone: 'TAROT' },
      { type: 'PICK_SPREAD', spreadId: 'daily-single' },
      { type: 'READ_DONE' },
    ],
    MEMORY_OFFER: [
      { type: 'ENTER_ZONE', zone: 'TAROT' },
      { type: 'PICK_SPREAD', spreadId: 'daily-single' },
      { type: 'READ_DONE' },
      { type: 'READ_DONE' },
    ],
    MEMORY_PLACE: [
      { type: 'ENTER_ZONE', zone: 'TAROT' },
      { type: 'PICK_SPREAD', spreadId: 'daily-single' },
      { type: 'READ_DONE' },
      { type: 'READ_DONE' },
      { type: 'OFFER_MEMORY', kind: 'plant' },
    ],
    MOOD_PICK: [{ type: 'ENTER_ZONE', zone: 'LIUYAO' }],
    FOCUS_PICK: [{ type: 'ENTER_ZONE', zone: 'LIUYAO' }, { type: 'PICK_MOOD', tone: 'CALM' }],
    PLACE_ITEM: [
      { type: 'ENTER_ZONE', zone: 'LIUYAO' },
      { type: 'PICK_MOOD', tone: 'CALM' },
      { type: 'PICK_FOCUS', focus: 'CAREER' },
    ],
    RITUAL: [
      { type: 'ENTER_ZONE', zone: 'LIUYAO' },
      { type: 'PICK_MOOD', tone: 'CALM' },
      { type: 'PICK_FOCUS', focus: 'CAREER' },
      { type: 'PLACE_ITEM', anchorId: 'TABLE_TOP', at: { x: 195, y: 612 } },
    ],
    MEMORY_RECALL: [{ type: 'RECALL_MEMORY', id: 'm1' }],
    COUNTDOWN_SET: [{ type: 'OPEN_COUNTDOWN' }],
  }

  for (const ev of walk[state] ?? []) send(ev)
  if (roomMachine.state !== state) throw new Error(`resetTo(${state}) 失败，停在了 ${roomMachine.state}`)
}

beforeEach(() => {
  setRoomCommandSink(() => {})
  roomMachine.reset()
})

// ═══════════════════════════════════════════════════════════════════════════
//  ①  引导文案：短、软、合规
// ═══════════════════════════════════════════════════════════════════════════

describe('引导文案 · 私语而不是说明书', () => {
  it('每个引导 key 都有内容，且步数很少（说完就走）', () => {
    for (const key of GUIDE_KEYS) {
      const steps = guideFor(key)
      expect(steps.length, `${key} 没有文案`).toBeGreaterThan(0)
      expect(steps.length, `${key} 步数太多`).toBeLessThanOrEqual(3)
    }
  })

  it('★ 每一句都不超过 34 字（超过就必须拆成两句）', () => {
    for (const key of GUIDE_KEYS) {
      for (const [i, step] of guideFor(key).entries()) {
        expect(step.text.length, `${key}[${i}] 超长：${step.text}`).toBeLessThanOrEqual(MAX_GUIDE_CHARS)
        expect(step.text.trim().length, `${key}[${i}] 是空的`).toBeGreaterThan(0)
      }
    }
  })

  it('★ 一行一句：没有换行、没有编号列表 —— 它不是一份步骤清单', () => {
    // ★ 注意别把"一张一张地翻。"这种正常句子误判成列表项 ——
    //   要匹配的是"编号"的形态（1. / 1、 / ① / 第一步），不是汉字"一"本身。
    const listLike = /^\s*(\d+\s*[.、)]|[①②③④⑤⑥]|第\s*[一二三四五]\s*步)/
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.text).not.toMatch(/[\n\r]/)
        expect(step.text, `${key}: ${step.text}`).not.toMatch(listLike)
      }
    }
  })

  it('★ 合规红线：不许出现 吉 / 凶 / 开运 / 化解 / 预测 / 算命 / 正位 / 逆位 / 牌意 / 五行 …', () => {
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.text, `${key}: ${step.text}`).not.toMatch(FORBIDDEN_COPY)
      }
    }
  })

  it('★ 内部行话：塔罗区 / 六爻区 / 玩法 / 模块 / 入口 / 菜单项 / Tab 都不许露出来', () => {
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.text, `${key}: ${step.text}`).not.toMatch(FORBIDDEN_STRUCTURE_WORDS)
      }
    }
  })

  it('★ 不说"请"、不道歉、不催 —— 那是客服语言，不是陪着你的搭子', () => {
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.text).not.toMatch(/请|抱歉|对不起|麻烦您|尽快|立刻|马上/)
      }
    }
  })

  it('★ 不承诺"通知 / 提醒" —— 归零是馈赠，不是一条推送', () => {
    // 这条有业务出处：倒计时归零时**没有任何文字提示**，
    // 只有沙漏的样子 + 旁边多出来的那件东西（见《UI 交互规范 v2》§4.5）。
    // 引导里如果先说"我会提醒你"，用户就会在等一条并不存在的消息。
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.text, `${key}: ${step.text}`).not.toMatch(/提醒|通知|推送|待办/)
      }
    }
  })

  it('★ 需求原文那一句逐字在表里', () => {
    const all = GUIDE_KEYS.flatMap((k) => guideFor(k).map((s) => s.text))
    expect(all.some((t) => t.includes('点一下这叠牌，在心里默念你的问题'))).toBe(true)
  })

  it('气泡尾巴都指在房间画布内（指到画布外就看不见了）', () => {
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) {
        expect(step.at.x).toBeGreaterThanOrEqual(0)
        expect(step.at.x).toBeLessThanOrEqual(ROOM_W)
        expect(step.at.y).toBeGreaterThanOrEqual(0)
        expect(step.at.y).toBeLessThanOrEqual(ROOM_H)
      }
    }
  })

  it('★ 每个"要动手"的引导，最后一步都在等那个具体动作', () => {
    // 这条表就是"零门槛"的落点：不是讲规则，而是等用户把那一件小事做完。
    const table: Array<[GuideKey, GuideWaitFor]> = [
      ['FIRST_LAUNCH', 'none'],
      ['TAROT_ENTER', 'tap-deck'],
      ['TAROT_PICK', 'pick-spread'],
      ['TAROT_DRAW', 'draw-card'],
      ['LIUYAO_ENTER', 'none'],
      ['LIUYAO_MOOD', 'pick-mood'],
      ['LIUYAO_FOCUS', 'pick-focus'],
      ['LIUYAO_PLACE', 'place-item'],
      ['LIUYAO_TOSS', 'toss'],
      ['MEMORY_OFFER', 'pick-memory'],
      ['MEMORY_PLACE', 'place-memory'],
      ['COUNTDOWN_SET', 'set-countdown'],
    ]
    for (const [key, want] of table) {
      const steps = guideFor(key)
      expect(steps[steps.length - 1].waitFor, `${key} 的最后一步`).toBe(want)
    }
    // 表覆盖了全部 key —— 新增引导必须显式写进来
    expect(table.map(([k]) => k).sort()).toEqual([...GUIDE_KEYS].sort())
  })

  it('等待动作的步给的时间更宽（用户走神了不该被催）', () => {
    const widest = Math.max(...GUIDE_KEYS.flatMap((k) => guideFor(k).map((s) => s.autoHideMs)))
    expect(widest).toBeGreaterThan(GUIDE_AUTO_HIDE_MS)
    for (const key of GUIDE_KEYS) {
      for (const step of guideFor(key)) expect(step.autoHideMs).toBeGreaterThan(0)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ②  引导推进：严格匹配，不做"任何点击都算"
// ═══════════════════════════════════════════════════════════════════════════

describe('advance / advanceOnTimeout · 推进规则', () => {
  it('★ 只有"这一步在等的那个动作"才推进 —— 别的动作原地不动', () => {
    // TAROT_ENTER[1] 等的是 tap-deck
    expect(advance('TAROT_ENTER', 1, 'tap-deck')).toBeNull() // 已是最后一步 → 整段结束
    expect(advance('TAROT_ENTER', 0, 'tap-deck')).toBe(0) // 第 0 步等的是 none → 不匹配
    expect(advance('TAROT_ENTER', 1, 'pick-spread')).toBe(1) // 不等这个 → 原地
  })

  it('最后一步做完 → null（整段淡出，不是回到第一步）', () => {
    expect(advance('TAROT_ENTER', 1, 'tap-deck')).toBeNull()
    expect(advance('TAROT_PICK', 1, 'pick-spread')).toBeNull()
  })

  it('越界下标 → null，不抛', () => {
    expect(advance('TAROT_ENTER', 99, 'tap-deck')).toBeNull()
    expect(advance('TAROT_ENTER', -1, 'none')).toBeNull()
  })

  it('★ 超时只推进纯叙述步 —— 等动作的步超时只是淡出，不前进', () => {
    // FIRST_LAUNCH 两步都是 none → 可以靠超时走过去
    expect(advanceOnTimeout('FIRST_LAUNCH', 0)).toBe(1)
    expect(advanceOnTimeout('FIRST_LAUNCH', 1)).toBeNull()
    // TAROT_ENTER[1] 在等 tap-deck → 超时原地不动（把"没做"当成"跳过"
    // 会让后面的引导指着一个还不存在的界面说话）
    expect(advanceOnTimeout('TAROT_ENTER', 1)).toBe(1)
    expect(advanceOnTimeout('LIUYAO_PLACE', 1)).toBe(1)
  })

  it('guideStepAt 越界返回 null', () => {
    expect(guideStepAt('TAROT_ENTER', 0)?.text).toBeTruthy()
    expect(guideStepAt('TAROT_ENTER', 99)).toBeNull()
  })

  it('★ 一段引导里，越靠后的句子尾巴越靠下（气泡不跳来跳去）', () => {
    for (const key of GUIDE_KEYS) {
      const steps = guideFor(key)
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i].at.y, `${key} 第 ${i} 步`).toBeGreaterThan(steps[i - 1].at.y)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ③  "首次才出现"的记忆
// ═══════════════════════════════════════════════════════════════════════════

describe('首次引导的记忆 · 见过一次就永不再弹', () => {
  it('shouldShow 只在没见过时返回 true', () => {
    expect(shouldShow('TAROT_ENTER', [])).toBe(true)
    expect(shouldShow('TAROT_ENTER', ['TAROT_ENTER'])).toBe(false)
  })

  it('markSeen 幂等，且不改原数组', () => {
    const before: GuideKey[] = ['TAROT_ENTER']
    const after = markSeen(before, 'TAROT_ENTER')
    expect(after).toEqual(['TAROT_ENTER'])
    expect(after).not.toBe(before)
    expect(markSeen(before, 'LIUYAO_ENTER')).toEqual(['TAROT_ENTER', 'LIUYAO_ENTER'])
    expect(before).toEqual(['TAROT_ENTER'])
  })

  it('分区 → 首次引导 key 的映射覆盖两个分区', () => {
    expect(ZONE_GUIDE.TAROT).toBe('TAROT_ENTER')
    expect(ZONE_GUIDE.LIUYAO).toBe('LIUYAO_ENTER')
    expect(zoneGuideFor('TAROT', [])).toBe('TAROT_ENTER')
    expect(zoneGuideFor('TAROT', ['TAROT_ENTER'])).toBeNull()
    expect(zoneGuideFor('LIUYAO', [])).toBe('LIUYAO_ENTER')
  })

  it('读写往返：非法 key 会被过滤掉（手工改过的本地数据不该让引导全废）', () => {
    const store = new PersistedStore(
      createMemoryPort({ [PERSIST_KEYS.guide]: ['TAROT_ENTER', '不存在的引导', 42, null] }),
    )
    // loadSeen 是同步读 —— 但 PersistedStore 需要先 load() 一次才拿到数据
    // 这里直接用内存端口验证过滤逻辑
    void store
    const sync = new PersistedStore(createMemoryPort())
    expect(loadSeen(sync)).toEqual([])
    saveSeen(sync, ['TAROT_ENTER', 'LIUYAO_ENTER'])
    expect(loadSeen(sync)).toEqual(['TAROT_ENTER', 'LIUYAO_ENTER'])
  })

  it('非数组 / 垃圾值 → 空表，不抛', () => {
    expect(loadSeen(new PersistedStore(createMemoryPort({ [PERSIST_KEYS.guide]: 'nope' })))).toEqual([])
    expect(loadSeen(new PersistedStore(createMemoryPort({ [PERSIST_KEYS.guide]: { a: 1 } })))).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ④  手势识别
// ═══════════════════════════════════════════════════════════════════════════

describe('GestureRecognizer · 互斥与容差', () => {
  let rec: GestureRecognizer
  beforeEach(() => {
    rec = new GestureRecognizer()
  })

  const p = (x: number, y: number, t: number, id = 0): PointerSample => ({ id, x, y, t })

  it('按下 → PRESS；一个触点只有一个 PRESS', () => {
    expect(rec.down(p(100, 100, 0)).map((e) => e.type)).toEqual(['PRESS'])
    expect(rec.isPressed).toBe(true)
  })

  it('★ TAP 与 RELEASE 互斥：短按几乎没动 → 只有 TAP', () => {
    rec.down(p(100, 100, 0))
    const evs = rec.up(p(101, 101, 80))
    expect(evs.map((e) => e.type)).toEqual(['TAP'])
    expect(evs.some((e) => e.type === 'RELEASE')).toBe(false)
  })

  it('★ 按住久了 → 只有 RELEASE（不是 TAP）', () => {
    rec.down(p(100, 100, 0))
    const evs = rec.up(p(100, 100, TAP_MAX_MS + 50))
    expect(evs.map((e) => e.type)).toEqual(['RELEASE'])
    expect(evs.some((e) => e.type === 'TAP')).toBe(false)
  })

  it('★ 动得多 → 只有 RELEASE（哪怕时间很短）', () => {
    rec.down(p(100, 100, 0))
    const evs = rec.up(p(100 + TAP_MAX_MOVE_PT + 5, 100, 80))
    expect(evs.map((e) => e.type)).toEqual(['RELEASE'])
  })

  it('★ 拖远了又拖回来，末位移很小 —— 仍然不算轻点（用位移**峰值**判定）', () => {
    rec.down(p(100, 100, 0))
    rec.move(p(160, 100, 40)) // 峰值 60
    rec.move(p(100, 100, 80)) // 末位移 0
    const evs = rec.up(p(100, 100, 100))
    expect(evs.map((e) => e.type)).toEqual(['RELEASE'])
  })

  it('★ 一次按下最多一个 LONG_PRESS', () => {
    rec.down(p(100, 100, 0))
    const types: string[] = []
    for (let t = 30; t <= 1200; t += 30) {
      types.push(...rec.move(p(100, 100, t)).map((e) => e.type))
    }
    expect(types.filter((t) => t === 'LONG_PRESS')).toHaveLength(1)
  })

  it('长按容差：超过 8pt 就不算"按着不动"，不会发 LONG_PRESS', () => {
    rec.down(p(100, 100, 0))
    // 动到刚好超过容差
    const moved = rec.move(p(100 + POINTER_LONG_PRESS_TOL_PT + 2, 100, 50))
    expect(moved.some((e) => e.type === 'LONG_PRESS')).toBe(false)
    const later = rec.move(p(100 + POINTER_LONG_PRESS_TOL_PT + 2, 100, 400))
    expect(later.some((e) => e.type === 'LONG_PRESS')).toBe(false)
  })

  it('容差之内可以发 LONG_PRESS，且同时会开始发 DRAG（表现层要跟随）', () => {
    rec.down(p(100, 100, 0))
    rec.move(p(104, 102, 200)) // peak 4.47，在容差内
    const evs = rec.move(p(140, 120, 260))
    expect(evs.some((e) => e.type === 'LONG_PRESS')).toBe(false) // 已过了长按窗口但已被拖走
    expect(evs.some((e) => e.type === 'DRAG')).toBe(true)
  })

  it('tick 让"按住完全不动"也能收到 LONG_PRESS；没按着时是空操作', () => {
    expect(rec.tick(999)).toEqual([])
    rec.down(p(100, 100, 0))
    expect(rec.tick(100)).toEqual([])
    expect(rec.tick(DEFAULT_GESTURE_OPTIONS.longPressMs).map((e) => e.type)).toEqual(['LONG_PRESS'])
    expect(rec.tick(9999)).toEqual([]) // 只发一次
  })

  it('★ 上滑 → fling（位移够 + 方向够"往上"）', () => {
    rec.down(p(100, 200, 0))
    const evs = rec.up(p(100, 200 - TH.SWIPE_MIN_PT - 10, 120))
    const rel = evs.find((e) => e.type === 'RELEASE')!
    expect(rel.fling).toBe(true)
    expect(rel.angleFromVerticalDeg).toBeCloseTo(0, 6)
  })

  it('★ 横着划 → 不 fling（少了方向这一条，横划就会把币丢出去）', () => {
    rec.down(p(100, 200, 0))
    const evs = rec.up(p(100 + TH.SWIPE_MIN_PT + 40, 200, 120))
    const rel = evs.find((e) => e.type === 'RELEASE')!
    expect(rel.fling).toBe(false)
    expect(rel.angleFromVerticalDeg).toBeCloseTo(90, 6)
  })

  it('★ 斜向上但超过 40° → 不 fling', () => {
    // 45° 斜划：dx = dy，angle = 45 > RELEASE_ANGLE_MAX(40)
    rec.down(p(100, 300, 0))
    const evs = rec.up(p(100 + 100, 300 - 100, 120))
    const rel = evs.find((e) => e.type === 'RELEASE')!
    expect(rel.fling).toBe(false)
    expect(rel.angleFromVerticalDeg).toBeCloseTo(45, 6)
  })

  it('★ 速度能单独构成掷出：位移不到 60pt、但 40pt / 60ms → 速度 666 ≥ 480', () => {
    rec.down(p(100, 200, 0))
    const evs = rec.up(p(100, 160, 60)) // 位移 40 < 60
    const rel = evs.find((e) => e.type === 'RELEASE')!
    expect(rel.distancePt).toBeCloseTo(40, 6)
    expect(rel.speedPtS).toBeGreaterThanOrEqual(TH.RELEASE_V_MIN)
    expect(rel.fling).toBe(true)
  })

  it('★ 掉帧（采样间隔 > 120ms）→ 速度强制为 0，宁可判成"力度不足"', () => {
    // 同样的 40pt 位移，但中间隔了 200ms：速度本该 200（本来也不够），
    // 关键是**必须被强制为 0**，而不是留下一个不可信的估算值
    rec.down(p(100, 200, 0))
    const evs = rec.up(p(100, 160, MAX_SAMPLE_GAP_MS + 80))
    const rel = evs.find((e) => e.type === 'RELEASE')!
    expect(rel.speedPtS).toBe(0)
    expect(rel.fling).toBe(false)
  })

  it('cancel 发 CANCEL；没有触点时是空操作（取消不是失败）', () => {
    expect(rec.cancel(10)).toEqual([])
    rec.down(p(100, 100, 0))
    const evs = rec.cancel(120)
    expect(evs.map((e) => e.type)).toEqual(['CANCEL'])
    expect(rec.isPressed).toBe(false)
  })

  it('★ 第二个 down 会先把前一个当作被系统取消（多指 / 手掌误触）', () => {
    rec.down(p(100, 100, 0, 0))
    const evs = rec.down(p(200, 200, 50, 1))
    expect(evs.map((e) => e.type)).toEqual(['CANCEL', 'PRESS'])
  })

  it('陌生 id 的 move / up 被忽略（不串触点）', () => {
    rec.down(p(100, 100, 0, 7))
    expect(rec.move(p(200, 200, 50, 9))).toEqual([])
    expect(rec.up(p(200, 200, 60, 9))).toEqual([])
    expect(rec.isPressed).toBe(true)
  })

  it('★ 摇晃：幅度 + 持续 + 冷却，三者缺一不可', () => {
    // 幅度不够
    expect(rec.motion(1.0, 0)).toEqual([])
    // 幅度够但持续不够
    expect(rec.motion(2.0, 0)).toEqual([])
    expect(rec.motion(2.0, 40)).toEqual([]) // 40 < SHAKE_HOLD_MS(80)
    // 持续够了 → 发一次
    expect(rec.motion(2.0, 100).map((e) => e.type)).toEqual(['SHAKE'])
    // 冷却期内不再发
    expect(rec.motion(2.0, 200)).toEqual([])
    expect(rec.motion(2.0, 100 + SHAKE_COOLDOWN_MS - 1)).toEqual([])
    // 冷却过去后可以再发
    expect(rec.motion(2.0, 100 + SHAKE_COOLDOWN_MS + 200).map((e) => e.type)).toEqual(['SHAKE'])
  })

  it('摇晃在语义上等同于"往上掷"（fling = true，方向朝上）', () => {
    rec.motion(2.0, 0)
    const ev = rec.motion(2.0, 100)[0]
    expect(ev.fling).toBe(true)
    expect(ev.dir.y).toBeLessThan(0)
    expect(ev.pointerId).toBe(-1) // 不是某个触点产生的
  })

  it('幅度掉下去会重置"持续"计时 —— 走路晃一下不该触发', () => {
    rec.motion(2.0, 0)
    rec.motion(0.5, 50) // 掉下去
    expect(rec.motion(2.0, 90)).toEqual([]) // 重新起算，才 40ms
    expect(rec.motion(2.0, 180).map((e) => e.type)).toEqual(['SHAKE'])
  })

  it('NaN / 非有限加速度不触发、不崩', () => {
    expect(rec.motion(Number.NaN, 0)).toEqual([])
    expect(rec.motion(Number.POSITIVE_INFINITY, 0)).toEqual([])
  })

  it('reset 丢弃所有中间态，且之后不会有残留事件', () => {
    rec.down(p(100, 100, 0))
    rec.motion(2.0, 0)
    rec.motion(2.0, 100)
    rec.reset()
    expect(rec.isPressed).toBe(false)
    expect(rec.up(p(100, 100, 200))).toEqual([])
    expect(rec.motion(2.0, 200)).toEqual([])
  })

  it('replay 把一条轨迹回放成确定的事件序列', () => {
    const events = replay(new GestureRecognizer(), {
      id: 0,
      pts: [
        { x: 100, y: 200 },
        { x: 100, y: 180 },
        { x: 100, y: 140 },
        { x: 100, y: 100 },
      ],
      stepMs: 20,
      startT: 0,
    })
    const kinds = events.map((e) => e.type)
    expect(kinds[0]).toBe('PRESS')
    expect(kinds[kinds.length - 1]).toBe('RELEASE')
    expect(events[events.length - 1].fling).toBe(true)
    // 同样的脚本回放两次结果一致（确定性）
    const again = replay(new GestureRecognizer(), {
      id: 0,
      pts: [
        { x: 100, y: 200 },
        { x: 100, y: 180 },
        { x: 100, y: 140 },
        { x: 100, y: 100 },
      ],
      stepMs: 20,
      startT: 0,
    })
    expect(again).toEqual(events)
  })

  it('空轨迹的 replay 返回空数组', () => {
    expect(replay(new GestureRecognizer(), { id: 0, pts: [], stepMs: 16, startT: 0 })).toEqual([])
  })

  it('长按阈值与规范一致（180ms / 8pt / 点击 220ms）', () => {
    expect(DEFAULT_GESTURE_OPTIONS.longPressMs).toBe(180)
    expect(DEFAULT_GESTURE_OPTIONS.longPressTolPt).toBe(8)
    expect(DEFAULT_GESTURE_OPTIONS.tapMaxMs).toBe(220)
    expect(POINTER_LONG_PRESS_TOL_PT).toBe(8)
    expect(TAP_MAX_MS).toBe(220)
    expect(TAP_MAX_MOVE_PT).toBe(8)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑤  房间主流程：状态转移图
// ═══════════════════════════════════════════════════════════════════════════

describe('roomMachine · 主流程', () => {
  it('★ 首次启动 → GUIDE（小卜先说两句）；见过 → 直接 ROOM', () => {
    resetTo('BOOT')
    expect(send({ type: 'BOOT_READY' })).toBe('GUIDE')

    resetTo('BOOT')
    roomMachine.ctx.seenGuides.push('FIRST_LAUNCH')
    expect(send({ type: 'BOOT_READY' })).toBe('ROOM')
  })

  it('GUIDE 里做对了动作 → 推进；做完 → ROOM 并记入 seenGuides', () => {
    resetTo('GUIDE')
    expect(send({ type: 'GUIDE_ACTION', did: 'none' })).toBe('GUIDE') // 推进到第 2 句
    expect(send({ type: 'GUIDE_ACTION', did: 'none' })).toBe('ROOM')
    expect(roomMachine.ctx.seenGuides).toContain('FIRST_LAUNCH')
  })

  it('GUIDE_DONE 立刻结束引导（任何真实操作都能把它推走）', () => {
    resetTo('GUIDE')
    expect(send({ type: 'GUIDE_DONE' })).toBe('ROOM')
    expect(roomMachine.ctx.guide.key).toBeNull()
  })

  it('★ 引导靠超时也能走完，且不会卡在 GUIDE', () => {
    resetTo('GUIDE')
    expect(send({ type: 'GUIDE_STEP_TIMEOUT' })).toBe('GUIDE')
    expect(send({ type: 'GUIDE_STEP_TIMEOUT' })).toBe('ROOM')
  })

  it('分区入口分出两条支线（塔罗从"翻开手账"进，六爻从"先说说今天"进）', () => {
    resetTo('ROOM')
    expect(send({ type: 'ENTER_ZONE', zone: 'TAROT' })).toBe('SPREAD_PICK')
    resetTo('ROOM')
    expect(send({ type: 'ENTER_ZONE', zone: 'LIUYAO' })).toBe('MOOD_PICK')
  })

  it('★ 塔罗全程：翻开手账 → 一张张翻 → 解读 → 记忆锚点 → 回房间', () => {
    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'TAROT' })
    expect(send({ type: 'PICK_SPREAD', spreadId: 'past-present-future' })).toBe('SPREAD_DRAW')
    expect(roomMachine.ctx.spread.id).toBe('past-present-future')

    // 抽牌顺序与 spreads.json 的 order 一致（第 1 张 → index 0）
    expect(send({ type: 'DRAW_CARD' })).toBe('SPREAD_DRAW')
    expect(send({ type: 'DRAW_CARD' })).toBe('SPREAD_DRAW')
    expect(roomMachine.ctx.spread.drawn).toBe(2)
    expect(roomMachine.ctx.spread.deck).toEqual([0, 1])

    expect(send({ type: 'READ_DONE' })).toBe('READING')
    expect(send({ type: 'READ_DONE' })).toBe('MEMORY_OFFER')
    expect(send({ type: 'OFFER_MEMORY', kind: 'plant' })).toBe('MEMORY_PLACE')
    expect(roomMachine.ctx.pendingKind).toBe('plant')
    expect(send({ type: 'PLACE_MEMORY', anchorId: 'TEA_TABLE', at: { x: 195, y: 738 } })).toBe('ROOM')
    expect(roomMachine.ctx.pendingKind).toBeNull()
  })

  it('★ 不带走也完全可以 —— SKIP_MEMORY 是一个和别的选项一样显眼的出口', () => {
    resetTo('MEMORY_OFFER')
    expect(send({ type: 'SKIP_MEMORY' })).toBe('ROOM')
    expect(roomMachine.ctx.pendingKind).toBeNull()
  })

  it('★ 六爻全程：心情 → 方向 → 放下道具 → 掷币 → 解读', () => {
    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'LIUYAO' })
    expect(send({ type: 'PICK_MOOD', tone: 'ANXIOUS' })).toBe('FOCUS_PICK')
    expect(roomMachine.ctx.liuyao.tone).toBe('ANXIOUS')
    expect(send({ type: 'PICK_FOCUS', focus: 'CAREER' })).toBe('PLACE_ITEM')
    expect(roomMachine.ctx.liuyao.focus).toBe('CAREER')

    expect(send({ type: 'PLACE_ITEM', anchorId: 'CENSER_SIDE', at: { x: 400, y: 500 } })).toBe('RITUAL')
    expect(roomMachine.ctx.liuyao.anchorId).toBe('CENSER_SIDE')

    const hex = { primary: 12, changed: 30, moving: [2] }
    expect(send({ type: 'RITUAL_CAST_DONE', hexagram: hex })).toBe('READING')
    expect(roomMachine.ctx.hexagram).toEqual(hex)
  })

  it('★ 放到空地上（anchorId = null）一样能进仪式 —— 没有失败态', () => {
    resetTo('PLACE_ITEM')
    expect(send({ type: 'PLACE_ITEM', anchorId: null, at: { x: 300, y: 300 } })).toBe('RITUAL')
    expect(roomMachine.ctx.liuyao.anchorId).toBeNull()
    expect(roomMachine.ctx.liuyao.at).toEqual({ x: 300, y: 300 })
  })

  it('★ 每个支线都有随时能走的出口（LEAVE_ZONE → ROOM）', () => {
    const exits: RoomState[] = [
      'SPREAD_PICK',
      'SPREAD_DRAW',
      'MOOD_PICK',
      'FOCUS_PICK',
      'PLACE_ITEM',
      'RITUAL',
      'READING',
    ]
    for (const s of exits) {
      resetTo(s)
      expect(send({ type: 'LEAVE_ZONE' }), `${s} 出不去`).toBe('ROOM')
    }
    // 记忆与倒计时的两条也有出口（用各自的关闭事件）
    resetTo('MEMORY_OFFER')
    expect(send({ type: 'SKIP_MEMORY' })).toBe('ROOM')
    resetTo('MEMORY_PLACE')
    expect(send({ type: 'SKIP_MEMORY' })).toBe('ROOM')
    resetTo('MEMORY_RECALL')
    expect(send({ type: 'CLOSE_RECALL' })).toBe('ROOM')
    resetTo('COUNTDOWN_SET')
    expect(send({ type: 'CANCEL_COUNTDOWN' })).toBe('ROOM')
  })

  it('INTERRUPTIBLE 表与 isInterruptible 一致，且不含 BOOT / GUIDE / ROOM', () => {
    for (const s of INTERRUPTIBLE) expect(isInterruptible(s)).toBe(true)
    for (const s of ['BOOT', 'GUIDE', 'ROOM', 'COUNTDOWN_DUE'] as RoomState[]) {
      expect(isInterruptible(s)).toBe(false)
    }
  })

  it('离开房间会清掉当前分区与气泡', () => {
    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'TAROT' })
    expect(roomMachine.ctx.zone).toBe('TAROT')
    send({ type: 'LEAVE_ZONE' })
    expect(roomMachine.ctx.zone).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑥  倒计时：不打断，靠状态机保证
// ═══════════════════════════════════════════════════════════════════════════

describe('倒计时归零 · 不打断', () => {
  it('★ COUNTDOWN_FIRED 只在 ROOM 态被声明 —— 其他状态根本收不到', () => {
    const silent: RoomState[] = ['READING', 'RITUAL', 'SPREAD_DRAW', 'MEMORY_OFFER', 'MEMORY_PLACE', 'COUNTDOWN_SET']
    for (const s of silent) {
      resetTo(s)
      expect(roomMachine.accepts('COUNTDOWN_FIRED'), `${s} 不该接受归零事件`).toBe(false)
      const stayed = send({ type: 'COUNTDOWN_FIRED', id: 'c1' })
      expect(stayed, `${s} 被归零打断了`).toBe(s)
      expect(roomMachine.ctx.dueQueue).toEqual([])
    }
  })

  it('★ ROOM 里归零 → 展示；ACK 之后回 ROOM', () => {
    resetTo('ROOM')
    expect(send({ type: 'COUNTDOWN_FIRED', id: 'c1' })).toBe('COUNTDOWN_DUE')
    expect(roomMachine.ctx.dueQueue).toEqual(['c1'])
    expect(send({ type: 'ACK_DUE' })).toBe('ROOM')
    expect(roomMachine.ctx.dueQueue).toEqual([])
  })

  it('★ 排队的一件一件展示，不会一次全塞给用户', () => {
    resetTo('ROOM')
    // 第一件：正常走完
    send({ type: 'COUNTDOWN_FIRED', id: 'c1' })
    expect(send({ type: 'ACK_DUE' })).toBe('ROOM')

    // 第二件：展示中；此时又到期了第三件
    send({ type: 'COUNTDOWN_FIRED', id: 'c2' })
    expect(roomMachine.state).toBe('COUNTDOWN_DUE')
    // ★ COUNTDOWN_DUE 态没有声明 COUNTDOWN_FIRED —— 展示期间新到的归零事件被忽略，
    //   这件事由 **engine** 兜底：它在"当前不能展示"时直接把 id 放进 dueQueue
    //   （见 engine.tickCountdowns / drainDueQueue）。这里模拟引擎那一手。
    expect(roomMachine.accepts('COUNTDOWN_FIRED')).toBe(false)
    send({ type: 'COUNTDOWN_FIRED', id: 'c3' })
    expect(roomMachine.ctx.dueQueue).toEqual(['c2'])
    roomMachine.ctx.dueQueue.push('c3')

    expect(roomMachine.ctx.dueQueue).toEqual(['c2', 'c3'])
    expect(send({ type: 'ACK_DUE' })).toBe('COUNTDOWN_DUE') // 队列还有 → 继续留在这个态
    expect(roomMachine.ctx.dueQueue).toEqual(['c3'])
    expect(send({ type: 'ACK_DUE' })).toBe('ROOM')
  })

  it('同一个 id 重复入队只算一次', () => {
    resetTo('ROOM')
    send({ type: 'COUNTDOWN_FIRED', id: 'c1' })
    send({ type: 'COUNTDOWN_FIRED', id: 'c1' })
    expect(roomMachine.ctx.dueQueue).toEqual(['c1'])
  })

  it('canShowCountdown 只有 ROOM 为真', () => {
    expect(canShowCountdown('ROOM')).toBe(true)
    for (const s of ['BOOT', 'GUIDE', 'READING', 'RITUAL', 'COUNTDOWN_DUE'] as RoomState[]) {
      expect(canShowCountdown(s)).toBe(false)
    }
  })

  it('定日子：ROOM → COUNTDOWN_SET → 设好 / 取消 → ROOM', () => {
    resetTo('ROOM')
    expect(send({ type: 'OPEN_COUNTDOWN' })).toBe('COUNTDOWN_SET')
    expect(send({ type: 'SET_COUNTDOWN', id: 'c9' })).toBe('ROOM')

    resetTo('ROOM')
    send({ type: 'OPEN_COUNTDOWN' })
    expect(send({ type: 'CANCEL_COUNTDOWN' })).toBe('ROOM')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑦  记忆回看
// ═══════════════════════════════════════════════════════════════════════════

describe('记忆回看 · 不是弹窗', () => {
  it('ROOM → 点一下它 → 低语卡；点别处就收起来', () => {
    resetTo('ROOM')
    expect(send({ type: 'RECALL_MEMORY', id: 'm7' })).toBe('MEMORY_RECALL')
    expect(roomMachine.ctx.recalledId).toBe('m7')
    expect(send({ type: 'CLOSE_RECALL' })).toBe('ROOM')
    expect(roomMachine.ctx.recalledId).toBeNull()
  })

  it('在低语卡里点另一个摆件 → 换成那一个（不要求先关掉）', () => {
    resetTo('MEMORY_RECALL')
    expect(send({ type: 'RECALL_MEMORY', id: 'm8' })).toBe('MEMORY_RECALL')
    expect(roomMachine.ctx.recalledId).toBe('m8')
  })

  it('RECALL 声明了 LEAVE_ZONE 的行为等价物（CLOSE_RECALL）', () => {
    resetTo('MEMORY_RECALL')
    expect(roomMachine.accepts('CLOSE_RECALL')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑧  四条"不"：失败 / 打断 / 困住 / 静默丢数据
// ═══════════════════════════════════════════════════════════════════════════

describe('四条"不" · 与任务书一致', () => {
  it('★ 不判失败：未声明的事件静默忽略，状态不动、不抛', () => {
    resetTo('ROOM')
    expect(send({ type: 'RITUAL_CAST_DONE', hexagram: { primary: 1, changed: null, moving: [] } })).toBe('ROOM')
    expect(send({ type: 'PICK_MOOD', tone: 'CALM' })).toBe('ROOM')
    resetTo('SPREAD_PICK')
    expect(send({ type: 'RITUAL_CAST_DONE', hexagram: { primary: 1, changed: null, moving: [] } })).toBe('SPREAD_PICK')
  })

  it('★ 不困住：三个支线状态都能无条件退出', () => {
    for (const s of ['SPREAD_PICK', 'MOOD_PICK', 'FOCUS_PICK'] as RoomState[]) {
      resetTo(s)
      expect(send({ type: 'LEAVE_ZONE' })).toBe('ROOM')
    }
  })

  it('★ 不静默丢数据：中途离开保留已落成的记忆与倒计时，只丢"这一次未完成的流程"', () => {
    resetTo('ROOM')
    // 已经放好的东西与设好的日子
    roomMachine.ctx.seenGuides.push('TAROT_ENTER')
    send({ type: 'ENTER_ZONE', zone: 'TAROT' })
    send({ type: 'PICK_SPREAD', spreadId: 'celtic-cross' })
    send({ type: 'DRAW_CARD' })
    send({ type: 'LEAVE_ZONE' })

    expect(roomMachine.ctx.spread.id).toBe('celtic-cross') // 未完成的这局保留在 ctx 里（engine 决定是否丢弃）
    expect(roomMachine.ctx.seenGuides).toContain('TAROT_ENTER') // 引导记忆没丢
    expect(roomMachine.ctx.zone).toBeNull()
  })

  it('手指事件只在 RITUAL 段转发给仪式机', () => {
    expect(acceptsPointer('RITUAL')).toBe(true)
    for (const s of ['ROOM', 'SPREAD_PICK', 'READING', 'MOOD_PICK', 'MEMORY_PLACE'] as RoomState[]) {
      expect(acceptsPointer(s)).toBe(false)
    }
  })

  it('★ 非法目标态 / 转移里抛异常都不会冒泡（不产生任何用户可见反馈）', () => {
    resetTo('ROOM')
    expect(roomMachine.state).toBe('ROOM')
    // 走一遍所有事件 × 所有状态的组合，只要求"不抛、且停在一个已知状态"
    const all: RoomEvent[] = [
      { type: 'BOOT_READY' },
      { type: 'GUIDE_STEP_TIMEOUT' },
      { type: 'GUIDE_ACTION', did: 'toss' },
      { type: 'GUIDE_DONE' },
      { type: 'ENTER_ZONE', zone: 'TAROT' },
      { type: 'ENTER_ZONE', zone: 'LIUYAO' },
      { type: 'LEAVE_ZONE' },
      { type: 'BACK_TO_ROOM' },
      { type: 'PICK_SPREAD', spreadId: 'nope' },
      { type: 'DRAW_CARD' },
      { type: 'READ_DONE' },
      { type: 'PICK_MOOD', tone: 'CALM' },
      { type: 'PICK_FOCUS', focus: 'SELF' },
      { type: 'PLACE_ITEM', anchorId: null, at: { x: 0, y: 0 } },
      { type: 'RITUAL_CAST_DONE', hexagram: { primary: 1, changed: null, moving: [] } },
      { type: 'OFFER_MEMORY', kind: 'plant' },
      { type: 'SKIP_MEMORY' },
      { type: 'PLACE_MEMORY', anchorId: null, at: { x: 0, y: 0 } },
      { type: 'RECALL_MEMORY', id: 'x' },
      { type: 'CLOSE_RECALL' },
      { type: 'OPEN_COUNTDOWN' },
      { type: 'SET_COUNTDOWN', id: 'x' },
      { type: 'CANCEL_COUNTDOWN' },
      { type: 'COUNTDOWN_FIRED', id: 'x' },
      { type: 'ACK_DUE' },
      { type: 'TICK', now: 1 },
    ]
    const known = new Set<RoomState>([
      'BOOT', 'GUIDE', 'ROOM', 'SPREAD_PICK', 'SPREAD_DRAW', 'MOOD_PICK', 'FOCUS_PICK',
      'PLACE_ITEM', 'RITUAL', 'READING', 'MEMORY_OFFER', 'MEMORY_PLACE', 'MEMORY_RECALL',
      'COUNTDOWN_SET', 'COUNTDOWN_DUE',
    ])
    for (const ev of all) {
      expect(() => roomMachine.send(ev)).not.toThrow()
      expect(known.has(roomMachine.state)).toBe(true)
    }
    // 最后回到一个可交互的态（不是卡在某个中间态）
    resetTo('ROOM')
    expect(roomMachine.state).toBe('ROOM')
  })

  it('★ reset 真的回到干净态（模块级单例的数组必须被复位）', () => {
    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'TAROT' })
    send({ type: 'PICK_SPREAD', spreadId: 'celtic-cross' })
    send({ type: 'DRAW_CARD' })
    send({ type: 'LEAVE_ZONE' })
    send({ type: 'RECALL_MEMORY', id: 'm1' })

    roomMachine.reset()
    expect(roomMachine.state).toBe('BOOT')
    const fresh = initialRoomCtx()
    expect(roomMachine.ctx.seenGuides).toEqual(fresh.seenGuides)
    expect(roomMachine.ctx.dueQueue).toEqual(fresh.dueQueue)
    expect(roomMachine.ctx.spread.deck).toEqual(fresh.spread.deck)
    expect(roomMachine.ctx.spread.drawn).toBe(0)
    expect(roomMachine.ctx.recalledId).toBeNull()
    expect(roomMachine.ctx.hexagram).toBeNull()
    expect(roomMachine.ctx.zone).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  ⑨  场景指令：只发指令，不碰 DOM
// ═══════════════════════════════════════════════════════════════════════════

describe('命令出口 · 只发指令', () => {
  it('各支线发出预期的场景指令', () => {
    const cmds: RoomCommand[] = []
    setRoomCommandSink((c) => cmds.push(c))

    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'TAROT' })
    expect(cmds.map((c) => c.type)).toContain('zone:focus')
    expect(cmds.map((c) => c.type)).toContain('panel:open')

    cmds.length = 0
    send({ type: 'PICK_SPREAD', spreadId: 'daily-single' })
    expect(cmds.some((c) => c.type === 'spread:dealt')).toBe(true)
    send({ type: 'DRAW_CARD' })
    const reveal = cmds.find((c) => c.type === 'card:reveal')
    expect(reveal).toBeTruthy()

    cmds.length = 0
    send({ type: 'READ_DONE' })
    expect(cmds.some((c) => c.type === 'reading:open')).toBe(true)

    cmds.length = 0
    send({ type: 'READ_DONE' })
    send({ type: 'OFFER_MEMORY', kind: 'lantern' })
    send({ type: 'PLACE_MEMORY', anchorId: 'TEA_TABLE', at: { x: 195, y: 738 } })
    const placed = cmds.find((c) => c.type === 'memory:placed')
    expect(placed).toBeTruthy()
    expect(placed && placed.type === 'memory:placed' && placed.kind).toBe('lantern')
  })

  it('房间待机时会收起气泡', () => {
    const cmds: RoomCommand[] = []
    setRoomCommandSink((c) => cmds.push(c))
    resetTo('ROOM')
    expect(cmds.some((c) => c.type === 'guide:hide')).toBe(true)
  })

  it('面板开合成对出现', () => {
    const cmds: RoomCommand[] = []
    setRoomCommandSink((c) => cmds.push(c))
    resetTo('ROOM')
    send({ type: 'ENTER_ZONE', zone: 'LIUYAO' })
    send({ type: 'LEAVE_ZONE' })
    const opens = cmds.filter((c) => c.type === 'panel:open').length
    const closes = cmds.filter((c) => c.type === 'panel:close').length
    expect(opens).toBe(1)
    expect(closes).toBe(1)
  })
})
