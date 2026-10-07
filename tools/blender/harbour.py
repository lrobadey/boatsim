"""Harbour kit: quay_segment, quay_head, bollard, gangplank, anchor, fender.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/harbour.py
Coordinates are glTF (y up, forward -z). Mole sections are centred on the origin in x and z,
top at y=0, 6 m wide (x), 6 m long (z), sides down to y=-7.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import (MB, box, lathe, tube, torus, ashlar_rows, ashlar_block, frame_for, _cuts, chamfer_box_obj,
                 join, export_glb, preview, reset_scene, rng, tris, to_b, quad, smooth, finish)

WALL_X = 3.0
COPING_IN = 2.78
COPING_OUT = 3.10
GAP = 0.005  # joint gap between coping stones (keeps faces from coinciding)


def _walls(mb, rnd):
    """Dressed ashlar on both long faces, courses from just under the coping down to y=-7."""
    for side in (1, -1):
        N = (side, 0.0, 0.0)
        U, V, Nn = frame_for(N, (0.0, 1.0, 0.0))
        O = (WALL_X * side, 0.0, 0.0)
        for ua, ub, va, vb in ashlar_rows(rnd, -3.0, 3.0, -0.22, -7.0, 0.6, 1.1, 2.0):
            ashlar_block(mb, O, U, V, N, ua, ub, va, vb, 'stone', rnd)


def _bottom(mb):
    mb.poly([(-3, -7, -3), (3, -7, -3), (3, -7, 3), (-3, -7, 3)], 'stone', (0, -1, 0))


def _paving(mb, rnd, rects):
    """Top slabs, flush with y=0. Rect = (x0, x1, z0, z1) in glTF space."""
    N = (0.0, 1.0, 0.0)
    U, V, Nn = frame_for(N, (0.0, 0.0, -1.0))  # v = -z, u = x
    for x0, x1, z0, z1 in rects:
        for ua, ub, va, vb in ashlar_rows(rnd, x0, x1, -z0, -z1, 1.5, 1.1, 1.9):
            ashlar_block(mb, (0.0, 0.0, 0.0), U, V, N, ua, ub, va, vb, 'stone', rnd,
                         bev=(0.02, 0.03), proud=(0.0, 0.004))


def _fenders(mb):
    """Timber wale and fender posts on both long faces."""
    for side in (1, -1):
        # wale and posts sit half-embedded in the wall so no faces are exactly coplanar with it
        lo, hi = sorted((2.95 * side, (WALL_X + 0.14) * side))
        box(mb, lo, hi, -0.47, -0.33, -3.0, 3.0, 'wood')
        for z in (-2.25, -0.75, 0.75, 2.25):
            lathe(mb, [(0.0, 0.0), (0.085, 0.0), (0.085, 1.7), (0.0, 1.7)], 10, 'wood',
                  C=(3.06 * side, -1.9, z), A=(0, 1, 0))


def _stair_notch(mb, n=9, rise=0.311, tread=0.35, z0=-0.15, w=0.8):
    """Stair cut into the seaward end: tops fall from y=0 to -2.8 toward +z."""
    tops = [-rise * (k + 1) for k in range(n)]
    zs = [z0 + tread * k for k in range(n + 1)]
    for s in (1, -1):
        x = w * s
        for k in range(n):
            quad(mb, [(x, 0.0, zs[k]), (x, 0.0, zs[k + 1]), (x, tops[k], zs[k + 1]), (x, tops[k], zs[k])],
                 'stone', (-s, 0, 0))
    for k in range(n):
        quad(mb, [(-w, tops[k], zs[k]), (w, tops[k], zs[k]), (w, tops[k], zs[k + 1]), (-w, tops[k], zs[k + 1])],
             'stone', (0, 1, 0))
        prev = tops[k - 1] if k > 0 else 0.0
        quad(mb, [(-w, prev, zs[k]), (w, prev, zs[k]), (w, tops[k], zs[k]), (-w, tops[k], zs[k])],
             'stone', (0, 0, 1))


def _end_face(mb, rnd, z=3.0, notch=0.8):
    N = (0.0, 0.0, 1.0)
    U, V, Nn = frame_for(N, (0.0, 1.0, 0.0))  # u = x, v = y
    O = (0.0, 0.0, z)
    for a, b in ((-3.0, -notch), (notch, 3.0)):
        for ua, ub, va, vb in ashlar_rows(rnd, a, b, -0.22, -2.8, 0.645, 1.1, 2.0):
            ashlar_block(mb, O, U, V, N, ua, ub, va, vb, 'stone', rnd)
    for ua, ub, va, vb in ashlar_rows(rnd, -3.0, 3.0, -2.8, -7.0, 0.6, 1.1, 2.0):
        ashlar_block(mb, O, U, V, N, ua, ub, va, vb, 'stone', rnd)


def build_quay_segment():
    rnd = rng(11)
    mb = MB()
    _walls(mb, rnd)
    _bottom(mb)
    _paving(mb, rnd, [(-COPING_IN, COPING_IN, -3.0, 3.0)])
    _fenders(mb)
    main = mb.build('quay_segment')
    boxes = []
    for side in (1, -1):
        a, b = sorted((COPING_IN * side, COPING_OUT * side))
        cuts = _cuts(rnd, -3.0, 3.0, 1.3, 2.0, False)
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            boxes.append((a, b, -0.22, 0.0, c0 + GAP, c1 - GAP))
    cop = chamfer_box_obj('coping', boxes, 'stone', 0.03, 1)
    ob = join([main, cop], 'quay_segment')
    finish(ob)
    return ob


def build_quay_head():
    rnd = rng(23)
    mb = MB()
    _walls(mb, rnd)
    _bottom(mb)
    _end_face(mb, rnd)
    _stair_notch(mb)
    _paving(mb, rnd, [
        (-COPING_IN, COPING_IN, -3.0, -0.15),
        (-COPING_IN, -0.8, -0.15, 3.0),
        (0.8, COPING_IN, -0.15, 3.0),
    ])
    _fenders(mb)
    # bronze mooring ring on an iron-free stone eye on the seaward face
    torus(mb, (1.9, -1.2, 3.12), (0, 0, 1), 0.13, 0.022, 12, 4, 'bronze')
    box(mb, 1.84, 1.96, -1.11, -1.03, 3.0, 3.12, 'stone')
    main = mb.build('quay_head')
    boxes = []
    cuts = _cuts(rnd, -3.0, 3.1, 1.3, 2.0, False)
    for side in (1, -1):
        a, b = sorted((COPING_IN * side, COPING_OUT * side))
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            boxes.append((a, b, -0.22, 0.0, c0 + GAP, c1 - GAP))
    for side in (1, -1):
        cx = _cuts(rnd, 0.8, COPING_IN, 1.0, 1.6, False)
        for c0, c1 in zip(cx[:-1], cx[1:]):
            x0, x1 = sorted((c0 * side + GAP * side, c1 * side - GAP * side))
            boxes.append((x0, x1, -0.22, 0.0, 2.78 + GAP, 3.1 - GAP))
    cop = chamfer_box_obj('coping', boxes, 'stone', 0.03, 1)
    ob = join([main, cop], 'quay_head')
    finish(ob)
    return ob


def build_bollard():
    mb = MB()
    lathe(mb, [(0.24, 0.0), (0.25, 0.05), (0.19, 0.12), (0.19, 0.6), (0.16, 0.64), (0.3, 0.72),
               (0.27, 0.79), (0.0, 0.8)], 14, 'stone', cap_bottom=True)
    ob = mb.build('bollard', smooth=True)
    finish(ob)
    return ob


def _prism(mb, poly2d, z0, z1, mat_name):
    """Extrude a convex xy polygon between z0 and z1."""
    n = len(poly2d)
    front = [(x, y, z1) for x, y in poly2d]
    back = [(x, y, z0) for x, y in poly2d]
    mb.poly(front, mat_name, (0, 0, 1))
    mb.poly(list(reversed(back)), mat_name, (0, 0, -1))
    for i in range(n):
        a, b = poly2d[i], poly2d[(i + 1) % n]
        mb.poly([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat_name,
                (b[1] - a[1], -(b[0] - a[0]), 0))


def build_gangplank():
    mb = MB()
    box(mb, -0.35, 0.35, -0.06, 0.0, -3.0, 0.0, 'wood')
    for k in range(1, 9):
        z = -0.35 * k
        box(mb, -0.36, 0.36, 0.0, 0.025, z - 0.025, z + 0.025, 'wood_dark')
    for s in (1, -1):
        x = 0.42 * s
        lo, hi = sorted((x - 0.025, x + 0.025))
        for z in (-0.15, -2.85):
            box(mb, lo, hi, 0.0, 0.9, z - 0.025, z + 0.025, 'wood_dark')
        tube(mb, [(x, 0.85, -0.15), (x, 0.85, -2.85)], [0.014, 0.014], 5, 'rope')
    ob = mb.build('gangplank')
    finish(ob)
    return ob


def build_anchor():
    mb = MB()
    # ring hangs from the shank eye; its top sits at the origin
    torus(mb, (0.0, -0.1, 0.0), (0, 0, 1), 0.08, 0.02, 14, 5, 'iron')
    # shank runs down from the eye, slightly tapered
    lathe(mb, [(0.03, 0.0), (0.03, 0.55), (0.024, 1.0), (0.035, 1.1)], 8, 'iron',
          C=(0.0, -0.18, 0.0), A=(0, -1, 0), cap_top=True)
    # wooden stock across the shank, lead collars at its ends
    box(mb, -0.035, 0.035, -0.285, -0.215, -0.45, 0.45, 'wood')
    for z in (-0.45, 0.45):
        lathe(mb, [(0.05, -0.04), (0.05, 0.04)], 8, 'iron', C=(0.0, -0.25, z), A=(0, 0, 1),
              cap_bottom=True, cap_top=True)
    # crown and two flukes
    lathe(mb, [(0.0, 0.0), (0.05, 0.0), (0.035, 0.1), (0.0, 0.12)], 8, 'iron',
          C=(0.0, -1.1, 0.0), A=(0, -1, 0))
    for s in (1, -1):
        # inner edges sit just off the centreline so the two flukes never share a face
        fluke = [(0.012 * s, -1.18), (0.3 * s, -1.5), (0.012 * s, -1.58)]
        _prism(mb, fluke, -0.02, 0.02, 'iron')
    ob = mb.build('anchor')
    finish(ob)
    return ob


def build_fender():
    mb = MB()
    lathe(mb, [(0.0, -0.4), (0.15, -0.4), (0.15, 0.4), (0.0, 0.4)], 12, 'rope',
          C=(0.0, 0.0, 0.0), A=(0, 0, 1))
    for z in (-0.25, 0.0, 0.25):
        torus(mb, (0.0, 0.0, z), (0, 0, 1), 0.152, 0.022, 8, 4, 'rope')
    ob = mb.build('fender', smooth=True)
    finish(ob)
    return ob


def _clear():
    reset_scene()


def main():
    # quay_segment and quay_head: two previews each, seam preview shows tiling
    _clear()
    seg = build_quay_segment()
    export_glb([seg], 'quay_segment.glb')
    preview('quay_segment', [seg], copies=[(seg, to_b((0, 0, 6)))])

    _clear()
    head = build_quay_head()
    export_glb([head], 'quay_head.glb')
    preview('quay_head', [head])
    preview('quay_head_stairs', [head], front=(0.55, -0.85, 0.42))

    _clear()
    b = build_bollard()
    export_glb([b], 'bollard.glb')
    preview('bollard', [b])

    _clear()
    g = build_gangplank()
    export_glb([g], 'gangplank.glb')
    preview('gangplank', [g])

    _clear()
    a = build_anchor()
    export_glb([a], 'anchor.glb')
    preview('anchor', [a])

    _clear()
    f = build_fender()
    export_glb([f], 'fender.glb')
    preview('fender', [f])


if __name__ == '__main__':
    main()
