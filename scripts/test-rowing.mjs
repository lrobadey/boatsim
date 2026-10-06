import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import * as THREE from 'three';
const { AudioEngine } = await import('../src/audio/audio.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField, createFlowSample } = await import('../src/world/waves.ts');
const { RowingSystem, createKinematics, evaluateOar, BladeClipper, bladeDrag, interpolateJoint } = await import('../src/ship/rowing.ts');
const { buildOarGeometry } = await import('../src/ship/oarGeometry.ts');
const { rng } = await import('../src/core/util.ts');
const dt = 1 / 120, kn = 1.943844;
const report = { host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, runtime: process.version }, tests: [], measured: {} };
let failures = 0;
const testFilter=process.argv.find(a=>a.startsWith('--test='))?.slice(7);
function test(name, fn) { if(testFilter&&!name.includes(testFilter))return; const start = performance.now(); try { fn(); report.tests.push({name,status:'passed',ms:performance.now()-start}); console.log('PASS', name); } catch (e) { failures++; report.tests.push({name,status:'failed',error:e.message}); console.error('FAIL',name,e.message); } }
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<=e, `${a} != ${b} (tol ${e})`);
function flat() { const w = new WaveField(new Wind(3)); w.waves.length = 0; return w; }
function single(amp=0.5,q=0,phase=0,dir=1) { const w=flat(); w.waves.push({dx:0,dz:dir,k:2*Math.PI/11,omega:Math.sqrt(9.81*2*Math.PI/11),phase,amp,target:amp,q}); return w; }
const terrain = { heightAt:()=>-100,normalAt:(x,z,out)=>out.set(0,1,0) };
function vessel(water=flat()) { const crew=new Crew(), ship=new ShipPhysics(water,{vx:0,vz:0},terrain,crew); ship.place(0,0,0); for(let i=0;i<240;i++)ship.step(dt); ship.vel.set(0,0,0);ship.angVel.set(0,0,0); return ship; }
function locked() { return {pos:new THREE.Vector3(0,.3,0),quat:new THREE.Quaternion(),vel:new THREE.Vector3(),angVel:new THREE.Vector3(),cg:new THREE.Vector3(0,.3,0)}; }
function rowStep(row,body,water,t,h=dt,helm=0) { const f=new THREE.Vector3(),m=new THREE.Vector3();row.step(h,t,body,helm,water,f,m);return {f,m}; }
function simulate(ship,seconds,h=dt,onStep=()=>{}) { const n=Math.round(seconds/h);let impulse=0,sum=0,meanN=0;for(let i=0;i<n;i++){onStep(i*h,ship);ship.step(h);impulse+=ship.oarThrust*h;if(i>=n-Math.round(Math.min(30,seconds/4)/h)){sum+=ship.speed;meanN++;}}return {meanKn:sum/meanN*kn,speedKn:ship.speed*kn,stamina:ship.crew.stamina,load:ship.rowing.telemetry.crewLoad,order:ship.crew.order.name,impulse}; }
const samplePose={sweep:.3,dip:.4,feather:.2,dSweep:-1.1,dDip:.3,dFeather:1.3};
test('layout, real bank geometry, orthonormal basis and endpoints',()=>{
 const row=new RowingSystem(new Crew()),k=createKinematics();assert.equal(row.slots.length,170);assert.equal(new Set(row.slots.map(s=>s.id)).size,170);
 for(let b=0;b<3;b++)for(const side of [-1,1])assert.equal(row.slots.filter(s=>s.bank===b&&s.side===side).length,[31,27,27][b]);
 const geometries=[0,1,2].map(b=>buildOarGeometry(row.slots.find(s=>s.bank===b)));
 for(const slot of row.slots){near(slot.bladeRadius,[3.22,2.92,2.67][slot.bank],1e-12);
 for(let phase=0;phase<=20;phase++)for(const direction of [-1,1]){
  const j={...samplePose,sweep:direction*(.72-1.3*phase/20),dip:.1+.5*phase/20,feather:Math.PI/2*phase/20};evaluateOar(slot,j,k);
  near(k.matrix.determinant(),1,1e-10);near(k.axis.dot(k.normal),0,1e-10);near(k.axis.dot(k.widthAxis),0,1e-10);
  const pos=geometries[slot.bank].attributes.position;const center=new THREE.Vector3();for(let v=pos.count-24;v<pos.count;v++)center.add(new THREE.Vector3().fromBufferAttribute(pos,v));center.multiplyScalar(1/24).applyMatrix4(k.matrix);assert.ok(center.distanceTo(k.center)<1e-6);
  for(const l of [-slot.bladeLength/2,slot.bladeLength/2])for(const w of [-slot.bladeWidth/2,slot.bladeWidth/2]){
   const a=new THREE.Vector3(slot.bladeRadius+l,w,0).applyMatrix4(k.matrix);const b=k.center.clone().addScaledVector(k.axis,l).addScaledVector(k.widthAxis,w);assert.ok(a.distanceTo(b)<1e-6);
  }
 }
 }
 geometries.forEach(g=>g.dispose());
});
test('analytic material velocities including dip and feather',()=>{
 const row=new RowingSystem(new Crew()),h=1e-5;
 for(const slot of row.slots){const k=createKinematics(),p=createKinematics(),n=createKinematics();evaluateOar(slot,samplePose,k);
 const offset=t=>({...samplePose,sweep:samplePose.sweep+t*samplePose.dSweep,dip:samplePose.dip+t*samplePose.dDip,feather:samplePose.feather+t*samplePose.dFeather});evaluateOar(slot,offset(h),p);evaluateOar(slot,offset(-h),n);
 assert.ok(p.center.clone().sub(n.center).multiplyScalar(1/(2*h)).distanceTo(k.centerVelocity)<1e-4);
 for(const l of [-.33,.33])for(const w of [-.085,.085]){const diff=p.center.clone().addScaledVector(p.axis,l).addScaledVector(p.widthAxis,w).sub(n.center).addScaledVector(n.axis,-l).addScaledVector(n.widthAxis,-w).multiplyScalar(1/(2*h));const velocity=k.axisVelocity.clone().multiplyScalar(slot.bladeRadius+l).addScaledVector(k.widthAxisVelocity,w);assert.ok(diff.distanceTo(velocity)<1e-4);}
 }
 const out=new Float64Array(6);interpolateJoint(.2,1.4,.6,0,.28,out);near(out[0],.2);near(out[3],1.4);interpolateJoint(.2,1.4,.6,.28,.28,out);near(out[0],.6);near(out[3],0,1e-12);
});
test('actual cyclic derivatives and C1 interrupted-controller boundaries',()=>{
 const row=new RowingSystem(new Crew()),slot=row.slots[0],side=row.sides[0],h=1e-6;
 for(const rate of [18,26,31,46])for(const direction of [-1,1]){
  side.mode='row';side.direction=direction;side.rate=rate;side.period=60/rate;side.drive=Math.max(.68,Math.min(1.55,.48*side.period));
  const C=Math.min(.12,.1*side.drive),boundaries=[0,C,side.drive-C,side.drive,side.drive+.12,side.period-.12,side.period];
  const values=t=>{side.elapsed=((t%side.period)+side.period)%side.period;row.cyclePose(slot,side);return Array.from(row.current.joint.slice(0,6));};
  for(let n=1;n<80;n++){
   const t=side.period*n/80;if(boundaries.some(b=>Math.abs(b-t)<2*h))continue;
   const a=values(t-h),b=values(t+h),mid=values(t);
   for(let k=0;k<3;k++)near((b[k]-a[k])/(2*h),mid[k+3],1e-4);
  }
  for(const boundary of boundaries){const a=values(boundary-h),b=values(boundary+h);for(let k=0;k<3;k++){near(a[k],b[k],1e-4);near(a[k+3],b[k+3],1e-4);}}
 }
 const body=locked(),water=flat(),crew=new Crew(),r=new RowingSystem(crew);crew.setOrder(4);let time=0;
 for(let i=0;i<180;i++){time+=dt;rowStep(r,body,water,time);}
 const before=Array.from(r.current.joint);r.sides[0].destination='hold';r.beginTransition(0,'exit');r.fillSide(0);
 for(let i=0;i<170;i+=2)for(let k=0;k<6;k++)near(r.current.joint[i*6+k],before[i*6+k],1e-12);
 for(const stage of ['exit','transfer','enter']){
  r.beginTransition(0,stage);const controller=r.sides[0];controller.elapsed=controller.duration;r.fillSide(0);
  for(let i=0;i<170;i+=2)for(let k=3;k<6;k++)near(r.current.joint[i*6+k],0,1e-10);
 }
});
test('continuous area clipping, exact dry force and dissipative power identity',()=>{
 const clip=new BladeClipper();for(const fraction of [0,.25,.5,.75,1]){const p=clip.clip(-.33,.33,-.085,.085,(fraction-.5)*.17,0,-1);near(p.area,.1122*fraction,1e-7);}
 const random=rng(123),force=new THREE.Vector3();for(let i=0;i<10000;i++){
 const normal=new THREE.Vector3(random()-.5,random()-.5,random()-.5).normalize();const vb=new THREE.Vector3(random()*12-6,random()*12-6,random()*12-6),vj=new THREE.Vector3(random()*12-6,random()*12-6,random()*12-6),vw=new THREE.Vector3(random()*4-2,random()*4-2,random()*4-2),v=vb.clone().add(vj).sub(vw);
 bladeDrag(random()*.1122,v,normal,force);force.multiplyScalar(random());assert.ok(force.dot(v)<=1e-7);near(force.dot(vb.clone().sub(vw)),-force.dot(vj)+force.dot(v),1e-7);
 }bladeDrag(0,new THREE.Vector3(2,3,4),new THREE.Vector3(0,0,1),force);near(force.length(),0);
});
test('flow particle velocity, inverse coordinates and depth decay',()=>{
 const waves=single(.5,.4,.3),w=waves.waves[0],t=.7,x=3,z=2,d=new Float64Array(3),prev=new Float64Array(3),next=new Float64Array(3),h=1e-5;
 waves.displacement(x,z,t,d);waves.displacement(x,z,t-h,prev);waves.displacement(x,z,t+h,next);
 const f=createFlowSample();waves.sampleFlowAt(x+d[0],Infinity,z+d[2],t,f);
 for(const [a,k] of [[f.vx,0],[f.vy,1],[f.vz,2]])near(a,(next[k]-prev[k])/(2*h),1e-5);
 const before=[f.vx,f.vy,f.vz];waves.flowAtDepth(f,1/w.k,f);for(const [i,a]of[f.vx,f.vy,f.vz].entries())near(a,before[i]*Math.exp(-1),1e-10);
 flat().sampleFlowAt(3,0,4,1,f);near(f.vx,0);near(f.vy,0);near(f.vz,0);
});
test('budgets, reservoirs, recovery contact and interrupted commands',()=>{
 const crew=new Crew(),row=new RowingSystem(crew),body=locked(),water=flat();crew.setOrder(4);
 for(let tick=0;tick<2400;tick++){
 if(tick%241===0)crew.setOrder([4,0,5,1,3,2][Math.floor(tick/241)%6]);crew.holdWater=tick>1700&&tick<1800;
 rowStep(row,body,water,tick*dt);for(const slot of row.slots){const i=slot.id,o=i*6;assert.ok(row.energy[i]>=-1e-8&&row.energy[i]<=640+1e-8);assert.ok(row.current.handleForce[i]<=row.handleCaps[i]+1e-6);assert.ok(row.current.positivePower[i]<=row.powerCaps[i]+1e-6);assert.ok(row.spentEnergy[i]<=640+row.replenishedEnergy[i]+1e-5);
 assert.ok(row.current.joint[o]>=-.83&&row.current.joint[o]<=.97);assert.ok(row.current.joint[o+1]>=-.3&&row.current.joint[o+1]<=1.2);assert.ok(row.current.joint[o+2]>=-.15&&row.current.joint[o+2]<=Math.PI/2+.15);
 }
 }
 const n=new THREE.Vector3(0,0,1),slip=new THREE.Vector3(0,0,2),f=new THREE.Vector3();bladeDrag(.1,slip,n,f);const squared=f.length();bladeDrag(.1,slip,new THREE.Vector3(0,1,0),f);assert.ok(f.length()>0&&f.length()<squared);
});
test('continuous human limits at hold entry and interrupted commands',()=>{
 const body=locked(),water=flat();body.vel.z=-4;
 let boundaryDelta=0,microDelta=0;
 for(const tiny of [false,true]){const c=new Crew(),r=new RowingSystem(c);c.holdWater=true;let time=0,lastForce=0,lastMode='rest';
 const step=h=>{const old=r.sides.map(s=>[s.handleLimit,s.peakLimit,s.meanLimit]);const result=rowStep(r,body,water,time+h,h);time+=h;const alpha=1-Math.exp(-h/.16);for(let side=0;side<2;side++)for(const[k,range]of[['handleLimit',900],['peakLimit',1400],['meanLimit',320]]){const index=['handleLimit','peakLimit','meanLimit'].indexOf(k);assert.ok(Math.abs(r.sides[side][k]-old[side][index])<=range*alpha+1e-9);assert.ok(r.sides[side][k]>=0&&r.sides[side][k]<=range+1e-9);}if(lastMode==='enter'&&r.sides[0].mode==='hold'){const delta=Math.abs(result.f.z-lastForce);if(tiny){microDelta=delta;assert.ok(delta<2,`micro force jump ${delta}`);}else{boundaryDelta=delta;assert.ok(delta<5000,`hold force jump ${delta}`);}}lastMode=r.sides[0].mode;lastForce=result.f.z;};
 for(let i=0;i<105;i++)step(dt);
 if(tiny){step(r.sides[0].duration-r.sides[0].elapsed-1e-6);step(2e-6);}else step(dt);
 assert.equal(r.sides[0].mode,'hold');r.energy.fill(0);step(dt);near(r.telemetry.positivePower,0,1e-8);assert.ok(lastForce>0);
 for(let i=0;i<600;i++){if(i%83===0)c.holdWater=!c.holdWater;if(i%117===0)c.setOrder([0,4,1,5][Math.floor(i/117)%4]);step(dt);}
 const limits=r.sides.map(s=>[s.handleLimit,s.peakLimit,s.meanLimit]);r.reset(body,time);assert.deepEqual(r.sides.map(s=>[s.handleLimit,s.peakLimit,s.meanLimit]),limits);
 }
 report.measured.humanLimitContinuity={boundaryDeltaN:boundaryDelta,microDeltaN:microDelta};
});
test('actual locked-body drive directions and fully dry rowing work',()=>{
 for(const order of [4,0]){const c=new Crew(),r=new RowingSystem(c),body=locked(),water=flat();c.setOrder(order);let seen=false;
 for(let i=0;i<480;i++){const {f}=rowStep(r,body,water,(i+1)*dt);const side=r.sides[0];if(side.mode==='row'&&side.elapsed>.3*side.drive&&side.elapsed<.7*side.drive){assert.ok(order===4?f.z<0:f.z>0);seen=true;}}
 assert.ok(seen);}
 const c=new Crew(),r=new RowingSystem(c),body=locked();body.pos.y=50;const dryWater=flat();c.setOrder(5);for(let i=0;i<1200;i++){const {f}=rowStep(r,body,dryWater,(i+1)*dt);near(f.length(),0);near(r.telemetry.positivePower,0);assert.ok(r.current.wetArea.every(a=>a===0));}assert.ok(r.telemetry.crewLoad>0);assert.ok(r.spentEnergy.every(e=>e===0));
});
test('fresh hold, release, zero contact and all order transitions',()=>{
 const body=locked(),water=flat(),crew=new Crew(),row=new RowingSystem(crew);crew.holdWater=true;for(let i=0;i<108;i++)rowStep(row,body,water,(i+1)*dt);assert.ok(row.sides.every(s=>s.mode==='hold'));near(row.telemetry.oarThrust,0);crew.holdWater=false;for(let i=0;i<108;i++)rowStep(row,body,water,(109+i)*dt);assert.ok(row.sides.every(s=>s.mode==='rest'));assert.equal(row.telemetry.wetBlades,0);
 for(let from=0;from<6;from++)for(let to=0;to<6;to++)for(let offset=0;offset<16;offset++){
  const c=new Crew(),r=new RowingSystem(c);c.setOrder(from);let t=0;for(let i=0;i<Math.round(1.7/dt);i++){t+=dt;rowStep(r,body,water,t);}if(from!==1){for(let side=0;side<2;side++){r.sides[side].elapsed=r.sides[side].period*offset/16;r.fillSide(side);}}c.setOrder(to);for(let i=0;i<180;i++){t+=dt;rowStep(r,body,water,t);assert.ok(r.current.joint.every(Number.isFinite));}assert.ok(r.sides.every(s=>s.mode===(to===1?'rest':'row')));if(to!==1)assert.ok(r.sides.every(s=>s.direction===(to===0?-1:1)));
 }
});
test('distributed short-wave loading and tangent-plane error',()=>{
 const body=locked();let nonzero=0,maxAreaError=0,maxForceError=0;
 for(const q of [0,.5])for(let phase=0;phase<12;phase++){
 const water=single(.5,q,phase*Math.PI/6),c=new Crew(),exactCrew=new Crew(),r=new RowingSystem(c),ref=new RowingSystem(exactCrew);c.setOrder(4);exactCrew.setOrder(4);ref.exactStripSampling=true;
 for(let i=0;i<180;i++){rowStep(r,body,water,(i+1)*dt);rowStep(ref,body,water,(i+1)*dt);}
 for(let i=0;i<170;i++)maxAreaError=Math.max(maxAreaError,Math.abs(r.current.wetArea[i]-ref.current.wetArea[i])/.1122);
 const delta=Math.abs(r.telemetry.oarThrust-ref.telemetry.oarThrust);if(Math.abs(ref.telemetry.oarThrust)>1000)maxForceError=Math.max(maxForceError,delta/Math.abs(ref.telemetry.oarThrust));else assert.ok(delta<=50);
 if(r.telemetry.wetBlades>0&&Math.abs(r.telemetry.oarThrust)>1)nonzero++;
 }
 assert.ok(nonzero>0);assert.ok(maxAreaError<=.08,`area error ${maxAreaError}`);assert.ok(maxForceError<=.05,`force error ${maxForceError}`);report.measured.waveComparison={maxAreaError,maxForceError};
});
test('fallback clipping versus independent curved corner samples',()=>{
 const body=locked(),kin=createKinematics(),point=new THREE.Vector3();let maxError=0,fallback=0;
 function cornerArea(slot,l0,l1,water,time){const polygon=[];for(const [l,w]of[[l0,-.085],[l1,-.085],[l1,.085],[l0,.085]]){point.copy(kin.center).addScaledVector(kin.axis,l).addScaledVector(kin.widthAxis,w).sub(body.cg).applyQuaternion(body.quat).add(body.pos);polygon.push({l,w,d:water.heightAt(point.x,point.z,time)-point.y});}
 const out=[];for(let i=0;i<4;i++){const a=polygon[i],b=polygon[(i+1)%4];if(a.d>=0)out.push(a);if((a.d>=0)!==(b.d>=0)){const f=a.d/(a.d-b.d);out.push({l:a.l+(b.l-a.l)*f,w:a.w+(b.w-a.w)*f});}}let area=0;for(let i=0;i<out.length;i++){const a=out[i],b=out[(i+1)%out.length];area+=a.l*b.w-a.w*b.l;}return Math.abs(area)/2;}
 for(const direction of [-1,1])for(const heel of [-.15,0,.15]){const water=single(.75,.5,.4,direction),crew=new Crew(),row=new RowingSystem(crew);crew.setOrder(4);body.quat.setFromEuler(new THREE.Euler(0,0,heel));
 for(let tick=0;tick<400;tick++){const time=(tick+1)*dt;rowStep(row,body,water,time);fallback+=row.telemetry.fallbackQueries;if(tick%20!==0)continue;for(const slot of row.slots){row.renderPose(slot.id,1,kin);let reference=0;for(let j=0;j<4;j++){const l0=-.33+j*.165;reference+=cornerArea(slot,l0,l0+.165,water,time);}maxError=Math.max(maxError,Math.abs(reference-row.current.wetArea[slot.id])/.1122);}}
 }
 assert.ok(fallback>0);assert.ok(maxError<=.05,`curved corner error ${maxError}`);report.measured.curvedCorners={maxError,fallbackQueries:fallback};
});
test('speed envelopes, work stamina and sprint',()=>{
 const results={};for(const index of [2,3,4,0]){const s=vessel();s.crew.setOrder(index);results[index]=simulate(s,120);const ranges={2:[3.5,6.2],3:[5,7.5],4:[6,8.6],0:[2.5,4.8]};const v=Math.abs(results[index].meanKn);assert.ok(v>=ranges[index][0]&&v<=ranges[index][1],`order${index}: ${v}kn`);if(index===4)assert.ok(results[index].stamina>.75,`full stamina ${results[index].stamina}`);}
 assert.ok(results[2].meanKn<results[3].meanKn&&results[3].meanKn<results[4].meanKn);
 const s=vessel();s.crew.setOrder(4);simulate(s,120);s.crew.stamina=1;const base=s.speed*kn;s.crew.setOrder(5);let max=0,demoted=null,window=[],powerSum=0,powerPeak=0,trace=[];for(let i=0;i<180/dt;i++){s.step(dt);powerSum+=s.rowing.telemetry.positivePower;powerPeak=Math.max(powerPeak,s.rowing.telemetry.positivePower);if(i%1200===0)trace.push({seconds:i*dt,stamina:s.crew.stamina,order:s.crew.orderIndex,power:s.rowing.telemetry.positivePower,load:s.rowing.telemetry.crewLoad});window.push(s.speed*kn);if(window.length>600)window.shift();if(i<30/dt&&window.length===600)max=Math.max(max,window.reduce((a,b)=>a+b,0)/600);if(s.crew.orderIndex!==5&&demoted===null)demoted=(i+1)*dt;}
 assert.ok(max>=base+.2,`sprint gain ${max-base}`);assert.ok(max<10);assert.ok(demoted>=60&&demoted<=180,`demotion ${demoted}`);report.measured.speeds=results;report.measured.sprint={base,max,demoted,meanPowerW:powerSum/(180/dt),peakPowerW:powerPeak,trace};
});
test('hold stops passively and differential steering mirrors',()=>{
 const hold=vessel(),coast=vessel();hold.vel.set(0,0,-4);coast.vel.set(0,0,-4);hold.crew.holdWater=true;
 let th=null,tc=null;for(let i=0;i<60/dt;i++){hold.step(dt);coast.step(dt);if(Math.abs(hold.speed)<=.3&&th===null)th=i*dt;if(Math.abs(coast.speed)<=.3&&tc===null)tc=i*dt;assert.ok(hold.speed>=-.05);}assert.ok(th!==null&&th<60);assert.ok(tc===null||th<tc);
 const runs=[];for(const helm of [-1,1]){const s=vessel();s.crew.setOrder(4);s.helm=helm;simulate(s,20);runs.push({heading:s.heading,speed:s.speed});assert.ok(Math.sign(s.heading)===helm);assert.ok(Math.abs(s.heading)>=15*Math.PI/180);}
 near(runs[0].speed,runs[1].speed,.02*Math.abs(runs[0].speed));near(runs[0].heading,-runs[1].heading,.02*Math.abs(runs[0].heading));report.measured.hold={holdStopSeconds:th,coastStopSeconds:tc};report.measured.pivot=runs;
});
test('events, interpolation and fixed-step schedule independence',()=>{
 const r=new RowingSystem(new Crew()),a=r.events.createCursor(),b=r.events.createCursor();r.crew.setOrder(4);const body=locked(),water=flat();for(let i=0;i<400;i++)rowStep(r,body,water,(i+1)*dt);
 const idsA=[],idsB=[];r.events.read(a,2,e=>idsA.push(e.id));r.events.read(a,Infinity,e=>idsA.push(e.id));r.events.read(b,Infinity,e=>idsB.push(e.id));assert.deepEqual(idsA,idsB);assert.equal(new Set(idsA).size,idsA.length);
 const k=createKinematics();for(let i=0;i<170;i++){r.renderPose(i,0,k);const j=r.previous.joint;near(k.center.x,r.slots[i].x+r.slots[i].bladeRadius*k.axis.x);near(Math.cos(j[i*6]),Math.abs(k.axis.x)/Math.cos(j[i*6+1]),1e-9);r.renderPose(i,1,k);assert.ok(Number.isFinite(k.center.y));}
 const outputs=[];for(const fps of [30,60,144]){const ship=vessel();let acc=0,ticks=0;for(let frame=0;frame<fps*3;frame++){acc+=1/fps;while(acc>=dt-1e-12){ship.crew.setOrder(ticks<120?2:4);ship.step(dt);acc-=dt;ticks++;}}assert.equal(ticks,360);outputs.push([...ship.pos.toArray(),...ship.quat.toArray(),ship.crew.stamina]);}assert.deepEqual(outputs[0],outputs[1]);assert.deepEqual(outputs[0],outputs[2]);
});
test('audio contact grouping and event epoch reset',()=>{
 const row=new RowingSystem(new Crew()),audio=new AudioEngine(),beats=[],contacts=[];
 audio.strokeBeat=i=>beats.push(i);audio.oarContact=(side,enter,intensity)=>contacts.push({side,enter,intensity});
 row.events.push('catchBeat',1,-1,-1,0,0,0,.4);row.events.push('catchBeat',1.01,-1,1,0,0,0,.4);
 row.events.push('enterWater',1.01,0,-1,0,0,0,.3);row.events.push('enterWater',1.02,2,-1,0,0,0,.4);
 audio.rowingEvents(row,1.03);assert.equal(beats.length,1);assert.equal(contacts.length,0);
 audio.rowingEvents(row,1.06);assert.equal(contacts.length,1);near(contacts[0].intensity,.5);
 row.events.push('leaveWater',2.02,0,-1,0,0,0,.9);audio.rowingEvents(row,2.03);
 row.events.clear();row.events.push('catchBeat',0,-1,-1,0,0,0,.5);audio.rowingEvents(row,.01);assert.equal(beats.length,2);audio.rowingEvents(row,3);assert.equal(contacts.length,1);
 const a=row.events.createCursor(),b=row.events.createCursor();for(let i=0;i<row.events.capacity+10;i++)row.events.push('catchBeat',4+i*dt,-1,1,0,0,0,.1);
 row.events.read(a,Infinity,()=>{});row.events.read(b,Infinity,()=>{});assert.equal(row.events.overflows,2);row.events.clear();row.events.read(a,Infinity,()=>{});assert.equal(row.events.overflows,0);
});
test('turning envelope, passive empty-reservoir hold and low-load recovery',()=>{
 const ship=vessel();ship.crew.setOrder(3);simulate(ship,60);ship.helm=1;
 const heading0=ship.heading,origin=ship.pos.clone();let turn=0,previous=heading0,t90=null,t180=null,diameter=0;
 for(let i=0;i<90/dt;i++){ship.step(dt);let delta=ship.heading-previous;delta=Math.atan2(Math.sin(delta),Math.cos(delta));turn+=delta;previous=ship.heading;diameter=Math.max(diameter,ship.pos.distanceTo(origin));if(turn>=Math.PI/2&&t90===null)t90=(i+1)*dt;if(turn>=Math.PI&&t180===null)t180=(i+1)*dt;assert.ok(Number.isFinite(turn));}
 assert.ok(t90>=15&&t90<=90,`90 degree turn ${t90}`);report.measured.turning={t90,t180,maxDistanceFromTurnStart:diameter};
 const body=locked(),crew=new Crew(),row=new RowingSystem(crew),water=flat();crew.holdWater=true;
 for(let i=0;i<120;i++)rowStep(row,body,water,i*dt);row.energy.fill(0);body.vel.set(0,0,-4);
 const kinetic0=body.vel.lengthSq(),mass=56600;let work=0;
 for(let i=0;i<2400;i++){const result=rowStep(row,body,water,(120+i)*dt);near(row.telemetry.positivePower,0,1e-8);assert.ok(result.f.dot(body.vel)<=1e-7);work+=result.f.dot(body.vel)*dt;body.vel.addScaledVector(result.f,dt/mass);assert.ok(body.vel.lengthSq()<=kinetic0*(1+1e-6));}
 assert.ok(work<0);report.measured.isolatedHold={workJ:work,initialSpeed:4,finalSpeed:body.vel.length()};
 for(const order of [1,2]){const s=vessel();s.crew.stamina=.5;s.crew.setOrder(order);let previous=.5;for(let i=0;i<30/dt;i++){s.step(dt);assert.ok(s.crew.stamina>=previous-1e-12);previous=s.crew.stamina;}}
 const stop=vessel();const cursor=stop.rowing.events.createCursor();let beats=0;simulate(stop,120,dt,()=>stop.rowing.events.read(cursor,Infinity,e=>{if(e.kind==='catchBeat')beats++;}));assert.equal(beats,0);near(stop.rowing.telemetry.oarThrust,0);assert.ok(stop.rowing.current.forceWorld.every(f=>f===0));
});
test('numerical convergence including hold and single-wave contacts',()=>{
 const comparisons=[];
 for(const scenario of ['full','back','hold','wave']){const runs=[];for(const h of [1/120,1/240]){const s=vessel(scenario==='wave'?single(.5,.5,.3):flat());s.crew.setOrder(scenario==='back'?0:scenario==='hold'?1:4);if(scenario==='hold'){s.vel.set(0,0,-4);s.crew.holdWater=true;}
 const cursor=s.rowing.events.createCursor(),counts=new Uint16Array(170);const data=simulate(s,20,h,()=>s.rowing.events.read(cursor,s.time,e=>{if(e.bladeId>=0&&e.kind!=='catchBeat')counts[e.bladeId]++;}));s.rowing.events.read(cursor,Infinity,e=>{if(e.bladeId>=0&&e.kind!=='catchBeat')counts[e.bladeId]++;});runs.push({...data,counts});}
 const speedError=Math.abs(runs[0].meanKn/runs[1].meanKn-1),impulseError=Math.abs(runs[0].impulse/runs[1].impulse-1),contactError=Math.max(...runs[0].counts.map((a,i)=>Math.abs(a-runs[1].counts[i])));assert.ok(speedError<.03,`${scenario} speed ${speedError}`);assert.ok(impulseError<.05,`${scenario} impulse ${impulseError}`);assert.ok(contactError<=2,`${scenario} contacts ${contactError}`);comparisons.push({scenario,speedError,impulseError,contactError});}
 report.measured.convergence=comparisons;
});
if(!process.argv.includes('--quick'))test('10 minute default-sea stability and CPU cost',()=>{
 const weather=new Wind(3),water=new WaveField(weather,11),s=vessel(water),random=rng(87);const cursor=s.rowing.events.createCursor();let maxHeel=0;
 for(let i=0;i<600/dt;i++){
 if(i%1200===0){s.crew.setOrder([1,2,3,4,5,0][Math.floor(random()*6)]);s.helm=random()*1.4-.7;s.crew.holdWater=random()<.1;}
 weather.update(dt);if(i%120===0)water.retarget(weather);water.update(dt);s.step(dt);s.rowing.events.read(cursor,s.time,()=>{});maxHeel=Math.max(maxHeel,Math.abs(s.heel));assert.ok(Number.isFinite(s.pos.length()));near(s.quat.length(),1,1e-8);assert.ok(s.rowing.current.wetArea.every(a=>a>=0&&a<=.1122+1e-10));
 }
 assert.ok(maxHeel<Math.PI/3);assert.equal(s.rowing.events.overflows,0);
 s.crew.setOrder(4);s.crew.holdWater=false;for(let i=0;i<1000;i++)s.step(dt);
 const samples=[];for(let i=0;i<5000;i++){const t=performance.now();s.step(dt);samples.push(performance.now()-t);s.rowing.events.read(cursor,s.time,()=>{});}samples.sort((a,b)=>a-b);const mean=samples.reduce((a,b)=>a+b,0)/samples.length,p95=samples[Math.floor(samples.length*.95)];report.measured.cpu={mean,p50:samples[2500],p95,maxHeelDegrees:maxHeel*180/Math.PI,fallbackQueries:s.rowing.telemetry.fallbackQueries};assert.ok(mean<=1.5);assert.ok(p95<=3);
});
if(process.env.ROWING_REPORT)fs.writeFileSync(process.env.ROWING_REPORT,JSON.stringify(report,null,2));
console.log(JSON.stringify(report.measured,null,2));if(failures)process.exitCode=1;
