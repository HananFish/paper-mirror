"""生成 PWA 图标（靛蓝底 + 译字），写入 frontend/public/icons/。"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "frontend" / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def make_icon(size: int, path: Path) -> None:
    img = Image.new("RGB", (size, size), (79, 70, 229))  # indigo-600
    draw = ImageDraw.Draw(img)
    # 圆角效果：直接画满即可（系统会裁圆角）
    font = None
    for cand in ("msyhbd.ttc", "msyh.ttc", "simhei.ttf"):
        try:
            font = ImageFont.truetype(f"C:/Windows/Fonts/{cand}", int(size * 0.55))
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    text = "译"
    bbox = draw.textbbox((0, 0), text, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text(((size - w) / 2 - bbox[0], (size - h) / 2 - bbox[1]), text, font=font, fill="white")
    img.save(path)


for s in (192, 512):
    make_icon(s, OUT / f"icon-{s}.png")
print("icons written:", OUT)
