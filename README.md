# 小卜 · M1 工程脚手架

**里程碑 M1「骨架跑通」· 出口条件：真机冷启动 ≤ 1.8 s 看见黄昏小屋（飞行模式亦然）**

> 技术栈：Capacitor 6 + Vue3 + Pinia + Vite + TypeScript + **Canvas2D 自研渲染**（M1 不引 Spine）
> 目录契约：《小卜-代码工程目录结构规划.md》 §2
> 验收口径：《小卜-开发验收清单 v1.0 FREEZE》 §0 + §A

---

## 一、这个目录里有什么（M1 只需要这些）

| # | 文件 | 作用 | 依据 |
|---|---|---|---|
| 1 | `package.json` | 依赖与脚本；`npm run ci` 串起 lint + test + 门禁 | — |
| 2 | `vite.config.ts` | 别名 = 目录契约；`assetsInlineLimit: 0` 守包体 | 规划 §2 |
| 3 | `tsconfig.json` | `strict` + paths 别名；`resolveJsonModule` 读配置 | — |
| 4 | `capacitor.config.ts` | 原生壳配置；**背景色 `#FDF9F6`，无启动闪屏** | Checklist A2 |
| 5 | `index.html` | ★ 防崩第一道防线：JS 崩了也**不是白的**；暖色呼吸点遮罩 | Checklist §0 |
| 6 | `eslint.config.js` | 把"禁止清单"变成构建失败（core 零依赖 / 仪式机不认 devMode / 画面不碰 UI） | 规划 §3 |
| 7 | `src/main.ts` | 唯一入口：`bootSequence()` → `mount` → 全局兜底接住裸异常 | Checklist A3 |
| 8 | `src/App.vue` | 唯一根组件：canvas + overlay 两层，多一件都不做 | — |
| 9 | `src/config/config.json` | ★ 本地默认配置（**无密钥**） | 规划 §5 |
| 10 | `src/bootstrap/builtinConfig.ts` | 内置真源 + 校验 + 边界 clamp（四层兜底的最后两层） | Checklist A4–A6 |
| 11 | `src/bootstrap/bootSequence.ts` | ★ 启动时序：t=0 同步首帧 → 读缓存 → `void` 拉远端 | Checklist A2–A6 |
| 12 | `src/scene/Scene.vue` | Scene 空壳：铺满的 Canvas + 暖色底 + rAF + DPR + 前后台暂停 | 规划 §7 D2 |
| 13 | `src/core/machine/createMachine.ts` | 极简状态机内核（~90 行，零依赖，node 可跑） | 规划 §4 |
| 14 | `src/core/machine/ritualMachine.ts` | ★ 掷币四态机 IDLE→LIFT→TOSS→PLACE→CAST | 规划 §4.2 |
| 15 | `src/shared/errors/handle.ts` | ★ 全应用唯一错误出口 + **两条防崩红线标注** | 白皮书 §3 |
| 16 | `src/shared/logger.ts` | 生产只留 warn/error | 规划 §8 |
| 17 | `src/ui/styles/tokens.css` | 设计 Token，Canvas 与 DOM 共用一份 | 规划 §6 |
| 18 | `ci/gates/09-no-ui-in-catch.mjs` | 门禁 ⑨：catch 块禁止出 UI | Checklist I |
| 19 | `ci/gates/10-no-persist-queue.mjs` | 门禁 ⑩：禁止持久化上报队列 | Checklist I |
| 20 | `ci/gates/run-all.mjs` | 十四道门禁总闸 | 白皮书 §5 |

> **关于 `.ts` 而不是 `.js`**：目录契约（规划 §2）里定的是 `main.ts` / `ritualMachine.ts`，所以这里按契约走 TS。
> 类型在 `core/` 不是装饰 —— 状态机的非法迁移能在编译期就被挡掉一半。若你确实想先跑纯 JS，
> 把 `vue-tsc` 从 build 脚本摘掉、文件后缀改回 `.js` 即可，**目录位置和内容一个字都不用动**。
>
> **关于 `state-machine.js` 拆成两个文件**：内核 `createMachine.ts` 与仪式机 `ritualMachine.ts` 分开，
> 是因为 `isDevMode` 门禁机（规划 §4.1）要复用同一个内核 —— 内核必须与业务无关。

---

## 二、跑起来

```bash
# 1. 装依赖
npm install

# 2. Web 端开发（不开模拟器也能开发 / 调试）
npm run dev            # → http://localhost:5173

# 3. 类型检查 + 构建
npm run build

# 4. 交给原生壳
npx cap add android    # 首次
npm run cap:sync
npm run cap:android

# 5. CI（本地与线上同一套）：lint → 单测 → 十四道门禁
node ci/ci.mjs         # ★ 跨 shell 总入口，PowerShell / cmd / Git Bash 通用
```

> **Windows / PowerShell 用户看这里**：PowerShell 默认执行策略会拦下 `npm.ps1`
> （`running scripts is disabled on this system`），于是 `npm run ci` 在你的终端里可能压根起不来。
> 这不是门禁脚本的问题 —— 门禁本身就是零 shell 的 Node 脚本。**直接跑 `node ci/ci.mjs` 即可绕过**，
> 它等价于 `lint + test + gates` 三条命令串起来，且不依赖任何 shell 或 npm。
> （`npm run ci` 在能跑 npm 脚本的环境里依然可用，它现在就是转发到 `node ci/ci.mjs`。）

**M1 验收入口**：真机开**飞行模式**冷启动 → 必须在 1.8 s 内看到暖奶油底 + 木桌菱形的黄昏小屋，且**全程无白帧**。

### 解读后端（M3）：`server/`（FastAPI，**当前是桩响应**）

解读链路是「**先本地、再云端、失败回落本地**」。本地模板（`src/core/readingCopy.ts`）永远可用；
云端只是更好看的那一版，由 `server/` 提供 —— **不接也不影响任何功能**（断网照样可玩）。

```bash
# 6. 装后端依赖（一次性）
npm run server:deps

# 7. 起后端 → http://127.0.0.1:8000
npm run server:dev

# 8. 另开一个终端跑前端；dev 已把 /api 代理到 8000，无需任何额外配置
npm run dev

# 9. 后端契约自测（不需要起服务，也不需要 pytest）
npm run server:test
```

> ★ **当前是桩响应**：不调大模型、不花钱，只把"请求出端 → 服务端 → 结构化返回 → 客户端渲染"
> 这条链路跑通。接真实模型的位置在 `server/main.py` 的 `generate_reading()`，有 ★ 标注。
> 桩响应带 `X-Xiaobu-Stub: 1` 响应头，`GET /api/health` 也会回 `{"ok":true,"stub":true}`。

**真机 / 生产要设 `VITE_API_BASE`**：App 跑在 `capacitor://localhost` 里，相对路径 `/api/...`
会打到 WebView 自己身上，永远命中不了后端 —— 必须给绝对地址（如 `VITE_API_BASE=https://api.example.com`）。
Web 开发留空即可，靠 Vite dev 代理转发。

### 不用真机、不开浏览器也能看画面：`npm run preview:scene`

把完整场景在 node 里渲染成 `preview/m1-scene.png`（390×844 @2x），**不装 Chromium、不启浏览器**，几百毫秒出图。

```bash
npm run preview:scene
# → preview/m1-scene.png
# → [preview] 底色 token = #fdf9f6（第一笔必须是它，否则就是白屏前兆）
# → [preview] ✓ 九个图层全部正常绘制
```

它靠 `esbuild`（vite 自带）+ `@napi-rs/canvas`（原生 canvas，装在隔离工作区，**不进本项目依赖**）。

三件事因此变得很便宜：
- **视觉回归**：美术改稿 / 调色 / 动排序，跑一次就能看整间屋子，不用在真机上来回切页面。
- **验货**：输出里那句"被隔离的图层"直接告诉你有没有图层在静默失败。
- **证明零 DOM 依赖**：它能在 node 里跑通，就说明 `isometric` / `LayerStack` / L1–L9 没有偷偷访问 `window` / `document`。

> 看图工具缺失时脚本会**正常退出（exit 0）**并打印安装提示 —— 看图工具不该阻断构建，这跟防崩底线是同一条原则。

### 美术量的像素对不对？`npm run check:art`（= 门禁⑫）

等距 2.5D 有一条硬约束：**任何轴对齐的刚体平面（桌子、卦盘、台阶…），投影出来必然是平行四边形，且半宽/半高 = GW/GH ≈ 2.0049**。这不是风格问题，是数学。

```bash
npm run check:art
# ✓ 卦盘 boardQuad()   半宽 118.14 × 半高 58.93 → 比例 2.0049
# ✓ 桌面 TABLE_QUAD    半宽 300.73 × 半高 150.00 → 比例 2.0049
# ✓ 卦盘完整落在桌面内（与设计稿一致）
# ✓ 全部自洽 —— 所有刚体平面都满足 2:1 等距
```

**它真的抓到过东西**：`TABLE_QUAD` 的左右顶点曾被量在**画布边缘**（x=0 / x=390），桌面因此窄了 105.7px/侧，症状是"卦盘探出了桌面"——所有人去查卦盘，而根源在一组实测像素。104 条单测全绿也照样漏掉了它，因为**当时没有任何一条断言在问"这符合投影吗"**。

> 新加的平面（地毯 / 蒲团 / 香炉…）若确实是**软边手绘**、允许不成比例，请登记到 `scripts/check-art-geometry.mjs` 的 `KNOWN_ISSUES` 并写清理由与收尾方式 —— 已登记的项不阻断，**新冒出来的不自洽一定阻断**。

---

## 三、两条防崩底线约束（写进了代码注释，也写进了门禁）

### 门禁 ⑨ · catch 块禁止出 UI

用户在断网、拒绝定位、操作失误时，**永远只该看到温馨的界面**。

```ts
catch (e) {
  // ✗ 禁止：alert / confirm / prompt / Toast / showModal / uni.showToast
  // ✓ 正确：错误是开发者的语言，不是用户的体验
  handle(e, 'scene.render')      // → 只记日志 + 脱敏埋点 + 分类降级
}
```

需要安抚用户时，**只由小卜的气泡开口**（`ui/components/BubbleXiaobu.vue`，全应用唯一容错出口）。
校验：`node ci/gates/09-no-ui-in-catch.mjs`

### 门禁 ⑩ · 禁止使用 LocalStorage 持久化上报队列

```ts
// ✗ 禁止：落盘、重试、await
localStorage.setItem('trackQueue', JSON.stringify(buf))
await fetch('/api/track', { body })

// ✓ 正确：内存缓冲 + sendBeacon，失败即丢
const ok = navigator.sendBeacon('/api/track', blob)
if (!ok) buf.length = 0        // 直接丢弃整批，不做任何补偿
```

上报永远不许阻塞主线程 —— **无 `await`、无 `retry`、无持久化队列**。
校验：`node ci/gates/10-no-persist-queue.mjs`

> 注意区分：**配置缓存与 anonId 是可以落盘的**（那是纯读优化），门禁只盯"上报队列"。

---

## 四、M1 只做四件事（其余一律不做）

| 天 | 做什么 | 出口 |
|---|---|---|
| D1 | 工程初始化：Vite + Vue3 + TS + Pinia + Capacitor；目录骨架；`tokens.css`；门禁脚本接进 `npm run ci` | `npm run dev` 能跑、`npm run ci` 能挂 |
| D2 | `CanvasRenderer` + `LayerStack` + `isometric.ts`；rAF / DPR / 前后台暂停 | **空白画布 60 fps 稳定** |
| D3 | 落 L1–L9 静态图层（照设计稿等距底座）；`bootSequence` 只做同步首帧 | ★ **真机冷启动 ≤ 1.8 s 看见黄昏小屋，无白屏** |

**M1 明确不做**：Spine 接入 · 手势识别 · 六爻算法 · 天气 · 埋点 · 远端配置 · 四季资源包。
这些分别在 M2（D4–D8）与 M3（D9–D11）落地。

---

## 五、契约提醒

- 目录一旦开工即为契约（规划 §9）。新增目录必须回写《代码工程目录结构规划》并注明理由。
  - ★ 已登记：`server/`（M3 解读网关，FastAPI）。理由：客户端只拿白名单枚举出端、且 **Key 必须留在服务端**，
    需要一处独立的、可单独部署的代理；它与前端构建互不依赖（前端不接它也能跑）。规划文档不在本仓库内，故在此登记。
- V1 范围已冻结：四季切换 · 云历史 · 社交 · 付费 · 多语言 —— 均不属于 V1。
- 任何"顺手加个功能"的冲动，记入 `BACKLOG-V2`，**不进 V1 代码库**。

---

*本脚手架与《小卜-代码工程目录结构规划》《小卜-开发验收清单 v1.0 FREEZE》《小卜-系统架构与防崩白皮书》共同构成 V1 的范围契约。*
