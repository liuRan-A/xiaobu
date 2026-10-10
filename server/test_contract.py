"""
小卜 · 解读网关契约自测   server/test_contract.py
==========================================================================
用法：  python server/test_contract.py        （零额外依赖，不需要先起服务）

守住这些事：
  ① 契约形状：sections 非空、每段 label / body 非空、字段名与客户端一致
  ② 牌阵结构：按 (structure, role) 还原牌位标签；没翻开的牌给兜底句
  ③ 隐私：请求模型里**根本没有**能装用户原话的字段
  ④ 语气：桩文案不命中客户端的禁词（命中会被客户端整份丢弃、回落本地模板）
  ⑤ 二次闸 / 成本 / 适配层 / 对话契约 / 语音听写契约 / 提示词：见文件后半段各节
  ⑥ 真模型返回基线：冻结的真实返回样例（离线钉形状）+ 联网实测（默认跳过）
==========================================================================
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import sys

# 允许 "python server/test_contract.py" 直接跑（此时 sys.path[0] 是 server/，import server.main 会失败）
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from server import asr, cost, guard, llm, prompts, weather  # noqa: E402
from server.main import (  # noqa: E402
    FALLBACK_CHAT_REPLY,
    NOT_DRAWN_BODY,
    AsrRequest,
    AsrResponse,
    ChatRequest,
    ChatResponse,
    ReadingRequest,
    WeatherResponse,
    _decode_audio,
    _reading_visible,
    _to_reading_response,
    generate_reading,
    generate_reading_with_meta,
)

# ───────────────────────────────────────────────────────────────────────────
# 离线契约段一律走桩：先把可能残留的 XIAOBU_LLM_* 摘下来存好、再从环境里移除。
#   原因：本机若恰好 export 过 Key，前面的"桩响应"断言会被真模型打乱（模型有自己的
#   moodLabel / 措辞），那几条就假红了。真模型实测集中在文末「真模型返回基线」一节，
#   届时把这份环境原样还原回去。
# ───────────────────────────────────────────────────────────────────────────
_LLM_KEYS = (
    "XIAOBU_LLM_BASE",
    "XIAOBU_LLM_KEY",
    "XIAOBU_LLM_MODEL",
    "XIAOBU_LLM_TIMEOUT_MS",
    "XIAOBU_LLM_MAX_RETRY",
)
_SAVED_ENV = {k: os.environ.get(k) for k in _LLM_KEYS}
for _k in _LLM_KEYS:
    os.environ.pop(_k, None)

# ★ 同理：把可能残留的讯飞 XIAOBU_IFLYTEK_* 也摘掉，否则 asr.is_configured() 会为真，
#   下面"未配置 ⇒ 回落空文本"的断言就假红了。ASR 不跑联网实测（讯飞是 WebSocket）。
_ASR_KEYS = ("XIAOBU_IFLYTEK_APPID", "XIAOBU_IFLYTEK_APIKEY", "XIAOBU_IFLYTEK_APISECRET")
for _k in _ASR_KEYS:
    os.environ.pop(_k, None)

# ★ 同理：天气（和风）也要先摘干净，否则本机若配过 Key，下面"未配置 ⇒ unknown"的断言会假红。
#   最外层还额外把"一键停用"也清掉，保证落到"未配置"这条确定路径。
_WEATHER_KEYS = (
    "XIAOBU_HEFENG_KEY",
    "XIAOBU_HEFENG_LOCATION",
    "XIAOBU_HEFENG_HOST",
    "XIAOBU_HEFENG_TIMEOUT_MS",
    "XIAOBU_WEATHER_DISABLED",
)
for _k in _WEATHER_KEYS:
    os.environ.pop(_k, None)

# ★ 联网实测开关：默认关。设 XIAOBU_LIVE=1 且配好 XIAOBU_LLM_* 才跑真模型。
LIVE = os.environ.get("XIAOBU_LIVE") == "1"

# ★ 与客户端 core/guide/guide.ts 的 FORBIDDEN_COPY 同源（这里只用于自测断言）
FORBIDDEN = re.compile(
    r"吉|凶|血光|运势|运程|开运|化解|改运|转运|预测|预言|命中注定|灵验|算命|命理|风水"
    r"|正位|逆位|牌意|寓意|爻辞|卦辞|五行|八字|生辰|抽签算"
)

failed: list[str] = []


def check(name: str, ok: bool) -> None:
    print(("  [ok]   " if ok else "  [FAIL] ") + name)
    if not ok:
        failed.append(name)


def sections_of(**payload: object) -> tuple[list, object]:
    resp = generate_reading(ReadingRequest(**payload))  # type: ignore[arg-type]
    return resp.sections, resp


print("[contract] 请求模型 · 隐私")
# pydantic v1 用 __fields__，v2 用 model_fields —— 两边都取得到
_fields = getattr(ReadingRequest, "model_fields", None) or ReadingRequest.__fields__
check(
    "请求模型不含能装用户原话的字段",
    set(_fields) == {"kind", "dims", "structure"},
)

print("[contract] liuyao")
secs, resp = sections_of(
    kind="liuyao",
    dims={"mood": "ANXIOUS", "focus": "CAREER", "hexagram": 11},
    structure="hexagram",
)
check("sections 非空", len(secs) > 0)
check("每段 label / body 都非空", all(s.label and s.body for s in secs))
check("title 留空（交给客户端沿用本地卦名）", resp.title == "")
check("moodLabel 回传", resp.moodLabel == "心里悬着")
check("label 取焦点词表的展示值", secs[0].label == "工作上的事")

print("[contract] tarot · timeline（翻满 3 张）")
secs, _ = sections_of(
    kind="tarot",
    dims={"mood": "TIRED", "roles": "past,present,future", "drawn": 3},
    structure="timeline",
)
check("段数 = 牌位数", len(secs) == 3)
check("按 (结构, 角色) 还原标签", [s.label for s in secs] == ["过去", "现在", "未来"])
check("每段都有真正文", all(s.body and s.body != NOT_DRAWN_BODY for s in secs))

print("[contract] tarot · timeline（只翻了 2 张）")
secs, _ = sections_of(
    kind="tarot",
    dims={"mood": "TIRED", "roles": "past,present,future", "drawn": 2},
    structure="timeline",
)
check("段数仍是 3（未翻的也要占位）", len(secs) == 3)
check(
    "第 3 张用兜底句，而不是编一句",
    secs[2].body == NOT_DRAWN_BODY,
)

print("[contract] tarot · cross（10 张）")
secs, _ = sections_of(
    kind="tarot",
    dims={"mood": "CALM", "roles": "now,block,root,past,goal,future,self,env,hope_fear,outcome", "drawn": 10},
    structure="cross",
)
check("段数 = 10", len(secs) == 10)
check("同一个 role 在不同牌阵里含义不同（cross.past ≠ timeline.past）", secs[3].label == "正在退场的事")

print("[contract] tarot · 缺 roles 也不许返回空 sections")
secs, _ = sections_of(kind="tarot", dims={"mood": "CALM"}, structure="timeline")
check("至少有 1 段（客户端会丢弃空 sections）", len(secs) >= 1)

print("[contract] 语气红线（全量变体扫一遍）")
blob = ""
for kind, structure, dims in [
    ("liuyao", "hexagram", {"mood": m, "focus": f, "hexagram": 11})
    for m in ["CALM", "TIRED", "ANXIOUS", "DOWN", "HOPEFUL", "RESTLESS"]
    for f in ["CAREER", "RELATION", "STUDY", "MONEY", "FAMILY", "SELF", "UNSURE"]
] + [
    ("tarot", "timeline", {"mood": m, "roles": "past,present,future", "drawn": 3})
    for m in ["CALM", "TIRED", "ANXIOUS", "DOWN", "HOPEFUL", "RESTLESS"]
]:
    secs, resp = sections_of(kind=kind, dims=dims, structure=structure)
    blob += resp.title + resp.subtitle + resp.summary + resp.moodLabel
    blob += "".join(s.label + s.body for s in secs)
hit = FORBIDDEN.search(blob)
check("桩文案不含禁词", hit is None)
if hit:
    print(f"        命中：{hit.group(0)}")

print("[contract] 服务端二次闸（guard.py）· 与客户端同源")
check("FORBIDDEN_COPY 与客户端逐字同源", guard.FORBIDDEN_COPY.pattern == FORBIDDEN.pattern)
check("reading_clean 放行干净字段", guard.reading_clean({"title": "嗯，我在听。"}))
check("reading_clean 拦下命中禁词的字段", not guard.reading_clean({"body": "这卦有吉兆"}))
check("empathy_reply_ok 放行 ≤34 字合规句", guard.empathy_reply_ok(FALLBACK_CHAT_REPLY))
check("empathy_reply_ok 拦下超长（>34 字）", not guard.empathy_reply_ok("很" * 35))
check("empathy_reply_ok 拦下客服腔 / 诊断词", not guard.empathy_reply_ok("建议你去心理咨询"))
check("兜底对话回应本身合规", guard.empathy_reply_ok(FALLBACK_CHAT_REPLY))

print("[contract] 成本折算（cost.py）")
check("有用量 ⇒ 至少 1 分（不因取整被吃成 0）", cost.cents_for_usage({"prompt_tokens": 1000, "completion_tokens": 500}) >= 1)
check("无用量 ⇒ 0 分", cost.cents_for_usage(None) == 0)
check("脏 usage 不抛异常", cost.cents_for_usage({"prompt_tokens": "x"}) == 0)  # type: ignore[arg-type]

print("[contract] 模型适配层（llm.py）· 纯函数部分")
check("未配 XIAOBU_LLM_* ⇒ is_configured() 为假（走桩）", llm.is_configured() is False)
check("_extract_json 能剥掉 markdown 围栏", llm._extract_json('```json\n{"reply": "嗯"}\n```') == {"reply": "嗯"})
check("_extract_json 能从夹杂文本里抠出 JSON", llm._extract_json('好的：{"reply": "在"}。') == {"reply": "在"})
check("_extract_json 脏输入返回 None", llm._extract_json("完全不是 json") is None)

print("[contract] /api/chat 契约形状")
_chat_fields = getattr(ChatRequest, "model_fields", None) or ChatRequest.__fields__
_resp_fields = getattr(ChatResponse, "model_fields", None) or ChatResponse.__fields__
check("请求模型字段 = {text, mood, turns}", set(_chat_fields) == {"text", "mood", "turns"})
check("响应模型字段 = {reply, cents}", set(_resp_fields) == {"reply", "cents"})

print("[contract] /api/asr 契约形状（第三条独立通道）")
_asr_req_fields = getattr(AsrRequest, "model_fields", None) or AsrRequest.__fields__
_asr_resp_fields = getattr(AsrResponse, "model_fields", None) or AsrResponse.__fields__
check("请求模型字段 = {audio, format, durationMs}", set(_asr_req_fields) == {"audio", "format", "durationMs"})
check("响应模型字段 = {text, cents}", set(_asr_resp_fields) == {"text", "cents"})
check("未配 XIAOBU_IFLYTEK_* ⇒ is_configured() 为假（走回落）", asr.is_configured() is False)
check("未配置 ⇒ transcribe 返回 None（永不抛）", asr.transcribe(b"\x00" * 128, "audio/L16;rate=16000", 100) is None)
check("_is_raw_pcm 认 PCM/L16/raw", asr._is_raw_pcm("audio/L16;rate=16000") and asr._is_raw_pcm("raw"))
check("_is_raw_pcm 不认 webm/opus（不硬塞给 iat）", not asr._is_raw_pcm("audio/webm;codecs=opus"))
check("_frames 按 1280B 切帧", len(asr._frames(b"\x00" * 3000)) == 3)
check("_decode_audio 空串 ⇒ b''", _decode_audio("") == b"")
check("_decode_audio 脏 padding ⇒ b''（永不抛）", _decode_audio("abc") == b"")
check("_decode_audio 超长 ⇒ b''（防误传大文件）", _decode_audio("A" * 4_000_001) == b"")
check(
    "_decode_audio 合法 base64 还原字节",
    _decode_audio(base64.b64encode(b"\x01\x02\x03").decode("ascii")) == b"\x01\x02\x03",
)

print("[contract] /api/weather 契约形状（第四条链路 · 只读氛围）")
_w_resp_fields = getattr(WeatherResponse, "model_fields", None) or WeatherResponse.__fields__
check(
    "响应模型字段 = {kind, tempC, degraded, brightness, updatedAt}",
    set(_w_resp_fields) == {"kind", "tempC", "degraded", "brightness", "updatedAt"},
)
# ★ 隐私红线：天气请求**不接收任何用户字段**（它是一个无 body 的 GET）
check("未配 XIAOBU_HEFENG_* ⇒ is_configured() 为假（走 unknown）", weather.is_configured() is False)
check("kind_of_icon 100 晴 ⇒ clear", weather.kind_of_icon("100") == "clear")
check("kind_of_icon 104 阴 ⇒ cloudy", weather.kind_of_icon("104") == "cloudy")
check("kind_of_icon 305 小雨 ⇒ rain", weather.kind_of_icon("305") == "rain")
check("kind_of_icon 400 小雪 ⇒ snow", weather.kind_of_icon("400") == "snow")
check("kind_of_icon 脏值 ⇒ unknown", weather.kind_of_icon("abc") == "unknown")
check("kind_of_icon 非雨雪编码 ⇒ unknown", weather.kind_of_icon("4999") == "unknown")

_w_snap = weather.fetch_snapshot(now_ms=1_700_000_000_000)
check("未配置 ⇒ kind='unknown'", _w_snap["kind"] == "unknown")
check("未配置 ⇒ 降级码 2（拿不到）", _w_snap["degraded"] == 2)
check("未配置 ⇒ tempC 为 None", _w_snap["tempC"] is None)
check("快照恒含 updatedAt（注入值原样带出）", _w_snap["updatedAt"] == 1_700_000_000_000)
# ★ 一键停用优先于"未配置"：置位后降级码应为 3，且仍然只吐 unknown
os.environ["XIAOBU_WEATHER_DISABLED"] = "1"
_w_off = weather.fetch_snapshot(now_ms=1)
check("一键停用 ⇒ 降级码 3", _w_off["degraded"] == 3 and _w_off["kind"] == "unknown")
os.environ.pop("XIAOBU_WEATHER_DISABLED", None)
# ★ 契约自洽：fetch_snapshot 的输出必须能被 WeatherResponse 原样吸收（Pydantic 不报错）
check("快照能被 WeatherResponse 吸收", isinstance(WeatherResponse(**_w_snap), WeatherResponse))

print("[contract] 提示词（prompts.py）")
_msgs = prompts.build_chat_messages("我今天很累", "TIRED", 1)
check("对话消息含 system + user", [m["role"] for m in _msgs] == ["system", "user"])
check("system 里写了 34 字上限", "34" in _msgs[0]["content"])
_read_msgs = prompts.build_reading_messages(
    {"kind": "liuyao", "structure": "hexagram", "dims": {"mood_hint": "tired", "focus_hint": "career", "hexagram": 11}}
)
check("解读消息含 system + user", [m["role"] for m in _read_msgs] == ["system", "user"])

print("[contract] 真模型返回基线 · 离线（冻结样例必须能被契约层吸收）")
# ───────────────────────────────────────────────────────────────────────────
# ★ 以下三份是 **2026-10-10 用 deepseek-chat 真模型实测抓下的返回**（不是手编的）,
#   存的是 `_to_reading_response()` 的输入 content。模型输出是概率性的、无法逐字复现，
#   所以这里固化的不是"模型一定会这么说"，而是**真模型产出的形状**：真实样例必须原样
#   通过契约层 + 服务端禁词闸。将来谁改 `_to_reading_response` / guard 把真模型的形状
#   改坏了，这一节会立刻变红 —— 这就是"回归基线"的意义。
# ───────────────────────────────────────────────────────────────────────────
REAL_READING_LIUYAO: dict = {
    "title": "",
    "subtitle": "",
    "sections": [
        {
            "key": "now",
            "label": "此刻的你",
            "body": "硬币落下之后，房间里安静下来。你坐在那里，心里可能还悬着一件没放下的事。"
            "不用急着把它说清楚，也不用马上知道答案。你愿意做这个动作，本身就说明你在认真对待它。",
        }
    ],
    "summary": "我在这里，陪着此刻的你，这样也可以。",
    "moodLabel": "安静",
}
REAL_READING_TAROT: dict = {
    "title": "",
    "subtitle": "",
    "sections": [
        {
            "key": "past",
            "label": "已经走过的那些时候",
            "body": "有些事已经过去了。它们在你身上留下了痕迹，不管你有没有察觉。那些日子是真的，你走过来也是真的。",
        },
        {
            "key": "present",
            "label": "此刻你所在的地方",
            "body": "你正停在这里。可能有点安静，也可能有点吵。不用急着弄清楚什么，就先在这待一会儿。",
        },
        {
            "key": "future",
            "label": "还没到来的那一段",
            "body": "这一张还没翻开，先不急着读它。",
        },
    ],
    "summary": "两张已经翻开了，第三张还盖着。你不需要现在就走到那里。",
    "moodLabel": "安静",
}
REAL_CHAT: dict = {"reply": "心里那根弦绷得太紧，睡不踏实也正常，先这样待着就好。"}

_real_ly = _to_reading_response(REAL_READING_LIUYAO, 1)
check(
    "真模型 liuyao 样例 → 契约结构非空",
    _real_ly is not None and len(_real_ly.sections) > 0,
)
check(
    "真模型 liuyao 样例 每段 label / body 非空",
    _real_ly is not None and all(s.label and s.body for s in _real_ly.sections),
)
check(
    "真模型 liuyao 样例 过服务端禁词闸",
    _real_ly is not None and guard.reading_clean(_reading_visible(_real_ly)),
)
_real_t = _to_reading_response(REAL_READING_TAROT, 1)
check(
    "真模型 tarot 样例 → 3 段骨架",
    _real_t is not None and len(_real_t.sections) == 3,
)
check(
    "真模型 tarot 样例 过服务端禁词闸",
    _real_t is not None and guard.reading_clean(_reading_visible(_real_t)),
)
check("真模型共情样例 ≤34 字且无禁词", guard.empathy_reply_ok(REAL_CHAT["reply"]))
_blob = json.dumps([REAL_READING_LIUYAO, REAL_READING_TAROT, REAL_CHAT], ensure_ascii=False)
check("真模型冻结样例整体不含禁词", FORBIDDEN.search(_blob) is None)

print("[contract] 真模型返回基线 · 联网实测")
if not (LIVE and any(_SAVED_ENV.values())):
    print("  [skip] 默认跳过：设 XIAOBU_LIVE=1 且配好 XIAOBU_LLM_* 后再跑（见 server/README-LLM.md）")
else:
    # 还原启动时的 LLM 环境，走真模型；拿到什么就直接断言契约（不比对措辞）
    for _k, _v in _SAVED_ENV.items():
        if _v:
            os.environ[_k] = _v
    check("已配置 XIAOBU_LLM_*", llm.is_configured())
    _live_resp, _live_src = generate_reading_with_meta(
        ReadingRequest(
            kind="liuyao",
            dims={"mood": "ANXIOUS", "focus": "CAREER", "hexagram": 11},
            structure="hexagram",
        )
    )
    check("真模型解读走到 llm 源（未回落桩）", _live_src == "llm")
    check("真模型解读 sections 非空", len(_live_resp.sections) > 0)
    check("真模型解读 每段 label / body 非空", all(s.label and s.body for s in _live_resp.sections))
    check("真模型解读过服务端禁词闸", guard.reading_clean(_reading_visible(_live_resp)))
    _live_chat = llm.call_chat("最近工作压力好大，晚上总是翻来覆去睡不着。", "ANXIOUS", 1)
    check("真模型共情有回应", _live_chat is not None)
    if _live_chat is not None:
        _live_reply = str(_live_chat.content.get("reply") or "")
        check("真模型共情 ≤34 字且无禁词", guard.empathy_reply_ok(_live_reply))
        print(f"         真模型共情：{_live_reply}")
    # 测完把环境收回去，不留痕
    for _k in _LLM_KEYS:
        os.environ.pop(_k, None)

print()
if failed:
    print(f"[FAILED] {len(failed)} 项不通过")
    sys.exit(1)
print("[PASS] 契约自测全部通过")
