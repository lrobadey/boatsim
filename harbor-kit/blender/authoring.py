"""Shared Ormos kit authoring primitives. Native Z-up metres; build_kit applies the asset frame.
Derived from the tested harbor study; this module is now the kit source of truth.
Import once inside Blender. Texture masters are deterministic and authored locally.
"""
import bpy, bmesh, math, random, json, os, struct, zlib
import numpy as np
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
ASSETS=ROOT/'build'; ASSETS.mkdir(exist_ok=True)
TEX=ROOT/'blender'/'textures'; TEX.mkdir(exist_ok=True)
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
for kind,col in [('limestone',(0.70,0.65,0.53)),('paving',(0.69,0.64,0.53)),('plaster',(0.84,0.80,0.69)),('wood',(0.43,0.33,0.23)),('tile',(0.57,0.29,0.17)),('rope',(0.55,0.46,0.30)),('cloth',(0.77,0.72,0.59)),('earth',(0.46,0.44,0.32)),('rock',(0.59,0.57,0.47))]:
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

def hterrain(x,y):
    # A low cultivated saddle meets two rocky shoulders. Quay ground is flat.
    shore=5 + 6*math.sin(x*.035) - 20*math.exp(-((x+47)/19)**2)-17*math.exp(-((x-55)/20)**2)
    if y<shore:return -1.7+(y-shore)*.11
    inland=max(0,y-12)
    h=1.8+inland*.095+2.0*math.sin(x*.031+y*.021)**2
    h+=9*math.exp(-((x+66)/33)**2-((y-35)/39)**2)+13*math.exp(-((x-68)/35)**2-((y-57)/40)**2)
    h+=.42*math.sin(x*.18+y*.10)*math.sin(y*.15-x*.07)
    if -33<x<34 and y<18:h=1.84
    if -27<x<27 and 17<=y<35:h=2.10
    if -23<x<25 and 35<=y<52:h=4.5
    return h


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
            # Gables are real wall volumes: their interior must close the roof
            # when viewed from the loading hall, with backface culling enabled.
            inner=[(px,py+(.25 if yy<y else -.25),pz) for px,py,pz in pts]
            b.face(list(reversed(inner)),tone)
            for i in range(3):
                j=(i+1)%3;b.face([pts[i],inner[i],inner[j],pts[j]],tone)
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

def rock(cx,cy,cz,sx,sy,sz):
    b=mb('rock');rc=tint(.72,.99);sides=11;angles=[j*math.tau/sides+R.uniform(-.09,.09) for j in range(sides)];rings=[]
    radial=[R.uniform(.78,1.15) for a in angles]
    profile=[(-.62,.95),(-.12,1.02),(.31,.89),(.48,.73)]
    for layer,(z,r) in enumerate(profile):
        rings.append([(cx+sx*r*math.cos(a)*radial[j]+z*sx*.20,cy+sy*r*math.sin(a)*radial[j],cz+sz*z+.13*sx*math.cos(a)+R.uniform(-.025,.025)*sz) for j,a in enumerate(angles)])
    def sculpt_face(points,color):
        # Subdivide fracture planes, then deform with continuous world-space
        # fields so neighbouring faces share precisely the same broken edge.
        def sculpt(p):
            x,y,z=p
            n=.045*math.sin(x*2.1+y*1.7)*math.sin(z*2.9-y*.8)+.008*math.sin(x*8.3-y*5.7+z*6.1)
            bed=.016*math.sin(z*8+x*.9+y*.4)
            direction=Vector((x-cx,y-cy,(z-cz)*.7));direction.normalize()
            return Vector(p)+direction*(n+bed)*min(1,max(sx,sy))
        a,b,c,d=map(Vector,points)
        # One edge subdivision count across all fracture faces avoids T-junction cracks.
        count=max(3,min(16,math.ceil(max(sx,sy,sz)*2/.45)))
        def point(u,v):return sculpt(a.lerp(b,u).lerp(d.lerp(c,u),v))
        for iy in range(count):
            for ix in range(count):
                u,v=ix/count,iy/count
                q=[point(u,v),point(u+1/count,v),point(u+1/count,v+1/count),point(u,v+1/count)]
                bld=mb('rock')
                for tri in [[q[0],q[1],q[2]],[q[0],q[2],q[3]]]:
                    if (tri[1]-tri[0]).cross(tri[2]-tri[0]).length>1e-9:bld.face(tri,color)
    for i in range(len(rings)-1):
        for j in range(sides):
            col=tuple(v*(.94 if i==2 else 1) for v in rc);k=(j+1)%sides
            if max(sx,sy)>.2:sculpt_face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],col)
            else:b.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],col)
    center=sum((Vector(p) for p in rings[-1]),Vector())/sides
    for j in range(sides):
        k=(j+1)%sides;a=Vector(rings[-1][j]);c=Vector(rings[-1][k]);mid=(a+c)/2
        if max(sx,sy)>.2:sculpt_face([a,c,center,center],rc)
        else:b.face([a,c,center],rc)

def tree(x,y,z,scale=1,kind='olive'):
    # Continuous tapered, fluted trunk and low buttress roots, never stilts.
    h=R.uniform(4,5.0)*scale
    def branch(points,radii):
        rings=[];b=mb('wood','bark');sides=12
        for i,p in enumerate(points):
            p=Vector(p);direction=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
            direction.normalize();u=direction.cross(Vector((0,1,0))).normalized();v=direction.cross(u)
            rings.append([p+radii[i]*(1+.13*math.sin(j*math.tau/sides*5+i*.55))*(math.cos(j*math.tau/sides)*u+math.sin(j*math.tau/sides)*v) for j in range(sides)])
        for i in range(len(rings)-1):
            for j in range(sides):
                k=(j+1)%sides;b.face([rings[i][j],rings[i][k],rings[i+1][k],rings[i+1][j]],(.72,.69,.61),[(j/sides,i*.32),((j+1)/sides,i*.32),((j+1)/sides,(i+1)*.32),(j/sides,(i+1)*.32)])
        b.face(list(reversed(rings[0])));b.face(rings[-1])
    branch([(x,y,z-.07),(x+.06*scale,y-.06*scale,z+h*.10),(x+.16*scale,y-.10*scale,z+h*.32),(x-.12*scale,y+.08*scale,z+h*.52),(x-.25*scale,y+.13*scale,z+h*.72)], [v*scale for v in [.40,.31,.26,.20,.08]])
    for root in range(6):
        angle=root*math.tau/6+.2;dx,dy=math.cos(angle),math.sin(angle)
        branch([(x+.10*dx*scale,y+.10*dy*scale,z+.48*scale),(x+.35*dx*scale,y+.35*dy*scale,z+.13*scale),(x+.69*dx*scale,y+.69*dy*scale,z-.02)], [v*scale for v in [.15,.115,.025]])
    for k in range(9):
        angle=k*math.tau/9+R.random()*.45;radius=R.uniform(1.0,1.9)*scale
        level=.65+.25*(k%3)/2
        end=(x+math.cos(angle)*radius,y+math.sin(angle)*radius,z+h*level+R.uniform(-.18,.18)*scale)
        branch([(x-.07*scale,y,z+h*.32),(x+math.cos(angle)*radius*.25,y+math.sin(angle)*radius*.25,z+h*.47),(x+math.cos(angle+.13)*radius*.64,y+math.sin(angle+.13)*radius*.64,z+h*(level-.1)),end], [v*scale for v in [.14,.10,.052,.014]])
        for twig in range(7):
            ta=angle+twig*1.2
            branch([end,(end[0]+math.cos(ta)*.45*scale,end[1]+math.sin(ta)*.45*scale,end[2]+.16*scale),(end[0]+math.cos(ta)*.85*scale,end[1]+math.sin(ta)*.85*scale,end[2]+.26*scale)],[v*scale for v in [.027,.015,.003]])
        for j in range(680):
            # Ellipsoidal clusters avoid the old rectangular cloud of crosses.
            while True:
                dx,dy,dz=R.uniform(-1,1),R.uniform(-1,1),R.uniform(-1,1)
                if dx*dx+dy*dy+dz*dz<=1:break
            px,py,pz=end[0]+dx*1.10*scale,end[1]+dy*1.10*scale,end[2]+dz*.90*scale
            a0=R.random()*math.tau;length=R.uniform(.11,.18)*scale;width=length*.24;tilt=R.uniform(-.05,.08)*scale
            dx,dy=math.cos(a0),math.sin(a0);col=tint(.82,1.04)
            # One narrow folded lanceolate blade with a silvery underside.
            leaf=mb('olive_leaf' if kind=='olive' else 'leaf')
            leaf.face([(px-dx*length,py-dy*length,pz-tilt),(px-dy*width,py+dx*width,pz),(px+dx*length,py+dy*length,pz+tilt),(px,py,pz+.018*scale)],col)
            leaf.face([(px-dx*length,py-dy*length,pz-tilt),(px,py,pz+.018*scale),(px+dx*length,py+dy*length,pz+tilt),(px+dy*width,py-dx*width,pz)],col)

def inside_width(x,z):
    u=x/8.5;t=max(0,min(1,(z+.50-abs(u)**5*.80)/1.95))
    return max(.1,2*(2.35*max(.025,1-u*u)**.52*math.sin(t*math.pi/2)-.13))
