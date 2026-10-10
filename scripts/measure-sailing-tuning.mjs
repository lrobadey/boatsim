import './register-ts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import * as THREE from 'three';

const { Crew } = await import('../src/ship/crew.ts');
const { ShipPhysics } = await import('../src/ship/physics.ts');
const { SailingSystem, SAIL_AERO } = await import('../src/ship/sailing.ts');
const { Wind, DEFAULT_WIND_SPEED } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');

const dt = 1 / 120;
const KNOTS_PER_MPS = 1.943844;
const QUICK = process.argv.includes('--quick');
const WEATHER = process.argv.includes('--weather');
const argValue = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const secondsArg = Number(argValue('seconds') ?? 120);
if (!Number.isFinite(secondsArg) || secondsArg <= 0) throw new Error('--seconds must be a positive number');
const SECONDS = secondsArg;
const bearingNames = new Map([[180, 'following'], [135, 'broad-reach'], [90, 'beam'], [0, 'headwind']]);
const defaults = QUICK
  ? { winds: [8, 12, 14, 16], bearings: [180], regimes: ['combined-full-sail-full-rowing'] }
  : { winds: [4, 8, 12, 14, 16], bearings: [180, 135, 90, 0], regimes: null };
function parseNumbers(name, fallback) {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const values = raw.split(',').map(value => Number(value.trim()));
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error(`--${name} expects comma-separated numbers`);
  return values;
}
const windSpeeds = parseNumbers('winds', defaults.winds);
if (windSpeeds.some(value => value < 0)) throw new Error('--winds values must be nonnegative');
const headings = parseNumbers('bearings', defaults.bearings).map(trueWindFromDegrees => ({ name: bearingNames.get(trueWindFromDegrees) ?? `wind-from-${trueWindFromDegrees}`, trueWindFromDegrees }));
const allRegimes = [
  { name: 'sail-only', deployment: 1, order: 1 },
  { name: 'full-rowing-only', deployment: 0, order: 4 },
  { name: 'combined-full-sail-full-rowing', deployment: 1, order: 4 },
  { name: 'combined-half-sail-full-rowing', deployment: 0.5, order: 4 },
];
const rawRegimes = argValue('regimes');
const regimeNames = rawRegimes === undefined ? defaults.regimes : rawRegimes.split(',').map(value => value.trim());
const regimes = regimeNames === null ? allRegimes : regimeNames.map(name => {
  const regime = allRegimes.find(candidate => candidate.name === name);
  if (!regime) throw new Error(`Unknown --regimes entry: ${name}; valid names: ${allRegimes.map(candidate => candidate.name).join(', ')}`);
  return regime;
});
const terrain = { heightAt: () => -100, normalAt: (_x, _z, out) => out.set(0, 1, 0) };
const report = {
  purpose: 'Deterministic sail and rowing measurements using production parameters recorded at process start; no force or speed overrides.',
  host: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model, runtime: process.version },
  sourceParametersAtProcessStart: { sailPressureDragCoefficient: SAIL_AERO.pressureDrag, sailAero: { ...SAIL_AERO }, defaultWindSpeedMps: DEFAULT_WIND_SPEED },
  configuration: { quick: QUICK, weather: WEATHER, weatherSeed: WEATHER ? 3 : null, waveSeed: WEATHER ? 3 : null, waveRetargetSeconds: WEATHER ? 1 : null, simulatedSecondsPerScenario: SECONDS, stepSeconds: dt, measuredLateWindowSeconds: Math.min(30, SECONDS), windSpeedsMps: windSpeeds, trueWindFromBearingsRelativeToInitialHeadingDegrees: headings, rowingOrder: 'Full (index 4)', modes: regimes.map(({ name, deployment }) => ({ name, sailDeployment: deployment })) },
  scenarios: [],
  staticTargetCheck: null,
};

function flatWater() {
  const waves = new WaveField(new Wind(1), 3);
  waves.waves.length = 0;
  return waves;
}

function uniformWind(speed, trueWindFromDegrees) {
  const from = trueWindFromDegrees * Math.PI / 180;
  // Fixed world true-wind direction, expressed relative to the ship's initial heading (zero).
  return { vx: -Math.sin(from) * speed, vz: Math.cos(from) * speed };
}

function createShip(speed, trueWindFromDegrees, regime) {
  let wind, waves;
  if (WEATHER) {
    wind = new Wind(3);
    wind.baseSpeed = speed;
    wind.baseFrom = trueWindFromDegrees * Math.PI / 180;
    wind.update(0);
    waves = new WaveField(wind, 3);
  } else {
    wind = uniformWind(speed, trueWindFromDegrees);
    waves = flatWater();
  }
  const crew = new Crew();
  const ship = new ShipPhysics(waves, wind, terrain, crew);
  ship.place(0, 0, 0);
  crew.setOrder(regime.order);
  ship.sailing.trimMode = 'auto';
  ship.sailing.deploymentTarget = regime.deployment;
  return { ship, wind, waves };
}

function measureScenario(windSpeed, heading, regime, index, total) {
  const { ship, wind, waves } = createShip(windSpeed, heading.trueWindFromDegrees, regime);
  const samplesNeeded = Math.round(Math.min(30, SECONDS) / dt);
  let lateSpeedSum = 0, lateCount = 0, lateForwardSum = 0, lateSideSum = 0, lateLoadSum = 0, latePowerSum = 0;
  let lateOarThrustSum = 0, lateApparentSum = 0, apparentSinSum = 0, apparentCosSum = 0;
  let lateAbsHeelSum = 0, lateAbsLeewaySum = 0, lateForwardCount = 0;
  let maxHeel = 0, maxForwardAbsLeeway = 0, maxSpeed = 0;
  const steps = Math.round(SECONDS / dt);
  for (let i = 0; i < steps; i++) {
    if (WEATHER) {
      wind.update(dt);
      if (i % 120 === 0) waves.retarget(wind);
      waves.update(dt);
    }
    ship.step(dt);
    const heel = Math.abs(ship.heel);
    maxHeel = Math.max(maxHeel, heel);
    maxSpeed = Math.max(maxSpeed, Math.abs(ship.speed));
    if (ship.speed > 0.5) maxForwardAbsLeeway = Math.max(maxForwardAbsLeeway, Math.abs(ship.leeway));
    if (i >= steps - samplesNeeded) {
      lateSpeedSum += ship.speed;
      lateForwardSum += ship.sailing.telemetry.forwardForce;
      lateSideSum += ship.sailing.telemetry.lateralForce;
      lateLoadSum += ship.sailing.telemetry.load;
      latePowerSum += ship.rowing.telemetry.positivePower;
      lateOarThrustSum += ship.oarThrust;
      lateApparentSum += ship.sailing.telemetry.apparentSpeed;
      const apparentFrom = ship.sailing.telemetry.apparentFrom;
      apparentSinSum += Math.sin(apparentFrom);
      apparentCosSum += Math.cos(apparentFrom);
      if (ship.speed > 0.5) {
        lateAbsHeelSum += Math.abs(ship.heel);
        lateAbsLeewaySum += Math.abs(ship.leeway);
        lateForwardCount++;
      }
      lateCount++;
    }
  }
  const result = {
    index,
    total,
    windSpeedMps: windSpeed,
    trueWindFromBearingRelativeToInitialHeading: heading.name,
    trueWindFromBearingRelativeToInitialHeadingDegrees: heading.trueWindFromDegrees,
    weatherMode: WEATHER ? 'Wind + WaveField, seed 3, wind update every step, wave retarget at 1 Hz' : 'uniform wind, flat water',
    regime: regime.name,
    sailDeploymentTarget: regime.deployment,
    rowingOrder: ship.crew.order.name,
    meanLast30SpeedMps: lateSpeedSum / lateCount,
    meanLast30SpeedKnots: lateSpeedSum / lateCount * KNOTS_PER_MPS,
    finalSpeedMps: ship.speed,
    maxAbsoluteSpeedMps: maxSpeed,
    finalHeadingDegrees: ship.heading * 180 / Math.PI,
    finalHeelDegrees: ship.heel * 180 / Math.PI,
    maxAbsoluteHeelDegrees: maxHeel * 180 / Math.PI,
    meanLast30AbsoluteHeelDegrees: lateForwardCount ? lateAbsHeelSum / lateForwardCount * 180 / Math.PI : null,
    finalLeewayDegrees: ship.leeway * 180 / Math.PI,
    maxAbsoluteLeewayDegreesWhenForward: maxForwardAbsLeeway * 180 / Math.PI,
    meanLast30AbsoluteLeewayDegrees: lateForwardCount ? lateAbsLeewaySum / lateForwardCount * 180 / Math.PI : null,
    meanLast30SailForwardForceN: lateForwardSum / lateCount,
    meanLast30SailSideForceN: lateSideSum / lateCount,
    meanLast30SailLoadN: lateLoadSum / lateCount,
    meanLast30ApparentWindSpeedMps: lateApparentSum / lateCount,
    meanLast30ApparentFromDegrees: Math.atan2(apparentSinSum, apparentCosSum) * 180 / Math.PI,
    last30ForwardSpeedSampleCountForMeanAngles: lateForwardCount,
    meanLast30RowingPositivePowerW: latePowerSum / lateCount,
    meanLast30OarThrustN: lateOarThrustSum / lateCount,
    finalStamina: ship.crew.stamina,
    finalSailStatus: ship.sailing.telemetry.status,
    finalYardAngleDegrees: ship.sailing.current.yardAngle * 180 / Math.PI,
  };
  report.scenarios.push(result);
  console.log(`MEASURED ${index}/${total} ${windSpeed} m/s true-from ${heading.trueWindFromDegrees}° ${regime.name}: ${result.meanLast30SpeedKnots.toFixed(3)} kn, max heel ${result.maxAbsoluteHeelDegrees.toFixed(2)}°, stamina ${result.finalStamina.toFixed(3)}`);
  return result;
}

function measureStaticTarget() {
  const targetSpeedMps = 8 / KNOTS_PER_MPS;
  const wind = uniformWind(8, 180);
  const body = {
    pos: new THREE.Vector3(0, 0.3, 0),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(0, 0, -targetSpeedMps),
    angVel: new THREE.Vector3(),
    cg: new THREE.Vector3(0, 0.3, 0),
  };
  const sail = new SailingSystem();
  sail.deploymentTarget = 1;
  sail.trimMode = 'auto';
  const force = new THREE.Vector3(), torque = new THREE.Vector3();
  for (let i = 0; i < 60 / dt; i++) sail.step(dt, (i + 1) * dt, body, wind, force.set(0, 0, 0), torque.set(0, 0, 0));

  // Estimate still-water axial resistance from one short, sail-furled rigid-body step at 8 kn.
  const crew = new Crew(), waves = flatWater(), calm = { vx: 0, vz: 0 };
  const ship = new ShipPhysics(waves, calm, terrain, crew);
  ship.place(0, 0, 0);
  for (let i = 0; i < 240; i++) ship.step(dt);
  ship.vel.set(0, 0, -targetSpeedMps);
  const before = ship.vel.z;
  ship.step(dt);
  const estimatedResistanceN = ship.mass * (ship.vel.z - before) / dt;
  return {
    condition: '8 kn forward speed, 8 m/s following wind, uniform air, flat calm water',
    targetSpeedMps,
    targetSpeedKnots: 8,
    sailLoadN: sail.telemetry.load,
    sailForwardForceN: sail.telemetry.forwardForce,
    sailSideForceN: sail.telemetry.lateralForce,
    sailFill: sail.current.fill,
    sailStatus: sail.telemetry.status,
    yardAngleDegrees: sail.current.yardAngle * 180 / Math.PI,
    estimatedStillWaterAxialResistanceN: estimatedResistanceN,
    method: 'ShipPhysics acceleration from one 1/120 s step at target speed, flat water, calm air, sail furled and crew stopped; sign is positive opposing forward motion.',
  };
}

const total = windSpeeds.length * headings.length * regimes.length;
if (!windSpeeds.length || !headings.length || !regimes.length) throw new Error('Scenario filters selected no cases');
let index = 0;
for (const windSpeed of windSpeeds) {
  for (const heading of headings) {
    for (const regime of regimes) {
      index++;
      measureScenario(windSpeed, heading, regime, index, total);
    }
  }
}
report.staticTargetCheck = measureStaticTarget();
if (process.env.SAILING_TUNING_REPORT) fs.writeFileSync(process.env.SAILING_TUNING_REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ configuration: report.configuration, staticTargetCheck: report.staticTargetCheck, scenarioCount: report.scenarios.length }, null, 2));
