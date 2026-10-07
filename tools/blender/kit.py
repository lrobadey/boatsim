"""Shared helpers for the Trieres Blender asset kit (WS-C).

Conventions
- Code is written in glTF space: +Y up, forward is -Z, units are metres. `MB` converts each
  vertex to Blender space (x, -z, y) so Blender's Z-up scene holds the same geometry; the glTF
  exporter maps it back, so the GLB coordinates equal the coordinates written in the scripts.
- Every object is built at the origin of its file (no object transforms), so a node in the GLB
  has no translation and `models.ts` can use the geometry as-is.
- Material slots are named Principled BSDF materials (see SLOTS); models.ts swaps them for game
  materials by name.
"""
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.normpath(os.path.join(HERE, '..', '..', 'public', 'assets', 'models'))
PREVIEW_DIR = os.path.join(HERE, 'previews')
TAU = 2.0 * math.pi

# slot name -> (sRGB hex, roughness, metallic). Preview colours only; the game re-materials them.
SLOTS = {
    'stone': (0xc9c1b0, 0.92, 0.0),
    'stone_dark': (0x8e8779, 0.95, 0.0),
    'wood': (0x9a6d43, 0.8, 0.0),
    'wood_dark': (0x5c3d25, 0.8, 0.0),
    'bronze': (0xb8863e, 0.35, 0.85),
    'iron': (0x4a4d52, 0.5, 0.9),
    'rope': (0xb9a27a, 0.95, 0.0),
    'clay': (0xa8603a, 0.85, 0.0),
    'plaster': (0xf2eee4, 0.92, 0.0),
    'roof_tile': (0xa4553a, 0.8, 0.0),
    'cloth': (0xe8e0cc, 0.9, 0.0),
    'cloth_red': (0x8f2a1c, 0.9, 0.0),
    'cloth_blue': (0x2a4a7a, 0.9, 0.0),
    'skin': (0xb07a5a, 0.6, 0.0),
    'hair': (0x2a1c14, 0.7, 0.0),
    'leather': (0x6a4a2a, 0.7, 0.0),
    'fire': (0xffb060, 0.6, 0.0),
}


def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def mat(name):
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    hexc, rough, metal = SLOTS[name]
    rgb = tuple(_lin(v) for v in ((hexc >> 16) & 255, (hexc >> 8) & 255, hexc & 255))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if name == 'fire':
        bsdf.inputs['Emission Color'].default_value = (1.0, 0.69, 0.38, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 1.0
    m.diffuse_color = (*rgb, 1.0)
    return m


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def rng(seed):
    return random.Random(seed)


def to_b(p):
    """glTF (y-up) point -> Blender (z-up) point."""
    return (p[0], -p[2], p[1])


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _norm(a):
    l = math.sqrt(_dot(a, a))
    return (a[0] / l, a[1] / l, a[2] / l) if l > 1e-12 else (0.0, 0.0, 0.0)


def _newell(pts):
    nx = ny = nz = 0.0
    n = len(pts)
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return (nx, ny, nz)


class MB:
    """Mesh accumulator in glTF space. Vertices are deduplicated by position, so neighbouring
    faces that share a boundary share vertices (watertight seams, no T-junction cracks)."""

    def __init__(self):
        self.verts = []
        self.index = {}
        self.faces = []
        self.mats = []

    def _v(self, p):
        b = to_b(p)
        key = (round(b[0], 6), round(b[1], 6), round(b[2], 6))
        i = self.index.get(key)
        if i is None:
            i = len(self.verts)
            self.verts.append(key)
            self.index[key] = i
        return i

    def poly(self, pts, mat_name, hint=None):
        pts = list(pts)
        if hint is not None and _dot(_newell(pts), hint) < 0:
            pts.reverse()
        ids = []
        for p in pts:
            i = self._v(p)
            if not ids or ids[-1] != i:
                ids.append(i)
        while len(ids) > 1 and ids[0] == ids[-1]:
            ids.pop()
        if len(ids) < 3:
            return
        if mat_name not in self.mats:
            self.mats.append(mat_name)
        self.faces.append((ids, self.mats.index(mat_name)))

    def build(self, name, smooth=False):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], [f for f, _ in self.faces])
        me.update()
        for m in self.mats:
            me.materials.append(mat(m))
        for poly, (_, mi) in zip(me.polygons, self.faces):
            poly.material_index = mi
            poly.use_smooth = smooth
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


# ---------------------------------------------------------------- primitives (write into MB)

def quad(mb, pts, mat_name, hint=None):
    mb.poly(pts, mat_name, hint)


def box(mb, x0, x1, y0, y1, z0, z1, mat_name):
    c = [
        ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (1, 0, 0)),
        ([(x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)], (-1, 0, 0)),
        ([(x0, y1, z0), (x0, y1, z1), (x1, y1, z1), (x1, y1, z0)], (0, 1, 0)),
        ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0)),
        ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1)),
        ([(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)], (0, 0, -1)),
    ]
    for pts, n in c:
        mb.poly(pts, mat_name, n)


def _basis(A):
    A = _norm(A)
    ref = (1.0, 0.0, 0.0) if abs(A[0]) < 0.9 else (0.0, 0.0, 1.0)
    U = _norm(_cross(ref, A))
    V = _cross(A, U)
    return A, U, V


def lathe(mb, profile, segs, mat_name, C=(0.0, 0.0, 0.0), A=(0.0, 1.0, 0.0), phase=0.0,
          cap_bottom=False, cap_top=False, radial=None, post=None):
    """Surface of revolution. profile = [(r, h), ...] along axis A from the base upwards.
    radial(theta, h) -> multiplier for shaping (e.g. flutes, folds). post(p) -> p for scaling."""
    A, U, V = _basis(A)
    rings = []
    for r, h in profile:
        ring = []
        for j in range(segs):
            th = phase + TAU * j / segs
            rr = r * (radial(th, h) if radial else 1.0)
            c, s = math.cos(th), math.sin(th)
            p = tuple(C[k] + A[k] * h + rr * (c * U[k] + s * V[k]) for k in range(3))
            ring.append(post(p) if post else p)
        rings.append(ring)
    for i in range(len(rings) - 1):
        for j in range(segs):
            q = [rings[i][j], rings[i][(j + 1) % segs], rings[i + 1][(j + 1) % segs], rings[i + 1][j]]
            cen = tuple(sum(p[k] for p in q) / 4 for k in range(3))
            axis_pt = tuple(C[k] + A[k] * _dot(_sub(cen, C), A) for k in range(3))
            mb.poly(q, mat_name, _sub(cen, axis_pt))
    if cap_bottom:
        mb.poly(list(reversed(rings[0])), mat_name, tuple(-A[k] for k in range(3)))
    if cap_top:
        mb.poly(rings[-1], mat_name, A)


def tube(mb, path, radii, segs, mat_name, caps=True):
    """Circular sweep along a polyline with per-point radius (rope, handles, spear, bow)."""
    n = len(path)
    T = []
    for i in range(n):
        if i == 0:
            t = _sub(path[1], path[0])
        elif i == n - 1:
            t = _sub(path[-1], path[-2])
        else:
            t = _sub(path[i + 1], path[i - 1])
        T.append(_norm(t))
    ref = (0.0, 0.0, 1.0) if abs(T[0][2]) < 0.9 else (1.0, 0.0, 0.0)
    N = _norm(_sub(ref, tuple(_dot(ref, T[0]) * T[0][k] for k in range(3))))
    frames = []
    for i in range(n):
        N = _norm(_sub(N, tuple(_dot(N, T[i]) * T[i][k] for k in range(3))))
        B = _cross(T[i], N)
        frames.append((N, B))
    rings = []
    for i in range(n):
        N, B = frames[i]
        ring = []
        for j in range(segs):
            a = TAU * j / segs
            ca, sa = math.cos(a), math.sin(a)
            ring.append(tuple(path[i][k] + radii[i] * (ca * N[k] + sa * B[k]) for k in range(3)))
        rings.append(ring)
    for i in range(n - 1):
        for j in range(segs):
            q = [rings[i][j], rings[i][(j + 1) % segs], rings[i + 1][(j + 1) % segs], rings[i + 1][j]]
            cen = tuple(sum(p[k] for p in q) / 4 for k in range(3))
            mb.poly(q, mat_name, _sub(cen, path[i]) if i < n - 1 else None)
    if caps:
        mb.poly(list(reversed(rings[0])), mat_name, tuple(-x for x in T[0]))
        mb.poly(rings[-1], mat_name, T[-1])


def torus(mb, C, A, R, r, segU, segV, mat_name):
    A, U, V = _basis(A)
    grid = []
    for i in range(segU):
        u = TAU * i / segU
        cu, su = math.cos(u), math.sin(u)
        row = []
        for j in range(segV):
            v = TAU * j / segV
            cv, sv = math.cos(v), math.sin(v)
            rad = R + r * cv
            row.append(tuple(C[k] + A[k] * r * sv + rad * (cu * U[k] + su * V[k]) for k in range(3)))
        grid.append(row)
    for i in range(segU):
        for j in range(segV):
            q = [grid[i][j], grid[(i + 1) % segU][j], grid[(i + 1) % segU][(j + 1) % segV], grid[i][(j + 1) % segV]]
            cen = tuple(sum(p[k] for p in q) / 4 for k in range(3))
            # outward hint: from the tube's core circle through the quad centre
            d = _sub(cen, C)
            d = _sub(d, tuple(A[k] * _dot(d, A) for k in range(3)))
            d = _norm(d)
            core = tuple(C[k] + R * d[k] for k in range(3))
            mb.poly(q, mat_name, _sub(cen, core))


def ashlar_block(mb, O, U, V, N, ua, ub, va, vb, mat_name, rnd, bev=(0.028, 0.045), proud=(0.0, 0.018)):
    """One dressed stone: flat front face, chamfered edges that meet the neighbouring blocks in
    V-joints. The boundary lies on the wall plane (depth 0) so adjacent blocks share vertices."""
    def P(u, v, d):
        return tuple(O[k] + U[k] * u + V[k] * v + N[k] * d for k in range(3))

    b = min(rnd.uniform(*bev), (ub - ua) / 4, (vb - va) / 4)
    p = rnd.uniform(*proud)
    jit = lambda: rnd.uniform(-0.006, 0.006)
    B = [P(ua, va, 0), P(ub, va, 0), P(ub, vb, 0), P(ua, vb, 0)]
    F = [P(ua + b + jit(), va + b + jit(), p), P(ub - b + jit(), va + b + jit(), p),
         P(ub - b + jit(), vb - b + jit(), p), P(ua + b + jit(), vb - b + jit(), p)]
    centre = P((ua + ub) / 2, (va + vb) / 2, 0)
    mb.poly(F, mat_name, N)
    for k in range(4):
        q = [B[k], B[(k + 1) % 4], F[(k + 1) % 4], F[k]]
        cen = tuple(sum(pp[m] for pp in q) / 4 for m in range(3))
        mb.poly(q, mat_name, _sub(cen, centre))


def frame_for(N, Vhint=(0.0, 1.0, 0.0)):
    """Basis (U, V, N) with U x V = N for a wall/slab whose outward normal is N."""
    N = _norm(N)
    V = _norm(_sub(Vhint, tuple(_dot(Vhint, N) * N[k] for k in range(3))))
    U = _cross(V, N)
    return U, V, N


def _cuts(rnd, a, b, minw, maxw, offset, forced=()):
    cuts = [a]
    u = a
    if offset:
        u = a + rnd.uniform(0.35, 0.65) * maxw
        cuts.append(u)
    while True:
        w = rnd.uniform(minw, maxw)
        if u + w > b - 0.6 * minw:
            break
        u += w
        cuts.append(u)
    cuts.append(b)
    for f in forced:
        cuts = [c for c in cuts if c in (a, b) or abs(c - f) > 0.3]
        cuts.append(f)
    return sorted(cuts)


def ashlar_rows(rnd, a, b, top, bottom, row_h, minw, maxw, forced=()):
    """Stone grid: rows (courses) from `top` down to `bottom` with staggered joints.
    Returns [(ua, ub, va, vb)] rectangles in the wall's (u, v) space."""
    n = max(1, round((top - bottom) / row_h))
    h = (top - bottom) / n
    out = []
    for r in range(n):
        vt = top - r * h
        vb = vt - h
        cuts = _cuts(rnd, a, b, minw, maxw, r % 2 == 1, forced)
        for c0, c1 in zip(cuts[:-1], cuts[1:]):
            out.append((c0, c1, vb, vt))
    return out


def chamfer_box_obj(objs_name, boxes, mat_name, width=0.03, segments=2):
    """Build boxes [(x0,x1,y0,y1,z0,z1)] as one object and bevel their edges."""
    mb = MB()
    for bx in boxes:
        box(mb, *bx, mat_name)
    ob = mb.build(objs_name)
    bevel(ob, width, segments, 35)
    return ob


# ---------------------------------------------------------------- Blender object helpers

def bevel(ob, width=0.03, segments=2, angle=35):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    thr = math.radians(angle)
    edges = []
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.link_faces[0].normal.angle(e.link_faces[1].normal) > thr:
            edges.append(e)
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=width, segments=segments, affect='EDGES',
                        clamp_overlap=True, profile=0.5)
    bm.normal_update()
    bm.to_mesh(ob.data)
    bm.free()


def recalc(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()


def smooth(ob, on=True):
    for p in ob.data.polygons:
        p.use_smooth = on


def join(objs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def apply_modifiers(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def box_uv(ob, metres_per_uv=2.0):
    """World-scale box projection: 1 UV unit = 2 m, projected along the face's dominant axis."""
    me = ob.data
    layer = me.uv_layers.get('UVMap') or me.uv_layers.new(name='UVMap')
    s = 1.0 / metres_per_uv
    for poly in me.polygons:
        n = poly.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax >= ay and ax >= az:
                u, v = co.y, co.z
            elif ay >= az:
                u, v = co.x, co.z
            else:
                u, v = co.x, co.y
            layer.data[li].uv = (u * s, v * s)


def finish(ob, uv=True):
    if uv:
        box_uv(ob)
    return ob


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


# ---------------------------------------------------------------- output

def export_glb(objs, filename):
    os.makedirs(MODELS_DIR, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    path = os.path.join(MODELS_DIR, filename)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_materials='EXPORT',
    )
    total = sum(tris(o) for o in objs)
    print(f'[kit] wrote {filename}: ' + ', '.join(f'{o.name}={tris(o)}' for o in objs) + f' (total {total} tris)')
    return path


def preview(name, objs, copies=None, res=(800, 600), front=(0.55, 0.85, 0.42)):
    """Render a 3/4 studio view of objs to previews/<name>.png. `copies` = [(obj, offset)] shows
    extra instances at an offset (preview only, never exported). Blender +Y is the model front."""
    scene = bpy.context.scene
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    extra = []
    for ob, off in (copies or []):
        c = ob.copy()
        c.location = Vector(off)
        scene.collection.objects.link(c)
        extra.append(c)
    targets = list(objs) + extra
    bpy.context.view_layer.update()  # copies need evaluated matrices before the camera is framed
    # only the targets render: hide every other mesh (e.g. the export originals at the origin)
    hidden = []
    for o in scene.objects:
        if o.type == 'MESH' and o not in targets and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    pts = []
    for o in targets:
        for corner in o.bound_box:
            pts.append(o.matrix_world @ Vector(corner))
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (mn + mx) / 2
    radius = max((mx - mn).length / 2, 0.2)
    cam_data = bpy.data.cameras.new('PreviewCam')
    cam_data.lens = 50
    cam_data.clip_start = 0.01
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new('PreviewCam', cam_data)
    scene.collection.objects.link(cam)
    half = math.atan(cam_data.sensor_width / 2 / cam_data.lens)
    dist = radius / math.sin(half) * 1.05
    d = Vector(front).normalized()
    cam.location = centre + d * dist
    direction = centre - cam.location
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'STUDIO'
    sh.color_type = 'MATERIAL'
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.cavity_ridge_factor = 1.0
    sh.background_type = 'WORLD'
    sh.background_color = (0.80, 0.82, 0.84)
    scene.render.resolution_x = res[0]
    scene.render.resolution_y = res[1]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        for o in hidden:
            o.hide_render = False
        for o in extra + [cam]:
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    print('[kit] preview', scene.render.filepath)
    return scene.render.filepath
