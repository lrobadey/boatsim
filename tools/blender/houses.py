"""Aegean houses a, b, c: house_a.glb, house_b.glb, house_c.glb.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/houses.py
Origin at footprint centre, ground at y=0, footing down to y=-1.5. Forward is -z (door side).
Walls are solid masonry boxes whose faces are rebuilt around openings (exact reveals, no booleans),
with a deterministic low-amplitude warp on the outer faces so the rubble walls are not planar.
Each house file holds the body as one object named after the house and the glowing window panes
as a second object `house_x_windows` (slot `fire`).
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kit import (MB, box, lathe, chamfer_box_obj, join, export_glb, preview, reset_scene, finish, frame_for,
                 to_b, _sub, _norm, _dot, _cross)

# face key -> (outward normal, point(u, v, d) on that face, rect axes)
FACE_N = {
    '+x': (1, 0, 0), '-x': (-1, 0, 0), '+z': (0, 0, 1), '-z': (0, 0, -1), '+y': (0, 1, 0), '-y': (0, -1, 0),
}


def _face_fns(lo, hi):
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    # u, v are the in-face axes: x&z for top/bottom, z&y for x-faces, x&y for z-faces
    return {
        '+x': lambda u, v, d: (x1 + d, v, u),
        '-x': lambda u, v, d: (x0 - d, v, u),
        '+z': lambda u, v, d: (u, v, z1 + d),
        '-z': lambda u, v, d: (u, v, z0 - d),
        '+y': lambda u, v, d: (u, y1 + d, v),
        '-y': lambda u, v, d: (u, y0 - d, v),
    }


def _rect(lo, hi, face):
    x0, y0, z0 = lo
    x1, y1, z1 = hi
    if face in ('+x', '-x'):
        return (z0, z1, y0, y1)
    if face in ('+z', '-z'):
        return (x0, x1, y0, y1)
    return (x0, x1, z0, z1)


def _warp(u, v, rect, amp):
    """Smooth rubble-like undulation, zero on the box edges so neighbouring faces stay welded."""
    u0, u1, v0, v1 = rect
    edge = min(u - u0, u1 - u, v - v0, v1 - v)
    w = max(0.0, min(1.0, edge / 0.35))
    w = w * w * (3 - 2 * w)
    g = (math.sin(u * 2.3 + v * 1.1) * 0.55 + math.sin(u * 5.7 - v * 4.3 + 1.7) * 0.3
         + math.sin(v * 9.1 + u * 0.7) * 0.15)
    return amp * w * g


def wall_box(mb, lo, hi, mat, openings=(), step=0.8, amp=0.04):
    """Solid box with rectangular recesses. openings = [(face, ua, ub, va, vb, depth, kind)],
    kind 'pane' adds a glowing pane (returned for the windows object), 'door' adds a leaf."""
    fns = _face_fns(lo, hi)
    panes = []
    for face in ('+x', '-x', '+z', '-z', '+y', '-y'):
        N = FACE_N[face]
        P = fns[face]
        rect = _rect(lo, hi, face)
        holes = [o for o in openings if o[0] == face]
        ua0, ua1, va0, va1 = rect
        us = _breaks(ua0, ua1, step, [h[1] for h in holes] + [h[2] for h in holes])
        vs = _breaks(va0, va1, step, [h[3] for h in holes] + [h[4] for h in holes])

        def inside(cu, cv):
            for h in holes:
                if h[1] <= cu <= h[2] and h[3] <= cv <= h[4]:
                    return True
            return False

        for i in range(len(us) - 1):
            for j in range(len(vs) - 1):
                u0, u1, v0, v1 = us[i], us[i + 1], vs[j], vs[j + 1]
                if inside((u0 + u1) / 2, (v0 + v1) / 2):
                    continue
                pts = []
                for (u, v) in ((u0, v0), (u1, v0), (u1, v1), (u0, v1)):
                    d = _warp(u, v, rect, amp)
                    pts.append(_offset(P(u, v, 0.0), N, d))
                mb.poly(pts, mat, N)
        for h in holes:
            _recess(mb, P, N, rect, h, mat, amp, panes)
    return panes


def _offset(p, N, d):
    return (p[0] + N[0] * d, p[1] + N[1] * d, p[2] + N[2] * d)


def _breaks(a, b, step, extra):
    n = max(1, int(math.ceil((b - a) / step)))
    vals = {a + (b - a) * i / n for i in range(n + 1)}
    for e in extra:
        if a < e < b:
            vals.add(e)
    vals = sorted(vals)
    # drop breaks that would make slivers next to hole edges
    out = [vals[0]]
    for v in vals[1:]:
        if v - out[-1] > 0.12 or v == b:
            out.append(v)
    if out[-1] != b:
        out[-1] = b
    return out


def _recess(mb, P, N, rect, h, mat, amp, panes):
    """Opening cut `depth` into the wall: four reveal faces (facing into the hole) and a back."""
    face, ua, ub, va, vb, depth, kind = h

    def Pin(u, v, d):  # d measured into the wall
        return P(u, v, -d)

    # reveals: walls of the recess, from the warped face edge straight into the wall
    target = Pin((ua + ub) / 2, (va + vb) / 2, depth / 2)
    for pts in (
        [Pin(ua, va, 0), Pin(ub, va, 0), Pin(ub, va, depth), Pin(ua, va, depth)],
        [Pin(ua, vb, 0), Pin(ub, vb, 0), Pin(ub, vb, depth), Pin(ua, vb, depth)],
        [Pin(ua, va, 0), Pin(ua, vb, 0), Pin(ua, vb, depth), Pin(ua, va, depth)],
        [Pin(ub, va, 0), Pin(ub, vb, 0), Pin(ub, vb, depth), Pin(ub, va, depth)],
    ):
        cen = tuple(sum(p[k] for p in pts) / 4 for k in range(3))
        mb.poly(pts, mat, _sub(target, cen))
    back = [Pin(ua, va, depth), Pin(ub, va, depth), Pin(ub, vb, depth), Pin(ua, vb, depth)]
    if kind == 'door':
        leaf_d = depth * 0.45
        leaf = [Pin(ua + 0.05, va + 0.02, leaf_d), Pin(ub - 0.05, va + 0.02, leaf_d),
                Pin(ub - 0.05, vb - 0.02, leaf_d), Pin(ua + 0.05, vb - 0.02, leaf_d)]
        mb.poly(leaf, 'wood_dark', N)
    elif kind == 'pane':
        panes.append((face, ua, ub, va, vb, depth))
    mb.poly(back, mat, N)


def face_box(mb, face, lo, hi, ua, ub, va, vb, d0, d1, mat):
    """Axis-aligned block hugging a face: in-face rect (ua..ub, va..vb), outward offset d0..d1."""
    P = _face_fns(lo, hi)[face]
    pts = [P(u, v, d) for u in (ua, ub) for v in (va, vb) for d in (d0, d1)]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    zs = [p[2] for p in pts]
    box(mb, min(xs), max(xs), min(ys), max(ys), min(zs), max(zs), mat)


def pane_quads(mb, lo, hi, panes):
    """Glowing pane inside each recess, set back from the opening."""
    fns = _face_fns(lo, hi)
    for face, ua, ub, va, vb, depth in panes:
        N = FACE_N[face]
        P = fns[face]
        rect = _rect(lo, hi, face)
        d = -depth * 0.55  # into the recess
        pts = [P(ua + 0.07, va + 0.07, d), P(ub - 0.07, va + 0.07, d), P(ub - 0.07, vb - 0.07, d),
               P(ua + 0.07, vb - 0.07, d)]
        mb.poly(pts, 'fire', N)


def gable_prism(mb, poly_xy, z0, z1, mat):
    """Extrude a convex xy polygon between z0 and z1."""
    n = len(poly_xy)
    front = [(x, y, z1) for x, y in poly_xy]
    back = [(x, y, z0) for x, y in poly_xy]
    mb.poly(front, mat, (0, 0, 1))
    mb.poly(back, mat, (0, 0, -1))
    for i in range(n):
        a, b = poly_xy[i], poly_xy[(i + 1) % n]
        mb.poly([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat,
                (b[1] - a[1], -(b[0] - a[0]), 0))


def roof_tiles(mb, E, R, zmin, zmax, rows_len=0.13, bump=0.035):
    """Low-pitch tile roof slope: rows of bumps running along z, from eave E to ridge R."""
    d = _sub(R, E)
    L = math.sqrt(_dot(d, d))
    s = (d[0] / L, d[1] / L, 0.0)
    n = (s[1], -s[0], 0.0)
    if n[1] < 0:
        n = (-n[0], -n[1], 0.0)
    rows = max(1, round(L / rows_len))
    rl = L / rows
    prof = []
    for r in range(rows):
        for k in range(4):
            f = k / 4.0
            u = (r + f) * rl
            h = bump * math.sin(math.pi * f) ** 0.7
            prof.append((u, h))
    prof.append((L, 0.0))
    ring = lambda u, h, z: (E[0] + s[0] * u + n[0] * h, E[1] + s[1] * u + n[1] * h, z)
    for i in range(len(prof) - 1):
        (u0, h0), (u1, h1) = prof[i], prof[i + 1]
        q = [ring(u0, h0, zmin), ring(u1, h1, zmin), ring(u1, h1, zmax), ring(u0, h0, zmax)]
        mb.poly(q, 'roof_tile', n)


def _shutter_pair(mb, lo, hi, face, ua, ub, va, vb):
    face_box(mb, face, lo, hi, ua - 0.24, ua, va, vb, 0.0, 0.05, 'wood_dark')
    face_box(mb, face, lo, hi, ub, ub + 0.24, va, vb, 0.0, 0.05, 'wood_dark')


def house_a():
    """5 x 6 m flat-roofed house with a parapet and a roof terrace (stair hut)."""
    lo, hi = (-2.5, 0.0, -3.0), (2.5, 3.6, 3.0)
    openings = [
        ('-z', -0.5, 0.5, 0.3, 2.5, 0.35, 'door'),
        ('-z', -1.9, -1.2, 1.9, 2.7, 0.3, 'pane'),
        ('+x', -1.0, -0.4, 1.9, 2.7, 0.3, 'pane'),
        ('-x', 0.5, 1.1, 1.9, 2.7, 0.3, 'pane'),
        ('+z', 0.8, 1.4, 1.9, 2.7, 0.3, 'pane'),
    ]
    mb = MB()
    panes = []
    footing = (2.6, 3.1)
    fx, fz = footing
    box(mb, -fx, fx, -1.5, 0.3, -fz, fz, 'stone')
    panes = wall_box(mb, lo, hi, 'plaster', openings)
    for face, ua, ub, va, vb, dep, kind in openings:
        if kind == 'pane':
            _shutter_pair(mb, lo, hi, face, ua, ub, va, vb)
        if kind == 'door':
            face_box(mb, face, lo, hi, ua - 0.1, ub + 0.1, vb, vb + 0.18, 0.0, 0.06, 'wood_dark')
    # parapet around the terrace
    t = 0.25
    H = 3.6
    box(mb, -2.5, 2.5, H, H + 0.5, -3.0, -3.0 + t, 'plaster')
    box(mb, -2.5, 2.5, H, H + 0.5, 3.0 - t, 3.0, 'plaster')
    box(mb, -2.5, -2.5 + t, H, H + 0.5, -3.0, 3.0, 'plaster')
    box(mb, 2.5 - t, 2.5, H, H + 0.5, -3.0, 3.0, 'plaster')
    # stair hut in the back corner; its door sits on the -z face, in world x/y
    wall_box(mb, (0.2, H, 0.4), (1.9, H + 2.0, 1.8), 'plaster', [
        ('-z', 0.7, 1.4, H, H + 1.5, 0.25, 'door')
    ])
    return mb, panes


def house_b():
    """6 x 8 m house under a low-pitch tile roof, gable ends to the ±z faces."""
    lo, hi = (-3.0, 0.0, -4.0), (3.0, 3.0, 4.0)
    openings = [
        ('-z', -0.5, 0.5, 0.3, 2.4, 0.35, 'door'),
        ('+x', -2.6, -1.7, 1.2, 2.1, 0.3, 'pane'),
        ('+x', 1.7, 2.6, 1.2, 2.1, 0.3, 'pane'),
        ('-x', -2.6, -1.7, 1.2, 2.1, 0.3, 'pane'),
        ('-x', 1.7, 2.6, 1.2, 2.1, 0.3, 'pane'),
        ('+z', -0.6, 0.6, 1.2, 2.1, 0.3, 'pane'),
    ]
    mb = MB()
    box(mb, -3.1, 3.1, -1.5, 0.3, -4.1, 4.1, 'stone')
    panes = wall_box(mb, lo, hi, 'plaster', openings)
    for face, ua, ub, va, vb, dep, kind in openings:
        if kind == 'pane':
            _shutter_pair(mb, lo, hi, face, ua, ub, va, vb)
        if kind == 'door':
            face_box(mb, face, lo, hi, ua - 0.1, ub + 0.1, vb, vb + 0.18, 0.0, 0.06, 'wood_dark')
    # gable ends (proud of the walls so their faces never coincide with the wall faces)
    tri = [(-3.0, 3.0), (3.0, 3.0), (3.0, 3.12), (0.0, 4.33), (-3.0, 3.12)]
    gable_prism(mb, tri, -4.02, -3.85, 'plaster')
    gable_prism(mb, tri, 3.85, 4.02, 'plaster')
    E_r, R_r = (3.3, 3.0), (0.0, 4.33)
    E_l = (-3.3, 3.0)
    roof_tiles(mb, (E_r[0], E_r[1], 0.0), (R_r[0], R_r[1], 0.0), -4.3, 4.3)
    roof_tiles(mb, (E_l[0], E_l[1], 0.0), (R_r[0], R_r[1], 0.0), -4.3, 4.3)
    box(mb, -0.15, 0.15, 4.3, 4.45, -4.3, 4.3, 'roof_tile')
    return mb, panes


def house_c():
    """4 x 4 m two-storey tower house with an L-shaped exterior stair to the first-floor door."""
    lo, hi = (-2.0, 0.0, -2.0), (2.0, 6.4, 2.0)
    openings = [
        ('-z', 1.2, 1.9, 0.3, 2.5, 0.35, 'door'),
        ('-z', 0.1, 1.0, 3.2, 4.8, 0.35, 'door'),
        ('+x', -1.2, -0.4, 1.4, 2.3, 0.3, 'pane'),
        ('+x', -1.2, -0.4, 3.9, 4.8, 0.3, 'pane'),
        ('-x', 0.4, 1.2, 1.4, 2.3, 0.3, 'pane'),
        ('-x', 0.4, 1.2, 3.9, 4.8, 0.3, 'pane'),
        ('+z', -0.8, 0.2, 3.9, 4.8, 0.3, 'pane'),
    ]
    mb = MB()
    box(mb, -2.1, 2.1, -1.5, 0.3, -2.1, 2.1, 'stone')
    panes = wall_box(mb, lo, hi, 'plaster', openings)
    for face, ua, ub, va, vb, dep, kind in openings:
        if kind == 'pane':
            _shutter_pair(mb, lo, hi, face, ua, ub, va, vb)
        if kind == 'door':
            face_box(mb, face, lo, hi, ua - 0.1, ub + 0.1, vb, vb + 0.18, 0.0, 0.06, 'wood_dark')
    # parapet roof
    t = 0.25
    H = 6.4
    box(mb, -2.0, 2.0, H, H + 0.5, -2.0, -2.0 + t, 'plaster')
    box(mb, -2.0, 2.0, H, H + 0.5, 2.0 - t, 2.0, 'plaster')
    box(mb, -2.0, -2.0 + t, H, H + 0.5, -2.0, 2.0, 'plaster')
    box(mb, 2.0 - t, 2.0, H, H + 0.5, -2.0, 2.0, 'plaster')
    # exterior stair: flight A out from the wall, landing, flight B back to the first-floor door
    for k in range(8):
        y = 0.2 * (k + 1)
        z0 = -2.0 - 0.26 * (k + 1)
        z1 = -2.0 - 0.26 * k
        box(mb, -1.0, -0.1, 0.0, y, z0, z1, 'stone')
    box(mb, -1.0, 1.0, 0.0, 1.6, -4.6, -4.0, 'stone')
    for k in range(8):
        y = 1.6 + 0.2 * (k + 1)
        z0 = -4.0 + 0.26 * k
        z1 = -4.0 + 0.26 * (k + 1)
        box(mb, 0.1, 1.0, 0.0, y, z0, z1, 'stone')
    return mb, panes


def build(name, fn):
    reset_scene()
    mb, panes = fn()
    body = mb.build(name)
    wm = MB()
    pane_quads(wm, *_lohi(name), panes)
    win = wm.build(name + '_windows')
    finish(body)
    finish(win)
    return body, win


def _lohi(name):
    if name == 'house_a':
        return (-2.5, 0.0, -3.0), (2.5, 3.6, 3.0)
    if name == 'house_b':
        return (-3.0, 0.0, -4.0), (3.0, 3.0, 4.0)
    return (-2.0, 0.0, -2.0), (2.0, 6.4, 2.0)


def main():
    for name, fn in (('house_a', house_a), ('house_b', house_b), ('house_c', house_c)):
        body, win = build(name, fn)
        export_glb([body, win], name + '.glb')
        preview(name, [body, win])


if __name__ == '__main__':
    main()
