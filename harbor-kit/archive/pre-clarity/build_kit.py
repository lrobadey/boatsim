"""Build the reusable Ormos asset library, not an assembled harbor.

Blender -b --factory-startup -P harbor-kit/blender/build_kit.py [-- --only id]
Then: node harbor-kit/tools/pack.mjs
Every recipe owns its seed. Assets are native Z-up while authored; export
converts to metre-scale Y-up with asset front / sea-facing direction -Z.
"""
import bpy, math, json, hashlib, sys
from pathlib import Path
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import authoring as a
for material in a.mats.values():
    material.use_backface_culling=material.name not in ('cloth','leaf','olive_leaf','tile')

ROOT = HERE.parent
RAW = ROOT / 'build' / 'raw'
RAW.mkdir(parents=True, exist_ok=True)
entries = []
definitions = []

def register(id, family, recipe, *, anchors=None, collision=None, footprint=None,
             origin='ground centre', front=True, description='', tags=None, lod=False):
    definitions.append(dict(id=id, family=family, recipe=recipe, anchors=anchors or [],
                            collision=collision or [], footprint=footprint, origin=origin,
                            front=front, description=description, tags=tags or [], lod=lod))

def anchor(name, p, normal=None, kind='placement'):
    out={'name':name,'position':list(p),'kind':kind}
    if normal is not None: out['normal']=list(normal)
    return out

def solid(center,size,walk=False,material='stone',name='body'):
    return {'type':'box','name':name,'center':list(center),'size':list(size),
            'walkableTop':walk,'surface':material}

def quay(variant=0,corner=False):
    depth=6 if corner else 4
    a.box((0,depth/2,-2.14),(6,depth,4.12),'limestone',.02,color=(.72,.73,.66))
    a.masonry(0,.05,-4.2,6,4.04,.42,course=.46)
    if corner:a.masonry(-2.79,depth/2,-4.2,depth,4.04,.42,math.pi/2,course=.46)
    for row in range(math.ceil(depth/1.0)):
        for col in range(4):
            a.box((-2.25+col*1.5,.5+row,-.105),(1.477,.977,.19),'paving',.025)
    for i in range(4):a.box((-2.25+i*1.5,.25,-.13),(1.475,.92,.26),'paving',.045)
    if variant!=2:
        a.box((0,-.22,-.76),(5.92,.17,.24),'wood',.026)
        for x in [-2,2]:a.box((x,-.23,-1.35),(.23,.24,1.8),'wood',.025)
    if variant==1:
        for x in [-1.25,1.25]:a.box((x,-.26,-1.14),(.48,.16,.16),'darkwood',.02)

for i in range(3):
    register(f'quay-straight-{chr(97+i)}','quay',lambda i=i:quay(i),
             anchors=[anchor('join-left',(-3,0,0),(-1,0,0),'snap'),anchor('join-right',(3,0,0),(1,0,0),'snap'),anchor('berth-face',(0,.05,0),(0,-1,0),'berth'),anchor('ground',(0,2,0))],
             collision=[solid((0,2,-2.1),(6,4,4.2),True)],footprint=[6,4],origin='front edge at walking height',
             description='Six-metre quay run. Front is the sea-facing -Z edge; top is Y=0.',tags=['modular','berth'])
register('quay-corner','quay',lambda:quay(0,True),
         anchors=[anchor('join-right',(3,0,0),(1,0,0),'snap'),anchor('join-back',(-3,6,0),(0,1,0),'snap')],
         collision=[solid((0,3,-2.1),(6,6,4.2),True)],footprint=[6,6],origin='front edge at walking height',description='Six-metre corner landing with two finished stone faces.')

def stairs():
    for i in range(10):
        top=-i*.23
        a.box((0,-i*.43,top-.25),(3,.46,.5),'paving',.035)
register('sea-stairs','quay',stairs,
         anchors=[anchor('upper-landing',(0,0,0),(0,1,0),'walk'),anchor('lower-landing',(0,-3.87,-2.07),(0,-1,0),'walk')],
         collision=[solid((0,-i*.43,-i*.23-.25),(3,.46,.5),True,name=f'tread-{i}') for i in range(10)],
         footprint=[3,4.3],origin='upper tread centre',description='Ten 230 mm risers and 430 mm treads; lower endpoint is 2.07 m below origin.')
register('retaining-wall','architecture',lambda:a.masonry(0,0,0,6,1.5,.6,course=.3),
         anchors=[anchor('join-left',(-3,0,0),(-1,0,0),'snap'),anchor('join-right',(3,0,0),(1,0,0),'snap')],
         collision=[solid((0,0,.75),(6,.6,1.5),True)],footprint=[6,.6],description='Six-metre limestone garden/terrace wall.')

def building_collision(w,d,h,door):
    return [solid((0,d/2,h/2),(w,.55,h),name='back-wall'),
            solid((-w/2,0,h/2),(.55,d,h),name='left-wall'),
            solid((w/2,0,h/2),(.55,d,h),name='right-wall'),
            solid((-(w+door)/4,-d/2,h/2),((w-door)/2,.55,h),name='front-left'),
            solid(((w+door)/4,-d/2,h/2),((w-door)/2,.55,h),name='front-right')]
for id,w,d,h,roof,door in [('warehouse',17,11,4.9,'tile',3.8),('house-courtyard',10,8,4.5,'flat',2.1),('house-workshop',7,8,3.7,'tile',2.1),('house-tower',6,7,7,'flat',2.1)]:
    register(id,'buildings',lambda id=id,w=w,d=d,h=h,roof=roof,door=door:a.building(id,0,0,0,w,d,h,roof=roof,door=door),
             anchors=[anchor('door',(0,-d/2,0),(0,-1,0),'entry'),anchor('roof',(0,0,h)),anchor('porch',(0,-d/2-1.9,0))],
             collision=building_collision(w,d,h,door)+[solid((0,0,-.10),(w,d,.20),True,name='floor')],
             footprint=[w,d],description='Authored shell, recesses, thresholds and roof. Footing extends below ground.',tags=['architecture','interior' if id=='warehouse' else 'shell'])

def canopy():
    for x in [-3,3]:
        a.box((x,-1.6,1.67),(.22,.24,3.34),'wood',.025)
        a.box((x,-1.6,.1),(.45,.46,.2),'limestone',.025)
        a.box((x,0,3.3),(.20,3.7,.20),'wood',.02)
        a.tube([(x,-1.6,2.55),(x+(-.7 if x>0 else .7),-1.6,3.25)],.07,'darkwood',6)
    a.box((0,-1.6,3.25),(6.3,.24,.28),'wood',.025)
    for panel in range(2):
        left=-3+panel*3
        def p(u,v):return (left+u*3,-1.8+v*3.6,3.43-.25*math.sin(u*math.pi)-.10*(1-v)+.025*math.sin(u*math.tau*4)*(1-v))
        for i in range(20):
            for j in range(12):a.mb('cloth').face([p(i/20,j/12),p((i+1)/20,j/12),p((i+1)/20,(j+1)/12),p(i/20,(j+1)/12)],(.89,.85,.73))
            p0,p1=p(i/20,0),p((i+1)/20,0)
            a.mb('cloth').face([p0,p1,(p1[0],p1[1],p1[2]-.16),(p0[0],p0[1],p0[2]-.16)],(.85,.80,.67))
        for u in [0,.5,1]:a.tube([p(u,j/12) for j in range(13)],.009,'rope',5)
register('linen-canopy','architecture',canopy,
         anchors=[anchor('wall-left',(-3,1.8,3.4),(0,1,0),'attach'),anchor('wall-right',(3,1.8,3.4),(0,1,0),'attach')],
         collision=[solid((x,-1.6,1.67),(.28,.30,3.34),material='wood',name=f'post-{x}') for x in [-3,3]],footprint=[6.3,3.8],description='Six-metre shaded loading porch. Two front posts; rear edge attaches to a facade.')

def mooring():
    a.lathe((0,0,0),[(0,.28),(.025,.31),(.075,.33),(.11,.32),(.18,.27),(.24,.25),(.62,.21),(.68,.24),(.75,.32),(.79,.34),(.86,.34),(.91,.31),(.94,.26)],'limestone',40)
register('mooring-stone','fixtures',mooring,anchors=[anchor('line',(0,0,.72),kind='mooring')],
         collision=[{'type':'cylinder','name':'body','center':[0,0,.47],'radius':.34,'height':.94,'surface':'stone','walkableTop':False}],footprint=[.68,.68],description='Mooring fixture with a named line attachment; not an inferred mooring force.')

def fender():
    for strand in range(9):
        pts=[]
        for j in range(37):
            t=j/36;ang=strand*math.tau/9+t*math.tau*1.4;r=.13+.055*math.sin(t*math.pi)
            pts.append((r*math.cos(ang),r*math.sin(ang),-1.2+t*1.04))
        a.tube(pts,.055,'rope',8,color=(.76,.70,.54))
    for z in [-1.03,-.34]:
        for turn in range(4):a.tube([(.225*math.cos(j*math.tau/32),.225*math.sin(j*math.tau/32),z+turn*.035) for j in range(33)],.02,'rope',8)
    a.tube([(0,0,-.12),(0,.12,0)],.028,'rope',8)
register('rope-fender','fixtures',fender,anchors=[anchor('hang',(0,.12,0),kind='attach'),anchor('contact',(0,-.25,-.65),(0,-1,0),'contact')],
         collision=[solid((0,0,-.68),(.5,.5,1.08),material='rope')],footprint=[.5,.5],origin='top suspension point',description='One plaited hanging rope fender; collider is a conservative contact proxy.')

def gangplank():
    for j in range(4):a.box((-.45+j*.30,0,-.065),(.28,3.6,.13),'wood',.02)
    for y in [-1.55,-.95,-.35,.25,.85,1.45]:a.box((0,y,.04),(1.23,.09,.08),'wood',.015)
    for y in [-1.6,1.6]:
        for x in [-.59,.59]:a.box((x,y,.52),(.075,.08,1.15),'wood',.015)
    for x in [-.59,.59]:a.tube([(x,-1.6,1.06),(x,0,1.0),(x,1.6,1.06)],.022,'rope',8)
register('gangplank','fixtures',gangplank,
         anchors=[anchor('ship-end',(0,-1.8,0),(0,-1,0),'contact'),anchor('land-end',(0,1.8,0),(0,1,0),'contact')],
         collision=[solid((0,0,-.065),(1.23,3.6,.13),True,'wood')],footprint=[1.23,3.6],origin='walking surface midpoint',description='Rigid 3.6 m plank; place between contact anchors without nonuniform stretching.')

for id,scale in [('amphora-large',1),('amphora-small',.72)]:
    register(id,'cargo',lambda scale=scale:a.jar(0,0,0,scale),collision=[{'type':'cylinder','name':'vessel','center':[0,0,.59*scale],'radius':.31*scale,'height':1.18*scale,'surface':'clay','walkableTop':False}],footprint=[.62*scale,.62*scale],description='Closed export with a recessed mouth, rounded handles and continuous pottery profile.')
register('wicker-basket','cargo',lambda:a.basket(0,0,0),collision=[{'type':'cylinder','name':'basket','center':[0,0,.295],'radius':.4,'height':.59,'surface':'wood','walkableTop':False}],footprint=[.8,.8],description='Woven storage basket with modeled uprights and rings.')
register('rope-coil','cargo',lambda:a.rope_coil(0,0,0,.40),footprint=[.85,.85],description='Four turns of laid rope; decorative, no collision needed.')

def rack():
    for x in [-1.5,1.5]:
        for y in [-.55,.55]:a.box((x,y,.58),(.12,.12,1.16),'darkwood',.014)
    for z in [.25,1.03]:
        for y in [-.55,.55]:a.box((0,y,z),(3.2,.13,.13),'wood',.012)
        for x in [-1.5,-1,-.5,0,.5,1,1.5]:a.box((x,0,z),(.12,1.25,.08),'wood',.012)
register('packing-rack','cargo',rack,anchors=[anchor('lower-shelf',(0,0,.29)),anchor('upper-shelf',(0,0,1.07))],collision=[solid((0,0,.58),(3.2,1.25,1.16),False,'wood')],footprint=[3.2,1.25],description='Empty packing rack; instantiate reusable cargo assets on its shelf anchors.')
def bench():
    for y in [-.137,.137]:a.box((0,y,.55),(1.6,.26,.16),'wood',.025)
    for x in [-.58,.58]:
        a.box((x,0,.27),(.15,.38,.54),'wood',.02)
        a.box((x,0,.43),(.27,.48,.13),'wood',.018)
        for y in [-.137,.137]:a.tube([(x,y,.62),(x,y,.636)],.025,'darkwood',10)
    a.box((0,0,.23),(1.16,.12,.14),'wood',.02)
register('timber-bench','props',bench,anchors=[anchor('seat',(0,0,.63))],collision=[solid((0,0,.315),(1.6,.52,.63),False,'wood')],footprint=[1.6,.52],description='Weathered timber bench.')
register('timber-beam','architecture',lambda:a.box((0,0,.12),(3,.24,.24),'wood',.018),anchors=[anchor('end-left',(-1.5,0,.12),(-1,0,0),'snap'),anchor('end-right',(1.5,0,.12),(1,0,0),'snap')],collision=[solid((0,0,.12),(3,.24,.24),True,'wood')],footprint=[3,.24],description='Three-metre structural timber with longitudinal grain.')

for id,sizes in [('rock-ledge-a',(4.2,3.1,2.2)),('rock-ledge-b',(3.6,2.7,3.1)),('rock-boulder',(1.1,.9,1.5)),('rock-rubble',(.45,.4,.55))]:
    sx,sy,sz=sizes
    register(id,'geology',lambda sx=sx,sy=sy,sz=sz:a.rock(0,0,sz*.25,sx,sy,sz),footprint=[2*sx,2*sy],
             description='Partly buried limestone with coherent fracture planes. Use simplified collision mesh.',lod=True,tags=['terrain-blend'])
for id,scale in [('olive-a',1),('olive-b',1.18)]:
    register(id,'vegetation',lambda scale=scale:a.tree(0,0,0,scale),collision=[{'type':'cylinder','name':'trunk','center':[0,0,1.4*scale],'radius':.35*scale,'height':2.8*scale,'surface':'wood','walkableTop':False}],footprint=[6*scale,6*scale],description='Rooted branching olive with narrow leaf geometry. Instance this asset; do not rebake each tree.',lod=True)

def shrub():
    for i in range(14):
        ang=i*math.tau/14;end=(math.cos(ang)*.35,math.sin(ang)*.35,.38+a.R.uniform(-.08,.10))
        a.tube([(0,0,0),(end[0]*.4,end[1]*.4,.26),end],.011,'darkwood',8)
        for j in range(55):
            px=end[0]+a.R.uniform(-.18,.18);py=end[1]+a.R.uniform(-.18,.18);pz=end[2]+a.R.uniform(-.12,.15)
            angle=a.R.random()*math.tau;length=a.R.uniform(.035,.065);width=length*.34;dx,dy=math.cos(angle),math.sin(angle)
            points=[(px-dx*length,py-dy*length,pz-.008),(px-dx*length*.3-dy*width,py-dy*length*.3+dx*width,pz),(px+dx*length*.4-dy*width,py+dy*length*.4+dx*width,pz+.004),(px+dx*length,py+dy*length,pz+.009),(px+dx*length*.4+dy*width,py+dy*length*.4-dx*width,pz+.004),(px-dx*length*.3+dy*width,py-dy*length*.3-dx*width,pz)]
            color=a.tint(.72,1.16)
            for k in range(6):a.mb('leaf').face([points[k],points[(k+1)%6],(px,py,pz+.01)],color)
register('coastal-shrub','vegetation',shrub,footprint=[1.2,1.2],description='Low coastal shrub for rock feet and soil transitions. Decorative only.',lod=True)

def boat_recipe():
    a.stage='boat'
    exec(compile((HERE/'recipes/cargo_boat.py').read_text(),str(HERE/'recipes/cargo_boat.py'),'exec'),a.__dict__)
register('cargo-boat','vessels',boat_recipe,
         anchors=[anchor('bow-line',(-6,-1.75,1.62),kind='mooring'),anchor('stern-line',(6,-1.75,1.62),kind='mooring'),anchor('gangplank',(3,-2.15,1.1),kind='contact'),anchor('mast',(-1,0,.95))],
         footprint=[17.6,5.6],origin='scenic waterline',front=False,description='The separate scenic boat the user liked. Forward is -X. Not a physics hull or drop-in playable ship.',tags=['scenic','preserve-silhouette'])

def transform_point(p,front):
    # Rotate native asset by pi about Z so original front -Y becomes glTF -Z.
    x,y,z=p
    return [-x,z,y] if front else [x,z,-y]

def collision_contract(item,front):
    item=dict(item);item['center']=transform_point(item['center'],front)
    if item['type']=='box':
        x,y,z=item['size'];item['size']=[x,z,y]
    return item

def export_objects(path,objects,root):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in [root,*objects]:ob.hide_set(False);ob.select_set(True)
    bpy.context.view_layer.objects.active=root
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
      export_yup=True,export_apply=True,export_animations=False,export_extras=True,
      export_materials='EXPORT',export_vertex_color='NAME',export_vertex_color_name='Tint',
      export_all_vertex_colors=False,export_image_format='JPEG',export_jpeg_quality=92)

only=None
if '--' in sys.argv:
    args=sys.argv[sys.argv.index('--')+1:]
    if '--only' in args:only=args[args.index('--only')+1]
    if '--list' in args:
        print('\n'.join(d['id'] for d in definitions));sys.exit(0)
if only and only not in [d['id'] for d in definitions]:raise ValueError('Unknown asset '+only)
for d in definitions:
    if only and d['id']!=only:continue
    id=d['id'];a.R.seed(int(hashlib.sha256(id.encode()).hexdigest()[:8],16));a.builders.clear();a.colliders.clear();a.floors.clear();a.sockets.clear();a.stage=id
    d['recipe']()
    coll=bpy.data.collections.new(id);bpy.context.scene.collection.children.link(coll)
    root=bpy.data.objects.new(id,None);coll.objects.link(root);root['assetId']=id;root['kitVersion']='1.0.0';root['units']='metres'
    meshes=[]
    for builder in a.builders.values():
        if not builder.f:continue
        ob=builder.build()
        for old in list(ob.users_collection):old.objects.unlink(ob)
        coll.objects.link(ob);ob.parent=root
        if d['front']:ob.data.transform(Matrix.Rotation(math.pi,4,'Z'))
        meshes.append(ob)
    for point in d['anchors']:
        name=point['name']
        if d['front']:name=name.replace('left','__swap__').replace('right','left').replace('__swap__','right')
        ob=bpy.data.objects.new('anchor_'+name,None);coll.objects.link(ob);ob.parent=root
        p=Vector(point['position']);p=Matrix.Rotation(math.pi,4,'Z')@p if d['front'] else p
        ob.location=p;ob.empty_display_type='ARROWS';ob.empty_display_size=.18;ob['kind']=point['kind'];ob['anchorName']=name;meshes.append(ob)
    points=[(v.co.x,v.co.z,-v.co.y) for ob in meshes if ob.type=='MESH' for v in ob.data.vertices]
    bounds={'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]}
    anchors=[]
    for point in d['anchors']:
        data={**point,'position':transform_point(point['position'],d['front'])}
        if d['front']:data['name']=data['name'].replace('left','__swap__').replace('right','left').replace('__swap__','right')
        if 'normal' in data:data['normal']=transform_point(data['normal'],d['front'])
        anchors.append(data)
    collision=[collision_contract(c,d['front']) for c in d['collision']]
    entry={'id':id,'family':d['family'],'description':d['description'],'tags':d['tags'],'source':{'blend':f'blender/sources/{id}.blend','collection':id,'recipe':'blender/build_kit.py'},
           'origin':d['origin'],'front':[0,0,-1] if d['front'] else [-1,0,0],
           'bounds':bounds,'footprint':d['footprint'],'anchors':anchors,'collision':collision,
           'lods':[{'level':0,'file':f'models/{id}.glb','distance':0}],
           'materials':sorted({m.name for ob in meshes if ob.type=='MESH' for m in ob.data.materials}),
           'triangles':sum(len(p.vertices)-2 for ob in meshes if ob.type=='MESH' for p in ob.data.polygons)}
    root['contract']=json.dumps({k:entry[k] for k in ['origin','front','anchors','collision']})
    export_objects(RAW/(id+'.glb'),meshes,root)
    if d['lod']:
        lod_objects=[]
        for ob in meshes:
            if ob.type!='MESH':continue
            copy=ob.copy();copy.data=ob.data.copy();coll.objects.link(copy);copy.parent=root;copy.name=ob.name+'_lod1'
            mod=copy.modifiers.new('Distance simplification','DECIMATE');mod.ratio=.32 if d['family']=='geology' else .46
            lod_objects.append(copy)
        export_objects(RAW/(id+'-lod1.glb'),lod_objects,root)
        entry['lods'].append({'level':1,'file':f'models/{id}-lod1.glb','distance':35 if d['family']=='geology' else 50})
        for ob in lod_objects:bpy.data.objects.remove(ob,do_unlink=True)
    if d['family']=='geology':
        # Collision is an explicit low-poly mesh, never render-triangle soup.
        collision_objects=[]
        for ob in meshes:
            if ob.type!='MESH':continue
            copy=ob.copy();copy.data=ob.data.copy();coll.objects.link(copy);copy.parent=root;copy.name='collision_'+id
            mod=copy.modifiers.new('Collision proxy','DECIMATE');mod.ratio=min(1,100/max(1,len(copy.data.polygons)))
            copy.data.materials.clear();collision_objects.append(copy)
        export_objects(RAW/(id+'-collision.glb'),collision_objects,root)
        entry['collision'].append({'type':'mesh','name':'rock-proxy','file':f'models/{id}-collision.glb','surface':'stone','walkableTop':True})
        for ob in collision_objects:bpy.data.objects.remove(ob,do_unlink=True)
    entries.append(entry)
    for ob in [root,*meshes]:ob.hide_set(True);ob.select_set(False)
    print('KIT_ASSET',id,entry['triangles'],flush=True)

manifest_path=ROOT/'assets'/'manifest.json'
if only and manifest_path.exists():
    old=json.loads(manifest_path.read_text());entries=[e for e in old['assets'] if e['id']!=only]+entries
manifest={'schemaVersion':1,'kit':'ormos','version':'1.0.0','units':'metres','up':[0,1,0],
          'frontConvention':'-Z except explicitly declared vessel axes','assetRoot':'./','materialPolicy':'preserve-glTF-PBR',
          'provenance':'Original local procedural authoring; no third-party model or texture downloads.',
          'assets':sorted(entries,key=lambda e:e['id'])}
manifest_path.parent.mkdir(parents=True,exist_ok=True);manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
# For partial builds, per-asset .blend libraries preserve authoritative edited
# collections. A full build additionally assembles the browsable master.
for entry in entries:
    coll=bpy.data.collections.get(entry['id'])
    if coll:
        path=HERE/'sources'/(entry['id']+'.blend');path.parent.mkdir(exist_ok=True)
        bpy.data.libraries.write(str(path),{coll},fake_user=True)
if not only:
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'harbor-kit.blend'))
print('KIT_BUILD_COMPLETE',len(entries),flush=True)
