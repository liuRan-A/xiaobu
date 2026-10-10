"""
小卜 · 服务端二次禁词闸   server/guard.py
==========================================================================
★ 这是**第二道**防线，不是第一道。

  第一道在客户端：
    · 解读 —— src/services/llm.ts 的 `parseCloudReading()` 命中 `FORBIDDEN_COPY` 整份丢弃
    · 对话 —— src/services/empathyCloud.ts 的 `parseCloudEmpathy()` 过 `isEmpathySafe()`
  也就是说，即使本文件放行了一句脏话，客户端仍会丢弃它、回落本地模板/本地回应，
  脏文案**到不了用户眼前**。既然如此，为什么还必须在这里再守一次？

  因为「客户端会兜住」不该成为「服务端可以乱说」的理由：
    · 脏文案仍要花掉 token（钱），在服务端拦掉=不白花
    · 日志 / 将来任何服务端侧复用（导出、二次训练）都不该沾脏话
    · 一句话只靠一处守，等于没有守；两处同源，才叫结构性保证

★ 同源互指（改一处必须改两处，单测会把两边扫一遍）：
    · FORBIDDEN_COPY            ←→ src/core/guide/guide.ts 的 FORBIDDEN_COPY
    · FORBIDDEN_STRUCTURE_WORDS ←→ src/core/guide/guide.ts 的 FORBIDDEN_STRUCTURE_WORDS
    · EMPATHY_BANNED            ←→ src/core/empathy/empathy.ts 的 EMPATHY_BANNED
    · MAX_GUIDE_CHARS = 34      ←→ 同上两处的 34 字气泡尺
  客户端 guide.ts 的文件头写着「面向用户的文案里不许出现解释牌意/吉凶的词」，
  本文件把那句话编译成了正则。
==========================================================================
"""

from __future__ import annotations

import re

# ───────────────────────────────────────────────────────────────────────────
# 与客户端逐字对齐的三张表
# ───────────────────────────────────────────────────────────────────────────

# ★ 合规红线 + 行话。见 src/core/guide/guide.ts 的 FORBIDDEN_COPY
FORBIDDEN_COPY = re.compile(
    r"吉|凶|血光|运势|运程|开运|化解|改运|转运|预测|预言|命中注定|灵验|算命|命理|风水"
    r"|正位|逆位|牌意|寓意|爻辞|卦辞|五行|八字|生辰|抽签算"
)

# ★ 面向用户的结构词。见 src/core/guide/guide.ts 的 FORBIDDEN_STRUCTURE_WORDS
FORBIDDEN_STRUCTURE_WORDS = re.compile(r"塔罗区|六爻区|玩法|模块|入口|菜单项|Tab")

# ★ 语气红线：客服腔 / 心理诊断 / 空头承诺。见 src/core/empathy/empathy.ts 的 EMPATHY_BANNED
EMPATHY_BANNED = re.compile(
    r"请|抱歉|对不起|麻烦您|尽快|立刻|马上|你应该|建议你|心理|咨询|治疗|诊断|症状|抑郁|焦虑症|我会一直|永远|保证|承诺"
)

# ★ 与 EMPATHY_MAX_CHARS / MAX_GUIDE_CHARS 同一个数（34）
MAX_GUIDE_CHARS = 34

# 用户一句话最多 200 字（与客户端 EMPATHY_TEXT_MAX_CHARS 一致）
EMPATHY_TEXT_MAX_CHARS = 200


# ───────────────────────────────────────────────────────────────────────────
# 判定
# ───────────────────────────────────────────────────────────────────────────


def has_forbidden_copy(text: str) -> str | None:
    """命中就返回命中的词，否则 None —— 返回词是为了日志里能定位"""
    t = str(text or "")
    m = FORBIDDEN_COPY.search(t)
    if m:
        return m.group(0)
    m = FORBIDDEN_STRUCTURE_WORDS.search(t)
    return m.group(0) if m else None


def reading_clean(fields: dict[str, object]) -> bool:
    """
    解读响应是否干净。
    ★ 只扫**面向用户**的字段：title / subtitle / summary / moodLabel / 各段 label+body。
      cents 这类数值字段不扫。
    """
    blob = "".join(str(v) for k, v in fields.items() if isinstance(v, str))
    return has_forbidden_copy(blob) is None


def empathy_reply_ok(text: str) -> bool:
    """
    小卜的共情回应能不能给用户看。
    ★ 与客户端 `isEmpathySafe()` 同一把尺子：非空 / ≤34 字 / 三类禁词全躲开。
    """
    t = str(text or "").strip()
    if not t:
        return False
    if len(t) > MAX_GUIDE_CHARS:
        return False
    if FORBIDDEN_COPY.search(t):
        return False
    if FORBIDDEN_STRUCTURE_WORDS.search(t):
        return False
    if EMPATHY_BANNED.search(t):
        return False
    return True
