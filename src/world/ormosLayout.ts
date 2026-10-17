import type {Sites} from './worldgenTypes';

/** Starting harbor, in metres: X across the quay, Z inland. Fronts face the sea. */
export const ORMOS = { top: 1.8, halfWidth: 32, inland: 48, blend: 32 } as const;
/** cx: the court's centre across the quay (m, default 0, the mole's axis). The ground is graded to 1.65 m, under the 1.8 m paving. */
export interface HarborCourt {halfWidth:number;inland:number;blend:number;cx?:number}
export function harborLocal(p: Sites['pier'], x: number, z: number) {
  const ux=Math.cos(p.angle), uz=Math.sin(p.angle), dx=x-p.x,dz=z-p.z;
  return {x:-uz*dx+ux*dz,z:-ux*dx-uz*dz};
}
export function harborWorld(p: Sites['pier'], x: number, z: number) {
  const ux=Math.cos(p.angle),uz=Math.sin(p.angle);
  return {x:p.x-uz*x-ux*z,z:p.z+ux*x-uz*z};
}
export function harborYaw(p: Sites['pier']) {return Math.atan2(-Math.cos(p.angle),-Math.sin(p.angle));}
export function inHarborCourt(p: Sites['pier'],x:number,z:number,margin=0,court:HarborCourt=ORMOS) {
  const l=harborLocal(p,x,z);return Math.abs(l.x-(court.cx??0))<court.halfWidth+margin && l.z>-4-margin && l.z<court.inland+margin;
}
/** Heightfield edit precedes AO and wave-shelter baking; a feathered terrace joins the native coast. */
export function prepareHarborGround(heights:Float32Array,n:number,worldSize:number,p:Sites['pier'],court:HarborCourt=ORMOS) {
  const cell=worldSize/n,half=worldSize/2;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const l=harborLocal(p,-half+(i+.5)*cell,-half+(j+.5)*cell);
    // The waterfront terminates at the quay face. Do not fill the working berth or dredged mole.
    if(l.z<-1)continue;
    const guard=cell*Math.SQRT2;
    const out=Math.hypot(Math.max(0,Math.abs(l.x-(court.cx??0))-court.halfWidth-guard),Math.max(0,l.z-court.inland-guard));
    if(out>=court.blend)continue;
    const t=Math.min(1,out/court.blend),w=1-t*t*(3-2*t);
    heights[j*n+i]+=(1.65-heights[j*n+i])*w;
  }
}
export interface HarborPlacement {id:string;x:number;z:number;y?:number;yaw?:number;scale?:number}
export const HARBOR_BUILDINGS:HarborPlacement[]=[
 {id:'warehouse',x:-14,z:19},
 {id:'house-workshop',x:15,z:18},
 {id:'house-courtyard',x:20,z:34},
 {id:'house-tower',x:-21,z:37},
 {id:'house-workshop',x:-7,z:38},
 {id:'linen-canopy',x:-18,z:10},{id:'linen-canopy',x:-10.8,z:10},
 {id:'linen-canopy',x:14,z:9},
];
export const HARBOR_CARGO:HarborPlacement[]=[
 {id:'packing-rack',x:-20,z:14},{id:'packing-rack',x:-8,z:14},
 {id:'timber-bench',x:14,z:10},{id:'timber-bench',x:25,z:24,yaw:Math.PI/2},
 {id:'amphora-large',x:-19.4,z:17},{id:'amphora-large',x:-18.6,z:17},
 {id:'amphora-large',x:-17.8,z:17},{id:'amphora-large',x:-19.4,z:17.8},
 {id:'amphora-small',x:12.2,z:9.5},{id:'amphora-small',x:12.8,z:9.5},
 {id:'wicker-basket',x:16,z:10},{id:'wicker-basket',x:-12,z:14},
 {id:'rope-coil',x:-4,z:1},{id:'rope-coil',x:-5,z:1.4},
 {id:'amphora-large',x:-17,z:20},{id:'amphora-large',x:-16.2,z:20},
 {id:'packing-rack',x:-14,z:23},{id:'wicker-basket',x:17,z:17},
];
export const HARBOR_TREES:HarborPlacement[]=[
 [-28,13],[-29,24],[-29,37],[-15,34],[-15,44],[-2,37],[9,44],
 [28,15],[29,28],[28,43],[17,44],[-25,46],[0,46],
].map(([x,z],i)=>({id:i%3===0?'olive-b':'olive-a',x,z,y:1.65,yaw:i*2.399,scale:.85+(i%3)*.09}));

/** Broad coastal shoulders frame the landing; the walking lane stays open. */
export const HARBOR_SHORE:HarborPlacement[]=[
 {id:'rock-ledge-a',x:-35,z:5,yaw:.25},{id:'rock-ledge-b',x:-36,z:27,yaw:-.35},
 {id:'rock-ledge-b',x:35,z:3,yaw:-.4},{id:'rock-ledge-a',x:35,z:25,yaw:.5},
 {id:'rock-boulder',x:-30,z:43,scale:.85},{id:'rock-boulder',x:30,z:40,scale:.9},
 ...[[-32,16],[-33,22],[-28,37],[-26,44],[-18,46],[12,45],[26,39],[31,15],[31,22],[29,34]].map(([x,z],i)=>({id:'coastal-shrub',x,z,scale:.8+(i%3)*.12,yaw:i*2.3})),
];

/**
 * One authored harbour, in the court's local frame (X across the quay, Z inland). The pier is the
 * generated mole; the plan dresses its root. Floors are [x, z, w, d] paved slabs walked on at the court top.
 */
export interface HarborPlan {
  name: string;
  /** only for this world (seed, heightmap size): a layout fitted to measured terrain */
  world?: { seed: number; size: number };
  /** metres seaward along the mole from the generated pier root to the court's quay face (default 0) */
  origin?: number;
  court: HarborCourt;
  buildings: HarborPlacement[];
  cargo: HarborPlacement[];
  trees: HarborPlacement[];
  shore: HarborPlacement[];
  floors: [number, number, number, number][];
  /** the front slab that meets the quay face: its retaining foundation and the ship collider */
  landing: { x?: number; z: number; w: number; d: number };
  /** the trader's quay point */
  market: { x: number; z: number };
  lamps: [number, number][];
  /** stacks of grain sacks: centre, columns × rows × layers, yaw */
  sacks?: { x: number; z: number; nx: number; nz: number; layers: number; yaw?: number }[];
  /** land use scale per good id on this world (e.g. no vineyards) */
  landUse?: Partial<Record<string, number>>;
}

export const ORMOS_PLAN: HarborPlan = {
  name: 'Ormos starting harbor',
  court: ORMOS,
  buildings: HARBOR_BUILDINGS, cargo: HARBOR_CARGO, trees: HARBOR_TREES, shore: HARBOR_SHORE,
  floors: [[0,5,60,12],[-14,12,24,2],[15,12,16,2],[0,21,6,20],[4,39,6,16],[-14,29,24,8],[16,26,18,8]],
  landing: { z: 5, w: 60, d: 12 },
  market: { x: 14, z: 7.5 },
  lamps: [[-23,12],[-5,12],[11,11],[-12,20],[4,29],[-18,36]],
};

/**
 * Kormakos (seed 1729 at 2048 only, measured): the generated pier root sits on a 23 m rock spine; the real
 * waterline is 24 m out along the mole, at the foot of a near-vertical cliff. The harbour is a stone quay built out
 * on fill over the shallows at the cliff toe, with the cliff left standing behind it: a wall along the cut, grain
 * sacks under canopies by the mole, a workshop store, and a watch tower at the north (+x) end, at the mouth of a low
 * gully (scenery only: no path is built up it). The quay cuts the tip of the south headland spur back; the rest of
 * the spur is left as it is.
 */
export const KORMAKOS_PLAN: HarborPlan = {
  name: 'Kormakos harbour',
  world: { seed: 1729, size: 2048 },
  origin: 34,
  // the grader flattens a further cell diagonal (about 8 m) past the court, so the flat ground ends at the paving
  court: { halfWidth: 13, inland: 6.5, blend: 8, cx: 13 },
  buildings: [
    {id:'house-workshop',x:21,z:9.5},
    {id:'house-tower',x:30.5,z:10},
    {id:'linen-canopy',x:-4.5,z:8.5},{id:'linen-canopy',x:9,z:8.5},
    ...[-5,1,7,13,19,25].map((x)=>({id:'retaining-wall',x,z:14.3})),
  ],
  cargo: [
    {id:'packing-rack',x:15,z:11.8},
    {id:'wicker-basket',x:14.5,z:6},{id:'wicker-basket',x:15.2,z:6.5},
    {id:'timber-bench',x:1.5,z:12.5},
    {id:'amphora-small',x:3.2,z:12.6},{id:'amphora-small',x:3.8,z:12.9},
    {id:'rope-coil',x:-5,z:1},{id:'rope-coil',x:6,z:1.2},{id:'rope-coil',x:6.9,z:1.5},
  ],
  trees: [],
  shore: [
    {id:'rock-rubble',x:4,z:15.5},{id:'rock-rubble',x:17,z:15.3,scale:1.2},
    {id:'olive-a',x:35,z:20,yaw:.7,scale:.8},
    ...[[-2,22],[10,23],[24,21]].map(([x,z],i)=>({id:'coastal-shrub',x,z,scale:.85+(i%3)*.12,yaw:i*1.9})),
  ],
  floors: [[13,6.5,42,15]],
  landing: { x: 13, z: 5, w: 42, d: 12 },
  market: { x: 3, z: 4 },
  lamps: [[-1,6],[15,4],[26,4]],
  sacks: [
    {x:-4.5,z:8.6,nx:3,nz:3,layers:2},{x:9,z:8.6,nx:5,nz:3,layers:3},
  ],
  landUse: { wine: 0 },
};

/** Authored plans by name; the worker decides which harbour gets which (HarbourSite.plan) and publishes it. */
export const PLANS: Readonly<Record<'ormos' | 'kormakos', HarborPlan>> = { ormos: ORMOS_PLAN, kormakos: KORMAKOS_PLAN };
/** Which plan the worker tries for each harbour id. A plan with `world` only applies there, and only with room. */
export const PLAN_FOR_HARBOUR: Readonly<Record<number, 'ormos' | 'kormakos'>> = { 0: 'ormos', 1: 'kormakos' };
/** Clear water a plan's quay face must leave before the berths: one heightmap cell of grading reach plus 4 m. */
export const PLAN_BERTH_CLEARANCE = 10;
export function planOf(site: { plan?: 'ormos' | 'kormakos' }): HarborPlan | undefined { return site.plan ? PLANS[site.plan] : undefined; }

/** the pier frame a plan is laid out in: the generated pier moved `origin` metres seaward along its axis */
export function planPier(p:Sites['pier'],plan:HarborPlan):Sites['pier'] {
  const o=plan.origin??0;if(!o)return p;
  return {...p,x:p.x+Math.cos(p.angle)*o,z:p.z+Math.sin(p.angle)*o};
}
export function harborMarket(p:Sites['pier'],plan:HarborPlan=ORMOS_PLAN) { p=planPier(p,plan); const v=harborWorld(p,plan.market.x,plan.market.z);return {...v,y:p.top,yaw:harborYaw(p),side:1 as const}; }
