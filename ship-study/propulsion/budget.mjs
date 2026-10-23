/** Design exploration only: convert the existing provisional tow curve into power scenarios.
 * No propulsion law, animal simulation, browser state or game file is changed.
 */
import fs from 'node:fs';
const tow=JSON.parse(fs.readFileSync(new URL('../browser/results/tow.json',import.meta.url),'utf8'));
const assumptions={humanMechanicalW:100,oxMechanicalW:350,transmissionEfficiency:.8,propulsorEfficiency:.55};
const eta=assumptions.transmissionEfficiency*assumptions.propulsorEfficiency;
function speedAtPower(watts) {
  const a=tow.rows;
  if(watts<a[0].effectivePowerW || watts>a.at(-1).effectivePowerW)return null;
  for(let i=1;i<a.length;i++)if(watts<=a[i].effectivePowerW) {
    const lo=a[i-1],hi=a[i];
    const t=(Math.log(watts)-Math.log(lo.effectivePowerW))/(Math.log(hi.effectivePowerW)-Math.log(lo.effectivePowerW));
    return Math.exp(Math.log(lo.knots)+t*(Math.log(hi.knots)-Math.log(lo.knots)));
  }
  return null;
}
const requirements=tow.rows.filter(r=>[2,3,4,6].includes(r.knots)).map(r=>({
  knots:r.knots,steadyThrustN:r.steadyThrustN,hullPowerW:r.effectivePowerW,
  sourceMechanicalW:r.effectivePowerW/eta,
  workingHumans:Math.ceil(r.effectivePowerW/(assumptions.humanMechanicalW*eta)),
  workingOxen:Math.ceil(r.effectivePowerW/(assumptions.oxMechanicalW*eta)),
}));
const teams=[[80,0],[160,0],[300,0],[0,24],[0,48],[80,24]].map(([humans,oxen])=>{
  const sourceW=humans*assumptions.humanMechanicalW+oxen*assumptions.oxMechanicalW;
  return {humans,oxen,sourceMechanicalW:sourceW,hullPowerW:sourceW*eta,
    interpolatedCalmSteadyKn:speedAtPower(sourceW*eta)};
});
const report={schema:'thalassa-propulsion-budget-v1',scope:'design-only',created:new Date().toISOString(),
  sourceTowDate:tow.created,sourceMassKg:tow.massKg,assumptions,totalEfficiency:eta,requirements,teams,
  turningExample:{hullCentresMetres:17,eachOpposingDriveThrustN:10000,netSurgeN:0,yawTorqueNm:170000},
  storageExamples:{gravity:{massKg:10000,dropMetres:5,idealStoredJ:10000*9.81*5,idealSecondsAt20kW:10000*9.81*5/20000},
    flywheel:{rimMassKg:1000,radiusMetres:2,rpm:60,idealStoredJ:.5*1000*4*(2*Math.PI)**2}},
  limitations:['Tow resistance remains an uncalibrated current-game estimate.',
    '100 W human and 350 W ox values are active-work scenarios, not continuous all-day output.',
    '80% transmission and 55% propulsor efficiency are assumed scenarios, not ancient machinery measurements.',
    'Existing tow curve holds design load fixed; machinery, animals, food and water need a later weight/trim budget.',
    'Team speeds are log-log interpolation of existing steady tow points, not new dynamic simulations.',
    'Starting, stopping, turning, waves, bollard thrust, propeller wash and animal footing are not tested.'],
  sourceUrls:{power:'https://www.fao.org/4/ah810e/ah810e08.htm',
    mechanism:'https://www.fao.org/4/x5455b/x5455b0z.htm'}};
fs.writeFileSync(new URL('./budget.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.table(requirements.map(r=>({knots:r.knots,thrustKN:(r.steadyThrustN/1000).toFixed(2),hullKW:(r.hullPowerW/1000).toFixed(1),sourceKW:(r.sourceMechanicalW/1000).toFixed(1),humans:r.workingHumans,oxen:r.workingOxen})));
console.table(teams.map(r=>({humans:r.humans,oxen:r.oxen,sourceKW:(r.sourceMechanicalW/1000).toFixed(1),hullKW:(r.hullPowerW/1000).toFixed(2),steadyKn:r.interpolatedCalmSteadyKn?.toFixed(2)})));
