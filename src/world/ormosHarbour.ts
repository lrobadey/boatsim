import * as THREE from 'three';
import {HarborKit} from '../../harbor-kit/runtime/kit';
import {patchMaterial} from '../gfx/shared';
import {LAYER_REFRACT,LAYER_NOREFLECT} from '../core/pipeline';
import {MERCHANT} from '../ship/design';
import type {SurfaceMaps} from '../gfx/assets';
import type {WorldGenResult} from './worldgenTypes';
import type {Solid} from './walkable';
import {pierFrame,berthBollards,QUAY,portSites,type PortSite} from './harbour';
import {harborWorld,harborYaw,planPier,planOf,type HarborPlacement,type HarborPlan} from './ormosLayout';
import {lookGeometry,LOOK_FOOTPRINT,LOOK_LAYER} from '../cargo/cargoModels';

/** height above sea level (m) no wave crest reaches in the harbour */
const REFRACT_CREST=4;

/** one authored harbour's scenery and the solids people walk on */
export interface AuthoredPort {id:number;plan:HarborPlan;group:THREE.Group;solids:Solid[]}
/** group and solids are the starting harbour's (id 0); ports lists every authored harbour, id 0 first */
export interface OrmosHarbour {group:THREE.Group;solids:Solid[];ports:AuthoredPort[];shell:THREE.Group;wood:SurfaceMaps;linen:SurfaceMaps;plank:THREE.Group;kit:HarborKit}
/** Production scenery shares the generated port frame and exact walk / berth geometry. */
export async function loadOrmosHarbour(gen:WorldGenResult):Promise<OrmosHarbour>{
 const kit=await HarborKit.open('/assets/ormos/manifest.json',{patchMaterial:(m,n)=>patchMaterial(m,undefined,'ormos_'+n)});
 // the worker decided which harbours carry a plan (it graded their courts); build exactly those
 const ports:AuthoredPort[]=[];
 for(const site of portSites(gen)){const plan=planOf(site);if(plan)ports.push(await buildAuthoredPort(kit,gen,site,plan));}
 const main=ports.find(p=>p.id===0);if(!main)throw Error('The starting harbour has no authored plan');
 const shell=await kit.create('merchant-shell'),canopy=await kit.create('linen-canopy');
 const maps=(obj:THREE.Object3D,name:string):SurfaceMaps=>{let m:THREE.MeshStandardMaterial|undefined;obj.traverse(o=>{if(o instanceof THREE.Mesh)for(const mat of Array.isArray(o.material)?o.material:[o.material])if(mat.name===name)m=mat as THREE.MeshStandardMaterial;});if(!m?.map||!m.normalMap||!m.roughnessMap)throw Error('Missing material '+name);return {color:m.map,normal:m.normalMap,roughness:m.roughnessMap};};
 const linen=maps(canopy,'cloth');for(const key of ['color','normal','roughness'] as const){linen[key]=linen[key].clone();linen[key].repeat.set(MERCHANT.rig.width/2,MERCHANT.rig.height/2);}
 const plank=new THREE.Group(),board=await kit.create('merchant-gangplank');board.rotation.y=Math.PI;board.position.z=-1.55;plank.add(board);
 return {group:main.group,solids:main.solids,ports,shell,wood:maps(shell,'wood'),linen,plank,kit};
}

/** One harbour dressed from its plan around the generated mole of `site`. */
async function buildAuthoredPort(kit:HarborKit,gen:WorldGenResult,site:PortSite,plan:HarborPlan):Promise<AuthoredPort>{
 // p: the plan's frame (the court's quay face); f: the generated mole, which starts o metres inland of it
 const group=new THREE.Group(),solids:Solid[]=[],p=planPier(site.pier,plan),f=pierFrame(site.pier),yaw=harborYaw(p),o=plan.origin??0;
 group.name=plan.name;group.position.set(p.x,0,p.z);group.rotation.y=yaw;
 const batches=new Map<string,THREE.Matrix4[]>();
 const matrix=(x:number,y:number,z:number,rot=0,sx=1,sy=1,sz=sx)=>new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),rot),new THREE.Vector3(sx,sy,sz));
 const place=(a:HarborPlacement,collision=true)=>{
   const y=a.y??p.top,s=a.scale??1,rot=a.yaw??0;
   const M=matrix(a.x,y,a.z,rot,s,s);const list=batches.get(a.id)??[];list.push(M);batches.set(a.id,list);
   if(!collision)return;
   for(const c of kit.asset(a.id).collision){
     if(c.type==='mesh'){
       if(kit.asset(a.id).family!=='geology')throw Error('Unsupported production collider: '+a.id);
       // The game walker supports primitive solids. Dense shore rocks are
       // conservatively blocked, rather than offering a false flat walking top.
       const b=kit.asset(a.id).bounds,center=new THREE.Vector3((b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2).applyMatrix4(M),v=harborWorld(p,center.x,center.z);
       solids.push({kind:'box',cx:v.x,cz:v.z,hx:(b.max[0]-b.min[0])*s/2,hz:(b.max[2]-b.min[2])*s/2,rot:yaw+rot,y0:y+b.min[1]*s,y1:y+b.max[1]*s,surface:'rock',walkTop:false});continue;
     }
     const center=new THREE.Vector3(...c.center).applyMatrix4(M),v=harborWorld(p,center.x,center.z);
     if(c.type==='box')solids.push({kind:'box',cx:v.x,cz:v.z,hx:c.size[0]*s/2,hz:c.size[2]*s/2,rot:yaw+rot,y0:center.y-c.size[1]*s/2,y1:center.y+c.size[1]*s/2,surface:c.surface as 'stone',walkTop:c.walkableTop});
     else solids.push({kind:'cyl',cx:v.x,cz:v.z,r:c.radius*s,y0:center.y-c.height*s/2,y1:center.y+c.height*s/2,surface:c.surface as 'wood',walkTop:c.walkableTop});
   }
 };
 plan.buildings.forEach(a=>{
   place(a);
   // The houses have closed shadow returns behind their timber doors; the
   // warehouse alone supplies an open loading hall.
   if(a.id.startsWith('house-')){
     const asset=kit.asset(a.id),r=a.yaw??0,d=-asset.footprint[1]/2+.6,v=harborWorld(p,a.x+Math.sin(r)*d,a.z+Math.cos(r)*d);
     solids.push({kind:'box',cx:v.x,cz:v.z,hx:1.05,hz:.06,rot:yaw+r,y0:p.top,y1:p.top+2.2,surface:'wood',walkTop:false});
   }
 });plan.cargo.forEach(a=>place(a));plan.trees.forEach(a=>place(a));
 const groundAt=(x:number,z:number)=>{const v=harborWorld(p,x,z),n=gen.size,cell=gen.worldSize/n,fx=(v.x+gen.worldSize/2)/cell-.5,fz=(v.z+gen.worldSize/2)/cell-.5,i=Math.floor(fx),j=Math.floor(fz),tx=fx-i,tz=fz-j,k=j*n+i,H=gen.heights;return (H[k]*(1-tx)+H[k+1]*tx)*(1-tz)+(H[k+n]*(1-tx)+H[k+n+1]*tx)*tz;};
 plan.shore.forEach(a=>place({...a,y:groundAt(a.x,a.z)}));
 // Quay units have their water face at local Z=0; back-to-back courses form the existing 6 m mole.
 const front=Math.round(plan.landing.w/6);
 for(let i=0;i<front;i++)place({id:['quay-straight-a','quay-straight-b','quay-straight-c'][i%3],x:(plan.landing.x??0)-(front-1)*3+i*6,z:-1},false);
 // the mole's faces run from the court's quay face out; any length inland of it lies under the court
 const count=Math.ceil((f.bodyLength-o)/6),step=(f.bodyLength-o)/count;
 for(let i=0;i<count;i++)for(const side of [-1,1]){
   const id=['quay-straight-a','quay-straight-b','quay-straight-c'][i%3],list=batches.get(id)??[];
   // module X runs along the mole; local Z runs inward across it.
   list.push(matrix(side*f.width/2,p.top,-(i+.5)*step,-side*Math.PI/2,step/6,1,f.width/8));batches.set(id,list);
 }
 for(const side of [-1,1] as const){
   for(const b of berthBollards(f,side)){
     const dx=b.x-p.x,dz=b.z-p.z;place({id:'mooring-stone',x:-f.uz*dx+f.ux*dz,z:-f.ux*dx-f.uz*dz},false);
   }
   for(let a=f.berthStart;a<f.bodyLength-2;a+=5)place({id:'rope-fender',x:side*f.width/2,z:o-a,y:p.top-.1},false);
 }
 await Promise.all([...batches].map(async([id,matrices])=>{
   const asset=kit.asset(id);
   if(asset.lods.length===1){group.add(await kit.batch(id,matrices));return;}
   // Batch coordinates are centered at the grove, so LOD range is measured from
   // its actual world location rather than the archipelago origin.
   const center=new THREE.Vector3();for(const m of matrices)center.add(new THREE.Vector3().setFromMatrixPosition(m));center.divideScalar(matrices.length);
   const lod=new THREE.LOD();lod.position.copy(center);
   const shift=new THREE.Matrix4().makeTranslation(-center.x,-center.y,-center.z),local=matrices.map(m=>new THREE.Matrix4().multiplyMatrices(shift,m));
   for(const level of asset.lods){const batch=await kit.batch(id,local,level.level);batch.traverse(o=>{if(o instanceof THREE.Mesh && asset.family==='vegetation')o.layers.enable(LAYER_NOREFLECT);});lod.addLevel(batch,level.distance);}
   group.add(lod);
 }));
 const proto=await kit.create('quay-straight-a');let paving:THREE.Material|undefined,stone:THREE.Material|undefined;
 proto.traverse(o=>{if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material]){if(m.name==='paving')paving=m;if(m.name==='limestone')stone=m;}});
 if(!paving||!stone)throw Error('Court requires paving and limestone');
 const box=(x:number,y:number,z:number,w:number,h:number,d:number,mat:THREE.Material)=>{const g=new THREE.BoxGeometry(w,h,d),pos=g.attributes.position,norm=g.attributes.normal,uv=g.attributes.uv;
    const colors=new Float32Array(pos.count*3).fill(1);g.setAttribute('color',new THREE.BufferAttribute(colors,3));
    for(let i=0;i<pos.count;i++){const nx=Math.abs(norm.getX(i)),ny=Math.abs(norm.getY(i));const u=nx>.5?pos.getZ(i)+z:pos.getX(i)+x,v=ny>.5?pos.getZ(i)+z:pos.getY(i)+y;uv.setXY(i,u/2,v/2);}
    const mesh=new THREE.Mesh(g,mat);mesh.position.set(x,y,z);mesh.castShadow=mesh.receiveShadow=true;mesh.layers.enable(LAYER_REFRACT);group.add(mesh);return mesh;};
 // Continuous landing and the narrow village lane. Terrain beneath is generated as a physical terrace.
 const pavingMatrices:THREE.Matrix4[]=[];
 const floor=(x:number,z:number,w:number,d:number)=>{
   box(x,p.top-.18,z,w,.24,d,stone!);
   const nx=Math.ceil(w/6),nz=Math.ceil(d/4),cw=w/nx,cd=d/nz;
   for(let i=0;i<nx;i++)for(let j=0;j<nz;j++)pavingMatrices.push(matrix(x-w/2+(i+.5)*cw,p.top,z-d/2+j*cd,0,cw/6,1,cd/4));const v=harborWorld(p,x,z);solids.push({kind:'box',cx:v.x,cz:v.z,hx:w/2,hz:d/2,rot:yaw,y0:p.top-.24,y1:p.top,surface:'stone',walkTop:true});};
 for(const [x,z,w,d] of plan.floors)floor(x,z,w,d);
 proto.updateMatrixWorld(true);
 proto.traverse(o=>{if(o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name==='paving'){
   const g=o.geometry.clone().applyMatrix4(o.matrixWorld),batch=new THREE.InstancedMesh(g,o.material,pavingMatrices.length);
   pavingMatrices.forEach((m,i)=>batch.setMatrixAt(i,m));batch.castShadow=batch.receiveShadow=true;batch.computeBoundingSphere();group.add(batch);
 }});
 // The buildings' exported floors, walls and doors provide precise independent support / obstruction.
 box(0,(QUAY.bottom+p.top-4.2)/2,-(f.bodyLength-o)/2,p.width,p.top-4.2-QUAY.bottom,f.bodyLength-o,stone);
 const sw=QUAY.stairWidth;
 for(const side of [-1,1])box(side*(sw/2+(p.width-sw)/4),(p.top+QUAY.bottom)/2,o-(f.bodyLength+f.length)/2,(p.width-sw)/2,p.top-QUAY.bottom,f.length-f.bodyLength,stone);
 for(let i=0;i<f.stairs;i++){const top=p.top-QUAY.riser*(i+1);box(0,(top+QUAY.bottom)/2,o-f.bodyLength-(i+.5)*QUAY.tread,sw,top-QUAY.bottom,QUAY.tread,stone);}
 // Retaining foundation of the shore landing, capped by the continuous slab.
 box(plan.landing.x??0,p.top-1.6,plan.landing.z,plan.landing.w,2.7,plan.landing.d,stone);
 if(plan.sacks)sackStacks(group,solids,p,plan.sacks);
 // The refraction pre-pass only shows what lies under the sea surface: meshes wholly above the
 // highest crest (the group sits at sea level, so its y is world height) stay out of it.
 group.updateMatrixWorld(true);const bounds=new THREE.Box3();
 group.traverse(o=>{if(o instanceof THREE.Mesh){if(bounds.setFromObject(o).min.y<REFRACT_CREST)o.layers.enable(LAYER_REFRACT);else o.layers.disable(LAYER_REFRACT);}});
 return {id:site.id,plan,group,solids};
}

/** Grain sacks in tidy stacks, from the hold's own sack geometry: one instanced mesh per harbour. */
function sackStacks(group:THREE.Group,solids:Solid[],p:PortSite['pier'],stacks:NonNullable<HarborPlan['sacks']>){
 const [px,pz]=LOOK_FOOTPRINT.sack,matrices:THREE.Matrix4[]=[],q=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),one=new THREE.Vector3(1,1,1);
 const yaw=harborYaw(p);
 for(const s of stacks){
   const r=s.yaw??0,c=Math.cos(r),sn=Math.sin(r);
   for(let l=0;l<s.layers;l++){
     // each layer is one sack shorter on both sides, so stacks step in like real grain piles
     const nx=Math.max(1,s.nx-l),nz=Math.max(1,s.nz-l);
     for(let i=0;i<nx;i++)for(let j=0;j<nz;j++){
       const lx=(i-(nx-1)/2)*px,lz=(j-(nz-1)/2)*pz,jit=((i*7+j*13+l*5)%5-2)*.06;
       q.setFromAxisAngle(up,r+jit);
       matrices.push(new THREE.Matrix4().compose(new THREE.Vector3(s.x+c*lx+sn*lz,p.top+l*LOOK_LAYER.sack,s.z-sn*lx+c*lz),q.clone(),one));
     }
   }
   const v=harborWorld(p,s.x,s.z);
   solids.push({kind:'box',cx:v.x,cz:v.z,hx:s.nx*px/2,hz:s.nz*pz/2,rot:yaw+r,y0:p.top,y1:p.top+(s.layers-1)*LOOK_LAYER.sack+.45,surface:'wood',walkTop:false});
 }
 // the hold's cargo material (white, coloured per instance), with the wheat sack's tint and a little variation
 const mat=patchMaterial(new THREE.MeshStandardMaterial({color:0xffffff,roughness:.95}),undefined,'cargo_sack');
 const mesh=new THREE.InstancedMesh(lookGeometry('sack'),mat,matrices.length),tint=new THREE.Color(0xcdbb94),c=new THREE.Color();
 matrices.forEach((m,i)=>{mesh.setMatrixAt(i,m);mesh.setColorAt(i,c.copy(tint).multiplyScalar(.72+((i*37)%11)/60));});mesh.castShadow=mesh.receiveShadow=true;mesh.computeBoundingSphere();group.add(mesh);
}
