import * as THREE from 'three';
import type { OarSlot } from './oarLayout';

/** Pivot-relative radial profile of the loom (m): grip, swell at the thole, taper toward the blade. */
function loomRadius(slot: Readonly<OarSlot>, x: number) {
  const root = slot.bladeRadius - slot.bladeLength / 2;
  const grip = -slot.inboard;
  if (x < grip + 0.04) return 0.027; // knob at the hand end
  if (x < grip + 0.34) return 0.023; // hand grip
  if (x < 0) return 0.023 + 0.019 * THREE.MathUtils.smoothstep(x, grip + 0.34, -0.1);
  if (x < root) return 0.042 - 0.016 * Math.pow(x / root, 0.8);
  // the loom runs on into the blade as a rib and dies out short of the tip
  const u = (x - root) / slot.bladeLength;
  return Math.max(0, 0.026 * (1 - u / 0.82));
}

const LEATHER: [number, number, number] = [0.42, 0.25, 0.15];
const GRIP: [number, number, number] = [0.72, 0.6, 0.48];

/**
 * The same material coordinates used by evaluateOar and blade clipping: x runs along the loom from
 * the thole pin, y across the blade (width axis), z through it (blade normal). The blade occupies
 * exactly [bladeRadius - bladeLength/2, bladeRadius + bladeLength/2] x [-bladeWidth/2, bladeWidth/2].
 *
 * Extra attribute `bend`: lateral deflection weight per vertex for the load-bending shader. It is
 * zero at the thole and over the whole blade, so the drawn blade stays where the physics has it.
 */
export function buildOarGeometry(slot: Readonly<OarSlot>): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], bend: number[] = [], idx: number[] = [];
  const root = slot.bladeRadius - slot.bladeLength / 2;
  const tip = slot.bladeRadius + slot.bladeLength / 2;
  // cantilever bow relative to the thole-blade chord, normalised to a peak of 1
  const bendAt = (x: number) => {
    if (x <= 0 || x >= root) return 0;
    const t = x / root;
    return (t - (t * t * (3 - t)) / 2) / 0.1925;
  };

  // ---------- loom: lathe along x with analytic normals ----------
  const RADIAL = 10;
  const rings: number[] = [];
  const grip = -slot.inboard;
  for (const x of [grip, grip + 0.012, grip + 0.04, grip + 0.05, grip + 0.34, grip + 0.42]) rings.push(x);
  for (let i = 1; i <= 5; i++) rings.push(grip + 0.42 + ((-0.16 - grip - 0.42) * i) / 5);
  // leather sleeve (askoma) where the loom bears on the thole
  rings.push(-0.15, -0.148, 0.24, 0.242);
  for (let i = 1; i <= 10; i++) rings.push(0.242 + ((root - 0.242) * i) / 10);
  for (let i = 1; i <= 6; i++) rings.push(root + (slot.bladeLength * 0.82 * i) / 6);
  rings.sort((a, b) => a - b);
  const sleeve = (x: number) => x > -0.149 && x < 0.241;
  const radius = (x: number) => loomRadius(slot, x) + (sleeve(x) ? 0.005 : 0);
  for (let i = 0; i < rings.length; i++) {
    const x = rings[i];
    const r = radius(x);
    const h = 0.004;
    const drdx = (radius(Math.min(x + h, rings[rings.length - 1])) - radius(Math.max(x - h, rings[0]))) / (2 * h);
    const c = sleeve(x) ? LEATHER : x < grip + 0.34 ? GRIP : ([1, 1, 1] as [number, number, number]);
    for (let j = 0; j <= RADIAL; j++) {
      const a = (j / RADIAL) * Math.PI * 2;
      const cy = Math.cos(a), cz = Math.sin(a);
      // flatten the rib inside the blade so it reads as a carved spine, not a pipe through it
      const flat = x > root ? 0.55 : 1;
      pos.push(x, cy * r, cz * r * flat);
      const n = new THREE.Vector3(-drdx, cy, cz / flat).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(x / 1.7, j / RADIAL * 0.35);
      col.push(...c);
      bend.push(bendAt(x));
    }
  }
  for (let i = 0; i < rings.length - 1; i++)
    for (let j = 0; j < RADIAL; j++) {
      const a = i * (RADIAL + 1) + j, b = a + 1, c = a + RADIAL + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  // end cap at the handle
  {
    const centre = pos.length / 3;
    pos.push(grip, 0, 0); nor.push(-1, 0, 0); uv.push(0, 0); col.push(...GRIP); bend.push(0);
    for (let j = 0; j < RADIAL; j++) idx.push(centre, j + 1, j);
  }

  // ---------- blade: a lens-section spoon with a rounded tip ----------
  const bladeStart = pos.length / 3;
  const NL = 16, NW = 8;
  const W = slot.bladeWidth / 2, T = slot.bladeThickness / 2;
  const halfWidth = (u: number) => {
    const neck = 0.52 + 0.48 * THREE.MathUtils.smoothstep(u, 0, 0.32);
    const end = u > 0.72 ? Math.sqrt(Math.max(0, 1 - ((u - 0.72) / 0.28) ** 2)) : 1;
    return W * neck * end;
  };
  for (const face of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= NL; i++) {
      const u = i / NL;
      const x = root + u * slot.bladeLength;
      const hw = halfWidth(u);
      const dhw = (halfWidth(Math.min(1, u + 0.01)) - halfWidth(Math.max(0, u - 0.01))) / (0.02 * slot.bladeLength);
      for (let k = 0; k <= NW; k++) {
        const v = (k / NW) * 2 - 1;
        const y = v * hw;
        // lens section: full thickness on the centreline, a thin edge, thinning toward the tip
        const taper = 1 - 0.45 * u;
        const z = face * T * taper * (0.18 + 0.82 * (1 - v * v));
        pos.push(x, y, z);
        // surface normal of z = f(x, y)
        const dzdv = face * T * taper * 0.82 * -2 * v;
        const dzdy = hw > 1e-5 ? dzdv / hw : 0;
        const dzdx = face * -0.45 * T / slot.bladeLength * (0.18 + 0.82 * (1 - v * v)) - dzdy * v * dhw;
        const n = new THREE.Vector3(-dzdx, -dzdy, 1).multiplyScalar(face).normalize();
        if (face < 0) n.z = -Math.abs(n.z);
        nor.push(n.x, n.y, n.z);
        uv.push(x / 1.7, 0.5 + y * 1.6);
        col.push(0.94, 0.92, 0.9);
        bend.push(0);
      }
    }
    for (let i = 0; i < NL; i++)
      for (let k = 0; k < NW; k++) {
        const a = base + i * (NW + 1) + k, b = a + 1, c = a + NW + 1, d = c + 1;
        if (face > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
  }
  // stitch the thin edges of the two faces
  {
    const top = bladeStart, bot = bladeStart + (NL + 1) * (NW + 1);
    const edge = (face: number, i: number, k: number) => (face > 0 ? top : bot) + i * (NW + 1) + k;
    for (const k of [0, NW]) {
      const side = k === 0 ? -1 : 1;
      const base = pos.length / 3;
      for (let i = 0; i <= NL; i++)
        for (const face of [1, -1]) {
          const s = edge(face, i, k) * 3;
          pos.push(pos[s], pos[s + 1], pos[s + 2]);
          nor.push(0, side, 0);
          uv.push(uv[(s / 3) * 2], uv[(s / 3) * 2 + 1]);
          col.push(0.94, 0.92, 0.9);
          bend.push(0);
        }
      for (let i = 0; i < NL; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        if (side > 0) idx.push(a, c, b, b, c, d);
        else idx.push(a, b, c, b, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('bend', new THREE.Float32BufferAttribute(bend, 1));
  g.setIndex(idx);
  g.userData.blade = { start: bladeStart, count: pos.length / 3 - bladeStart, root, tip };
  return g;
}
