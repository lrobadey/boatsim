"""Separate, articulated timber/bronze side-wheel retrofit. Does not modify pass-five scenes."""
from pathlib import Path
import bpy, math, json
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
def v(p):
    x,y,z=p
    return Vector((-z,-x,y))
def mat(name,col,metal=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*col,1);m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*col,1);bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=.5 if metal else .73
    return m
wood=mat('Paddle | oiled cedar',(.25,.13,.050));blade=mat('Paddle | honey oak',(.39,.24,.105));bronze=mat('Paddle | aged bronze',(.25,.15,.052),.7);red=mat('Paddle | oxblood lacquer',(.19,.022,.012));rope=mat('Paddle | tarred hemp',(.32,.25,.14))
def finish(ob,name,material,parent=None):
    ob.name=name;ob.data.materials.append(material)
    if parent:
        ob.parent=parent;ob.matrix_parent_inverse=parent.matrix_world.inverted()
    return ob
def box(name,c,d,material,parent=None,angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=v(c));ob=bpy.context.object
    ob.dimensions=(d[2],d[0],d[1]);ob.rotation_euler.y=-angle
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    return finish(ob,name,material,parent)
def rod(name,a,b,r,material,parent=None):
    a,b=v(a),v(b);dv=b-a
    bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=r,depth=dv.length,location=(a+b)/2)
    ob=bpy.context.object;ob.rotation_euler=dv.to_track_quat('Z','Y').to_euler()
    return finish(ob,name,material,parent)
def hoop(name,c,r,t,material,parent):
    bpy.ops.mesh.primitive_torus_add(major_segments=64,minor_segments=8,location=v(c),major_radius=r,minor_radius=t,rotation=(math.pi/2,0,0))
    return finish(bpy.context.object,name,material,parent)
for side,label in [(-1,'port'),(1,'starboard')]:
    x=side*13.5;y=2;z=3
    root=bpy.data.objects.new('Paddle_'+label+'_rotor',None);bpy.context.collection.objects.link(root);root.location=v((x,y,z));bpy.context.view_layer.update()
    rod('Oak axle',(side*10.5,y,z),(side*15.35,y,z),.24,wood,root)
    rod('Bronze hub boss',(x+side*1.08,y,z),(x+side*1.32,y,z),.52,wood,root)
    rod('Bronze hub face',(x+side*1.32,y,z),(x+side*1.345,y,z),.51,bronze,root)
    rod('Lacquer hub rosette',(x+side*1.32,y,z),(x+side*1.37,y,z),.34,red,root)
    rod('Sun boss',(x+side*1.37,y,z),(x+side*1.43,y,z),.17,bronze,root)
    for i in range(12):
        t=i*math.tau/12
        rod('Sun ray',(x+side*1.39,y+.22*math.cos(t),z+.22*math.sin(t)),(x+side*1.39,y+.43*math.cos(t+.10),z+.43*math.sin(t+.10)),.035,bronze,root)
    for i in range(8):
        t=i*math.tau/8
        rod('Hub rivet',(x+side*1.36,y+.40*math.cos(t),z+.40*math.sin(t)),(x+side*1.40,y+.40*math.cos(t),z+.40*math.sin(t)),.045,bronze,root)
    for dx in [-1.08,1.08]:
        # Twelve pegged timber felloe segments read as carpenter-built machinery.
        for j in range(12):
            a=j*math.tau/12;b=(j+1)*math.tau/12
            rod('Segmented oak felloe',(x+dx,y+3.24*math.cos(a),z+3.24*math.sin(a)),(x+dx,y+3.24*math.cos(b),z+3.24*math.sin(b)),.17,wood,root)
            rod('Felloe wooden peg',(x+dx-.21,y+3.24*math.cos(a),z+3.24*math.sin(a)),(x+dx+.21,y+3.24*math.cos(a),z+3.24*math.sin(a)),.055,blade,root)
        for i in range(12):
            t=i*math.tau/12;c=math.cos(t);s=math.sin(t)
            rod('Braced oak spoke',(x+dx,y+.32*c,z+.32*s),(x+dx,y+3.45*c,z+3.45*s),.105,wood,root)
            rod('Hub pin',(x+dx-.07,y+.5*c,z+.5*s),(x+dx+.07,y+.5*c,z+.5*s),.045,bronze,root)
            # Three turns of hemp around the radial spoke/felloe joint.
            for rr in [2.93,3.02,3.11]:
                pts=[(x+dx-.15,y+(rr-.055)*c,z+(rr-.055)*s),(x+dx+.15,y+(rr-.055)*c,z+(rr-.055)*s),(x+dx+.15,y+(rr+.055)*c,z+(rr+.055)*s),(x+dx-.15,y+(rr+.055)*c,z+(rr+.055)*s)]
                for k in range(4):rod('Hemp joint lashing',pts[k],pts[(k+1)%4],.026,rope,root)
    for i in range(12):
        t=i*math.tau/12
        # Raw board X=width, Y=radial; physical and rendered boards use identical radius/span.
        for plank in range(3):
            box('Radial oak paddle',(x+(plank-1)*.8,y+3.6*math.cos(t),z+3.6*math.sin(t)),(.79,.75,.10),blade,root,t)
        for dx in [-.94,.94]:
            box('Hemp paddle binding',(x+dx,y+3.6*math.cos(t),z+3.6*math.sin(t)),(.075,.76,.125),rope,root,t)
    # Open supports keep the wheel visible and allow its complete swept volume.
    for zz in [-1.6,7.6]:
        box('Wheel gallery cantilever',(side*12.8,5.65,zz),(5,.32,.32),wood)
        rod('Diagonal hull brace',(side*10.6,1.1,zz),(side*15.1,5.5,zz),.15,wood)
        rod('Axle bearing A frame',(side*15.05,2,z),(side*15.05,5.65,zz),.16,wood)
        rod('Gallery handrail',(side*15.15,6.65,zz),(side*10.6,6.65,zz),.07,wood)
        for xx in [10.8,12.7,15.15]:rod('Rail stanchion',(side*xx,5.6,zz),(side*xx,6.65,zz),.065,wood)
    for zz in [-1.6,7.6]:
        for xx in [11.0,13.0,15.0]:
            for yy in [5.52,5.66]:rod('Bronze beam fastening',(side*xx,yy,zz-.19),(side*xx,yy,zz+.19),.026,bronze)
    rod('Long gallery rail',(side*15.15,6.65,-1.6),(side*15.15,6.65,7.6),.07,wood)
    # Small guards above the rim, not an opaque steamboat paddle box.
    for zz in [-1.6,7.6]:box('Oxblood gallery fascia',(side*13,5.9,zz),(4.5,.22,.12),red)
    for zz in [1,5]:
        rod('Bearing support',(side*15.05,2,3),(side*15.05,5.65,zz),.13,wood)
    # Exterior gear chest and shaft from working deck down to the wheel axle.
    for xx in [10.44,11.36]:box('Transmission chest side',(side*xx,4.5,3),(.08,2.0,2.8),red)
    for zz in [1.64,4.36]:box('Transmission chest end',(side*10.9,4.5,zz),(1.0,2.0,.08),red)
    box('Transmission chest lid',(side*10.9,5.5,3),(1.0,.10,2.8),wood)
    rod('Deck drive shaft',(side*10.9,4.4,3),(side*10.9,6.1,3),.16,wood)
    probe=bpy.data.objects.new('Paddle_'+label+'_blade_probe',None);bpy.context.collection.objects.link(probe)
    probe.location=v((x,y+3.6,z));probe.parent=root;probe.matrix_parent_inverse=root.matrix_world.inverted()
# Record exact physical geometry inside the reusable asset.
bpy.context.scene['physical_geometry']=json.dumps({'radius':3.6,'bladeWidth':2.4,'bladeHeight':.75,'blades':12,'axles':[[-13.5,2,3],[13.5,2,3]],'gameFrame':'(-BlenderY, BlenderZ, -BlenderX)'})
out=ROOT/'browser/assets/thalassa-twin-paddles.glb'
# First-order solid material budget; overlaps/joinery are not a structural survey.
import bmesh
volumes={}
for ob in bpy.context.scene.objects:
    if ob.type!='MESH':continue
    bm=bmesh.new();bm.from_mesh(ob.data);bm.transform(ob.matrix_world)
    vol=abs(bm.calc_volume(signed=True));bm.free()
    material=ob.data.materials[0].name
    volumes[material]=volumes.get(material,0)+vol
(ROOT/'propulsion/results/paddle-materials.json').write_text(json.dumps(volumes,indent=2))
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'blender/thalassa-twin-paddles.blend'))
# Export a handful of draw batches per assembly, preserving rotor pivots and probes.
for parent in [None]+[o for o in bpy.context.scene.objects if o.name.endswith('_rotor')]:
    groups={}
    for ob in list(bpy.context.scene.objects):
        if ob.type=='MESH' and ob.parent==parent:groups.setdefault(ob.data.materials[0].name,[]).append(ob)
    for material,objects in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for ob in objects:ob.select_set(True)
        bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.join();objects[0].name=('Static' if parent is None else parent.name)+'_'+material.replace(' | ','_')
bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',export_yup=True,export_extras=True)
print('PADDLE_EXPORT',out.stat().st_size,flush=True)
