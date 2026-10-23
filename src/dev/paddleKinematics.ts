import * as THREE from 'three';
import type { PaddleGeometry } from './paddleVariants';
export const createPaddleFrame = () => ({ point: new THREE.Vector3(), tangent: new THREE.Vector3(),
  normal: new THREE.Vector3(), widthAxis: new THREE.Vector3(1,0,0), heightAxis: new THREE.Vector3() });
export type PaddleFrame = ReturnType<typeof createPaddleFrame>;
/** Derivative is metres per drive radian, used by both visuals and virtual-work shaft load. */
export function paddleFrame(g: PaddleGeometry, angle: number, blade: number, out: PaddleFrame) {
  const q = angle + blade * 2 * Math.PI / g.blades, c = Math.cos(q), s = Math.sin(q);
  out.point.set(g.x, g.y, g.z); out.heightAxis.set(0, 1, 0); out.widthAxis.set(1,0,0);
  if (g.mechanism === 'oars') {
    const yaw = g.radius*s, depression = .47-.26*c, dyaw = g.radius*c, ddep = .26*s;
    const cy=Math.cos(yaw), sy=Math.sin(yaw), cd=Math.cos(depression), sd=Math.sin(depression), L=g.outboard!;
    out.heightAxis.set(cd*cy,-sd,cd*sy);
    out.point.set(g.rowlockX!,g.y,g.z+(blade-(g.blades-1)/2)*8).addScaledVector(out.heightAxis,L);
    out.tangent.set(L*(-sd*ddep*cy-cd*sy*dyaw),-L*cd*ddep,L*(-sd*ddep*sy+cd*cy*dyaw));
    out.normal.set(-sy,0,cy).applyAxisAngle(out.heightAxis,Math.PI/2*Math.max(0,c)**2);
    out.widthAxis.crossVectors(out.heightAxis,out.normal).normalize();
  } else if (g.mechanism === 'sweeps') {
    out.point.y += 2.6 * c; out.point.z += (blade - (g.blades - 1) / 2) * 8 + g.radius * s;
    out.tangent.set(0, -2.6 * s, g.radius * c); out.normal.set(0, 0, 1);
  } else if (g.mechanism === 'chain') {
    const half = g.trackHalfLength ?? 5, straight = 2 * half, arc = Math.PI * g.radius;
    const length = 2 * straight + 2 * arc, k = length / (2 * Math.PI);
    let d = ((q * k) % length + length) % length;
    if (d < straight) {
      out.point.y -= g.radius; out.point.z += half - d; out.tangent.set(0, 0, -k); out.normal.set(0, 0, -1);
    } else if ((d -= straight) < arc) {
      const t = d / g.radius;
      out.point.y -= g.radius * Math.cos(t); out.point.z -= half + g.radius * Math.sin(t);
      out.tangent.set(0, k * Math.sin(t), -k * Math.cos(t)); out.normal.copy(out.tangent).normalize();
      out.heightAxis.set(0, Math.cos(t), Math.sin(t));
    } else if ((d -= arc) < straight) {
      out.point.y += g.radius; out.point.z += -half + d; out.tangent.set(0, 0, k); out.normal.set(0, 0, 1);
    } else {
      d -= straight; const t = d / g.radius;
      out.point.y += g.radius * Math.cos(t); out.point.z += half + g.radius * Math.sin(t);
      out.tangent.set(0, -k * Math.sin(t), k * Math.cos(t)); out.normal.copy(out.tangent).normalize();
      out.heightAxis.set(0, Math.cos(t), Math.sin(t));
    }
  } else {
    out.point.y += g.radius * c; out.point.z += g.radius * s;
    out.tangent.set(0, -g.radius * s, g.radius * c); out.normal.set(0, -s, c); out.heightAxis.set(0, c, s);
  }
  return out;
}
