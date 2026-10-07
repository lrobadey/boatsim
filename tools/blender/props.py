"""Deck and quay props: dock_props.glb with one named object per prop (see next-level-spec §5).

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/props.py
Every object is built at the origin with its base on y=0 and centred on x/z, so the game can
place it by footprint (src/build/pieces.ts hx/hz/height).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import (MB, box, lathe, tube, torus, chamfer_box_obj, join, export_glb, preview, reset_scene,
                 finish, to_b, quad, TAU)


def _noise(x, y, z, s=1.0):
    """Cheap deterministic hash noise in [-1, 1] for lumps and wrinkles."""
    v = math.sin(x * 12.9898 * s + y * 78.233 + z * 37.719) * 43758.5453
    return (v - math.floor(v)) * 2.0 - 1.0


def crate():
    ob = chamfer_box_obj('crate', [(-0.39, 0.39, 0.0, 0.7, -0.39, 0.39)], 'wood', 0.02, 2)
    mb = MB()
    for y in (0.16, 0.5):
        box(mb, -0.4, 0.4, y, y + 0.09, -0.4, -0.38, 'wood_dark')
        box(mb, -0.4, 0.4, y, y + 0.09, 0.38, 0.4, 'wood_dark')
    bands = mb.build('crate_bands')
    return join([ob, bands], 'crate')


def _amphora_parts(mb, C, mat_clay='clay'):
    """One amphora at C (base on C.y). Pointed toe, tall neck, two loop handles."""
    profile = [(0.0, 0.0), (0.06, 0.1), (0.16, 0.35), (0.18, 0.5), (0.12, 0.7), (0.075, 0.78),
               (0.08, 0.84), (0.0, 0.86)]
    lathe(mb, profile, 9, mat_clay, C=C, A=(0, 1, 0))
    for s in (1, -1):
        path = [(C[0] + s * 0.07, C[1] + 0.8, C[2]), (C[0] + s * 0.13, C[1] + 0.84, C[2]),
                (C[0] + s * 0.19, C[1] + 0.78, C[2]), (C[0] + s * 0.2, C[1] + 0.66, C[2]),
                (C[0] + s * 0.17, C[1] + 0.56, C[2])]
        tube(mb, path, [0.018] * 5, 5, mat_clay, caps=True)


def amphora():
    mb = MB()
    _amphora_parts(mb, (0.0, 0.0, 0.0))
    ob = mb.build('amphora', smooth=True)
    return finish(ob)


def amphora_rack():
    mb = MB()
    # timber frame: uprights, two cradle boards, two lashing straps
    for x in (-0.72, 0.72):
        for z in (-0.36, 0.36):
            box(mb, x - 0.03, x + 0.03, 0.0, 1.0, z - 0.03, z + 0.03, 'wood_dark')
    for z in (-0.2, 0.2):
        box(mb, -0.74, 0.74, 0.0, 0.07, z - 0.07, z + 0.07, 'wood')
        box(mb, -0.74, 0.74, 0.84, 0.9, z - 0.035, z + 0.035, 'wood')
    for x in (-0.5, 0.0, 0.5):
        for z in (-0.2, 0.2):
            _amphora_parts(mb, (x, 0.07, z))
    ob = mb.build('amphora_rack', smooth=True)
    return finish(ob)


def pithos():
    mb = MB()
    profile = [(0.0, 0.0), (0.2, 0.0), (0.28, 0.1), (0.38, 0.3), (0.42, 0.6), (0.38, 0.9), (0.28, 1.1),
               (0.27, 1.16), (0.33, 1.22), (0.33, 1.3), (0.0, 1.3)]
    lathe(mb, profile, 16, 'clay', A=(0, 1, 0))
    for h, R in ((0.45, 0.415), (0.85, 0.405)):
        torus(mb, (0.0, h, 0.0), (0, 1, 0), R, 0.022, 16, 4, 'rope')
    ob = mb.build('pithos', smooth=True)
    return finish(ob)


def rope_coil():
    mb = MB()
    torus(mb, (0.0, 0.07, 0.0), (0, 1, 0), 0.25, 0.07, 16, 6, 'rope')
    ob = mb.build('rope_coil', smooth=True)
    return finish(ob)


def net_pile():
    mb = MB()
    steps = 9
    profile = []
    for i in range(steps + 1):
        t = math.pi * i / steps
        profile.append((math.sin(t), 0.17 - 0.17 * math.cos(t)))

    def post(p):
        x, y, z = p
        lump = 1.0 + 0.05 * _noise(x, y, z)
        return (x * 0.46 * lump, y, z * 0.36 * lump)

    lathe(mb, profile, 12, 'rope', post=post)
    ob = mb.build('net_pile', smooth=False)
    return finish(ob)


def basket():
    mb = MB()
    profile = [(0.0, 0.0), (0.14, 0.0), (0.2, 0.25), (0.24, 0.4), (0.235, 0.42), (0.215, 0.4),
               (0.18, 0.22), (0.12, 0.04), (0.0, 0.04)]
    lathe(mb, profile, 12, 'rope', A=(0, 1, 0))
    for h in (0.12, 0.3):
        torus(mb, (0.0, h, 0.0), (0, 1, 0), 0.205 + 0.04 * h, 0.012, 12, 3, 'wood')
    ob = mb.build('basket', smooth=True)
    return finish(ob)


def brazier():
    mb = MB()
    lathe(mb, [(0.0, 0.0), (0.2, 0.0), (0.22, 0.03), (0.15, 0.07), (0.06, 0.1), (0.04, 0.12), (0.0, 0.12)],
          10, 'bronze')
    lathe(mb, [(0.04, 0.1), (0.035, 0.6), (0.06, 0.64), (0.0, 0.64)], 10, 'bronze')
    lathe(mb, [(0.0, 0.6), (0.12, 0.62), (0.25, 0.7), (0.34, 0.84), (0.33, 0.9), (0.3, 0.9),
               (0.22, 0.8), (0.0, 0.72)], 14, 'bronze')
    lathe(mb, [(0.0, 0.74), (0.2, 0.76), (0.26, 0.78), (0.0, 0.8)], 10, 'stone_dark')
    ob = mb.build('brazier', smooth=True)
    return finish(ob)


def lamp_post():
    mb = MB()
    lathe(mb, [(0.0, 0.0), (0.13, 0.0), (0.13, 0.08), (0.1, 0.1), (0.035, 0.1), (0.035, 1.7), (0.0, 1.7)],
          10, 'wood_dark')
    lathe(mb, [(0.0, 1.66), (0.1, 1.7), (0.14, 1.74), (0.15, 1.78), (0.13, 1.8), (0.1, 1.78), (0.0, 1.74)],
          12, 'bronze')
    # flame: teardrop sitting in the bowl, the only fire-slot mesh on the lamp
    flame = []
    for i in range(7):
        t = math.pi * i / 6
        flame.append((0.045 * math.sin(t) ** 0.8, 1.76 + 0.07 * (1 - math.cos(t))))
    lathe(mb, flame, 10, 'fire', C=(0.0, 0.0, 0.0), A=(0, 1, 0))
    ob = mb.build('lamp_post', smooth=True)
    return finish(ob)


def bench():
    mb = MB()
    for x in (-0.6, 0.6):
        box(mb, x - 0.1, x + 0.1, 0.0, 0.4, -0.2, 0.2, 'stone')
    for z in (-0.13, 0.0, 0.13):
        box(mb, -0.8, 0.8, 0.4, 0.45, z - 0.06, z + 0.06, 'wood')
    ob = mb.build('bench')
    return finish(ob)


def awning():
    mb = MB()
    for x in (-1.42, 1.42):
        for z in (-1.12, 1.12):
            lathe(mb, [(0.0, 0.0), (0.045, 0.0), (0.045, 2.3), (0.0, 2.3)], 8, 'wood_dark',
                  C=(x, 0.0, z), A=(0, 1, 0))
    nx, nz = 12, 8

    def h(x, z):
        return 2.3 - 0.12 * (1 - (x / 1.5) ** 2) * (1 - (z / 1.2) ** 2)

    for i in range(nx):
        x0 = -1.5 + 3.0 * i / nx
        x1 = -1.5 + 3.0 * (i + 1) / nx
        m = 'cloth_red' if i % 4 == 1 else 'cloth'
        for j in range(nz):
            z0 = -1.2 + 2.4 * j / nz
            z1 = -1.2 + 2.4 * (j + 1) / nz
            pts = [(x0, h(x0, z0), z0), (x1, h(x1, z0), z0), (x1, h(x1, z1), z1), (x0, h(x0, z1), z1)]
            mb.poly(pts, m, (0, 1, 0))
    # hanging valance along the front edge
    for i in range(nx):
        x0 = -1.5 + 3.0 * i / nx
        x1 = -1.5 + 3.0 * (i + 1) / nx
        m = 'cloth_red' if i % 4 == 1 else 'cloth'
        mb.poly([(x0, h(x0, 1.2), 1.2), (x1, h(x1, 1.2), 1.2), (x1, 2.08, 1.2), (x0, 2.08, 1.2)], m, (0, 0, 1))
    ob = mb.build('awning', smooth=False)
    return finish(ob)


def altar():
    base = chamfer_box_obj('altar', [(-0.4, 0.4, 0.0, 0.7, -0.28, 0.28)], 'stone', 0.03, 2)
    top = chamfer_box_obj('altar_top', [(-0.45, 0.45, 0.7, 0.9, -0.33, 0.33)], 'stone', 0.03, 2)
    return join([base, top], 'altar')


def shield_rack():
    mb = MB()
    for x in (-0.66, 0.66):
        box(mb, x - 0.03, x + 0.03, 0.0, 1.4, -0.03, 0.03, 'wood_dark')
    for y in (0.18, 1.2):
        box(mb, -0.68, 0.68, y, y + 0.04, -0.03, 0.03, 'wood')
    for x in (-0.44, 0.0, 0.44):
        C = (x, 0.7, 0.0)
        lathe(mb, [(0.0, 0.035), (0.1, 0.03), (0.19, 0.012), (0.2, 0.0), (0.19, -0.02), (0.0, -0.02)],
              14, 'wood', C=C, A=(0, 0, 1))
        torus(mb, C, (0, 0, 1), 0.2, 0.018, 14, 4, 'bronze')
        lathe(mb, [(0.0, 0.035), (0.05, 0.035), (0.04, 0.05), (0.0, 0.06)], 10, 'bronze', C=C, A=(0, 0, 1))
    ob = mb.build('shield_rack', smooth=True)
    return finish(ob)


def banner():
    mb = MB()
    lathe(mb, [(0.0, 0.0), (0.025, 0.0), (0.025, 3.0), (0.0, 3.0)], 8, 'wood', A=(0, 1, 0))
    lathe(mb, [(0.0, 3.0), (0.035, 3.0), (0.0, 3.2)], 8, 'bronze', A=(0, 1, 0))
    lathe(mb, [(0.0, -0.15), (0.015, -0.15), (0.015, 0.15), (0.0, 0.15)], 6, 'wood', C=(0.0, 2.92, 0.0), A=(0, 0, 1))
    cols, rows = 8, 6

    def fl(zi, yi):
        z = -0.15 + 0.3 * zi / cols
        ytop = 2.9
        ybot = 1.5 + 0.1 * (1 - abs(z) / 0.15)
        y = ybot + (ytop - ybot) * yi / rows
        x = 0.03 + 0.03 * math.sin(z * 30.0 + y * 3.0) * (2.9 - y) / 1.4
        return (x, y, z)

    for zi in range(cols):
        for yi in range(rows):
            mb.poly([fl(zi, yi), fl(zi + 1, yi), fl(zi + 1, yi + 1), fl(zi, yi + 1)], 'cloth_red', (1, 0, 0))
    ob = mb.build('banner', smooth=False)
    return finish(ob)


BUILDERS = [crate, amphora, amphora_rack, pithos, rope_coil, net_pile, basket, brazier, lamp_post, bench,
            awning, altar, shield_rack, banner]


def main():
    reset_scene()
    objs = []
    for fn in BUILDERS:
        objs.append(fn())
    export_glb(objs, 'dock_props.glb')
    half = (len(objs) + 1) // 2
    row_a = [(o, to_b((i * 2.6 - 4.5, 0.0, -1.5))) for i, o in enumerate(objs[:half])]
    row_b = [(o, to_b((i * 2.6 - 4.5, 0.0, 2.2))) for i, o in enumerate(objs[half:])]
    preview('dock_props_a', [], copies=row_a)
    preview('dock_props_b', [], copies=row_b)


if __name__ == '__main__':
    main()
