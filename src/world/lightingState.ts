import * as THREE from 'three';
import { clamp, smoothstep } from '../core/util';
import type { AstroClock } from './astro';

export type NumericTuple3 = readonly [number, number, number];

export const LIGHTING_PROFILE = Object.freeze({ name: 'aegean-skylight', version: 2, skySpecularShadowCoupling: 0 });

/** Immutable, linear-space lighting inputs shared by the live sky consumers. */
export interface LightingState {
  readonly profileName: string;
  readonly profileVersion: number;
  readonly sunDir: NumericTuple3;
  readonly moonDir: NumericTuple3;
  readonly directDir: NumericTuple3;
  readonly directRGB: NumericTuple3;
  readonly nightSkyRGB: NumericTuple3;
  readonly twilightSkyRGB: NumericTuple3;
  readonly cloudAmbTopRGB: NumericTuple3;
  readonly cloudAmbBottomRGB: NumericTuple3;
  readonly night: number;
  readonly sunIntensity: number;
  readonly hemiIntensity: number;
  readonly starVisibility: number;
  readonly moonBright: number;
  readonly moonVisible: number;
  readonly moonRight: NumericTuple3;
  readonly moonUp: NumericTuple3;
  readonly moonSun: NumericTuple3;
  readonly targetExposure: number;
  readonly phase: number;
  readonly absoluteHours: number;
  readonly activeSource: 'sun' | 'moon';
}

function tuple3(x: number, y: number, z: number): NumericTuple3 {
  return Object.freeze([x, y, z]) as NumericTuple3;
}

/** Evaluate the existing sky, direct-light, cloud-ambient, and exposure formulas without side effects. */
export function evaluateLighting(clock: AstroClock): LightingState {
  const sun = new THREE.Vector3(clock.sunDir.x, clock.sunDir.y, clock.sunDir.z);
  const moon = new THREE.Vector3(clock.moonDir.x, clock.moonDir.y, clock.moonDir.z);
  const sunY = sun.y;
  const night = smoothstep(0.05, -0.16, sunY);

  // Sun transmittance through air mass (Kasten-Young), Rayleigh + hazy aerosol.
  const altDeg = (Math.asin(clamp(sunY, -1, 1)) * 180) / Math.PI;
  const m = 1 / (Math.max(0.0, Math.sin((Math.max(altDeg, -1) * Math.PI) / 180))
    + 0.50572 * Math.pow(Math.max(altDeg, -3.5) + 6.07995, -1.6364));
  const tr: NumericTuple3 = [
    Math.exp(-(0.045 + 0.06) * m),
    Math.exp(-(0.1 + 0.07) * m),
    Math.exp(-(0.23 + 0.08) * m),
  ];
  const sunVis = smoothstep(-0.035, 0.03, sunY);
  const sunIntensity = 4.2 * sunVis;

  const phase = clock.moonPhase;
  const phaseLight = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const lunarHandoff = smoothstep(-0.04, -0.14, sunY);
  const moonVis = smoothstep(-0.02, 0.1, moon.y) * night * lunarHandoff;
  const moonI = 0.08 * phaseLight * moonVis;
  const skyMoon = phaseLight * smoothstep(-0.05, 0.15, moon.y) * smoothstep(0.0, -0.1, sunY);
  const nightSkyScale = skyMoon * (1 - 0.35 * night);
  const nightSkyRGB = tuple3(0.0022 * nightSkyScale, 0.0048 * nightSkyScale, 0.0115 * nightSkyScale);

  const afterSunset = smoothstep(0, -0.035, sunY);
  const remainTwilight = 1 - smoothstep(-0.035, -0.20, sunY);
  const twilightWeight = afterSunset * remainTwilight;
  const twilightSkyRGB = tuple3(0.012 * twilightWeight, 0.020 * twilightWeight, 0.042 * twilightWeight);

  const activeSource = sunY > -0.04 ? 'sun' : 'moon';
  const directDir = activeSource === 'sun' ? sun : moon;
  const directRGB = activeSource === 'sun'
    ? tuple3(tr[0] * sunIntensity, tr[1] * sunIntensity, tr[2] * sunIntensity)
    : tuple3(0.72 * moonI, 0.8 * moonI, moonI);

  const twilight = 4 * night * (1 - night);
  const hemiIntensity = 0.05 * night + 0.12 * twilight;
  const starVisibility = smoothstep(-0.05, -0.2, sunY);

  // Same camera-facing moon frame and transforms used by the sky shader today.
  const moonFrame = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(), moon, new THREE.Vector3(0, 1, 0)),
  );
  const moonRightV = new THREE.Vector3(1, 0, 0).applyQuaternion(moonFrame);
  const moonUpV = new THREE.Vector3(0, 1, 0).applyQuaternion(moonFrame);
  const moonRight = tuple3(moonRightV.x, moonRightV.y, moonRightV.z);
  const moonUp = tuple3(moonUpV.x, moonUpV.y, moonUpV.z);
  const moonSun = tuple3(sun.dot(moonRightV), sun.dot(moonUpV), -sun.dot(moon));
  const moonBright = (0.4 + 0.55 * night) * (0.3 + 0.7 * smoothstep(-0.05, 0.05, moon.y));
  const moonVisible = moon.y > -0.1 ? 1 : 0;

  // game.ts cloud inputs, in linear authored RGB.
  const day = clamp((sunY + 0.08) / 0.33, 0, 1);
  const daylight = day * day * (3 - 2 * day);
  const moonlight = phaseLight * smoothstep(-0.02, 0.1, moon.y) * night;
  const airglow = 0.012;
  const solarFill = airglow + (1 - airglow) * daylight;
  const cloudAmbTopRGB = tuple3(
    0.36 * solarFill + 0.018 * moonlight + 0.7 * twilightSkyRGB[0],
    0.46 * solarFill + 0.027 * moonlight + 0.7 * twilightSkyRGB[1],
    0.62 * solarFill + 0.045 * moonlight + 0.7 * twilightSkyRGB[2],
  );
  const cloudAmbBottomRGB = tuple3(
    0.09 * solarFill + 0.004 * moonlight + 0.1 * twilightSkyRGB[0],
    0.1 * solarFill + 0.006 * moonlight + 0.1 * twilightSkyRGB[1],
    0.115 * solarFill + 0.01 * moonlight + 0.1 * twilightSkyRGB[2],
  );

  const directMax = Math.max(...directRGB);
  const E = directMax * Math.max(directDir.y, 0) + 0.5 * (1 - night) + 0.02;
  const targetExposure = 0.62 * Math.pow(1.35 / (E + 0.5), 0.42) * (1 + 2.1 * night);

  return Object.freeze({
    profileName: LIGHTING_PROFILE.name,
    profileVersion: LIGHTING_PROFILE.version,
    sunDir: tuple3(sun.x, sun.y, sun.z),
    moonDir: tuple3(moon.x, moon.y, moon.z),
    directDir: tuple3(directDir.x, directDir.y, directDir.z),
    directRGB,
    nightSkyRGB,
    twilightSkyRGB,
    cloudAmbTopRGB,
    cloudAmbBottomRGB,
    night,
    sunIntensity,
    hemiIntensity,
    starVisibility,
    moonBright,
    moonVisible,
    moonRight,
    moonUp,
    moonSun,
    targetExposure,
    phase,
    absoluteHours: clock.dayCount * 24 + clock.hours,
    activeSource,
  });
}
