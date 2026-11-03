"""Draw the golden plunger shown by a former ultimate loser's name, in the golden goat's flat gold.

Reads the gold from assets/img/champs/grand-champion.png and writes assets/img/champs/ultimate-loser.png.
Requires Pillow. Run from the site root:

    python tools/build-plunger.py
"""
from collections import Counter

from PIL import Image, ImageDraw, ImageFilter

SIZE = 96  # same as the goat
SMOOTH = 4  # drawn large and scaled down so the edges stay smooth
CONTOUR = 3  # black line around the handle and bulb, in pixels of the finished image

goat = Image.open('assets/img/champs/grand-champion.png').convert('RGBA')
pixels = goat.load()
gold = Counter(pixels[x, y][:3] for x in range(goat.width) for y in range(goat.height) if pixels[x, y][3] == 255).most_common(1)[0][0]

s = SIZE * SMOOTH
u = s / 96
cx = s / 2
art = Image.new('RGBA', (s, s), gold + (0,))



def outlined(shape):
    """Black first, then the gold shrunk inside it, so an even contour line is left around the edge."""
    art.paste((0, 0, 0, 255), mask=shape)
    art.paste(gold + (255,), mask=shape.filter(ImageFilter.MinFilter(2 * CONTOUR * SMOOTH + 1)))


# handle with a rounded grip end, running down behind the bulb
handle = Image.new('L', (s, s), 0)
ImageDraw.Draw(handle).rounded_rectangle((cx - 8 * u, 1 * u, cx + 8 * u, 60 * u), radius=8 * u, fill=255)
outlined(handle)

# the rubber bulb: a dome flaring out to a wide rim
bulb = Image.new('L', (s, s), 0)
draw = ImageDraw.Draw(bulb)
draw.pieslice((cx - 30 * u, 44 * u, cx + 30 * u, 124 * u), 180, 360, fill=255)
draw.rounded_rectangle((cx - 36 * u, 80 * u, cx + 36 * u, 95 * u), radius=7 * u, fill=255)
outlined(bulb)

# fit the drawing to the image like the goat
art = art.crop(art.getbbox())
scale = SIZE / max(art.size)
art = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)

out = Image.new('RGBA', (SIZE, SIZE), gold + (0,))
out.paste(art, ((SIZE - art.width) // 2, (SIZE - art.height) // 2))
out.save('assets/img/champs/ultimate-loser.png', optimize=True)
print('gold', gold, 'goat size', goat.size)
