"""Trim the league seal for the site: a thin soft white outline instead of the original's wide white border.

Reads assets/img/mgdx-logo.png and writes assets/img/mgdx-seal.png with transparent corners. Requires
Pillow. Run from the site root:

    python tools/build-seal.py
"""
from PIL import Image, ImageChops, ImageDraw, ImageFilter

OUTLINE = .022  # solid white past the seal's navy edge, as a share of its radius
GLOW = .022  # soft fade beyond that
SMOOTH = 4  # the edge is drawn large and scaled down so it stays smooth

source = Image.open('assets/img/mgdx-logo.png').convert('RGB')

# The seal's edge is where the image stops being white.
ink = ImageChops.difference(source, Image.new('RGB', source.size, (255, 255, 255))).convert('L').point(lambda v: 255 if v > 90 else 0)
left, top, right, bottom = ink.getbbox()
cx, cy = (left + right) / 2, (top + bottom) / 2
radius = max(right - left, bottom - top) / 2

reach = round(radius * (1 + OUTLINE + GLOW))
box = tuple(round(v) for v in (cx - reach, cy - reach)) + tuple(round(v) + reach * 2 for v in (cx - reach, cy - reach))
seal = source.crop(box)
size = seal.width * SMOOTH

# Alpha: solid out to the outline, then fading to nothing at the crop's edge.
solid = radius * (1 + OUTLINE) * SMOOTH * seal.width / (2 * reach)
mid = size / 2
mask = Image.new('L', (size, size), 0)
ImageDraw.Draw(mask).ellipse((mid - solid, mid - solid, mid + solid, mid + solid), fill=255)
blur = radius * GLOW * SMOOTH * seal.width / (2 * reach) / 2
mask = mask.filter(ImageFilter.GaussianBlur(blur)).resize(seal.size, Image.LANCZOS)

seal.putalpha(mask)
seal.save('assets/img/mgdx-seal.png', optimize=True)
print('built', seal.size, 'center', (cx, cy), 'radius', radius)
