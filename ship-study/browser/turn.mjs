import '../../scripts/register-ts.mjs';
import fs from 'node:fs';
const {Trial}=await import('./simulation.ts');
const t=new Trial();t.wind.baseSpeed=0;t.sail=0;t.setOrder(4);
for(let i=0;i<240*120;i++)t.step();
const entry={time:t.ship.time,heading:t.ship.heading,speedKn:t.ship.speed/.514444,x:t.ship.pos.x,z:t.ship.pos.z};
const rudderArea=Number(process.argv.find(a=>a.startsWith('--area='))?.split('=')[1]??2);
t.design.rudder.area=rudderArea;
t.headingHold=false;t.helm=1;t.clearLedger();let last=t.ship.heading,angle=0,at90=null,at180=null;
const rows=[];
for(let i=0;i<300*120;i++) {
  t.step();const h=t.ship.heading;angle+=Math.atan2(Math.sin(h-last),Math.cos(h-last));last=h;
  if(i%30===0)rows.push({...t.sample(),turnDegrees:angle*180/Math.PI,turnTime:t.ship.time-entry.time});
  const dx=t.ship.pos.x-entry.x,dz=t.ship.pos.z-entry.z;
  const observation={seconds:t.ship.time-entry.time,speedKn:t.ship.speed/.514444,
    advance:dx*Math.sin(entry.heading)-dz*Math.cos(entry.heading),transfer:dx*Math.cos(entry.heading)+dz*Math.sin(entry.heading)};
  if(!at90&&angle>=Math.PI/2)at90=observation;
  if(!at180&&angle>=Math.PI)at180=observation;
}
const report={created:new Date().toISOString(),entry,rudderAreaEach:rudderArea,at90,at180,finalTurnDeg:angle*180/Math.PI,settings:t.snapshot().settings,
  final:t.snapshot(),method:'240 s full-rowing run-up in flat calm water, sails furled, then hard starboard for 300 s. 3 hands per oar grouped motor approximation; no forced yaw.'};
const stem=rudderArea===2?'turn':`turn-rudder-${rudderArea}`;
fs.mkdirSync(new URL('./results/',import.meta.url),{recursive:true});fs.writeFileSync(new URL(`./results/${stem}.json`,import.meta.url),JSON.stringify(report,null,2));
const keys=Object.keys(rows[0]);fs.writeFileSync(new URL(`./results/${stem}.csv`,import.meta.url),[keys.join(','),...rows.map(r=>keys.map(k=>r[k]).join(','))].join('\n'));
console.log(JSON.stringify({entry,rudderAreaEach:rudderArea,at90,at180,finalTurnDeg:report.finalTurnDeg,closure:report.final.sample.forceClosureN},null,2));
