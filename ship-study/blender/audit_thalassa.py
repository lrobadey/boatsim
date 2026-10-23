"""Read-only packaging check for the delivered native Blender documents."""
import bpy
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
result=[]
for suffix in ['', '-dusk']:
    source=ROOT/'blender'/('thalassa-pass-05'+suffix+'.blend')
    bpy.ops.wm.open_mainfile(filepath=str(source))
    scene=bpy.context.scene
    images=[im for im in bpy.data.images if im.source=='FILE']
    unpacked=[im.name for im in images if not im.packed_file]
    assert not unpacked,(source,unpacked)
    assert scene['Refinement pass']==5
    result.append(dict(scene=str(source),refinement=scene['Refinement pass'],
        file_size=source.stat().st_size,packed_images=[im.name for im in images],
        cameras=[o.name for o in scene.objects if o.type=='CAMERA'],
        meshes=sum(o.type=='MESH' for o in scene.objects),
        render_engine=scene.render.engine,resolution=[scene.render.resolution_x,scene.render.resolution_y],
        samples=scene.cycles.samples))
(ROOT/'renders/thalassa/final-audit.json').write_text(json.dumps(result,indent=2))
print('PACKAGING_VERIFIED',[(r['scene'],len(r['packed_images']),r['resolution']) for r in result],flush=True)
