import type { ResistanceModel } from './design';

const G = 9.81;
/** kinematic viscosity of sea water at about 18 °C (m²/s) */
const NU = 1.19e-6;

/**
 * Longitudinal drag coefficient of a hull column moving at local velocity vz through the water
 * (z aft, so vz < 0 is ahead). Fr and Re use the hull length.
 */
export function dragCoefficient(m: ResistanceModel, vz: number, length: number): number {
  const Fr = Math.abs(vz) / Math.sqrt(G * length);
  const Cw = m.cw0 * Math.pow(Fr / 0.33, m.cwExp);
  const astern = vz > 0 ? m.astern : 1;
  if (m.kind === 'constant') return m.cf * astern + Cw;
  const Re = Math.max(1e5, (Math.abs(vz) * length) / NU);
  const l = Math.log10(Re) - 2;
  return m.formFactor * (0.075 / (l * l)) * astern + Cw;
}
