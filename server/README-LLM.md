# 小卜 · 真实 LLM 接入说明（server/）

这份文档讲清楚三件事：**怎么把桩换成真模型**、**两条链路的隐私边界在哪**、
**为什么服务端超时必须比客户端短**。读完之后，接任何 OpenAI 兼容的模型都只是改几个环境变量。

---

## 1. 一分钟切换（桩 → 真模型）

在 `server/` 下建 `.env`（**已在 `.gitignore`**，永不进仓库）：

```dotenv
XIAOBU_LLM_BASE=https://api.deepseek.com/v1
XIAOBU_LLM_KEY=sk-你的密钥
XIAOBU_LLM_MODEL=deepseek-chat
```

然后启动：

```bash
npm run server:deps     # 首次：pip install -r server/requirements.txt
npm run server:dev      # uvicorn server.main:app --reload --port 8000
```

判据：
- 启动日志出现 `已配置 LLM：走真实模型，失败自动回落桩` ⇒ 接上了
- `GET /api/health` 返回 `{"ok": true, "llm": true, "stub": false}`

**没有配置时一切照旧**：服务端走桩、路径完全不变，客户端拿到的仍是合格结构。

---

## 2. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `XIAOBU_LLM_BASE` | 是 | — | OpenAI 兼容基址，如 `https://api.deepseek.com/v1`。以 `/chat/completions` 结尾也可直接填 |
| `XIAOBU_LLM_KEY` | 是 | — | 密钥。★ **只在服务端**，绝不进客户端 config（门禁⑧） |
| `XIAOBU_LLM_MODEL` | 是 | — | 如 `deepseek-chat` |
| `XIAOBU_LLM_TIMEOUT_MS` | 否 | `4500` | 服务端**总预算**（含重试），见 §4 |
| `XIAOBU_LLM_MAX_RETRY` | 否 | `1` | 最多重试几次（快速失败才有重试价值） |
| `XIAOBU_LLM_CENTS_PER_1K_IN` | 否 | `0.027` | 输入每 1K token 折几分 |
| `XIAOBU_LLM_CENTS_PER_1K_OUT` | 否 | `0.11` | 输出每 1K token 折几分 |

全部只走 `os.environ`（[llm.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/llm.py)、[cost.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/cost.py)）。
**永远不要**把这些写进 `src/config/config.json` —— 客户端产物是公开的。

---

## 3. 两条链路，两套隐私模型

| | `POST /api/reading`（解读） | `POST /api/chat`（共情对话） |
|---|---|---|
| 出端内容 | 只有枚举：`kind / dims / structure` | 用户**原话** `text`（≤200 字）+ `mood` + `turns` |
| 何时发送 | 总是可用（默认开） | **仅当** `consent='on'` **且** `features.empathyCloud.enabled` |
| 隐私保证方式 | **结构性**：客户端 `serializeForNetwork()` 把原话整个剥掉，请求体里根本没有那个字段 | **同意式**：默认 `off`，一个字都不出端；用户点「好」才走这条独立通道 |
| 服务端存储 | 无 | 无（`Retention: none`） |

请求模型佐证：
- `ReadingRequest` 只有 `{kind, dims, structure}` —— 见 [main.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/main.py)，契约自测第 ① 项会断言它**不含**能装原话的字段。
- `ChatRequest` 有 `text` 字段，但客户端 `empathyCloud.ts` 在 `consent !== 'on'` 时**连请求都不发**（单测钉着 `fetchImpl` 零调用）。

> ⚠️ `/api/chat` 是**独立的同意通道**，不属于 `reading` 的隐私白名单。
> 它之所以能带原话，是因为用户显式同意；它不是「reading 白名单被放宽了」。

**服务端日志纪律**（[main.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/main.py) 的 `/api/chat`）：
只 `logger.info("[chat] len=%d mood=%s turns=%d", ...)` —— **记长度与枚举，绝不记正文**。

---

## 4. 超时预算：服务端必须比客户端短

客户端两条链路的超时**都是 6000ms**（[llm.ts](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/src/services/llm.ts)、[empathyCloud.ts](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/src/services/empathyCloud.ts)）。
到点客户端就撤、回落本地模板/本地回应。**如果服务端比客户端慢，客户端先走了** ——
这次 token 花了却没人看到，纯粹的浪费。

所以 `XIAOBU_LLM_TIMEOUT_MS`（默认 **4500**）是**总预算**，不是单次超时：

- 单次尝试以「预算剩余」为上限（留 1.5s 余量给网络往返与解析）
- 只有还剩得下足够时间才重试；预算耗尽即放弃、返回 `None`
- 上层据此回落桩，客户端永远拿得到一份可用结构

```
客户端 6000ms  ←──────────────────────────────────→
服务端   4500ms ←──────────────→   （1.5s 余量）
              ├ 尝试1 ┤ ├ 尝试2（若还剩时间）┤
```

---

## 5. 输出契约与双重禁词闸

### 解读
模型必须返回**严格 JSON**：

```json
{ "title": "", "subtitle": "",
  "sections": [{ "key": "", "label": "", "body": "" }],
  "summary": "", "moodLabel": "" }
```

- `title / subtitle` 可留空（卦名、牌阵名只在客户端内容表里）
- `sections` **必须非空**，每段 `label / body` **必须非空** —— 否则服务端直接回落桩
- 客户端 `parseCloudReading()` 有**完全相同**的判断：宁可回落本地模板，也不给半截话

### 共情对话
```json
{ "reply": "一句 ≤34 字的中文短句" }
```

### 禁词闸（两道，同源）
| 位置 | 文件 | 行为 |
|---|---|---|
| 客户端（第一道） | [llm.ts](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/src/services/llm.ts) / [empathyCloud.ts](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/src/services/empathyCloud.ts) | 命中禁词 ⇒ 整份丢弃、回落本地 |
| 服务端（第二道） | [guard.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/guard.py) | 命中禁词 ⇒ 回落 `_stub_*()` / 固定安全句 |

`guard.py` 的三张表与客户端**逐字同源**（`FORBIDDEN_COPY` / `FORBIDDEN_STRUCTURE_WORDS` / `EMPATHY_BANNED`），
契约自测会断言两边正则相等。**改一处必须改两处。**

---

## 6. 回落路径与响应头

无论哪一环失败，客户端拿到的永远是合格结构。服务端用响应头说明这份产自哪里：

| 场景 | `X-Xiaobu-Source` | `X-Xiaobu-Stub` | `X-Xiaobu-Guard` |
|---|---|---|---|
| 真模型产出 | `llm` | — | — |
| 未配置模型（正常降级） | — | `1` | — |
| 模型给了但结构不合格 / 命中禁词 / 调用失败 | — | `1` | `1` |

`/api/chat` 回落固定安全句 `FALLBACK_CHAT_REPLY`（`"嗯，我在听。你慢慢说。"`）时带 `X-Xiaobu-Guard: 1`。

---

## 7. 成本

[cost.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/cost.py) 把 token 用量折成**分**写进响应的 `cents`：

- 单位是「分」+ **向上取整**：只要真花了，就一定 ≥1 分 —— 否则取整会把它吃成 0，钱花了却熔断不了
- 客户端 `services/track` 拿到 `cents` 累加，超当日全局上限即触发熔断
- 换供应商改 `XIAOBU_LLM_CENTS_PER_1K_{IN,OUT}` 即可

---

## 8. 验证

```bash
python server/test_contract.py                 # 契约自测（零额外依赖，不必起服务）
XIAOBU_LIVE=1 python server/test_contract.py   # 联网实测「真模型返回基线」一节（需已配 XIAOBU_LLM_*）
npm run server:dev                             # 起服务
curl http://127.0.0.1:8000/api/health          # {"ok":true,"llm":true|false,...}
```
> ★ 契约自测**默认走桩**：文末「真模型返回基线 · 联网实测」会 `[skip]`，前面的桩断言也不受
>   本机残留的 `XIAOBU_LLM_*` 影响。要真打模型就设 `XIAOBU_LIVE=1`（PowerShell：先
>   `$env:XIAOBU_LIVE=1` 再跑）；该节只断言**形状**（sections 非空、无禁词、≤34 字），
>   不比对措辞 —— 模型输出本就概率性。冻结的真实返回样例存在
>   [test_contract.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/test_contract.py) 里，离线也钉形状。

手动链路：
```bash
npm run server:dev     # 终端 A
npm run dev            # 终端 B → 点悬浮球 → 输入一句 → 看小卜回应
```
> ★ 隐私验收：**对话开关关闭时**，抓包不得出现 `/api/chat`；解读请求体里不得出现用户原话。

---

## 9. 文件地图

| 文件 | 职责 |
|---|---|
| [main.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/main.py) | FastAPI 应用、路由、契约模型、回落编排（`generate_reading_with_meta`） |
| [llm.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/llm.py) | 供应商适配（OpenAI 兼容）+ 总预算重试；`call_reading` / `call_chat`，**永不抛** |
| [prompts.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/prompts.py) | system prompt + `dims` → 提示词（两类链路各一套） |
| [guard.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/guard.py) | 服务端二次禁词闸（与客户端同源） |
| [cost.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/cost.py) | token → 分 |
| [test_contract.py](file:///c:/Users/LENOVO/WorkBuddy/2026-10-09-15-08-16/xiaobu/server/test_contract.py) | 契约自测（形状 / 隐私 / 语气 / 二次闸 / 成本 / 提示词 / 真模型返回基线） |
