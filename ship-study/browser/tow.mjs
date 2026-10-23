/** Prescribed-speed bare-hull resistance measurements using the exact browser prototype solver.
 * The carriage holds the upright body at speed; this is a towing diagnostic, not gameplay thrust.
 */
import '../../scripts/register-ts.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const {Trial}=await import('./simulation.ts');
const t=new Trial(),s=t.ship;t.wind.baseSpeed=0;t.sail=0;t.setOrder(1);t.rowingEnabled=false;t.headingHold=false;t.helm=0;
s.sailing.current.deployment=0;t.aft.current.deployment=0;
const rows=[];
for(const knots of [1,2,3,4,5,6,8]) {
  const v=knots*.514444;t.clearLedger();
  for(let i=0;i<120;i++) {
    s.quat.identity();s.angVel.set(0,0,0);s.vel.set(0,0,-v);s.pos.y=s.cg.y;s.heading=0;s.speed=v;t.step();
  }
  const result=t.snapshot(),waterN=result.ledger.water.forceN[2],airN=result.ledger.windage.forceN[2],rudderN=result.ledger.rudders.forceN[2],forceN=waterN+airN+rudderN;
  const effectiveW=forceN*v,acceleratingN=s.mass*v/180;
  assert(forceN>0&&Number.isFinite(effectiveW),'Tow resistance must oppose travel and be finite');
  rows.push({knots,speedMps:v,waterDragN:waterN,stillAirDragN:airN,rudderDragN:rudderN,steadyThrustN:forceN,effectivePowerW:effectiveW,
    shaftPowerWAt60Percent:effectiveW/.6,
    humansAt140WAnd40Percent:Math.ceil(effectiveW/(140*.4)),humansAt140WAnd60Percent:Math.ceil(effectiveW/(140*.6)),
    extraThrustFor180sRampN:acceleratingN,endOf180sRampPowerW:(forceN+acceleratingN)*v});
}
const report={schema:'thalassa-tow-v1',created:new Date().toISOString(),massKg:s.mass,rows,
  method:'Constant-speed upright carriage, 120 actual solver steps per point, no wind, no waves, oars disabled, sails fully furled. Water + still-air + current rudder profile drag.',
  interpretation:['Effective power = thrust times speed. Shaft/motor power must cover propulsor losses.',
    '40% and 60% overall human-to-hull efficiencies are explicit scenarios, not measured efficiencies.',
    '180-second acceleration is a constant acceleration sizing example; added mass is not enabled.',
    'Current longitudinal resistance law excludes catamaran interference, further appendage drag and structural constraints.'],
  body:snapshotBody(t)};
function snapshotBody(t){return t.snapshot().body;}
fs.mkdirSync(new URL('./results/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('./results/tow.json',import.meta.url),JSON.stringify(report,null,2));
console.table(rows.map(r=>({kn:r.knots,kN:(r.steadyThrustN/1000).toFixed(2),effectiveKW:(r.effectivePowerW/1000).toFixed(1),shaftKW:(r.shaftPowerWAt60Percent/1000).toFixed(1),rowers40to60:`${r.humansAt140WAnd60Percent}-${r.humansAt140WAnd40Percent}`,extraAccelKN:(r.extraThrustFor180sRampN/1000).toFixed(1)})));
