"""Build the faint ink art beside the page on wide desktop screens.

Draws small football and lab icons in a worn, one-color ink style and scatters them over two tall
transparent panels: assets/img/side-art-left.webp and side-art-right.webp. Also builds
assets/img/side-speckle.webp, a tile of colored specks that covers the whole background. Requires
Pillow. Run from the site root:

    python tools/build-side-art.py
"""
import math
import random

from PIL import Image, ImageDraw, ImageFilter

IMG = 'assets/img/'
COLORS = [(63, 140, 240), (236, 106, 79), (102, 184, 90), (246, 189, 47)]
PANEL_W, PANEL_H = 640, 1500
SCALE = 2  # panels are stored at double size so they stay sharp on high-density screens
COLUMN, ROW = 122, 125  # spacing of the scatter; ROW divides PANEL_H so the panels repeat evenly
ZOOM = 4  # icons are drawn large and scaled down for smooth edges
TILE = 900  # size of the repeating speck tile; large enough that the repeat doesn't show


class Pen:
    """Draws in a 140-wide icon space. White paints ink, black cuts it back out."""

    def __init__(self, draw):
        self.d = draw

    @staticmethod
    def _pts(points):
        return [(x * ZOOM, y * ZOOM) for x, y in points]

    def line(self, points, width=4, ink=255):
        self.d.line(self._pts(points), fill=ink, width=width * ZOOM, joint='curve')

    def shape(self, points, ink=255):
        self.d.polygon(self._pts(points), fill=ink)

    def outline(self, points, width=4):
        self.line(list(points) + [points[0], points[1]], width)

    def dot(self, x, y, r, ink=255):
        self.d.ellipse(((x - r) * ZOOM, (y - r) * ZOOM, (x + r) * ZOOM, (y + r) * ZOOM), fill=ink)

    def ring(self, x, y, r, width=4):
        self.d.ellipse(((x - r) * ZOOM, (y - r) * ZOOM, (x + r) * ZOOM, (y + r) * ZOOM), outline=255, width=width * ZOOM)

    def oval(self, box, width=None):
        box = [v * ZOOM for v in box]
        if width:
            self.d.ellipse(box, outline=255, width=width * ZOOM)
        else:
            self.d.ellipse(box, fill=255)

    def arc(self, box, start, end, width=4):
        self.d.arc([v * ZOOM for v in box], start, end, fill=255, width=width * ZOOM)

    def box(self, box, radius=0, ink=255, width=None):
        box = [v * ZOOM for v in box]
        if width:
            self.d.rounded_rectangle(box, radius * ZOOM, outline=255, width=width * ZOOM)
        else:
            self.d.rounded_rectangle(box, radius * ZOOM, fill=ink)


# ----- Football -----
def football(p):
    p.oval((8, 28, 132, 92))
    p.line([(46, 60), (94, 60)], 3, 0)
    for x in range(52, 94, 10):
        p.line([(x, 52), (x, 68)], 3, 0)
    p.line([(32, 36), (24, 84)], 3, 0)
    p.line([(108, 36), (116, 84)], 3, 0)


def goal_post(p):
    p.line([(28, 8), (28, 66), (112, 66), (112, 8)], 6)
    p.line([(70, 66), (70, 124)], 8)
    p.line([(46, 128), (94, 128)], 6)


def play(p):
    for x, y in [(24, 108), (68, 116), (112, 108)]:
        p.ring(x, y, 11, 4)
    for x, y in [(30, 22), (90, 18), (128, 56)]:
        p.line([(x - 10, y - 10), (x + 10, y + 10)], 5)
        p.line([(x + 10, y - 10), (x - 10, y + 10)], 5)
    p.line([(24, 92), (24, 62), (58, 42)], 4)
    p.line([(48, 40), (60, 40), (56, 52)], 4)
    p.line([(112, 92), (116, 76), (100, 64)], 4)
    p.line([(112, 62), (98, 62), (102, 76)], 4)


def trophy(p):
    p.shape([(38, 12), (102, 12), (98, 58), (84, 76), (56, 76), (42, 58)])
    p.arc((14, 16, 52, 58), 90, 280, 5)
    p.arc((88, 16, 126, 58), 260, 90, 5)
    p.box((62, 76, 78, 104))
    p.box((42, 104, 98, 116), 2)
    p.box((32, 116, 108, 128), 2)


def clipboard(p):
    p.box((24, 16, 116, 134), 8, width=6)
    p.box((50, 6, 90, 26), 4)
    for x, y in [(50, 54), (88, 54)]:
        p.line([(x - 8, y - 8), (x + 8, y + 8)], 4)
        p.line([(x + 8, y - 8), (x - 8, y + 8)], 4)
    p.ring(50, 104, 9, 4)
    p.ring(88, 104, 9, 4)
    p.line([(50, 92), (50, 72)], 3)


# ----- Lab -----
def microscope(p):
    p.box((22, 118, 112, 134), 4)
    p.arc((26, 30, 112, 124), 285, 85, 10)
    p.line([(52, 12), (80, 74)], 16)
    p.line([(42, 8), (58, 2)], 7)
    p.line([(80, 74), (86, 88)], 7)
    p.box((50, 92, 110, 98))


def test_tubes(p):
    for x, level in [(18, 44), (50, 28), (82, 56), (114, 38)]:
        p.line([(x, 10), (x, 92)], 3)
        p.line([(x + 16, 10), (x + 16, 92)], 3)
        p.d.pieslice((x * ZOOM, 82 * ZOOM, (x + 16) * ZOOM, 102 * ZOOM), 0, 180, fill=255)
        p.box((x, level, x + 16, 92))
        p.line([(x - 3, 10), (x + 19, 10)], 4)
    p.box((8, 70, 138, 78), ink=255)
    p.line([(14, 78), (14, 122)], 6)
    p.line([(132, 78), (132, 122)], 6)
    p.line([(4, 122), (140, 122)], 6)


def flask(p):
    p.line([(46, 8), (94, 8)], 6)
    p.outline([(56, 10), (84, 10), (84, 50), (124, 124), (16, 124), (56, 50)], 6)
    p.shape([(42, 84), (98, 84), (118, 122), (22, 122)])
    p.dot(62, 70, 4)
    p.dot(78, 58, 3)


def dna(p):
    def strand(phase):
        return [(70 + 30 * math.sin(y / 17 + phase), y) for y in range(6, 136, 3)]

    p.line(strand(0), 6)
    p.line(strand(math.pi), 6)
    for y in range(14, 132, 13):
        x = 30 * math.sin(y / 17)
        p.line([(70 + x, y), (70 - x, y)], 3)


ICONS = [football, goal_post, play, trophy, clipboard, microscope, test_tubes, flask, dna]


def render(paint):
    """Draw one icon, then wear it with ink speckle. Returns its alpha mask, trimmed."""
    big = Image.new('L', (150 * ZOOM, 150 * ZOOM), 0)
    paint(Pen(ImageDraw.Draw(big)))
    big = big.filter(ImageFilter.GaussianBlur(1.2))
    rng = random.Random(paint.__name__)
    mask = ImageDraw.Draw(big)
    for _ in range(1500):
        x, y, r = rng.randrange(big.width), rng.randrange(big.height), rng.uniform(1, 4)
        mask.ellipse((x - r, y - r, x + r, y + r), fill=0)
    return big.crop(big.getbbox())


def build(side):
    panel = Image.new('RGBA', (PANEL_W * SCALE, PANEL_H * SCALE), (0, 0, 0, 0))
    rng = random.Random(f'mgdx-{side}')
    masks = {paint: render(paint) for paint in ICONS}
    columns, rows = PANEL_W // COLUMN, PANEL_H // ROW
    bag, grid = [], {}
    for row in range(rows):
        for col in range(columns):
            # Neighbors don't match, and every icon gets used before any repeats.
            near = [grid.get((row + dr, (col + dc) % columns)) for dr, dc in ((-1, -1), (-1, 0), (-1, 1), (0, -1))]
            if not bag:
                bag = ICONS[:]
                rng.shuffle(bag)
            paint = next((i for i in bag if i not in [n and n[0] for n in near]), bag[0])
            bag.remove(paint)
            color = rng.choice([c for c in COLORS if c not in [n and n[1] for n in (near[1], near[3])]])
            grid[(row, col)] = (paint, color)

            mask = masks[paint]
            scale = rng.uniform(.5, .62)
            size = (round(mask.width * scale * SCALE / ZOOM), round(mask.height * scale * SCALE / ZOOM))
            icon = Image.new('RGBA', size, color + (0,))
            icon.putalpha(mask.resize(size, Image.LANCZOS))
            icon = icon.rotate(rng.uniform(-16, 16), Image.BICUBIC, expand=True)
            # Staggered rows with a little drift, so it reads as scattered rather than as a grid.
            x = 22 + col * COLUMN + (COLUMN // 2 if row % 2 else 0) + rng.randrange(-10, 11)
            y = row * ROW + 12 + rng.randrange(-12, 13)
            if x + icon.width // SCALE > PANEL_W - 4:
                continue  # would be cut off at the panel's outer edge
            left = PANEL_W - x - icon.width // SCALE if side == 'left' else x
            layer = Image.new('RGBA', panel.size, (0, 0, 0, 0))
            layer.paste(icon, (left * SCALE, y * SCALE))
            panel = Image.alpha_composite(panel, layer)
    panel.save(f'{IMG}side-art-{side}.webp', quality=78, alpha_quality=70, method=6)


def build_speckle():
    """Colored specks in all four league colors. Specks crossing an edge wrap around, so the tile repeats cleanly."""
    size = TILE * SCALE * 2
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    rng = random.Random('mgdx-speckle')
    for count, low, high in [(2400, .5, 1), (500, 1, 1.6), (70, 1.6, 2.4)]:
        for _ in range(count):
            x, y = rng.randrange(size), rng.randrange(size)
            r = rng.uniform(low, high) * SCALE * 2
            fill = rng.choice(COLORS) + (rng.randrange(150, 256),)
            for ox in (-size, 0, size):
                for oy in (-size, 0, size):
                    draw.ellipse((x + ox - r, y + oy - r, x + ox + r, y + oy + r), fill=fill)
    tile = tile.resize((TILE * SCALE, TILE * SCALE), Image.LANCZOS)
    tile.save(f'{IMG}side-speckle.webp', quality=78, alpha_quality=70, method=6)


build('left')
build('right')
build_speckle()
print('built')
