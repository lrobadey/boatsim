import * as THREE from 'three';

const RHO_WATER = 1025;
const PI = Math.PI;
/** pi AR e of the hull as a low-aspect-ratio lifting surface: induced drag coefficient cl² / this */
const INDUCED = PI * 0.18 * 0.7;

/** quadratic plus linear crossflow resistance of one strip (local x, starboard), N */
const crossflow = (vx: number, area: number) => -0.5 * RHO_WATER * 1.1 * area * vx * Math.abs(vx) - 400 * area * vx;
/** quasi-steady lift coefficient at the strip's drift angle */
const liftCoefficient = (vx: number, vz: number) => 0.8 * Math.sin(2 * Math.atan2(vx, Math.abs(vz)));

/**
 * Lift of one strip at coefficient cl and induced drag at coefficient cdi, added to out (local x, z).
 * Lift is normal to the strip's relative velocity, induced drag along it.
 */
function addLiftAndInduced(vx: number, vz: number, area: number, cl: number, cdi: number, out: THREE.Vector3) {
  const speed = Math.hypot(vx, vz);
  if (speed <= 1e-12 || area <= 0) return;
  const qArea = 0.5 * RHO_WATER * area * speed * speed;
  out.x += qArea * cl * (-Math.abs(vz) / speed);
  out.z += qArea * cl * ((vz === 0 ? 0 : Math.sign(vz)) * vx / speed);
  out.x -= qArea * cdi * vx / speed;
  out.z -= qArea * cdi * vz / speed;
}

/**
 * Coupled lateral lift, induced drag, and existing crossflow resistance for one submerged hull
 * strip in steady uniform flow. Inputs are local hull-frame velocity relative to water in m/s and wetted
 * lateral area m². Output is the total local horizontal force (x starboard, z aft), in newtons.
 * The ship uses HullLift, which equals the sum of this over its strips when they all see the same flow.
 */
export function hullLateralForce(vx: number, vz: number, area: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(crossflow(vx, area), 0, 0);
  if (Math.hypot(vx, vz) > 1e-12 && area > 0) {
    const cl = liftCoefficient(vx, vz);
    addLiftAndInduced(vx, vz, area, cl, (cl * cl) / INDUCED, out);
  }
  return out;
}

/**
 * Lateral forces on the whole hull, strip by strip. Crossflow and lift are local, but induced drag
 * comes from the hull's total lift coefficient: the strips lie along one lifting surface (the hull's
 * chord), so lift that cancels along the length, as in waves shorter than the hull or the bow and stern
 * in a turn, carries no induced drag. Summing each strip's own cl² instead charges induced drag for
 * every wave-frequency crossflow and was most of the merchant's speed loss in beam and following seas.
 *   reset() each step, add() each wet strip, then solve() and read fx/fz (local, N) per strip index.
 */
export class HullLift {
  readonly fx: Float64Array;
  readonly fz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vz: Float64Array;
  private readonly area: Float64Array;
  private readonly wet: Uint8Array;
  constructor(readonly count: number) {
    this.fx = new Float64Array(count);
    this.fz = new Float64Array(count);
    this.vx = new Float64Array(count);
    this.vz = new Float64Array(count);
    this.area = new Float64Array(count);
    this.wet = new Uint8Array(count);
  }
  reset() {
    this.wet.fill(0);
  }
  /** strip i's relative velocity (local, m/s) and lateral area (m²) this step */
  add(i: number, vx: number, vz: number, area: number) {
    this.vx[i] = vx; this.vz[i] = vz; this.area[i] = area; this.wet[i] = 1;
  }
  solve() {
    const n = this.count;
    let qa = 0, qaCl = 0;
    for (let i = 0; i < n; i++) {
      if (!this.wet[i]) continue;
      const vx = this.vx[i], vz = this.vz[i], speed2 = vx * vx + vz * vz;
      if (speed2 <= 1e-24 || this.area[i] <= 0) continue;
      const q = this.area[i] * speed2;
      qa += q; qaCl += q * liftCoefficient(vx, vz);
    }
    // the hull's lift coefficient: dynamic-pressure weighted over the strips
    const CL = qa > 0 ? qaCl / qa : 0, cdi = (CL * CL) / INDUCED;
    const p = _f;
    for (let i = 0; i < n; i++) {
      if (!this.wet[i]) { this.fx[i] = 0; this.fz[i] = 0; continue; }
      const vx = this.vx[i], vz = this.vz[i], area = this.area[i];
      p.set(crossflow(vx, area), 0, 0);
      addLiftAndInduced(vx, vz, area, liftCoefficient(vx, vz), cdi, p);
      this.fx[i] = p.x; this.fz[i] = p.z;
    }
  }
}
const _f = new THREE.Vector3();
