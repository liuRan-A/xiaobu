"""
小卜 · 模型适配层   server/llm.py
==========================================================================
把「问模型要一段话」这件事收口到一个文件里，上层（main.py）只关心：
    result = call_reading(req)     # 解读 → LlmResult | None
    result = call_chat(text,...)   # 共情 → LlmResult | None
None 的含义永远是「这一份拿不到，请你回落桩」——本模块**永不抛异常给上层**。

── 供应商无关 ──────────────────────────────────────────────────────────────
  只认 OpenAI 兼容的 `POST {base}/chat/completions`。换供应商（DeepSeek / 通义 /
  自建 vLLM…）只需改环境变量，代码一行不动：
    · XIAOBU_LLM_BASE       例 https://api.deepseek.com/v1  （可含 /chat/completions）
    · XIAOBU_LLM_KEY        密钥 —— ★ 只在服务端环境变量里，绝不进客户端 config（门禁⑧）
    · XIAOBU_LLM_MODEL      例 deepseek-chat
    · XIAOBU_LLM_TIMEOUT_MS 服务端**总预算**（默认 4500）
    · XIAOBU_LLM_MAX_RETRY  最多重试几次（默认 1）
  用标准库 urllib 发请求，不引入 requests/httpx —— 与仓库「核心零新依赖」的纪律一致。

── 超时预算：必须严格小于客户端的 6000ms ────────────────────────────────────
  客户端 llm.ts / empathyCloud.ts 的超时都是 6000ms，到点就撤、回落本地。
  如果服务端比它慢，客户端**先走了**，这一次 token 花了却没人看 —— 白花钱。
  所以这里的 `XIAOBU_LLM_TIMEOUT_MS` 是**总预算**（默认 4500，留 1.5s 余量）：
    · 单次尝试以「预算剩余」为上限（不会一次就吃光整个预算）
    · 只有还剩得下足够时间时才重试（快速失败的重试才有意义）
    · 预算耗尽即放弃，返回 None
==========================================================================
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
from dataclasses import dataclass
from typing import Any

from server import cost, prompts

logger = logging.getLogger("xiaobu.llm")


@dataclass
class LlmResult:
    """一份成功的模型返回：解析后的 JSON 内容 + 本次花费（分）"""

    content: dict[str, Any]
    cents: int


# ───────────────────────────────────────────────────────────────────────────
# 环境变量（只走 os.environ）
# ───────────────────────────────────────────────────────────────────────────


def _env(name: str, fallback: str = "") -> str:
    return os.environ.get(name, "").strip() or fallback


def _int_env(name: str, fallback: int) -> int:
    raw = _env(name)
    if not raw:
        return fallback
    try:
        v = int(raw)
    except ValueError:
        return fallback
    return v if v >= 0 else fallback


def is_configured() -> bool:
    """三个必填项齐了才算"接了真模型"；缺一即视为未配置 → 用桩。"""
    return bool(_env("XIAOBU_LLM_BASE") and _env("XIAOBU_LLM_KEY") and _env("XIAOBU_LLM_MODEL"))


# ───────────────────────────────────────────────────────────────────────────
# 单次 HTTP（OpenAI 兼容）
# ───────────────────────────────────────────────────────────────────────────


def _chat_url() -> str:
    base = _env("XIAOBU_LLM_BASE").rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _chat_completion(messages: list[dict[str, str]], budget_ms: int) -> dict[str, Any]:
    """
    发一次请求并返回解析后的响应 JSON。★ 网络 / HTTP / JSON 异常一律向上抛，
    由 `_call()` 统一捕获并决定是否重试 —— 这里保持"薄"。
    """
    body = json.dumps(
        {
            "model": _env("XIAOBU_LLM_MODEL"),
            "messages": messages,
            "temperature": 0.8,
            "stream": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        _chat_url(),
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "authorization": f"Bearer {_env('XIAOBU_LLM_KEY')}",
        },
    )
    timeout_s = max(0.2, budget_ms / 1000.0)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 (base 由运维配置)
        raw = resp.read()
    return json.loads(raw)


def _call(messages: list[dict[str, str]]) -> dict[str, Any] | None:
    """
    带总预算的重试调用。★ 永不抛：全部失败返回 None。
    """
    total_ms = _int_env("XIAOBU_LLM_TIMEOUT_MS", 4500)
    max_retry = _int_env("XIAOBU_LLM_MAX_RETRY", 1)
    deadline = time.monotonic() + total_ms / 1000.0
    attempts = max_retry + 1

    for i in range(attempts):
        remaining_ms = int((deadline - time.monotonic()) * 1000)
        if remaining_ms <= 200:
            break
        try:
            return _chat_completion(messages, remaining_ms)
        except Exception as e:  # noqa: BLE001 —— 适配层刻意吞掉一切，交给上层回落桩
            logger.warning("[llm] attempt %d/%d failed: %s", i + 1, attempts, e)
    return None


# ───────────────────────────────────────────────────────────────────────────
# 响应内容抽取（模型常常会把 JSON 包在 markdown 围栏里，要能剥出来）
# ───────────────────────────────────────────────────────────────────────────


def _content_of(data: dict[str, Any]) -> str:
    try:
        return str(data["choices"][0]["message"]["content"] or "")
    except (KeyError, IndexError, TypeError):
        return ""


def _extract_json(text: str) -> dict[str, Any] | None:
    """
    从模型输出里抠出第一个 JSON 对象。
    ★ 容错顺序：直接 parse → 去掉 ``` 围栏 → 取第一个 { 到最后一个 } 之间。
      全都失败返回 None（上层据此回落桩）。
    """
    s = str(text or "").strip()
    if not s:
        return None
    for candidate in _candidates(s):
        try:
            v = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(v, dict):
            return v
    return None


def _candidates(s: str) -> list[str]:
    out = [s]
    # 剥掉 markdown 代码围栏
    if s.startswith("```"):
        stripped = s.strip("`")
        # 去掉可能的语言标注（json\n…）
        if "\n" in stripped:
            stripped = stripped.split("\n", 1)[1]
        out.append(stripped.strip())
    # 取首个 { 到末个 } 之间
    a, b = s.find("{"), s.rfind("}")
    if a != -1 and b > a:
        out.append(s[a : b + 1])
    return out


# ───────────────────────────────────────────────────────────────────────────
# 出口（两条链路）
# ───────────────────────────────────────────────────────────────────────────


def _result_from(data: dict[str, Any] | None, want_key: str) -> LlmResult | None:
    if not data:
        return None
    content = _extract_json(_content_of(data))
    if content is None:
        return None
    if want_key and want_key not in content:
        return None
    usage = data.get("usage")
    return LlmResult(content=content, cents=cost.cents_for_usage(usage if isinstance(usage, dict) else None))


def call_reading(req: dict[str, Any]) -> LlmResult | None:
    """
    解读链路：把 {kind, dims, structure} 交给模型，要一份结构化 JSON。
    返回 None = 未配置 / 调用失败 / JSON 解析失败 —— 上层回落桩。
    ★ 本函数**不**做禁词判定（那是 guard.py 的职责）；它只管"拿到结构"。
    """
    if not is_configured():
        return None
    messages = prompts.build_reading_messages(req)
    return _result_from(_call(messages), want_key="sections")


def call_chat(text: str, mood: str | None, turns: int) -> LlmResult | None:
    """
    共情链路：把用户这一句交给模型，要一句 ≤34 字的回应。
    ★ `text` 只在客户端 consent='on' 时才存在（独立同意通道，见 README-LLM.md）。
    ★ 不落盘、不打日志正文 —— 见 main.py 的 /api/chat。
    """
    if not is_configured():
        return None
    if not str(text or "").strip():
        return None
    messages = prompts.build_chat_messages(text, mood, turns)
    return _result_from(_call(messages), want_key="reply")
