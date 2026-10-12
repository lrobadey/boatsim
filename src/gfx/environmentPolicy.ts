import type { LightingState } from '../world/lightingState';

export type EnvironmentRegime = 'day' | 'twilight' | 'night';

export interface EnvironmentInput {
  readonly lighting: LightingState;
  readonly profileName: string;
  readonly profileVersion: number;
  readonly animationTime: number;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly windX: number;
  readonly windZ: number;
  readonly coverage: number;
  readonly density: number;
  readonly erosion: number;
  readonly atmosphere: readonly number[];
  readonly sourceVersion: number;
  readonly radiance: number;
}

export function environmentRegime(lighting: LightingState): EnvironmentRegime {
  if (lighting.sunDir[1] < Math.sin(-12 * Math.PI / 180)) return 'night';
  if (lighting.sunDir[1] > Math.sin(6 * Math.PI / 180)) return 'day';
  return 'twilight';
}

export function environmentAgeLimitMs(lighting: LightingState): number {
  return environmentRegime(lighting) === 'twilight' ? 1000 : 4000;
}

function angleDegrees(a: readonly number[], b: readonly number[]): number {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * 180 / Math.PI;
}

/** Return an explanatory reason when a completed capture is stale, otherwise null. */
function hasMeaningfulChange(previous: EnvironmentInput, next: EnvironmentInput): boolean {
  if (previous.lighting.sunDir.some((v, i) => v !== next.lighting.sunDir[i])) return true;
  if (previous.lighting.moonDir.some((v, i) => v !== next.lighting.moonDir[i])) return true;
  if (previous.lighting.phase !== next.lighting.phase || previous.lighting.absoluteHours !== next.lighting.absoluteHours) return true;
  if (previous.profileName !== next.profileName || previous.profileVersion !== next.profileVersion || previous.animationTime !== next.animationTime) return true;
  if (previous.originX !== next.originX || previous.originY !== next.originY || previous.originZ !== next.originZ) return true;
  if (previous.windX !== next.windX || previous.windZ !== next.windZ) return true;
  if (previous.coverage !== next.coverage || previous.density !== next.density || previous.erosion !== next.erosion) return true;
  if (previous.radiance !== next.radiance || previous.sourceVersion !== next.sourceVersion) return true;
  return previous.atmosphere.length !== next.atmosphere.length
    || previous.atmosphere.some((v, i) => v !== next.atmosphere[i]);
}

export function environmentDirtyReason(previous: EnvironmentInput | null, next: EnvironmentInput, ageMs: number, renderSlackMs = 300): string | null {
  if (!previous) return 'initial';
  const regime = environmentRegime(next.lighting);
  const phaseDelta = Math.abs((((next.lighting.phase - previous.lighting.phase) + 0.5) % 1 + 1) % 1 - 0.5);
  if (Math.abs(next.lighting.absoluteHours - previous.lighting.absoluteHours) > 1) return 'clock-discontinuity';
  if (phaseDelta >= 0.1) return 'phase-discontinuity';
  const dx = next.originX - previous.originX;
  const dz = next.originZ - previous.originZ;
  if (Math.hypot(dx, next.originY - previous.originY, dz) >= 500) return 'origin-discontinuity';
  const threshold = regime === 'twilight' ? 0.25 : regime === 'night' ? 0.5 : 1;
  if (angleDegrees(previous.lighting.sunDir, next.lighting.sunDir) >= threshold) return 'sun-direction';
  // A moon below the visible dome contributes no disc or lunar radiance to either capture.
  // Let the meaningful-change age bound handle other evolving inputs in that case.
  if ((previous.lighting.moonVisible > 0 || next.lighting.moonVisible > 0)
    && angleDegrees(previous.lighting.moonDir, next.lighting.moonDir) >= 0.5) return 'moon-direction';
  if (previous.lighting.activeSource !== next.lighting.activeSource) return 'direct-source';
  if (phaseDelta >= 0.01) return 'lunar-phase';
  if (Math.hypot(dx, next.originY - previous.originY, dz) >= 60) return 'origin';
  const wx = next.windX - previous.windX;
  const wz = next.windZ - previous.windZ;
  if (Math.hypot(wx, wz) >= 60) return 'wind';
  if (Math.abs(next.coverage - previous.coverage) >= 0.02) return 'cloud-coverage';
  if (next.density !== previous.density) return 'cloud-density';
  if (next.erosion !== previous.erosion) return 'cloud-erosion';
  if (next.sourceVersion !== previous.sourceVersion) return 'source-version';
  if (next.profileName !== previous.profileName || next.profileVersion !== previous.profileVersion) return 'lighting-profile';
  if (next.atmosphere.some((value, i) => value !== previous.atmosphere[i])) return 'atmosphere';
  if (Math.abs(next.radiance - previous.radiance) >= Math.max(0.01, previous.radiance * 0.05)) return 'radiance';
  if (regime !== environmentRegime(previous.lighting)) return 'regime';
  if (hasMeaningfulChange(previous, next)
    && ageMs >= Math.max(0, environmentAgeLimitMs(next.lighting) - Math.max(0, renderSlackMs))) return 'age';
  return null;
}
