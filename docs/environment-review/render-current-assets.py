import bpy, sys, json
from pathlib import Path
root = str(Path(__file__).resolve().parents[2])
sys.path.insert(0, root + '/tools/blender')
import kit
kit.PREVIEW_DIR=root+'/docs/environment-review/current-assets'
stats=[]
for name in ['house_a','house_b','house_c','quay_segment','quay_head','bollard','fender','gangplank']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=root+'/public/assets/models/'+name+'.glb')
    objs=[o for o in bpy.context.scene.objects if o.type=='MESH']
    stats.append({'asset':name,'triangles':sum(kit.tris(o) for o in objs),'materials':sorted(set(s.material.name for o in objs for s in o.material_slots if s.material))})
    kit.preview(name,objs,res=(1000,750),front=(0.55,0.85,0.3))
with open(kit.PREVIEW_DIR+'/inventory.json','w') as f: json.dump(stats,f,indent=2)
print('ASSET_REVIEW_COMPLETE')
