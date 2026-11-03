"""Crop the league banner art so its ground line is the bottom edge of the image, like Molecular Mice's.

Reads the untouched assets/img/*-alt.jpg files and writes the *-alt-crop.jpg files the banners use.
Requires Pillow. Run from the site root:

    python tools/build-banner-art.py
"""
from PIL import Image

# (left, top, right, bottom) of each source image, with bottom running through the ground line
CROPS = {
    'lab-rats': (86, 122, 734, 696),
    'genomic-gerbils': (48, 188, 752, 624),
    'research-rodents': (60, 88, 750, 676),
}

for slug, box in CROPS.items():
    art = Image.open(f'assets/img/{slug}-alt.jpg').convert('RGB').crop(box)
    art.save(f'assets/img/{slug}-alt-crop.jpg', quality=90)
    print(slug, art.size)
