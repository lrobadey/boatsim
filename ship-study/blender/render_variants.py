"""Render the three saved, exterior-only variants without further design passes."""
import bpy
import json
import sys
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'renders/selection'
OUT.mkdir(parents=True,exist_ok=True)
selected=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else ['A','B','C']

for letter in selected:
    letter=letter.upper()
    source=ROOT/'blender'/(letter.lower()+'-terraced.blend')
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene=bpy.context.scene
    scene.cycles.samples=96
    scene.cycles.use_denoising=True
    prefs=bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type='METAL'
    prefs.get_devices()
    for d in prefs.devices:d.use=d.type=='METAL'
    scene.cycles.device='GPU'
    scene.render.resolution_x=2000
    scene.render.resolution_y=1300
    scene.render.resolution_percentage=100
    # A second photographic viewpoint makes the height and sheer easier to judge.
    ob=bpy.data.objects.get('Camera | waterline')
    if ob is None:
        data=bpy.data.cameras.new('Camera | waterline')
        ob=bpy.data.objects.new('Camera | waterline',data)
        scene.collection.objects.link(ob)
    data=ob.data
    ob.location=(92,-135,29)
    ob.rotation_euler=(Vector((0,0,10))-ob.location).to_track_quat('-Z','Y').to_euler()
    data.lens=54
    data.clip_end=200000
    views=['hero','stern','waterline']
    for view in views:
        scene.camera=bpy.data.objects['Camera | '+view]
        scene.render.filepath=str(OUT/(letter.lower()+'-'+view+'.png'))
        bpy.ops.render.render(write_still=True)
        print('RENDER_VERIFIED',scene.render.filepath,flush=True)
    scene.camera=bpy.data.objects['Camera | hero']
    scene.render.filepath=str(OUT/(letter.lower()+'-hero.png'))
    scene['Review stage']='Three exterior alternatives awaiting user choice; five design passes deferred'
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    metadata={
        'variant':letter,'name':scene['Concept'],
        'length_m':scene['Hull length (m)'],'beam_m':scene['Hull beam (m)'],
        'source':str(source),'engine':scene.render.engine,'samples':scene.cycles.samples,
        'resolution':[scene.render.resolution_x,scene.render.resolution_y],
        'views':views,'interiors':False,
    }
    (OUT/(letter.lower()+'-manifest.json')).write_text(json.dumps(metadata,indent=2))
