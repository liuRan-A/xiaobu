"""
小卜 · 成本折算   server/cost.py
==========================================================================
把模型的 token 用量折成**分（cents）**，写进响应的 `cents` 字段。
客户端 `services/track` 拿到它累加，超过当日全局上限就触发熔断
（见 src/services/track 的 isLlmCircuitBlown / recordLlmCost）——
所以「花了多少钱」这个数必须由服务端诚实给出，客户端无从伪造。

── 为什么单位是"分"而不是"元" ──────────────────────────────────────────────
  单次解读的绝对花费极小（less than a cent），用元会长期显示 0。
  用分 + **向上取整**（ceil）保证"只要真的花了，就一定 ≥1 分"，
  于是熔断计数不会因为取整被静默吃成 0，钱花了却熔断不了。

── 价格从哪来 ──────────────────────────────────────────────────────────────
  ★ 只走 `os.environ`，绝不进客户端 config（门禁⑧：config 里只有开关/数值/URL）。
     · XIAOBU_LLM_CENTS_PER_1K_IN   输入 每 1K token 多少分（默认见下）
     · XIAOBU_LLM_CENTS_PER_1K_OUT  输出 每 1K token 多少分
  默认值是按 deepseek-chat 量级给的经验值：
    输入 ≈ $0.27 / 1M token ≈ 0.027 分/1K，输出 ≈ $1.10 / 1M ≈ 0.11 分/1K。
  换供应商时改这两个环境变量即可，不用动代码。
==========================================================================
"""

from __future__ import annotations

import math
import os

# ★ 默认价（分 / 1K token）。换模型时用环境变量覆盖，别改这里。
DEFAULT_CENTS_PER_1K_IN = 0.027
DEFAULT_CENTS_PER_1K_OUT = 0.11


def _float_env(name: str, fallback: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return fallback
    try:
        v = float(raw)
    except ValueError:
        return fallback
    return v if v >= 0 else fallback


def _int_of(v: object) -> int:
    if isinstance(v, bool):
        return 0
    if isinstance(v, int):
        return max(0, v)
    if isinstance(v, str) and v.strip().isdigit():
        return int(v.strip())
    return 0


def cents_for_usage(usage: dict[str, object] | None) -> int:
    """
    按 usage（OpenAI 兼容格式：prompt_tokens / completion_tokens）折算花费。

    ★ 永不抛：usage 缺失 / 字段非法 ⇒ 返回 0（调用方据此认为"这次没花钱"）。
    ★ 只要算出来 > 0，就向上取整到 ≥1 —— 见文件头"为什么单位是分"。
    """
    if not isinstance(usage, dict):
        return 0
    pin = _float_env("XIAOBU_LLM_CENTS_PER_1K_IN", DEFAULT_CENTS_PER_1K_IN)
    pout = _float_env("XIAOBU_LLM_CENTS_PER_1K_OUT", DEFAULT_CENTS_PER_1K_OUT)
    pt = _int_of(usage.get("prompt_tokens"))
    ct = _int_of(usage.get("completion_tokens"))
    cents = (pt * pin + ct * pout) / 1000.0
    if cents <= 0:
        return 0
    return max(1, int(math.ceil(cents)))
