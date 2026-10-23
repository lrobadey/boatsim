"""Rebuild pass 5 as an exterior shell, omitting oars and running rig for runtime articulation.
No saved concept scene is overwritten. Run with Blender --python-exit-code 1 -b -P this script.
"""
from pathlib import Path
import bpy, math, json, sys
ROOT=Path(__file__).resolve().parents[1]
base=(ROOT/'blender/build_ship.py').read_text()
start=base.index('                wood.rod(start,end,.105')
end=base.index('\n\n    # Stem profile',start)
base=base[:start]+'                pass # animated oars supplied by current game crew\n'+base[end:]
source=(ROOT/'blender/build_thalassa.py').read_text()
source=source.replace("base_source=(STUDY_ROOT/'blender/build_ship.py').read_text()",'base_source=EXPORT_BASE_SOURCE')
steer_start=source.index('        wood.rod(a,b,.21,.13,12)')
steer_end=source.index('        wood.rod((-30,side*2.1,5.4)',steer_start)
source=source[:steer_start]+'        # Runtime steering surfaces replace the four scenic sweeps.\n'+source[steer_end:]
start=source.index('    wood.rod((x,0,yard)')
end=source.index('        for j in range(5):',start)
source=source[:start]+'    for side in [-1,1]:\n'+source[end:]
source=source[:source.index("OUT=STUDY_ROOT/'renders/thalassa'")]
sys.argv=[str(ROOT/'blender/build_thalassa.py'),'--','--refine','5','--save-only']
scope={'__file__':str(ROOT/'blender/build_thalassa.py'),'EXPORT_BASE_SOURCE':base}
exec(compile(source,str(ROOT/'blender/build_thalassa.py'),'exec'),scope)
# Preserve deliberate colors; translate procedural Cycles materials into portable PBR.
M=scope['M']
tints={'Cedar | hull':(.086,.057,.030),'Honey teak | deck':(.28,.17,.087),
       'Oiled timber | structure':(.060,.027,.014),'Flax linen':(.74,.66,.49)}
for name,mat in M.items():
    bs=mat.node_tree.nodes.get('Principled BSDF')
    if not bs: continue
    # Procedural ramps and multiply nodes have no portable glTF equivalent.
    for socket_name in ['Base Color','Normal','Roughness']:
        for link in list(bs.inputs[socket_name].links):mat.node_tree.links.remove(link)
    if name in tints:bs.inputs['Base Color'].default_value=(*tints[name],1)
    if name in tints and name!='Flax linen':
        # Normal and roughness maps have the authored metre-scaled UVs; colors remain the chosen palette.
        for tex in mat.node_tree.nodes:
            if tex.type!='TEX_IMAGE' or not tex.image:continue
            if tex.image.name.startswith('wood_normal'):
                normal=mat.node_tree.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.22
                mat.node_tree.links.new(tex.outputs['Color'],normal.inputs['Color']);mat.node_tree.links.new(normal.outputs[0],bs.inputs['Normal'])
            if tex.image.name.startswith('wood_rough'):mat.node_tree.links.new(tex.outputs['Color'],bs.inputs['Roughness'])
bpy.ops.object.select_all(action='DESELECT')
selected=[]
for ob in list(bpy.context.scene.objects):
    if ob.type in {'MESH','FONT'} and ob.name!='Open sea':
        # Millimetre-scale offline bevels multiply deck/beam vertices by an order of magnitude.
        # Keep the actual joinery, hull lines and all exterior details; omit only render micro-bevels.
        for modifier in list(ob.modifiers):
            if modifier.type=='BEVEL':ob.modifiers.remove(modifier)
        ob.select_set(True);selected.append(ob)
out=ROOT/'browser/assets';out.mkdir(parents=True,exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(out/'thalassa-shell.glb'),export_format='GLB',use_selection=True,
    export_yup=True,export_apply=True,export_extras=True,export_lights=False,export_cameras=False)
(out/'manifest.json').write_text(json.dumps({'source':'Blender pass 5, rebuilt without moving oars and running sails',
    'runtimeRotationY':math.pi/2,'hullLength':82,'hullCentres':[-8.5,8.5],'hullBeam':6.6,
    'objects':len(selected),'vertices':sum(len(o.data.vertices) for o in selected if o.type=='MESH'),
    'bytes':(out/'thalassa-shell.glb').stat().st_size},indent=2))
print('THALASSA_EXPORT', (out/'manifest.json').read_text(),flush=True)
