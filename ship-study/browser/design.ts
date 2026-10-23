/** Isolated Thalassa study. No registration in the game's ship catalogue or saved voyages. */
import { TRIREME, type ShipDesign, type SailRig } from '../../src/ship/design';
import type { HullShape } from '../../src/ship/hullShape';
import type { Column } from '../../src/ship/hull';
import type { OarSlot } from '../../src/ship/oarLayout';
import { TRIREME_CREW } from '../../src/ship/crew/params';

export const LENGTH = 82, HULL_BEAM = 6.6, HULL_OFFSET = 8.5;
const smooth = (a:number,b:number,x:number) => { const t=Math.max(0,Math.min(1,(x-a)/(b-a))); return t*t*(3-2*t); };
// Blender +X is bow, +Z up. Runtime conversion: (-Blender Y, Blender Z, -Blender X).
export function demiBeam(s:number) { const b=1-s; return 3.3*Math.max(.001,Math.sin(Math.PI*b))**.58*(1-.2*smooth(.82,1,b)); }
export function sheer(s:number) { const b=1-s; return 5+2.1*b**8+3.7*(1-b)**8; }
export function depth(s:number) { const b=1-s; return 3.25*Math.max(.001,Math.sin(Math.PI*b))**.3-4.4*(1-smooth(0,.12,b)); }
export function section(s:number,t:number,out={x:0,y:0}) {
  const p=t*Math.PI/2, d=depth(s);
  out.x=demiBeam(s)*Math.sin(p)**.72; out.y=-d+(sheer(s)+d)*(1-Math.cos(p))**.88; return out;
}
export function demiBottom(s:number,x:number) {
  // Analytic inverse of the authored section; avoids a nested bisection at startup.
  const u=Math.min(1,Math.max(0,Math.abs(x)/demiBeam(s)));
  const c=Math.sqrt(Math.max(0,1-u**(2/.72)));
  return -depth(s)+(sheer(s)+depth(s))*(1-c)**.88;
}
export function demiWidthAt(s:number,y:number) {
  const d=depth(s), f=Math.min(1,Math.max(0,(y+d)/(sheer(s)+d)));
  return demiBeam(s)*Math.sqrt(Math.max(0,1-(1-f**(1/.88))**2))**.72;
}
export function buildColumns(stations=32,strips=8):Column[] {
  const cols:Column[]=[], dz=LENGTH/stations;
  for (let i=0;i<stations;i++) {
    const s=(i+.5)/stations, w=demiBeam(s), dx=2*w/strips;
    for (const offset of [-HULL_OFFSET,HULL_OFFSET]) for(let j=0;j<strips;j++) {
      const x=-w+(j+.5)*dx;
      let bottom=0;
      for(let q=0;q<8;q++) bottom+=demiBottom(s,x+((q+.5)/8-.5)*dx)/8;
      cols.push({x:offset+x,z:(s-.5)*LENGTH,bottom,top:sheer(s),area:dx*dz,dx,dz,keel:-depth(s),latW:dx/(2*w)});
    }
  }
  return cols;
}
// Outline methods are an envelope for contact helpers. ONLY the two column sets displace water.
export const HULL:HullShape={
  length:LENGTH,bowOverhang:4.5,sternOverhang:1,
  zOf:s=>(s-.5)*LENGTH,sOf:z=>z/LENGTH+.5,
  halfBeam:s=>HULL_OFFSET+demiBeam(s),keelDepth:depth,sheer,
  section:(s,t,out)=>{section(s,t,out);out.x+=HULL_OFFSET;return out;},
  halfWidthAt:(s,y)=>HULL_OFFSET+demiWidthAt(s,y),
  bottomAt:(s,x)=>demiBottom(s,Math.abs(x)-HULL_OFFSET),buildColumns,
  hullWidthTable:()=>Float32Array.from({length:16},(_,i)=>HULL_OFFSET+demiBeam(i/15)),
};

export function oarSlots():OarSlot[] {
  const slots:OarSlot[]=[];
  for(const blenderOffset of [-8.5,8.5]) for(let bank=0;bank<3;bank++) for(let i=0;i<34;i++) {
    const bx=-LENGTH*.315+i*LENGTH*.635/33+(bank-1)*.20;
    if(blenderOffset<0 && bx>-16 && bx<-7) continue; // actual boarding opening, preserved from pass 5
    const s=.5-bx/LENGTH, side=(blenderOffset<0?1:-1) as -1|1, y=1.15+bank*.88;
    const outboard=Math.hypot(6.5+bank*.9-.12,2.15,y-(.38+bank*.06));
    // Inboard handles, inertia and one human per loom are study assumptions, not present in the artwork.
    const inboard=1.7, bladeLength=1.7;
    slots.push({id:slots.length,bank,side,x:side*(8.5+demiWidthAt(s,y)+.16),y,z:-bx,
      length:outboard+inboard,inboard,bladeLength,bladeWidth:.46,bladeThickness:.045,
      bladeRadius:outboard-bladeLength/2,jitter:Math.sin(i*12.9898+bank*78.233+side)*.5});
  }
  return slots;
}
export function rig(bx:number,h:number,width:number,height:number):SailRig {
  // Projected cloth area from the authored tapered sail, including its raised corners.
  const area=width*(.94*height-.85*.28);
  return {...TRIREME.rig,width,height,area,mastStation:.5-bx/LENGTH,mastHeight:h,
    mastBaseY:5.55,yardDrop:1.25,yardY:5.55+h-1.25,yardZ:-bx,yardLength:width,clothTopDrop:0,clothOffsetZ:0};
}
export const MAIN_RIG=rig(12,24,21.5,7.1), AFT_RIG=rig(-14.8,19,16.4,4.6);
export function hydrostatics(stations=320,strips=80) {
  let v=0,mz=0,my=0,aw=0,ix=0;
  const dz=LENGTH/stations;
  for(let i=0;i<stations;i++) {
    const s=(i+.5)/stations,w=demiWidthAt(s,0),dx=2*w/strips,z=(s-.5)*LENGTH;
    for(const offset of [-8.5,8.5]) for(let j=0;j<strips;j++) {
      const x=offset-w+(j+.5)*dx,b=demiBottom(s,x-offset),d=Math.max(0,-b),dv=d*dx*dz;
      v+=dv;mz+=dv*z;my+=dv*b/2;aw+=dx*dz;ix+=(x*x+dx*dx/12)*dx*dz;
    }
  }
  return {volume:v,mass:v*1025,cbY:my/v,cbZ:mz/v,waterplane:aw,waterplaneRollInertia:ix,metacentricHeightAboveWater:my/v+ix/v};
}
export const HYDRO=hydrostatics();
export function makeDesign(stations=32,strips=8):ShipDesign {
  const slots=oarSlots(),n=slots.length;
  return {...TRIREME,name:'Thalassa — exterior prototype',subtitle:'Twin-hull sea trials',hull:HULL,
    columns:{stations,strips},deck:{deckY:()=>5.55,deckHalfWidth:s=>HULL.halfBeam(s)-.4,outerHalfWidth:HULL.halfBeam,s0:.08,s1:.92},
    mass:{cgY:2.5,cgZ:HYDRO.cbZ,inertiaScale:[1.1,1.05,1.25]},
    // Existing trireme response keeps heave damping at each hull. Merchant response centres it at x=0.
    hydro:{...TRIREME.hydro,resistance:{kind:'ittc',formFactor:1.82,cw0:.004,cwExp:6,astern:1.4},
      lateralFromProfile:true,wettedFactor:1.35,heaveDampLin:1800,rollDampLin:22000,rollDampQuad:40000},
    windage:{lateralCd:1,lateralArea:380,frontalCd:.7,frontalArea:95,point:[0,5.3,3]},
    rudder:{...TRIREME.rudder,area:2.0,s:.93,y:-1,dz:.8,xOut:.45,depthNorm:1.2},
    rig:MAIN_RIG,
    oars:{...TRIREME.oars,slots:oarSlots,maxOrder:4,crew:{...TRIREME_CREW,layout:oarSlots,hands:n,
      banks:[0,1,2].map(b=>({handR:1.45,Ioar:180+b*70,addedMass:1025*Math.PI/8*.46**2*1.7})),
      handR:1.45,gripOuter:1.55,gripInner:1.35,inboard:1.7,
      thetaMid:.04,thetaHalf:.40,catchMax:.44,finishMin:-.36,arcMin:.25,arcMax:.80,arcStart:.65,
      orders:TRIREME_CREW.orders.slice(0,5).map((o,i)=>({...o,rate:[14,0,14,18,22][i],manned:i===1?0:n})),
      payload:false,animated:false}},
    docking:{...TRIREME.docking,enabled:false},anchoringEnabled:false,buildingEnabled:false,
    contactExtras:[],quayStations:[],crewSpots:[],cargo:undefined};
}
