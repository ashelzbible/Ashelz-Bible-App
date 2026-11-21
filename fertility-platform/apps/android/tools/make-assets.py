"""Regenerate the Android launcher icons and splash screens (neutral demo artwork) at the sizes the project expects.
Run from apps/android:  python3 tools/make-assets.py   (needs Pillow)"""
import glob
from PIL import Image, ImageDraw

BRAND = (91, 42, 134)
RES = "android/app/src/main/res"


def ring(draw, cx, cy, r, ink, width):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink, width=width)
    d = r * 0.14
    px, py = cx + r * 0.707, cy - r * 0.707
    draw.ellipse([px - d, py - d, px + d, py + d], fill=ink)
    c = r * 0.18
    draw.ellipse([cx - c, cy - c, cx + c, cy + c], fill=ink)


def foreground(size):  # adaptive icon layer: artwork inside the central 66% safe zone, transparent elsewhere
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ring(ImageDraw.Draw(img), size / 2, size / 2, size * 0.27, "white", max(2, size // 22))
    return img


def legacy(size, round_):
    img = Image.new("RGBA", (size, size), BRAND + (255,))
    ring(ImageDraw.Draw(img), size / 2, size / 2, size * 0.34, "white", max(2, size // 20))
    if round_:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, size - 1, size - 1], fill=255)
        img.putalpha(mask)
    return img


for f in glob.glob(f"{RES}/mipmap-*/ic_launcher_foreground.png"):
    foreground(Image.open(f).size[0]).save(f)
for f in glob.glob(f"{RES}/mipmap-*/ic_launcher.png"):
    legacy(Image.open(f).size[0], False).save(f)
for f in glob.glob(f"{RES}/mipmap-*/ic_launcher_round.png"):
    legacy(Image.open(f).size[0], True).save(f)
for f in glob.glob(f"{RES}/drawable*/splash.png"):
    w, h = Image.open(f).size
    img = Image.new("RGB", (w, h), BRAND)
    ring(ImageDraw.Draw(img), w / 2, h / 2, min(w, h) * 0.14, "white", max(3, min(w, h) // 90))
    img.save(f)

open(f"{RES}/values/ic_launcher_background.xml", "w").write(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#5B2A86</color>\n</resources>\n'
)
print("assets regenerated")
