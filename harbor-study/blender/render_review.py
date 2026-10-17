"""Non-destructive, neutral-light review of the existing Blender master."""
import bpy, sys
from pathlib import Path
from mathutils import Vector

root = Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(root / 'blender/ormos-harbor.blend'))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 12
scene.cycles.use_denoising = True
scene.render.resolution_x = 960
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.view_settings.exposure = 0
scene.world.use_nodes = True
background = scene.world.node_tree.nodes.get('Background')
background.inputs['Color'].default_value = (.65, .74, .85, 1)
background.inputs['Strength'].default_value = .35
# Reproduce the vertex tints used by the GLB viewer in this unsaved session.
for mat in bpy.data.materials:
    if not mat.use_nodes:
        continue
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bs = nodes.get('Principled BSDF')
    if not bs:
        continue
    base = bs.inputs['Base Color']
    original = base.links[0].from_socket if base.is_linked else None
    tint = nodes.new('ShaderNodeVertexColor')
    tint.layer_name = 'Tint'
    mix = nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 1
    mix.inputs[1].default_value = base.default_value
    if original:
        links.new(original, mix.inputs[1])
    links.new(tint.outputs['Color'], mix.inputs[2])
    links.new(mix.outputs[0], base)

views = [
    ('01-quay', (-15, -11, 3.7), (-5, 2, 2.7)),
    ('02-warehouse', (-4, 1, 6), (-15, 17, 4)),
    ('03-village', (33, 2, 13), (9, 29, 5)),
    ('04-shore', (-65, -30, 30), (-36, 15, 4)),
]
scene.camera.data.lens = 38
out = root / 'evidence/refinement-v2'
out.mkdir(parents=True, exist_ok=True)
for name, position, target in views:
    if '--' in sys.argv and name not in sys.argv[sys.argv.index('--')+1:]:
        continue
    scene.camera.location = position
    scene.camera.rotation_euler = (Vector(target)-Vector(position)).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = str(out / (name+'.png'))
    bpy.ops.render.render(write_still=True)
    print('REVIEW_SAVED', name, flush=True)
