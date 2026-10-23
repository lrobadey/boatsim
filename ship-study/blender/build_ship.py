"""Exterior-only trireme-descendant studies. Native Blender, metres, +X bow, +Z up.

Run Blender -b --factory-startup -P this_file -- --concept B --pass 1 --view hero.
Each render is saved with its editable scene; no game assets are overwritten.
"""
import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument('--concept', choices=['A', 'B', 'C'], default='B')
ap.add_argument('--pass', dest='iteration', type=int, default=1)
ap.add_argument('--view', default='hero')
ap.add_argument('--quality', default='draft', choices=['draft', 'final'])
ap.add_argument('--samples', type=int, default=0)
ap.add_argument('--save-only', action='store_true')
opt = ap.parse_args(args)
R = random.Random(241)
bpy.ops.wm.read_factory_settings(use_empty=True)

DESIGNS = {
    'A': dict(name='01 — Dory / The Long Spear', L=88., B=11.8, aft=1, court=False, roof='flat'),
    'B': dict(name='02 — Nereid / The Terraced Flagship', L=84., B=16., aft=2, court=True, roof='awning'),
    'C': dict(name='03 — Hestia / The Sheltered Residence', L=78., B=18.4, aft=2, court=True, roof='tile'),
}
PASS = opt.iteration
if PASS>=2:
    DESIGNS={
        'A':dict(name='Asterion / War flagship',L=90.,B=12.6),
        'B':dict(name='Nereid / Broad residence',L=84.,B=19.2),
        'C':dict(name='Thalassa / Twin-hull court',L=82.,B=23.6),
    }
D = DESIGNS[opt.concept]
L, B = D['L'], D['B']
TWIN=opt.concept=='C' and PASS>=2
HULL_BEAM=6.6 if TWIN else B
HULL_OFFSETS=[-8.5,8.5] if TWIN else [0.]
AUTHOR_Y=0.
M = {}


def material(name, color, rough=.5, metal=0., grain=False, cloth=False):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bs = nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    if grain or cloth:
        geo = nodes.new('ShaderNodeNewGeometry')
        scale = nodes.new('ShaderNodeVectorMath')
        scale.operation = 'MULTIPLY'
        scale.inputs[1].default_value = (.45, 14, 20) if grain else (25, 25, 25)
        links.new(geo.outputs['Position'], scale.inputs[0])
        n = nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = 2
        n.inputs['Detail'].default_value = 3
        n.inputs['Roughness'].default_value = .72
        links.new(scale.outputs[0], n.inputs['Vector'])
        ramp = nodes.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].position = .14
        ramp.color_ramp.elements[0].color = (*(v * .63 for v in color), 1)
        ramp.color_ramp.elements[1].position = .87
        ramp.color_ramp.elements[1].color = (*(min(1, v * 1.22) for v in color), 1)
        links.new(n.outputs['Fac'], ramp.inputs[0])
        links.new(ramp.outputs[0], bs.inputs['Base Color'])
        bump = nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = .15 if grain else .12
        bump.inputs['Distance'].default_value = .025 if grain else .012
        links.new(n.outputs['Fac'], bump.inputs['Height'])
        links.new(bump.outputs[0], bs.inputs['Normal'])
    if cloth:
        bs.inputs['Sheen Weight'].default_value = .22
        bs.inputs['Subsurface Weight'].default_value = .035
    M[name] = m
    return m


HULL_COLOR=(.19,.076,.033) if PASS==1 else {'A':(.027,.023,.020),'B':(.065,.030,.017),'C':(.086,.057,.030)}[opt.concept]
PAINT_COLOR=(.30,.038,.022) if PASS==1 else {'A':(.21,.016,.010),'B':(.24,.035,.018),'C':(.025,.115,.110)}[opt.concept]
material('Cedar | hull', HULL_COLOR, .52, grain=True)
material('Honey teak | deck', (.40, .235, .104) if PASS==1 else (.28, .17, .087), .66, grain=True)
material('Oiled timber | structure', (.12, .044, .022) if PASS==1 else (.060, .027, .014), .46, grain=True)
material('Vermilion | painted wale', PAINT_COLOR, .48)
material('Aged bronze', (.36, .235, .085), .37, .72)
material('Patinated bronze', (.09, .19, .15), .52, .48)
material('Flax linen', (.74, .66, .49), .86, cloth=True)
material('Warm limewash', (.67, .59, .43), .85)
material('Deep shadow', (.019, .015, .012), .8)
material('Hemp rigging', (.17, .119, .065), .95)
material('Oxide terracotta', (.30, .086, .039), .8)
material('Cypress green', (.065, .095, .035), .9)
material('Pale eye', (.82, .76, .58), .55)
material('Sea green | bulwark', (.045, .13, .115), .55)
material('Human ochre', (.55, .29, .09), .85)


class Batch:
    def __init__(self, name, mat, smooth=False):
        self.name, self.mat, self.smooth = name, mat, smooth
        self.v, self.f = [], []

    def face(self, pts):
        i = len(self.v)
        self.v.extend((p[0],p[1]+AUTHOR_Y,p[2]) for p in pts)
        self.f.append(tuple(range(i, i + len(pts))))

    def box(self, c, d):
        x, y, z = c
        a, b, h = (v / 2 for v in d)
        vv = [(x + sx*a, y + sy*b, z + sz*h) for sx,sy,sz in
              [(-1,-1,-1), (1,-1,-1), (1,1,-1), (-1,1,-1),
               (-1,-1,1), (1,-1,1), (1,1,1), (-1,1,1)]]
        for idx in [(0,3,2,1), (4,5,6,7), (0,1,5,4), (1,2,6,5), (2,3,7,6), (3,0,4,7)]:
            self.face([vv[i] for i in idx])

    def rod(self, a, b, r, r2=None, sides=8):
        a, b = Vector(a), Vector(b)
        axis = (b-a).normalized()
        u = axis.cross(Vector((0,0,1)))
        if u.length < .01:
            u = axis.cross(Vector((0,1,0)))
        u.normalize()
        v = axis.cross(u).normalized()
        r2 = r if r2 is None else r2
        p = [a + r*(math.cos(j*math.tau/sides)*u+math.sin(j*math.tau/sides)*v) for j in range(sides)]
        q = [b + r2*(math.cos(j*math.tau/sides)*u+math.sin(j*math.tau/sides)*v) for j in range(sides)]
        for j in range(sides):
            k = (j+1) % sides
            self.face([p[j], p[k], q[k], q[j]])
        self.face(list(reversed(p)))
        self.face(q)

    def path(self, pts, r=.05, sides=6):
        for a, b in zip(pts[:-1], pts[1:]):
            self.rod(a, b, r, sides=sides)

    def build(self):
        if not self.v:
            return
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.v, [], self.f)
        me.update()
        if self.smooth:
            bm=bmesh.new();bm.from_mesh(me)
            bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
            bm.to_mesh(me);bm.free();me.update()
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.collection.objects.link(ob)
        me.materials.append(M[self.mat])
        if self.smooth:
            for p in me.polygons:
                p.use_smooth = True
        return ob


wood = Batch('Longitudinal timber, gallery structure', 'Oiled timber | structure')
deck = Batch('Individual laid deck planks', 'Honey teak | deck')
red = Batch('Continuous vermilion strakes', 'Vermilion | painted wale')
bronze = Batch('Bronze fittings and rails', 'Aged bronze')
rope = Batch('Standing and running hemp rigging', 'Hemp rigging', True)
black = Batch('Recessed gallery and window shadows', 'Deep shadow')
lime = Batch('Accommodation exterior panels', 'Warm limewash')
green = Batch('Sea green screens', 'Sea green | bulwark')
linen = Batch('Folded canvas and awnings', 'Flax linen', True)
all_batches = [wood, deck, red, bronze, rope, black, lime, green, linen]


def smooth(a, b, s):
    t = max(0, min(1, (s-a)/(b-a)))
    return t*t*(3-2*t)


def width(s):
    return HULL_BEAM*.5*max(.001, math.sin(math.pi*s))**.58*(1-.20*smooth(.82,1,s))


def sheer(s):
    return 5.0 + 2.1*s**8 + 3.7*(1-s)**8


def section(s, t, side):
    phi = t * math.pi*.5
    depth = 3.25 * max(.001, math.sin(math.pi*s))**.3 - 4.4*(1-smooth(0,.12,s))
    return ((s-.5)*L,
            side*width(s)*math.sin(phi)**.72,
            -depth + (sheer(s)+depth)*(1-math.cos(phi))**.88)


def side_width(x, z):
    s = max(.001, min(.999, x/L+.5))
    lo, hi = 0, 1
    for _ in range(24):
        t = (lo+hi)*.5
        if section(s,t,1)[2] < z:
            lo = t
        else:
            hi = t
    return section(s,(lo+hi)*.5,1)[1]


def build_hull(offset):
    global AUTHOR_Y
    AUTHOR_Y=offset
    # Curved shell is built in separate close-fitting strakes, leaving real caulking seams.
    hull = Batch('Carvel cedar hull | 24 strakes per side', 'Cedar | hull', True)
    for side in [-1,1]:
        for j in range(24):
            t0, t1 = j/24+.0016, (j+1)/24-.0016
            for i in range(150):
                s0, s1 = .002+.996*i/150, .002+.996*(i+1)/150
                hull.face([section(s0,t0,side), section(s1,t0,side), section(s1,t1,side), section(s0,t1,side)])
    all_batches.append(hull)

    # Dark inner skin closes caulking seams; no daylight can pass through the hull.
    backing=Batch('Continuous inner hull skin', 'Deep shadow',True)
    for side in [-1,1]:
        for i in range(150):
            for j in range(24):
                pts=[section(.002+.996*s/150,t/24,side) for s,t in [(i,j),(i+1,j),(i+1,j+1),(i,j+1)]]
                backing.face([(x,y*.996,z-.025) for x,y,z in pts])
    all_batches.append(backing)

    # A continuous swept deck under the laid boards closes the tapered end pieces.
    for i in range(150):
        s0=.002+.996*i/150;s1=.002+.996*(i+1)/150
        x0=(s0-.5)*L;x1=(s1-.5)*L
        w0=width(s0)-.025;w1=width(s1)-.025
        z0=sheer(s0)+.055;z1=sheer(s1)+.055
        deck.face([(x0,-w0,z0),(x1,-w1,z1),(x1,w1,z1),(x0,w0,z0)])

    # Broad, cambered deck, with each plank trimmed to the actual hull outline.
    for j in range(int(HULL_BEAM/.24)+1):
        y = -HULL_BEAM/2+j*.24+.12
        for i in range(44):
            x = -L/2+(i+.5)*L/44
            s0, s1 = (x-L/88)/L+.5, (x+L/88)/L+.5
            lim = min(width(max(.003,s0)),width(min(.997,s1)))-.12
            if abs(y)+.12 > lim:
                continue
            z0, z1 = sheer(s0)+.10, sheer(s1)+.10
            deck.face([(x-L/88+.012,y-.112,z0),(x+L/88-.012,y-.112,z1),
                       (x+L/88-.012,y+.112,z1),(x-L/88+.012,y+.112,z0)])

    # Wale, gunwale, low bulwark and open gallery rhythms follow the hull rather than a box.
    for side in [-1,1]:
        for dz, rr, batch in [(-.26,.16,red),(-.02,.085,bronze),(-1.03,.11,wood),(-2.05,.09,wood)]:
            pts=[]
            for i in range(121):
                s=.015+.97*i/120
                pts.append(((s-.5)*L,side*(width(s)+.08),sheer(s)+dz))
            batch.path(pts,rr)
        for i in range(39):
            x=-L*.36+i*L*.72/38
            s=x/L+.5
            w=width(s)
            wood.rod((x,side*(w-.1),4.25),(x,side*(w+.93),4.25),.12)
            wood.rod((x,side*(w-.05),3.55),(x,side*(w+.87),4.25),.085)
            red.box((x,side*(w+.94),4.47),(L*.72/38-.025,.13,.40))
            bronze.rod((x-.45,side*(w+1.02),4.66),(x+.45,side*(w+1.02),4.66),.035)
        # Open safety rail at the edge of the main deck, with two horizontal ropes.
        railpts=[[],[]]
        for i in range(66):
            s=.065+.87*i/65
            x=(s-.5)*L; w=width(s)-.17; z=sheer(s)+.18
            if i%2==0:
                wood.rod((x,side*w,z),(x,side*w,z+1.03),.055)
                bronze.rod((x,side*w,z+1.03),(x,side*w,z+1.10),.065)
            for k in range(2):
                railpts[k].append((x,side*w,z+.49+k*.55))
        for p in railpts:
            rope.path(p,.032)

    # Three banks. Separate side ports, leather shadow, oar looms, and flattened blades.
    for side in [-1,1]:
        if TWIN and side != (1 if offset>0 else -1):
            continue
        for bank in range(3):
            for i in range(34):
                x=-L*.315+i*L*.635/33+(bank-1)*.20
                z=1.15+bank*.88
                y=side*(side_width(x,z)+.04)
                black.box((x,y,z),(.48,.10,.30))
                bronze.box((x,y+side*.04,z-.18),(.55,.07,.045))
                start=(x,y+side*.12,z)
                length=6.5+bank*.9
                end=(x-2.15, y+side*length, .38+bank*.06)
                wood.rod(start,end,.105,.075,8)
                # Long narrow spoon at the outer end.
                v=(Vector(end)-Vector(start)).normalized()
                e=Vector(end); a=e-v*1.7; perp=Vector((-v.y,v.x,0))*.23
                deck.face([a-perp*.45,a+perp*.45,e+perp,e-perp])
                bronze.rod(start,Vector(start)+v*.23,.13,sides=8)

    # Stem profile, low bronze forefoot, stern fan, and paired steering oars.
    wood.path([(L*.43,0,1.2),(L*.485,0,2.4),(L*.51,0,5.6),(L*.496,0,8.25),(L*.47,0,8.9)],.29)
    red.path([(L*.43,0,1.2),(L*.485,0,2.4),(L*.51,0,5.6),(L*.496,0,8.25),(L*.47,0,8.9)],.20)
    bronze.rod((L*.435,0,.3),(L*.555,0,.55),.75,.11,12)
    for k in [-1,0,1]:
        bronze.box((L*.53,0,.56+k*.27),(L*.07,1.05,.12))
    for k in range(-2,3):
        pts=[]
        for j in range(31):
            t=j/30
            pts.append((-L*.445-4.2*math.sin(t*math.pi*.72)+1.2*t*t,
                        k*.30*(.3+t), 5.2+8.1*t-2.3*t*t))
        red.path(pts,.16 if k else .23)
        bronze.path([(p[0]-.05,p[1],p[2]+.10) for p in pts],.045)
    for side in [-1,1]:
        a=(-L*.37,side*HULL_BEAM*.32,7.6); b=(-L*.49,side*(HULL_BEAM*.42+2.7),.18)
        wood.rod(a,b,.22,.16,10)
        v=(Vector(b)-Vector(a)).normalized(); e=Vector(b); p=Vector((0,side*.7,0))
        deck.face([e-v*3-p*.4,e-v*3+p*.4,e+p,e-p])

    # Painted almond eyes on the bow. These sit above the water and ahead of the oar run.
    eye=Batch('Apotropaic bow eyes', 'Pale eye')
    pupil=Batch('Eye pupils', 'Deep shadow')
    for side in [-1,1]:
        x=L*.392; z=3.7; y=side*(side_width(x,z)+.10)
        for k in range(48):
            t0=k*math.tau/48; t1=(k+1)*math.tau/48
            eye.face([(x,y,z),(x+1.23*math.cos(t0),y,z+.44*math.sin(t0)),(x+1.23*math.cos(t1),y,z+.44*math.sin(t1))])
            pupil.face([(x+.1,y+side*.025,z),(x+.1+.31*math.cos(t0),y+side*.025,z+.31*math.sin(t0)),(x+.1+.31*math.cos(t1),y+side*.025,z+.31*math.sin(t1))])
    all_batches.extend([eye,pupil])

    AUTHOR_Y=0.

for hull_offset in HULL_OFFSETS:
    build_hull(hull_offset)


def rail_rect(x0,x1,y0,y1,z,skip_front=False):
    for y in [y0,y1]:
        n=max(2,int((x1-x0)/1.35))
        for i in range(n+1):
            x=x0+(x1-x0)*i/n
            wood.rod((x,y,z),(x,y,z+1.0),.055)
        wood.rod((x0,y,z+1),(x1,y,z+1),.065)
        rope.rod((x0,y,z+.5),(x1,y,z+.5),.03)
    for x in [x0,x1]:
        if skip_front and x==x1:
            continue
        n=max(2,int((y1-y0)/1.3))
        for i in range(n+1):
            y=y0+(y1-y0)*i/n
            wood.rod((x,y,z),(x,y,z+1),.055)
        wood.rod((x,y0,z+1),(x,y1,z+1),.065)


def platform(x0,x1,y0,y1,z):
    wood.box(((x0+x1)/2,(y0+y1)/2,z-.17),(x1-x0,y1-y0,.32))
    for j in range(max(1,int((y1-y0)/.23))):
        y=y0+.115+j*.23
        deck.box(((x0+x1)/2,y,z+.015),(x1-x0-.05,.217,.04))
    red.box(((x0+x1)/2,y0,z-.10),(x1-x0,.15,.23))
    red.box(((x0+x1)/2,y1,z-.10),(x1-x0,.15,.23))
    bronze.rod((x0,y0-.02,z+.03),(x1,y0-.02,z+.03),.035)
    bronze.rod((x0,y1+.02,z+.03),(x1,y1+.02,z+.03),.035)


def cabin(x0,x1,y0,y1,z,h,open_front=False):
    # Timber bay construction, deep reveals, shaded openings and exterior shutters.
    lime.box(((x0+x1)/2,(y0+y1)/2,z+h/2),(x1-x0,y1-y0,h))
    for y in [y0-.035,y1+.035]:
        for i in range(int((x1-x0)/1.65)+1):
            x=x0+.32+i*1.65
            if x>x1-.25:continue
            wood.box((x,y,z+h/2),(.14,.12,h+.12))
            black.box((x+.78,y+(.09 if y>0 else -.09),z+h*.57),(.96,.08,h*.56))
            for k in range(5):
                wood.box((x+.78,y+(.15 if y>0 else -.15),z+h*.31+k*h*.105),(.96,.07,.065))
            # Paired deep red half shutters, a repeated domestic scale cue.
            red.box((x+.15,y+(.17 if y>0 else -.17),z+h*.57),(.18,.09,h*.59))
        wood.box(((x0+x1)/2,y,z+.20),(x1-x0,.15,.25))
        wood.box(((x0+x1)/2,y,z+h-.10),(x1-x0,.18,.21))
    for x in [x0,x1]:
        wood.box((x,(y0+y1)/2,z+h-.10),(.16,y1-y0,.21))
        for y in [y0,y1]:
            wood.box((x,y,z+h/2),(.20,.20,h+.15))
    if open_front:
        for y in [-1.0,1.0]:
            black.box((x1+.06,y,z+h*.44),(.08,1.4,h*.85))


def awning(x0,x1,y0,y1,z,sag=.45):
    # Tensioned canvas with scalloped ends, hems and rope lashings.
    for x in [x0,x1]:
        for y in [y0,y1]:
            wood.rod((x,y,z-2.1),(x,y,z+.15),.085)
            bronze.rod((x,y,z+.15),(x,y,z+.25),.095)
    nx,ny=24,16
    def p(u,v):
        return (x0+(x1-x0)*u,y0+(y1-y0)*v,
                z-sag*math.sin(math.pi*v)+.08*math.sin(u*math.tau*7)*math.sin(math.pi*v))
    for i in range(nx):
        for j in range(ny):
            linen.face([p(i/nx,j/ny),p((i+1)/nx,j/ny),p((i+1)/nx,(j+1)/ny),p(i/nx,(j+1)/ny)])
    for u in [0,1]:
        rope.path([p(u,j/ny) for j in range(ny+1)],.045)
    for v in [0,1]:
        rope.path([p(i/nx,v) for i in range(nx+1)],.045)
    for i in range(9):
        u=i/8
        rope.rod(p(u,0),(x0+(x1-x0)*u,y0-.35,z-.4),.025)
        rope.rod(p(u,1),(x0+(x1-x0)*u,y1+.35,z-.4),.025)


def open_gallery(x0,x1,y,h,z,side):
    """A genuinely open exterior timber arcade, with low wind screens."""
    platform(x0,x1,y-h/2,y+h/2,z+2.45)
    n=int((x1-x0)/2.0)
    for i in range(n+1):
        x=x0+(x1-x0)*i/n
        for yy in [y-h/2,y+h/2]:
            wood.rod((x,yy,z),(x,yy,z+2.45),.095,sides=10)
            wood.rod((x,yy,z+1.85),(x+.48,yy,z+2.42),.06)
            wood.rod((x,yy,z+1.85),(x-.48,yy,z+2.42),.06)
    yy=y+side*h/2
    green.box(((x0+x1)/2,yy,z+.45),(x1-x0,.12,.85))
    bronze.rod((x0,yy+side*.08,z+.9),(x1,yy+side*.08,z+.9),.04)
    for i in range(n):
        x=x0+(x1-x0)*(i+.5)/n
        wood.box((x,yy+side*.07,z+.43),((x1-x0)/n-.24,.06,.56))
    rail_rect(x0,x1,y-h/2,y+h/2,z+2.45)


def stair(x0,x1,y,w,z0,z1):
    n=14
    for i in range(n):
        x=x0+(x1-x0)*(i+.5)/n
        z=z0+(z1-z0)*(i+1)/n
        deck.box((x,y,z-.08),(abs(x1-x0)/n+.015,w,.16))
    for side in [-1,1]:
        yy=y+side*w*.51
        wood.rod((x0,yy,z0-.2),(x1,yy,z1-.2),.11)
        for i in range(0,n+1,2):
            t=i/n
            wood.rod((x0+(x1-x0)*t,yy,z0+(z1-z0)*t),(x0+(x1-x0)*t,yy,z0+(z1-z0)*t+.95),.05)
        rope.rod((x0,yy,z0+.95),(x1,yy,z1+.95),.045)


# Revised brief: three members of the terraced-flagship family, before a direction is chosen.
if PASS>=2:
    if opt.concept=='A':
        platform(-32,6,-4.3,4.3,5.5)
        cabin(-30,-15,-3.45,3.45,5.52,2.45,True)
        platform(-30.4,-13.5,-3.85,3.85,8.12)
        rail_rect(-30.4,-13.5,-3.85,3.85,8.12,True)
        for side in [-1,1]:
            open_gallery(-15,3,side*3.15,1.6,5.52,side)
            stair(8,2,side*4.2,1.0,5.5,8.0)
        awning(-28,-20,-3.45,3.45,10.5,.35)
        awning(-11,1,-2.1,2.1,8.4,.35)
        stair(-7,-14,-2.6,1.05,5.5,8.12)
        # Bronze-faced shields make the martial version legible at silhouette distance.
        for side in [-1,1]:
            for x in [-25,-18,-11,-4,3,10,17,24]:
                y=side*(width(x/L+.5)+.92)
                bronze.rod((x,y,4.85),(x,y+side*.16,4.85),.48,sides=24)
                red.rod((x,y+side*.17,4.85),(x,y+side*.19,4.85),.32,sides=24)
                bronze.rod((x,y+side*.19,4.85),(x,y+side*.30,4.85),.13,sides=16)
    elif opt.concept=='B':
        platform(-30,9,-7.1,7.1,5.5)
        cabin(-29,-15,-5.9,5.9,5.52,3.0,True)
        platform(-29.5,-13.8,-6.35,6.35,8.68)
        rail_rect(-29.5,-13.8,-6.35,6.35,8.68,True)
        for side in [-1,1]:
            open_gallery(-15,5,side*5.7,2.4,5.52,side)
            stair(10,3.5,side*6.5,1.2,5.5,8.0)
        cabin(-27,-19,-3.55,3.55,8.70,2.35,True)
        platform(-27.4,-18.4,-3.9,3.9,11.20)
        rail_rect(-27.4,-18.4,-3.9,3.9,11.20)
        awning(-27,-19,-3.75,3.75,13.4,.4)
        awning(-11,3,-4.0,4.0,8.9,.7)
        stair(-6,-14,-4.2,1.35,5.5,8.68)
        # A shaded veranda below the raised pavilion, rather than another enclosed storey.
        awning(-18,-14.5,-5.2,5.2,11.0,.4)
    else:
        platform(-29,30,-10.65,10.65,5.55)
        # Express the structure that ties the two hulls together.
        for x in [-27,-19,-11,-3,5,13,21,28]:
            wood.box((x,0,4.9),(.48,22,.85))
            for side in [-1,1]:
                wood.rod((x,side*8.5,3.8),(x,side*4.5,5.2),.16)
        for offset in HULL_OFFSETS:
            cabin(-27,-13,offset-2.2,offset+2.2,5.57,2.85,True)
            platform(-28,-11.5,offset-2.65,offset+2.65,8.6)
            rail_rect(-28,-11.5,offset-2.65,offset+2.65,8.6)
            awning(-25,-16,offset-2.3,offset+2.3,10.9,.3)
            stair(-5,-12,offset,1.25,5.55,8.6)
        platform(-26,-21,-6.2,6.2,8.6)
        rail_rect(-26,-21,-6.2,6.2,8.6)
        platform(-14,-10,-6.2,6.2,8.6)
        rail_rect(-14,-10,-6.2,6.2,8.6)
        awning(-7,6,-6.0,6.0,9.0,.75)
        for y in [-10.6,10.6]:
            rail_rect(-9,28,y-.03,y+.03,5.6)
        # The forward bridge terrace frames a central space without a central tower.
        platform(10,14,-10.5,10.5,8.0)
        rail_rect(10,14,-10.5,10.5,8.0)
        for y in [-10,-6,-2,2,6,10]:
            wood.rod((11,y,5.55),(11,y,8.0),.11)
        stair(20,14,-7,1.3,5.55,8.0)
elif opt.concept=='A':
    platform(-32,-8,-3.65,3.65,5.5)
    cabin(-29,-12,-2.8,2.8,5.52,2.7,True)
    platform(-30,-10,-3.15,3.15,8.34)
    rail_rect(-30,-10,-3.15,3.15,8.34)
    awning(-27,-16,-2.6,2.6,10.5,.35)
    stair(-6,-12,-3.7,1.25,5.4,8.34)
    awning(-4,11,-3.6,3.6,7.8,.45)
elif opt.concept=='B':
    platform(-30,8,-5.8,5.8,5.5)
    cabin(-29,-11 if PASS==1 else -15,-4.7,4.7,5.52,2.9,True)
    platform(-29.5,-9.8 if PASS==1 else -13.8,-5.15,5.15,8.58)
    rail_rect(-29.5,-9.8 if PASS==1 else -13.8,-5.15,5.15,8.58,True)
    # Flanking wings create a sheltered open court, visible from the exterior.
    for side in [-1,1]:
        if PASS==1:
            cabin(-11,5,side*4.7-1.0,side*4.7+1.0,5.52,2.4)
            platform(-11,5,side*4.7-1.1,side*4.7+1.1,8.04)
            rail_rect(-11,5,side*4.7-1.1,side*4.7+1.1,8.04)
        else:
            open_gallery(-15,5,side*4.7,2.2,5.52,side)
        stair(9,3,side*5.6,1.15,5.5,8.04)
    if PASS==1:
        awning(-27,-17,-4.4,4.4,11.0,.55)
    awning(-9,3,-3.35,3.35,8.55,.62)
    if PASS>=2:
        # Compress the aft silhouette and strengthen the line of the open galleries.
        cabin(-27,-20,-2.65,2.65,8.60,2.20,True)
        platform(-27.3,-19.5,-3.0,3.0,10.96)
        rail_rect(-27.3,-19.5,-3,3,10.96)
        awning(-27,-20,-2.85,2.85,13.15,.35)
        # Exterior stair to the principal terrace, outside the accommodation.
        stair(-5,-11,-4.0,1.25,5.5,8.58)
else:
    platform(-29,15,-6.9,6.9,5.55)
    cabin(-28,-9,-5.5,5.5,5.57,3.15,True)
    for side in [-1,1]:
        cabin(-9,13,side*5.2-1.1,side*5.2+1.1,5.57,3.15)
        awning(-8,12,side*4.2-1.2,side*4.2+1.2,9.05,.24)
    platform(-28,-9,-5.7,5.7,8.90)
    rail_rect(-28,-9,-5.7,5.7,8.90)
    awning(-26,-13,-5,5,11.4,.5)
    tiles=Batch('Low pitched terracotta roof', 'Oxide terracotta')
    for side in [-1,1]:
        for i in range(51):
            x=-28+i*.38
            for j in range(12):
                y=side*j*.46
                z=10.1-abs(y)*.19
                tiles.box((x,y,z),(.37,.49,.13))
    all_batches.append(tiles)
    stair(18,11,-5.1,1.4,5.55,8.9)


def mast(x,h,span,deploy):
    base=5.2
    wood.rod((x,0,base),(x,0,base+h),.38,.20,14)
    for z in [base+.7,base+1.7,base+h-1.0]:
        bronze.rod((x,0,z),(x,0,z+.14),.40 if z<8 else .23,sides=14)
    top=base+h-1.2
    wood.rod((x,-span*.5,top),(x,span*.5,top),.15,.15,12)
    # Cloth shape with reefed foot and stitched vertical panel lines.
    nu,nv=40,14
    def p(u,v):
        return (x+deploy*.28*math.sin(math.pi*u)*math.sin(math.pi*v),
                (u-.5)*span*(1-.12*v),
                top-v*deploy+.16*math.sin(u*math.pi*12)*v*v)
    for i in range(nu):
        for j in range(nv):
            linen.face([p(i/nu,j/nv),p((i+1)/nu,j/nv),p((i+1)/nu,(j+1)/nv),p(i/nu,(j+1)/nv)])
    for k in range(13):
        rope.path([p(k/12,j/14) for j in range(15)],.018)
    rope.path([p(i/40,1) for i in range(41)],.045)
    for side in [-1,1]:
        a=(x,side*span*.5,top)
        rope.rod(a,(x,0,base+h-.1),.04)
        rope.rod(a,(x-3.5,side*B*.35,5.5),.035)
        # Shrouds with ratlines, placed away from the accommodation.
        for j in range(4):
            foot=(x-2.8+j*1.65,side*(B*.5-.5),5.4)
            rope.rod((x,0,base+h-2.0),foot,.052)
        for i in range(1,23):
            t=i/24
            z=5.4+(h-2)*t
            yy=side*(B*.5-.5)*(1-t)
            rope.rod((x-2.8*(1-t),yy,z),(x+2.15*(1-t),yy,z),.019)
    rope.rod((x,0,base+h),(L*.43,0,7.4),.062)
    rope.rod((x,0,base+h),(-L*.38,0,8.0),.062)
    # Small, weathered red pennant.
    red.face([(x,0,base+h),(x-3.6,.12,base+h-.36),(x,0,base+h-.85)])


mast(11,24,21,2.5 if PASS==1 else {'A':6.0,'B':4.2,'C':5.0}[opt.concept])
mast(-14,19,16,1.8 if PASS==1 else 2.8)
if opt.concept=='A' and PASS==1:
    mast(31,13,11,1.0)


def tender(center, length=7.3, beam=2.15, afloat=False):
    cx,cy,cz=center
    small=Batch('Cedar tender '+str(center), 'Honey teak | deck',True)
    for side in [-1,1]:
        for i in range(24):
            for j in range(7):
                def p(s,t):
                    return (cx+(s-.5)*length,cy+side*beam*.5*math.sin(math.pi*s)**.55*math.sin(t*math.pi*.5),
                            cz-.6+.95*(1-math.cos(t*math.pi*.5))+.48*abs(2*s-1)**4)
                s0=.001+.998*i/24;s1=.001+.998*(i+1)/24
                small.face([p(s0,j/7),p(s1,j/7),p(s1,(j+1)/7),p(s0,(j+1)/7)])
        small.path([(cx+(s-.5)*length,cy+side*beam*.5*math.sin(math.pi*s)**.55,cz+.35+.48*abs(2*s-1)**4) for s in [i/40 for i in range(41)]],.07)
    for xx in [-2,-.5,1,2.2]:
        small.box((cx+xx,cy,cz+.08),(.26,beam*.78,.09))
    all_batches.append(small)


# Tender storage, embarkation landing and ordinary deck fittings make the scale legible.
tender((21,-2.2,6.05))
for x in [18.5,23.5]:
    wood.box((x,-2.2,5.6),(.25,2.1,.30))
    rope.rod((x,-3.2,5.6),(x,-1.2,6.65),.045)
platform(-16,-7,-B*.5-1.5,-B*.5+.3,4.9)
stair(-3,-8,-B*.5+.1,1.2,5.5,4.9)
for x in [-15,-8]:
    wood.rod((x,-B*.5+.3,5.5),(x,-B*.5-1.45,4.7),.15)
    rope.rod((x,-B*.5-1.3,4.9),(x,-B*.5-1.3,5.85),.035)
tender((-11,-B*.5-4.0,.5),6.8,2.0,True)
rope.path([(-11,-B*.5-1.3,4.9),(-11,-B*.5-2.0,2.8),(-11,-B*.5-3.3,.85)],.035)
for x,y in [(28,1.8),(30,-1.6),(-33,1.8),(-33,-1.8)]:
    wood.rod((x,y,5.6),(x,y,6.5),.16,sides=10)
    wood.rod((x,y-.5,6.25),(x,y+.5,6.25),.10,sides=8)
    for k in range(4):
        pts=[(x+.3*math.cos(t*math.tau/30),y+.3*math.sin(t*math.tau/30),5.7+k*.055) for t in range(31)]
        rope.path(pts,.03)
for x in [26,32]:
    bronze.rod((x,0,5.5),(x,0,6.6),.30,sides=12)
    wood.rod((x,-1.2,6.3),(x,1.2,6.3),.075,sides=8)

# Small amphora clusters and exterior benches, not an interior layout.
pot=Batch('Deck amphorae', 'Oxide terracotta',True)
for x,y in [(25,4),(25,4.6),(-7,2.5),(-7,3.1),(-9,2.6)]:
    z=5.55
    pot.rod((x,y,z),(x,y,z+.75),.24,.13,12)
    pot.rod((x,y,z+.75),(x,y,z+.95),.09,.12,12)
    for side in [-1,1]:
        pot.path([(x,y+side*.10,z+.85),(x,y+side*.30,z+.72),(x,y+side*.29,z+.5)],.035)
all_batches.append(pot)

# Sparse 1.75m human scale references with garments, limbs and heads.
people=Batch('People | 1.75m scale', 'Flax linen',True)
skin=Batch('People | skin', 'Human ochre',True)
def person(x,y,z,turn=0):
    people.rod((x,y,z+.65),(x,y,z+1.4),.23,.17,10)
    skin.rod((x,y,z+1.41),(x,y,z+1.69),.13,.13,10)
    for side in [-1,1]:
        skin.rod((x,y+side*.12,z+.03),(x,y+side*.12,z+.7),.063,.075)
        skin.rod((x,y+side*.19,z+1.30),(x+.08,y+side*.31,z+.83),.058,.05)
person(29,-2,5.6)
person(17,3.9,5.45)
person(-16,-5.2,8.62 if opt.concept=='B' else 5.6)
person(-10,-B*.5-.6,4.93)
person(-24,0,8.65) if TWIN else person(-31,0,6.0)
all_batches += [people,skin]

# Consolidated semantic meshes keep the editable .blend light and comprehensible.
for batch in all_batches:
    batch.build()

# Real 3D water surface: large swells, smaller crossed ripples and procedural reflection.
water=bpy.data.materials.new('Mediterranean | layered seawater')
water.use_nodes=True
nodes,links=water.node_tree.nodes,water.node_tree.links
bs=nodes.get('Principled BSDF')
bs.inputs['Base Color'].default_value=(.012,.085,.10,1)
bs.inputs['Metallic'].default_value=.18
bs.inputs['Roughness'].default_value=.21
bs.inputs['IOR'].default_value=1.333
bs.inputs['Transmission Weight'].default_value=.15
geo=nodes.new('ShaderNodeNewGeometry')
n=nodes.new('ShaderNodeTexNoise');n.inputs['Scale'].default_value=2.0;n.inputs['Detail'].default_value=3
links.new(geo.outputs['Position'],n.inputs['Vector'])
bump=nodes.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.28;bump.inputs['Distance'].default_value=.16
links.new(n.outputs['Fac'],bump.inputs['Height']);links.new(bump.outputs[0],bs.inputs['Normal'])
me=bpy.data.meshes.new('Sea surface')
vs=[];fs=[];N=200;size=1100
for j in range(N+1):
    for i in range(N+1):
        x=(i/N-.5)*size;y=(j/N-.5)*size
        if i in (0,N):x*=180
        if j in (0,N):y*=180
        z=-.12+.12*math.sin(.22*x+.15*y)+.055*math.sin(.7*x-.34*y)
        vs.append((x,y,z))
for j in range(N):
    for i in range(N):
        a=j*(N+1)+i;fs.append((a,a+1,a+N+2,a+N+1))
me.from_pydata(vs,[],fs);me.update();ob=bpy.data.objects.new('Open sea',me);bpy.context.collection.objects.link(ob);me.materials.append(water)
for p in me.polygons:p.use_smooth=True

# Lighting deliberately reveals structure: broad sky, warm raking sun, no bloom.
world=bpy.data.worlds.new('Marine daylight');bpy.context.scene.world=world;world.use_nodes=True
wn=world.node_tree.nodes;wl=world.node_tree.links
sky=wn.new('ShaderNodeTexSky');sky.sky_type='MULTIPLE_SCATTERING' if bpy.app.version >= (5,0,0) else 'NISHITA';sky.sun_elevation=math.radians(24);sky.sun_rotation=math.radians(138)
sky.altitude=.05;sky.air_density=1.2
setattr(sky,'aerosol_density' if hasattr(sky,'aerosol_density') else 'dust_density',1.8)
wl.new(sky.outputs[0],wn.get('Background').inputs['Color']);wn.get('Background').inputs['Strength'].default_value=.30
def area(name,pos,energy,size,color):
    ld=bpy.data.lights.new(name,'AREA');ld.energy=energy;ld.shape='DISK';ld.size=size;ld.color=color
    ob=bpy.data.objects.new(name,ld);bpy.context.collection.objects.link(ob);ob.location=pos;ob.rotation_euler=(Vector((0,0,4))-ob.location).to_track_quat('-Z','Y').to_euler()
area('Soft marine sky fill',(10,-35,50),18000,50,(.63,.79,1))
sd=bpy.data.lights.new('Low afternoon sun','SUN');sd.energy=2.2;sd.angle=math.radians(5);sd.color=(1,.81,.59)
so=bpy.data.objects.new('Low afternoon sun',sd);bpy.context.collection.objects.link(so);so.rotation_euler=(math.radians(29),math.radians(-24),math.radians(-32))

scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=opt.samples or (80 if opt.quality=='final' else 24)
scene.cycles.use_denoising=True
scene.cycles.max_bounces=7
scene.cycles.diffuse_bounces=3
scene.cycles.glossy_bounces=4
scene.cycles.transmission_bounces=4
try:
    prefs=bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type='METAL';prefs.get_devices()
    for device in prefs.devices:device.use=device.type=='METAL'
    scene.cycles.device='GPU'
except Exception as exc:
    print('METAL_FALLBACK',exc,flush=True);scene.cycles.device='CPU'
scene.render.resolution_x=2000 if opt.quality=='final' else 1200
scene.render.resolution_y=1300 if opt.quality=='final' else 800
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.view_settings.exposure=-.25 if PASS==1 else -1.35
scene.render.film_transparent=False

VIEWS={
    'hero': ((90,-114,65),(0,0,8.5),52),
    'stern': ((-83,-98,48),(-9,0,7.8),55),
    'profile': ((7,-155,25),(0,0,10.0),56),
    'deck': ((-40,-41,27),(-10,0,7.5),49),
    'bow': ((58,-36,15),(23,0,5.5),47),
}
for view,(pos,target,lens) in VIEWS.items():
    camdata=bpy.data.cameras.new('Camera | '+view);cam=bpy.data.objects.new('Camera | '+view,camdata);bpy.context.collection.objects.link(cam)
    cam.location=pos;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();camdata.lens=lens;camdata.clip_end=200000
    if view==opt.view:scene.camera=cam
scene.unit_settings.system='METRIC'
scene['Study']='Trireme descendant / exterior concept only'
scene['Concept']=D['name'];scene['Iteration']=PASS;scene['Hull length (m)']=L;scene['Hull beam (m)']=B
scene['Engineering status']='Visual proportions only; no naval-architecture or rowing feasibility claim'
for area_ in bpy.context.screen.areas:
    if area_.type=='VIEW_3D':
        area_.spaces.active.region_3d.view_perspective='CAMERA'

folder=ROOT/'renders'/{1:'01-directions',2:'02-terraced-variants',3:'03-detail',4:'04-review',5:'05-final'}[PASS]
folder.mkdir(parents=True,exist_ok=True)
stem=f'{opt.concept.lower()}-p{PASS:02d}-{opt.view}'
scene.render.filepath=str(folder/(stem+'.png'))
blend=ROOT/'blender'/(f'{opt.concept.lower()}-terraced.blend' if PASS==2 else f'{opt.concept.lower()}-p{PASS:02d}.blend')
bpy.ops.wm.save_as_mainfile(filepath=str(blend))
print('STUDY_SAVED',blend,flush=True)
if not opt.save_only:
    bpy.ops.render.render(write_still=True)
    print('RENDER_SAVED',scene.render.filepath,flush=True)
summary=dict(concept=opt.concept,iteration=PASS,view=opt.view,length=L,beam=B,
             objects=len(scene.objects),vertices=sum(len(o.data.vertices) for o in scene.objects if o.type=='MESH'),
             blend=str(blend),render=scene.render.filepath)
(folder/(stem+'.json')).write_text(json.dumps(summary,indent=2))
