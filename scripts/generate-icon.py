#!/usr/bin/env python3
# Generates the app icon (assets/icon.icns + assets/icon.ico) from scratch.
# Created: 2026-07-02 v1.0 — dark zinc rounded square, 4x4 MIDI pad grid
# with lit pads. Run: python3 scripts/generate-icon.py  (needs Pillow +
# macOS iconutil for the .icns step).
import os
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
os.makedirs(ASSETS, exist_ok=True)

S = 1024
# macOS icon grid: art occupies ~82% of the canvas with transparent margin.
MARGIN = 100
RADIUS = 185


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def rounded_rect_mask(size, box, radius):
    mask = Image.new('L', size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle(box, radius=radius, fill=255)
    return mask


def build_master():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Background: vertical zinc gradient inside the rounded square.
    bg = Image.new('RGBA', (S, S))
    top, bottom = (42, 42, 48, 255), (20, 20, 24, 255)
    px = bg.load()
    for y in range(S):
        row = lerp(top, bottom, y / (S - 1))
        for x in range(S):
            px[x, y] = row
    mask = rounded_rect_mask((S, S), [MARGIN, MARGIN, S - MARGIN, S - MARGIN], RADIUS)
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # Subtle top edge highlight + outer border.
    d.rounded_rectangle([MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS,
                        outline=(82, 82, 91, 200), width=6)

    # 4x4 pad grid. Lit pads get a soft glow (drawn as layered rounded rects).
    GRID = 4
    inner_pad = 88          # inset from the rounded-square edge to the grid
    gap = 34
    x0 = MARGIN + inner_pad
    y0 = MARGIN + inner_pad
    span = (S - 2 * (MARGIN + inner_pad) - (GRID - 1) * gap) / GRID
    pad_r = 46

    CYAN = (34, 211, 238)
    VIOLET = (167, 139, 250)
    GREEN = (74, 222, 128)
    lit = {(0, 2): CYAN, (1, 0): VIOLET, (2, 3): GREEN, (3, 1): CYAN}

    for row in range(GRID):
        for col in range(GRID):
            x = x0 + col * (span + gap)
            y = y0 + row * (span + gap)
            box = [x, y, x + span, y + span]
            color = lit.get((row, col))
            if color:
                # Glow halo.
                for grow, alpha in ((26, 40), (14, 80)):
                    gbox = [box[0] - grow, box[1] - grow, box[2] + grow, box[3] + grow]
                    overlay = Image.new('RGBA', (S, S), (0, 0, 0, 0))
                    od = ImageDraw.Draw(overlay)
                    od.rounded_rectangle(gbox, radius=pad_r + grow, fill=color + (alpha,))
                    img = Image.alpha_composite(img, overlay)
                d = ImageDraw.Draw(img)
                d.rounded_rectangle(box, radius=pad_r, fill=color + (255,))
                # Inner top highlight for a lit-from-within feel.
                hl = [box[0] + 14, box[1] + 12, box[2] - 14, box[1] + span * 0.45]
                d.rounded_rectangle(hl, radius=pad_r - 14, fill=lerp(color, (255, 255, 255), 0.35) + (90,))
            else:
                d.rounded_rectangle(box, radius=pad_r, fill=(63, 63, 70, 255),
                                    outline=(82, 82, 91, 255), width=3)

    # Clip everything back to the rounded square so glows don't bleed outside.
    clipped = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    clipped.paste(img, (0, 0), mask)
    return clipped


master = build_master()
master_png = os.path.join(ASSETS, 'icon.png')
master.save(master_png)
print(f'wrote {master_png}')

# .icns via iconutil
with tempfile.TemporaryDirectory() as tmp:
    iconset = os.path.join(tmp, 'icon.iconset')
    os.makedirs(iconset)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px_size = size * scale
            name = f'icon_{size}x{size}' + ('@2x' if scale == 2 else '') + '.png'
            master.resize((px_size, px_size), Image.LANCZOS).save(os.path.join(iconset, name))
    subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', os.path.join(ASSETS, 'icon.icns')], check=True)
print(f'wrote {os.path.join(ASSETS, "icon.icns")}')

# .ico for Windows (multi-size)
ico_path = os.path.join(ASSETS, 'icon.ico')
master.resize((256, 256), Image.LANCZOS).save(
    ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(f'wrote {ico_path}')
