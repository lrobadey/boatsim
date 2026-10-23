"""Five cumulative, visually reviewed exterior refinements of the chosen Thalassa.

Uses the original study's native geometry toolkit without altering its saved variants.
Blender -b --factory-startup --python-exit-code 1 -P this_file -- --refine 1
"""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

parser=argparse.ArgumentParser()
parser.add_argument('--refine',type=int,choices=range(1,6),required=True)
parser.add_argument('--views',nargs='+',default=['hero','stern','court'])
parser.add_argument('--final',action='store_true')
parser.add_argument('--save-only',action='store_true')
parser.add_argument('--dusk',action='store_true')
request=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
REFINE=request.refine
RENDER_VIEWS=request.views
FINAL=request.final
SAVE_ONLY=request.save_only
DUSK=request.dusk
STUDY_ROOT=Path(__file__).resolve().parents[1]


def spline(points,steps=12):
    """Interpolating Catmull-Rom curve through deliberate design control points."""
    p=[Vector(points[0])]+[Vector(v) for v in points]+[Vector(points[-1])]
    out=[]
    for i in range(1,len(p)-2):
        a,b,c,d=p[i-1:i+3]
        for j in range(steps):
            t=j/steps
            out.append(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t))
    out.append(Vector(points[-1]))
    return out


def refined_ends(offset):
    # The prow curls are smooth continuations of the keel and stem.
    prow=spline([(34,0,1.3),(39.2,0,3.6),(42.6,0,7.0),(42.2,0,9.3),(40.3,0,10.0),(39.3,0,9.6)])
    wood.path(prow,.29 if REFINE==1 else .20,10)
    red.path([p+Vector((.08,0,.03)) for p in prow],.19 if REFINE==1 else .25,10)
    bronze.path([p+Vector((.16,0,.07)) for p in prow],.045,8)
    # Sculpted bronze forefoot, with hollowed grooves rather than a stack of boards.
    for side in [-1,1]:
        bronze.face([(35.1,side*.50,-.02),(39.8,side*.49,.13),(45.4,side*.12,.44),(40.8,side*.31,.85),(36.0,side*.65,1.0)])
    bronze.face([(35.1,-.5,-.02),(35.1,.5,-.02),(45.4,.12,.44),(45.4,-.12,.44)])
    bronze.face([(36,-.65,1),(36,.65,1),(40.8,.31,.85),(45.4,.12,.44),(45.4,-.12,.44),(40.8,-.31,.85)])
    for side in [-1,1]:
        for z in [.24,.48,.71]:
            wood.rod((38.1,side*.53,z),(43.7,side*.18,.47+(z-.48)*.35),.035,sides=6)
    # A compact, fanned ancient stern ornament.
    for k in range(-2,3):
        pts=spline([(-35.5,k*.09,5.7),(-39.8,k*.17,8.4),(-41.0,k*.26,11.1),(-39.8,k*.30,12.1),(-38.8,k*.31,12.0)])
        red.path(pts,.17 if k else .24,8)
        bronze.path([p+Vector((-.06,0,.08)) for p in pts],.041,6)
    # Steering sweeps are fixed to visible timber crutches.
    for side in [-1,1]:
        a=(-31,side*2.1,7.2);b=(-40.4,side*5.0,.10)
        wood.rod(a,b,.21,.13,12)
        v=(Vector(b)-Vector(a)).normalized();e=Vector(b);p=Vector((0,side*.6,0))
        deck.face([e-v*3-p*.4,e-v*3+p*.4,e+p,e-p])
        wood.rod((-30,side*2.1,5.4),(-31,side*2.1,7.3),.13,sides=10)
        bronze.rod((-31,side*1.8,7.2),(-31,side*2.5,7.2),.24,sides=12)


# Reuse only the original toolkit and hull construction. The design below is separate.
base_source=(STUDY_ROOT/'blender/build_ship.py').read_text()
prefix=base_source[:base_source.index('# Revised brief:')]
a=prefix.index('    # Stem profile, low bronze forefoot')
b=prefix.index('    # Painted almond eyes',a)
prefix=prefix[:a]+'    refined_ends(offset)\n\n'+prefix[b:]
if REFINE>=3:
    prefix=prefix.replace('            z=1.15+bank*.88','            z=1.15+bank*.88')
    # The boarding station needs a clear gap in the port oar run.
    prefix=prefix.replace('                z=1.15+bank*.88','                if offset<0 and -16<x<-7:\n                    continue\n                z=1.15+bank*.88')
original_argv=sys.argv
sys.argv=[str(STUDY_ROOT/'blender/build_ship.py'),'--','--concept','C','--pass','2','--save-only']
exec(compile(prefix,str(STUDY_ROOT/'blender/build_ship.py'),'exec'),globals())
sys.argv=original_argv

fine=Batch('Carved bronze edgework','Aged bronze',True)
all_batches.append(fine)


def edge_polygon(x0,x1,y0,y1,cut=1.):
    return [(x0+cut,y0),(x1-cut,y0),(x1,y0+cut),(x1,y1-cut),
            (x1-cut,y1),(x0+cut,y1),(x0,y1-cut),(x0,y0+cut)]


def shaped_terrace(name,x0,x1,y0,y1,z,cut=1.,rails=True):
    """Chamfered, planked terrace with an expressed timber perimeter beam."""
    outline=edge_polygon(x0,x1,y0,y1,cut)
    for i in range(8):
        a=outline[i];b=outline[(i+1)%8]
        wood.face([(*a,z-.32),(*b,z-.32),(*b,z),(*a,z)])
        red.rod((*a,z-.09),(*b,z-.09),.074,sides=8)
        bronze.rod((*a,z+.035),(*b,z+.035),.028,sides=8)
        if rails:
            length=(Vector(a)-Vector(b)).length
            n=max(1,math.ceil(length/1.3))
            def opening(p):
                if REFINE<5:return False
                xx,yy=p
                if name=='Aft promenade bridge' and abs(xx+10)<.15 and abs(yy)>4.35:return True
                if name=='Forward cross terrace':
                    if abs(xx-14)<.15 and 7.5<abs(yy)<9.5:return True
                    if abs(xx-10)<.15 and 6.25<abs(yy)<10.7:return True
                if name=='Gallery roof':
                    if abs(xx+12.8)<.15 or abs(xx-10.2)<.15:return True
                    if 6.2<abs(yy)<6.4 and xx<-9.8:return True
                if name=='Aft residence terrace':
                    if abs(xx+11.5)<.15:return True
                    if abs(abs(yy)-5.85)<.15 and -27.1<xx<-20.9:return True
                if name=='Aft cross terrace' and abs(yy)>5.9:return True
                return False
            for j in range(n):
                t=j/n;p=(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t)
                if opening(p):continue
                wood.rod((*p,z),(*p,z+1.0),.045,sides=8)
                fine.rod((*p,z+.94),(*p,z+1.015),.058,sides=10)
            for j in range(n):
                t0=j/n;t1=(j+1)/n
                p=(a[0]+(b[0]-a[0])*t0,a[1]+(b[1]-a[1])*t0)
                q=(a[0]+(b[0]-a[0])*t1,a[1]+(b[1]-a[1])*t1)
                if opening(((p[0]+q[0])/2,(p[1]+q[1])/2)):continue
                wood.rod((*p,z+1),(*q,z+1),.06,sides=8)
                rope.rod((*p,z+.50),(*q,z+.50),.025,sides=6)
    n=math.ceil((y1-y0)/.23)
    for j in range(n):
        ya=y0+j*(y1-y0)/n;yb=y0+(j+1)*(y1-y0)/n
        y=(ya+yb)/2
        trim=max(0,cut-min(y-y0,y1-y))
        for i in range(max(1,math.ceil((x1-x0)/3.3))):
            xa=max(x0+trim,x0+i*3.3);xb=min(x1-trim,x0+(i+1)*3.3)
            if xb<=xa:continue
            deck.box(((xa+xb)/2,y,z+.018),(xb-xa-.013,yb-ya-.013,.036))
    # Solid substrate under the individually fitted boards.
    deck.face([(x,y,z-.015) for x,y in outline])


def gallery(x0,x1,y,width_=4.4):
    shaped_terrace('Gallery roof',x0,x1,y-width_/2,y+width_/2,8.64,.55)
    n=math.ceil((x1-x0)/2.2)
    for i in range(n+1):
        x=x0+(x1-x0)*i/n
        for yy in [y-width_/2+.1,y+width_/2-.1]:
            wood.rod((x,yy,5.6),(x,yy,8.5),.10,.085,12)
            wood.rod((x,yy,7.7),(x+.55,yy,8.4),.065,sides=8)
            wood.rod((x,yy,7.7),(x-.55,yy,8.4),.065,sides=8)
            fine.rod((x,yy,5.67),(x,yy,5.83),.13,sides=12)
    side=1 if y>0 else -1
    yy=y+side*(width_/2-.06)
    green.box(((x0+x1)/2,yy,6.0),(x1-x0,.10,.76))
    wood.rod((x0,yy,6.42),(x1,yy,6.42),.065,sides=8)


# PASS 1 — massing, shaped terraces and a legible cross-hull timber frame.
shaped_terrace('Main bridge deck',-29,30,-10.65,10.65,5.55,3.0,False)
for x in [-27,-19,-11,-3,5,13,21,28]:
    wood.box((x,0,4.91),(.50,21.8,.82))
    for side in [-1,1]:
        wood.rod((x,side*8.5,3.9),(x,side*4.8,5.13),.17,sides=10)
        bronze.box((x,side*7.8,4.91),(.55,.15,.87))
for offset in HULL_OFFSETS:
    cabin(-27,-13,offset-2.15,offset+2.15,5.57,2.85,True)
    shaped_terrace('Aft residence terrace',-28,-11.5,offset-2.65,offset+2.65,8.62,.8)
    awning(-25.5,-16,offset-2.35,offset+2.35,11.1,.30)
    gallery(-12.8,8.7 if REFINE<5 else 10.2,offset)
    stair(-5,-12,offset if REFINE<4 else math.copysign(5.35,offset),1.35,5.6,8.62)
    stair(21.5,14,offset,1.5,5.6,8.62)
shaped_terrace('Aft cross terrace',-27,-21,-6.1,6.1,8.62,.7)
shaped_terrace('Aft promenade bridge',-14,-10,-6.1,6.1,8.62,.5)
shaped_terrace('Forward cross terrace',10,14,-10.6,10.6,8.62,.7)
for y in [-10,-6,-2,2,6,10]:
    wood.rod((12,y,5.55),(12,y,8.5),.13,sides=10)
if REFINE==1:
    awning(-7.5,6.0,-5.8,5.8,9.5,.65)
else:
    # Annular tensioned linen: an open skylight makes the central court legible.
    def court_canopy(theta,r):
        co,si=math.cos(theta),math.sin(theta)
        inner=Vector((-1.25+2.45*co,1.65*si,10.12))
        outer=Vector((-1.25+7.1*math.copysign(abs(co)**.5,co),5.85*math.copysign(abs(si)**.5,si),9.60+.35*math.cos(theta*4)))
        p=inner.lerp(outer,r)
        p.z-=.35*math.sin(math.pi*r)
        return p
    for i in range(128):
        t0=i*math.tau/128;t1=(i+1)*math.tau/128
        for j in range(14):
            linen.face([court_canopy(t0,j/14),court_canopy(t1,j/14),court_canopy(t1,(j+1)/14),court_canopy(t0,(j+1)/14)])
    for r in [0,1]:
        rope.path([court_canopy(i*math.tau/128,r) for i in range(129)],.033)
    if REFINE>=3:
        wood.path([court_canopy(i*math.tau/128,0)-Vector((0,0,.06)) for i in range(129)],.065,8)
        for x,y in [(-3.0,-1.2),(-3.0,1.2),(.5,-1.2),(.5,1.2)]:
            wood.rod((x,y,5.6),(x,y,10.1),.08,sides=12)
            fine.rod((x,y,5.65),(x,y,5.85),.11,sides=12)
    for i in range(24):
        theta=i*math.tau/24
        rope.path([court_canopy(theta,j/16) for j in range(17)],.012,6)
    for theta in [math.pi/4,math.pi*3/4,math.pi*5/4,math.pi*7/4]:
        p=court_canopy(theta,1)
        foot=(p.x*1.1,p.y*1.12,5.6)
        wood.rod(foot,(foot[0],foot[1],10.4),.085,sides=12)
        rope.rod(p,(foot[0],foot[1],10.4),.045,sides=8)
for side in [-1,1]:
    rail_rect(-9,27,side*10.6-.025,side*10.6+.025,5.6)

# PASS 2 — layered edge moldings and restrained bronze meanders.
if REFINE>=2:
    for offset in HULL_OFFSETS:
        for yy in [offset-2.68,offset+2.68]:
            fine.rod((-27.2,yy,8.48),(-12.3,yy,8.48),.027,sides=8)
            wood.rod((-27.2,yy,8.38),(-12.3,yy,8.38),.075,sides=10)
            # One clean Greek key band, kept subordinate to the ship's long lines.
            for i in range(22):
                x=-26.8+i*.64
                fine.path([(x,yy,8.22),(x+.44,yy,8.22),(x+.44,yy,8.38),(x+.14,yy,8.38),(x+.14,yy,8.30)],.013,6)
        for x in [-26.6,-24.2,-21.8,-19.4,-17.0,-14.6]:
            for side in [-1,1]:
                yy=offset+side*2.22
                for z in [5.95,7.95]:
                    fine.rod((x,yy,z),(x,yy+side*.055,z),.055,sides=10)

# Original native rig and tender functions, retained for silhouette continuity.
start=base_source.index('def mast(');end=base_source.index('\nmast(11',start)
exec(compile(base_source[start:end],'<original mast toolkit>','exec'),globals())
def block(center,r=.19):
    x,y,z=center
    for side in [-1,1]:
        wood.rod((x,y+side*.07,z-r*.40),(x,y+side*.07,z+r*.4),r*.68,r*.68,12)
    fine.rod((x,y-.12,z),(x,y+.12,z),r*.28,sides=12)
    rope.path([(x+r*.67*math.cos(t*math.tau/32),y,z+r*.85*math.sin(t*math.tau/32)) for t in range(33)],.026,6)

def developed_rig(x,h,span,drop):
    base=5.55;top=base+h;yard=top-1.25
    wood.rod((x,0,base),(x,0,top),.42,.18,20)
    for z in [base+.2,base+1.5,base+3.5,top-1.4]:
        fine.rod((x,0,z),(x,0,z+.12),.44 if z<12 else .22,sides=20)
    wood.rod((x,0,yard),(x,-span/2,yard-.18),.18,.095,14)
    wood.rod((x,0,yard),(x,span/2,yard-.18),.18,.095,14)
    def p(u,v):
        return Vector((x+drop*.25*math.sin(math.pi*u)*math.sin(math.pi*v),
                      (u-.5)*span*(1-.12*v),
                      yard-drop*v+.85*(abs(2*u-1)**3)*v+.07*math.sin(u*math.pi*18)*v*v))
    for i in range(64):
        for j in range(28):
            linen.face([p(i/64,j/28),p((i+1)/64,j/28),p((i+1)/64,(j+1)/28),p(i/64,(j+1)/28)])
    for k in range(17):
        rope.path([p(k/16,j/32) for j in range(33)],.012,6)
    for v in [0,1]:rope.path([p(i/64,v) for i in range(65)],.039,8)
    for u in [0,1]:rope.path([p(u,j/32) for j in range(33)],.038,8)
    for k in range(1,16):
        pt=p(k/16,.76)
        rope.path([pt,pt+Vector((.015,.04,-.2)),pt+Vector((.035,-.02,-.42))],.015,6)
    for side in [-1,1]:
        block((x,side*(span/2-.2),yard-.28),.18)
        rope.rod((x,side*span/2,yard),(x,0,top-.15),.041,sides=8)
        clew=p(0 if side<0 else 1,1)
        block(clew,.21)
        rope.rod(clew,(x-4.1,side*10.6,5.85),.042,sides=8)
        for j in range(5):
            fx=x-3.3+j*1.5
            fy=side*(8.5+width(fx/82+.5)-.12)
            foot=Vector((fx,fy,sheer(fx/82+.5)+.25))
            shoulder=Vector((x,0,top-1.7))
            rope.rod(shoulder,foot,.052,sides=8)
            wood.rod(foot,foot+Vector((0,0,.44)),.14,sides=12)
            fine.rod(foot-Vector((0,0,.35)),foot,.08,sides=10)
            block(foot+Vector((0,0,.52)),.14)
        # Actual chain-plate attachment points, with matching ratlines.
        for j in range(1,25):
            t=j/27
            left=Vector((x-3.3,side*(8.5+width((x-3.3)/82+.5)-.12),5.6)).lerp(Vector((x,0,top-1.7)),t)
            right=Vector((x+2.7,side*(8.5+width((x+2.7)/82+.5)-.12),5.6)).lerp(Vector((x,0,top-1.7)),t)
            rope.rod(left,right,.018,sides=6)
        for ax,az in [(30.,6.2),(-30.0,6.4)]:
            anchor=Vector((ax,side*8.5,az))
            rope.rod((x,0,top-.1),anchor,.057,sides=8)
            fine.rod(anchor-Vector((.15,0,0)),anchor+Vector((.15,0,0)),.09,sides=10)
        for z in [base+.7,base+1.1]:
            wood.rod((x-.45,side*.45,z),(x+.45,side*.45,z),.055,sides=8)
    red.face([(x,0,top+.2),(x-4.6,.3,top-.05),(x-1.8,.12,top-.52),(x-4.0,-.05,top-.85),(x,0,top-.65)])

if REFINE<3:
    mast(12,24,21,5.)
    mast(-14.8,19,16,2.8)
else:
    developed_rig(12,24,21.5,7.1)
    developed_rig(-14.8,19,16.4,4.6)
start=base_source.index('def tender(');end=base_source.index('# Tender storage',start)
exec(compile(base_source[start:end],'<original tender toolkit>','exec'),globals())
tender((23,-2.6,6.05))
for x in [20.5,25.5]:
    wood.box((x,-2.6,5.6),(.25,2.1,.30))
    rope.rod((x,-3.6,5.6),(x,-1.6,6.65),.045)
shaped_terrace('Embarkation landing',-16,-7,-13.2,-11.4,4.9,.25,False)
stair(-3,-8,-11.7,1.2,5.6,4.9)
if REFINE<3:
    tender((-11,-15.7,.5),6.8,2.0,True)
    rope.path([(-11,-12.9,4.9),(-11,-14,2.8),(-11,-15,.85)],.035)
else:
    tender((-30.5,0,.5),6.8,2.0,True)
    for x in [-32.6,-28.4]:
        for side in [-1,1]:
            wood.rod((x,side*5.5,5.75),(x,side*3.6,8.6),.15,sides=12)
        wood.rod((x,-3.6,8.6),(x,3.6,8.6),.19,sides=14)
        block((x,0,8.35),.26)
        rope.rod((x,-.45,.9),(x,0,8.2),.039,sides=8)
        rope.rod((x,.45,.9),(x,0,8.2),.039,sides=8)
    for side in [-1,1]:
        for x in [28.5,31.5]:
            y=side*8.5
            wood.rod((x,y,5.6),(x,y,6.7),.19,sides=12)
            wood.rod((x,y-.9,6.45),(x,y+.9,6.45),.085,sides=10)
            fine.rod((x,y,5.75),(x,y,5.9),.21,sides=14)
            for k in range(4):
                rope.path([(x+.34*math.cos(t*math.tau/32),y+.34*math.sin(t*math.tau/32),5.68+k*.06) for t in range(33)],.025,6)
        # Stocked ancient anchor, set in a visible bow-side crutch.
        x=30.3;y=side*10.4
        wood.rod((x,y,5.7),(x+1.6,y+side*.9,8.3),.14,sides=12)
        fine.rod((x-.9,y,6.0),(x+.9,y,6.0),.12,sides=12)
        fine.path([(x-1.0,y,5.9),(x,y,5.5),(x+1.0,y,5.9)],.12,10)
        rope.path([(x+1.6,y+side*.9,8.3),(x+1.8,y+side*1.2,7.9),(x+1.6,y+side*.9,7.5)],.065,8)

# PASS 4 — an inhabited exterior: garden court, shaded terraces and practical boarding.
if REFINE>=4:
    import random as _random
    rng=_random.Random(28171)
    material('Olive foliage',(.095,.145,.045),.9)
    material('Olive silver',(.20,.25,.115),.93)
    material('Earth in planters',(.055,.038,.018),1.)
    material('Woven jade textile',(.043,.105,.087),.94,cloth=True)
    material('Lantern amber',(.31,.14,.025),.28,metal=.15)
    leaves=Batch('Olive canopy | individual leaves','Olive foliage',True)
    silver=Batch('Olive canopy | silver leaf undersides','Olive silver',True)
    earth=Batch('Planter soil','Earth in planters')
    textile=Batch('Woven terrace runners and throws','Woven jade textile')
    cushions=Batch('Soft outdoor cushions','Flax linen')
    pots=Batch('Terracotta vessels and planted tubs','Oxide terracotta',True)
    glass=Batch('Lantern amber lights','Lantern amber',True)
    all_batches.extend([leaves,silver,earth,textile,cushions,pots,glass])
    def vessel(x,y,z,r=.30,h=.8):
        # Curved lathed ceramic with a visible rim and recessed mouth.
        profile=[(.0,.22),(.08,.55),(.30,1.),(.68,.94),(.83,.55),(.94,.45),(1.,.58)]
        for j in range(len(profile)-1):
            a,ra=profile[j];b,rb=profile[j+1]
            for i in range(32):
                t=i*math.tau/32;u=(i+1)*math.tau/32
                pots.face([(x+r*ra*math.cos(t),y+r*ra*math.sin(t),z+h*a),(x+r*ra*math.cos(u),y+r*ra*math.sin(u),z+h*a),
                           (x+r*rb*math.cos(u),y+r*rb*math.sin(u),z+h*b),(x+r*rb*math.cos(t),y+r*rb*math.sin(t),z+h*b)])
        pots.path([(x+r*.58*math.cos(i*math.tau/40),y+r*.58*math.sin(i*math.tau/40),z+h) for i in range(41)],.035,8)
        earth.rod((x,y,z+h-.06),(x,y,z+h-.04),r*.48,sides=32)
    def olive(cx,cy,z,scale=1):
        def p(x,y,h):return Vector((cx+x*scale,cy+y*scale,z+h*scale))
        vessel(cx,cy,z,.86*scale,.9*scale)
        trunk=spline([p(0,0,.75),p(-.16,.09,1.5),p(.12,-.07,2.25),p(-.07,.05,3.0)],8)
        wood.path(trunk,.12*scale,10)
        for i in range(24):
            angle=i*2.39996;rad=.7+.4*rng.random()
            end=p(math.cos(angle)*rad,math.sin(angle)*rad,2.35+rng.random()*1.1)
            root=p(0,0,1.6+.8*rng.random())
            wood.rod(root,(root+end)/2+Vector((0,0,.25*scale)),.055*scale,.035*scale,8)
            wood.rod((root+end)/2+Vector((0,0,.25*scale)),end,.035*scale,.009*scale,8)
            for j in range(100):
                theta=rng.random()*math.tau;rr=rng.random()**.5*.47*scale
                q=end+Vector((math.cos(theta)*rr,math.sin(theta)*rr,(rng.random()-.5)*.48*scale))
                angle_=rng.random()*math.tau
                u=Vector((math.cos(angle_),math.sin(angle_),.2))*rng.uniform(.075,.12)*scale
                v=Vector((-math.sin(angle_),math.cos(angle_),.3))*.025*scale
                target=leaves if j%3 else silver
                target.face([q-u,q+v,q+u,q-v])
    olive(-1.25,0,5.60,1.)
    for offset in HULL_OFFSETS:
        # Each aft terrace has a small quiet seating group under its canopy.
        for y in [offset-1.25,offset+1.25]:
            wood.box((-20.5,y,9.00),(3.6,.68,.22))
            for x in [-21.8,-19.2]:
                wood.rod((x,y,8.64),(x,y,8.95),.09,sides=10)
            cushions.box((-20.5,y,9.20),(3.55,.72,.21))
            wood.box((-20.5,y+(.40 if y>offset else -.40),9.40),(3.6,.09,.65))
            textile.box((-21.4,y,9.32),(.72,.73,.025))
        wood.rod((-20.5,offset,8.64),(-20.5,offset,9.22),.13,sides=12)
        wood.rod((-20.5,offset,9.20),(-20.5,offset,9.30),.60,sides=48)
        textile.box((-21,offset,8.66),(5.8,2.05,.025))
        for yy in [offset-.91,offset+.91]:
            linen.box((-21,yy,8.68),(5.6,.035,.015))
        vessel(-20.5,offset,9.31,.12,.28)
        olive(-13.6,offset,8.66,.50)
        olive(-26.1,offset+math.copysign(1.55,offset),8.66,.45)
    # Dining beneath the court canopy remains an exterior space.
    wood.box((3.9,0,6.41),(2.7,1.05,.12))
    for x in [2.9,4.9]:
        for y in [-.35,.35]:wood.rod((x,y,5.6),(x,y,6.35),.065,sides=10)
    for y in [-1.05,1.05]:
        wood.box((3.9,y,6.03),(2.7,.43,.14))
        cushions.box((3.9,y,6.13),(2.6,.44,.10))
        for x in [2.9,4.9]:wood.rod((x,y,5.6),(x,y,5.98),.07,sides=10)
    vessel(3.8,0,6.48,.13,.34)
    for x,y in [(18,4.4),(18.7,4.8),(19.1,4.1)]:vessel(x,y,5.6,.28,.9)
    # Four fenders mark the boarding station, beyond the shortened oar run.
    for x in [-15.1,-13.0,-10.8,-8.6]:
        y=-12.1
        rope.rod((x,y,5.65),(x,y-.18,3.0),.038,sides=8)
        rope.rod((x,y-.18,3.0),(x,y-.18,4.2),.19,.19,12)
        for z in [3.08,3.3,3.52,3.74,3.96,4.14]:
            fine.path([(x+.2*math.cos(i*math.tau/20),y-.18+.2*math.sin(i*math.tau/20),z) for i in range(21)],.017,6)
    def lantern(x,y,z):
        # Bronze-caged oil lanterns with amber, replaceable light sources.
        glass.rod((x,y,z),(x,y,z+.34),.10,sides=12)
        fine.rod((x,y,z-.04),(x,y,z),.15,sides=12)
        fine.rod((x,y,z+.34),(x,y,z+.41),.15,.05,12)
        for i in range(4):
            t=i*math.pi/2
            fine.rod((x+.12*math.cos(t),y+.12*math.sin(t),z),(x+.12*math.cos(t),y+.12*math.sin(t),z+.35),.012,sides=6)
        fine.path([(x+.08*math.cos(i*math.pi/16),y,z+.44+.10*math.sin(i*math.pi/16)) for i in range(17)],.015,6)
    for offset in HULL_OFFSETS:
        for x in [-24,-17,-10,-3,4]:lantern(x,offset-math.copysign(1.8,offset),7.65)
    for x in [-26,-13,12]:
        for y in [-5.4,5.4]:lantern(x,y,8.77)

# PASS 5 — final craft, soft furnishings, identity and resolved exterior circulation.
if REFINE>=5:
    for x in [-3.22,.72]:
        for y in [-1.2,1.2]:
            lantern(x,y,9.05)
            fine.rod((x+(.22 if x<0 else -.22),y,9.5),(x,y,9.5),.026,sides=8)
    for offset in HULL_OFFSETS:
        # Curtains are drawn back at the corners, keeping the terraces visually open.
        for side in [-1,1]:
            yy=offset+side*2.27
            for j in range(30):
                for i in range(10):
                    def p(u,v):
                        return (-16.2-u*.52,yy+.075*math.sin(u*math.pi*7)+.07*math.sin(math.pi*v),11.0-v*1.8)
                    linen.face([p(i/10,j/30),p((i+1)/10,j/30),p((i+1)/10,(j+1)/30),p(i/10,(j+1)/30)])
            rope.rod((-16.8,yy,9.8),(-16.1,yy,9.8),.026,sides=8)
        # Matching palmette medallions on the aft quarters.
        for side in [-1,1]:
            yy=offset+side*(width(-31/82+.5)+.07)
            fine.rod((-31,yy,4.3),(-31,yy+side*.08,4.3),.42,sides=48)
            red.rod((-31,yy+side*.09,4.3),(-31,yy+side*.12,4.3),.32,sides=40)
            for k in range(-3,4):
                fine.path([(-31,yy+side*.15,4.08),(-31+k*.067,yy+side*.15,4.38),(-31+k*.092,yy+side*.15,4.50-abs(k)*.035)],.022,8)
    # Sail-yard and mast lashings, with proper coils at the bases.
    for x,h,span in [(12,24,21.5),(-14.8,19,16.4)]:
        for k in range(12):
            z=5.55+h-1.25-.19+k*.035
            rope.path([(x+.205*math.cos(i*math.tau/32),.205*math.sin(i*math.tau/32),z) for i in range(33)],.020,6)
        for side in [-1,1]:
            for k in range(5):
                rope.path([(x-.9+.32*math.cos(i*math.tau/32),side*.9+.44*math.sin(i*math.tau/32),5.64+k*.045) for i in range(33)],.023,6)
    green.box((14.06,0,8.44),(.10,3.7,.31))

for batch in all_batches:
    batch.build()

if REFINE>=2:
    # Real-world UVs orient grain along each face's longest construction axis.
    for ob in list(bpy.context.scene.objects):
        if ob.type!='MESH':continue
        me=ob.data
        uv=me.uv_layers.new(name='Construction grain')
        for poly in me.polygons:
            points=[me.vertices[i].co for i in poly.vertices]
            ranges=[max(p[k] for p in points)-min(p[k] for p in points) for k in range(3)]
            uaxis=max(range(3),key=lambda k:ranges[k])
            vaxis=max((k for k in range(3) if k!=uaxis),key=lambda k:ranges[k])
            for li in poly.loop_indices:
                p=me.vertices[me.loops[li].vertex_index].co
                uv.data[li].uv=(p[uaxis],p[vaxis])
        if ob.name.startswith(('Longitudinal timber','Individual laid deck','Accommodation exterior','Sea green screens','Soft outdoor cushions')):
            bm=bmesh.new();bm.from_mesh(me)
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
            bm.to_mesh(me);bm.free()
            mod=ob.modifiers.new('Hand eased construction edges','BEVEL')
            mod.width=.075 if ob.name.startswith('Soft outdoor') else .018;mod.segments=4;mod.limit_method='ANGLE';mod.angle_limit=.65
            normal=ob.modifiers.new('Weighted joinery normals','WEIGHTED_NORMAL');normal.keep_sharp=True
    for name,col in [('Cedar | hull',(.063,.035,.017)),('Honey teak | deck',(.265,.162,.077)),('Oiled timber | structure',(.052,.026,.012))]:
        mat=M[name];nodes,links=mat.node_tree.nodes,mat.node_tree.links
        tex=nodes.new('ShaderNodeTexCoord')
        scale=next(n for n in nodes if n.bl_idname=='ShaderNodeVectorMath')
        links.new(tex.outputs['UV'],scale.inputs[0]);scale.inputs[1].default_value=(.32,24,1)
        ramp=next(n for n in nodes if n.bl_idname=='ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color=(*(v*.55 for v in col),1)
        ramp.color_ramp.elements[1].color=(*(v*1.28 for v in col),1)
        if name=='Cedar | hull':
            geo=nodes.new('ShaderNodeNewGeometry');sep=nodes.new('ShaderNodeSeparateXYZ');links.new(geo.outputs['Position'],sep.inputs[0])
            wet=nodes.new('ShaderNodeMapRange');wet.inputs['From Min'].default_value=-.30;wet.inputs['From Max'].default_value=1.15
            wet.inputs['To Min'].default_value=.78;wet.inputs['To Max'].default_value=0;wet.clamp=True;links.new(sep.outputs['Z'],wet.inputs[0])
            mix=nodes.new('ShaderNodeMixRGB');mix.blend_type='MIX';mix.inputs[2].default_value=(.017,.033,.024,1)
            links.new(wet.outputs[0],mix.inputs[0]);links.new(ramp.outputs[0],mix.inputs[1]);links.new(mix.outputs[0],nodes.get('Principled BSDF').inputs['Base Color'])
    bs=M['Vermilion | painted wale'].node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.018,.082,.071,1);bs.inputs['Roughness'].default_value=.43
    bs=M['Warm limewash'].node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(.62,.57,.45,1)
    nodes=M['Aged bronze'].node_tree.nodes;links=M['Aged bronze'].node_tree.links
    geo=nodes.new('ShaderNodeNewGeometry');noise=nodes.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=4.2;noise.inputs['Detail'].default_value=3
    links.new(geo.outputs['Position'],noise.inputs['Vector'])
    ramp=nodes.new('ShaderNodeValToRGB');ramp.color_ramp.elements[0].color=(.07,.09,.045,1);ramp.color_ramp.elements[1].color=(.40,.26,.085,1)
    links.new(noise.outputs['Fac'],ramp.inputs[0]);links.new(ramp.outputs[0],nodes.get('Principled BSDF').inputs['Base Color'])
    if REFINE>=3:
        # Pack existing local PBR surfaces into the Blender document.
        texture_dir=STUDY_ROOT.parent/'harbor-study/blender/textures'
        def surface_image(name,space):
            im=bpy.data.images.load(str(texture_dir/name),check_existing=True)
            im.colorspace_settings.name=space;im.pack();return im
        for name,tint in [('Cedar | hull',(.60,.45,.28)),('Honey teak | deck',(1.65,1.42,1.12)),('Oiled timber | structure',(.34,.27,.20))]:
            mat=M[name];nodes,links=mat.node_tree.nodes,mat.node_tree.links
            coord=nodes.new('ShaderNodeTexCoord');mapping=nodes.new('ShaderNodeMapping')
            mapping.inputs['Rotation'].default_value=(0,0,math.pi/2);mapping.inputs['Scale'].default_value=(.5,.5,.5)
            links.new(coord.outputs['UV'],mapping.inputs[0])
            color=nodes.new('ShaderNodeTexImage');color.image=surface_image('wood_color.png','sRGB');links.new(mapping.outputs[0],color.inputs[0])
            mul=nodes.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1;mul.inputs[2].default_value=(*tint,1);links.new(color.outputs[0],mul.inputs[1])
            old=next(n for n in nodes if n.bl_idname=='ShaderNodeValToRGB')
            destinations=[link.to_socket for link in list(old.outputs[0].links)]
            for dest in destinations:links.new(mul.outputs[0],dest)
            normaltex=nodes.new('ShaderNodeTexImage');normaltex.image=surface_image('wood_normal.png','Non-Color');links.new(mapping.outputs[0],normaltex.inputs[0])
            normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.26;links.new(normaltex.outputs[0],normal.inputs[1]);links.new(normal.outputs[0],nodes.get('Principled BSDF').inputs['Normal'])
            rough=nodes.new('ShaderNodeTexImage');rough.image=surface_image('wood_rough.png','Non-Color');links.new(mapping.outputs[0],rough.inputs[0]);links.new(rough.outputs[0],nodes.get('Principled BSDF').inputs['Roughness'])
        if REFINE>=5:
            mat=M['Flax linen'];nodes,links=mat.node_tree.nodes,mat.node_tree.links
            coord=nodes.new('ShaderNodeTexCoord');mapping=nodes.new('ShaderNodeMapping');mapping.inputs['Scale'].default_value=(.8,.8,.8);links.new(coord.outputs['UV'],mapping.inputs[0])
            texture=nodes.new('ShaderNodeTexImage');texture.image=surface_image('cloth_color.png','sRGB');links.new(mapping.outputs[0],texture.inputs[0])
            mul=nodes.new('ShaderNodeMixRGB');mul.blend_type='MULTIPLY';mul.inputs[0].default_value=1;mul.inputs[2].default_value=(1.27,1.27,1.22,1);links.new(texture.outputs[0],mul.inputs[1]);links.new(mul.outputs[0],nodes.get('Principled BSDF').inputs['Base Color'])
            texture=nodes.new('ShaderNodeTexImage');texture.image=surface_image('cloth_normal.png','Non-Color');links.new(mapping.outputs[0],texture.inputs[0])
            normal=nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.32;links.new(texture.outputs[0],normal.inputs[1]);links.new(normal.outputs[0],nodes.get('Principled BSDF').inputs['Normal'])
    if REFINE>=5:
        text=bpy.data.curves.new('Thalassa bronze lettering','FONT');text.body='Θ Α Λ Α Σ Σ Α';text.align_x='CENTER';text.size=.225;text.extrude=.008;text.bevel_depth=.002;text.materials.append(M['Aged bronze'])
        ob=bpy.data.objects.new('Ship name | inlaid bronze',text);bpy.context.collection.objects.link(ob);ob.location=(14.12,0,8.335);ob.rotation_euler=(math.pi/2,0,math.pi/2)

# Reuse the already-verified native water and lighting, without saving over the study.
tail=base_source[base_source.index('# Real 3D water surface'):base_source.index("folder=ROOT/'renders'")]
exec(compile(tail,'<marine render environment>','exec'),globals())
scene=bpy.context.scene
if REFINE>=5:
    # Oil lanterns are actual lights, so the evening look belongs to the 3D scene.
    amber=M['Lantern amber'].node_tree.nodes.get('Principled BSDF')
    amber.inputs['Emission Color'].default_value=(1,.36,.075,1)
    amber.inputs['Emission Strength'].default_value=7 if DUSK else .22
    lantern_positions=[(x,offset-math.copysign(1.8,offset),7.82) for offset in HULL_OFFSETS for x in [-24,-17,-10,-3,4]]
    lantern_positions += [(x,y,8.94) for x in [-26,-13,12] for y in [-5.4,5.4]]
    lantern_positions += [(x,y,9.22) for x in [-3.22,.72] for y in [-1.2,1.2]]
    for i,pos in enumerate(lantern_positions):
        light=bpy.data.lights.new(f'Oil lantern {i+1:02d}','POINT');light.energy=65 if DUSK else 1.0;light.color=(1,.42,.13);light.shadow_soft_size=.16
        ob=bpy.data.objects.new(light.name,light);scene.collection.objects.link(ob);ob.location=(pos[0],pos[1]-math.copysign(.18,pos[1]),pos[2]-.08)
    if DUSK:
        sky.sun_elevation=math.radians(1.5);sky.sun_disc=False
        world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.18
        bpy.data.lights['Low afternoon sun'].energy=.12
        bpy.data.lights['Low afternoon sun'].color=(1,.52,.25)
        bpy.data.lights['Soft marine sky fill'].energy=18000
        bpy.data.lights['Soft marine sky fill'].color=(.29,.48,1)
        scene.view_settings.exposure=1.45
scene['Concept']='Thalassa / refined twin-hull flagship'
scene['Refinement pass']=REFINE
scene['Scope']='Exterior only; no game integration'
scene.cycles.samples=128 if FINAL else 32
scene.render.resolution_x=2600 if FINAL else 1400
scene.render.resolution_y=1700 if FINAL else 920
scene.render.resolution_percentage=100

CAMERAS={
    'hero':((90,-114,65),(0,0,8.5),52),
    'stern':((-83,-98,48),(-9,0,7.8),55),
    'court':((-5,-28,18),(-5,1,6.8),37),
    'bow':((68,-43,17),(22,0,5.2),48),
    'waterline':((92,-135,29),(0,0,10),54),
    'terrace':((-42,-33,18),(-18,-3,8),44),
    'garden':((-5.5,-4.8,7.1),(-.5,.5,7.8),28),
}
for name,(pos,target,lens) in CAMERAS.items():
    cam=bpy.data.objects.get('Camera | '+name)
    if cam is None:
        cd=bpy.data.cameras.new('Camera | '+name);cam=bpy.data.objects.new('Camera | '+name,cd);scene.collection.objects.link(cam)
    cam.location=pos;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=lens;cam.data.clip_end=200000
scene.camera=bpy.data.objects['Camera | hero']
OUT=STUDY_ROOT/'renders/thalassa'/f'pass-{REFINE:02d}'
if DUSK:OUT=OUT/'dusk'
OUT.mkdir(parents=True,exist_ok=True)
BLEND=STUDY_ROOT/'blender'/f'thalassa-pass-{REFINE:02d}{"-dusk" if DUSK else ""}.blend'
scene.render.filepath=str(OUT/'hero.png')
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
if not SAVE_ONLY:
    for name in RENDER_VIEWS:
        scene.camera=bpy.data.objects['Camera | '+name]
        scene.render.filepath=str(OUT/(name+'.png'))
        bpy.ops.render.render(write_still=True)
        print('PASS_RENDER',REFINE,name,flush=True)
scene.camera=bpy.data.objects['Camera | hero']
scene.render.filepath=str(OUT/'hero.png')
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND))
(OUT/'manifest.json').write_text(json.dumps(dict(refinement=REFINE,blend=str(BLEND),views=RENDER_VIEWS,
    resolution=[scene.render.resolution_x,scene.render.resolution_y],samples=scene.cycles.samples,
    objects=len(scene.objects),vertices=sum(len(o.data.vertices) for o in scene.objects if o.type=='MESH')),indent=2))
