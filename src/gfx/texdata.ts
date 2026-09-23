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

// ---------- 3D cloud noise (tileable) ----------

/** tileable Worley F1 (inverted: 1 at feature points) with `cells` cells per side over an N^3 tile */
function worley3(N: number, cells: number, seed: number): Float32Array {
  const r = rng(seed);
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = r();
  const out = new Float32Array(N * N * N);
  const cs = N / cells;
  let o = 0;
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const fx = (x + 0.5) / cs, fy = (y + 0.5) / cs, fz = (z + 0.5) / cs;
        const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const cx = ix + dx, cy = iy + dy, cz = iz + dz;
              const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells, wz = ((cz % cells) + cells) % cells;
              const p = ((wz * cells + wy) * cells + wx) * 3;
              const ddx = cx + pts[p] - fx, ddy = cy + pts[p + 1] - fy, ddz = cz + pts[p + 2] - fz;
              const d = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d < best) best = d;
            }
        out[o++] = 1 - Math.min(1, Math.sqrt(best));
      }
  return out;
}

/** tileable 3D gradient (Perlin) noise fbm, period = N voxels, base frequency `freq` */
function perlin3(N: number, freq: number, octaves: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(N * N * N);
  let amp = 1, norm = 0;
  for (let oc = 0; oc < octaves; oc++) {
    const P = freq << oc;
    const g = new Float32Array(P * P * P * 3);
    for (let i = 0; i < P * P * P; i++) {
      const th = r() * Math.PI * 2, u = r() * 2 - 1, s = Math.sqrt(1 - u * u);
      g[i * 3] = s * Math.cos(th); g[i * 3 + 1] = s * Math.sin(th); g[i * 3 + 2] = u;
    }
    const grad = (ix: number, iy: number, iz: number, x: number, y: number, z: number) => {
      const p = ((((iz % P) + P) % P) * P * P + (((iy % P) + P) % P) * P + (((ix % P) + P) % P)) * 3;
      return g[p] * x + g[p + 1] * y + g[p + 2] * z;
    };
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    let o = 0;
    for (let z = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const fx = ((x + 0.5) / N) * P, fy = ((y + 0.5) / N) * P, fz = ((z + 0.5) / N) * P;
          const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
          const tx = fx - ix, ty = fy - iy, tz = fz - iz;
          const u = fade(tx), v = fade(ty), w = fade(tz);
          const l = (a: number, b: number, t: number) => a + (b - a) * t;
          const n = l(
            l(l(grad(ix, iy, iz, tx, ty, tz), grad(ix + 1, iy, iz, tx - 1, ty, tz), u), l(grad(ix, iy + 1, iz, tx, ty - 1, tz), grad(ix + 1, iy + 1, iz, tx - 1, ty - 1, tz), u), v),
            l(l(grad(ix, iy, iz + 1, tx, ty, tz - 1), grad(ix + 1, iy, iz + 1, tx - 1, ty, tz - 1), u), l(grad(ix, iy + 1, iz + 1, tx, ty - 1, tz - 1), grad(ix + 1, iy + 1, iz + 1, tx - 1, ty - 1, tz - 1), u), v),
            w,
          );
          out[o++] += n * amp;
        }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] / norm * 0.9 + 0.5;
  return out;
}

const remap = (v: number, a: number, b: number, c: number, d: number) => c + ((v - a) / (b - a)) * (d - c);

/**
 * Cloud noise (Schneider, "Nubis", 2015): a 128^3 Perlin-Worley shape texture (billowy cells) and a
 * 32^3 Worley detail texture that erodes the edges into wisps. Both tile seamlessly.
 */
export function cloudNoiseData(seed = 5): { shape: Uint8Array; detail: Uint8Array } {
  const N = 128;
  const per = perlin3(N, 4, 4, seed);
  const w1 = worley3(N, 6, seed + 1), w2 = worley3(N, 12, seed + 2), w3 = worley3(N, 24, seed + 3);
  const shape = new Uint8Array(N * N * N);
  for (let i = 0; i < shape.length; i++) {
    const wf = w1[i] * 0.625 + w2[i] * 0.25 + w3[i] * 0.125;
    const pw = remap(per[i], wf - 1, 1, 0, 1); // Perlin-Worley: perlin dilated by worley cells
    const v = remap(pw, (w2[i] * 0.625 + w3[i] * 0.375) * 0.45 - 0.05, 1, 0, 1);
    shape[i] = Math.max(0, Math.min(255, v * 255));
  }
  const M = 32;
  const d1 = worley3(M, 3, seed + 7), d2 = worley3(M, 6, seed + 8), d3 = worley3(M, 12, seed + 9);
  const detail = new Uint8Array(M * M * M);
  for (let i = 0; i < detail.length; i++) detail[i] = Math.max(0, Math.min(255, (d1[i] * 0.625 + d2[i] * 0.25 + d3[i] * 0.125) * 255));
  return { shape, detail };
}
