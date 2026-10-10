"""
小卜 · 解读网关（M3 · 桩响应版）   server/main.py
==========================================================================
客户端 src/services/llm.ts 的唯一后端。契约逐字对齐：

  POST /api/reading
    Body: { "kind": "liuyao" | "tarot",
            "dims": { ...枚举维度... },
            "structure": "hexagram" | "single" | "timeline" | ... }
    Resp: { "title": str, "subtitle": str,
            "sections": [ { "key": str, "label": str, "body": str } ],
            "summary": str, "moodLabel": str, "cents": int }

  ★ title / subtitle 允许留空 —— 客户端在空值时沿用**本地**标题。
    原因：卦名（第 11 卦 · 泰）与牌阵名只有客户端的内容表里有，
    服务端这一版没有那张表。接真实模型时服务端会拿到这些内容再补上标题。

--------------------------------------------------------------------------
两条红线（与客户端同一套）
--------------------------------------------------------------------------
  ① **隐私**：客户端只发 dims 里的枚举（mood / focus / place / hexagram …），
     用户的原话在 `localOnly` 里、**永远不会到达这里** —— 请求体里根本没有那个字段。
     所以本服务端的日志与转存也不可能泄漏隐私 —— 这不是纪律，是结构上不可能。
  ② **语气**：不许出现"吉 / 凶 / 运势 / 正位 / 逆位 / 牌意 / 五行 / 八字"这类
     预测或行话。客户端对响应有一道兜底：命中禁词整份丢弃、回落本地模板 ——
     所以脏文案到不了用户眼前，但服务端仍须干净。

--------------------------------------------------------------------------
真模型 vs 桩响应
--------------------------------------------------------------------------
  配了 `XIAOBU_LLM_{BASE,KEY,MODEL}` 三个环境变量 ⇒ 走真模型（llm.py）；
  没配 / 调用失败 / 输出不过 guard ⇒ **自动回落桩**，客户端永远拿到合格结构。
  回落时带 `X-Xiaobu-Stub: 1`，被 guard 拦下时另带 `X-Xiaobu-Guard: 1`。
  切换与成本、隐私的完整说明见 `server/README-LLM.md`。

第二条链路：POST /api/chat（共情对话）
--------------------------------------------------------------------------
  ★ 这是**独立的同意通道**，与 /api/reading 的隐私白名单无关：
    · 只有当用户在客户端点了「好」（consent='on'）且功能开关开启时，
      客户端才会把这一句原话发过来（见 src/services/empathyCloud.ts）。
    · 服务端**不落盘**，日志只记长度与枚举，绝不记正文。
  契约：{text≤200, mood|null, turns} → {reply≤34, cents}
==========================================================================
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from server import guard, llm

logger = logging.getLogger("xiaobu.chat")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # ★ 启动就把"这一版到底接没接真模型"打到台面上，别让人猜
    if llm.is_configured():
        print("[xiaobu-server] 已配置 LLM：走真实模型，失败自动回落桩")
    else:
        print("[xiaobu-server] 未配置 XIAOBU_LLM_*：当前为【桩响应】，见 server/README-LLM.md")
    yield


app = FastAPI(title="小卜 · 解读与共情网关", version="0.2.0", lifespan=lifespan)

# 真机同网段调试时，App 从 capacitor://localhost 或局域网 IP 访问本服务 → 跨域。
# 开发期放开；上线时把 allow_origins 收敛成自己的域名。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ───────────────────────────────────────────────────────────────────────────
# 请求 / 响应模型（与 src/services/llm.ts 的契约一致）
# ───────────────────────────────────────────────────────────────────────────


class ReadingRequest(BaseModel):
    kind: Literal["liuyao", "tarot"]
    # ★ 只有枚举与数值 —— 客户端不会把用户原话放进来（见 reading.ts 的字段白名单）
    # ★ 用 Dict[str, Any] 而不是 dict[str, str | int]：本机是 pydantic v1，
    #   v1 不认识 PEP 604 的 `str | int`，会把数字**悄悄转成字符串**（drawn=2 → "2"），
    #   于是"翻了几张牌"判断全错。Dict[str, Any] 在 v1 / v2 下都老实。
    dims: Dict[str, Any] = Field(default_factory=dict)
    structure: str = ""


class Section(BaseModel):
    key: str
    label: str
    body: str


class ReadingResponse(BaseModel):
    title: str = ""
    subtitle: str = ""
    sections: List[Section]
    summary: str = ""
    moodLabel: str = ""
    # 本次花费（分）。桩不花钱，恒为 0；接模型后由后端按 token 折算（见 cost.py）
    cents: int = 0


class ChatRequest(BaseModel):
    """
    ★ 共情对话请求 —— 与 ReadingRequest 是**两个端点、两套契约**。
      · 这个模型**有**能装用户原话的 text 字段，但它只在客户端 consent='on'
        且开关开启时才被填充（见 src/services/empathyCloud.ts）；默认永远是空串。
      · mood 用 Optional[str]（pydantic v1 不认 PEP 604 的 `str | None`）。
    """

    text: str = ""
    mood: Optional[str] = None
    turns: int = 0


class ChatResponse(BaseModel):
    # 小卜的回应（≤34 字、无禁词）；拿不到模型回应时回落下面的固定安全句
    reply: str
    cents: int = 0


# ★ 服务端兜底回应：与客户端本地回应同调性，恒 ≤34 字、恒无禁词
FALLBACK_CHAT_REPLY = "嗯，我在听。你慢慢说。"


def _int_of(v: Any) -> int | None:
    """dims 里的数值可能是 int，也可能被上游字符串化成 "2" —— 两种都认。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, str) and v.strip().lstrip("+-").isdigit():
        return int(v.strip())
    return None


# ───────────────────────────────────────────────────────────────────────────
# 展示词表（★ 与客户端同源：这些是**面向用户**的固定词表值，不是自由文本）
# ───────────────────────────────────────────────────────────────────────────

MOOD_LABEL: dict[str, str] = {
    "CALM": "还算平静",
    "TIRED": "有点累",
    "ANXIOUS": "心里悬着",
    "DOWN": "提不起劲",
    "HOPEFUL": "有点期待",
    "RESTLESS": "静不下来",
}

MOOD_TEXT: dict[str, str] = {
    "CALM": "你此刻还算平静，先把这份平静多留一会儿。",
    "TIRED": "你有点累了；累的时候，慢一点是可以的。",
    "ANXIOUS": "你心里悬着，先别急着把它按下去，让它在这里待一会儿。",
    "DOWN": "你提不起劲，这阵子已经很不容易了。",
    "HOPEFUL": "你心里有一点期待，哪怕很小，也值得被看见。",
    "RESTLESS": "你静不下来，这份想动的心，先被接住就好。",
}

FOCUS_LABEL: dict[str, str] = {
    "CAREER": "工作上的事",
    "RELATION": "和某个人的关系",
    "STUDY": "学习与考试",
    "MONEY": "钱的事",
    "FAMILY": "家里的事",
    "SELF": "就是我自己",
    "UNSURE": "说不上来",
}

# ★ 牌位标签按 (structure, role) 取值 —— 同一个 role 在不同牌阵里含义不同
#   （timeline 的 past = 「过去」，cross 的 past = 「正在退场的事」），
#   单靠 role 不足以还原标签，必须带上牌阵结构。
ROLE_LABEL: dict[str, dict[str, str]] = {
    "single": {"today": "今日"},
    "timeline": {"past": "过去", "present": "现在", "future": "未来"},
    "comparison": {
        "now": "此刻",
        "pathA_near": "这条路 · 近景",
        "pathA_far": "这条路 · 远处",
        "pathB_near": "那条路 · 近景",
        "pathB_far": "那条路 · 远处",
    },
    "cross": {
        "now": "现况",
        "block": "横亘其上的阻碍或助力",
        "root": "根基",
        "past": "正在退场的事",
        "goal": "意识里的目标",
        "future": "即将到来的",
        "self": "你的姿态",
        "env": "身处的环境",
        "hope_fear": "既希望又害怕的",
        "outcome": "若如此走下去 · 结果",
    },
}

# 牌还没翻开时的兜底句 —— 与客户端本地模板逐字一致，免得"云端来了反而变了样"
NOT_DRAWN_BODY = "这一张还没翻开，先不急着读它。"


def _mood_of(req: ReadingRequest) -> str:
    mood = str(req.dims.get("mood", ""))
    return mood if mood in MOOD_LABEL else ""


def _stub_section(mood: str, label: str) -> str:
    head = MOOD_TEXT.get(mood, "你此刻的感受，值得被好好放一放。")
    return f"{head}关于「{label}」，先不急着下结论，把它放在这里待一会儿。"


def _stub_liuyao(req: ReadingRequest) -> ReadingResponse:
    mood = _mood_of(req)
    focus = str(req.dims.get("focus", ""))
    focus_label = FOCUS_LABEL.get(focus, "")
    n = _int_of(req.dims.get("hexagram"))
    head = f"第 {n} 卦" if n else "这一卦"

    label = focus_label or "这一卦"
    body = f"{head}先当作一个由头。{MOOD_TEXT.get(mood, '')}慢慢看，不必急着下结论。"

    mood_line = f"此刻心里{MOOD_LABEL[mood]}" if mood else "此刻的你"
    focus_line = f"你问的是{focus_label}" if focus_label else "你说不太清在烦什么"
    return ReadingResponse(
        title="",
        subtitle="",
        sections=[Section(key="cloud", label=label, body=body)],
        summary=f"{focus_line}，{mood_line}。卦只是个由头，真正要看的，是你自己。",
        moodLabel=MOOD_LABEL.get(mood, ""),
    )


def _stub_tarot(req: ReadingRequest) -> ReadingResponse:
    mood = _mood_of(req)
    roles = [r for r in str(req.dims.get("roles", "")).split(",") if r]
    drawn = _int_of(req.dims.get("drawn"))
    drawn_n = len(roles) if drawn is None else drawn
    labels = ROLE_LABEL.get(req.structure, {})

    if not roles:
        # 结构缺失也要给一段，绝不返回空 sections（客户端会整份丢弃）
        roles = ["today"]

    sections = [
        Section(
            key=f"{i + 1}-{role}",
            label=labels.get(role, "这一张"),
            body=_stub_section(mood, labels.get(role, "这一张")) if i < drawn_n else NOT_DRAWN_BODY,
        )
        for i, role in enumerate(roles)
    ]

    mood_label = MOOD_LABEL.get(mood, "")
    mood_line = f"此刻的你，{mood_label}。" if mood_label else ""
    return ReadingResponse(
        title="",
        subtitle="",
        sections=sections,
        summary=f"{mood_line}这几张不必全信 —— 挑一句最像你今天样子的，就够了。",
        moodLabel=mood_label,
    )


# ───────────────────────────────────────────────────────────────────────────
# 解读主流程：真模型优先，任何一环不合格 ⇒ 回落桩
# ───────────────────────────────────────────────────────────────────────────

# 源标记：'llm' 真模型 / 'guard' 模型给了但没过关 / 'stub' 未配置模型
Source = Literal["llm", "guard", "stub"]


def _req_dict(req: ReadingRequest) -> Dict[str, Any]:
    """pydantic v1 用 .dict()，v2 用 .model_dump() —— 两边都取得到"""
    dump = getattr(req, "model_dump", None) or getattr(req, "dict")
    return dump()


def _stub(req: ReadingRequest) -> ReadingResponse:
    return _stub_liuyao(req) if req.kind == "liuyao" else _stub_tarot(req)


def _to_reading_response(content: Dict[str, Any], cents: int) -> ReadingResponse | None:
    """
    把模型返回的 dict 收成契约同构的 ReadingResponse。
    ★ 硬要求：sections 非空、每段 label / body 都非空 —— 否则返回 None（上层回落桩）。
      这与客户端 `parseCloudReading()` 的判断完全一致：宁可回落本地模板，也不给半截话。
    """
    raw_sections = content.get("sections")
    if not isinstance(raw_sections, list) or not raw_sections:
        return None
    sections: List[Section] = []
    for raw in raw_sections:
        if not isinstance(raw, dict):
            return None
        label = str(raw.get("label") or "").strip()
        body = str(raw.get("body") or "").strip()
        if not label or not body:
            return None
        sections.append(Section(key=str(raw.get("key") or len(sections) + 1), label=label, body=body))

    return ReadingResponse(
        title=str(content.get("title") or ""),
        subtitle=str(content.get("subtitle") or ""),
        sections=sections,
        summary=str(content.get("summary") or ""),
        moodLabel=str(content.get("moodLabel") or ""),
        cents=int(cents or 0),
    )


def _reading_visible(resp: ReadingResponse) -> Dict[str, object]:
    """抽出响应里**面向用户**的文本字段，交给 guard 二次扫禁词"""
    d: Dict[str, object] = {
        "title": resp.title,
        "subtitle": resp.subtitle,
        "summary": resp.summary,
        "moodLabel": resp.moodLabel,
    }
    for i, s in enumerate(resp.sections):
        d[f"s{i}_label"] = s.label
        d[f"s{i}_body"] = s.body
    return d


def generate_reading_with_meta(req: ReadingRequest) -> tuple[ReadingResponse, Source]:
    """
    ★ 接真实模型的位置就在这个函数里 —— 不再是一行 `_stub_*()`：
      · 配了模型 ⇒ 调 `llm.call_reading()`；拿到结构 → 收契约 → 过 guard → 用它
      · 未配置模型 ⇒ 'stub'（正常降级，带 X-Xiaobu-Stub: 1）
      · 配置了但调用失败 / 结构不合格 / 命中禁词 ⇒ 'guard'（多带 X-Xiaobu-Guard: 1）

    提示词里不可能有用户原话 —— 它从不出端，服务端拿不到（见 reading.ts）。
    """
    if llm.is_configured():
        result = llm.call_reading(_req_dict(req))
        if result is not None:
            resp = _to_reading_response(result.content, result.cents)
            if resp is not None and guard.reading_clean(_reading_visible(resp)):
                return resp, "llm"
        return _stub(req), "guard"
    return _stub(req), "stub"


def generate_reading(req: ReadingRequest) -> ReadingResponse:
    """契约自测（test_contract.py）用的纯函数入口：只关心最终返回的那份结构。"""
    return generate_reading_with_meta(req)[0]



# ───────────────────────────────────────────────────────────────────────────
# 路由
# ───────────────────────────────────────────────────────────────────────────


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "stub": not llm.is_configured(), "llm": llm.is_configured()}


@app.post("/api/reading", response_model=ReadingResponse)
def reading(req: ReadingRequest, response: Response) -> ReadingResponse:
    resp, source = generate_reading_with_meta(req)
    if source == "llm":
        # 真模型产出：不打桩标记
        response.headers["X-Xiaobu-Source"] = "llm"
    else:
        # 给人工/联调一个明确信号：这一份不是真模型
        response.headers["X-Xiaobu-Stub"] = "1"
        if source == "guard":
            # 模型给了、但结构不合格 / 命中禁词 ⇒ 被服务端拦下
            response.headers["X-Xiaobu-Guard"] = "1"
    return resp


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest, response: Response) -> ChatResponse:
    """
    ★ 共情对话（独立同意通道）—— 客户端只在 consent='on' 且开关开启时才会调到这里。
    ★ 隐私：本函数**不打印正文**，日志只记长度与枚举；不落盘、`Retention: none`。
    """
    text = str(req.text or "")[: guard.EMPATHY_TEXT_MAX_CHARS]
    logger.info("[chat] len=%d mood=%s turns=%d", len(text), req.mood, req.turns)

    if text.strip():
        result = llm.call_chat(text, req.mood, req.turns)
        if result is not None:
            reply = str(result.content.get("reply") or "").strip()
            # ★ 第二道禁词闸：通过才把模型那句交给用户
            if guard.empathy_reply_ok(reply):
                return ChatResponse(reply=reply, cents=result.cents)

    # 空文本 / 未配置模型 / 调用失败 / 回应不合格 ⇒ 回落固定安全句（带 guard 标记）
    response.headers["X-Xiaobu-Guard"] = "1"
    return ChatResponse(reply=FALLBACK_CHAT_REPLY, cents=0)

