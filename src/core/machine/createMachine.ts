/**
 * 小卜 · 极简状态机内核   src/core/machine/createMachine.ts
 * ---------------------------------------------------------------------------
 * 约 90 行，零依赖，不引 xstate —— 因为我们要的东西太少，而包体预算太紧（≤ 30 MB）。
 * 它必须能在纯 node 环境里跑（无 DOM、无 Vue、无 Capacitor），这样：
 *   ① ritualMachine / devModeMachine 可以直接单测
 *   ② CI 里不用起浏览器就能跑全量状态迁移断言
 *
 * ★ 三个设计立场（写进单测）：
 *   1. 非法转移**只记 warn**，回最近合法态，绝不产生用户可见反馈
 *   2. 未声明的事件**静默忽略**（弱网 / 误触下会收到各种奇怪事件）
 *   3. 迁移过程中抛异常**不冒泡**，状态停在原地（catch 内不许出 UI，门禁 ⑨）
 * ---------------------------------------------------------------------------
 */

export interface Vec2 {
  x: number
  y: number
}

export type Transition<S extends string, C, E> = S | ((ctx: C, event: E) => S)

/**
 * ★ 从事件联合里按 `type` 取出对应的那一个成员。
 *   没有它，`on.DRAG` 的处理器收到的会是**整个联合**，`e.point` 会报
 *   "Property 'point' does not exist on type '{ type: "LONG_PRESS"; ... }'"。
 *   有了它，处理器里的 `e` 自动收窄到该事件，既省掉手写类型断言，
 *   也让"写错事件字段名"从运行时 bug 变成编译期错误。
 */
export type EventOf<E extends { type: string }, K extends string> = Extract<E, { type: K }>

export interface StateNode<S extends string, C, E extends { type: string }> {
  /** 进入该态时的副作用（只做数据与场景指令，不做 UI 决定） */
  entry?: (ctx: C, event: E) => void
  /** 离开该态时的清理 */
  exit?: (ctx: C, event: E) => void
  /**
   * 事件 → 下一态（或决定下一态的函数）。
   * ★ 键必须是事件联合里的 `type` 字面量；处理器收到的 event 已按 type 收窄。
   */
  on?: { [K in E['type']]?: Transition<S, C, EventOf<E, K>> }
  /** 自动迁移：{ 毫秒: 目标态 } —— 用来自动收回（如 ARMED 60s 过期） */
  after?: Record<number, S>
}

export interface MachineConfig<S extends string, C, E extends { type: string }> {
  initial: S
  states: Record<S, StateNode<S, C, E>>
  ctx: C
  /**
   * ★ 可选的初始上下文工厂。
   *
   * 不提供它时，`ctx` 是**模块级单例**：`createMachine` 只在配置对象求值时建一次 ctx，
   * 之后所有 `send` 都在原地改它。这在真机上没问题（进程里就一台机器），
   * 但在**单测里会串味** —— 上一个用例拖出来的 `ctx.lines` 会留给下一个用例，
   * 表现为"单跑绿、连跑红"，而且看起来像是状态机的转移写错了。
   *
   * 提供它之后，`reset()` 会把 ctx 复位到工厂产出的新值。
   * 每建一台新机器（或每个用例）先 `reset()` 一次，就是干净的。
   */
  initialCtx?: () => C
  /** 只记日志；默认 console.warn（由 main.ts 侧统一收敛到 logger） */
  onWarn?: (msg: string, detail?: unknown) => void
}

export interface Machine<S extends string, C, E extends { type: string }> {
  readonly state: S
  readonly ctx: C
  /** 该态是否声明了某事件 —— 用于测试断言，不参与运行时判断 */
  accepts(eventType: string): boolean
  send(event: E): S
  /** 仅测试用：重置回初始态 */
  reset(): S
}

export function createMachine<S extends string, C, E extends { type: string }>(
  config: MachineConfig<S, C, E>,
): Machine<S, C, E> {
  let current: S = config.initial
  let timers: Array<ReturnType<typeof setTimeout>> = []

  const warn = (msg: string, detail?: unknown): void => {
    if (config.onWarn) config.onWarn(msg, detail)
  }

  function clearTimers(): void {
    for (const t of timers) clearTimeout(t)
    timers = []
  }

  function enter(state: S, event: E): void {
    const node = config.states[state]
    if (!node) return

    try {
      node.entry?.(config.ctx, event)
    } catch (e) {
      // ★ 立场 3：entry 抛异常不许冒泡。状态已迁到位，副作用缺失由调用方兜底。
      // ★ 门禁 ⑨：catch 内不许出 UI。
      warn(`entry() threw in "${state}"`, e)
    }

    for (const [msRaw, next] of Object.entries(node.after ?? {})) {
      const ms = Number(msRaw)
      const timer = setTimeout(() => {
        timers = timers.filter((t) => t !== timer)
        goTo(next, event)
      }, ms)
      timers.push(timer)
    }
  }

  function goTo(next: S, event: E): void {
    if (!config.states[next]) {
      warn(`unknown state "${next}", ignored`, event)
      return
    }
    clearTimers()

    try {
      config.states[current]?.exit?.(config.ctx, event)
    } catch (e) {
      warn(`exit() threw in "${current}"`, e) // ★ 门禁 ⑨
    }

    current = next
    enter(current, event)
  }

  function send(event: E): S {
    const node = config.states[current]
    // ★ 取值时把 on 视作宽表：映射类型让 on[K] 的入参是"按 K 收窄后的 E"，
    //   而按 event.type 动态取值时 TS 无法用字面量去索引。
    //   安全性由"键必须来自 E['type']"这条约束保证（见 StateNode.on 的类型）——
    //   写错事件名在 config 里就是编译错误，运行时不可能取到一个不存在的键。
    const on = node?.on as Record<string, Transition<S, C, E>> | undefined
    const handler = on?.[event.type]

    // ★ 立场 2：未声明的事件静默忽略 —— 不 warn、不报错、不迁移
    if (handler === undefined) return current

    let next: S
    try {
      next = typeof handler === 'function' ? handler(config.ctx, event) : handler
    } catch (e) {
      // ★ 立场 1 + 3：转移函数自己抛了，就停在原地，只记一条 warn
      // ★ 门禁 ⑨：catch 内不许出 UI
      warn(`transition threw in "${current}" on "${event.type}"`, e)
      return current
    }

    if (!config.states[next]) {
      warn(`illegal target "${next}" from "${current}"`, event)
      return current
    }

    if (next !== current) goTo(next, event)
    return current
  }

  // 初始 entry（含初始态的 after 定时器）
  enter(current, { type: '$init' } as unknown as E)

  return {
    get state() {
      return current
    },
    ctx: config.ctx,
    accepts: (eventType: string) => {
      const on = config.states[current]?.on as Record<string, unknown> | undefined
      return on?.[eventType] !== undefined
    },
    send,
    reset: () => {
      clearTimers()
      current = config.initial
      // ★ 有工厂才复位 ctx；没有则保持旧行为（原地保留），免得改动影响未声明工厂的机器
      if (config.initialCtx) Object.assign(config.ctx as object, config.initialCtx())
      enter(current, { type: '$reset' } as unknown as E)
      return current
    },
  }
}
