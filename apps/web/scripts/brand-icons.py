"""Render the site's icon set from the new brand PNGs.

    cd apps/web && python3 scripts/brand-icons.py

Needs Pillow (`python3 -m pip install pillow`). Writes into public/ and prints each
file with its size. Re-run it when brand/ changes; the outputs are
committed, so the build itself never runs this.

Why PNG in, not SVG: the new brand exists only as raster art (1254 px masters).
There is no vector mark to hand, so there is no favicon.svg — a PNG wrapped in an
SVG would only add bytes. Browsers take favicon.ico (16/32/48) and the PNGs.

What goes where:
  · favicon.ico, icon-32.png — the bare mark, transparent. At 16 px a tile's
    dark square swallows the leaves; the mark alone survives on light and dark tabs.
  · apple-touch-icon.png — mark on an OPAQUE full-bleed square. iOS rounds the
    corners itself and paints transparency black, so the tile's own corners
    would show as a black ring.
  · icon-192.png, icon-512.png — the app tile as-is ("any" purpose).
  · icon-maskable-512.png — full-bleed background, mark inside the 80 % safe
    circle, because Android crops maskable icons to whatever shape it likes.

The background is the tile's own gradient, sampled from lotus-mobile-icon-dark.png
(top #212b55 → bottom #0b122e), so every opaque icon matches the tile.
"""

from pathlib import Path

from PIL import Image

WEB = Path(__file__).resolve().parent.parent
BRANDS = WEB.parent.parent / "brand"
PUBLIC = WEB / "public"

MARK = BRANDS / "mark" / "lotus-mark-dark.png"
TILE = BRANDS / "app-icons" / "lotus-mobile-icon-dark.png"

TOP = (33, 43, 85)
BOTTOM = (11, 18, 46)


def cropped(path: Path) -> Image.Image:
    """The artwork alone: the masters carry 2–5 % transparent padding."""
    image = Image.open(path).convert("RGBA")
    return image.crop(image.getchannel("A").getbbox())


def square(image: Image.Image) -> Image.Image:
    """Centre on a transparent square without scaling."""
    side = max(image.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((side - image.width) // 2, (side - image.height) // 2))
    return canvas


def gradient(side: int) -> Image.Image:
    column = Image.new("RGBA", (1, side))
    for y in range(side):
        t = y / max(side - 1, 1)
        column.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    return column.resize((side, side))


def on_ground(mark: Image.Image, side: int, fraction: float) -> Image.Image:
    """The mark centred on the opaque gradient, its longer edge at `fraction` of the side."""
    ground = gradient(side)
    scale = side * fraction / max(mark.size)
    art = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.LANCZOS)
    ground.alpha_composite(art, ((side - art.width) // 2, (side - art.height) // 2))
    return ground


def save(image: Image.Image, name: str, **options) -> None:
    out = PUBLIC / name
    image.save(out, optimize=True, **options)
    sizes = " ".join(f"{w}x{h}" for w, h in options.get("sizes", [image.size]))
    print(f"{name:24} {sizes:20} {out.stat().st_size / 1024:.1f} KB")


def main() -> None:
    mark = square(cropped(MARK))
    tile = square(cropped(TILE))

    small = lambda side: mark.resize((side, side), Image.LANCZOS)

    save(small(256), "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    save(small(32), "icon-32.png")
    # 0.62: the mark's visual weight matches the tile's own margin at this size.
    save(on_ground(mark, 180, 0.62), "apple-touch-icon.png")
    save(tile.resize((192, 192), Image.LANCZOS), "icon-192.png")
    save(tile.resize((512, 512), Image.LANCZOS), "icon-512.png")
    # 0.5 keeps the whole mark inside the 80 % safe circle (its diagonal is ~0.71).
    save(on_ground(mark, 512, 0.5), "icon-maskable-512.png")


if __name__ == "__main__":
    main()
