#!/usr/bin/env node
// ===========================================================================
// 小卜 · 门禁 ⑥   禁核心逻辑反向依赖天气模块   .sh 的等价 Node 移植
// 用法：node ci/gates/06-weather-oneway.mjs [src]
//   $SRC 为 src/./src 时扫固定的核心目录列表；否则把 $SRC 整体当核心域扫描。
// 退出码：0 = 放行，非 0 = 阻断
// ===========================================================================
import { isDir, listFiles, scanCode } from './lib.mjs'

const SRC = process.argv[2] ?? 'src'
let FAIL = 0

const CORE_DIRS =
  SRC === 'src' || SRC === './src'
    ? [
        'src/core',
        'src/services/llm',
        'src/services/tarot',
        'src/services/liuyao',
        'src/liuyao',
        'src/llm',
        'src/ritual',
        'src/health',
      ]
    : [SRC]

const RE_WEATHER = /weather(Store|Provider|Snapshot|Type)|WeatherSnapshot|NowWeatherPort|@services\/weather/

console.log('── 门禁⑥ 核心逻辑反向依赖扫描（天气必须只向氛围层流动）')

for (const d of CORE_DIRS) {
  if (!isDir(d)) continue
  const h = scanCode(d, RE_WEATHER)
  if (h.length > 0) {
    console.log(`✗ [门禁⑥] 核心逻辑 ${d} 里出现了天气依赖：`)
    for (const l of h) console.log(`    ${l}`)
    FAIL = 1
  } else {
    console.log(`  · ${d} 干净`)
  }
}

// 正向校验：氛围层是否存在（只是提示，不影响退出码）
const ambienceFound = listFiles(`${SRC}/scene`, {}).some(({ display }) => /ambience/.test(display))
if (ambienceFound) {
  console.log('  · 氛围层存在 ✓（天气的唯一合法去处）')
} else {
  console.log('  · 提示：尚未发现独立的氛围层文件，天气一旦接入请落在 src/scene 下')
}

if (FAIL === 0) {
  console.log('✓ [门禁⑥] 依赖方向正确：天气 → 氛围层，核心决策逻辑零感知')
} else {
  console.log('')
  console.log('修复方式：')
  console.log('  · 需要氛围：由 scene 层订阅，把结果转成光色 / 粒子参数再传进去')
  console.log('  · 需要降级：把降级码传成数值（1/2/3），不要传 WeatherSnapshot 对象')
  console.log('  · 永远不要让"今天下雨"改变任何一次占卜的结果')
}
process.exit(FAIL)
