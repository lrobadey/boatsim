import * as THREE from 'three';

const RHO_WATER = 1025;
const PI = Math.PI;

/**
 * Coupled lateral lift, induced drag, and existing crossflow resistance for one submerged hull
 * strip. Inputs are local hull-frame velocity relative to water in m/s and wetted lateral area m².
 * Output is the total local horizontal force (x starboard, z aft), in newtons.
 */
export function hullLateralForce(vx: number, vz: number, area: number, out: THREE.Vector3): THREE.Vector3 {
  const speed = Math.hypot(vx, vz);
  let fx = -0.5 * RHO_WATER * 1.1 * area * vx * Math.abs(vx) - 400 * area * vx;
  let fz = 0;

  if (speed > 1e-12 && area > 0) {
    const beta = Math.atan2(vx, Math.abs(vz));
    const cl = 0.8 * Math.sin(2 * beta);
    const qArea = 0.5 * RHO_WATER * area * speed * speed;
    const liftMagnitude = qArea * cl;
    const liftX = -Math.abs(vz) / speed;
    const liftZ = (vz === 0 ? 0 : Math.sign(vz)) * vx / speed;
    fx += liftMagnitude * liftX;
    fz += liftMagnitude * liftZ;

    const cdInduced = (cl * cl) / (PI * 0.18 * 0.7);
    const dragMagnitude = qArea * cdInduced;
    fx -= dragMagnitude * vx / speed;
    fz -= dragMagnitude * vz / speed;
  }

  return out.set(fx, 0, fz);
}
