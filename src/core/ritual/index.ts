/**
 * 小卜 · 仪式内核导出面   src/core/ritual/index.ts
 * ===========================================================================
 * 掷币仪式的**纯逻辑**都从这里出去：
 *
 *   · thresholds.ts   —— 阈值单一来源（规范 §2.2 + §3）
 *   · flight.ts       —— 抛物线 / 椭圆命中 / 弹跳（FlightSolver）
 *   · slotResolver.ts —— 最近中心点吸附（SlotResolver）
 *   · flightPlay.ts   —— 一帧该画什么：3 段拖尾 / 2 圈涟漪 / 自旋压缩（表现采样）
 *   · engine.ts       —— RitualEngine：把状态机、飞行、指令汇缝成一条时间线
 *
 * ★ 这五块都零依赖、不碰 DOM，所以能在 node 里对规范 §8.3 的用例做确定性断言。
 *   换句话说：**"手感"里最容易被写错的那部分，是可以被证明正确的**。
 *
 *   `engine.ts` 是最后补上的一块 —— 它把前三块的纯计算接到了状态机上，
 *   于是"这一帧画什么"与"什么时候算落定"也进了单测范围，
 *   而不是留在渲染层靠肉眼验收。
 *
 * ★ 一个刻意的分层：本目录**只管时间，不管像素**。
 *   所有美术坐标（铜钱的家、竹筒口、卦盘椭圆）都由场景层通过
 *   `RitualEngine.configure()` 喂进来。core 里出现 196 / 452 / 118 即为违规。
 * ===========================================================================
 */

export * from './thresholds'
export * from './flight'
export * from './slotResolver'
export * from './flightPlay'
export * from './engine'
