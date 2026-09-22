import { createNoise4D } from 'simplex-noise';

/** Pure texture synthesis (runs in a worker): no three.js dependency. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable RGBA noise: each channel a different frequency of periodic simplex (torus-mapped 4D noise). */
export function noiseData(size = 256, seed = 3): Uint8Array {
  const n4 = createNoise4D(rng(seed));
  const data = new Uint8Array(size * size * 4);
  const freqs = [2, 4, 8, 16];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const a = (x / size) * Math.PI * 2;
      const b = (y / size) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      for (let c = 0; c < 4; c++) {
        let v = 0, amp = 0.5, R = freqs[c] * 0.16, norm = 0;
        for (let o = 0; o < 3; o++) {
          v += amp * n4(ca * R + c * 11, sa * R, cb * R, sb * R + c * 7);
          norm += amp;
          amp *= 0.5;
          R *= 2;
        }
        data[(y * size + x) * 4 + c] = Math.max(0, Math.min(255, ((v / norm) * 0.5 + 0.5) * 255));
      }
    }
  return data;
}

/**
 * Tileable capillary/ripple normal map: sum of many small directional sine waves with integer wave
 * vectors (so it tiles perfectly). RG = slope, B = height.
 */
export function rippleData(size = 512, seed = 9): Uint8Array {
  const r = rng(seed);
  const waves: { kx: number; ky: number; a: number; p: number }[] = [];
  for (let i = 0; i < 90; i++) {
    const k = 3 + Math.floor(Math.pow(r(), 1.6) * 40);
    const ang = (r() - 0.5) * Math.PI * 1.3 + (r() < 0.2 ? Math.PI : 0);
    const kx = Math.round(Math.cos(ang) * k), ky = Math.round(Math.sin(ang) * k);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, a: 1 / Math.pow(Math.hypot(kx, ky), 1.3), p: r() * Math.PI * 2 });
  }
  const n = size * size;
  const h = new Float32Array(n), sx = new Float32Array(n), sy = new Float32Array(n);
  // separable evaluation: sin(kx*u + ky*v + p) = sin(kx*u)cos(ky*v+p) + cos(kx*u)sin(ky*v+p)
  const su = new Float32Array(size), cu = new Float32Array(size);
  const sv = new Float32Array(size), cv = new Float32Array(size);
  for (const w of waves) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * Math.PI * 2;
      su[i] = Math.sin(w.kx * u); cu[i] = Math.cos(w.kx * u);
      sv[i] = Math.sin(w.ky * u + w.p); cv[i] = Math.cos(w.ky * u + w.p);
    }
    for (let y = 0; y < size; y++) {
      const svy = sv[y], cvy = cv[y];
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const s = su[x] * cvy + cu[x] * svy;
        const c = (cu[x] * cvy - su[x] * svy) * w.a;
        h[row + x] += w.a * s;
        sx[row + x] += c * w.kx;
        sy[row + x] += c * w.ky;
      }
    }
  }
  let maxS = 0, maxH = 0;
  for (let i = 0; i < n; i++) {
    maxS = Math.max(maxS, Math.abs(sx[i]), Math.abs(sy[i]));
    maxH = Math.max(maxH, Math.abs(h[i]));
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = ((sx[i] / maxS) * 0.5 + 0.5) * 255;
    data[i * 4 + 1] = ((sy[i] / maxS) * 0.5 + 0.5) * 255;
    data[i * 4 + 2] = ((h[i] / maxH) * 0.5 + 0.5) * 255;
    data[i * 4 + 3] = 255;
  }
  return data;
}
