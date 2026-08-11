#!/usr/bin/env python3
"""
Generates the PWA icon set from the same mark as public/icons/icon.svg:
four muted bars and one taller accent bar, on the app's dark ink ground.

    python3 scripts/generate-icons.py

Regenerate only when the mark changes. Output goes to public/icons/.
"""
from PIL import Image, ImageDraw
from pathlib import Path

INK = (30, 27, 22, 255)
MUTED = (139, 129, 117, 255)
ACCENT = (79, 178, 123, 255)

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

# Height as a fraction of the drawable box, left to right. The last bar is the
# accent: the week's earnings rising to the Friday payout.
BARS = [
    (0.42, MUTED),
    (0.56, MUTED),
    (0.47, MUTED),
    (0.70, MUTED),
    (1.00, ACCENT),
]


def draw_mark(size: int, inset: float, rounded: bool) -> Image.Image:
    """inset is the fraction of the canvas kept clear around the mark."""
    scale = 4  # supersample, then downscale for clean edges
    canvas = size * scale
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=int(canvas * 0.22), fill=INK)
    else:
        draw.rectangle([0, 0, canvas, canvas], fill=INK)

    pad = canvas * inset
    box = canvas - 2 * pad
    bar_w = box * 0.14
    # Step across the full drawable width, not across one gap.
    step = (box - bar_w) / (len(BARS) - 1)
    baseline = pad + box

    for index, (h_frac, colour) in enumerate(BARS):
        x0 = pad + index * step
        height = box * h_frac
        draw.rounded_rectangle(
            [x0, baseline - height, x0 + bar_w, baseline],
            radius=bar_w * 0.3,
            fill=colour,
        )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # Standard icons: rounded, mark uses most of the canvas.
    for size in (192, 512):
        draw_mark(size, inset=0.21, rounded=True).save(OUT / f"icon-{size}.png")

    # Maskable: full bleed, mark inside the 80% safe zone so no OS mask clips it.
    for size in (192, 512):
        draw_mark(size, inset=0.28, rounded=False).save(OUT / f"icon-{size}-maskable.png")

    # iOS applies its own rounding and dislikes transparency.
    apple = draw_mark(180, inset=0.21, rounded=False).convert("RGB")
    apple.save(OUT / "apple-touch-icon.png")

    for path in sorted(OUT.glob("*.png")):
        print(f"  {path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
