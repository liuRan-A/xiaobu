"""
小卜 · 语音听写适配层（科大讯飞 iat）   server/asr.py
==========================================================================
把「一段音频 → 一句话」这件事收口到一个文件里，上层（main.py）只关心：

    text = transcribe(audio_bytes, fmt, duration_ms)   # str | None

None 的含义永远是「这一份没听清 / 没配置 / 拿不到」——本模块**永不抛异常给上层**。
于是客户端的降级路径只有一条：`text 为空 ⇒ 提示'没听清，再试一次'`，与网络无关。

── 供应商与密钥 ────────────────────────────────────────────────────────────
  走科大讯飞实时语音听写 WebSocket（`wss://iat-api.xfyun.cn/v2/iat`）。
  三个密钥**只从环境变量读**，绝不进客户端、绝不写进任何提交的文件：
    · XIAOBU_IFLYTEK_APPID
    · XIAOBU_IFLYTEK_APIKEY
    · XIAOBU_IFLYTEK_APISECRET       （放在 gitignored 的 server/.env 里）
  三者缺一 ⇒ `is_configured()` 为假 ⇒ 端点直接回落"没听清"，客户端行为与断网一致。

── 音频格式（重要，别踩坑）─────────────────────────────────────────────────
  讯飞 iat 只吃 **PCM 16bit / 单声道**（raw），常见采样率 16000Hz。
  浏览器 `MediaRecorder` 默认吐的是 `audio/webm;codecs=opus` —— **不能直接喂给 iat**。
  所以本模块只负责"把已经能喂的字节发上去"：
    · fmt 里含 'pcm' / 'raw' / 'l16' ⇒ 按 raw 直接发；
    · 其它格式 ⇒ 视为**当前环境不具备转码能力**，返回 None（回落"没听清"），
      而不是把 webm 硬塞给 iat 换来一堆 code!=0 的噪音。
  生产接入时，请让客户端采集 PCM16@16k（或用服务端转码），本函数无需改动。

── 可选依赖 ────────────────────────────────────────────────────────────────
  用了 `websockets`（见 requirements.txt 的注释行）。它**没装**时本模块照样不崩：
  `transcribe()` 直接返回 None，等于"这条链路暂不可用"，与未配置同一条降级路径。
==========================================================================
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from email.utils import formatdate
from typing import Any, Optional
from urllib.parse import quote

logger = logging.getLogger("xiaobu.asr")

# ── 讯飞 iat 接入点（公开常量，不是密钥）────────────────────────────────────
IAT_HOST = "iat-api.xfyun.cn"
IAT_PATH = "/v2/iat"

# ── 单次听写的音频上限（字节）。约 2 分钟的 opus；超出直接拒绝，防滥用与误传大文件。
MAX_AUDIO_BYTES = 2_000_000

# ── 帧参数：16k / 16bit / 单声道，40ms 一帧 = 16000 * 2 * 0.04 = 1280 字节
FRAME_BYTES = 1280
FRAME_INTERVAL_S = 0.04

# 讯飞要求每个连接有上限时长（这里给 60s 的余量，正常一段话远用不到）
RESULT_COLLECT_TIMEOUT_S = 20.0

# 可选依赖：没装就整条链路不可用（不崩、不抛）
try:  # pragma: no cover - 取决于运行环境是否装了 websockets
    from websockets.sync.client import connect as _ws_connect  # type: ignore
except Exception:  # noqa: BLE001 —— 刻意吞掉，缺依赖不是错误，是降级
    _ws_connect = None  # type: ignore[assignment]


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def is_configured() -> bool:
    """三个密钥齐了、且 websockets 可用，才算"接了真听写"；缺一即视为未接入。"""
    return bool(
        _ws_connect is not None
        and _env("XIAOBU_IFLYTEK_APPID")
        and _env("XIAOBU_IFLYTEK_APIKEY")
        and _env("XIAOBU_IFLYTEK_APISECRET")
    )


# ───────────────────────────────────────────────────────────────────────────
# 鉴权 URL（讯飞 v2 的 HMAC-SHA256 签名）
# ───────────────────────────────────────────────────────────────────────────


def _auth_url() -> Optional[str]:
    """
    拼出带 authorization 的 wss URL。
    ★ 签名只在本进程内算，用到 api_secret 但**绝不**把它写进 URL 或日志。
    """
    app_id = _env("XIAOBU_IFLYTEK_APPID")
    api_key = _env("XIAOBU_IFLYTEK_APIKEY")
    api_secret = _env("XIAOBU_IFLYTEK_APISECRET")
    if not (app_id and api_key and api_secret):
        return None

    date = formatdate(timeval=None, localtime=False, usegmt=True)
    signature_origin = f"host: {IAT_HOST}\ndate: {date}\nGET {IAT_PATH} HTTP/1.1"
    signature_sha = hmac.new(
        api_secret.encode("utf-8"), signature_origin.encode("utf-8"), digestmod=hashlib.sha256
    ).digest()
    signature = base64.b64encode(signature_sha).decode("utf-8")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode("utf-8")).decode("utf-8")
    return (
        f"wss://{IAT_HOST}{IAT_PATH}"
        f"?authorization={authorization}&date={quote(date)}&host={IAT_HOST}"
    )


# ───────────────────────────────────────────────────────────────────────────
# 音频格式判定与切帧
# ───────────────────────────────────────────────────────────────────────────


def _is_raw_pcm(fmt: str) -> bool:
    f = str(fmt or "").lower()
    return ("pcm" in f) or ("raw" in f) or ("l16" in f)


def _frames(audio: bytes) -> list[bytes]:
    """按 FRAME_BYTES 切帧；最后一帧可能不足，也照发（讯飞按 status 判定结束）。"""
    return [audio[i : i + FRAME_BYTES] for i in range(0, len(audio), FRAME_BYTES)]


def _text_of(payload: dict[str, Any]) -> str:
    """从一帧识别结果里抽出文字（含动态修正时把平滑结果也拼上）。"""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    result = data.get("result")
    if not isinstance(result, dict):
        return ""
    out = ""
    ws_list = result.get("ws")
    if isinstance(ws_list, list):
        for ws in ws_list:
            cws = ws.get("cw") if isinstance(ws, dict) else None
            if isinstance(cws, list):
                for cw in cws:
                    if isinstance(cw, dict):
                        out += str(cw.get("w") or "")
    return out


# ───────────────────────────────────────────────────────────────────────────
# 唯一出口
# ───────────────────────────────────────────────────────────────────────────


def transcribe(audio_bytes: bytes, fmt: str, duration_ms: int) -> Optional[str]:
    """
    一段音频 → 一句话。★ 永不抛：任何失败（未配置 / 缺依赖 / 格式不支持 / 网络 /
    协议错误 / 空结果）都返回 None，由上层回落"没听清"。

    @param audio_bytes 原始音频字节（非 base64）
    @param fmt         容器 / 编码声明（决定是否按 raw PCM 处理）
    @param duration_ms 录音时长（毫秒，仅用于日志与兜底判断，可不信）
    """
    if _ws_connect is None:
        return None
    if not is_configured():
        return None
    if not audio_bytes:
        return None
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        logger.warning("[asr] audio too large: %d bytes", len(audio_bytes))
        return None
    if not _is_raw_pcm(fmt):
        # ★ 不硬塞 webm/opus 给 iat —— 那只会换来一串 code!=0 的噪音（见文件头说明）
        logger.warning("[asr] unsupported audio format for iat: %s (need raw PCM16@16k)", fmt)
        return None

    url = _auth_url()
    if url is None:
        return None

    app_id = _env("XIAOBU_IFLYTEK_APPID")
    business = {"language": "zh_cn", "domain": "iat", "accent": "mandarin", "vad_eos": 3000}
    common = {"app_id": app_id}
    frames = _frames(audio_bytes)

    try:
        chunks: list[str] = []
        with _ws_connect(url, open_timeout=6, close_timeout=3) as ws:
            for idx, frame in enumerate(frames):
                status = 0 if idx == 0 else 2 if idx == len(frames) - 1 else 1
                audio_b64 = base64.b64encode(frame).decode("utf-8")
                packet: dict[str, Any] = {
                    "data": {
                        "status": status,
                        "format": "audio/L16;rate=16000",
                        "encoding": "raw",
                        "audio": audio_b64,
                    }
                }
                if idx == 0:
                    packet["common"] = common
                    packet["business"] = business
                ws.send(json.dumps(packet))
                # 逐帧读取结果（讯飞会为每帧回一条）
                try:
                    raw = ws.recv(timeout=RESULT_COLLECT_TIMEOUT_S)
                except Exception:  # noqa: BLE001 —— 读超时按"这帧没有结果"处理
                    continue
                payload = json.loads(raw)
                if int(payload.get("code", 0)) != 0:
                    logger.warning("[asr] iflytek code=%s", payload.get("code"))
                    continue
                chunks.append(_text_of(payload))
                time.sleep(FRAME_INTERVAL_S)
        text = "".join(chunks).strip()
        return text or None
    except Exception as e:  # noqa: BLE001 —— 契约：永不抛给上层，一律回落"没听清"
        logger.warning("[asr] transcribe failed: %s", e)
        return None
