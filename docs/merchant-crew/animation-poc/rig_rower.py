"""PoC: rigged standing rower (fig_rower) from the figures.py Skin-modifier body.

Hand-built 22-bone armature from the figures.py joint map; heat (automatic) weights on the manifold
skin body only; rule weights on the rigid parts (head, hair, hands, feet, belt); chiton weights by
nearest-surface transfer from the weighted body, then reshaped (upper part spine-led, hem shared
with the pelvis) and smoothed. One idle clip to prove the clip path. Writes only to the scratchpad.

Run: Blender -b --factory-startup -P rig_rower.py
"""
import math
import os
import sys

REPO_BLENDER = '/Users/lucarobadey/Developer/boatsim/tools/blender'
OUT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, REPO_BLENDER)
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import kit  # noqa: E402

kit.PREVIEW_DIR = os.path.join(OUT, 'previews')   # never write into the repo
kit.MODELS_DIR = OUT
import figures as F  # noqa: E402
from kit import MB, to_b, reset_scene, apply_modifiers, tris, join, torus  # noqa: E402

BODY_BUDGET = 1500


def V(p):
    return Vector(to_b(p))


def build_armature(P):
    arm_data = bpy.data.armatures.new('rower_rig')
    arm = bpy.data.objects.new('rower_rig', arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones

    def bone(name, head, tail, parent=None, deform=True, connect=False):
        b = eb.new(name)
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
    # figures.py's 'L' joints sit at +x; the figure faces -z, so +x is its anatomical RIGHT.
    # Bones are named anatomically (side suffix from the figure's point of view).
    for js, s, sx in (('L', 'R', 1), ('R', 'L', -1)):
        sh, el, wr, hd = P['sh' + js], P['el' + js], P['wr' + js], P['hd' + js]
        bone('clavicle_' + s, (sx * 0.035, 1.39, 0.0), sh, 'chest')
        bone('upperarm_' + s, sh, el, 'clavicle_' + s, connect=True)
        bone('forearm_' + s, el, wr, 'upperarm_' + s, connect=True)
        mid = tuple((a + b) / 2 for a, b in zip(el, wr))
        bone('forearmTwist_' + s, mid, wr, 'forearm_' + s)
        tip = tuple(h + (h - w) * 0.9 for h, w in zip(hd, wr))
        bone('hand_' + s, wr, tip, 'forearm_' + s, connect=True)
        hip, kn, an = P['hip' + js], P['knee' + js], P['ankle' + js]
        bone('thigh_' + s, hip, kn, 'pelvis')
        bone('shin_' + s, kn, an, 'thigh_' + s, connect=True)
        bone('foot_' + s, an, (an[0], 0.03, an[2] - 0.19), 'shin_' + s, connect=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def select_only(objs, active):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active


def decimate(ob, budget):
    t = tris(ob)
    if t > budget:
        m = ob.modifiers.new('Decimate', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = budget / t
        apply_modifiers(ob)


def ensure_groups(ob, arm):
    for b in arm.data.bones:
        if b.use_deform and b.name not in ob.vertex_groups:
            ob.vertex_groups.new(name=b.name)


def rigid_part_weights(ob, arm, P):
    """head/hair -> head, hands -> hand_*, feet -> foot_*, belt -> pelvis/spine (per material slot)."""
    ensure_groups(ob, arm)
    g = ob.vertex_groups
    slot_of = {i: s.material.name for i, s in enumerate(ob.material_slots)}
    vmat = {}
    for poly in ob.data.polygons:
        for vi in poly.vertices:
            vmat[vi] = slot_of[poly.material_index]
    for v in ob.data.vertices:
        x, y, z = v.co.x, v.co.z, -v.co.y          # back to glTF space
        m = vmat.get(v.index, 'skin')
        if y > 1.46:
            g['head'].add([v.index], 1.0, 'REPLACE')
        elif y < 0.14:
            g['foot_R' if x > 0 else 'foot_L'].add([v.index], 1.0, 'REPLACE')
        else:
            g['hand_R' if x > 0 else 'hand_L'].add([v.index], 1.0, 'REPLACE')


def chiton_weights(ch, body, arm, P):
    """Transfer from the body surface, then reshape: hem shares weight with the pelvis so the bell
    spans between the legs instead of tearing; the yoke follows chest/clavicles, never the arms."""
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
    gidx = {n: i for i, n in enumerate(names)}
    arms = {n for n in names if n.startswith(('upperarm', 'forearm', 'hand'))}
    legs = {n for n in names if n.startswith(('thigh', 'shin', 'foot'))}
    for v in ch.data.vertices:
        y = v.co.z
        w = {names[e.group]: e.weight for e in v.groups if e.weight > 1e-4}
        # yoke: no arm influence (sleeveless chiton), give it to clavicle/chest
        a = sum(w.pop(n, 0.0) for n in list(w) if n in arms)
        if a:
            side = 'R' if v.co.x > 0 else 'L'
            w['clavicle_' + side] = w.get('clavicle_' + side, 0.0) + a
        # below the belt: legs take at most 60% at the hem, fading to 0 at the waist
        t = min(max((1.0 - y) / (1.0 - 0.53), 0.0), 1.0)   # 0 at y=1.0 (waist), 1 at the hem
        leg = sum(w.get(n, 0.0) for n in legs)
        tot = sum(w.values()) or 1.0
        legshare = 0.6 * t
        neww = {}
        for n, x in w.items():
            if n in legs:
                # shins/feet never drive cloth; fold into the thigh of that side
                key = 'thigh_' + n[-1]
                neww[key] = neww.get(key, 0.0) + (x / max(leg, 1e-6)) * legshare
            else:
                neww[n] = neww.get(n, 0.0) + x / tot * (1.0 - legshare if leg else 1.0)
        if leg == 0 and t > 0:
            neww = {n: x / tot for n, x in w.items()}
        if y < 1.0 and 'pelvis' not in neww:
            neww['pelvis'] = 0.0
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


def main():
    reset_scene()
    P = F.pose_std()
    arm = build_armature(P)

    body = F.skin_body(P, name='rower_body')
    decimate(body, BODY_BUDGET)
    rigid = MB()
    F.head_parts(rigid, (0, 1.60, 0.0))
    for k in ('hdL', 'hdR'):
        F.hand(rigid, P[k])
    for k in ('ankleL', 'ankleR'):
        F.foot(rigid, P[k])
    rigid_ob = rigid.build('rower_rigid', smooth=True)
    cm = MB()
    F.chiton(cm)
    torus(cm, (0, P['waist'][1], 0), (0, 1, 0), 0.14, 0.018, 12, 4, 'leather')
    ch = cm.build('rower_chiton', smooth=True)

    # heat weights on the manifold skin body only
    select_only([body, arm], arm)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    ok = sum(1 for v in body.data.vertices if len(v.groups) == 0)
    print(f'[rig] body auto weights: {len(body.data.vertices)} verts, {ok} unweighted')
    rigid_part_weights(rigid_ob, arm, P)
    chiton_weights(ch, body, arm, P)

    # join into one skinned object, body active so its Armature modifier survives
    for o in (rigid_ob, ch):
        o.parent = None
    fig = join([body, rigid_ob, ch], 'fig_rower')
    fig.parent = arm
    if not any(m.type == 'ARMATURE' for m in fig.modifiers):
        m = fig.modifiers.new('Armature', 'ARMATURE')
        m.object = arm
    select_only([fig], fig)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    kit.box_uv(fig)
    unweighted = sum(1 for v in fig.data.vertices if len(v.groups) == 0)
    print(f'[rig] fig_rower: {tris(fig)} tris, {len(fig.data.vertices)} verts, '
          f'{len(fig.material_slots)} slots, {unweighted} unweighted verts')

    # one clip: a 4 s idle breath/weight shift, to prove the AnimationMixer path
    arm.animation_data_create()
    act = bpy.data.actions.new('idle_breath')
    arm.animation_data.action = act
    pb = arm.pose.bones
    for b in pb:
        b.rotation_mode = 'QUATERNION'
    fps = bpy.context.scene.render.fps
    for i, t in enumerate((0.0, 2.0, 4.0)):
        f = 1 + int(t * fps)
        k = 1.0 if i == 1 else 0.0
        pb['chest'].rotation_quaternion = (1, 0.025 * k, 0, 0)
        pb['pelvis'].location = (0, 0, 0.012 * k)
        pb['head'].rotation_quaternion = (1, -0.02 * k, 0.03 * k, 0)
        for n in ('chest', 'head'):
            pb[n].keyframe_insert('rotation_quaternion', frame=f)
        pb['pelvis'].keyframe_insert('location', frame=f)
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 1 + 4 * fps

    path = os.path.join(OUT, 'fig_rower.glb')
    select_only([fig, arm], fig)
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_cameras=False, export_lights=False, export_animations=True, export_skins=True,
              export_materials='EXPORT', export_def_bones=False, export_force_sampling=False,
              export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=False,
              export_influence_nb=4)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        print('[rig] export kw error', e)
        props = [p.identifier for p in bpy.ops.export_scene.gltf.get_rna_type().properties]
        print('[rig] exporter props:', props)
        raise
    print('[rig] wrote', path)

    # previews: rest pose and a hand-posed lean (pose bones) to eyeball weights
    bpy.context.scene.frame_set(1)
    arm.animation_data.action = None
    for b in pb:
        b.rotation_quaternion = (1, 0, 0, 0)
        b.location = (0, 0, 0)
    kit.preview('rower_rest', [fig], front=(0.5, 0.9, 0.3))

    def rot(name, axis, deg):
        from mathutils import Quaternion
        pb[name].rotation_quaternion = Quaternion(axis, math.radians(deg))

    rot('spine', (1, 0, 0), 25)
    rot('chest', (1, 0, 0), 15)
    rot('upperarm_R', (1, 0, 0), 60)
    rot('upperarm_L', (1, 0, 0), 70)
    rot('forearm_R', (1, 0, 0), 30)
    rot('forearm_L', (1, 0, 0), 20)
    rot('forearmTwist_R', (0, 1, 0), 45)
    rot('thigh_R', (1, 0, 0), 40)
    rot('shin_R', (1, 0, 0), -50)
    rot('thigh_L', (1, 0, 0), -20)
    bpy.context.view_layer.update()
    kit.preview('rower_lunge_blender', [fig], front=(0.9, 0.6, 0.3))
    kit.preview('rower_lunge_blender_side', [fig], front=(1.0, 0.05, 0.15))


main()
