"""Game-coordinate Kyrenia shell. Physics offsets are authoritative; decorative timber is inboard."""
import json, math, bisect
from pathlib import Path
C=json.loads((Path(__file__).resolve().parents[2]/'contracts/game-merchant.json').read_text())
O=C['hull']['offsets']; S=O['stations']; ss=[p['s'] for p in S]; L=O['length']
def section(s,t):
    i=max(0,min(len(S)-2,bisect.bisect_right(ss,s)-1));w=(s-ss[i])/(ss[i+1]-ss[i]);n=len(S[0]['pts'])//2
    u=max(0,min(1,t))*(n-1);k=min(int(u),n-2);f=u-k
    return tuple((S[i]['pts'][2*k+c]*(1-f)+S[i]['pts'][2*k+2+c]*f)*(1-w)+(S[i+1]['pts'][2*k+c]*(1-f)+S[i+1]['pts'][2*k+2+c]*f)*w for c in (0,1))
def ydeck(s):return section(s,1)[1]-.3
def width(s,y):
    lo,hi=0,1
    for _ in range(24):
        m=(lo+hi)/2
        if section(s,m)[1]<y:lo=m
        else:hi=m
    return section(s,(lo+hi)/2)[0]
def point(s,t,side):
    x,z=section(s,t);return (side*x,L*(.5-s),z)
def build(a):
    # Continuous exterior: no open seams or arbitrary reshaping of the underwater hull.
    stations=sorted(set(ss+[i/160 for i in range(161)]))
    for side in (-1,1):
        for band in range(16):
            color=(.80+band*.007,.78+band*.006,.73+band*.005)
            for k in range(4):
                t0=(band+k/4)/16;t1=(band+(k+1)/4)/16
                for s0,s1 in zip(stations,stations[1:]):
                    p=[point(s0,t0,side),point(s1,t0,side),point(s1,t1,side),point(s0,t1,side)]
                    if side>0:p.reverse()
                    a.mb('wood','hull').face(p,color,[(q[2]*2.4,q[1]/3) for q in p])
        # Inner lining continues below the deck: an open hatch must reveal a hold,
        # not the backface-culled exterior and the inspection ground beyond it.
        for j in range(32):
            for s0,s1 in zip(stations,stations[1:]):
                p=[]
                for s,t in [(s0,j/32),(s1,j/32),(s1,(j+1)/32),(s0,(j+1)/32)]:
                    x,y=section(s,t);p.append((side*max(0,x-.065),L*(.5-s),y+.012*(1-t)))
                if side<0:p.reverse()
                a.mb('wood','lining').face(p,(.76,.72,.65),[(q[2]*2.4,q[1]/3) for q in p])
        a.tube([(side*section(s,1)[0],L*(.5-s),section(s,1)[1]+.03) for s in stations if .02<=s<=.98],.045,'darkwood',8,color=(.71,.69,.62))
    for s0,s1 in zip(stations,stations[1:]):
        p=[point(s0,0,-1),point(s1,0,-1),point(s1,0,1),point(s0,0,1)]
        a.mb('wood','keel').face(list(reversed(p)),(.72,.69,.63))
    for s in (0,1):
        for j in range(64):
            p=[point(s,j/64,-1),point(s,j/64,1),point(s,(j+1)/64,1),point(s,(j+1)/64,-1)]
            if s==0:p.reverse()
            a.mb('wood','end').face(p,(.75,.71,.65))
    # Flush deck with genuine open hatch rectangles, no decorative cargo obstruction.
    rows=sorted(set([.06+i*(.93-.06)/96 for i in range(97)]+[h[k] for h in C['cargo']['hatches'] for k in ('s0','s1')]))
    hw=C['cargo']['hatchHalfWidth']
    for s0,s1 in zip(rows,rows[1:]):
        hatch=any(s0>=h['s0']-1e-9 and s1<=h['s1']+1e-9 for h in C['cargo']['hatches'])
        for j in range(24):
            x0=-2.4+j*.2;x1=x0+.2
            # Insert exact hatch edges into plank intervals.
            edges=sorted(set([x0,x1]+[x for x in (-hw,hw) if x0<x<x1]))
            for l,r in zip(edges,edges[1:]):
                if hatch and l>=-hw-1e-9 and r<=hw+1e-9:continue
                p=[]
                for s,x in [(s0,l),(s0,r),(s1,r),(s1,l)]:
                    w=width(s,ydeck(s));p.append((max(-w,min(w,x)),L*(.5-s),ydeck(s)))
                # Local native Y runs bowwards, so reverse for upward-facing deck.
                p.reverse();p=[q for i,q in enumerate(p) if q!=p[i-1]]
                if len(p)<3:continue
                shade=.91+.025*math.sin(j*2.4)
                a.mb('wood','deck').face(p,(shade,shade*.98,shade*.93),[(q[0]*2.4,q[1]/3) for q in p])
    # Structural frames confined to the short bulwark above the working deck.
    for i in range(21):
        s=.08+i*.041
        for side in (-1,1):
            y0=ydeck(s)+.01;y1=section(s,1)[1]-.025
            a.tube([(side*(width(s,y)-.105),L*(.5-s),y) for y in [y0,(y0+y1)/2,y1]],.035,'darkwood',6,color=(.75,.70,.60))
    # Same stem/post reach and heights as the existing game model.
    h=C['hull'];bow=[(0,L*(.5-.02),section(.02,0)[1]),(0,L/2+.12,section(0,1)[1]*.5),(0,L/2+h['bowOverhang'],section(0,1)[1]+.1),(0,L/2+h['bowOverhang']+.05,section(0,1)[1]+.45)]
    stern=[(0,L*(.5-.97),section(.97,0)[1]),(0,-L/2-.1,section(1,1)[1]*.6),(0,-L/2-h['sternOverhang'],section(1,1)[1]+.2),(0,-L/2-h['sternOverhang']+.1,section(1,1)[1]+.9),(0,-L/2-h['sternOverhang']+.45,section(1,1)[1]+1.3)]
    for points in (bow,stern):a.tube(points,.085,'darkwood',12,color=(.72,.65,.54))
