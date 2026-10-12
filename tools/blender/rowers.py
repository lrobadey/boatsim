"""Production merchant-crew rowers (P4): fig_rower_a / _b / _c, one shared 20-bone rig.

Writes public/assets/models/crew.glb and previews into tools/blender/previews/.

Facing and sides
- glTF: the figures face -Z, +Y is up, so +x is the figure's anatomical RIGHT (facing -Z, right = forward x up).
- Blender (kit.to_b maps glTF (x, y, z) to (x, -z, y)): the figures face +Y, +X is the figure's right.
- Bones named *_R sit at x > 0, *_L at x < 0. The side is read from the joint's x sign, not from the
  figures.py joint labels: pose_std still labels the +x joints 'L', which is the figure's right.

Run: /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender/rowers.py
"""
import json
import math
import os
import shutil
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bpy  # noqa: E402
from mathutils import Vector, Quaternion  # noqa: E402
from bpy_extras import anim_utils  # noqa: E402
import kit  # noqa: E402
import figures as F  # noqa: E402
from kit import MB, to_b, reset_scene, apply_modifiers, tris, join, torus, SLOTS, _lin  # noqa: E402

BODY_BUDGET = 1500
FPS = 24
MODEL_PATH = os.path.join(kit.MODELS_DIR, 'crew.glb')
PREVIEW_DIR = kit.PREVIEW_DIR
AX_X = Vector((1.0, 0.0, 0.0))
AX_Z = Vector((0.0, 0.0, 1.0))

# name, seed, cloth / hair colours and hair cap scale
VARIANTS = [
    ('fig_rower_a', dict(seed=11, cloth=0xe8e0cc, hair=0x2a1c14, hair_scale=1.0)),
    ('fig_rower_b', dict(seed=22, cloth=0x2a4a7a, hair=0x4a3420, hair_scale=1.0)),
    ('fig_rower_c', dict(seed=33, cloth=0x8f2a1c, hair=0x1a1410, hair_scale=1.06)),
]

BONES = ['root', 'pelvis', 'spine', 'chest', 'neck', 'head'] + [
    f'{part}_{s}' for s in ('R', 'L')
    for part in ('clavicle', 'upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot')]


def V(p):
    return Vector(to_b(p))


def hex_lin(h):
    return tuple(_lin(v) for v in ((h >> 16) & 255, (h >> 8) & 255, h & 255))


def palette(var):
    pal = {name: hex_lin(hexc) for name, (hexc, _r, _m) in SLOTS.items()}
    pal['cloth'] = hex_lin(var['cloth'])
    pal['hair'] = hex_lin(var['hair'])
    return pal


def select_only(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def side_of(P, js):
    """'R' for the joint at +x (the figure's right), 'L' for -x."""
    return 'R' if P['sh' + js][0] > 0 else 'L'


def move(new_anchor, old_anchor, old_p, t):
    """Place a joint along the same segment direction, scaled by t."""
    return tuple(na + (op - oa) * t for na, oa, op in zip(new_anchor, old_anchor, old_p))


def jitter(P, r):
    """Seeded +-4 % limb length per segment, per side. Anchors keep their place; each child moves along
    its old segment direction, so the chain stays connected and the torso is unchanged."""
    P = dict(P)

    def s():
        return 1.0 + r.uniform(-0.04, 0.04)

    for js in ('L', 'R'):
        sh, el, wr, hd = P['sh' + js], P['el' + js], P['wr' + js], P['hd' + js]
        el2 = move(sh, sh, el, s())
        wr2 = move(el2, el, wr, s())
        hd2 = move(wr2, wr, hd, s())
        hip, kn, an = P['hip' + js], P['knee' + js], P['ankle' + js]
        kn2 = move(hip, hip, kn, s())
        an2 = move(kn2, kn, an, s())
        P['el' + js], P['wr' + js], P['hd' + js] = el2, wr2, hd2
        P['knee' + js], P['ankle' + js] = kn2, an2
    return P


def build_armature(name, P):
    data = bpy.data.armatures.new(name + '_rig')
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones

    def bone(bname, head, tail, parent=None, connect=False, deform=True):
        b = eb.new(bname)
        b.head = V(head)
        b.tail = V(tail)
        b.roll = 0.0
        b.use_deform = deform
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        return b

    bone('root', (0, 0, 0), (0, 0, 0.25), deform=False)
    bone('pelvis', P['pelvis'], P['waist'], 'root')
    bone('spine', P['waist'], P['chest'], 'pelvis', connect=True)
    bone('chest', P['chest'], P['neck'], 'spine', connect=True)
    bone('neck', P['neck'], P['neckTop'], 'chest', connect=True)
    bone('head', P['neckTop'], (0, 1.74, 0), 'neck', connect=True)
    # right side first so the bone order reads root..head, R set, L set
    for js in sorted(('L', 'R'), key=lambda j: 0 if side_of(P, j) == 'R' else 1):
        s = side_of(P, js)
        sx = 1.0 if s == 'R' else -1.0
        sh, el, wr, hd = P['sh' + js], P['el' + js], P['wr' + js], P['hd' + js]
        bone('clavicle_' + s, (sx * 0.035, 1.39, 0.0), sh, 'chest')
        bone('upperarm_' + s, sh, el, 'clavicle_' + s, connect=True)
        bone('forearm_' + s, el, wr, 'upperarm_' + s, connect=True)
        tip = tuple(h + (h - w) * 0.9 for h, w in zip(hd, wr))
        bone('hand_' + s, wr, tip, 'forearm_' + s, connect=True)
        hip, kn, an = P['hip' + js], P['knee' + js], P['ankle' + js]
        bone('thigh_' + s, hip, kn, 'pelvis')
        bone('shin_' + s, kn, an, 'thigh_' + s, connect=True)
        bone('foot_' + s, an, (an[0], 0.03, an[2] - 0.19), 'shin_' + s, connect=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    assert sorted(b.name for b in data.bones) == sorted(BONES), 'bone set mismatch'
    assert len(data.bones) == 20 and all('.' not in b.name for b in data.bones)
    return arm


def ensure_groups(ob, arm):
    for b in arm.data.bones:
        if b.use_deform and b.name not in ob.vertex_groups:
            ob.vertex_groups.new(name=b.name)


def decimate(ob, budget):
    t = tris(ob)
    if t > budget:
        m = ob.modifiers.new('Decimate', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = budget / t
        apply_modifiers(ob)


def head_parts(mb, C, hair_scale):
    """Head ellipsoid plus hair cap; hair_scale varies the cap per figure."""
    F.ellipsoid(mb, C, 0.095, 0.115, 0.11, 'skin', segs=10, rings=6)
    hs = hair_scale
    F.ellipsoid(mb, (C[0], C[1] + 0.012, C[2] + 0.012), 0.104 * hs, 0.122 * hs, 0.117 * hs, 'hair',
                segs=10, rings=5, top_only=True)


def rigid_weights(ob, arm):
    """Head and hair -> head; hands -> hand_R (x > 0) or hand_L; feet -> foot_R / foot_L."""
    ensure_groups(ob, arm)
    g = ob.vertex_groups
    for v in ob.data.vertices:
        x, y = v.co.x, v.co.z            # glTF height is Blender z
        if y > 1.46:
            g['head'].add([v.index], 1.0, 'REPLACE')
        elif y < 0.14:
            g['foot_R' if x > 0 else 'foot_L'].add([v.index], 1.0, 'REPLACE')
        else:
            g['hand_R' if x > 0 else 'hand_L'].add([v.index], 1.0, 'REPLACE')


def chiton_weights(ch, body, arm):
    """Transfer from the weighted body, then reshape: no arm influence on the yoke (folded into the
    clavicles), legs fade from 0 at the waist to at most 60 % at the hem, shin and foot fold into the
    thigh, then 3 smoothing passes and a 4-influence cap."""
    ensure_groups(ch, arm)
    select_only([body, ch], ch)
    dt = ch.modifiers.new('DT', 'DATA_TRANSFER')
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'
    dt.layers_vgroup_select_dst = 'NAME'
    bpy.context.view_layer.objects.active = ch
    bpy.ops.object.datalayout_transfer(modifier='DT')
    bpy.ops.object.modifier_apply(modifier='DT')
    names = [vg.name for vg in ch.vertex_groups]
    arms = {n for n in names if n.startswith(('upperarm', 'forearm', 'hand'))}
    legs = {n for n in names if n.startswith(('thigh', 'shin', 'foot'))}
    for v in ch.data.vertices:
        y = v.co.z                       # glTF height
        w = {names[e.group]: e.weight for e in v.groups if e.weight > 1e-4}
        a = sum(w.pop(n, 0.0) for n in list(w) if n in arms)
        if a:
            side = 'R' if v.co.x > 0 else 'L'
            w['clavicle_' + side] = w.get('clavicle_' + side, 0.0) + a
        t = min(max((1.0 - y) / (1.0 - 0.53), 0.0), 1.0)   # 0 at the waist (y=1.0), 1 at the hem (y=0.53)
        leg = sum(w.get(n, 0.0) for n in legs)
        tot = sum(w.values()) or 1.0
        legshare = 0.6 * t
        neww = {}
        for n, x in w.items():
            if n in legs:
                key = 'thigh_' + n[-1]
                neww[key] = neww.get(key, 0.0) + (x / max(leg, 1e-6)) * legshare
            else:
                neww[n] = neww.get(n, 0.0) + x / tot * (1.0 - legshare if leg else 1.0)
        if leg == 0 and t > 0:
            neww = {n: x / tot for n, x in w.items()}
        for e in list(v.groups):
            ch.vertex_groups[e.group].remove([v.index])
        s = sum(neww.values()) or 1.0
        for n, x in neww.items():
            if x / s > 1e-3:
                ch.vertex_groups[n].add([v.index], x / s, 'REPLACE')
    select_only([ch], ch)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_smooth(group_select_mode='ALL', factor=0.5, repeat=3)
    bpy.ops.object.mode_set(mode='OBJECT')


def bake_colours(ob, pal):
    """Per-corner colour from each part's material slot, so the merged figure needs one material."""
    me = ob.data
    slot_names = [s.material.name if s.material else '' for s in ob.material_slots]
    ca = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
    for poly in me.polygons:
        rgb = pal.get(slot_names[poly.material_index], (0.5, 0.5, 0.5))
        for li in poly.loop_indices:
            ca.data[li].color = (rgb[0], rgb[1], rgb[2], 1.0)


def crew_material():
    m = bpy.data.materials.get('crew')
    if m is not None:
        return m
    m = bpy.data.materials.new('crew')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    vc = nt.nodes.new('ShaderNodeVertexColor')
    vc.layer_name = 'Col'
    nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Metallic'].default_value = 0.0
    return m


def build_figure(name, var):
    r = kit.rng(var['seed'])
    P = jitter(F.pose_std(), r)
    arm = build_armature(name, P)

    body = F.skin_body(P, name=name + '_skin')
    decimate(body, BODY_BUDGET)
    rigid = MB()
    head_parts(rigid, (0, 1.60, 0.0), var['hair_scale'])
    for k in ('hdL', 'hdR'):
        F.hand(rigid, P[k])
    for k in ('ankleL', 'ankleR'):
        F.foot(rigid, P[k])
    rigid_ob = rigid.build(name + '_rigid', smooth=True)
    cm = MB()
    F.chiton(cm)
    torus(cm, (0, P['waist'][1], 0), (0, 1, 0), 0.14, 0.018, 12, 4, 'leather')
    ch = cm.build(name + '_chiton', smooth=True)

    # heat weights on the closed skin body only; rules on the rigid parts; transfer + reshape on the chiton
    ensure_groups(body, arm)
    select_only([body, arm], arm)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    unweighted_body = sum(1 for v in body.data.vertices if len(v.groups) == 0)
    rigid_weights(rigid_ob, arm)
    chiton_weights(ch, body, arm)

    pal = palette(var)
    for part in (body, rigid_ob, ch):
        bake_colours(part, pal)
    for o in (rigid_ob, ch):
        o.parent = None
    fig = join([body, rigid_ob, ch], name + '_mesh')
    fig.parent = arm
    if not any(m.type == 'ARMATURE' for m in fig.modifiers):
        m = fig.modifiers.new('Armature', 'ARMATURE')
        m.object = arm
    else:
        for m in fig.modifiers:
            if m.type == 'ARMATURE':
                m.object = arm

    me = fig.data
    me.materials.clear()
    me.materials.append(crew_material())
    for p in me.polygons:
        p.material_index = 0
    try:
        me.color_attributes.active_color_name = 'Col'
    except AttributeError:
        pass

    select_only([fig], fig)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    counts = [len(v.groups) for v in me.vertices]
    sums_bad = 0
    for v in me.vertices:
        if v.groups and abs(sum(g.weight for g in v.groups) - 1.0) > 1e-3:
            sums_bad += 1
    print(f'[rowers] {name}: {tris(fig)} tris, {len(me.vertices)} verts, '
          f'max influences {max(counts)}, unweighted {sum(1 for c in counts if c == 0)} '
          f'(body unweighted before transfer {unweighted_body}), weight-sum errors {sums_bad}')
    return fig, arm


# ------------------------------------------------------------------ clips

def _rot(name, axis, deg):
    return name, (axis, deg)


def walk_samples():
    """1 s cycle, two steps per cycle, sampled every 2 frames; the last key equals the first."""
    out = []
    for i in range(0, 25, 2):
        ph = 2 * math.pi * i / 24
        s, c = math.sin(ph), math.cos(ph)
        rots = {
            'thigh_R': (AX_X, 24 * s), 'thigh_L': (AX_X, -24 * s),
            'shin_R': (AX_X, -(5 + 5 * (1 - c))), 'shin_L': (AX_X, -(5 + 5 * (1 + c))),
            'upperarm_R': (AX_X, -14 * s), 'upperarm_L': (AX_X, 14 * s),
            'forearm_R': (AX_X, 14.0), 'forearm_L': (AX_X, 14.0),
            'pelvis': (AX_Z, 3 * s), 'spine': (AX_Z, -2 * s), 'chest': (AX_Z, 2 * s),
            'head': (AX_Z, -1.5 * s),
        }
        locs = {'pelvis': (0.0, 0.0, 0.008 * math.cos(2 * ph))}
        out.append((1 + i, rots, locs))
    return out


def idle_samples():
    """4 s breathing loop with a slow weight shift and head sway."""
    out = []
    for i in range(0, 97, 8):
        ph = 2 * math.pi * i / 96
        s = math.sin(ph)
        rots = {
            'chest': (AX_X, 1.0 * s), 'spine': (AX_Z, -1.0 * s), 'pelvis': (AX_Z, 1.0 * s),
            'head': (AX_Z, 2.5 * s), 'upperarm_R': (AX_X, 2.0 * math.sin(ph + 0.5)),
            'upperarm_L': (AX_X, 2.0 * math.sin(ph + 0.5)),
            'forearm_R': (AX_X, 6.0), 'forearm_L': (AX_X, 6.0),
        }
        locs = {'pelvis': (0.0, 0.0, 0.002 * s)}
        out.append((1 + i, rots, locs))
    return out


def rest_sit_samples():
    """Seated on the deck: hips about 0.46 m lower, thighs flat forward, shins down, hands on knees.
    Breath is a 4 s loop of 5 keys; the first and last keys are equal."""
    base_rots = {
        'thigh_R': (AX_X, 88.0), 'thigh_L': (AX_X, 88.0),
        'shin_R': (AX_X, -88.0), 'shin_L': (AX_X, -88.0),
        'spine': (AX_X, -6.0),
        'upperarm_R': (AX_X, 20.0), 'upperarm_L': (AX_X, 20.0),
        'forearm_R': (AX_X, 35.0), 'forearm_L': (AX_X, 35.0),
    }
    out = []
    for i in range(0, 97, 24):
        ph = 2 * math.pi * i / 96
        rots = dict(base_rots)
        rots['chest'] = (AX_X, 1.0 * math.cos(ph))
        locs = {'pelvis': (0.0, 0.0, -0.46 + 0.002 * math.cos(ph))}
        out.append((1 + i, rots, locs))
    return out


CLIPS = [('walk', walk_samples), ('idle_stand', idle_samples), ('rest_sit', rest_sit_samples)]


def apply_pose(arm, rots, locs):
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        pb.location = (0.0, 0.0, 0.0)
    for name, (axis_world, deg) in rots.items():
        # pose rotations act in the bone's rest frame: convert the world axis into it
        rest = arm.data.bones[name].matrix_local.to_3x3()
        axis_local = (rest.inverted() @ axis_world).normalized()
        arm.pose.bones[name].rotation_quaternion = Quaternion(axis_local, math.radians(deg))
    for name, v in locs.items():
        rest = arm.data.bones[name].matrix_local.to_3x3()
        arm.pose.bones[name].location = rest.inverted() @ Vector(v)


def key_pose(arm, f, rots, locs, animated, prev):
    """Key only the bones the clip moves: untouched bones get no tracks at all.
    prev holds each bone's last keyed quaternion; a key in the opposite hemisphere is negated first, so the
    quaternion track stays continuous (q and -q are the same rotation, but interpolating across them spins)."""
    apply_pose(arm, rots, locs)
    for name in animated:
        pb = arm.pose.bones[name]
        q = pb.rotation_quaternion.copy()
        if name in prev and q.dot(prev[name]) < 0:
            q.negate()
            pb.rotation_quaternion = q
        prev[name] = q.copy()
        pb.keyframe_insert('rotation_quaternion', frame=f)
        if name in locs:
            pb.keyframe_insert('location', frame=f)


def make_clip(clip_name, samples, arms):
    """One action per clip, shared by name: each armature gets its own slot in the same action."""
    act = bpy.data.actions.new(clip_name)
    frames = samples()
    animated = []
    for _f, rots, locs in frames:
        for name in list(rots) + list(locs):
            if name not in animated:
                animated.append(name)
    for arm in arms:
        arm.animation_data_create()
        arm.animation_data.action = act
        prev = {}
        for f, rots, locs in frames:
            key_pose(arm, f, rots, locs, animated, prev)
        set_linear(arm)
    return act


def set_linear(arm):
    """LINEAR keys: the glTF exporter then writes LINEAR samplers, a per-key slerp. Bezier keys export as
    CUBICSPLINE, and their auto tangents spike (33.9 on idle_stand pelvis) when a quaternion key sits near a
    sign change."""
    cb = anim_utils.animdata_get_channelbag_for_assigned_slot(arm.animation_data)
    assert cb is not None, 'no channelbag for the armature action'
    for fc in cb.fcurves:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
        fc.update()


# ------------------------------------------------------------------ preview and export

def render(name, objs, color_type, front=(0.5, 0.9, 0.3), res=(800, 600)):
    scene = bpy.context.scene
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    bpy.context.view_layer.update()
    hidden = []
    for o in scene.objects:
        if o.type == 'MESH' and o not in objs and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
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
    cam.location = centre + Vector(front).normalized() * dist
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light = 'STUDIO'
    sh.color_type = color_type
    sh.show_cavity = True
    sh.cavity_type = 'BOTH'
    sh.cavity_ridge_factor = 1.0
    sh.background_type = 'WORLD'
    sh.background_color = (0.80, 0.82, 0.84)
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = os.path.join(PREVIEW_DIR, name + '.png')
    try:
        bpy.ops.render.render(write_still=True)
    finally:
        for o in hidden:
            o.hide_render = False
        bpy.data.objects.remove(cam, do_unlink=True)
        bpy.data.cameras.remove(cam_data)
    print('[rowers] preview', scene.render.filepath)


CHAINS = {
    'torso': ['pelvis', 'spine', 'chest', 'neck', 'clavicle_R', 'clavicle_L'],
    'head': ['head'],
    'arm_R': ['clavicle_R', 'upperarm_R', 'forearm_R', 'hand_R'],
    'arm_L': ['clavicle_L', 'upperarm_L', 'forearm_L', 'hand_L'],
    'leg_R': ['thigh_R', 'shin_R', 'foot_R'],
    'leg_L': ['thigh_L', 'shin_L', 'foot_L'],
}


def weight_overlay(fig, chain, bones):
    """Vertex colour = summed weight of the chain's bones (blue 0 -> red 1), rendered in the rest pose."""
    me = fig.data
    gname = {vg.index: vg.name for vg in fig.vertex_groups}
    wsum = []
    for v in me.vertices:
        wsum.append(min(1.0, sum(g.weight for g in v.groups if gname.get(g.group) in bones)))
    if 'Wt' in me.color_attributes:
        me.color_attributes.remove(me.color_attributes['Wt'])
    ca = me.color_attributes.new('Wt', 'FLOAT_COLOR', 'CORNER')
    for poly in me.polygons:
        for li in poly.loop_indices:
            t = wsum[me.loops[li].vertex_index]
            ca.data[li].color = (t, 0.05, 1.0 - t, 1.0)
    try:
        me.color_attributes.active_color_name = 'Wt'
    except AttributeError:
        pass
    render(f'weights_{fig.name}_{chain}', [fig], 'VERTEX', res=(600, 600))
    me.color_attributes.remove(ca)
    try:
        me.color_attributes.active_color_name = 'Col'
    except AttributeError:
        pass


def _read_glb(path):
    with open(path, 'rb') as fh:
        b = fh.read()
    jlen = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jlen].decode('utf8'))
    rest = b[20 + jlen:]
    binb = b''
    if len(rest) >= 8:
        blen = struct.unpack('<I', rest[0:4])[0]
        binb = rest[8:8 + blen]
    return j, bytearray(binb)


def _write_glb(path, j, binb):
    jb = json.dumps(j, separators=(',', ':')).encode('utf8')
    jb += b' ' * (-len(jb) % 4)
    binb = bytes(binb) + b'\0' * (-len(binb) % 4)
    total = 12 + 8 + len(jb) + 8 + len(binb)
    out = struct.pack('<4sII', b'glTF', 2, total)
    out += struct.pack('<I4s', len(jb), b'JSON') + jb
    out += struct.pack('<I4s', len(binb), b'BIN\0') + binb
    with open(path, 'wb') as fh:
        fh.write(out)


def _merge_animations(base_path, extra):
    """extra: list of GLB paths exported with one clip each. Appends their animations to base_path.
    Node lists must match (same export of the same objects), so node indices are reused as they are."""
    base_j, base_bin = _read_glb(base_path)
    base_names = [n.get('name') for n in base_j['nodes']]
    for path in extra:
        j, binb = _read_glb(path)
        assert [n.get('name') for n in j['nodes']] == base_names, 'node lists differ between clip exports'
        acc_map, bv_map = {}, {}

        def copy_accessor(idx):
            if idx in acc_map:
                return acc_map[idx]
            acc = dict(j['accessors'][idx])
            bv_idx = acc['bufferView']
            if bv_idx not in bv_map:
                bv = dict(j['bufferViews'][bv_idx])
                off = bv.get('byteOffset', 0)
                chunk = bytes(binb[off:off + bv['byteLength']])
                base_bin.extend(b'\0' * (-len(base_bin) % 4))
                bv_new = {'buffer': 0, 'byteOffset': len(base_bin), 'byteLength': len(chunk)}
                base_bin.extend(chunk)
                base_j.setdefault('bufferViews', []).append(bv_new)
                bv_map[bv_idx] = len(base_j['bufferViews']) - 1
            acc['bufferView'] = bv_map[bv_idx]
            acc['byteOffset'] = acc.get('byteOffset', 0)
            base_j.setdefault('accessors', []).append(acc)
            acc_map[idx] = len(base_j['accessors']) - 1
            return acc_map[idx]

        for anim in j.get('animations', []):
            samplers = []
            for smp in anim['samplers']:
                samplers.append({'input': copy_accessor(smp['input']), 'output': copy_accessor(smp['output']),
                                 'interpolation': smp.get('interpolation', 'LINEAR')})
            # samplers are per animation in glTF, so channel sampler indices carry over unchanged
            channels = [{'sampler': c['sampler'], 'target': dict(c['target'])} for c in anim['channels']]
            base_j.setdefault('animations', []).append({'name': anim['name'], 'samplers': samplers,
                                                        'channels': channels})
    base_j['buffers'][0]['byteLength'] = len(base_bin)
    _write_glb(base_path, base_j, base_bin)


def _fix_quat_signs(j, binb):
    """Safety net on the written file: the exporter re-derives each quaternion from the bone matrix, which can
    return q or -q. Flip every rotation key into the hemisphere of the previous key of its channel (cubic keys
    flip their tangents with the value). Returns the number of keys flipped."""
    flips = 0
    for anim in j.get('animations', []):
        for ch in anim['channels']:
            if ch['target'].get('path') != 'rotation':
                continue
            smp = anim['samplers'][ch['sampler']]
            acc = j['accessors'][smp['output']]
            bv = j['bufferViews'][acc['bufferView']]
            assert acc['componentType'] == 5126 and acc['type'] == 'VEC4', 'rotation output must be float VEC4'
            base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
            stride = bv.get('byteStride', 16)
            cubic = smp.get('interpolation') == 'CUBICSPLINE'
            per = 3 if cubic else 1
            prev = None
            for k in range(acc['count'] // per):
                elems = [base + (k * per + e) * stride for e in range(per)]
                val = struct.unpack_from('<4f', binb, elems[1 if cubic else 0])
                if prev is not None and sum(a * b for a, b in zip(val, prev)) < 0:
                    flips += 1
                    for off in elems:
                        v = struct.unpack_from('<4f', binb, off)
                        struct.pack_into('<4f', binb, off, *(-x for x in v))
                    val = tuple(-x for x in val)
                prev = val
    return flips


def export(figs):
    """Each clip is exported on its own and the animation lists are merged into one file. Only fig_rower_a
    gets the clip's action at export, so the file carries one figure's tracks under plain bone names: all
    three figures share the same skeleton names, and GLTFLoader suffixes the duplicates (_1, _2) on the
    figures after the first. The runtime clones fig_rower_a's clips onto each figure by name."""
    tmp = tempfile.mkdtemp(prefix='rowers_')
    arms = [arm for _f, arm in figs]
    meshes = [f for f, _a in figs]
    paths = []
    for clip_name, _samples in CLIPS:
        for k, arm in enumerate(arms):
            arm.animation_data.action = bpy.data.actions[clip_name] if k == 0 else None
        bpy.ops.object.select_all(action='DESELECT')
        for o in arms + meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = arms[0]
        path = os.path.join(tmp, clip_name + '.glb')
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_selection=True, export_yup=True,
            export_apply=False, export_cameras=False, export_lights=False,
            export_animations=True, export_animation_mode='ACTIONS',
            export_skins=True, export_def_bones=False, export_materials='EXPORT',
            export_vertex_color='ACTIVE',
            export_force_sampling=False, export_optimize_animation_size=True,
            export_optimize_animation_keep_anim_armature=False,
        )
        paths.append(path)
        for arm in arms:
            arm.animation_data.action = None
    # the first clip is the base; the rest contribute their animations
    shutil.copyfile(paths[0], MODEL_PATH)
    _merge_animations(MODEL_PATH, paths[1:])
    j, binb = _read_glb(MODEL_PATH)
    flips = _fix_quat_signs(j, binb)
    _write_glb(MODEL_PATH, j, binb)
    print(f'[rowers] quaternion keys flipped into their previous hemisphere: {flips}')
    shutil.rmtree(tmp, ignore_errors=True)
    print('[rowers] wrote', MODEL_PATH)


def main():
    reset_scene()
    crew_material()
    figs = [build_figure(name, var) for name, var in VARIANTS]
    actions = {}
    for clip_name, samples in CLIPS:
        actions[clip_name] = make_clip(clip_name, samples, [arm for _f, arm in figs])
    for _f, arm in figs:
        arm.animation_data.action = None
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, 97
    export(figs)

    # previews: weight overlays for fig_rower_a (rest pose, at origin)
    fig_a, arm_a = figs[0]
    for _f, arm in figs:
        arm.animation_data.action = None
        apply_pose(arm, {}, {})
    for chain, bones in CHAINS.items():
        weight_overlay(fig_a, chain, bones)
    # rest pose, three figures side by side (armature offsets move their meshes too)
    xs = (-0.8, 0.0, 0.8)
    for (fig, arm), x in zip(figs, xs):
        arm.location = (x, 0.0, 0.0)
    render('rower_rest', [f for f, _a in figs], 'VERTEX', front=(0.5, 0.9, 0.3), res=(1000, 600))
    # clip samples on the first figure's pose (every figure shares the clip)
    for clip_name, frame in (('walk', 7), ('rest_sit', 1), ('idle_stand', 1)):
        for _f, arm in figs:
            arm.animation_data_create()
            arm.animation_data.action = actions[clip_name]
        scene.frame_set(frame)
        render(f'{clip_name}_frame{frame:02d}', [f for f, _a in figs], 'VERTEX', front=(0.7, 0.9, 0.3),
               res=(1000, 600))
        for _f, arm in figs:
            arm.animation_data.action = None

    for fig, arm in figs:
        print(f'[rowers] {fig.name}: bones {len(arm.data.bones)}, primitives 1, mesh {fig.data.name}')


main()
