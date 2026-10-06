import * as THREE from 'three';
import { patchMaterial, shared } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import type { WorldGenResult } from './worldgenTypes';
import type { SurfaceMaps } from '../gfx/assets';

const CHUNK = 64; // cells per chunk side

/**
 * Terrain: chunked LOD meshes built from the generated heightmap, a procedural material
 * (sand / limestone / dry grass / maquis / seagrass, caustics under water), and CPU height queries.
 */
export class Terrain {
  readonly group = new THREE.Group();
  readonly heights: Float32Array;
  readonly N: number;
  readonly S: number;
  readonly cell: number;
  readonly half: number;
  readonly heightTexture: THREE.DataTexture;
  readonly material: THREE.MeshStandardMaterial;

  constructor(gen: WorldGenResult, noiseTex: THREE.Texture, lodCount: number, sand: SurfaceMaps) {
    this.heights = gen.heights;
    this.N = gen.size;
    this.S = gen.worldSize;
    this.cell = this.S / this.N;
    this.half = this.S / 2;

    // half-float height texture for other shaders (water depth, foam, chart)
    const hf = new Uint16Array(this.N * this.N);
    for (let i = 0; i < hf.length; i++) hf[i] = THREE.DataUtils.toHalfFloat(this.heights[i]);
    this.heightTexture = new THREE.DataTexture(hf, this.N, this.N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;
    this.heightTexture.wrapS = this.heightTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.heightTexture.needsUpdate = true;

    this.material = this.makeMaterial(noiseTex, sand);
    this.buildChunks(lodCount);
  }

  heightAt(x: number, z: number): number {
    const N = this.N;
    const fx = (x + this.half) / this.cell - 0.5;
    const fz = (z + this.half) / this.cell - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return -60;
    const i = Math.floor(fx),
      j = Math.floor(fz);
    const tx = fx - i,
      tz = fz - j;
    const H = this.heights;
    const k = j * N + i;
    const a = H[k],
      b = H[k + 1],
      c = H[k + N],
      d = H[k + N + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  normalAt(x: number, z: number, out: THREE.Vector3) {
    const e = this.cell;
    const gx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const gz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return out.set(-gx, 1, -gz).normalize();
  }

  private h(i: number, j: number) {
    const N = this.N;
    i = Math.max(0, Math.min(N - 1, i));
    j = Math.max(0, Math.min(N - 1, j));
    return this.heights[j * N + i];
  }

  private buildChunks(lodCount: number) {
    const N = this.N;
    const chunks = N / CHUNK;
    const steps = [1, 2, 4, 8, 16].slice(0, lodCount);
    const dists = [0, 650, 1500, 3200, 6000];
    for (let cj = 0; cj < chunks; cj++)
      for (let ci = 0; ci < chunks; ci++) {
        let maxH = -1e9;
        for (let j = cj * CHUNK; j <= Math.min(N - 1, (cj + 1) * CHUNK); j += 2)
          for (let i = ci * CHUNK; i <= Math.min(N - 1, (ci + 1) * CHUNK); i += 2) maxH = Math.max(maxH, this.heights[j * N + i]);
        // Deep seabed contributes nothing visible through the water (absorbed); skip it.
        if (maxH < -32) continue;
        const lod = new THREE.LOD();
        const cx = -this.half + (ci * CHUNK + CHUNK / 2 + 0.5) * this.cell;
        const cz = -this.half + (cj * CHUNK + CHUNK / 2 + 0.5) * this.cell;
        lod.position.set(cx, 0, cz);
        const landChunk = maxH > 0;
        steps.forEach((s, li) => {
          // underwater-only chunks don't need the finest LOD
          const step = !landChunk && s === 1 ? 2 : s;
          const geo = this.chunkGeometry(ci * CHUNK, cj * CHUNK, step, cx, cz);
          const mesh = new THREE.Mesh(geo, this.material);
          mesh.receiveShadow = true;
          mesh.castShadow = landChunk && li < 2;
          mesh.layers.enable(LAYER_REFRACT);
          mesh.matrixAutoUpdate = false;
          mesh.updateMatrix();
          lod.addLevel(mesh, dists[li], 60);
        });
        lod.matrixAutoUpdate = false;
        lod.updateMatrix();
        this.group.add(lod);
      }
  }

  private chunkGeometry(i0: number, j0: number, step: number, cx: number, cz: number) {
    const n = CHUNK / step + 1;
    const cell = this.cell;
    const vcount = n * n + 4 * n; // + skirt
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const idx: number[] = [];
    let v = 0;
    const put = (i: number, j: number, drop: number) => {
      const x = -this.half + (i + 0.5) * cell - cx;
      const z = -this.half + (j + 0.5) * cell - cz;
      const y = this.h(i, j) - drop;
      // normal from central differences at this LOD's spacing
      const s = Math.max(1, step);
      const gx = (this.h(i + s, j) - this.h(i - s, j)) / (2 * s * cell);
      const gz = (this.h(i, j + s) - this.h(i, j - s)) / (2 * s * cell);
      const l = Math.hypot(gx, 1, gz);
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = z;
      nor[v * 3] = -gx / l;
      nor[v * 3 + 1] = 1 / l;
      nor[v * 3 + 2] = -gz / l;
      return v++;
    };
    const grid: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid.push(put(i0 + i * step, j0 + j * step, 0));
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = grid[j * n + i],
          b = grid[j * n + i + 1],
          c = grid[(j + 1) * n + i],
          d = grid[(j + 1) * n + i + 1];
        // alternate the diagonal for a less directional look
        if ((i + j) & 1) idx.push(a, c, b, b, c, d);
        else idx.push(a, c, d, a, d, b);
      }
    // skirts hide LOD cracks
    const drop = 6 * step;
    const edge = (list: number[], flip: boolean) => {
      const sk = list.map((gi) => {
        const vi = gi;
        const x = pos[vi * 3],
          y = pos[vi * 3 + 1],
          z = pos[vi * 3 + 2];
        pos[v * 3] = x;
        pos[v * 3 + 1] = y - drop;
        pos[v * 3 + 2] = z;
        nor.copyWithin(v * 3, vi * 3, vi * 3 + 3);
        return v++;
      });
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k],
          b = list[k + 1],
          c = sk[k],
          d = sk[k + 1];
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    };
    const top: number[] = [],
      bottom: number[] = [],
      left: number[] = [],
      right: number[] = [];
    for (let i = 0; i < n; i++) {
      top.push(grid[i]);
      bottom.push(grid[(n - 1) * n + i]);
      left.push(grid[i * n]);
      right.push(grid[i * n + n - 1]);
    }
    edge(top, true);
    edge(bottom, false);
    edge(left, false);
    edge(right, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, v * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, v * 3), 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.boundingSphere!.radius += 30;
    return g;
  }

  private makeMaterial(noiseTex: THREE.Texture, sand: SurfaceMaps) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    mat.side = THREE.DoubleSide; // skirts
    const uniforms = {
      uNoise: { value: noiseTex },
      uSandColor: { value: sand.color },
      uSandNormal: { value: sand.normal },
      uSandRough: { value: sand.roughness },
    };
    patchMaterial(
      mat,
      (sh) => {
        Object.assign(sh.uniforms, uniforms);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;')
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
             vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
             vTNormal = normalize(mat3(modelMatrix) * objectNormal);`,
          );
        sh.fragmentShader = sh.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            varying vec3 vTWorld;
            varying vec3 vTNormal;
            uniform sampler2D uNoise;
            uniform sampler2D uSandColor;
            uniform sampler2D uSandNormal;
            uniform sampler2D uSandRough;
            uniform float uTime;
            uniform float uNight;
            vec3 srgb(vec3 c){ return pow(c, vec3(2.2)); }
            float nz(vec2 p, int ch){ vec4 t = texture2D(uNoise, p); return ch==0?t.r:ch==1?t.g:ch==2?t.b:t.a; }
            float fbm3(vec2 p){ vec4 a = texture2D(uNoise, p); vec4 b = texture2D(uNoise, p*4.13+0.37); return a.r*0.5 + a.g*0.25 + b.b*0.15 + b.a*0.1; }
            float causticsAt(vec2 p, float t){
              vec2 q1 = p * 0.11 + vec2(t * 0.021, t * 0.013);
              vec2 q2 = p * 0.13 - vec2(t * 0.017, -t * 0.019);
              float a = texture2D(uNoise, q1).b;
              float b = texture2D(uNoise, q2 + a * 0.05).b;
              float c = 1.0 - abs(a - b) * 5.0;
              return pow(clamp(c, 0.0, 1.0), 6.0);
            }
            vec3 gTerrainAlbedo; float gTerrainRough; float gWet;
            vec3 gSandNormal; float gSandWeight;
            // triplanar rock relief (no stretching on cliffs): blocky limestone + fine grain
            vec3 triW(vec3 n) { vec3 a = pow(abs(n), vec3(4.0)); return a / (a.x + a.y + a.z); }
            float rockH(vec3 wp, vec3 w) {
              float x = texture2D(uNoise, wp.zy * 0.031).a * 0.55 + texture2D(uNoise, wp.zy * 0.13 + 0.3).b * 0.3 + texture2D(uNoise, wp.zy * 0.5).g * 0.15;
              float y = texture2D(uNoise, wp.xz * 0.031).a * 0.55 + texture2D(uNoise, wp.xz * 0.13 + 0.3).b * 0.3 + texture2D(uNoise, wp.xz * 0.5).g * 0.15;
              float z = texture2D(uNoise, wp.xy * 0.031).a * 0.55 + texture2D(uNoise, wp.xy * 0.13 + 0.3).b * 0.3 + texture2D(uNoise, wp.xy * 0.5).g * 0.15;
              float hgt = x * w.x + y * w.y + z * w.z;
              // horizontal bedding planes of the limestone
              float bed = smoothstep(0.38, 0.5, abs(fract(wp.y * 0.13 + hgt * 1.4 + y * 0.8) - 0.5)) * 0.1;
              return hgt - bed * (1.0 - w.y);
            }
            void terrainSurface(vec3 wp, vec3 n) {
              float h = wp.y;
              float slope = 1.0 - clamp(n.y, 0.0, 1.0); // 0 flat .. 1 vertical
              vec2 p = wp.xz;
              float n1 = fbm3(p * 0.0021);
              float n2 = fbm3(p * 0.013);
              float n3 = texture2D(uNoise, p * 0.09).a;
              // palette (sRGB authored): Cycladic summer
              vec3 sandWet = srgb(vec3(0.52, 0.45, 0.34));
              vec3 sandDry = srgb(vec3(0.8, 0.72, 0.57));
              vec3 sandSea = srgb(vec3(0.82, 0.76, 0.6));
              vec3 grass = mix(srgb(vec3(0.78, 0.66, 0.42)), srgb(vec3(0.66, 0.52, 0.32)), n2);
              vec3 soil = srgb(vec3(0.58, 0.40, 0.27));
              vec3 maquis = mix(srgb(vec3(0.30, 0.33, 0.21)), srgb(vec3(0.40, 0.40, 0.28)), n3);
              vec3 rockA = srgb(vec3(0.66, 0.62, 0.55));
              vec3 rockB = srgb(vec3(0.44, 0.40, 0.35));
              vec3 seagrass = srgb(vec3(0.10, 0.19, 0.12));
              // limestone: subtle strata plus weathering streaks down the face
              vec3 tw = triW(n);
              float rh = rockH(wp, tw);
              float strata = 0.5 + 0.5 * sin(h * 0.45 + rh * 4.0 + n1 * 6.0);
              // dark water/lichen streaks running down the faces, warm iron staining
              float streak = texture2D(uNoise, vec2((p.x + p.y) * 0.035, h * 0.0035)).g;
              vec3 rock = mix(rockB * 0.62, rockA, smoothstep(0.28, 0.72, rh));
              rock *= 0.82 + 0.28 * strata;
              rock = mix(rock, rock * vec3(0.72, 0.7, 0.66), smoothstep(0.55, 0.8, streak) * (1.0 - tw.y));
              rock = mix(rock, rock * vec3(1.08, 0.92, 0.78), smoothstep(0.6, 0.85, n2) * 0.6);
              // land cover: dry golden grass with red soil patches, maquis in moist hollows, rock by slope/altitude
              // maquis clings to moist hollows and north-facing slopes; the rest is sun-bleached grass
              float northFacing = clamp(-n.z * 2.0, 0.0, 1.0) * slope * 2.0;
              float moist = smoothstep(0.5, 0.78, n1 + 0.25 * n2 + 0.15 * northFacing);
              vec3 dry = mix(grass, soil, smoothstep(0.55, 0.75, n3 + (n2 - 0.5) * 0.4) * 0.6);
              // scattered garrigue: dark shrub speckle over the grass
              float speck = smoothstep(0.62, 0.7, texture2D(uNoise, p * 0.21).r + n3 * 0.2);
              dry = mix(dry, maquis * 0.8, speck * 0.55);
              vec3 land = mix(dry, maquis, moist * (1.0 - smoothstep(250.0, 380.0, h)));
              float rockW = smoothstep(0.32, 0.52, slope + (n2 - 0.5) * 0.25) + smoothstep(320.0, 440.0, h + n2 * 60.0);
              // limestone outcrops breaking through the thin soil everywhere
              rockW += smoothstep(0.66, 0.78, n2 * 0.55 + n3 * 0.45 + slope * 0.4) * 0.85;
              land = mix(land, rock, clamp(rockW, 0.0, 1.0));
              // beach band
              float beachTop = 2.8 + n2 * 2.5;
              float beach = (1.0 - smoothstep(beachTop - 0.8, beachTop, h)) * (1.0 - smoothstep(0.18, 0.4, slope));
              vec3 sandColor = sandDry;
              float sandRough = 0.95;
              gSandNormal = vec3(0.0, 0.0, 1.0);
              gSandWeight = 0.0;
              if (beach > 0.001 && h > -0.4) {
                vec2 sandUv = p / 15.0; // source scan covers a 15 m square
                sandColor = mix(sandDry, texture2D(uSandColor, sandUv).rgb, 0.7);
                sandRough = texture2D(uSandRough, sandUv).r;
                gSandNormal = texture2D(uSandNormal, sandUv).xyz * 2.0 - 1.0;
                gSandWeight = beach;
              }
              vec3 col = mix(land, sandColor, beach);
              // below the waterline
              float under = 1.0 - smoothstep(-0.4, 0.6, h);
              vec3 seabed = mix(sandSea, sandSea * 0.8, n3);
              float grassPatch = smoothstep(0.55, 0.62, fbm3(p * 0.006) + n2 * 0.08) * smoothstep(-2.5, -6.0, h) * (1.0 - smoothstep(0.35, 0.55, slope));
              seabed = mix(seabed, seagrass, grassPatch);
              seabed = mix(seabed, rock * 0.8, smoothstep(0.35, 0.6, slope));
              col = mix(col, seabed, under);
              // wet band at the shoreline
              gWet = (1.0 - smoothstep(0.0, 1.3, h)) * (1.0 - under);
              col = mix(col, col * 0.62, gWet);
              gTerrainAlbedo = col;
              gTerrainRough = mix(0.95, sandRough, beach * 0.75);
              gTerrainRough = mix(gTerrainRough, 0.35, gWet) * mix(1.0, 0.8, rockW);
            }`,
          )
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
             terrainSurface(vTWorld, normalize(vTNormal));
             diffuseColor.rgb = gTerrainAlbedo;`,
          )
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
             roughnessFactor = gTerrainRough;`,
          )
          .replace(
            '#include <normal_fragment_maps>',
            `#include <normal_fragment_maps>
             {
               // procedural detail normal from noise gradients (world space -> view space)
               vec3 n0 = normalize(vTNormal);
               vec3 w = triW(n0);
               float camD = length(vTWorld - cameraPosition);
               float s = (0.18 + 1.5 * smoothstep(0.2, 0.55, 1.0 - n0.y)) * (1.0 - smoothstep(600.0, 3500.0, camD));
               float e = 0.5;
               float hC = rockH(vTWorld, w);
               vec3 g = vec3(rockH(vTWorld + vec3(e, 0.0, 0.0), w) - hC, rockH(vTWorld + vec3(0.0, e, 0.0), w) - hC, rockH(vTWorld + vec3(0.0, 0.0, e), w) - hC) / e;
               g -= dot(g, n0) * n0; // tangential gradient
               vec3 wn = normalize(n0 - g * 3.2 * s);
               wn = normalize(wn + vec3(gSandNormal.x, 0.0, gSandNormal.y) * gSandWeight * 0.35);
               normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
             }`,
          )
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
             {
               // caustics dancing on the seabed (fade with depth), sunlit only
               float depth = -vTWorld.y;
               if (depth > 0.0) {
                 float c = causticsAt(vTWorld.xz, uTime) + 0.6 * causticsAt(vTWorld.xz * 1.7 + 13.0, uTime * 1.3);
                 float att = exp(-depth * 0.12) * smoothstep(0.0, 0.8, depth);
                 reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * c * att * 0.9 * max(uSunDir.y, 0.0) * gTerrainShadow;
               }
             }`,
          );
      },
      'terrain',
    );
    return mat;
  }
}
