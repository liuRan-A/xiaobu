"""
小卜 · 提示词组装   server/prompts.py
==========================================================================
两类提示词，对应两条**独立**链路：

  · build_reading_messages(req) → POST /api/reading 用（解读）
      入参是客户端 `serializeForNetwork()` 的产物：{kind, dims, structure}。
      ★ 里面**只有枚举**（mood / focus / place_hint …），没有一句用户原话 ——
        用户在请求体里根本没有能装原话的字段（见 src/core/reading.ts 的 NETWORK_FIELDS）。
  · build_chat_messages(text, mood, turns) → POST /api/chat 用（共情对话）
      这里**有**用户原话，但只在 consent='on' 时客户端才发（见 empathyCloud.ts）。
      这是**独立的同意通道**，不属于 reading 的隐私白名单 —— 文档反复强调这一点。

── 两条共同的写作纪律（与客户端 core/guide 同源）────────────────────────────
  ① 语气：先映照用户此刻的状态，再给一句「这样也可以」的许可。
     绝不预测、绝不吉凶、绝不说教、绝不连问。
  ② 词汇：躲开 guide.ts 的 FORBIDDEN_COPY（吉/凶/运势/正位/逆位/牌意/五行…）
     与 FORBIDDEN_STRUCTURE_WORDS（塔罗区/六爻区/玩法…）。
     字段缺失时**给中性兜底**，不留空让模型自己猜 —— 猜出来的往往是行话。

── 输出契约 ────────────────────────────────────────────────────────────────
  一律要求模型返回**严格 JSON**（不带 markdown 围栏）。解析失败由 llm.py 兜底，
  再失败由 main.py 回落 `_stub_*()`（带 X-Xiaobu-Guard: 1）。见 README-LLM.md。
==========================================================================
"""

from __future__ import annotations

from typing import Any

# ★ 与客户端同源的禁词清单（写进提示词，让模型一开始就绕开）
_AVOID = (
    "不得出现以下词或同类表达：吉、凶、运势、运程、开运、化解、转运、预测、预言、"
    "命中注定、灵验、算命、命理、风水、正位、逆位、牌意、寓意、爻辞、卦辞、五行、"
    "八字、生辰；也不得出现「塔罗区」「六爻区」「玩法」这类产品结构词。"
)

# ───────────────────────────────────────────────────────────────────────────
# 一、解读（/api/reading）
# ───────────────────────────────────────────────────────────────────────────

READING_SYSTEM = (
    "你是「小卜」，一个温柔的情绪陪伴者，不预测未来、不判断吉凶、不解释命理。"
    "用户刚做完一次掷币或抽牌的仪式，你要把「此刻」轻轻说给他听："
    "先说他的状态，再给一句「这样也可以」的许可；不给建议、不说教、不连问。"
    "语气像深夜里坐在对面的人，短句、留白，不用感叹号堆情绪。"
    + _AVOID
    + "\n\n输出必须是**严格 JSON**（不要 markdown 围栏、不要多余说明），结构："
    '{"title": "", "subtitle": "", '
    '"sections": [{"key": "", "label": "", "body": ""}], '
    '"summary": "", "moodLabel": ""}。'
    "title / subtitle 可留空；sections 必须非空、每段 label 与 body 都必须非空。"
)


def _dim_hint(req: dict[str, Any], key: str) -> str:
    """取 dims 里的 *_hint（英文语义提示词，客户端已生成）；没有就返回空串。"""
    dims = req.get("dims") if isinstance(req.get("dims"), dict) else {}
    return str(dims.get(key, "") or "")


def _dim(req: dict[str, Any], key: str) -> str:
    dims = req.get("dims") if isinstance(req.get("dims"), dict) else {}
    return str(dims.get(key, "") or "")


def build_reading_messages(req: dict[str, Any]) -> list[dict[str, str]]:
    """
    把 {kind, dims, structure} 拼成对话消息。
    ★ 三维数据全部来自枚举与 *_hint，没有任何自由文本能漏进来。
    """
    kind = str(req.get("kind", ""))
    structure = str(req.get("structure", ""))
    mood_hint = _dim_hint(req, "mood_hint")
    lines: list[str] = [f"仪式类型：{kind}", f"解读结构：{structure}"]

    if mood_hint:
        lines.append(f"用户此刻的心情：{mood_hint}")
    else:
        lines.append("用户此刻的心情：未填写（请用中性、承接的语气）")

    if kind == "liuyao":
        lines.append(f"问事方向：{_dim_hint(req, 'focus_hint') or '未指定，用中性语气'}")
        lines.append(f"放置位置：{_dim_hint(req, 'place_hint') or '未特别放置'}")
        n = _dim(req, "hexagram")
        lines.append(f"卦序号（仅作由头，不作吉凶判断）：{n or '未取到'}")
        lines.append("请给出 1 段解读（sections 长度 1），label 用生活语言，别用术数术语。")
    else:
        roles = _dim(req, "roles")
        drawn = _dim(req, "drawn")
        lines.append(f"牌位角色（按顺序）：{roles or 'today'}")
        lines.append(f"已翻开的张数：{drawn or '未知'}")
        lines.append(
            "请为**每一个**牌位都给出 1 段，sections 顺序与牌位顺序一致；"
            "label 用牌位的生活化含义；尚未翻开的牌位，body 写「这一张还没翻开，先不急着读它。」"
        )

    lines.append("最后用一句 summary 收束，语气是陪伴，不是结论。")
    return [
        {"role": "system", "content": READING_SYSTEM},
        {"role": "user", "content": "\n".join(lines)},
    ]


# ───────────────────────────────────────────────────────────────────────────
# 二、共情对话（/api/chat）
# ───────────────────────────────────────────────────────────────────────────

CHAT_SYSTEM = (
    "你是「小卜」。用户对你说了他此刻的心情，你回**一句**话就好，像贴着耳朵的低语。"
    "做法只有两步：先把他此刻的状态说出来（映照），再给一句「这样也可以」的许可。"
    "不给建议、不做评估、不说教、不诊断、不承诺、不反问连击。"
    "不要复读用户原话，不要说「我理解你」这类空话。"
    "回复必须是一句**中文短句，不超过 34 个字**。" + _AVOID
    + "\n\n输出必须是**严格 JSON**（不要 markdown 围栏），结构："
    '{"reply": "你的这一句话"}。reply 不得超过 34 个字。'
)


def build_chat_messages(text: str, mood: str | None, turns: int) -> list[dict[str, str]]:
    """
    拼共情对话消息。
    ★ 这里的 `text` 是用户原话 —— 只在 consent='on' 且开关开启时才会到达这里，
      是独立的同意通道，不落盘、日志只记长度（见 main.py 的 /api/chat）。
    """
    mood_line = f"（他此前选的心情：{mood}）" if mood else ""
    ctx = f"这是本次对话的第 {max(0, int(turns or 0)) + 1} 句。{mood_line}".strip()
    return [
        {"role": "system", "content": CHAT_SYSTEM},
        {"role": "user", "content": f"{ctx}\n他说：{text}"},
    ]
