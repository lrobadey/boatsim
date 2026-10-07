"""Human figures: figures.glb (fig_marine, fig_archer, fig_keleustes, fig_sailor_idle,
fig_dockworker_carry, fig_fisher_sit). 1.72 m, feet on y=0, facing -z.

Each body is a Skin-modifier skeleton (spine, neck, arms, legs; per-joint radii) with subdivision 1,
then decimated to budget. Head, hands, feet, hair, the chiton (cloth bell from neck to knee), belt
and accessories are separate parts joined into one object per figure with several material slots.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/figures.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from kit import (MB, box, lathe, tube, torus, join, export_glb, preview, reset_scene, finish, to_b, mat,
                 tris, apply_modifiers, smooth, TAU)

BUDGET = 2500
SKIN_RADII = {
    'pelvis': (0.135, 0.11), 'waist': (0.115, 0.095), 'chest': (0.15, 0.105), 'neck': (0.05, 0.05),
    'neckTop': (0.045, 0.045), 'shL': (0.062, 0.062), 'shR': (0.062, 0.062), 'hipL': (0.09, 0.09),
    'hipR': (0.09, 0.09), 'kneeL': (0.058, 0.058), 'kneeR': (0.058, 0.058), 'ankleL': (0.038, 0.038),
    'ankleR': (0.038, 0.038), 'elL': (0.04, 0.04), 'elR': (0.04, 0.04), 'wrL': (0.028, 0.028),
    'wrR': (0.028, 0.028), 'hdL': (0.03, 0.03), 'hdR': (0.03, 0.03),
}


def _join_skin_edges(P):
    """Build the skeleton graph. P maps joint name -> glTF point."""
    names = [k for k in P.keys()]
    idx = {k: i for i, k in enumerate(names)}
    edges = []
    chains = [
        ['pelvis', 'waist', 'chest', 'neck', 'neckTop'],
        ['pelvis', 'hipL', 'kneeL', 'ankleL'],
        ['pelvis', 'hipR', 'kneeR', 'ankleR'],
        ['chest', 'shL', 'elL', 'wrL', 'hdL'],
        ['chest', 'shR', 'elR', 'wrR', 'hdR'],
    ]
    for ch in chains:
        for a, b in zip(ch[:-1], ch[1:]):
            edges.append((idx[a], idx[b]))
    return names, edges


def skin_body(P, radii=None, name='skin_body'):
    """Blender object: skin tubes through the joints, subdivided once, in the 'skin' material."""
    radii = radii or SKIN_RADII
    names, edges = _join_skin_edges(P)
    verts = [to_b(P[n]) for n in names]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, edges, [])
    me.update()
    me.materials.append(mat('skin'))
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.mesh.customdata_skin_add()
    layer = me.skin_vertices[0]
    for i, n in enumerate(names):
        r = radii.get(n, (0.05, 0.05))
        layer.data[i].radius = r
    # roots at the pelvis keeps the skin frame stable
    layer.data[names.index('pelvis')].use_root = True
    sk = ob.modifiers.new('Skin', 'SKIN')
    sk.use_smooth_shade = True
    sb = ob.modifiers.new('Subsurf', 'SUBSURF')
    sb.levels = 1
    sb.render_levels = 1
    apply_modifiers(ob)
    return ob


def ellipsoid(mb, C, rx, ry, rz, mat_name, segs=10, rings=6, top_only=False):
    """UV ellipsoid (or its upper half) via the lathe helper."""
    if top_only:
        ts = [math.pi / 2 * (1 - i / rings) for i in range(rings + 1)]
    else:
        ts = [math.pi * (1 - i / rings) for i in range(rings + 1)]
    profile = [(math.sin(t), math.cos(t)) for t in ts]
    lathe(mb, profile, segs, mat_name, A=(0, 1, 0),
          post=lambda p: (C[0] + p[0] * rx, C[1] + p[1] * ry, C[2] + p[2] * rz))


def arm_points(P, side):
    return P['sh' + side], P['el' + side], P['wr' + side], P['hd' + side]


def chiton_profile(dy=0.0):
    """Revolved profile of the chiton: neck to shoulders, tapered waist, flaring to the knee."""
    return [(0.075, 1.44 + dy), (0.17, 1.42 + dy), (0.165, 1.3 + dy), (0.13, 1.1 + dy),
            (0.165, 0.96 + dy), (0.24, 0.66 + dy), (0.27, 0.53 + dy)]


def chiton(mb, dy=0.0):
    def fold(th, h):
        return 1.0 + 0.022 * math.sin(7 * th + h * 9.0) + 0.012 * math.sin(13 * th - h * 4.0)

    lathe(mb, chiton_profile(dy), 14, 'cloth', A=(0, 1, 0), radial=fold,
          post=lambda p: (p[0] * 1.12, p[1], p[2] * 0.86))


def head_parts(mb, C, hair_cap=True, helmet=False):
    ellipsoid(mb, C, 0.095, 0.115, 0.11, 'skin', segs=10, rings=6)
    if hair_cap:
        ellipsoid(mb, (C[0], C[1] + 0.012, C[2] + 0.012), 0.104, 0.122, 0.117, 'hair', segs=10, rings=5,
                  top_only=True)


def hand(mb, p):
    ellipsoid(mb, p, 0.034, 0.032, 0.03, 'skin', segs=6, rings=4)


def foot(mb, ankle):
    x, y, z = ankle
    ellipsoid(mb, (x, 0.035, z - 0.08), 0.045, 0.035, 0.115, 'skin', segs=6, rings=4)


def pose_std():
    """Standing neutral figure. Joints in glTF coords (x right, y up, -z forward)."""
    P = {
        'pelvis': (0, 0.94, 0), 'waist': (0, 1.08, 0), 'chest': (0, 1.30, 0), 'neck': (0, 1.44, 0),
        'neckTop': (0, 1.50, 0),
        'hipL': (0.1, 0.92, 0), 'hipR': (-0.1, 0.92, 0),
        'kneeL': (0.1, 0.48, -0.02), 'kneeR': (-0.1, 0.48, -0.02),
        'ankleL': (0.1, 0.08, 0.0), 'ankleR': (-0.1, 0.08, 0.0),
        'shL': (0.19, 1.41, 0), 'shR': (-0.19, 1.41, 0),
        'elL': (0.25, 1.16, -0.02), 'elR': (-0.25, 1.16, -0.02),
        'wrL': (0.28, 0.93, -0.04), 'wrR': (-0.28, 0.93, -0.04),
        'hdL': (0.3, 0.84, -0.06), 'hdR': (-0.3, 0.84, -0.06),
    }
    return P


def core_body(P, name):
    """Skin skeleton + head + hands + feet + chiton + belt + hair; returns the part list (objects)."""
    parts = []
    body = skin_body(P, name=name + '_skin')
    parts.append(body)
    mb = MB()
    head_parts(mb, (0, 1.60, 0.0))
    for k in ('hdL', 'hdR'):
        hand(mb, P[k])
    for k in ('ankleL', 'ankleR'):
        foot(mb, P[k])
    chiton(mb)
    torus(mb, (0, P['waist'][1] + 0.0, 0), (0, 1, 0), 0.14, 0.018, 12, 4, 'leather')
    parts.append(mb.build(name + '_parts', smooth=True))
    return parts


def finish_figure(name, parts, extra_objs=()):
    ob = join(list(parts) + list(extra_objs), name)
    total = tris(ob)
    # decimate to the budget if the subsurf body overshoots
    if total > BUDGET:
        ratio = BUDGET / total * 0.97
        dm = ob.modifiers.new('Decimate', 'DECIMATE')
        dm.decimate_type = 'COLLAPSE'
        dm.ratio = ratio
        apply_modifiers(ob)
    finish(ob)
    print(f'[figures] {name}: {tris(ob)} tris, {len(ob.material_slots)} slots')
    return ob


# ----------------------------------------------------------------- figures

def fig_sailor_idle():
    P = pose_std()
    P['elL'] = (0.25, 1.14, -0.03)
    P['elR'] = (-0.25, 1.14, -0.03)
    P['wrL'] = (0.27, 0.92, -0.06)
    P['wrR'] = (-0.27, 0.92, -0.06)
    P['hdL'] = (0.28, 0.83, -0.1)
    P['hdR'] = (-0.28, 0.83, -0.1)
    parts = core_body(P, 'fig_sailor_idle')
    return finish_figure('fig_sailor_idle', parts)


def fig_marine():
    P = pose_std()
    # left arm (x>0 is the figure's left in glTF, shield side) braces the shield forward
    P['elL'] = (0.24, 1.12, -0.14)
    P['wrL'] = (0.14, 1.07, -0.3)
    P['hdL'] = (0.08, 1.05, -0.36)
    # right arm (-x) holds the spear upright
    P['elR'] = (-0.3, 1.2, -0.02)
    P['wrR'] = (-0.31, 1.25, 0.02)
    P['hdR'] = (-0.31, 1.3, 0.03)
    parts = core_body(P, 'fig_marine')
    mb = MB()
    # bronze crested helmet: hemisphere over the head, cheek guards, horsehair crest
    ellipsoid(mb, (0, 1.6, 0.0), 0.118, 0.128, 0.124, 'bronze', segs=10, rings=5, top_only=True)
    for s in (1, -1):
        box(mb, s * 0.095 - 0.02, s * 0.095 + 0.02, 1.52, 1.6, -0.09, -0.04, 'bronze')
    tube(mb, [(0, 1.70, 0.1), (0, 1.79, 0.0), (0, 1.78, -0.1), (0, 1.7, -0.13)], [0.02, 0.026, 0.026, 0.02],
         6, 'cloth_red')
    # round shield with bronze rim and a wooden face, carried in front of the left arm
    C = (0.2, 1.02, -0.36)
    lathe(mb, [(0.0, 0.035), (0.1, 0.03), (0.2, 0.01), (0.215, 0.0), (0.2, -0.02), (0.0, -0.02)], 14, 'wood',
          C=C, A=(0, 0, -1))
    torus(mb, C, (0, 0, -1), 0.215, 0.018, 14, 4, 'bronze')
    lathe(mb, [(0.0, 0.035), (0.05, 0.035), (0.04, 0.05), (0.0, 0.065)], 8, 'bronze', C=C, A=(0, 0, -1))
    # spear: wooden shaft and iron head, held upright in the right hand
    tube(mb, [(-0.33, 0.0, 0.05), (-0.31, 1.0, 0.03), (-0.31, 1.85, 0.03)], [0.016, 0.016, 0.016], 6, 'wood')
    lathe(mb, [(0.0, 0.0), (0.024, 0.0), (0.012, 0.09), (0.0, 0.12)], 6, 'iron',
          C=(-0.31, 1.85, 0.03), A=(0, 1, 0))
    parts.append(mb.build('fig_marine_acc', smooth=True))
    return finish_figure('fig_marine', parts)


def fig_archer():
    P = pose_std()
    # left arm (+x) extends forward to the bow grip
    P['elL'] = (0.22, 1.2, -0.2)
    P['wrL'] = (0.18, 1.12, -0.42)
    P['hdL'] = (0.14, 1.1, -0.46)
    # right arm (-x) draws the string back to the cheek
    P['elR'] = (-0.36, 1.32, -0.12)
    P['wrR'] = (-0.2, 1.45, -0.1)
    P['hdR'] = (-0.09, 1.5, -0.1)
    parts = core_body(P, 'fig_archer')
    mb = MB()
    # composite bow: arc in the vertical plane, bulging forward, held at the left hand
    cx, cy, cz = 0.14, 1.1, -0.42
    arc = []
    for i in range(11):
        th = -math.pi / 2 + math.pi * i / 10
        arc.append((cx, cy + 0.36 * math.sin(th), cz - 0.22 * (1 - math.cos(th))))
    tube(mb, arc, [0.014] * len(arc), 6, 'wood')
    tube(mb, [arc[0], (-0.02, 1.1, -0.12), arc[-1]], [0.006] * 3, 4, 'rope')
    parts.append(mb.build('fig_archer_acc', smooth=True))
    return finish_figure('fig_archer', parts)


def fig_keleustes():
    P = pose_std()
    P['elL'] = (0.3, 1.5, -0.02)
    P['wrL'] = (0.3, 1.7, -0.05)
    P['hdL'] = (0.28, 1.76, -0.06)
    P['elR'] = (-0.3, 1.5, -0.02)
    P['wrR'] = (-0.3, 1.7, -0.05)
    P['hdR'] = (-0.28, 1.76, -0.06)
    parts = core_body(P, 'fig_keleustes')
    return finish_figure('fig_keleustes', parts)


def fig_dockworker_carry():
    P = pose_std()
    # right arm (-x) lifts the amphora from the shoulder; left arm swings loose
    P['elR'] = (-0.3, 1.32, -0.05)
    P['wrR'] = (-0.22, 1.56, -0.04)
    P['hdR'] = (-0.2, 1.62, -0.03)
    P['elL'] = (0.26, 1.14, -0.04)
    P['wrL'] = (0.28, 0.93, -0.06)
    P['hdL'] = (0.3, 0.85, -0.08)
    parts = core_body(P, 'fig_dockworker_carry')
    mb = MB()
    # amphora on the right shoulder, tilted back against the neck
    jar = MB()
    from props import _amphora_parts  # noqa: E402  (same geometry as the dock prop)
    _amphora_parts(jar, (0.0, 0.0, 0.0))
    jo = jar.build('carry_jar', smooth=True)
    # Blender is Z-up: glTF rotation about X is Blender X, about Z is -Blender Y (tilt toward the head)
    jo.scale = (0.72, 0.72, 0.72)
    jo.rotation_euler = (math.radians(-18), math.radians(20), 0)
    jo.location = to_b((-0.25, 1.12, -0.02))
    bpy.context.view_layer.objects.active = jo
    jo.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    jo.select_set(False)
    parts.append(jo)
    return finish_figure('fig_dockworker_carry', parts)


def fig_fisher_sit():
    P = {
        'pelvis': (0, 0.47, 0.0), 'waist': (0, 0.63, 0.0), 'chest': (0, 0.8, 0.0), 'neck': (0, 0.94, 0.0),
        'neckTop': (0, 1.0, 0.0),
        'hipL': (0.1, 0.46, 0.0), 'hipR': (-0.1, 0.46, 0.0),
        'kneeL': (0.1, 0.5, -0.46), 'kneeR': (-0.1, 0.5, -0.46),
        'ankleL': (0.1, 0.08, -0.5), 'ankleR': (-0.1, 0.08, -0.5),
        'shL': (0.19, 0.9, 0.0), 'shR': (-0.19, 0.9, 0.0),
        'elL': (0.22, 0.7, -0.14), 'elR': (-0.22, 0.7, -0.14),
        'wrL': (0.15, 0.6, -0.36), 'wrR': (-0.15, 0.6, -0.36),
        'hdL': (0.12, 0.56, -0.42), 'hdR': (-0.12, 0.56, -0.42),
    }
    body = skin_body(P, name='fig_fisher_sit_skin')
    mb = MB()
    head_parts(mb, (0, 1.1, 0.02))
    for k in ('hdL', 'hdR'):
        hand(mb, P[k])
    for k in ('ankleL', 'ankleR'):
        foot(mb, P[k])
    chiton(mb, dy=-0.5)
    torus(mb, (0, 0.6, 0), (0, 1, 0), 0.14, 0.018, 12, 4, 'leather')
    parts = [body, mb.build('fig_fisher_sit_parts', smooth=True)]
    return finish_figure('fig_fisher_sit', parts)


FIGURES = [fig_marine, fig_archer, fig_keleustes, fig_sailor_idle, fig_dockworker_carry, fig_fisher_sit]


def main():
    reset_scene()
    objs = [fn() for fn in FIGURES]
    export_glb(objs, 'figures.glb')
    copies = [(o, to_b(((i - 2.5) * 1.6, 0.0, 0.0))) for i, o in enumerate(objs)]
    preview('figures', [], copies=copies, front=(0.4, 0.9, 0.25))
    for o in objs:
        preview(o.name, [o], front=(0.5, 0.9, 0.3))


if __name__ == '__main__':
    main()
