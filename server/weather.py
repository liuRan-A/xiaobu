"""
小卜 · 天气适配层（和风天气）   server/weather.py
==========================================================================
把「看一眼窗外」这件事收口到一个文件里，上层（main.py）只关心：

    snap = fetch_snapshot()      # Dict[str, Any]，永远是合法快照，永不抛

── 为什么天气也走自家后端代理 ──────────────────────────────────────────────
  和风 Key 是"用一次就烧一次额度"的东西，放客户端 = 解包即盗用。
  所以 Key 只在服务端环境变量里，客户端只见 **归一化快照**：
    { kind, tempC, degraded, brightness, updatedAt }
  路径里没有任何密钥（客户端门禁⑤会扫产物确认这一点）。

── 环境变量（只从 os.environ 读，绝不进客户端、绝不提交）──────────────────
    · XIAOBU_HEFENG_KEY         和风 Key      （放在 gitignored 的 server/.env）
    · XIAOBU_HEFENG_LOCATION    城市/经纬度 id（和风 location 参数）
    · XIAOBU_HEFENG_HOST        可选，默认 devapi.qweather.com（商业版换 api.qweather.com）
    · XIAOBU_HEFENG_TIMEOUT_MS  可选，默认 4000（必须小于客户端 5000ms）
    · XIAOBU_WEATHER_DISABLED   可选，置 1/true 时整条链路停用（秒级止血）
  两个必填缺一 ⇒ `is_configured()` 为假 ⇒ 返回 kind='unknown' + 降级码 2，
  客户端据此**什么都不提**（不是报错，是"今天先不说天气"）。

── 三条硬线 ────────────────────────────────────────────────────────────────
  ① **永不抛**：网络 / HTTP / JSON / 字段异常一律归一成 kind='unknown' + 降级码，
     上层与客户端都只需面对一个合法结构。
  ② **零行话**：只归一成 clear/cloudy/rain/snow/unknown 五档 —— 不返回"降水概率 /
     气压 / 风向"这类东西，也不报好坏（与客户端 WEATHER_LABEL 同调）。
  ③ **单向只读**：这份数据在客户端只流向氛围层，绝不参与六爻 / 塔罗 / 解读。

── 降级码（与客户端 @weather 的 WeatherDegraded 同源）──────────────────────
    0 = 正常；1 = 上游超时 / 无响应 / 解析失败；2 = 未配置或拿不到；3 = 被一键关停。
==========================================================================
"""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.request
from typing import Any, Dict, Optional

logger = logging.getLogger("xiaobu.weather")

# 和风天气默认接入点（公开常量，不是密钥）。商业版付费套餐换成 api.qweather.com
DEFAULT_HOST = "devapi.qweather.com"
NOW_PATH = "/v7/weather/now"

# 降级码（与客户端 WeatherDegraded 同源）
DEGRADED_OK = 0
DEGRADED_UPSTREAM = 1
DEGRADED_UNAVAILABLE = 2
DEGRADED_DISABLED = 3

# kind → 归一化氛围亮度（0..1）。客户端只用它做弱提示，拿不到就给 0.5。
_BRIGHTNESS: Dict[str, float] = {
    "clear": 0.85,
    "cloudy": 0.55,
    "rain": 0.35,
    "snow": 0.45,
    "unknown": 0.5,
}


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
    """两个必填项齐了才算"接了真天气"；缺一即视为未接入 → unknown + 降级 2。"""
    return bool(_env("XIAOBU_HEFENG_KEY") and _env("XIAOBU_HEFENG_LOCATION"))


def is_disabled() -> bool:
    """服务端一键停用天气（秒级止血）。"""
    return _env("XIAOBU_WEATHER_DISABLED").lower() in ("1", "true", "yes", "on")


# ───────────────────────────────────────────────────────────────────────────
# 归一化：和风的 icon 编码 → 五档 kind
# ───────────────────────────────────────────────────────────────────────────


def kind_of_icon(icon: Any) -> str:
    """
    和风 icon 编码 → clear / cloudy / rain / snow / unknown。
    ★ icon 是一串数字（如 "100"），按**前缀**分档：
        100 晴 → clear；101–103 多云 / 104 阴 → cloudy；
        3xx 雨 → rain；4xx 雪 → snow；其余 → unknown。
      只按前缀是因为和风把"小雨/中雨/大雨/暴雨"编成 300–399 的一整段。
    """
    s = str(icon or "").strip()
    if not s.isdigit():
        return "unknown"
    n = int(s)
    if n == 100:
        return "clear"
    if 101 <= n <= 104:
        return "cloudy"
    if 300 <= n <= 399:
        return "rain"
    if 400 <= n <= 499:
        return "snow"
    return "unknown"


def brightness_of_kind(kind: str) -> float:
    return _BRIGHTNESS.get(kind, 0.5)


def _unknown(degraded: int, now_ms: int) -> Dict[str, Any]:
    """合法但"没拿到"的快照：kind=unknown，客户端据此什么都不提。"""
    return {
        "kind": "unknown",
        "tempC": None,
        "degraded": degraded,
        "brightness": _BRIGHTNESS["unknown"],
        "updatedAt": now_ms,
    }


def _int_or_none(v: Any) -> Optional[int]:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(round(v))
    if isinstance(v, str) and v.strip().lstrip("+-").isdigit():
        return int(v.strip())
    return None


# ───────────────────────────────────────────────────────────────────────────
# 唯一出口
# ───────────────────────────────────────────────────────────────────────────


def fetch_snapshot(now_ms: Optional[int] = None) -> Dict[str, Any]:
    """
    取一份归一化天气快照。★ 永不抛：任何失败都返回一个合法结构（kind='unknown' + 降级码）。

    @param now_ms 注入当前时刻（测试用）；缺省取墙上时间。
    """
    now = int(now_ms if now_ms is not None else time.time() * 1000)

    if is_disabled():
        return _unknown(DEGRADED_DISABLED, now)
    if not is_configured():
        return _unknown(DEGRADED_UNAVAILABLE, now)

    host = _env("XIAOBU_HEFENG_HOST", DEFAULT_HOST)
    key = _env("XIAOBU_HEFENG_KEY")
    location = _env("XIAOBU_HEFENG_LOCATION")
    timeout_s = max(0.2, _int_env("XIAOBU_HEFENG_TIMEOUT_MS", 4000) / 1000.0)

    url = f"https://{host}{NOW_PATH}?location={location}&key={key}"
    req = urllib.request.Request(url, method="GET", headers={"accept": "application/json"})

    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 (host 由运维配置)
            raw = resp.read()
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001 —— 契约：永不抛，一律归一成降级快照
        logger.warning("[weather] fetch failed: %s", e)
        return _unknown(DEGRADED_UPSTREAM, now)

    if not isinstance(data, dict) or str(data.get("code")) != "200":
        # 和风 code ≠ 200：Key 失效 / 额度用尽 / location 非法 —— 都当"这次拿不到"
        logger.warning("[weather] hefeng code=%s", data.get("code") if isinstance(data, dict) else "?")
        return _unknown(DEGRADED_UNAVAILABLE, now)

    now_obj = data.get("now")
    if not isinstance(now_obj, dict):
        return _unknown(DEGRADED_UNAVAILABLE, now)

    kind = kind_of_icon(now_obj.get("icon"))
    return {
        "kind": kind,
        "tempC": _int_or_none(now_obj.get("temp")),
        "degraded": DEGRADED_OK,
        "brightness": brightness_of_kind(kind),
        "updatedAt": now,
    }
