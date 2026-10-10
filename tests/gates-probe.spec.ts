import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ===========================================================================
// 门禁探针：证明「门禁真的能拦住东西」
// ---------------------------------------------------------------------------
// 一道永远绿的门DFA 有两种可能：
//   ① 代码确实干净
//   ② 它从没被真正调用过 / 正则写错 / 路径没覆盖到
// 二者从 CI 日志上看**完全一样**，而 ② 比没有门禁更危险 ——
// 它提供的是虚假的安全感，让人在 M3 放肆加图。
//
// 所以这组测试专门做**负面用例**：丢一个违规样本进临时目录，跑门禁，
// 断言必须返回非 0。每条"能拦住"旁边都配一条"不许误报"（Q3）：
// 注释里写同样的字面量，门禁必须放行。
//
// 临时目录一律落在 os.tmpdir() 之外 —— 探针目录天生不在 src 下，
// 即使测试中断也不会污染仓库。
// ===========================================================================

const ROOT = path.resolve(__dirname, '..')
const GATES = path.join(ROOT, 'ci', 'gates')
let tmpDirs: string[] = []

function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaobu-gate-probe-'))
  tmpDirs.push(d)
  // 注意：这里返回的是 Node 能直接写文件的原始路径；门禁脚本本身按原生路径访问
  // 文件系统并自行做正斜杠规范化，所以传原生路径即可。
  return d
}

/** 跑门禁脚本，返回退出码。0 = 放行，非 0 = 阻断 */
function runGate(file: string, arg: string, env: NodeJS.ProcessEnv = {}): number {
  const script = path.join(GATES, file)
  try {
    execFileSync('node', [script, arg], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, ...env },
    })
    return 0
  } catch (e: unknown) {
    const err = e as { status?: number }
    return typeof err.status === 'number' ? err.status : 1
  }
}

afterEach(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
  tmpDirs = []
})

/** 造一个"字节很小但尺寸很大"的伪 PNG —— 专门验证「字节数骗人，像素不会」 */
function fakeLargePng(w: number, h: number): Buffer {
  const head = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8) // IHDR length
  Buffer.from('IHDR').copy(head, 12)
  head.writeUInt32BE(w, 16)
  head.writeUInt32BE(h, 20)
  return head
}

/**
 * 造一个伪 WebP（VP8X 变体）头，返回可写的 Buffer。
 * WebP 头：'RIFF' + 文件长 + 'WEBP' + 'VP8X' ... 画布宽高**减一**存 24 位小端（第 24..29 字节）。
 * 供门禁② 新增的"塔罗牌 ≤ 768px / WebP 总量 ≤ 2MB"探针使用。
 */
function fakeWebp(w: number, h: number): Buffer {
  const head = Buffer.alloc(32)
  Buffer.from('RIFF').copy(head, 0)
  head.writeUInt32LE(24, 4) // 后续块长（示意）
  Buffer.from('WEBP').copy(head, 8)
  Buffer.from('VP8X').copy(head, 12)
  // VP8X 的画布宽高 = 真实值减 1，24 位小端（只取低 24 位）
  head.writeUInt32LE((w - 1) & 0xffffff, 24)
  head.writeUInt32LE((h - 1) & 0xffffff, 27)
  return head
}

describe('门禁探针 · 每一道都必须真能拦住违规', () => {
  describe('门禁⑨ catch 内直出 UI', () => {
    it('拦住：catch 后紧跟 alert()', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        ['try {', '  doThing()', '} catch (e) {', '  alert(String(e))', '}', ''].join('\n'),
      )
      expect(runGate('09-no-ui-in-catch.mjs', d)).not.toBe(0)
    })

    it('拦住：catch 后第 10 行才出 Toast（窗口仍未过期）', () => {
      const d = mkTmp()
      const lines = ['try {', '  x()', '} catch (e) {']
      for (let i = 0; i < 9; i += 1) lines.push(`  const pad${i} = ${i}`)
      lines.push('  Toast.fail("网络好像走神了")', '}', '')
      fs.writeFileSync(path.join(d, 'bad.ts'), lines.join('\n'))
      expect(runGate('09-no-ui-in-catch.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：注释里写明这条禁令，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        [
          '// 门禁⑨：catch 内只记日志。绝无 alert / 弹窗 / 红色感叹号。',
          'try {',
          '  y()',
          '} catch (e) {',
          '  logger.warn("degraded", e)',
          '}',
          '',
        ].join('\n'),
      )
      expect(runGate('09-no-ui-in-catch.mjs', d)).toBe(0)
    })
  })

  describe('门禁⑬ 存储收口', () => {
    it('拦住：偷用 indexedDB', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'bad.ts'), "const db = indexedDB.open('xiaobu')\n")
      expect(runGate('13-no-idb.mjs', d)).not.toBe(0)
    })

    it('拦住：绕开收口直接碰 localStorage', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'bad.ts'), "localStorage.setItem('k', 'v')\n")
      expect(runGate('13-no-idb.mjs', d)).not.toBe(0)
    })

    it('拦住：sessionStorage（记忆必须活过两次启动）', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'bad.ts'), "sessionStorage.setItem('k', 'v')\n")
      expect(runGate('13-no-idb.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：注释里逐条解释禁令，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        [
          '// 全仓不许出现 indexedDB / IDBFactory；localStorage 只允许',
          '// src/store/localStore.ts 一处；sessionStorage 一律不许。',
          'export const ok = 1',
          '',
        ].join('\n'),
      )
      expect(runGate('13-no-idb.mjs', d)).toBe(0)
    })
  })

  describe('门禁⑥ 核心逻辑不得反向依赖天气', () => {
    it('拦住：核心层 import 了 WeatherSnapshot', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        "import type { WeatherSnapshot } from '@services/weather'\n",
      )
      expect(runGate('06-weather-oneway.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：注释里说明依赖方向，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        [
          '// 这里绝不 import WeatherSnapshot —— 天气只能流向氛围层，',
          '// 绝不能反过来影响任何一次占卜的结果。',
          'export const pure = true',
          '',
        ].join('\n'),
      )
      expect(runGate('06-weather-oneway.mjs', d)).toBe(0)
    })
  })

  describe('门禁⑦ 监控载荷无隐私', () => {
    it('拦住：把经纬度写进上报体', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'index.ts'),
        'export const lat: number = 39.9\nexport const lng: number = 116.4\n',
      )
      expect(runGate('07-track-payload.mjs', d, { TRACK_SRC: d })).not.toBe(0)
    })

    it('拦住：把整个 payload 展开进上报体（最典型的偷懒）', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'index.ts'), 'push({ name: "ERROR", ...payload })\n')
      expect(runGate('07-track-payload.mjs', d, { TRACK_SRC: d })).not.toBe(0)
    })

    it('Q3 不误报：注释里列出禁用字段名，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'index.ts'),
        [
          '// 载荷禁止出现 prompt / completion / transcript / lat / lng / city',
          'export interface TrackEvent { name: string; ok: 0 | 1 }',
          '',
        ].join('\n'),
      )
      expect(runGate('07-track-payload.mjs', d, { TRACK_SRC: d })).toBe(0)
    })
  })

  describe('门禁⑤ 天气 Key 不得进产物', () => {
    it('拦住：源码里写了和风 Header', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        "headers: { 'X-QW-Api-Key': k }\nfetch('https://devapi.qweather.com/v7/weather/now')\n",
      )
      expect(runGate('05-no-weather-key.mjs', d)).not.toBe(0)
    })

    it('拦住：32 位十六进制疑似 Key', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        "const cfg = { apiKey: '0123456789abcdef0123456789abcdef' }\n",
      )
      expect(runGate('05-no-weather-key.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：注释里说明禁止项，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        ["// 禁止 X-QW-Api-Key 或 devapi.qweather 出现在客户端\n", 'export const ok = 1'].join('\n'),
      )
      expect(runGate('05-no-weather-key.mjs', d)).toBe(0)
    })
  })

  describe('门禁⑧ config 无密钥', () => {
    it('拦住：config.json 出现 cdnSecret', () => {
      const d = mkTmp()
      fs.mkdirSync(path.join(d, 'config'), { recursive: true })
      fs.writeFileSync(
        path.join(d, 'config', 'config.json'),
        JSON.stringify({ schemaVersion: 3, cdnSecret: 'abcd0123-abcd-0123' }, null, 2),
      )
      expect(runGate('08-no-key-in-config.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：正常开关 / 数值 / URL 必须放行', () => {
      const d = mkTmp()
      fs.mkdirSync(path.join(d, 'config'), { recursive: true })
      fs.writeFileSync(
        path.join(d, 'config', 'config.json'),
        JSON.stringify(
          { schemaVersion: 3, weather: { enabled: true }, assets: { cdnBase: 'https://cdn.xiaobu.app/s' } },
          null,
          2,
        ),
      )
      expect(runGate('08-no-key-in-config.mjs', d)).toBe(0)
    })
  })

  describe('门禁③ 四季素材不得进主包', () => {
    it('拦住：静态 import 了秋季资源', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        "import autumnFloor from './assets/scene/autumn/floor.png'\n",
      )
      expect(runGate('03-no-season-leak.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：注释里规划四季策略，必须放行', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        ['// 四季资源走 CDN 按需拉取，主包只带 spring 与通用层', 'export const ok = 1', ''].join('\n'),
      )
      expect(runGate('03-no-season-leak.mjs', d)).toBe(0)
    })
  })

  describe('门禁④ 无引擎残留', () => {
    it('拦住：import 了 three', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'bad.ts'), "import * as THREE from 'three'\n")
      expect(runGate('04-no-engine-residue.mjs', d)).not.toBe(0)
    })

    it('Q3 不误报：变量名含 three 但不是包引用', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'ok.ts'),
        'export const threeCoins = 3\nexport const thresholdMax = 10\n',
      )
      expect(runGate('04-no-engine-residue.mjs', d)).toBe(0)
    })

    it('Q3b 不误报：数据字面量 "three" / "p5" 不是包引用', () => {
      const d = mkTmp()
      // 塔罗小阿卡纳阶位名 'three'、画布名 'p5' 都是纯数据，不是引擎
      fs.writeFileSync(
        path.join(d, 'cards.ts'),
        "const RANKS = ['ace', 'two', 'three', 'four']\nconst TOOLS = ['p5', 'sketch']\n",
      )
      expect(runGate('04-no-engine-residue.mjs', d)).toBe(0)
    })

    it('Q3c 仍拦住：子路径 import（three/examples/…）', () => {
      const d = mkTmp()
      fs.writeFileSync(
        path.join(d, 'bad.ts'),
        "import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'\n",
      )
      expect(runGate('04-no-engine-residue.mjs', d)).not.toBe(0)
    })
  })

  describe('门禁② 位图资产（M3 主防线）', () => {
    // ★ 探针一律落在**临时目录**，不往 src/ 里写文件。
    //   曾经把探针 PNG 写进 src/assets/__probe__/，结果：
    //   ① 测试过程修改了仓库 —— 跑一半失败就会留下垃圾；
    //   ② 清理时要递归删目录，动作重且容易残留。
    //   → 门禁② 支持 SCAN_ROOTS / WHITELIST 覆写，探针指到临时目录即可，
    //     临时目录由外层 afterEach 统一收拾。
    it('拦住：4096² 纯色 PNG —— 字节只有 24B，解码却是 64 MB 内存', () => {
      const d = mkTmp()
      const f = path.join(d, 'probe-oversize.png')
      fs.writeFileSync(f, fakeLargePng(4096, 4096))
      expect(fs.statSync(f).size).toBeLessThan(200 * 1024) // 证明字节查不出来
      expect(
        runGate('02-no-uncompressed-png.mjs', 'src', { SCAN_ROOTS: d }),
      ).not.toBe(0)
    })

    it('拦住：合规尺寸但未登记', () => {
      const d = mkTmp()
      fs.writeFileSync(path.join(d, 'probe-ok.png'), fakeLargePng(256, 256))
      expect(runGate('02-no-uncompressed-png.mjs', 'src', { SCAN_ROOTS: d })).not.toBe(0)
    })

    it('放行：合规尺寸且已登记入白名单', () => {
      const d = mkTmp()
      const f = path.join(d, 'probe-ok.png')
      fs.writeFileSync(f, fakeLargePng(256, 256))
      fs.writeFileSync(path.join(d, 'whitelist.txt'), '# probe\n' + f + '\n')
      expect(
        runGate('02-no-uncompressed-png.mjs', 'src', {
          SCAN_ROOTS: d,
          WHITELIST: path.join(d, 'whitelist.txt'),
        }),
      ).toBe(0)
    })

    it('拦住：塔罗牌单边超 768px（即使字节很小、且已登记）', () => {
      const d = mkTmp()
      // 目录名含 "tarot" → 触发塔罗专属约束
      const tarotDir = path.join(d, 'assets', 'tarot')
      fs.mkdirSync(tarotDir, { recursive: true })
      const f = path.join(tarotDir, 'back.webp')
      fs.writeFileSync(f, fakeWebp(1024, 512)) // 单边 1024 > 768
      fs.writeFileSync(path.join(d, 'whitelist.txt'), '# probe\n' + f + '\n')
      expect(
        runGate('02-no-uncompressed-png.mjs', 'src', {
          SCAN_ROOTS: d,
          WHITELIST: path.join(d, 'whitelist.txt'),
        }),
      ).not.toBe(0)
    })

    it('放行：塔罗牌 ≤ 768px 且 ≤ 100KB 且已登记', () => {
      const d = mkTmp()
      const tarotDir = path.join(d, 'assets', 'tarot')
      fs.mkdirSync(tarotDir, { recursive: true })
      const f = path.join(tarotDir, 'back.webp')
      fs.writeFileSync(f, fakeWebp(512, 768)) // 合规
      fs.writeFileSync(path.join(d, 'whitelist.txt'), '# probe\n' + f + '\n')
      expect(
        runGate('02-no-uncompressed-png.mjs', 'src', {
          SCAN_ROOTS: d,
          WHITELIST: path.join(d, 'whitelist.txt'),
        }),
      ).toBe(0)
    })

    it('拦住：WebP 总量超 2MB 聚合红线（压小上限触发）', () => {
      const d = mkTmp()
      // 三张合规 WebP，每张 2KB（32B 头 + 填充），总量 6KB；上限压到 1KB 必超
      for (let i = 0; i < 3; i += 1) {
        const buf = fakeWebp(512, 768)
        const padded = Buffer.concat([buf, Buffer.alloc(2048)]) // 让字节真实存在
        fs.writeFileSync(path.join(d, `card-${i}.webp`), padded)
      }
      fs.writeFileSync(path.join(d, 'whitelist.txt'), '# probe\n' + d + '\n')
      // 把总量上限压到 1KB，三张 WebP（共 6KB）必然超
      expect(
        runGate('02-no-uncompressed-png.mjs', 'src', {
          SCAN_ROOTS: d,
          WHITELIST: path.join(d, 'whitelist.txt'),
          WEBP_TOTAL_MAX_KB: '1',
        }),
      ).not.toBe(0)
    })
  })

  describe('门禁① 包体增量预算', () => {
    it('放行：当前 dist 在校准过的基线内', () => {
      expect(runGate('01-bundle-size.mjs', 'src')).toBe(0)
    })

    it('拦住：把增量上限压到 1 KB 后，任何增长都应被抓住', () => {
      const before = runGate('01-bundle-size.mjs', 'src')
      expect(before).toBe(0)
      // 降低门槛 —— 证明这道门不是"永远 true"，它真的在比数字
      expect(runGate('01-bundle-size.mjs', 'src', { DIST_MAX_KB: '1' })).not.toBe(0)
    })
  })
})
