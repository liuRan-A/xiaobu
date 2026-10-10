/**
 * §R 真机回归 · 可在 Node 内复现的部分   tests/r-regression.spec.ts
 * ===========================================================================
 * 《开发验收清单》§R 的 R1–R14 是双端真机走查项。但其中大部分判据本质上是
 * 「引擎状态应有的样子」，完全可以在确定性时间源下用断言钉住。
 *
 * 为什么要再做一遍（而不是照抄 §R）：
 *   手动走查的价值在于发现**只有真机能暴露**的问题 —— 掉帧、OOM、权限弹窗、
 *   手感摸起来不对、真实空网格     下的表现。而"流程能不能走到头"、
 *   "该在的数据在不在"、"连点会不会乱"这些，交给机器更可靠：
 *   人会把第 9 次重复操作跳过，机器不会。§R 保留给人做机器做不到的事。
 *
 * 覆盖矩阵（「自动」= 本文件已钉住；「仅真机」= 必须手动，见《§R 真机回归测试清单》）
 *   R1 自动   R2 自动   R3 自动   R4 自动   R5 自动   R6 自动   R7 自动
 *   R8 自动   R10 自动(等价压力)  R12 自动  R13 自动  R14 自动(静态确权)
 *   R9 / R11 —— 依赖网络与画质降级实现，届时接入后补
 *
 * ★ 全部用注入式 now：真机上的"十分钟后""隔天"在这里是几次 tick。
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest'
import { Engine } from '@core/engine'
import type { EngineHit } from '@core/engine'
import { createMemoryPort, PERSIST_KEYS } from '@core/persist'
import type { MemoryItem } from '@core/memory/memoryAnchor'
import { GestureRecognizer } from '@core/gesture'

const T = 1_800_000_000_000

function mkEngine(opts: {
  seed?: Record<string, unknown>
  hitTest?: (p: { x: number; y: number }) => EngineHit
} = {}) {
  let now = T
  const engine = new Engine({
    port: createMemoryPort(opts.seed ?? {}),
    now: () => now,
    hitTest: opts.hitTest,
  })
  const advance = (ms = 16) => {
    now += ms
    engine.tick(now)
  }
  return { engine, advance }
}

/** 已看过首启引导 —— 跳过 GUIDE 直达 ROOM */
const SEEN_GUIDE = { [PERSIST_KEYS.guide]: ['FIRST_LAUNCH'] }

/** 本地那一天的 yyyy-MM-dd */
function ymdOf(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ───────────────────────────────────────────────────────────────────────────

describe('R1 · 首启引导：两句说完自己淡出，绝不出现按钮', () => {
  it('全新用户 boot 后进 GUIDE，且气泡自带自动隐藏（⇒ 无需点击）', async () => {
    const { engine } = mkEngine()
    await engine.boot()
    expect(engine.roomState).toBe('GUIDE')

    const snap = engine.snapshot()
    expect(snap.guide).not.toBeNull()
    // ★ autoHideMs > 0 就是"没有按钮"的机器判据：
    //   需要用户点「下一步」的引导，这个值会是 0。
    expect(snap.guide!.autoHideMs).toBeGreaterThan(0)
    expect(snap.guide!.text.length).toBeGreaterThan(0)
  })

  it('推进足够时间后自动淡出到 ROOM —— 全程零次 pointerDown', async () => {
    const { engine, advance } = mkEngine()
    await engine.boot()
    expect(engine.roomState).toBe('GUIDE')

    // 一口气往前走 30 秒，中间一次都不碰屏幕
    for (let i = 0; i < 60; i += 1) advance(500)
    expect(engine.roomState).toBe('ROOM')
    expect(engine.snapshot().guide).toBeNull()
  })

  it('★ 引导文案不得出现"下一步 / 我知道了 / 确定"这类按钮话术', async () => {
    const { engine, advance } = mkEngine()
    await engine.boot()
    const seen: string[] = []
    const first = engine.snapshot().guide
    if (first) seen.push(first.text)
    for (let i = 0; i < 20; i += 1) {
      advance(500)
      const g = engine.snapshot().guide
      if (g) seen.push(g.text)
    }
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) {
      expect(s).not.toMatch(/下一步|我知道了|确定|开始体验|去设置|立即/)
    }
  })
})

describe('R2 · 塔罗闭环：选牌阵 → 翻牌 → 解读 → 带走 → 亲手放下', () => {
  it('整条链路状态依次可达，收尾回到 ROOM 且记忆落位', async () => {
    const { engine, advance } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()
    expect(engine.roomState).toBe('ROOM')

    engine.enterZone('TAROT')
    expect(engine.roomState).toBe('SPREAD_PICK')

    engine.pickSpread('past-present-future')
    expect(engine.roomState).toBe('SPREAD_DRAW')

    const need = engine.snapshot().spreads.count
    expect(need).toBeGreaterThan(0)
    for (let i = 0; i < need; i += 1) {
      engine.drawCard()
      advance()
    }
    // ★ 第一次 readDone = 抽完牌、开始看解读；第二次 = 解读看完、愿意带走一件。
    //   两级设计是为了让"正在读"期间不被塞东西 —— 对应 §R 的 R7。
    engine.readDone()
    expect(engine.roomState).toBe('READING')
    engine.readDone()
    expect(engine.roomState).toBe('MEMORY_OFFER')

    engine.offerMemory('plant')
    expect(engine.roomState).toBe('MEMORY_PLACE')

    engine.placeMemoryAt({ x: 200, y: 300 })
    expect(engine.roomState).toBe('ROOM')
    expect(engine.snapshot().memory.items.length).toBe(1)
  })
})

describe('R3 · 六爻闭环：选心情 → 选方向 → 放置 → 掷币 → 解读', () => {
  it('整条链路状态依次可达，卦象进快照', async () => {
    const { engine } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()

    engine.enterZone('LIUYAO')
    expect(engine.roomState).toBe('MOOD_PICK')

    engine.pickMood('CALM')
    expect(engine.roomState).toBe('FOCUS_PICK')

    engine.pickFocus('CAREER')
    expect(engine.roomState).toBe('PLACE_ITEM')

    engine.placeItem('CENSER_SIDE', { x: 240, y: 320 })
    expect(engine.snapshot().liuyao.placed).toBe(true)

    engine.castDone({ primary: 1, changed: 2, moving: [1] })
    expect(engine.snapshot().hexagram).not.toBeNull()
    expect(engine.roomState).toBe('READING')
  })
})

describe('R4 · 拖到空地松手：就地放下，且不给任何提示', () => {
  it('placeItem(null) 视为就地放下 —— 不抛错、不弹提示、流程继续', async () => {
    const { engine } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()
    engine.enterZone('LIUYAO')
    engine.pickMood('TIRED')
    engine.pickFocus('STUDY')
    expect(engine.roomState).toBe('PLACE_ITEM')

    expect(() => engine.placeItem(null, { x: 999, y: 999 })).not.toThrow()
    const snap = engine.snapshot()
    expect(snap.liuyao.placed).toBe(true)

    // ★ "无任何提示"的机器判据：就算有引导气泡，也必须是**自动消隐**的
    //   （autoHideMs > 0 = 不等用户点）。需要用户交互的提示在这里会被抓住。
    if (snap.guide) {
      expect(snap.guide.autoHideMs).toBeGreaterThan(0)
      expect(snap.guide.text).not.toMatch(/失败|出错|重试|不对|wrong failed/i)
    }
  })
})

describe('R5 · 低语卡：点另一个摆件直接切换（不经退场再进场）', () => {
  const item = (id: string, kind: MemoryItem['kind']): MemoryItem => ({
    id,
    createdAt: T,
    readAt: new Date(2026, 9, 10, 12, 0, 0).getTime(),
    kind,
    source: { kind: 'liuyao', hexagram: 12, focus: 'CAREER' },
    tone: 'HOPEFUL',
    note: '',
    anchorId: null,
    at: { x: 100, y: 200 },
  })

  it('切换後内容即时换成另一件，且浮现卡重新走淡入', async () => {
    const seed: Record<string, unknown> = {
      ...SEEN_GUIDE,
      [PERSIST_KEYS.memory]: [item('m1', 'plant'), item('m2', 'stone')],
    }
    const { engine, advance } = mkEngine({ seed })
    await engine.boot()

    engine.recallMemory('m1')
    expect(engine.snapshot().memory.recall).not.toBeNull()
    const first = engine.snapshot().memory.recall!.itemName
    advance(400)
    expect(engine.snapshot().memoryCard.phase).toBe('shown')

    engine.recallMemory('m2')
    const second = engine.snapshot().memory.recall!.itemName
    expect(second).not.toBe(first)
    // ★ 直接回到 appearing（重新淡入），而不是硬切成 hidden
    expect(engine.snapshot().memoryCard.phase).toBe('appearing')
  })
})

describe('R6 · 倒计时设为「今天」→ 立刻收到纪念品', () => {
  it('目标日 = 今天 ⇒ 归零成立，且给出纪念品 offer', async () => {
    const { engine, advance } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()

    expect(engine.setCountdown({ title: '出发的日子', target: ymdOf(T) })).toBe(true)
    for (let i = 0; i < 10; i += 1) advance(16)

    const snap = engine.snapshot()
    expect(snap.countdown.arrivedCount).toBeGreaterThan(0)
    expect(snap.memory.offers.length + snap.memory.items.length).toBeGreaterThan(0)
  })
})

describe('R7 · 读到一半归零：不打断阅读，数据上却已到点', () => {
  it('READING 期间坐等到时，不会被强行切到 COUNTDOWN_DUE', async () => {
    const { engine, advance } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()
    engine.enterZone('TAROT')
    engine.pickSpread('past-present-future')
    for (let i = 0; i < engine.snapshot().spreads.count; i += 1) engine.drawCard()
    engine.readDone()
    expect(engine.roomState).toBe('READING')

    engine.setCountdown({ title: '那天', target: ymdOf(T) })
    for (let i = 0; i < 20; i += 1) advance(16)

    // ★ 正在解读 ≠ 被通知打断
    expect(engine.roomState).not.toBe('COUNTDOWN_DUE')
    expect(engine.snapshot().countdown.arrivedCount).toBeGreaterThan(0)
  })
})

describe('R8 · 杀进程重启：数据都在，且纪念品不重发', () => {
  it('同一份 port 重开引擎：倒计时条数不变，赠品不翻倍', async () => {
    const port = createMemoryPort({ ...SEEN_GUIDE })
    let now = T

    const e1 = new Engine({ port, now: () => now })
    await e1.boot()
    e1.setCountdown({ title: '那天', target: ymdOf(T) })
    for (let i = 0; i < 10; i += 1) {
      now += 16
      e1.tick(now)
    }
    const before = e1.snapshot()
    expect(before.countdown.arrivedCount).toBeGreaterThan(0)
    await e1.flush()

    // ── 重启 ──
    const e2 = new Engine({ port, now: () => now })
    await e2.boot()
    for (let i = 0; i < 10; i += 1) {
      now += 16
      e2.tick(now)
    }
    const after = e2.snapshot()

    expect(after.countdown.items.length).toBe(before.countdown.items.length)
    // ★ 同一天再触发，条目数不许增长 —— 这就是"不重发"
    expect(after.memory.items.length + after.memory.offers.length).toBeLessThanOrEqual(
      before.memory.items.length + before.memory.offers.length,
    )
  })
})

describe('R10 · 连续操作不泄漏（真机"连玩 10 分钟"的低配等价物）', () => {
  it('2000 轮进出分区 + tick：countdown / memory 条数不增长，待写不堆积', async () => {
    let now = T
    const port = createMemoryPort(SEEN_GUIDE)
    const engine = new Engine({ port, now: () => now })
    await engine.boot()

    const base = engine.inspect()
    for (let i = 0; i < 2000; i += 1) {
      engine.enterZone(i % 2 === 0 ? 'TAROT' : 'LIUYAO')
      engine.leaveZone()
      now += 16
      engine.tick(now)
    }
    const after = engine.inspect()

    expect(after.countdown).toBe(base.countdown)
    expect(after.memory).toBe(base.memory)
    expect(after.pendingWrites).toBeGreaterThanOrEqual(0)
    // 写预算必须真的把积压缩住 —— 这是"不卡低端机"的前提
    expect(after.pendingWrites).toBeLessThan(50)
  })
})

// ★ 房间里有分区：点在不同坐标会进不同流程（这是**有意**设计了区游戏：谁贴在谁身上）。
//   所以 R12 验的不是"点了必须没反应"，而是**幂等与无错乱** ——
//   选一个落在所有分区之外的中性坐标来测"纯误触"。
const NEUTRAL = { x: 8, y: 8 }

describe('R12 · 手掌误触 / 多指乱划 / 快速连点：状态不错乱', () => {
  it('同一位置狂点 50 次：状态收敛且第 51 次不再变化（幂等锁生效）', async () => {
    const { engine } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()

    for (let i = 0; i < 50; i += 1) {
      engine.pointerDown({ id: 0, ...NEUTRAL, t: 1_000 + i })
      engine.pointerUp({ id: 0, ...NEUTRAL, t: 1_000 + i + 5 })
    }
    const settled = engine.roomState

    // 再点一次：状态必须不变 —— 这才是"幂等"的机器判据
    engine.pointerDown({ id: 0, ...NEUTRAL, t: 9_000 })
    engine.pointerUp({ id: 0, ...NEUTRAL, t: 9_005 })
    expect(engine.roomState).toBe(settled)

    // 且没有产出任何垃圾数据
    const ins = engine.inspect()
    expect(ins.memory).toBe(0)
    expect(ins.countdown).toBe(0)
  })

  it('多指按下 + 中途取消：不残留孤儿指针，之后的单次点击仍正常', async () => {
    const { engine } = mkEngine({ seed: SEEN_GUIDE })
    await engine.boot()

    engine.pointerDown({ id: 0, ...NEUTRAL, t: 1_000 })
    engine.pointerDown({ id: 1, x: 400, y: 400, t: 1_005 })
    engine.pointerMove({ id: 0, x: 60, y: 60, t: 1_010 })
    engine.pointerUp({ id: 1, x: 400, y: 400, t: 1_020 })
    engine.pointerCancel(1_030)

    // 取消之后，一次普通轻点必须还能正常处理（不卡死、不吞事件）
    expect(() => {
      engine.pointerDown({ id: 0, ...NEUTRAL, t: 2_000 })
      engine.pointerUp({ id: 0, ...NEUTRAL, t: 2_050 })
    }).not.toThrow()
    expect(engine.snapshot().room).toBeDefined()
  })
})

describe('R13 · 横着划一下：币不能飞出去（方向不够「往上」不算掷）', () => {
  /**
   * 用真实识别器跑一次"快速甩 + 松手"。
   * ★ 必须给**多个** move 采样：速度是按采样窗口估算的，只有一次 move
   *   算不出稳定速度，RELEASE 事件压根不会产生 —— 那会让测试假通过。
   */
  function swipe(dx: number, dy: number) {
    const rec = new GestureRecognizer()
    rec.down({ id: 0, x: 200, y: 400, t: 1_000 })
    for (let i = 1; i <= 4; i += 1) {
      rec.move({ id: 0, x: 200 + (dx * i) / 4, y: 400 + (dy * i) / 4, t: 1_000 + i * 15 })
    }
    const ups = rec.up({ id: 0, x: 200 + dx, y: 400 + dy, t: 1_060 })
    return ups[ups.length - 1]
  }

  it('横向甩动不判为 fling（夹角超过 RELEASE_ANGLE_MAX）', () => {
    const rel = swipe(140, 2) // 几乎纯横向
    expect(rel).toBeDefined()
    expect(rel!.angleFromVerticalDeg).toBeGreaterThan(40)
    expect(rel!.fling).toBe(false)
  })

  it('向上甩动判为 fling', () => {
    const rel = swipe(10, -140) // 竖直往上
    expect(rel).toBeDefined()
    expect(rel!.angleFromVerticalDeg).toBeLessThan(40)
    expect(rel!.fling).toBe(true)
  })
})

describe('R14 · 悬浮球：不得申请系统级悬浮窗权限', () => {
  it('capacitor 配置与 AndroidManifest 都不含 SYSTEM_ALERT_WINDOW', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '..')

    const cfg = path.join(root, 'capacitor.config.ts')
    expect(fs.existsSync(cfg)).toBe(true)
    expect(fs.readFileSync(cfg, 'utf8')).not.toMatch(/SYSTEM_ALERT_WINDOW/)

    const manifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
    if (fs.existsSync(manifest)) {
      expect(fs.readFileSync(manifest, 'utf8')).not.toMatch(/SYSTEM_ALERT_WINDOW/)
    }
  })
})
