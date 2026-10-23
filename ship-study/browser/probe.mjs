// Run the exact isolated browser body + unmodified game subsystems without a browser.
import '../../scripts/register-ts.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {Trial}=await import('./simulation.ts');
const {buildColumns,HYDRO}=await import('./design.ts');
const report={created:new Date().toISOString(),hydrostaticReference:HYDRO,cases:{},convergence:[]};
for(const [stations,strips] of [[32,8],[64,16],[128,32]]) {
  const cols=buildColumns(stations,strips),mass=cols.reduce((m,c)=>m+1025*c.area*Math.max(0,-c.bottom),0);
  report.convergence.push({stations,strips,columns:cols.length,massKg:mass,relativeError:mass/HYDRO.mass-1});
}
const cases=[
  ['rest',60,t=>{t.wind.baseSpeed=0;t.sail=0;t.setOrder(1);}],
  ['row',240,t=>{t.wind.baseSpeed=0;t.sail=0;t.setOrder(4);}],
  ['row_one_hand',240,t=>{t.setHandsPerOar(1);t.wind.baseSpeed=0;t.sail=0;t.setOrder(4);}],
  ['sail',240,t=>{t.setOrder(1);}],
  ['combined',240,t=>{}],
  ['test_drive',360,t=>{t.wind.baseSpeed=0;t.sail=0;t.setOrder(1);t.auxiliaryKN=6.4;}],
  ['pivot',240,t=>{t.wind.baseSpeed=0;t.sail=0;t.setOrder(4);t.headingHold=false;t.helm=1;}],
  ['rudder_at_rest',60,t=>{t.wind.baseSpeed=0;t.sail=0;t.setOrder(1);t.headingHold=false;t.helm=1;}],
];
const selected=process.argv.find(a=>a.startsWith('--case='))?.split('=')[1];
for(const [name,seconds,setup] of cases) {
  if(selected&&selected!==name)continue;
  const t=new Trial();setup(t);const heading0=t.ship.heading,start=performance.now();
  for(let i=0;i<seconds*120;i++)t.step();
  const snap=t.snapshot(),tail=t.history.slice(-120),mean=key=>tail.reduce((a,r)=>a+r[key],0)/tail.length;
  report.cases[name]={...snap,cpuSeconds:(performance.now()-start)/1000,meanLast30s:{speedKn:mean('speed')/.514444,
    rowerKW:mean('rowerW')/1000,hullKW:mean('hullW')/1000,oarKN:mean('oarN')/1000,sailKN:mean('sailN')/1000},
    headingChangeDeg:Math.atan2(Math.sin(t.ship.heading-heading0),Math.cos(t.ship.heading-heading0))*180/Math.PI,maxHeelDeg:t.maxHeel*180/Math.PI};
  assert(snap.sample.forceClosureN<1e-4,`${name}: external force / momentum does not close`);
  assert(Math.abs(t.ship.heel)<Math.PI/4,`${name}: unsafe roll or unstable integration`);
  if(name==='rest') {assert(t.ship.vel.length()<.001);assert(Math.abs(t.ship.pos.y-t.ship.cg.y)<.001);}
  if(name==='row')assert(mean('rowerW')>100&&mean('speed')>0,'Working crew must do positive work and move ahead');
  if(name==='sail')assert(mean('sailN')>0&&mean('speed')>0,'Sails must drive the actual rigid body');
  if(name==='pivot')assert(Math.abs(report.cases[name].headingChangeDeg)>5,'Differential crew must turn the ship');
  if(name==='rudder_at_rest')assert(Math.abs(report.cases[name].headingChangeDeg)<.1,'No artificial turning torque at rest');
  fs.mkdirSync(new URL('./results/',import.meta.url),{recursive:true});
  const keys=Object.keys(t.history[0]);
  fs.writeFileSync(new URL(`./results/${name}.csv`,import.meta.url),[keys.join(','),...t.history.map(r=>keys.map(k=>r[k]).join(','))].join('\n'));
  console.log(name,JSON.stringify({mean:report.cases[name].meanLast30s,headingChange:report.cases[name].headingChangeDeg,heel:report.cases[name].maxHeelDeg,ms:snap.performance.physicsMsPerStep}));
}
fs.mkdirSync(new URL('./results/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL(`./results/${selected??'report'}.json`,import.meta.url),JSON.stringify(report,null,2));
console.log('PASS: finite state, force/momentum closure, flotation and selected propulsion checks');
