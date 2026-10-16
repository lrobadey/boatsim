import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const {harborWorld,harborLocal,HARBOR_BUILDINGS,HARBOR_TREES,HARBOR_SHORE,inHarborCourt,KORMAKOS_PLAN,planPier}=await import('../src/world/ormosLayout.ts');
const {buildHarbours}=await import('../src/world/harbour.ts');
const {Wind}=await import('../src/world/wind.ts');
const holder={postMessage(){},onmessage:null};globalThis.self=holder;
await import('../src/world/worldgen.worker.ts');
const height=(g,x,z)=>{const c=g.worldSize/g.size,fx=(x+g.worldSize/2)/c-.5,fz=(z+g.worldSize/2)/c-.5,i=Math.floor(fx),j=Math.floor(fz),a=fx-i,b=fz-j,k=j*g.size+i,H=g.heights;return (H[k]*(1-a)+H[k+1]*a)*(1-b)+(H[k+g.size]*(1-a)+H[k+g.size+1]*a)*b;};
for(const [seed,size] of [[1729,2048],[1730,2048],[1,1024]]){
 let gen;holder.postMessage=m=>{if(m.type==='done')gen=m.result;};holder.onmessage({data:{seed,size,worldSize:12000,windFrom:new Wind(3).baseFrom,vegetationDensity:.4,authoredHarbour:true}});
 const p=gen.sites.pier,layouts=buildHarbours(gen,{},true),main=layouts[0],market=harborLocal(p,main.stall.x,main.stall.z);
 assert.ok(Math.abs(market.x-14)<1e-8 && Math.abs(market.z-7.5)<1e-8,'Trade point does not follow the authored court');
 assert.equal(main.shipColliders.length,2,'Physical shore landing collider missing');
 assert.equal(main.width,6,'Original docking width changed');
 assert.equal(main.berths.length,2,'Original berth count changed');
 for(const a of HARBOR_BUILDINGS){const v=harborWorld(p,a.x,a.z),l=harborLocal(p,v.x,v.z);assert.ok(Math.abs(l.x-a.x)<1e-8 && Math.abs(l.z-a.z)<1e-8);assert.ok(height(gen,v.x,v.z)>=1.5 && height(gen,v.x,v.z)<=1.66,`${seed}: ${a.id} (${a.x},${a.z}) ground ${height(gen,v.x,v.z)}: building foundation buried or unsupported`);}
 for(const side of [-1,1])for(const a of [p.berthStart+8,(p.berthStart+p.length)/2,p.length-8]){const v=harborWorld(p,side*(p.width/2+2.4),-a);assert.ok(height(gen,v.x,v.z)<-3.2,`${seed}: berth dredge filled by terrace`);}
 assert.ok(gen.sites.houses.every(h=>!inHarborCourt(p,h.x,h.z,15)),'Native houses overlap authored court');
 for(let i=0;i<gen.vegetation.length;i+=6)assert.ok(!inHarborCourt(p,gen.vegetation[i],gen.vegetation[i+2],8),'Native vegetation overlaps authored court');
 assert.ok(gen.seaState && gen.ao.length,'Physical terrain bakes missing');
 // Kormakos: graded only in the world it was fitted to (seed 1729 at 2048), and never over its berths
 const k=gen.sites.harbours[1];
 if(seed===1729&&size===2048){
   assert.equal(k.plan,'kormakos','Kormakos plan not applied in its own world');
   const q=planPier(k.pier,KORMAKOS_PLAN),stall=harborLocal(q,layouts[1].stall.x,layouts[1].stall.z);
   assert.ok(Math.abs(stall.x-KORMAKOS_PLAN.market.x)<1e-8&&Math.abs(stall.z-KORMAKOS_PLAN.market.z)<1e-8,'Kormakos trade point off the plan');
   assert.equal(layouts[1].shipColliders.length,2,'Kormakos landing collider missing');
   for(const a of KORMAKOS_PLAN.buildings){const v=harborWorld(q,a.x,a.z),h=height(gen,v.x,v.z);assert.ok(h>=1.5&&h<=1.66,`Kormakos ${a.id} (${a.x},${a.z}) ground ${h}`);}
   const kp=k.pier;for(const side of [-1,1])for(const a of [kp.berthStart+8,(kp.berthStart+kp.length)/2,kp.length-8]){const v=harborWorld(kp,side*(kp.width/2+2.4),-a);assert.ok(height(gen,v.x,v.z)<-3.2,`Kormakos berth filled at ${a} m`);}
   assert.ok(k.houses.every(h=>!inHarborCourt(q,h.x,h.z,15,KORMAKOS_PLAN.court)),'Kormakos houses overlap its court');
   for(let i=0;i<gen.vegetation.length;i+=6)assert.ok(!inHarborCourt(q,gen.vegetation[i],gen.vegetation[i+2],8,KORMAKOS_PLAN.court),'Vegetation overlaps the Kormakos court');
 } else assert.equal(k?.plan,undefined,`${seed}/${size}: the Kormakos plan was applied to a world it was not fitted to`);
 console.log(`PASS Ormos seed ${seed}, ${size}: graded foundations, clear berths, reserved court, physical bakes; Kormakos ${k?.plan?'authored':'native'}`);
}
const root=new URL('../public/assets/ormos/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('manifest.json',root)));
for(const a of manifest.assets)for(const lod of a.lods){const bytes=fs.readFileSync(new URL(lod.file,root));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),lod.sha256,`${a.id}: staged asset stale`);}
assert.ok(manifest.assets.find(a=>a.id==='merchant-shell'));assert.deepEqual(manifest.assets.find(a=>a.id==='merchant-gangplank').footprint,[.7,3.1]);
for(const a of HARBOR_TREES){const x=a.z>31?4:0;assert.ok(Math.abs(a.x-x)>1,'Olive trunk blocks the village lane');}
for(const a of HARBOR_SHORE.filter(a=>a.id.startsWith('rock-'))){const asset=manifest.assets.find(v=>v.id===a.id);const radius=Math.hypot((asset.bounds.max[0]-asset.bounds.min[0])/2,(asset.bounds.max[2]-asset.bounds.min[2])/2)*(a.scale??1);assert.ok(Math.abs(a.x)-radius>10,'Shore rock intrudes on the central route');}
console.log('PASS landscape: olive trunks and conservative shore rock solids clear the central walking route');
console.log('PASS production kit: checked GLB hashes, merchant shell and gangplank contract');
