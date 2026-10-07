import { LAYER_NOREFLECT } from '../core/pipeline';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, shared } from '../gfx/shared';
import { rng } from '../core/util';
import type { WorldGenResult } from './worldgenTypes';
import type { Terrain } from './terrain';
import { QUAY, berthBollards, pierFrame, houseFootprint } from './harbour';
import type { WaveField } from './waves';
import type { Quality } from '../core/quality';
import type { VisualAssets } from '../gfx/assets';
import type { ModelKit } from '../gfx/models';
import type { Solid } from './walkable';
import { LAYER_REFRACT } from '../core/pipeline';

const BLOCK = 1500;

function colorize(g: THREE.BufferGeometry, c: THREE.Color, jitter: number, r: () => number, heightDarken = 0) {
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  let minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = g.attributes.position.getY(i);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let i = 0; i < n; i++) {
    const k = 1 + (r() - 0.5) * jitter;
    const t = (g.attributes.position.getY(i) - minY) / Math.max(1e-3, maxY - minY);
    const d = 1 - heightDarken * (1 - t);
    col[i * 3] = c.r * k * d;
    col[i * 3 + 1] = c.g * k * d;
    col[i * 3 + 2] = c.b * k * d;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function jiggle(g: THREE.BufferGeometry, amt: number, r: () => number) {
  const p = g.attributes.position;
  // displace coincident vertices identically so faceted blobs stay closed
  const map = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let d = map.get(key);
    if (!d) {
      d = [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt];
      map.set(key, d);
    }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  return g;
}

const lin = (hex: number) => new THREE.Color(hex);

function strip(g: THREE.BufferGeometry) {
  const ng = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(ng.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') ng.deleteAttribute(k);
  return ng;
}

const UP = new THREE.Vector3(0, 1, 0);
const RAD_X = new THREE.Vector3(1, 0, 0);

/** objects visible through the water surface (seabed, hull) also draw in the refraction pass */
function refract(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      c.castShadow = true;
      c.receiveShadow = true;
      c.layers.enable(LAYER_REFRACT);
    }
  });
  return o;
}

/** one InstancedMesh per sub-mesh of the named kit objects; every instance shares geometry and slot materials */
class KitBatch {
  readonly meshes: THREE.InstancedMesh[] = [];
  constructor(models: ModelKit, names: string | string[], readonly count: number) {
    if (count > 0) for (const p of models.parts(names)) this.meshes.push(new THREE.InstancedMesh(p.geometry, p.material, count));
  }
  set(i: number, M: THREE.Matrix4) {
    for (const m of this.meshes) m.setMatrixAt(i, M);
    return M;
  }
  /** call after the matrices are set so the bounding spheres cover every instance */
  addTo(group: THREE.Group, refractive = false) {
    for (const m of this.meshes) {
      m.castShadow = true;
      m.receiveShadow = true;
      if (refractive) m.layers.enable(LAYER_REFRACT);
      m.computeBoundingSphere();
      group.add(m);
    }
  }
}

/** Tree / bush / rock archetypes (low-poly, vertex coloured) */
function makeArchetypes() {
  const r = rng(99);
  const trunkCol = lin(0x5a4636);
  // 0 cypress
  const cyp = new THREE.LatheGeometry(
    [0, 0.5, 0.75, 0.85, 0.8, 0.65, 0.45, 0.22, 0.0].map((w, i, a) => new THREE.Vector2(w * 0.95, (i / (a.length - 1)) * 9.5 + 0.6)),
    8,
  );
  jiggle(cyp, 0.25, r);
  const cypTrunk = new THREE.CylinderGeometry(0.1, 0.16, 1.2, 5).translate(0, 0.6, 0);
  const cypress = mergeGeometries([colorize(strip(cypTrunk), trunkCol, 0.2, r), colorize(strip(cyp), lin(0x1f3a1a), 0.3, r, 0.45)]);

  // 1 olive: gnarled trunk + silver-green blobs
  const olParts: THREE.BufferGeometry[] = [];
  const tr = new THREE.CylinderGeometry(0.18, 0.32, 2.2, 6, 3).translate(0, 1.1, 0);
  jiggle(tr, 0.18, r);
  olParts.push(colorize(strip(tr), lin(0x5b5046), 0.25, r));
  for (let i = 0; i < 5; i++) {
    const b = new THREE.IcosahedronGeometry(1.1 + r() * 0.5, 1);
    jiggle(b, 0.35, r);
    b.scale(1, 0.72, 1).translate((r() - 0.5) * 2.2, 2.6 + r() * 1.1, (r() - 0.5) * 2.2);
    olParts.push(colorize(strip(b), lin(0x6b7a52), 0.25, r, 0.45));
  }
  const olive = mergeGeometries(olParts);

  // 2 maquis bush
  const bParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.IcosahedronGeometry(0.7 + r() * 0.4, 0);
    jiggle(b, 0.3, r);
    b.scale(1, 0.65, 1).translate((r() - 0.5) * 1.2, 0.35 + r() * 0.2, (r() - 0.5) * 1.2);
    bParts.push(colorize(strip(b), i === 0 ? lin(0x3d4a26) : lin(0x4b5a2c), 0.3, r, 0.5));
  }
  const bush = mergeGeometries(bParts);

  // 3 limestone boulder
  const rock = new THREE.DodecahedronGeometry(1, 1);
  jiggle(rock, 0.45, r);
  rock.scale(1.2, 0.75, 1).translate(0, 0.3, 0);
  const boulder = colorize(strip(rock), lin(0x857d70), 0.22, r, 0.45);

  // 4 aleppo pine: leaning trunk + umbrella canopy
  const pParts: THREE.BufferGeometry[] = [];
  const pt = new THREE.CylinderGeometry(0.14, 0.26, 6, 6).translate(0, 3, 0).rotateZ(0.12);
  pParts.push(colorize(strip(pt), lin(0x6a4e3a), 0.2, r));
  for (let i = 0; i < 4; i++) {
    const b = new THREE.IcosahedronGeometry(1.5 + r() * 0.6, 1);
    jiggle(b, 0.4, r);
    b.scale(1.3, 0.45, 1.3).translate(0.7 + (r() - 0.5) * 2.4, 6.2 + r() * 1.0, (r() - 0.5) * 2.4);
    pParts.push(colorize(strip(b), lin(0x3c5a2a), 0.25, r, 0.5));
  }
  const pine = mergeGeometries(pParts);
  for (const g of [cypress, olive, bush, boulder, pine]) g.computeVertexNormals();
  return [cypress, olive, bush, boulder, pine];
}

export class Props {
  readonly group = new THREE.Group();
  private blocks: { obj: THREE.Object3D; center: THREE.Vector3; maxDist: number }[] = [];
  private boats: { mesh: THREE.Object3D; x: number; z: number; yaw: number; phase: number }[] = [];
  private beaconLight: THREE.PointLight;
  private beaconMat: THREE.MeshStandardMaterial;
  private flame: THREE.Mesh;
  private fireMat: THREE.MeshStandardMaterial;
  /** blocking solids for people on the quay and village dock (world): props and standing figures */
  readonly solids: Solid[] = [];

  constructor(gen: WorldGenResult, private terrain: Terrain, private waves: WaveField, noise: THREE.Texture, q: Quality, assets: VisualAssets, private models: ModelKit) {
    this.fireMat = models.material('fire');
    this.buildVegetation(gen);
    this.buildVillage(gen);
    this.buildTemple(gen);
    this.buildPier(gen);
    this.buildDockLife(gen);
    this.buildRockFaces(gen, assets);
    this.buildBoats(gen);
    // beacon fire in front of the temple (east side)
    const t = gen.sites.temple;
    this.beaconMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff8a30, emissiveIntensity: 2, transparent: true, opacity: 0.9, depthWrite: false });
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 8, 1, true).translate(0, 1.1, 0), this.beaconMat);
    const bx = t.x + 22,
      bz = t.z;
    const by = terrain.heightAt(bx, bz) + 1.0;
    this.flame.position.set(bx, by, bz);
    this.group.add(this.flame);
    const brazier = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 1.0, 10), patchMaterial(new THREE.MeshStandardMaterial({ color: 0x5a4a3a, metalness: 0.6, roughness: 0.5 }), undefined, 'brazier'));
    brazier.position.set(bx, by - 0.5, bz);
    this.group.add(brazier);
    this.beaconLight = new THREE.PointLight(0xff8a3a, 0, 120, 1.4);
    this.beaconLight.position.set(bx, by + 2, bz);
    this.group.add(this.beaconLight);
  }

  private buildVegetation(gen: WorldGenResult) {
    const arche = makeArchetypes();
    const mats = arche.map((_, i) => {
      const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: i === 3 ? 0.9 : 0.85, flatShading: i === 3 });
      patchMaterial(
        m,
        (sh) => {
          if (i === 3) return;
          sh.vertexShader = sh.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             {
               float hgt = max(transformed.y, 0.0);
               vec3 ip = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
               float ph = ip.x * 0.13 + ip.z * 0.11;
               float sway = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.9 + ph * 1.7) * 0.25;
               vec2 w = uWindDir * (0.4 + 0.6 * uWindStrength);
               transformed.xz += w * sway * 0.006 * hgt * hgt;
             }`,
          ).replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;');
        },
        'veg' + i,
      );
      return m;
    });
    const v = gen.vegetation;
    const byBlock = new Map<string, number[][]>();
    for (let i = 0; i < v.length; i += 6) {
      const type = v[i + 5];
      const bx = Math.floor(v[i] / BLOCK),
        bz = Math.floor(v[i + 2] / BLOCK);
      const key = `${bx},${bz},${type}`;
      if (!byBlock.has(key)) byBlock.set(key, []);
      byBlock.get(key)!.push([v[i], v[i + 1], v[i + 2], v[i + 3], v[i + 4]]);
    }
    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const S = new THREE.Vector3();
    const P = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    const r = rng(5);
    for (const [key, list] of byBlock) {
      const type = Number(key.split(',')[2]);
      const inst = new THREE.InstancedMesh(arche[type], mats[type], list.length);
      let cx = 0,
        cz = 0;
      list.forEach((e, i) => {
        const [x, y, z, s, rot] = e;
        Q.setFromAxisAngle(up, rot);
        const sy = type === 0 ? s * (0.8 + r() * 0.5) : s;
        S.set(s, sy, s);
        P.set(x, y - 0.25 * s, z);
        M.compose(P, Q, S);
        inst.setMatrixAt(i, M);
        tint.setHSL(0.25 + (r() - 0.5) * 0.05, 0.1 + r() * 0.1, 0.45 + r() * 0.15);
        const k = 0.85 + r() * 0.3;
        inst.setColorAt(i, new THREE.Color(k, k, k * (0.95 + r() * 0.1)));
        cx += x;
        cz += z;
      });
      inst.computeBoundingSphere();
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.layers.set(LAYER_NOREFLECT); // thousands of instances for little gain in a rippled mirror
      this.group.add(inst);
      const maxDist = type === 2 ? 2200 : type === 3 ? 3500 : 7000;
      this.blocks.push({ obj: inst, center: new THREE.Vector3(cx / list.length, 0, cz / list.length), maxDist });
    }
  }

  private buildVillage(gen: WorldGenResult) {
    const houses = gen.sites.houses;
    if (!houses.length) return;
    // modelled footprints (m); a house takes the smallest variant that holds its area
    const variants = [
      { name: 'house_c', w: 4, l: 4 },
      { name: 'house_a', w: 5, l: 6 },
      { name: 'house_b', w: 6, l: 8 },
    ];
    const byVariant = variants.map(() => [] as typeof houses);
    // same choice as the collision boxes in harbour.ts
    for (const h of houses) byVariant[variants.findIndex((v) => v.w === houseFootprint(h.w * h.l)[0])].push(h);
    // footprints stretch to the village plan but keep the modelled proportions within 0.8..1.25
    const fit = (k: number) => Math.min(1.25, Math.max(0.8, k));
    const M = new THREE.Matrix4(),
      Q = new THREE.Quaternion(),
      P = new THREE.Vector3(),
      S = new THREE.Vector3();
    variants.forEach((v, k) => {
      const list = byVariant[k];
      const batch = new KitBatch(this.models, [v.name, v.name + '_windows'], list.length);
      list.forEach((h, i) => {
        Q.setFromAxisAngle(UP, h.rot);
        // the footing reaches 1.5 m below ground, so the model only needs its ground at the lowest corner
        P.set(h.x, h.y + 0.05, h.z);
        batch.set(i, M.compose(P, Q, S.set(fit(h.w / v.w), 1, fit(h.l / v.l))));
      });
      batch.addTo(this.group);
    });
  }

  private buildTemple(gen: WorldGenResult) {
    const t = gen.sites.temple;
    const parts: THREE.BufferGeometry[] = [];
    const W = 14,
      L = 31;
    // krepidoma: three steps
    for (let s = 0; s < 3; s++) parts.push(new THREE.BoxGeometry(W + (3 - s) * 1.2, 0.5, L + (3 - s) * 1.2).translate(0, 0.25 + s * 0.5, 0));
    const base = 1.5;
    const colH = 6.6;
    const nx = 6,
      nz = 13;
    const col = new THREE.CylinderGeometry(0.52, 0.64, colH, 20, 1);
    // fluting: modulate radius by 20 flutes
    const cp = col.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i),
        z = cp.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 - 0.04 * Math.abs(Math.sin(a * 10));
      cp.setX(i, x * k);
      cp.setZ(i, z * k);
    }
    const capital = new THREE.CylinderGeometry(0.85, 0.6, 0.45, 20).translate(0, colH / 2 + 0.22, 0);
    const abacus = new THREE.BoxGeometry(1.7, 0.3, 1.7).translate(0, colH / 2 + 0.6, 0);
    const column = mergeGeometries([col, capital, abacus].map((g) => strip(g)));
    const sx = (W - 1.6) / (nx - 1),
      sz = (L - 1.6) / (nz - 1);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        if (i !== 0 && i !== nx - 1 && j !== 0 && j !== nz - 1) continue;
        parts.push(column.clone().translate(-W / 2 + 0.8 + i * sx, base + colH / 2, -L / 2 + 0.8 + j * sz));
      }
    // cella walls
    parts.push(new THREE.BoxGeometry(W - 5, colH, L - 9).translate(0, base + colH / 2, 0));
    // entablature
    const eb = base + colH + 0.75;
    parts.push(new THREE.BoxGeometry(W + 0.2, 1.2, L + 0.2).translate(0, eb + 0.6, 0)); // architrave+frieze
    parts.push(new THREE.BoxGeometry(W + 0.8, 0.35, L + 0.8).translate(0, eb + 1.35, 0)); // cornice
    // pediment roof
    const rs = new THREE.Shape();
    rs.moveTo(-W / 2 - 0.4, 0);
    rs.lineTo(W / 2 + 0.4, 0);
    rs.lineTo(0, 2.3);
    rs.closePath();
    parts.push(new THREE.ExtrudeGeometry(rs, { depth: L + 0.8, bevelEnabled: false }).translate(0, eb + 1.5, -(L + 0.8) / 2));
    const geo = mergeGeometries(parts.map((g) => strip(g)));
    geo.computeVertexNormals();
    const marble = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xece4d6, roughness: 0.55 }), undefined, 'marble');
    const temple = new THREE.Mesh(geo, marble);
    // Greek temples face east: long axis east-west
    temple.rotation.y = Math.PI / 2;
    temple.position.set(t.x, t.y - 0.4, t.z);
    temple.castShadow = true;
    temple.receiveShadow = true;
    this.group.add(temple);
    // painted frieze band (triglyph blue / metope red)
    const frieze = new THREE.Mesh(
      new THREE.BoxGeometry(W + 0.3, 0.5, L + 0.3),
      patchMaterial(new THREE.MeshStandardMaterial({ color: 0x2a4a7a, roughness: 0.6 }), undefined, 'frieze'),
    );
    frieze.position.set(t.x, t.y - 0.4 + eb + 0.95, t.z);
    frieze.rotation.y = Math.PI / 2;
    this.group.add(frieze);
  }

  /** the mole from the kit: quay_head at the sea end, quay_segment tiles back to the shore, bollards and fenders at the berth */
  private buildPier(gen: WorldGenResult) {
    const f = pierFrame(gen.sites.pier);
    // model +z runs shore → sea
    const Q = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(f.ux, f.uz));
    const at = (a: number, lat: number, y: number) => new THREE.Vector3(f.x0 + f.ux * a + f.lx * lat, y, f.z0 + f.uz * a + f.lz * lat);
    const M = new THREE.Matrix4(),
      S = new THREE.Vector3();

    // body: tiles of 6 m, stretched so they meet exactly at the head
    const body = f.length - 6;
    const n = Math.max(1, Math.round(body / 6));
    const seg = body / n;
    const tiles = new KitBatch(this.models, 'quay_segment', n);
    for (let i = 0; i < n; i++) tiles.set(i, M.compose(at((i + 0.5) * seg, 0, f.top), Q, S.set(1, 1, seg / 6)));
    tiles.addTo(this.group, true);

    // head: its +z end (the stair end) sits at the pier length
    const head = this.models.get('quay_head');
    head.position.copy(at(f.length - 3, 0, f.top));
    head.quaternion.copy(Q);
    this.group.add(refract(head));

    const bollards = new KitBatch(this.models, 'bollard', 6);
    let bi = 0;
    for (const side of [-1, 1] as const) for (const v of berthBollards(f, side)) bollards.set(bi++, M.makeTranslation(v.x, v.y, v.z));
    bollards.addTo(this.group, true);

    // fenders hang just outside both faces of the berth, every 5 m, long axis vertical
    const F = new THREE.Quaternion().setFromAxisAngle(RAD_X, Math.PI / 2);
    const fenders: THREE.Matrix4[] = [];
    for (const side of [-1, 1])
      for (let a = f.berthStart + 2.5; a < f.length - 3; a += 5)
        fenders.push(new THREE.Matrix4().compose(at(a, side * (f.width / 2 + 0.2), f.top - 1), F, S.set(1, 1, 1)));
    const fb = new KitBatch(this.models, 'fender', fenders.length);
    fenders.forEach((m, i) => fb.set(i, m));
    fb.addTo(this.group, true);
  }

  /**
   * Life on the shore half of the mole: a cluster of goods on one side, a porter on the other, a fisher
   * sitting on the edge and a sailor by a bollard. Everything blocks people except the fisher, whose
   * legs hang over the face.
   */
  private buildDockLife(gen: WorldGenResult) {
    const f = pierFrame(gen.sites.pier);
    const a0 = 4,
      a1 = f.berthStart - 2;
    if (a1 - a0 < 8) return;
    const r = rng(41);
    const top = f.top;
    const hw = f.width / 2;
    const at = (a: number, lat: number) => ({ x: f.x0 + f.ux * a + f.lx * lat, z: f.z0 + f.uz * a + f.lz * lat });
    // yaw that points a model's -z (its facing) along (dx, dz)
    const face = (dx: number, dz: number) => Math.atan2(-dx, -dz);
    const placed: { x: number; z: number; rad: number }[] = [];
    const clear = (x: number, z: number, rad: number) => placed.every((p) => Math.hypot(p.x - x, p.z - z) >= p.rad + rad + 0.1);
    const figure = (name: string, x: number, y: number, z: number, yaw: number, blocks: boolean) => {
      const o = this.models.get(name);
      o.position.set(x, y, z);
      o.rotation.y = yaw;
      this.group.add(o);
      if (blocks) {
        this.solids.push({ kind: 'cyl', cx: x, cz: z, r: 0.3, y0: top, y1: top + 1.8, surface: 'stone', walkTop: false });
        placed.push({ x, z, rad: 0.3 });
      }
    };

    const side = r() < 0.5 ? -1 : 1; // goods cluster side; the figures stand on the other
    const fs = -side;
    // fisher on the edge, seated (hips on the quay top), knees over the face, facing the water
    const fp = at(7, fs * (hw - 0.6));
    figure('fig_fisher_sit', fp.x, top - 0.47, fp.z, face(fs * f.lx, fs * f.lz), false);
    placed.push({ x: fp.x, z: fp.z, rad: 0.6 });
    // porter walking seaward, toward the berth
    const dp = at(a1 - 4, fs * 1.8);
    figure('fig_dockworker_carry', dp.x, top, dp.z, face(f.ux, f.uz), true);
    // sailor standing by the berth bollard, facing the ship
    const sl = at(f.mid - QUAY.bollardSpacing + 1, fs * (hw - QUAY.bollardInset));
    figure('fig_sailor_idle', sl.x, top, sl.z, face(fs * f.lx, fs * f.lz), true);

    // goods: crates and racks are boxes, jars and coils are cylinders; each stays out of the walkway (|lateral| < 1.3)
    type Item = { name: string; hx?: number; hz?: number; rad?: number; h: number };
    const items: Item[] = [
      { name: 'crate', hx: 0.4, hz: 0.4, h: 0.7 },
      { name: 'amphora', rad: 0.25, h: 0.86 },
      { name: 'amphora_rack', hx: 0.75, hz: 0.39, h: 1.0 },
      { name: 'pithos', rad: 0.44, h: 1.3 },
      { name: 'net_pile', rad: 0.45, h: 0.34 },
      { name: 'basket', rad: 0.25, h: 0.42 },
      { name: 'rope_coil', rad: 0.33, h: 0.13 },
    ];
    const want = 8 + Math.floor(r() * 5);
    const ac = a0 + 2 + r() * (a1 - a0 - 4);
    let made = 0;
    for (let tries = 0; tries < 400 && made < want; tries++) {
      const it = items[Math.floor(r() * items.length)];
      const yaw = r() * Math.PI * 2;
      // lateral half-extent under this yaw (box axes: (cos, -sin) and (sin, cos)), circumscribed radius for spacing
      const circ = it.rad ?? Math.hypot(it.hx!, it.hz!);
      const ext = it.rad ?? it.hx! * Math.abs(Math.cos(yaw) * f.lx - Math.sin(yaw) * f.lz) + it.hz! * Math.abs(Math.sin(yaw) * f.lx + Math.cos(yaw) * f.lz);
      const a = Math.min(a1 - ext, Math.max(a0 + ext, ac + (r() - 0.5) * 8));
      const lat = side * (1.3 + ext + r() * 0.9);
      if (Math.abs(lat) + ext > hw - 0.1) continue;
      const p = at(a, lat);
      if (!clear(p.x, p.z, circ)) continue;
      const o = this.models.get(it.name);
      o.position.set(p.x, top, p.z);
      o.rotation.y = yaw;
      this.group.add(o);
      if (it.rad) this.solids.push({ kind: 'cyl', cx: p.x, cz: p.z, r: it.rad, y0: top, y1: top + it.h, surface: 'stone', walkTop: false });
      else this.solids.push({ kind: 'box', cx: p.x, cz: p.z, hx: it.hx!, hz: it.hz!, rot: yaw, y0: top, y1: top + it.h, surface: 'stone', walkTop: false });
      placed.push({ x: p.x, z: p.z, rad: circ });
      made++;
    }
  }

  private buildRockFaces(gen: WorldGenResult, assets: VisualAssets) {
    // Find exposed shore on both sides of the pier from navigable harbor water.
    const h = gen.sites.harbour;
    const shoreAngle = gen.sites.pier.angle + Math.PI;
    const offsets = [-0.58, -0.4, -0.23, 0.23, 0.4, 0.58];
    assets.rockFace.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.layers.enable(LAYER_REFRACT);
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) patchMaterial(material, undefined, 'rockface');
    });
    for (let i = 0; i < offsets.length; i++) {
      const a = shoreAngle + offsets[i];
      const dx = Math.cos(a), dz = Math.sin(a);
      let d = 0;
      for (let probe = 35; probe <= 650; probe += 6) {
        if (this.terrain.heightAt(h.x + dx * probe, h.z + dz * probe) > 2) {
          d = probe;
          break;
        }
      }
      if (!d) continue;
      const x = h.x + dx * (d + 3), z = h.z + dz * (d + 3);
      const scale = 2.0 + (i % 3) * 0.4;
      const rock = assets.rockFace.clone(true);
      rock.scale.setScalar(scale);
      rock.rotation.y = -Math.PI / 2 - a + (i % 2 ? 0.2 : -0.15);
      rock.position.set(x, this.terrain.heightAt(x, z) - scale * 0.75, z);
      rock.updateMatrixWorld(true);
      this.group.add(rock);
      this.blocks.push({ obj: rock, center: new THREE.Vector3(x, 0, z), maxDist: 2200 });
    }
  }

  private buildBoats(gen: WorldGenResult) {
    const h = gen.sites.harbour;
    const hull = new THREE.CylinderGeometry(1, 1, 7, 12, 4, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
    const p = hull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i) / 3.5; // -1..1
      const taper = 1 - Math.pow(Math.abs(z), 2.2) * 0.85;
      p.setX(i, p.getX(i) * 0.9 * taper);
      p.setY(i, p.getY(i) * 0.7 + Math.pow(Math.abs(z), 3) * 0.5);
    }
    hull.computeVertexNormals();
    const mats = [0x2b5a8a, 0xe8e2d4, 0x8f2a1c, 0x3a6a4a].map((c) => patchMaterial(new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, side: THREE.DoubleSide }), undefined, 'boat'));
    const r = rng(8);
    // keep clear of the mole and its berth zone
    const pier = gen.sites.pier;
    const pux = Math.cos(pier.angle),
      puz = Math.sin(pier.angle);
    const pierDist = (x: number, z: number) => {
      const t = Math.max(0, Math.min(pier.length, (x - pier.x) * pux + (z - pier.z) * puz));
      return Math.hypot(x - (pier.x + pux * t), z - (pier.z + puz * t));
    };
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      const d = 40 + r() * 120;
      const x = h.x + Math.cos(a) * d,
        z = h.z + Math.sin(a) * d;
      if (this.terrain.heightAt(x, z) > -1.5) continue;
      if (pierDist(x, z) < 30) continue;
      const g = new THREE.Group();
      const m = new THREE.Mesh(hull, mats[i % mats.length]);
      m.castShadow = true;
      g.add(m);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 4.5, 5), mats[1]);
      mast.position.set(0, 2.3, -0.8);
      g.add(mast);
      this.group.add(g);
      this.boats.push({ mesh: g, x, z, yaw: r() * Math.PI * 2, phase: r() * 10 });
    }
  }

  update(dt: number, time: number, camera: THREE.Camera, night: number) {
    const cp = camera.position;
    for (const b of this.blocks) {
      const d = Math.hypot(b.center.x - cp.x, b.center.z - cp.z);
      b.obj.visible = d < b.maxDist + BLOCK;
    }
    // anchored boats ride the swell (same water the trireme floats on)
    for (const b of this.boats) {
      const y = this.waves.heightAt(b.x, b.z, time);
      const f = this.waves.heightAt(b.x + Math.sin(b.yaw) * 3, b.z + Math.cos(b.yaw) * 3, time);
      const s = this.waves.heightAt(b.x + Math.cos(b.yaw) * 1, b.z - Math.sin(b.yaw) * 1, time);
      b.mesh.position.set(b.x, y - 0.1, b.z);
      b.mesh.rotation.set(Math.atan2(f - y, 3) * 0.8, b.yaw + Math.sin(time * 0.05 + b.phase) * 0.3, Math.atan2(s - y, 1) * 0.6, 'YXZ');
    }
    const flick = 0.8 + 0.2 * Math.sin(time * 11.3) * Math.sin(time * 5.7 + 2.0);
    this.beaconLight.intensity = (0.3 + night) * 400 * flick;
    this.beaconMat.emissiveIntensity = 3 + 4 * night * flick;
    this.flame.scale.set(1 + 0.1 * Math.sin(time * 9), 0.9 + 0.2 * flick, 1 + 0.1 * Math.cos(time * 7));
    this.fireMat.emissiveIntensity = night * 3;
  }
}
