"""
小卜 · 塔罗样张烘焙   scripts/bake-tarot-samples.py
==========================================================================
让「牌面素材 → WebP → 门禁②红线」这条**工程管线**先真实跑通一遍，再谈画风。

为什么先烘样张（而不是等美术真稿）：
  ① 管线 bug 要在有真稿之前踩完 —— 否则美术交稿那天才发现"又超 100KB 又超边"。
  ② 样张本身就是用户逐轮确认过的视觉定稿（程序化黄昏落日 × 玄学稿），
     真稿到位时**同名覆盖**即可，代码零改动。
  ③ 产出的 `manifest.json` 就是"哪些牌面进主包、各自多大"的事实来源，
     与 `ci/art-whitelist.txt` 一一对应。

本脚本做四件事：
  1. 程序化绘制 N 张样张（RGBA，黄昏渐变 + 奶油内框 + 星月 + 远山）
  2. `convert('RGB')` 去 alpha → `resize(512×768, LANCZOS)`
  3. 自适应降质编码 WebP，直到 ≤ 100 KiB；**脚本内断言** 单边 ≤ 768px 且 ≤ 102400B
  4. 覆写 `src/assets/tarot/manifest.json`

用法：  python scripts/bake-tarot-samples.py          # 只烘 3 张主包样张（faces/core）
        python scripts/bake-tarot-samples.py --all    # 再烘其余 75 张到 export/（待上传 CDN）
依赖：  Pillow（本机 12.2.0 可用）
==========================================================================
"""

from __future__ import annotations

import io
import json
import pathlib
import sys

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "src" / "assets" / "tarot" / "faces" / "core"
MANIFEST = ROOT / "src" / "assets" / "tarot" / "manifest.json"
# ★ 按需牌面**不入库**（门禁①：主包 dist 单次增量 ≤256KB；门禁②：位图须登记）。
#   它们上传到 CDN，路径与 config.assets.cdnBase 下的 `dirs.ondemand` 对齐：
#   `tarot/faces/ondemand/<slug>.webp`。这里先落到仓库外的 export/ 暂存区等上传。
EXPORT_DIR = ROOT / "export" / "tarot" / "faces" / "ondemand"

# ── 门禁② 塔罗红线（与 ci/gates/02-no-uncompressed-png.mjs 同一组数，脚本内自断言）──
LIMIT_BYTES = 100 * 1024  # 100 KiB
MAX_EDGE = 768

# 绘制尺寸 → 成品尺寸（先大后缩，边缘更干净）
SRC_W, SRC_H = 1024, 1536
OUT_W, OUT_H = 512, 768

# ★ 与 src/scene/renderer/tokens.gen.ts 同源色（cCream / cDuskRose / cDusk / cDuskDeep / cDuskHill）
CREAM = (253, 249, 246)
DUSK_ROSE = (232, 160, 140)
DUSK = (123, 106, 146)
DUSK_DEEP = (90, 74, 117)
DUSK_HILL = (74, 61, 99)


def mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


def vertical_gradient(w: int, h: int) -> Image.Image:
    """黄昏落日三段渐变：余晖粉橘 → 黄昏紫 → 背光深紫（与卡背同稿）"""
    stops = [
        (0.0, mix(DUSK_ROSE, (255, 255, 255), 0.1)),
        (0.42, DUSK_ROSE),
        (0.72, DUSK),
        (1.0, DUSK_DEEP),
    ]
    img = Image.new("RGBA", (w, h))
    draw = ImageDraw.Draw(img)
    for y in range(h):
        f = y / (h - 1)
        # 定位 f 落在哪两段之间
        for i in range(len(stops) - 1):
            f0, c0 = stops[i]
            f1, c1 = stops[i + 1]
            if f0 <= f <= f1:
                t = 0.0 if f1 == f0 else (f - f0) / (f1 - f0)
                draw.line([(0, y), (w, y)], fill=mix(c0, c1, t) + (255,))
                break
    return img


def color_at(f: float) -> tuple[int, int, int]:
    """取渐变在纵向比例 f 处的颜色（用于把"咬月牙"的圆填成底色，做得像真的）"""
    if f < 0.42:
        return mix(mix(DUSK_ROSE, (255, 255, 255), 0.1), DUSK_ROSE, f / 0.42)
    if f < 0.72:
        return mix(DUSK_ROSE, DUSK, (f - 0.42) / 0.30)
    return mix(DUSK, DUSK_DEEP, (f - 0.72) / 0.28)


def draw_face(variant: dict) -> Image.Image:
    """画一张样张。variant 控制月相位置 / 星点 / 山脊高度，让三张样张彼此可辨。"""
    w, h = SRC_W, SRC_H
    img = vertical_gradient(w, h)
    draw = ImageDraw.Draw(img)

    # ① 远山剪影（两段交错弧丘，落日山丘的"线条感"，极简两笔 → 用多边形近似）
    hill_top = h * (1 - variant["hill"])
    draw.polygon(
        [
            (0, h),
            (0, hill_top + h * 0.02),
            (w * 0.3, hill_top - h * variant["hill_peak"]),
            (w * 0.55, hill_top + h * 0.01),
            (w * 0.8, hill_top - h * variant["hill_peak"] * 0.6),
            (w, hill_top + h * 0.01),
            (w, h),
        ],
        fill=DUSK_HILL,
    )

    # ② 奶油白内框（手绘描边感，压住渐变不让它飘）
    inset = int(w * 0.035)
    draw.rounded_rectangle(
        [inset, inset, w - inset, h - inset],
        radius=int(w * 0.03),
        outline=CREAM,
        width=max(2, int(w * 0.006)),
    )

    # ③ 星月：奶油白圆 + 用**同坐标底色**咬掉一块（咬口不出现补丁色差）
    mx, my, mr = int(w * variant["moon_x"]), int(h * variant["moon_y"]), int(w * 0.13)
    draw.ellipse([mx - mr, my - mr, mx + mr, my + mr], fill=CREAM)
    bite_r = int(mr * 0.92)
    bite_dx = int(mr * 0.42)
    bite_dy = int(mr * 0.30)
    bx, by = mx + bite_dx, my - bite_dy
    draw.ellipse([bx - bite_r, by - bite_r, bx + bite_r, by + bite_r], fill=color_at(by / h) + (255,))

    # ④ 星点（错相分布，让牌面"活"一点，仍是极简）
    for sx, sy, sr in variant["stars"]:
        cx, cy, r = int(w * sx), int(h * sy), int(w * sr)
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=CREAM)

    return img


# ── 三张样张：牌面 slug 必须与 src/core/tarot/cardsIndex.ts 对齐 ──────────────
SAMPLES: list[dict] = [
    {
        "id": "major-00",
        "slug": "the-fool",
        "variant": {
            "moon_x": 0.62, "moon_y": 0.30, "hill": 0.16, "hill_peak": 0.08,
            "stars": [(0.30, 0.24, 0.010), (0.74, 0.20, 0.008), (0.44, 0.40, 0.009)],
        },
    },
    {
        "id": "major-17",
        "slug": "the-star",
        "variant": {
            "moon_x": 0.50, "moon_y": 0.24, "hill": 0.13, "hill_peak": 0.10,
            "stars": [(0.28, 0.18, 0.009), (0.72, 0.16, 0.010), (0.36, 0.34, 0.008), (0.66, 0.32, 0.008)],
        },
    },
    {
        "id": "major-18",
        "slug": "the-moon",
        "variant": {
            "moon_x": 0.42, "moon_y": 0.38, "hill": 0.19, "hill_peak": 0.06,
            "stars": [(0.70, 0.22, 0.009), (0.60, 0.36, 0.007), (0.82, 0.44, 0.008)],
        },
    },
]

# ── 全副 78 张的 id/slug（★ 必须与 src/core/tarot/cardsIndex.ts 逐字对齐）────────
#   为什么在这里再写一份：烘焙脚本是 Python，够不到 TS 模块。漂移由
#   tests/tarot-assets.spec.ts 兜底（主包 3 张的 id/slug 会被断回 cardsIndex）。
MAJOR_SLUGS = [
    "the-fool", "the-magician", "the-high-priestess", "the-empress", "the-emperor",
    "the-hierophant", "the-lovers", "the-chariot", "strength", "the-hermit",
    "wheel-of-fortune", "justice", "the-hanged-man", "death", "temperance",
    "the-devil", "the-tower", "the-star", "the-moon", "the-sun", "judgement", "the-world",
]
SUITS = ["wands", "cups", "swords", "pentacles"]
RANK_SLUGS = [
    "ace", "two", "three", "four", "five", "six", "seven",
    "eight", "nine", "ten", "page", "knight", "queen", "king",
]


def all_cards() -> list[tuple[str, str]]:
    """全副 78 张 (id, slug)。大阿卡纳在前，小阿卡纳按 权杖→圣杯→宝剑→星币 分组。"""
    cards: list[tuple[str, str]] = []
    for i, slug in enumerate(MAJOR_SLUGS):
        cards.append((f"major-{i:02d}", slug))
    for suit in SUITS:
        for j, rank in enumerate(RANK_SLUGS):
            cards.append((f"{suit}-{j + 1:02d}", f"{suit}-{rank}"))
    assert len(cards) == 78, f"全副应为 78 张，实得 {len(cards)}"
    return cards


def derived_variant(card_id: str) -> dict:
    """
    从牌 id 派生一个**确定性**的构图参数（禁随机 —— 同一张牌每次烘出同一张脸）。
    只调月相位置 / 山脊高度 / 星点，保持"黄昏落日 × 玄学"这一套统一画风。
    """
    s = sum(ord(c) for c in card_id)
    return {
        "moon_x": 0.28 + (s % 44) / 100,
        "moon_y": 0.18 + ((s * 7) % 34) / 100,
        "hill": 0.12 + ((s * 3) % 8) / 100,
        "hill_peak": 0.05 + ((s * 5) % 7) / 100,
        "stars": [
            (0.22 + ((s * 2) % 56) / 100, 0.16 + ((s * 3) % 30) / 100, 0.008),
            (0.30 + ((s * 5) % 50) / 100, 0.26 + ((s * 7) % 28) / 100, 0.009),
            (0.24 + ((s * 11) % 54) / 100, 0.34 + ((s * 13) % 24) / 100, 0.007),
        ],
    }


def encode_webp(img: Image.Image) -> tuple[bytes, int, tuple[int, int]]:
    """
    去 alpha → 缩到 512×768 → 自适应降质 WebP。
    ★ 断言：单边 ≤ 768px 且 ≤ 100 KiB —— 宁可脚本失败，也不让超限文件落盘。
    """
    rgb = img.convert("RGB")  # ← 去 alpha（门禁② 不欢迎多余的透明通道）
    resized = rgb.resize((OUT_W, OUT_H), Image.LANCZOS)

    quality = 92
    buf = io.BytesIO()
    while True:
        buf = io.BytesIO()
        resized.save(buf, format="WEBP", quality=quality, method=6)
        if buf.tell() <= LIMIT_BYTES or quality <= 40:
            break
        quality -= 6

    data = buf.getvalue()
    edge = max(OUT_W, OUT_H)
    assert edge <= MAX_EDGE, f"单边 {edge}px > {MAX_EDGE}px 红线"
    assert len(data) <= LIMIT_BYTES, f"{len(data)}B > {LIMIT_BYTES}B 红线（即使 quality=40）"
    return data, quality, (OUT_W, OUT_H)


def main(argv: list[str]) -> int:
    bake_all = "--all" in argv
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    entries: list[dict] = []
    core_slugs: set[str] = set()
    print("[bake-tarot] 烘焙主包样张（faces/core）")

    for s in SAMPLES:
        data, quality, (w, h) = encode_webp(draw_face(s["variant"]))
        out = OUT_DIR / f"{s['slug']}.webp"
        out.write_bytes(data)
        core_slugs.add(s["slug"])
        entries.append(
            {
                "id": s["id"],
                "slug": s["slug"],
                "file": out.name,
                "core": True,
                "bytes": len(data),
                "w": w,
                "h": h,
            }
        )
        print(
            f"  · {out.name}  {w}×{h}  quality={quality}  {len(data) / 1024:.1f}KB"
            f"  ≤ {LIMIT_BYTES / 1024:.0f}KB / ≤ {MAX_EDGE}px  ✓"
        )

    manifest = {
        "schemaVersion": 1,
        "_comment": (
            "塔罗牌面资产登记（由 scripts/bake-tarot-samples.py 生成，勿手改）。"
            "faces 只登记**进主包/已知**的那几张；78 张里的其余牌面走 CDN 按需加载，"
            "URL 由 config.assets.cdnBase 派生（见 src/services/tex/tarotPath.ts）。"
        ),
        "dirs": {"core": "tarot/faces/core/", "ondemand": "tarot/faces/ondemand/"},
        "faces": sorted(entries, key=lambda e: e["id"]),
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[bake-tarot] ✓ 已更新 {MANIFEST.relative_to(ROOT)}（{len(entries)} 条）")

    if bake_all:
        # 其余 75 张：确定性构图 → export/ 暂存（不入库、不进主包），等上传 CDN。
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        total = 0
        worst = 0
        count = 0
        print("[bake-tarot] 烘焙按需牌面（faces/ondemand → export/，待上传 CDN）")
        for cid, slug in all_cards():
            if slug in core_slugs:
                continue
            data, _quality, _wh = encode_webp(draw_face(derived_variant(cid)))
            (EXPORT_DIR / f"{slug}.webp").write_bytes(data)
            total += len(data)
            worst = max(worst, len(data))
            count += 1
        assert count == 78 - len(core_slugs), f"按需应为 {78 - len(core_slugs)} 张，实得 {count}"
        print(
            f"[bake-tarot] ✓ {count} 张 → {EXPORT_DIR.relative_to(ROOT)}"
            f"  合计 {total / 1024:.1f}KB  最大 {worst / 1024:.1f}KB"
        )
        print("[bake-tarot]   上传后 URL 形如 {cdnBase}/tarot/faces/ondemand/<slug>.webp")

    print("[bake-tarot] 下一步：node ci/gates/02-no-uncompressed-png.mjs → node ci/ci.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
