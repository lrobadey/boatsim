"""Editable harbor study, authored in metres. Run with Blender --background -P this_file.
Native Blender coordinates: Z up, +Y inland. GLB is Y up, -Z inland.
Textures are seeded, seamless PBR surfaces; all construction joints are geometry.
"""
import bpy, bmesh, math, random, json, os, struct, zlib, shutil
import numpy as np
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'assets'; ASSETS.mkdir(exist_ok=True)
RAW=ROOT/'build/raw';RAW.mkdir(parents=True,exist_ok=True)
KIT=ROOT.parent/'harbor-kit'
kit_instances=[]
TEX=ROOT/'blender/textures'; TEX.mkdir(exist_ok=True)
R=random.Random(2741)
bpy.ops.wm.read_factory_settings(use_empty=True)

# Seamless multiscale surface fields. Values are authored in sRGB for color maps.
N=1024
rng=np.random.default_rng(813)
def noise(nx,ny=None):
    ny=ny or nx
    a=rng.random((ny,nx)).astype(np.float32)
    xx=np.arange(N)*nx/N; yy=np.arange(N)*ny/N
    xi=xx.astype(int); yi=yy.astype(int); u=xx-xi; v=yy-yi
    u=u*u*(3-2*u);v=v*v*(3-2*v)
    return ((a[yi[:,None]%ny,xi[None,:]%nx]*(1-u)+a[yi[:,None]%ny,(xi[None,:]+1)%nx]*u)*(1-v[:,None])+(a[(yi[:,None]+1)%ny,xi[None,:]%nx]*(1-u)+a[(yi[:,None]+1)%ny,(xi[None,:]+1)%nx]*u)*v[:,None])
def save_img(name,a,linear=False):
    a=np.clip(a,0,1)
    if a.ndim==2:a=np.repeat(a[:,:,None],3,axis=2)
    raw=(a*255+.5).astype(np.uint8)
    # Write literal sRGB bytes; bpy image.save would encode linear float pixels again.
    def chunk(t,d):return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    data=b''.join(b'\0'+raw[y].tobytes() for y in range(N))
    path=TEX/(name+'.png')
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',N,N,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(data,6))+chunk(b'IEND',b''))
    im=bpy.data.images.load(str(path));im.colorspace_settings.name='Non-Color' if linear else 'sRGB'
    return im

textures={}
for kind,col in [('limestone',(0.70,0.65,0.53)),('paving',(0.69,0.64,0.53)),('plaster',(0.84,0.80,0.69)),('wood',(0.43,0.33,0.23)),('tile',(0.57,0.29,0.17)),('rope',(0.55,0.46,0.30)),('cloth',(0.77,0.72,0.59)),('earth',(0.60,0.56,0.43)),('rock',(0.59,0.57,0.47))]:
    low=noise(4);mid=noise(24);fine=noise(160);grain=rng.random((N,N))
    h=.35*low+.32*mid+.23*fine+.1*grain
    base=(h-.5)*.085
    rough=.80+.18*(mid-.5)
    if kind=='wood':
        longitudinal=noise(150,3); fibers=noise(360,7); warp=noise(12,2)
        yy,xx=np.mgrid[:N,:N]/N
        grainline=xx+ .017*np.sin(yy*math.tau*3)+.008*(warp-.5)
        knots=np.zeros_like(xx)
        for kx,ky in [(.23,.28),(.71,.76)]:
            dxk=np.minimum(abs(xx-kx),1-abs(xx-kx));dyk=np.minimum(abs(yy-ky),1-abs(yy-ky))
            field=np.exp(-(dxk/.06)**2-(dyk/.14)**2)
            grainline+=.024*field*np.sin(yy*math.tau*8);knots+=field
        growth=.5+.5*np.sin(grainline*math.tau*92)
        h=.30*longitudinal+.22*fibers+.24*growth+.14*grain-.10*knots
        base=(h-.5)*.105 + (low-.5)*.025-knots*.035
        rough=.73+.2*low
    if kind=='rope':
        yy,xx=np.mgrid[:N,:N]/N
        twist=(.5+.5*np.sin((xx*18+yy*5+noise(12)*.08)*math.tau))
        h=.62*twist+.25*fine+.13*grain;base=(h-.5)*.075
    if kind=='cloth':
        yy,xx=np.mgrid[:N,:N];weave=(np.sin(xx*math.pi/2)*np.sin(yy*math.pi/2))
        h=.4+weave*.14+.12*fine;base=(low-.5)*.022+(h-.5)*.018;rough=np.full_like(h,.92)
    if kind=='plaster':
        # Broad limewash/trowel variation, with separate fine aggregate relief.
        swept=noise(9,40)
        base=(low-.5)*.025+(swept-.5)*.010+(fine-.5)*.012
        h=.22*low+.28*swept+.32*fine+.18*grain
    if kind=='rock':
        yy,xx=np.mgrid[:N,:N]/N
        strata=np.sin((yy*13+noise(6)*.2)*math.tau)
        h+=strata*.025;base=(h-.5)*.11;rough=.85+.12*mid
    if kind in ('paving','limestone'):
        pits=np.maximum(0,.24-fine)*1.7
        h-=pits;base-=pits*.065
        yy,xx=np.mgrid[:N,:N]/N
        tool=np.maximum(0,np.sin((xx*91+yy*23+low*.6)*math.tau)-.82)
        h-=tool*.10
        base+=(low-.5)*.035
    if kind=='tile':
        base+=(low-.5)*.045
        h=.18*low+.32*fine+.5*grain
    color=np.clip(np.array(col)[None,None,:]+base[:,:,None],.015,1)
    strength=1.1 if kind in ('wood','rock') else .65
    dx=(np.roll(h,-1,axis=1)-np.roll(h,1,axis=1))*strength
    dy=(np.roll(h,-1,axis=0)-np.roll(h,1,axis=0))*strength
    normal=np.stack([-dx,-dy,np.ones_like(h)],axis=2);normal/=np.linalg.norm(normal,axis=2)[:,:,None]
    textures[kind]=(save_img(kind+'_color',color),save_img(kind+'_normal',normal*.5+.5,True),save_img(kind+'_rough',rough,True))

mats={}
def material(name,kind=None,color=(1,1,1),rough=.8,metal=0):
    m=bpy.data.materials.new(name);m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    if kind:
        c,n,r=textures[kind]
        for im,socket in [(c,'Base Color'),(r,'Roughness')]:
            t=m.node_tree.nodes.new('ShaderNodeTexImage');t.image=im;m.node_tree.links.new(t.outputs['Color'],bs.inputs[socket])
        t=m.node_tree.nodes.new('ShaderNodeTexImage');t.image=n;nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value={'wood':.32,'rock':.30,'limestone':.26,'paving':.22,'plaster':.16,'tile':.22,'rope':.45,'cloth':.30}.get(kind,.30);m.node_tree.links.new(t.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    m.diffuse_color=(*color,1);mats[name]=m;return m
for k in textures:material(k,k)
material('darkwood','wood');material('iron',color=(.09,.105,.09),rough=.7,metal=.7)
material('bronze',color=(.23,.18,.09),rough=.5,metal=.8)
material('shadow',color=(.048,.038,.027),rough=1)
material('leaf',color=(.17,.23,.095),rough=.94)
material('olive_leaf',color=(.30,.36,.20),rough=.94)
material('paint',color=(.105,.23,.22),rough=.83)
material('lichen',color=(.29,.30,.16),rough=1)
material('endgrain','wood',rough=.9)

for material in mats.values():material.use_backface_culling=material.name not in ('cloth','leaf','olive_leaf','tile')

builders={};stage='harbor';colliders=[];floors=[];sockets=[]
class Mesh:
    def __init__(self,name,mat):self.name=name;self.mat=mat;self.v=[];self.f=[];self.uv=[];self.colors=[]
    def face(self,pts,tint=(1,1,1),uv=None):
        if len(pts)<3:return
        first=len(self.v);self.v.extend(pts);self.f.append(tuple(range(first,first+len(pts))))
        if uv is None:
            n=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0]));axis=max(range(3),key=lambda a:abs(n[a]));axes=[a for a in range(3) if a!=axis]
            # A surface repeat spans two metres. No texture contains construction joints.
            uv=[(p[axes[0]]/2,p[axes[1]]/2) for p in pts]
        self.uv.extend(uv);self.colors.extend([(*tint,1)]*len(pts))
    def build(self):
        me=bpy.data.meshes.new(self.name);me.from_pydata(self.v,[],self.f);me.update()
        ob=bpy.data.objects.new(self.name,me);bpy.context.collection.objects.link(ob);me.materials.append(mats[self.mat])
        u=me.uv_layers.new(name='UVMap')
        for p in me.polygons:
            for li in p.loop_indices:u.data[li].uv=self.uv[me.loops[li].vertex_index]
        vc=me.color_attributes.new(name='Tint',type='FLOAT_COLOR',domain='POINT');vc.data.foreach_set('color',np.asarray(self.colors,dtype=np.float32).ravel())
        if self.mat in ('tile','rope','rock') or self.name.endswith('_hull_wood') or self.name.endswith('_bark_wood') or self.name.startswith('mooring-stone_'):
            bm=bmesh.new();bm.from_mesh(me);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001);bm.to_mesh(me);bm.free()
            for p in me.polygons:p.use_smooth=True
            if self.mat=='rock':me.set_sharp_from_angle(angle=.90)
            if self.name.startswith('mooring-stone_'):me.set_sharp_from_angle(angle=.55)
            if self.name.endswith('_hull_wood'):me.set_sharp_from_angle(angle=.65)
        ob['part']=self.name;return ob

def mb(mat,group=None):
    key=(stage,group or mat,mat)
    if key not in builders:builders[key]=Mesh('_'.join(key),mat)
    return builders[key]
def tint(a=.975,b=1.025):
    v=R.uniform(a,b);return (v,v*R.uniform(.98,1.02),v*R.uniform(.97,1.015))
def box(c,d,mat='limestone',bevel=0,rot=0,color=None,group=None):
    color=color or tint();b=mb(mat,group);h=[q/2 for q in d];bevel=min(bevel,min(h)*.5)
    # Continuous local deformation keeps bevel faces welded in shape while
    # breaking the identical machine-cut silhouette of each masonry unit.
    seed=sum(c[i]*(13.7,7.3,19.1)[i] for i in range(3))
    def tr(p):
        p=list(p)
        if mat in ('limestone','paving') and max(d)<6 and min(d)>.09:
            amount=min(.008,min(d)*.025)
            p=[q+amount*math.sin(seed+i*2.4+p[(i+1)%3]*5.8+p[(i+2)%3]*3.1) for i,q in enumerate(p)]
        return (c[0]+p[0]*math.cos(rot)-p[1]*math.sin(rot),c[1]+p[0]*math.sin(rot)+p[1]*math.cos(rot),c[2]+p[2])
    def emit(pts):
        uv=None
        if mat in ('wood','darkwood'):
            longest=max(range(3),key=lambda a:d[a])
            n=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0]));dom=max(range(3),key=lambda a:abs(n[a]))
            other=next(a for a in range(3) if a!=longest and a!=dom) if dom!=longest else (longest+1)%3
            uv=[(p[other]/.65,p[longest]/3.0) for p in pts]
        b.face([tr(p) for p in pts],color,uv)
    if bevel<=0:
        for ax in range(3):
            oth=[i for i in range(3) if i!=ax]
            for s in [-1,1]:
                pts=[]
                for a,z in [(-1,-1),(1,-1),(1,1),(-1,1)]:
                    p=[0,0,0];p[ax]=s*h[ax];p[oth[0]]=a*h[oth[0]];p[oth[1]]=z*h[oth[1]];pts.append(p)
                n=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0]));
                if n[ax]*s<0:pts.reverse()
                emit(pts)
    else:
        def v(ax,sg):return [sg[i]*(h[i] if i==ax else h[i]-bevel) for i in range(3)]
        def face(pts):
            normal=(Vector(pts[1])-Vector(pts[0])).cross(Vector(pts[2])-Vector(pts[0]));cent=sum((Vector(p) for p in pts),Vector())/len(pts)
            if normal.dot(cent)<0:pts.reverse()
            emit(pts)
        for ax in range(3):
            oth=[i for i in range(3) if i!=ax]
            for s in [-1,1]:
                ps=[]
                for a,z in [(-1,-1),(1,-1),(1,1),(-1,1)]:
                    sg=[0,0,0];sg[ax]=s;sg[oth[0]]=a;sg[oth[1]]=z;ps.append(v(ax,sg))
                face(ps)
        for a,z in [(0,1),(1,2),(0,2)]:
            other=3-a-z
            for sa in [-1,1]:
                for sz in [-1,1]:
                    p=[0,0,0];p[a]=sa;p[z]=sz;p[other]=-1;q=p.copy();q[other]=1
                    face([v(a,p),v(z,p),v(z,q),v(a,q)])
        for sx in [-1,1]:
            for sy in [-1,1]:
                for sz in [-1,1]:face([v(a,[sx,sy,sz]) for a in range(3)])

def tube(points,r,mat='rope',sides=7,color=None):
    b=mb(mat);color=color or tint(); rings=[];lengths=[0];previous_u=None
    for i,p in enumerate(points):
        p=Vector(p);d=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        if d.length<1e-6:d=Vector((0,0,1))
        d.normalize()
        # Parallel-transport the frame through bends: no cross-product sign flip.
        u=previous_u-d*previous_u.dot(d) if previous_u is not None else d.cross(Vector((0,0,1)))
        if u.length<.1:u=d.cross(Vector((1,0,0)))
        u.normalize();previous_u=u.copy();v=d.cross(u)
        rings.append([p+r*(math.cos(j*math.tau/sides)*u+math.sin(j*math.tau/sides)*v) for j in range(sides)])
        if i:lengths.append(lengths[-1]+(p-Vector(points[i-1])).length)
    for i in range(len(rings)-1):
        for j in range(sides):
            k=(j+1)%sides;b.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],color,[(j/sides,lengths[i]),((j+1)/sides,lengths[i]),((j+1)/sides,lengths[i+1]),(j/sides,lengths[i+1])])
    b.face(list(reversed(rings[0])),color);b.face(rings[-1],color)
def lathe(c,profile,mat='tile',sides=48,color=None):
    b=mb(mat);color=color or tint();rings=[]
    for z,r in profile:rings.append([(c[0]+r*math.cos(j*math.tau/sides),c[1]+r*math.sin(j*math.tau/sides),c[2]+z) for j in range(sides)])
    for i in range(len(rings)-1):
        for j in range(sides):
            k=(j+1)%sides;b.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],color,[(j/sides,profile[i][0]),((j+1)/sides,profile[i][0]),((j+1)/sides,profile[i+1][0]),(j/sides,profile[i+1][0])])
    b.face(list(reversed(rings[0])),color);b.face(rings[-1],color)
def jar(x,y,z,s=1):
    profile=[(0,.07),(.10,.13),(.30,.23),(.64,.27),(.83,.18),(.93,.10),(1.10,.095),(1.13,.13),(1.18,.13),(1.18,.075),(1.08,.075)]
    # Interpolate the vessel profile with a bounded Catmull-Rom curve.
    smooth=[]
    for i in range(len(profile)-1):
        p0=Vector(profile[max(0,i-1)]);p1=Vector(profile[i]);p2=Vector(profile[i+1]);p3=Vector(profile[min(len(profile)-1,i+2)])
        for j in range(4):
            t=j/4;p=.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)
            smooth.append((p.x*s,max(.04,p.y)*s))
    smooth.append((profile[-1][0]*s,profile[-1][1]*s))
    lathe((x,y,z),smooth,color=tint(.93,1.03))
    for sign in [-1,1]:
        points=[]
        for j in range(19):
            t=j/18
            points.append((x+sign*(.085+.19*math.sin(math.pi*t)**.8)*s,y,z+(1.08-.35*t)*s))
        tube(points,.032*s,'tile',10)
def rope_coil(x,y,z,r=.3):
    points=[]
    for i in range(180):
        t=i/179*math.tau*4;rad=r*(.35+.65*i/179);points.append((x+rad*math.cos(t),y+rad*math.sin(t),z+.02+i/179*.024))
    tube(points,.022,'rope',6)
def masonry(x,y,z,w,h,depth=.6,angle=0,mat='limestone',course=.48):
    for row in range(math.ceil(h/course)):
        rh=min(course,h-row*course);pos=-w/2;target=w/2
        while pos<target-.01:
            width=min(R.uniform(.85,1.75),target-pos)
            if width<.05:break
            xx=(pos+width/2)*math.cos(angle);yy=(pos+width/2)*math.sin(angle)
            color=tint(.93,1.035)
            center=z+row*course+rh/2
            if center<.7:
                damp=.82+.13*max(0,center)/.7;color=(color[0]*damp*.96,color[1]*damp,color[2]*damp*.96)
            box((x+xx,y+yy,center),(width-.022,depth,rh-.024),mat,.023,angle,color=color)
            pos+=width

def smooth(a,b,v):
    t=max(0,min(1,(v-a)/(b-a)));return t*t*(3-2*t)
def shore_y(x):
    return 5+6*math.sin(x*.035)-20*math.exp(-((x+47)/19)**2)-17*math.exp(-((x-55)/20)**2)
def hterrain(x,y):
    # Broad shoulders meet a submerged apron without a vertical grid-shaped coast.
    shore=shore_y(x);inland=max(0,y-12)
    h=1.8+inland*.082+1.6*math.sin(x*.031+y*.021)**2
    h+=7*math.exp(-((x+66)/33)**2-((y-35)/39)**2)+10*math.exp(-((x-68)/35)**2-((y-57)/40)**2)
    h+=.20*math.sin(x*.12+y*.10)*math.sin(y*.11-x*.07)
    land=smooth(shore-4,shore+9,y)
    h=(-1.8+(y-shore)*.10)*(1-land)+h*land
    if -33<x<34 and y<18 and y>=shore:h=1.84
    if -27<x<27 and 17<=y<35:h=2.10
    if -23<x<25 and 35<=y<52:h=4.5
    # The upper lane climbs continuously beyond the built terrace.
    if -23<x<25 and 52<=y<68:h=4.5+(h-4.5)*smooth(52,68,y)
    deep=smooth(8,20,shore-y)
    h=h*(1-deep)-35*deep
    edge=max(smooth(98,125,abs(x)),smooth(176,205,y))
    return h*(1-edge)-35*edge
def rendered_ground(x,y):
    # Exact barycentric height on the exported two-metre terrain triangles.
    gx=-125+math.floor((x+125)/2)*2;gy=-45+math.floor((y+45)/2)*2;a=(x-gx)/2;b=(y-gy)/2
    h00=hterrain(gx,gy);h10=hterrain(gx+2,gy);h01=hterrain(gx,gy+2);h11=hterrain(gx+2,gy+2)
    return h00+a*(h10-h00 if a>=b else h11-h01)+b*(h11-h10 if a>=b else h01-h00)
UPPER_PATH=[(0,52),(-1,58),(-6,63),(-13,67),(-12,72)]
def route_distance(x,y):
    best=999
    for (ax,ay),(bx,by) in zip(UPPER_PATH,UPPER_PATH[1:]):
        vx,vy=bx-ax,by-ay;t=max(0,min(1,((x-ax)*vx+(y-ay)*vy)/(vx*vx+vy*vy)))
        best=min(best,math.hypot(x-ax-vx*t,y-ay-vy*t))
    return best
def ground_tint(x,y):
    # Continuous vertex color fields: pale paths, dry cultivated soil, sage shoulders.
    tone=.98+.018*math.sin(x*.08+y*.06)+.016*math.sin(x*.031-y*.045)
    col=np.array([tone*.86,tone*.90,tone*.85])
    grove=math.exp(-((x+21)/23)**2-((y-98)/34)**2)+math.exp(-((x-32)/22)**2-((y-77)/26)**2)
    col=col*(1-min(.14,grove*.12))
    path=(1-smooth(1.15,2.6,route_distance(x,y)))*smooth(50,54,y)
    col=col*(1-path)+np.array([1.0,.985,.95])*path
    shore=(1-smooth(2,11,abs(y-shore_y(x))))*(1-smooth(80,120,abs(x)))
    col=col*(1-shore*.25)+np.array([.98,.96,.91])*shore*.25
    return tuple(col)
b=mb('earth','land');grid=125;span=250
for iy in range(grid):
    y=-45+iy*span/grid
    for ix in range(grid):
        x=-125+ix*span/grid;pts=[(x,y,hterrain(x,y)),(x+2,y,hterrain(x+2,y)),(x+2,y+2,hterrain(x+2,y+2)),(x,y+2,hterrain(x,y+2))]
        for triangle in [[pts[0],pts[1],pts[2]],[pts[0],pts[2],pts[3]]]:
            b.face(triangle,(1,1,1),[(p[0]/9,p[1]/9) for p in triangle])
            b.colors[-3:]=[(*ground_tint(p[0],p[1]),1) for p in triangle]
# Quay core, stone courses and individually laid paving.
box((0,7,-.25),(58,14,4.1),'limestone',.08,color=(.7,.72,.66))
masonry(0,-.10,-2.2,58,4.14,.65,course=.46)
for side in [-1,1]:masonry(side*28.8,7,-2.2,14,4.14,.65,math.pi/2,course=.46)
for row in range(10):
    y=.62+row*1.3;pos=-28.7
    while pos<28.6:
        w=min(R.uniform(1.25,2.25),28.8-pos)
        box((pos+w/2,y,1.93),(w-.025,1.27,.20),'paving',.035,color=tint(.93,1.1));pos+=w
for i in range(39):box((-28.5+i*1.5,-.26,2.025),(1.475,1.05,.32),'paving',.065,color=tint(.97,1.12))
floors.append({'x':0,'z':-6.5,'w':58,'d':14,'y':2.1})
# Short return mole: a clear edge, lower landing and end.
box((26.1,-13,-.4),(5.8,26,4.6),'limestone',.06)
for side in [-1,1]:masonry(26.1+side*2.8,-13,-2.6,26,4.55,.6,math.pi/2)
for j in range(19):
    for i in range(4):box((24+i*1.4,-.5-j*1.4,1.96),(1.37,1.37,.22),'paving',.04)
    for xx in [23.17,29.03]:box((xx,-.5-j*1.4,2.03),(.8,1.37,.3),'paving',.06)
masonry(26.1,-26.1,-2.6,5.8,4.5,.6)
floors.append({'x':26.1,'z':13,'w':5.8,'d':26,'y':2.1})
# Wide sea stairs on western quay; explicit, comfortable worn treads.
for k in range(10):
    top=2.0-k*.23;box((-26.2,-.5-k*.43,top-.28),(3.25,.48,.56),'paving',.045)
floors.extend({'x':-26.2,'z':.5+k*.43,'w':3.25,'d':.5,'y':2-k*.23} for k in range(10))
# Mooring stones, timber rubbing strips and rope fenders.
for x in [-21,-9,-3,4,17]:
    lathe((x,.55,2.15),[(0,.28),(.1,.33),(.20,.26),(.64,.20),(.76,.34),(.88,.34),(.94,.26)],'limestone',12)
    sockets.append({'name':'mooring','position':[x,2.86,-.55]})
    rope_coil(x+.7,.8,2.1,.35)
for x in range(-23,23,4):
    box((x,-.54,.65),(.27,.28,2.2),'wood',.045,color=(.85,.90,.89))
    # A plaited rope bundle with wrapped lashings at two stations.
    for strand in range(9):
        points=[]
        for j in range(37):
            t=j/36;a=strand*math.tau/9+t*math.tau*1.4;r=.13+.055*math.sin(t*math.pi)
            points.append((x+r*math.cos(a),-.84+r*math.sin(a),.22+t*1.04))
        tube(points,.055,'rope',8,color=tint(.66,.92))
    for z in [.39,1.08]:
        for turn in range(4):tube([(x+.225*math.cos(j*math.tau/32),-.84+.225*math.sin(j*math.tau/32),z+turn*.035) for j in range(33)],.020,'rope',8)
    tube([(x,-.78,1.25),(x,-.55,1.90),(x,.1,2.16)],.025)
# Timber wale sits independently of the stone courses.
for x in range(-27,26,6):box((x+2.8,-.56,1.37),(5.55,.18,.22),'wood',.035)

# Building walls are assembled around real recesses, never dark rectangles pasted on a solid wall.
def building(name,x,y,z,w,d,h,roof='tile',tone=(1,1,1),door=2.1,porch=False):
    # Ground-level stone footing and front wall with central opening.
    masonry(x,y-d/2,z-.28,w,.65,.52,course=.34)
    box((x,y+d/2,z+h/2),(w,.42,h),'plaster',.04,color=tone,group=name)
    for side in [-1,1]:box((x+side*(w/2-.2),y,z+h/2),(.42,d,h),'plaster',.05,color=tone,group=name)
    dw=door;dh=2.8 if name=='warehouse' else 2.2
    for side in [-1,1]:
        left,right=sorted([x+side*dw/2,x+side*w/2])
        wx=x+side*w*.32; wz=z+(h*.70 if name=='house-tower' else min(2.5,h*.61))
        for a,b in [(left,wx-.55),(wx+.55,right)]:
            if b>a:box(((a+b)/2,y-d/2,z+h/2),(b-a,.55,h),'plaster',0,color=tone,group=name)
        for low,high in [(z,wz-.66),(wz+.66,z+h)]:
            if high>low:box((wx,y-d/2,(low+high)/2),(1.1,.55,high-low),'plaster',0,color=tone,group=name)
    box((x,y-d/2,z+(h+dh)/2),(dw,.55,h-dh),'plaster',0,color=tone,group=name)
    if name!='warehouse':box((x,y-d/2+.6,z+dh/2),(dw,.12,dh),'shadow',group=name)
    else:
        # The loading doorway leads into a real lit volume with floor and racks.
        box((x,y,z-.04),(w-.8,d-.6,.16),'paving',.015)
        for xx in [x-5,x+5]:
            for yy in [y-2,y+2]:
                box((xx,yy,z+1.3),(.18,.18,2.6),'darkwood',.02)
            for zz in [.25,1.35,2.45]:
                box((xx,y,z+zz),(1.45,5,.12),'wood',.015)
                for yy in [-1.6,-.7,.2,1.1]:jar(xx,y+yy,z+zz+.08,.83)
        for xx in [x-5,x,x+5]:
            tube([(xx,y-d/2,z+h-.25),(xx,y+d/2,z+h-.25)],.14,'darkwood',8)
        for yy in [y-3,y,y+3]:
            box((x,yy,z+.12),(3.2,.8,.15),'wood',.02)
            for xx in [-.9,0,.9]:jar(x+xx,yy,z+.22,.95)
    for side in [-1,1]:box((x+side*(dw/2+.08),y-d/2-.035,z+dh/2),(.18,.58,dh),'limestone',.035,group=name)
    box((x,y-d/2-.06,z+dh+.13),(dw+.6,.64,.28),'wood',.035,group=name)
    box((x,y-d/2-.22,z+.06),(dw+.6,.94,.18),'paving',.035,group=name)
    # Partially open thick timber leaves.
    for side in [-1,1]:
        cx=x+side*(dw/2-.12);cy=y-d/2+.22
        for k in range(4):box((cx+side*k*.14,cy+.1+k*.09,z+dh/2),(.16,.075,dh-.1),'wood',.018,rot=side*.45,group=name)
    # Deep projecting window frames, shutters and shadow returns on each wing.
    for side in [-1,1]:
        wx=x+side*w*.32;wy=y-d/2-.26;wz=z+(h*.70 if name=='house-tower' else min(2.5,h*.61))
        box((wx,wy+.72,wz),(1.1,.10,1.32),'shadow',.01,group=name)
        for sx in [-1,1]:box((wx+sx*.58,wy-.055,wz),(.14,.24,1.48),'wood',.025,group=name)
        for zz in [-.68,.68]:box((wx,wy-.06,wz+zz),(1.26,.3,.15),'wood',.02,group=name)
        for sx in [-1,1]:
            for k in range(3):box((wx+sx*(.73+k*.14),wy-.04,wz),(.135,.10,1.22),'paint' if name!='warehouse' else 'wood',.015,group=name)
        box((wx,wy-.12,wz-.77),(1.5,.55,.13),'paving',.025,group=name)
    # Limestone plinth returns and corner repairs give long side walls a scale.
    for side in [-1,1]:
        masonry(x+side*(w/2-.08),y,z-.22,d,.48,.32,angle=math.pi/2,course=.24)
        for level in range(3):
            box((x+side*(w/2-.19),y-d/2-.29,z+.52+level*.35),(.38 if level%2 else .64,.075,.30),'limestone',.025,color=tint(.95,1.025),group=name)
    if name=='house-tower':
        for side in [-1,1]:box((x,y+side*d/2,z+3.5),(w+.15,.18,.20),'wood',.02,group=name)
    if roof=='tile':
        ridge=z+h+1.55;edge=z+h+.10;over=.42
        b=mb('plaster',name)
        for yy in [y-d/2,y+d/2]:
            pts=[(x-w/2,yy,z+h),(x+w/2,yy,z+h),(x,yy,ridge)]
            if yy>y:pts.reverse()
            b.face(pts,tone)
        for side in [-1,1]:
            p=[(x,y-d/2-over,ridge),(x+side*(w/2+over),y-d/2-over,edge),(x+side*(w/2+over),y+d/2+over,edge),(x,y+d/2+over,ridge)]
            if side<0:p.reverse()
            mb('tile',name).face(p,(.75,.76,.75))
            # Rows of curved overlapping tiles, thin shell with a visible turned edge.
            cols=math.ceil((d+2*over)/.34);rows=math.ceil((w/2+over)/.50)
            for r in range(rows):
                xa=r*(w/2+over)/rows;xb=min(w/2+over,xa+(w/2+over)/rows+.08)
                for c in range(cols):
                    ya=y-d/2-over+c*(d+2*over)/cols;yb=ya+(d+2*over)/cols-.012
                    color=tint(.95,1.04)
                    for q in range(8):
                        ya0=ya+(yb-ya)*q/8;yb0=ya+(yb-ya)*(q+1)/8
                        za=math.sin(q/8*math.pi)*.065;zb=math.sin((q+1)/8*math.pi)*.065
                        # Raise the downhill overlap above the next tile: no coplanar strips.
                        zz=lambda a:ridge-(ridge-edge)*a/(w/2+over)+.028+.045*(a-xa)/(xb-xa)
                        pp=[(x+side*xa,ya0,zz(xa)+za),(x+side*xb,ya0,zz(xb)+za),(x+side*xb,yb0,zz(xb)+zb),(x+side*xa,yb0,zz(xa)+zb)]
                        if side<0:pp.reverse()
                        mb('tile',name).face(pp,color)
                    for q in range(8):
                        ya0=ya+(yb-ya)*q/8;yb0=ya+(yb-ya)*(q+1)/8
                        za=zz(xb)+math.sin(q/8*math.pi)*.065;zb=zz(xb)+math.sin((q+1)/8*math.pi)*.065
                        mb('tile',name).face([(x+side*xb,ya0,za),(x+side*xb,yb0,zb),(x+side*xb,yb0,zb-.022),(x+side*xb,ya0,za-.022)],color)

            # Eave timber has visible joints and end grain.
            box((x+side*(w/2+.12),y,edge-.12),(.19,d+.8,.22),'wood',.02,group=name)
        for yy in np.arange(y-d/2-.4,y+d/2+.4,.52):tube([(x,yy,ridge+.06),(x,yy+.5,ridge+.06)],.115,'tile',8)
    else:
        box((x,y,z+h),(w+.12,d+.12,.25),'plaster',.04,color=tone,group=name)
        for side in [-1,1]:
            box((x+side*(w/2-.1),y,z+h+.32),(.24,d,.6),'plaster',.05,color=tone,group=name)
            box((x,y+side*(d/2-.1),z+h+.32),(w,.24,.6),'plaster',.05,color=tone,group=name)
        for yy in [y-1,y+1]:jar(x+1,yy,z+h+.16,.7)
    colliders.append({'name':name,'door':dw,'doorHeight':dh,'x':x,'z':-y,'w':w,'d':d,'y0':z,'y1':z+h})
    return (x,y,z)

building('warehouse',-13,20,2.15,17,11,4.9,door=3.8,tone=(.99,.95,.86))
building('merchant_house',10,22,2.15,8.5,8,6.4,roof='flat',tone=(1.04,1.02,.96))
building('workshop',23,24,2.15,7,8,3.7,tone=(.94,.89,.77))
building('upper_house',-15,42,4.5,8,8,5.4,tone=(1,.94,.83))
building('courtyard_house',0,44,4.5,10,8,4.5,tone=(1.05,.99,.87))
building('tower_house',16,44,4.5,6,7,7.0,roof='flat',tone=(.95,.96,.91))
# Low garden courts and side lanes tie the buildings into a settlement.
for cx,cy,width,ang in [(-23,27,12,math.pi/2),(5.5,29,9,math.pi/2),(25.8,38,8,math.pi/2),(-9.5,36,8,0),(7.5,36,8,0)]:
    z=2.15 if cy<35 else 4.5
    masonry(cx,cy,z,width,.9,.48,ang,course=.30)
    for q in range(math.ceil(width/1.2)):
        along=-width/2+(q+.5)*width/math.ceil(width/1.2)
        box((cx+math.cos(ang)*along,cy+math.sin(ang)*along,z+.96),(width/math.ceil(width/1.2)-.02,.57,.16),'paving',.04,ang)
# A darker, projecting stone base returns around the waterfront facades.
for cx,cy,z,w,d in [(-13,20,2.15,17,11),(10,22,2.15,8.5,8),(23,24,2.15,7,8)]:
    for side in [-1,1]:masonry(cx+side*w/2,cy,z-.12,d,.62,.52,math.pi/2,course=.31)
# A little retaining garden and a built-in water trough.
masonry(18,13,2.10,4.6,.55,.48,course=.28)
box((19,11.8,2.35),(2.3,.9,.46),'limestone',.06)
box((19,11.8,2.59),(1.9,.55,.025),'shadow',.01,color=(.45,.52,.45))

# Front porch covers the loading court and creates deep, usable shade.
for x in [-22,-16,-10,-4]:
    box((x,11,3.80),(.22,.24,3.4),'wood',.03)
    box((x,13,5.47),(.18,4.5,.22),'wood',.025)
box((-13,10.9,5.40),(19,.26,.32),'wood',.025)
for section in range(6):
    xa=-22+section*3;xb=xa+3.05
    for a in range(12):
        u=a/12;v=(a+1)/12
        def awn(t,yy):return (xa+(xb-xa)*t,yy,5.55-.26*math.sin(t*math.pi)-.18*(14.7-yy)/4+.008*math.sin(t*math.pi*4)*(14.7-yy)/4)
        for row in range(10):
            ya=10.75+row*.395;yb=ya+.395
            mb('cloth').face([awn(u,ya),awn(v,ya),awn(v,yb),awn(u,yb)],(.88,.85,.74))
        hem=[awn(t,10.75) for t in [u,v]]
        mb('cloth').face([hem[0],hem[1],(hem[1][0],hem[1][1],hem[1][2]-.20),(hem[0][0],hem[0][1],hem[0][2]-.20)],(.84,.81,.70))
    for t in [0,.5,1]:tube([awn(t,10.75+q*.395) for q in range(11)],.009,'rope',5,color=(.76,.72,.61))
# Structural brackets and a loading bench.
for x in [-22,-16,-10,-4]:tube([(x,11,4.65),(x+.65,11,5.32)],.07,'wood',5)
# Visible mortise collars, pegs and grounded stone shoes.
for x in [-22,-16,-10,-4]:
    box((x,11,2.19),(.45,.46,.20),'limestone',.025)
    box((x,11,5.27),(.31,.33,.24),'darkwood',.015)
    for z in [4.90,5.31]:tube([(x,10.80,z),(x,11.20,z)],.029,'darkwood',10)
    tube([(x,11,4.62),(x,11.72,5.37)],.065,'darkwood',6)
box((-18,12.3,2.88),(5.8,1.1,.16),'wood',.02)
for x in [-20.4,-15.6]:box((x,12.3,2.51),(.18,.82,.8),'wood',.02)
for x,y in [(-20,12.3),(-19.4,12.3),(-18.8,12.3),(-15,13.5),(-14.4,13.5),(-13.8,13.5),(-8,12.5),(-7.5,12.8),(-6.9,12.5)]:jar(x,y,3 if x<-18 else 2.08,R.uniform(.70,1.0))
# Cargo storage frames and bundled timber.
for x in [-21,-17,-10]:
    for y in [7.7,8.3]:
        for k in range(3):jar(x+k*.52,y,2.15,.72)
    for yy in [7.4,8.7]:box((x+.52,yy,2.53),(1.8,.08,.14),'wood',.015)
for k in range(7):tube([(-5+k*.17,8,2.24),(-5+k*.17,11,2.24)],.07,'wood',7)
# A working packing corner: wicker hampers, lidded jars and a lashed rack.
def basket(x,y,z,r=.38,h=.55):
    lathe((x,y,z),[(0,r*.72),(.08,r*.80),(h,r),(h+.035,r*.99),(h+.035,r*.91),(.065,r*.67)],'rope',40,color=(.62,.55,.39))
    # Woven rim and handles retain an open, readable interior.
    for turn in range(3):
        tube([(x+(r-.007)*math.cos(j*math.tau/64),y+(r-.007)*math.sin(j*math.tau/64),z+h+.012+turn*.012) for j in range(65)],.013,'rope',6)
    for side in [-1,1]:
        tube([(x+side*(r-.025)+side*.055*math.sin(j*math.pi/16),y+.10*math.cos(j*math.pi/16),z+h-.06+.11*math.sin(j*math.pi/16)) for j in range(17)],.023,'rope',8)
    for level in range(15):
        height=h*level/14;radius=r*(.74+.26*level/14)+.009
        tube([(x+(radius+.008*math.sin(j*math.tau/48*20+level*math.pi))*math.cos(j*math.tau/48),y+(radius+.008*math.sin(j*math.tau/48*20+level*math.pi))*math.sin(j*math.tau/48),z+height) for j in range(49)],.012,'rope',5,color=(.80,.71,.51))
    for stave in range(20):
        a=stave*math.tau/20
        tube([(x+r*(.74+.26*t)*math.cos(a),y+r*(.74+.26*t)*math.sin(a),z+h*t) for t in [0,.25,.5,.75,1]],.014,'wood',5)
for x,y in [(-22.4,12),(-21.7,12.4),(-22.1,13),(-6,13.6)]:basket(x,y,2.12)
for xx in [-9,-6]:
    for yy in [9.4,10.5]:box((xx,yy,2.7),(.12,.12,1.16),'darkwood',.01)
for zz in [2.38,3.16]:
    for yy in [9.4,10.5]:box((-7.5,yy,zz),(3.2,.13,.13),'wood',.012)
    for xx in [-9,-8.5,-8,-7.5,-7,-6.5,-6]:box((xx,9.95,zz),(.12,1.25,.08),'wood',.012)
# Rolled linen and substantial rope coils keep the landing route clear.
for xx in [-8.6,-7.9,-7.2]:
    tube([(xx,9.55,3.38),(xx,10.4,3.38)],.17,'cloth',20,color=(.79,.73,.59))
    for yy in [9.72,10.18]:tube([(xx+.185*math.cos(t*math.tau/24),yy,3.38+.185*math.sin(t*math.tau/24)) for t in range(25)],.014,'rope',6)
rope_coil(-11.5,9,2.15,.55)
# A modest timber trellis connects dwelling and workshop into a shaded court.
for xx in [16.3,19.2]:
    for yy in [17.7,21.5]:
        box((xx,yy,3.55),(.16,.18,2.8),'darkwood',.018)
        box((xx,yy,2.23),(.32,.34,.22),'limestone',.025)
    box((xx,19.6,5.0),(.20,4.15,.20),'wood',.018)
for yy in [17.5+i*.34 for i in range(13)]:
    tube([(16.1,yy,5.13),(19.5,yy,5.13)],.045,'wood',7,color=(.78,.73,.61))
masonry(18.0,22.0,2.15,3.6,1.15,.44,course=.30)
# Two little seats and pots in the inhabited waterfront.
for x,y in [(7,16),(13,15),(20,18)]:
    box((x,y,2.70),(1.6,.52,.16),'wood',.025)
    for dx in [-.58,.58]:box((x+dx,y,2.43),(.15,.38,.5),'wood',.02)
    jar(x+1.2,y,2.15,.65)
# Terrace walls and a real stair route into the village.
for x,w in [(-17,17),(16,17)]:masonry(x,35,2.1,w,2.40,.62,course=.42)
for k in range(13):
    top=2.1+(k+1)*2.4/13;y=30.2+k*.43
    box((0,y,top-.35),(3.9,.47,.70),'paving',.04)
    floors.append({'x':0,'z':-y,'w':3.9,'d':.47,'y':top})
floors.extend([{'x':0,'z':-25,'w':60,'d':19,'y':2.15},{'x':0,'z':-44,'w':48,'d':17,'y':4.5}])
# Side stair to a small flat-roof terrace, outdoors only.
for k in range(20):box((15.5,20+k*.29,2.15+(k+1)*.32-.2),(1.1,.31,.4),'paving',.03)
# Paved lane; irregular joints made from the same grain-only limestone.
for yy in np.arange(14.5,30,.95):
    for xx in [-1.2,0,1.2]:box((xx,yy,2.125),(1.17,.92,.12),'paving',.025,color=tint(.9,1.03))
for yy in np.arange(36,54,1.0):
    for xx in [-1.2,0,1.2]:box((xx,yy,4.52),(1.17,.97,.12),'paving',.025,color=tint(.9,1.03))

# A few asymmetrical, partly buried outcrops establish the two rocky shoulders.
# Extents use the exported bounds, not the recipe's nominal seed dimensions.
landscape_rng=random.Random(9471)
rock_bounds={'rock-ledge-a':(8.968,3.454,5.768),'rock-ledge-b':(6.828,4.301,5.269),'rock-boulder':(2.224,1.949,1.711),'rock-rubble':(.86,.76,.70)}
def outcrop(id,x,y,width,depth,height,yaw=0,burial=.35):
    dx,dy,dz=rock_bounds[id];z=hterrain(x,y)-burial
    kit_instances.append({'id':id,'position':[x,z,-y],'scale':[width/dx,height/dy,depth/dz],'yaw':yaw})
# Negative space between strata is as deliberate as the stone itself.
rock_groups=[(-34,1,13,10,4.6),(-44,-7,16,11,5.2),(-55,-10,16,10,4.2),(-64,-3,10,7,2.5),(-39,17,9,7,2.5),(-52,27,13,8,3.3),(-67,41,12,8,3.1),(-42,49,8,6,2.3),(34,-1,13,9,4.0),(44,-7,16,12,5.4),(56,-4,18,12,5.2),(70,5,12,8,3.3),(41,23,10,7,2.8),(56,35,12,8,3.2),(72,50,13,8,3.8)]
for i,(x,y,w,d,h) in enumerate(rock_groups):
    yaw=.25+landscape_rng.uniform(-.25,.25)+(math.pi if x<0 else 0)
    outcrop('rock-ledge-a' if i%3 else 'rock-ledge-b',x,y,w,d,h,yaw,burial=.35)
    # One subordinate ledge, lower and offset along the common bedding direction.
    ox=x+landscape_rng.uniform(-w*.4,w*.4);oy=y-d*.38
    outcrop('rock-ledge-a',ox,oy,w*.68,d*.55,h*.55,yaw+.12,burial=.3)
    for j in range(3):
        rx=x+landscape_rng.uniform(-w*.65,w*.65);ry=y+landscape_rng.uniform(-d*.7,d*.55)
        if hterrain(rx,ry)<-.7:continue
        size=landscape_rng.uniform(.5,1.15)
        outcrop('rock-boulder',rx,ry,size*1.4,size,size*.8,yaw+landscape_rng.uniform(-.3,.3),burial=.08)
def tree(x,y,z,scale=1,kind='olive'):
    id='olive-a' if len(kit_instances)%2 else 'olive-b'
    size=scale/(1.18 if id=='olive-b' else 1)
    kit_instances.append({'id':id,'position':[x,z,-y],'scale':[size,size,size],'yaw':landscape_rng.random()*math.tau})
for x,y,size in [(-30,20,1.25),(31,15,1.15),(-27,39,1.3),(28,44,1.3),(-6,38,.9),(8,53,1.15),(-37,55,1.2),(45,38,1.25)]:tree(x,y,hterrain(x,y),size)
# Small cultivated groves give the uphill route a destination and a human scale.
for cx,cy,cols,rows in [(-26,91,3,3),(28,68,3,3),(-63,90,2,3),(63,112,3,2)]:
    for row in range(rows):
        for col in range(cols):
            x=cx+col*8.7+landscape_rng.uniform(-1.3,1.3);y=cy+row*11+col*.9+landscape_rng.uniform(-1,1)
            tree(x,y,hterrain(x,y),landscape_rng.uniform(1.05,1.4))
# Shrubs occur in the shelter of rocks and walls, leaving broad areas of quiet soil.
shrub_centers=[(x,y+d*.5) for x,y,w,d,h in rock_groups]+[(-25,31),(26,31),(-21,57),(15,57),(-18,82),(39,87)]
for cx,cy in shrub_centers:
    for j in range(4):
        x=cx+landscape_rng.uniform(-2.8,2.8);y=cy+landscape_rng.uniform(-1.7,1.7);z=hterrain(x,y)
        if z<.3 or route_distance(x,y)<2.8:continue
        radius=landscape_rng.uniform(.40,.85)
        kit_instances.append({'id':'coastal-shrub','position':[x,z-.025,-y],'scale':[radius/.55]*3,'yaw':landscape_rng.random()*math.tau})
# Continue the village lane to the shrine with broad, flush limestone steps.
# Each slab samples the same terrain as walking; there are no floating path ribbons.
for (ax,ay),(bx,by) in zip(UPPER_PATH,UPPER_PATH[1:]):
    length=math.hypot(bx-ax,by-ay);count=math.ceil(length/.95);dx,dy=(bx-ax)/length,(by-ay)/length
    for j in range(count):
        for side in [-1,0,1]:
            center=(j+.5)*length/count;cx=ax+dx*center-dy*side*.70;cy=ay+dy*center+dx*side*.70
            pts=[]
            for u,v in [(-.335,-length/count*.48),(.335,-length/count*.48),(.335,length/count*.48),(-.335,length/count*.48)]:
                px=cx-dy*u+dx*v;py=cy+dx*u+dy*v;pts.append((px,py,rendered_ground(px,py)+.023))
            mb('paving','upper-lane').face(list(reversed(pts)),tint(.95,1.0))
# Three low orchard boundaries give the groves a cultivated scale.
orchard_walls=[]
for xa,xb,ybase in [(-31,-1,83),(18,51,61),(-35,-9,106)]:
    count=math.ceil((xb-xa)/1.35)
    for i in range(count):
        x=xa+(xb-xa)*(i+.5)/count;y=ybase+1.7*math.sin((x-xa)/(xb-xa)*math.pi);base=hterrain(x,y)
        angle=math.atan(1.7*math.pi/(xb-xa)*math.cos((x-xa)/(xb-xa)*math.pi))
        for row in range(2):box((x,y,base+.15+row*.29),(1.30,.43,.275),'limestone',.027,angle,color=tint(.93,1.02))
        orchard_walls.append({'name':'orchard-boundary','x':x,'z':-y,'w':1.4,'d':.7,'y0':base,'y1':base+.61})
# A small hill shrine with shaded entrance gives the inland silhouette a focal point.
building('shrine',-12,76,hterrain(-12,76),5.6,7.0,3.4,tone=(1.04,1.03,.94),door=1.4)

# Material groups keep the scene's render submission count bounded.
objects=[]
for key,builder in builders.items():
    if builder.f:
        ob=builder.build();ob['stage']=key[0];objects.append(ob)
        if key[1]=='land':
            bm=bmesh.new();bm.from_mesh(ob.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001);bm.to_mesh(ob.data);bm.free()
            for face in ob.data.polygons:face.use_smooth=True
# True Y-up GLB boundary; apply all mesh transforms before export.
for name in ['harbor']:
    bpy.ops.object.select_all(action='DESELECT')
    chosen=[o for o in objects if o['stage']==name]
    for o in chosen:o.select_set(True)
    bpy.context.view_layer.objects.active=chosen[0]
    bpy.ops.export_scene.gltf(filepath=str(RAW/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_animations=False,export_extras=True,export_materials='EXPORT',export_vertex_color='NAME',export_vertex_color_name='Tint',export_all_vertex_colors=False,export_image_format='JPEG',export_jpeg_quality=92)
    print('EXPORTED',name,sum(len(p.vertices)-2 for o in chosen for p in o.data.polygons),'triangles')
# Non-rendered sockets and collision metadata in a portable manifest.
manifest=json.loads((KIT/'assets/manifest.json').read_text())
for asset in manifest['assets']:
    asset['source']={**asset['source'],'blend':'../harbor-kit/'+asset['source']['blend'],'recipe':'../harbor-kit/'+asset['source']['recipe']}
    for lod in asset['lods']:shutil.copy2(KIT/'build/raw'/Path(lod['file']).name,RAW/Path(lod['file']).name)
    for collision in asset['collision']:
        if collision['type']=='mesh':shutil.copy2(KIT/'build/raw'/Path(collision['file']).name,RAW/Path(collision['file']).name)
points=[(v.co.x,v.co.z,-v.co.y) for o in objects if o['stage']=='harbor' for v in o.data.vertices]
manifest['assets'].append({'id':'study-harbor','family':'assembly','source':{'blend':'blender/ormos-harbor.blend','recipe':'blender/build_harbor.py'},'bounds':{'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]},'anchors':[],'collision':[],'triangles':sum(len(p.vertices)-2 for o in objects if o['stage']=='harbor' for p in o.data.polygons),'lods':[{'level':0,'file':'models/harbor.glb','distance':0}]})
# Walking solids preserve door openings and follow actual furniture/fixture placements.
walls=[]
for b in colliders:
    x,z,w,d,h,base,dw,dh=b['x'],b['z'],b['w'],b['d'],b['y1']-b['y0'],b['y0'],b['door'],b['doorHeight']
    def wall(name,x,z,w,d,y0,y1):walls.append({'name':b['name']+'-'+name,'x':x,'z':z,'w':w,'d':d,'y0':y0,'y1':y1})
    wall('back',x,z-d/2,w,.55,base,base+h)
    for sign in [-1,1]:
        wall('side',x+sign*(w/2-.2),z,.55,d,base,base+h)
        wall('front',x+sign*(w+dw)/4,z+d/2,(w-dw)/2,.55,base,base+h)
    wall('lintel',x,z+d/2,dw,.55,base+dh,base+h)
    if b['name']!='warehouse':wall('closed-door',x,z+d/2-.6,dw,.12,base,base+dh)
colliders=walls+orchard_walls

def walk_solid(name,x,native_y,w,d,y0,y1):colliders.append({'name':name,'x':x,'z':-native_y,'w':w,'d':d,'y0':y0,'y1':y1})
for x in [-21,-9,-3,4,17]:walk_solid('mooring-stone',x,.55,.68,.68,2.1,3.1)
for x in [-22,-16,-10,-4]:walk_solid('canopy-post',x,11,.45,.46,2.1,5.4)
walk_solid('loading-bench',-18,12.3,5.8,1.1,2.1,2.96)
walk_solid('packing-rack',-7.5,9.95,3.2,1.25,2.1,3.6)
walk_solid('water-trough',19,11.8,2.3,.9,2.1,2.6)
for x,y in [(7,16),(13,15),(20,18)]:walk_solid('bench',x,y,1.6,.52,2.1,2.78)
for x in [-21,-17,-10]:walk_solid('cargo-group',x+.52,8,1.85,1.5,2.1,3.05)
for x in [-18,-8]:walk_solid('warehouse-rack',x,20,1.6,5.2,2.15,5.5)
for y in [17,20,23]:walk_solid('warehouse-cargo',-13,y,3.2,.85,2.15,3.5)
for x in [16.3,19.2]:
    for y in [17.7,21.5]:walk_solid('trellis-post',x,y,.34,.34,2.15,5.2)
for x,y,w,angle in [(-23,27,12,math.pi/2),(5.5,29,9,math.pi/2),(25.8,38,8,math.pi/2),(-9.5,36,8,0),(7.5,36,8,0)]:
    base=2.15 if y<35 else 4.5;walk_solid('garden-wall',x,y,.6 if angle else w,w if angle else .6,base,base+1.05)
for x,w in [(-17,17),(16,17)]:walk_solid('terrace-wall',x,35,w,.62,2.1,4.5)
manifest['terrain']={'x0':-125,'nativeY0':-45,'step':2,'columns':126,'rows':126,'triangles':'00-10-11 / 00-11-01','heights':[hterrain(-125+i*2,-45+j*2) for j in range(126) for i in range(126)]}
manifest.update({'axes':'glTF Y up; -Z inland','quayHeight':2.1,'floors':floors,'colliders':colliders,'sockets':sockets,'boatPosition':[-4,.15,5.0],'seed':2741,'instances':kit_instances})
(ASSETS/'manifest.json').write_text(json.dumps(manifest,indent=2))
# The master retains editable meshes/materials, plus a composed camera and lighting.
for o in objects:
    if o['stage'] in ['boat','plank']:o.hide_render=True;o.hide_set(True)
# Editable master keeps linked kit collection instances, matching runtime placements.
collections={}
master_instances=kit_instances+[{'id':'merchant-shell','position':[-4,0,2.358],'scale':[1,1,1],'yaw':math.pi/2}]
# Runtime supplies the original animated rig; the Blender master stages its authored shell.
span=math.sqrt(3.1**2-1.602**2)
master_instances.append({'id':'merchant-gangplank','position':[-2.1403,1.4776,1.031],'scale':[1,1,1],'yaw':0,'pitch':math.atan2(1.602,span)})
for item in master_instances:
    id=item['id']
    if id not in collections:
        with bpy.data.libraries.load(str(KIT/'blender/sources'/(id+'.blend')),link=False) as (source,target):target.collections=[id]
        collections[id]=target.collections[0]
    ob=bpy.data.objects.new('kit_'+id,None);ob.instance_type='COLLECTION';ob.instance_collection=collections[id]
    bpy.context.scene.collection.objects.link(ob)
    x,y,z=item['position'];sx,sy,sz=item['scale'];ob.location=(x,-z,y);ob.scale=(sx,sz,sy);ob.rotation_euler.z=item['yaw']
    if 'pitch' in item:ob.rotation_euler.x=item['pitch']
    ob['kitAsset']=id
bpy.ops.mesh.primitive_plane_add(size=3000,location=(0,0,-35));seabed=bpy.context.object;seabed.name='Deep seabed';seabed.data.materials.append(mats['earth'])
bpy.ops.object.light_add(type='SUN',location=(10,-40,60));sun=bpy.context.object;sun.name='Afternoon sun';sun.rotation_euler=(.6,-.45,-.55);sun.data.energy=2.5;sun.data.angle=.06
world=bpy.data.worlds.new('Coastal sky');bpy.context.scene.world=world;world.color=(.28,.35,.42)
bpy.ops.object.camera_add(location=(73,-93,45));cam=bpy.context.object;direction=Vector((0,14,4))-cam.location;cam.rotation_euler=direction.to_track_quat('-Z','Y').to_euler();cam.data.lens=43;bpy.context.scene.camera=cam
bpy.context.scene.render.engine='CYCLES';bpy.context.scene.cycles.samples=24
bpy.context.scene.render.resolution_x=1600;bpy.context.scene.render.resolution_y=1000;bpy.context.scene.render.resolution_percentage=100
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'blender'/'ormos-harbor.blend'))
print('HARBOR_BUILD_COMPLETE')
