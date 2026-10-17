# Boat geometry recipe; executed in authoring namespace by build_kit.py.
# Length along X, sheer rises toward each end; plank strakes are continuous geometry.
length=17
for side in [-1,1]:
    for band in range(9):
        va=band/9;vb=(band+1)/9
        band_color=tint(.76,.97)
        for j in range(36):
            xa=-length/2+length*j/36;xb=-length/2+length*(j+1)/36
            def hull(x,t):
                u=x/(length/2);beam=2.35*max(.025,1-u*u)**.52
                return (x,side*beam*math.sin(t*math.pi/2),-.50+1.95*t+abs(u)**5*.80)
            p=[hull(xa,va+.0007),hull(xb,va+.0007),hull(xb,vb-.0007),hull(xa,vb-.0007)]
            if side>0:p.reverse()
            col=band_color
            mb('wood','hull').face(p,col,[(q[2]*2.4,q[0]/3) for q in p])
            inner=[(q[0],q[1]-side*.065,q[2]+.025) for q in p]
            mb('wood','hull').face(list(reversed(inner)),tuple(v*.88 for v in col),[(q[2]*2.4,q[0]/3) for q in reversed(inner)])
            for edge in range(4):
                if edge in (1,3) and j not in (0,35):continue
                nxt=(edge+1)%4
                mb('darkwood').face([p[edge],inner[edge],inner[nxt],p[nxt]],(.52,.47,.39))
    points=[]
    for j in range(61):
        x=-length/2+length*j/60;u=x/(length/2);points.append((x,side*2.35*max(.025,1-u*u)**.52,1.47+abs(u)**5*.8))
    tube(points,.085,'darkwood',8,color=(.55,.6,.55))
# Frames rise inside the planking; their feet sit below the working deck.
for x in [-7.5+i*.75 for i in range(21)]:
    u=x/(length/2);beam=2.35*max(.025,1-u*u)**.52
    for side in [-1,1]:
        points=[]
        for j in range(17):
            t=.74+j/16*.25
            points.append((x,side*(beam*math.sin(t*math.pi/2)-.12),-.50+1.95*t+abs(u)**5*.80))
        tube(points,.055,'darkwood',6,color=(.63,.55,.44))
    if abs(x)<7:
        for side in [-1,1]:
            y=side*(beam-.12);zz=1.47+abs(u)**5*.8
            tube([(x,y,zz-.04),(x,y,zz+.055)],.018,'wood',8,color=(.45,.37,.26))
# Curved solid stem and sternpost close the plank ends and carry the sheer.
for sign in [-1,1]:
    tube([(sign*8.2,0,-.03),(sign*8.5,0,.55),(sign*8.58,0,1.55),(sign*8.68,0,2.25),(sign*8.52,0,2.63),(sign*8.28,0,2.82)],.14,'darkwood',12,color=(.63,.55,.44))
    for side in [-1,1]:
        tube([(sign*8.15,side*.56,2.10),(sign*8.48,side*.28,2.24),(sign*8.64,0,2.30)],.095,'darkwood',10)
def inside_width(x,z):
    u=x/8.5;t=max(0,min(1,(z+.50-abs(u)**5*.80)/1.95))
    return max(.1,2*(2.35*max(.025,1-u*u)**.52*math.sin(t*math.pi/2)-.13))
for k in range(31):
    x=-7.75+k*.5;width=min(inside_width(x-.238,.93),inside_width(x+.238,.93))
    box((x,0,.99),(.475,width,.12),'wood',.018,color=tint(.83,1.13))
for x in [-6,-3,0,3,6]:
    width=min(inside_width(x-.11,1.185),inside_width(x+.11,1.185))
    box((x,0,1.26),(.22,width,.15),'wood',.02)
# Boarding saddles sit above the gunwale, with two inboard steps to the deck.
# Clear of the cargo groups; both sides can receive the reusable gangplank.
for side in [-1,1]:
    for j in range(4):box((4.7,side*(1.05+j*.25),1.615),(1.25,.235,.11),'wood',.018)
    for xx in [4.23,5.17]:box((xx,side*1.42,1.34),(.12,.90,.54),'darkwood',.016)
    box((4.7,side*.73,1.40),(1.25,.33,.10),'wood',.018)
    box((4.7,side*.39,1.19),(1.25,.33,.10),'wood',.018)
# Mast partners, belaying pins and a tapered yard supporting a bundled sail.
box((-1,0,1.10),(.65,.65,.22),'darkwood',.04)
for yy in [-.32,.32]:box((-1,yy,1.23),(.60,.10,.17),'wood',.02)
tube([(-1,0,.95),(-1,0,7.7)],.12,'wood',16)
tube([(-1,-3.2,6.35),(-1,3.2,6.35)],.075,'wood',12)
for side in [-1,1]:
    box((-1,side*.48,1.53),(1.2,.16,.15),'wood',.025)
    for xx in [-1.4,-1,-.6]:
        tube([(xx,side*.48,1.36),(xx,side*.48,1.78)],.028,'darkwood',10)
        lathe((xx,side*.48,1.76),[(0,.037),(.06,.043),(.09,.025)],'wood',12)
# Uneven cloth folds run along the furled sail; tie-downs compress its profile.
cloth=mb('cloth');segments=96;around=20
def sail_point(i,j):
    t=i/segments;y=-3.12+6.24*t;a=j/around*math.tau
    bulge=.13+.065*math.sin(t*math.pi)+.025*math.sin(t*math.tau*7)
    fold=.022*math.cos(a*7+t*8)
    return (-1+(bulge+fold)*math.cos(a),y,6.53+(bulge+fold)*math.sin(a))
for i in range(segments):
    for j in range(around):
        cloth.face([sail_point(i,j),sail_point(i+1,j),sail_point(i+1,j+1),sail_point(i,j+1)],(.89,.84,.71))
for yy in [-2.9,-2.15,-1.3,-.45,.45,1.3,2.15,2.9]:
    t=(yy+3.12)/6.24;r=.14+.065*math.sin(t*math.pi)+.025*math.sin(t*math.tau*7)+.025
    tube([(-1+r*math.cos(j*math.tau/32),yy,6.53+r*math.sin(j*math.tau/32)) for j in range(33)],.014,'rope',6)
    tube([(-1,yy,6.35),(-1.06,yy,6.20),(-.97,yy,6.12)],.013,'rope',6)
for yy in [-1.85,1.85]:tube([(-1,yy,1.55),(-1,0,7.6)],.024,'rope',6)
for xx in [-7,7]:tube([(xx,0,1.85),(-1,0,7.6)],.024,'rope',6)
# Wooden blocks and halyard fall, visibly attached to mast and belaying rail.
for xx,yy,zz in [(-1,.20,7.25),(-1,.28,6.18)]:
    lathe((xx,yy,zz),[(0,.07),(.03,.11),(.17,.11),(.20,.065)],'darkwood',16)
tube([(-1,.2,6.28),(-1,.2,7.32),(-.85,.32,7.35),(-.72,.48,1.72)],.015,'rope',8)
rope_coil(-.2,.7,1.08,.26)
for xx in [-4,-3.4,-2.8,2,2.6,3.2]:
    for yy in [-.6,.1,.8]:jar(xx,yy,1.11,.64)
for xx in [-6,6]:
    box((xx,1.75,1.62),(.55,.12,.12),'wood',.025)
    rope_coil(xx-.3,1,1.10,.30)
# Cargo dunnage and low timber retainers keep jars in orderly working groups.
for xx in [-3.4,2.6]:
    for yy in [-.88,1.08]:box((xx,yy,1.29),(2.05,.07,.28),'wood',.018,color=(.70,.63,.50))
    for dx in [-1.02,1.02]:box((xx+dx,.1,1.29),(.07,2,.28),'wood',.018,color=(.70,.63,.50))
# Quarter steering oar with a shaped blade, timber bearing and rope strop.
box((6.15,-1.48,1.53),(.65,.26,.18),'darkwood',.03)
tube([(5.5,-1.1,2.0),(6.45,-1.9,1.15),(7.4,-2.65,-.65)],.066,'wood',12)
blade=[(7.13,-2.64,-.32),(7.51,-2.89,-1.17),(7.95,-2.67,-1.24),(7.63,-2.43,-.38)]
mb('wood').face(blade,(.66,.56,.42));mb('wood').face(list(reversed([(x,y+.07,z) for x,y,z in blade])),(.61,.52,.39))
for j in range(4):
    z=1.35+j*.028;tube([(6.3+.18*math.cos(t*math.tau/24),-1.78+.18*math.sin(t*math.tau/24),z) for t in range(25)],.015,'rope',6)
for yy in [.85,1.05]:tube([(3.9,yy,1.43),(7.0,yy,1.62)],.035,'wood',10)
