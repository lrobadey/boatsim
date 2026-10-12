"""Render posed OBJ snapshots (skinned in three.js) with Workbench: side and 3/4 views, one contact sheet row
per snapshot. Run: Blender -b --factory-startup -P render_snaps.py -- <snapdir> <outpng>"""
import math
import os
import sys
import glob
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
snapdir, outpng = argv[0], argv[1]
COL = {'skin': (0.43, 0.2, 0.11), 'hair': (0.03, 0.015, 0.01), 'cloth': (0.8, 0.75, 0.62),
       'leather': (0.15, 0.08, 0.03), 'wood': (0.32, 0.17, 0.07), 'deck': (0.45, 0.4, 0.33)}
files = sorted(glob.glob(os.path.join(snapdir, '*.obj')))
scene = bpy.context.scene
for o in list(scene.objects):
    bpy.data.objects.remove(o, do_unlink=True)
scene.render.engine = 'BLENDER_WORKBENCH'
sh = scene.display.shading
sh.light = 'STUDIO'
sh.color_type = 'MATERIAL'
sh.show_cavity = True
sh.background_type = 'WORLD'
sh.background_color = (0.85, 0.87, 0.9)
scene.render.resolution_x, scene.render.resolution_y = 420, 520
scene.render.image_settings.file_format = 'PNG'
cam_data = bpy.data.cameras.new('cam')
cam_data.lens = 40
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
tiles = []
for fp in files:
    before = set(scene.objects)
    bpy.ops.wm.obj_import(filepath=fp, forward_axis='NEGATIVE_Z', up_axis='Y')
    objs = [o for o in scene.objects if o not in before]
    for o in objs:
        for slot in o.material_slots:
            m = slot.material
            if m:
                base = m.name.split('.')[0]
                c = COL.get(base, (0.6, 0.6, 0.6))
                m.diffuse_color = (*c, 1.0)
    # frame on the figure (skin object bounds)
    pts = []
    for o in objs:
        if o.name.split('.')[0] in ('skin', 'cloth'):
            pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
    mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    c = (mn + mx) / 2
    tag = os.path.splitext(os.path.basename(fp))[0]
    # Blender coords: x = ship x (starboard), y = -ship z (forward), z = up
    for view, d in (('side', Vector((-1.0, 0.0, 0.12))), ('q34', Vector((-0.75, -0.9, 0.45))), ('top', Vector((0.0, 0.05, 1.0)))):
        d = d.normalized()
        cam.location = c + d * 3.6
        cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
        path = os.path.join(snapdir, f'{tag}_{view}.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        tiles.append(path)
    for o in objs:
        bpy.data.objects.remove(o, do_unlink=True)

# contact sheet: rows = snapshots, cols = views
imgs = [bpy.data.images.load(p) for p in tiles]
cols, rows = 3, len(files)
w, h = imgs[0].size
sheet = bpy.data.images.new('sheet', w * cols, h * rows)
px = [0.0] * (w * cols * h * rows * 4)
for k, im in enumerate(imgs):
    r, cc = k // cols, k % cols
    src = list(im.pixels)
    oy = (rows - 1 - r) * h
    for y in range(h):
        row0 = ((oy + y) * w * cols + cc * w) * 4
        px[row0:row0 + w * 4] = src[y * w * 4:(y + 1) * w * 4]
sheet.pixels = px
sheet.filepath_raw = outpng
sheet.file_format = 'PNG'
sheet.save()
print('[snaps] wrote', outpng)
