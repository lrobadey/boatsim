import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, shared } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { makeSailTexture, makeEyeTexture } from '../gfx/textures';
import type { SurfaceMaps } from '../gfx/assets';
import { halfBeam, keelDepth, sheer, section, zOf, deckY, DECK_S0, DECK_S1, HULL_LENGTH, RAM_LENGTH } from './hull';
import { OAR_BANKS, type OarSlot } from './oarLayout';
import { createKinematics } from './rowing';
import { buildOarGeometry } from './oarGeometry';
import { Crew } from './crew';
import type { ShipPhysics } from './physics';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** outrigger (parexeiresia) outboard extension along the hull */
export const outrigger = (s: number) => 0.7 * smooth(0.13, 0.2, s) * (1 - smooth(0.8, 0.87, s));
/** walkable half-width of the deck */
export const deckHalfWidth = (s: number) => halfBeam(s) + outrigger(s) - 0.45;

const mat = (p: THREE.MeshStandardMaterialParameters, key = '') => patchMaterial(new THREE.MeshStandardMaterial(p), undefined, key);

/**
 * The visual trireme, built procedurally from the hull definition.
 */
export class Trireme {
  readonly group = new THREE.Group();
  private oars: THREE.InstancedMesh[] = [];
  private slots: readonly OarSlot[];
  private instanceIds: Int16Array;
  private oarPose = createKinematics();
  private sailMesh: THREE.Mesh;
  private sailUniforms = { uBillow: { value: 0 }, uFurl: { value: 0 }, uFlutter: { value: 0 } };
  private yard: THREE.Group;
  private steer: THREE.Group[] = [];
  readonly lantern: THREE.PointLight;
  private lanternMat: THREE.MeshStandardMaterial;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpS = new THREE.Vector3(1, 1, 1);
  readonly bladeWorld: THREE.Vector3[] = [];
  readonly bladeIn: boolean[] = [];
  private crewFigures: THREE.InstancedMesh | null = null;
  readonly mastTop = new THREE.Vector3();

  constructor(planks: SurfaceMaps, slots: readonly OarSlot[]) {
    const g = this.group;
    // The scan's grain runs vertically. Hull UVs run lengthwise in U; deck UVs run lengthwise in V.
    const hullMaps = [planks.color, planks.normal, planks.roughness].map((source) => {
      const tex = source.clone();
      tex.center.set(0.5, 0.5);
      tex.rotation = Math.PI / 2;
      tex.needsUpdate = true;
      return tex;
    });

    // ---------- hull ----------
    const hullMat = mat({ map: hullMaps[0], normalMap: hullMaps[1], roughnessMap: hullMaps[2], normalScale: new THREE.Vector2(0.4, 0.4), vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }, 'hull');
    const hull = new THREE.Mesh(this.hullGeometry(), hullMat);
    hull.castShadow = true;
    hull.receiveShadow = true;
    hull.layers.enable(LAYER_REFRACT);
    g.add(hull);

    // ---------- deck ----------
    const deckMat = mat({ map: planks.color, normalMap: planks.normal, roughnessMap: planks.roughness, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 1, color: new THREE.Color().setRGB(1.25, 1.14, 1.02) }, 'deck');
    const deck = new THREE.Mesh(this.deckGeometry(), deckMat);
    deck.receiveShadow = true;
    deck.castShadow = true;
    g.add(deck);

    // ---------- screens & outrigger ----------
    const screenMat = mat({ map: hullMaps[0], normalMap: hullMaps[1], roughnessMap: hullMaps[2], normalScale: new THREE.Vector2(0.4, 0.4), color: 0xd6b290, roughness: 0.9, side: THREE.DoubleSide }, 'screen');
    const screens = new THREE.Mesh(this.screenGeometry(), screenMat);
    screens.castShadow = true;
    screens.receiveShadow = true;
    g.add(screens);

    // ---------- shields hung on the screens ----------
    this.addShields();

    // ---------- ram & bow ----------
    const bronze = mat({ color: 0xb07a3a, metalness: 0.9, roughness: 0.32 }, 'bronze');
    const ram = new THREE.Mesh(this.ramGeometry(), bronze);
    ram.castShadow = true;
    ram.layers.enable(LAYER_REFRACT);
    g.add(ram);
    // bow ornament (stolos) and stern ornament (aphlaston)
    const woodDark = mat({ color: 0x6e4c32, roughness: 0.7 }, 'wooddark');
    const painted = mat({ color: 0x8f2a1c, roughness: 0.6 }, 'painted');
    g.add(this.curvedPiece([[0, sheer(0) - 0.2, zOf(0) + 0.1], [0, sheer(0) + 0.4, zOf(0) - 0.25], [0, sheer(0) + 0.9, zOf(0) - 0.1], [0, sheer(0) + 1.1, zOf(0) + 0.3]], 0.12, 0.05, painted));
    for (let k = -2; k <= 2; k++) {
      const sx = k * 0.16;
      const s1 = 1.0;
      const base = [0, sheer(s1) - 0.3, zOf(s1) - 0.2];
      g.add(
        this.curvedPiece(
          [
            base,
            [sx * 0.5, sheer(s1) + 0.6, zOf(s1) + 0.5],
            [sx, sheer(s1) + 1.8, zOf(s1) + 0.35],
            [sx * 1.2, sheer(s1) + 2.5 - Math.abs(k) * 0.1, zOf(s1) - 0.6],
            [sx * 1.3, sheer(s1) + 2.4 - Math.abs(k) * 0.2, zOf(s1) - 1.2],
          ],
          0.1,
          0.035,
          k === 0 ? painted : woodDark,
        ),
      );
    }

    // ---------- eyes ----------
    const eyeTex = makeEyeTexture();
    const eyeMat = mat({ map: eyeTex, transparent: true, alphaTest: 0.5, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2 }, 'eye');
    for (const side of [-1, 1]) {
      // sit the eye on the hull surface, oriented by the local hull tangent
      const s = 0.06;
      const y = 1.45;
      const ds = 0.01;
      const x0 = this.hullXAt(s - ds, y),
        x1 = this.hullXAt(s + ds, y);
      const tangent = new THREE.Vector3(side * (x1 - x0), 0, zOf(s + ds) - zOf(s - ds)).normalize();
      const normal = new THREE.Vector3(0, 1, 0).cross(tangent).multiplyScalar(side > 0 ? -1 : 1).normalize();
      const x = side * (this.hullXAt(s, y) + 0.03);
      const eye = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.62), eyeMat);
      eye.position.set(x, y, zOf(s));
      eye.lookAt(eye.position.clone().add(normal));
      g.add(eye);
    }

    // ---------- oars ----------
    this.slots = slots;
    this.instanceIds = new Int16Array(slots.length);
    const oarMat = mat({ color: 0x9a7650, roughness: 0.7 }, 'oar');
    for (let bank = 0; bank < OAR_BANKS.length; bank++) {
      const bankSlots = slots.filter(slot => slot.bank === bank);
      const mesh = new THREE.InstancedMesh(buildOarGeometry(bankSlots[0]), oarMat, bankSlots.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.layers.enable(LAYER_REFRACT);
      bankSlots.forEach((slot, index) => { this.instanceIds[slot.id] = index; });
      this.oars.push(mesh); g.add(mesh);
    }
    for (const slot of slots) { this.bladeWorld.push(new THREE.Vector3()); this.bladeIn.push(false); }

    // ---------- mast, yard, sail ----------
    const sm = 0.42;
    const mastZ = zOf(sm);
    const mastBase = deckY(sm);
    const mastH = 11.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, mastH, 10), woodDark);
    mast.position.set(0, mastBase + mastH / 2, mastZ);
    mast.castShadow = true;
    g.add(mast);
    this.mastTop.set(0, mastBase + mastH, mastZ);
    this.yard = new THREE.Group();
    this.yard.position.set(0, mastBase + mastH - 0.7, mastZ);
    g.add(this.yard);
    const yardMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 12.5, 8).rotateZ(Math.PI / 2), woodDark);
    yardMesh.castShadow = true;
    this.yard.add(yardMesh);
    const sailTex = makeSailTexture();
    const sailMat = new THREE.MeshStandardMaterial({ map: sailTex, side: THREE.DoubleSide, roughness: 0.9 });
    patchMaterial(
      sailMat,
      (sh) => {
        Object.assign(sh.uniforms, this.sailUniforms);
        sh.vertexShader = sh.vertexShader
          .replace(
            '#include <common>',
            `#include <common>
            uniform float uBillow; uniform float uFurl; uniform float uFlutter; uniform float uTime;
            varying float vSailShade;`,
          )
          .replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3(position);
             // position: x in [-5,5], y in [-7,0] (top at the yard)
             float u = transformed.x / 5.0;
             float v = -transformed.y / 7.0;           // 0 top .. 1 foot
             float h = 7.0 * (1.0 - uFurl * 0.94);      // brailed up toward the yard
             transformed.y = -v * h;
             float belly = (1.0 - u * u) * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
             float flap = sin(transformed.x * 1.3 + uTime * 7.0 + v * 4.0) * sin(v * 3.14159) * uFlutter;
             transformed.z += -(uBillow * 1.6 * belly) * (1.0 - uFurl) + flap * 0.35;
             // folds when brailed
             // brailed-up cloth: a rounded bundle under the yard with irregular folds
             transformed.z += uFurl * (0.28 * sin(3.14159 * v) + sin(v * 40.0 + u * 3.0) * 0.08) * (1.0 - 0.3 * u * u);
             transformed.y -= uFurl * 0.08 * sin(u * 9.0) * v;
             vSailShade = belly;`,
          )
          .replace(
            '#include <beginnormal_vertex>',
            `#include <beginnormal_vertex>
             {
               float u = position.x / 5.0; float v = -position.y / 7.0;
               float dbdu = -2.0 * u * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
               objectNormal = normalize(vec3(uBillow * 1.6 * dbdu / 5.0 * (1.0 - uFurl), 0.0, 1.0));
             }`,
          );
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vSailShade;')
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
             // light transmitted through the linen from behind
             {
               vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
               float back = max(dot(-nW * (gl_FrontFacing ? 1.0 : -1.0), uSunDir), 0.0);
               reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * back * 0.35;
             }`,
          );
      },
      'sail',
    );
    const sailGeo = new THREE.PlaneGeometry(10, 7, 24, 18).translate(0, -3.5, 0);
    this.sailMesh = new THREE.Mesh(sailGeo, sailMat);
    this.sailMesh.position.set(0, -0.1, 0.2);
    this.sailMesh.castShadow = true;
    this.sailMesh.frustumCulled = false;
    this.yard.add(this.sailMesh);

    // rigging
    const ropeMat = mat({ color: 0x6b5a40, roughness: 0.95 }, 'rope');
    const top = new THREE.Vector3(0, mastBase + mastH - 0.2, mastZ);
    const rope = (a: THREE.Vector3, b: THREE.Vector3, r = 0.018) => {
      const d = b.clone().sub(a);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 4), ropeMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      g.add(m);
    };
    rope(top, new THREE.Vector3(0, sheer(0.02) + 0.3, zOf(0.02)));
    rope(top, new THREE.Vector3(0, deckY(0.9) + 0.1, zOf(0.9)));
    for (const side of [-1, 1]) {
      for (const s of [0.36, 0.48]) rope(top, new THREE.Vector3(side * (halfBeam(s) + outrigger(s)), deckY(s) + 0.9, zOf(s)), 0.014);
    }

    // ---------- steering oars ----------
    const steerMat = mat({ color: 0x5a3d25, roughness: 0.7 }, 'steer');
    for (const side of [-1, 1]) {
      const s = 0.9;
      const pivot = new THREE.Vector3(side * (halfBeam(s) + 0.3), sheer(s) - 0.2, zOf(s));
      const bladeC = new THREE.Vector3(side * (halfBeam(0.93) + 0.45), -0.7, zOf(0.93) + 0.8);
      const dir = bladeC.clone().sub(pivot);
      const len = dir.length();
      dir.normalize();
      const grp = new THREE.Group();
      grp.position.copy(pivot);
      grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const shaftM = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, len + 1.6, 8).translate(0, -(len + 1.6) / 2 + 1.6, 0), steerMat);
      const bladeM = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.7, 0.55).translate(0, -len, 0.12), steerMat);
      const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 6).rotateX(Math.PI / 2).translate(0, 1.5, -0.55), steerMat);
      for (const m of [shaftM, bladeM, tiller]) {
        m.castShadow = true;
        m.layers.enable(LAYER_REFRACT);
        grp.add(m);
      }
      g.add(grp);
      this.steer.push(grp);
      (grp as any).baseQuat = grp.quaternion.clone();
    }

    // ---------- stern lantern ----------
    this.lanternMat = new THREE.MeshStandardMaterial({ color: 0x221100, emissive: 0xffa040, emissiveIntensity: 0, roughness: 0.5 });
    patchMaterial(this.lanternMat, undefined, 'lantern');
    const lanternPos = new THREE.Vector3(0, deckY(0.955) + 1.5, zOf(0.955));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), this.lanternMat);
    lamp.position.copy(lanternPos);
    g.add(lamp);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), woodDark);
    post.position.copy(lanternPos).add(new THREE.Vector3(0, -0.75, 0));
    g.add(post);
    this.lantern = new THREE.PointLight(0xff9a40, 0, 30, 1.6);
    this.lantern.position.copy(lanternPos);
    g.add(this.lantern);

    // ---------- deck clutter & crew ----------
    this.addDeckProps(woodDark);
    this.addCrew();

    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = true;
    });
  }

  /** x of the hull surface at station s and height y (starboard) */
  private hullXAt(s: number, y: number) {
    let lo = 0,
      hi = 1;
    const p = { x: 0, y: 0 };
    for (let i = 0; i < 16; i++) {
      const m = (lo + hi) / 2;
      section(s, m, p);
      if (p.y < y) lo = m;
      else hi = m;
    }
    return section(s, lo, p).x;
  }

  private hullGeometry() {
    const NS = 72,
      NG = 16;
    const pos: number[] = [],
      uv: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const p = { x: 0, y: 0 };
    const row = 2 * NG + 1;
    for (let i = 0; i <= NS; i++) {
      const s = 0.5 - 0.5 * Math.cos((Math.PI * i) / NS);
      const z = zOf(s);
      const S = sheer(s);
      // arc length along the girth for UVs
      let arc = 0;
      let px = 0,
        py = -keelDepth(s);
      const arcs: number[] = [];
      for (let j = 0; j <= NG; j++) {
        section(s, j / NG, p);
        arc += Math.hypot(p.x - px, p.y - py);
        px = p.x;
        py = p.y;
        arcs.push(arc);
      }
      for (let k = 0; k < row; k++) {
        const j = Math.abs(k - NG);
        const side = k < NG ? -1 : 1;
        section(s, j / NG, p);
        pos.push(side * p.x, p.y, z);
        uv.push(z / 8, (side * arcs[j]) / 3.2 + 0.5);
        // paint scheme: pitch below the wale, red ochre band, stained wood topsides, red bow
        let c: [number, number, number];
        const y = p.y;
        if (y < 1.02) c = [0.09, 0.075, 0.065];
        else if (y < 1.1) c = [0.8, 0.62, 0.28];
        else if (y > S - 0.42 && y < S - 0.16) c = [0.75, 0.2, 0.1];
        else if (y > S - 0.52 && y < S - 0.46) c = [0.85, 0.7, 0.35];
        else c = [1.05, 0.86, 0.68];
        if (s < 0.1 && y > 1.1 && y < S - 0.52) {
          const w = 1 - smooth(0.06, 0.1, s);
          c = [c[0] * (1 - w) + 0.72 * w, c[1] * (1 - w) + 0.2 * w, c[2] * (1 - w) + 0.1 * w];
        }
        col.push(...c);
      }
    }
    for (let i = 0; i < NS; i++)
      for (let k = 0; k < row - 1; k++) {
        const a = i * row + k,
          b = a + 1,
          c = a + row,
          d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private deckGeometry() {
    const NS = 60,
      NX = 8;
    const pos: number[] = [],
      uv: number[] = [],
      idx: number[] = [];
    for (let i = 0; i <= NS; i++) {
      const s = DECK_S0 + ((DECK_S1 - DECK_S0) * i) / NS;
      const w = halfBeam(s) + outrigger(s);
      for (let k = 0; k <= NX; k++) {
        const x = -w + (2 * w * k) / NX;
        pos.push(x, deckY(s), zOf(s));
        uv.push(x / 3, zOf(s) / 3);
      }
    }
    for (let i = 0; i < NS; i++)
      for (let k = 0; k < NX; k++) {
        const a = i * (NX + 1) + k,
          b = a + 1,
          c = a + NX + 1,
          d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    // thin edge boards
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private screenGeometry() {
    const NS = 60;
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const pos: number[] = [],
        uv: number[] = [],
        idx: number[] = [];
      // rows: outrigger bottom (inner), outrigger bottom (outer), screen bottom, screen top
      for (let i = 0; i <= NS; i++) {
        const s = DECK_S0 - 0.02 + ((DECK_S1 - DECK_S0 + 0.05) * i) / NS;
        const B = halfBeam(s);
        const o = outrigger(s);
        const x = side * (B + o);
        const S = sheer(s);
        // full screens (parablemata) along the rowing frame, a low rail at bow and stern
        const screenH = 0.35 + 0.5 * smooth(0.1, 0.2, s) * (1 - smooth(0.8, 0.9, s));
        const top = deckY(s) + screenH;
        const bottom = S + (o > 0.05 ? 0.3 : 0.0);
        const z = zOf(s);
        pos.push(side * B, S - 0.05, z, x, S - 0.05, z, x, bottom, z, x, top, z);
        uv.push(z / 8, 0, z / 8, 0.1, z / 8, 0.2, z / 8, 0.45);
      }
      for (let i = 0; i < NS; i++)
        for (let r = 0; r < 3; r++) {
          if (r === 1) continue; // gap between outrigger floor and screen: thranite oar ports
          const a = i * 4 + r,
            b = a + 1,
            c = a + 4,
            d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      parts.push(g);
    }
    // outrigger posts (vertical stanchions) between floor and screen
    for (const side of [-1, 1])
      for (let i = 0; i <= 24; i++) {
        const s = 0.16 + (i / 24) * 0.68;
        const x = side * (halfBeam(s) + outrigger(s));
        const b = new THREE.BoxGeometry(0.06, 0.4, 0.06).translate(x, sheer(s) + 0.15, zOf(s));
        b.deleteAttribute('uv');
        b.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(b.attributes.position.count * 2), 2));
        parts.push(b);
      }
    return mergeGeometries(parts.map((p) => p.toNonIndexed()));
  }

  private addShields() {
    // bronze-faced aspides and painted ones in earth pigments
    const colors = [0xa07038, 0x7a2a1c, 0x9a6a34, 0x2c2622, 0xb08a4a, 0x5a2a20, 0xc9b28a];
    const geo = new THREE.CylinderGeometry(0.46, 0.46, 0.07, 20).rotateZ(Math.PI / 2);
    const m = mat({ color: 0xffffff, roughness: 0.4, metalness: 0.55 }, 'shield');
    const pts: { x: number; y: number; z: number; c: number }[] = [];
    for (const side of [-1, 1])
      for (let i = 0; i < 18; i++) {
        const s = 0.22 + (i / 17) * 0.56;
        pts.push({ x: side * (halfBeam(s) + outrigger(s) + 0.05), y: deckY(s) + 0.45, z: zOf(s), c: colors[(i + (side > 0 ? 2 : 0)) % colors.length] });
      }
    const inst = new THREE.InstancedMesh(geo, m, pts.length);
    const M = new THREE.Matrix4();
    pts.forEach((p, i) => {
      M.makeTranslation(p.x, p.y, p.z);
      inst.setMatrixAt(i, M);
      inst.setColorAt(i, new THREE.Color(p.c));
    });
    inst.castShadow = true;
    this.group.add(inst);
  }

  private ramGeometry() {
    // three-finned bronze ram at the waterline + proembolion above
    const z0 = zOf(0) + 0.6,
      z1 = zOf(0) - RAM_LENGTH;
    const body = new THREE.BoxGeometry(1, 1, 1, 1, 1, 6);
    const p = body.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getZ(i) + 0.5; // 0 front .. 1 back
      const w = 0.12 + 0.55 * Math.pow(t, 0.8);
      const h = 0.25 + 0.75 * Math.pow(t, 0.7);
      p.setXYZ(i, p.getX(i) * w, p.getY(i) * h - 0.05, z1 + t * (z0 - z1));
    }
    const parts: THREE.BufferGeometry[] = [body];
    for (const fy of [-0.28, 0.0, 0.28]) {
      const fin = new THREE.BoxGeometry(1, 0.05, 1, 1, 1, 4);
      const q = fin.attributes.position;
      for (let i = 0; i < q.count; i++) {
        const t = q.getZ(i) + 0.5;
        q.setXYZ(i, q.getX(i) * (0.22 + 0.6 * t), q.getY(i) + fy * (0.4 + 0.6 * t) - 0.05, z1 - 0.05 + t * (z0 - z1 - 0.3));
      }
      parts.push(fin);
    }
    const pro = new THREE.ConeGeometry(0.18, 0.9, 8).rotateX(-Math.PI / 2).translate(0, 1.55, zOf(0) - 0.35);
    parts.push(pro);
    body.computeVertexNormals();
    return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => { g.deleteAttribute('uv'); return g; }));
  }

  private curvedPiece(pts: number[][], r0: number, r1: number, m: THREE.Material) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const geo = new THREE.TubeGeometry(curve, 24, 1, 6, false);
    // taper
    const p = geo.attributes.position;
    const segs = 24,
      radial = 6;
    for (let i = 0; i <= segs; i++) {
      const c = curve.getPointAt(i / segs);
      const r = r0 + (r1 - r0) * (i / segs);
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        const v = new THREE.Vector3(p.getX(k), p.getY(k), p.getZ(k)).sub(c).multiplyScalar(r).add(c);
        p.setXYZ(k, v.x, v.y, v.z);
      }
    }
    geo.computeVertexNormals();
    const m2 = new THREE.Mesh(geo, m);
    m2.castShadow = true;
    return m2;
  }

  private addDeckProps(wood: THREE.Material) {
    // amphorae lashed near the mast, coils of rope, a small helmsman's bench
    const clay = mat({ color: 0xa8603a, roughness: 0.85 }, 'clay');
    const amph = new THREE.LatheGeometry(
      [
        [0.0, 0],
        [0.06, 0.02],
        [0.17, 0.2],
        [0.2, 0.45],
        [0.16, 0.65],
        [0.07, 0.75],
        [0.06, 0.9],
        [0.08, 0.93],
      ].map(([x, y]) => new THREE.Vector2(x, y)),
      10,
    );
    const inst = new THREE.InstancedMesh(amph, clay, 8);
    const M = new THREE.Matrix4();
    for (let i = 0; i < 8; i++) {
      const s = 0.47 + (i % 4) * 0.012;
      const x = (i < 4 ? -1 : 1) * 0.7;
      M.makeRotationY(i * 1.3).setPosition(x, deckY(s), zOf(s) + (i % 4) * 0.05);
      inst.setMatrixAt(i, M);
    }
    inst.castShadow = true;
    this.group.add(inst);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.45, 0.5), wood);
    bench.position.set(0, deckY(0.9) + 0.22, zOf(0.905));
    bench.castShadow = true;
    this.group.add(bench);
  }

  private addCrew() {
    // deck crew: marines (epibatai) with bronze helmets, archers, the keleustes and the aulos player
    const skinParts: THREE.BufferGeometry[] = [];
    const clothParts: THREE.BufferGeometry[] = [];
    const legL = new THREE.CylinderGeometry(0.07, 0.06, 0.85, 6).translate(-0.1, 0.43, 0);
    const legR = new THREE.CylinderGeometry(0.07, 0.06, 0.85, 6).translate(0.1, 0.43, 0);
    const armL = new THREE.CylinderGeometry(0.05, 0.045, 0.62, 6).rotateZ(0.12).translate(-0.27, 1.12, 0);
    const armR = new THREE.CylinderGeometry(0.05, 0.045, 0.62, 6).rotateZ(-0.12).translate(0.27, 1.12, 0);
    const neck = new THREE.CylinderGeometry(0.05, 0.06, 0.1, 6).translate(0, 1.5, 0);
    const head = new THREE.SphereGeometry(0.115, 10, 8).scale(1, 1.12, 1.05).translate(0, 1.64, 0.01);
    skinParts.push(legL, legR, armL, armR, neck, head);
    // chiton: flared tunic to the knee, belted torso, shoulders
    const skirt = new THREE.CylinderGeometry(0.19, 0.27, 0.5, 10).translate(0, 0.8, 0);
    const torso = new THREE.CylinderGeometry(0.22, 0.18, 0.55, 10).scale(1, 1, 0.72).translate(0, 1.28, 0);
    const shoulders = new THREE.SphereGeometry(0.22, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.05, 0.45, 0.72).translate(0, 1.44, 0);
    clothParts.push(skirt, torso, shoulders);
    const skinGeo = mergeGeometries(skinParts.map((g) => g.toNonIndexed()));
    const clothGeo = mergeGeometries(clothParts.map((g) => g.toNonIndexed()));
    const helmetGeo = new THREE.SphereGeometry(0.14, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.62).translate(0, 1.66, 0);
    const crestGeo = new THREE.BoxGeometry(0.035, 0.12, 0.34).translate(0, 1.84, -0.02);
    const spots: [number, number, number, boolean][] = [
      // x, s, facing, helmet
      // marines along the rails, archers forward, the keleustes amidships facing the rowers' benches,
      // the aulos player beside him; the view forward from the helm stays clear
      [1.05, 0.5, 1.3, true], [-1.1, 0.53, -1.6, true], [0.95, 0.38, 1.1, true], [-1.0, 0.33, -1.2, true],
      [0.8, 0.2, 0.2, true], [-0.75, 0.17, -0.3, true], [0.2, 0.12, 0.0, false], [0.9, 0.66, 2.2, false],
    ];
    const tunic = [0xe8e0cc, 0x8f2a1c, 0xd8c8a8, 0x3a4a6a, 0xc9b18a, 0xa33a22, 0xe0d6c0, 0x5a6a3a];
    const skinMat = mat({ color: 0xb07a5a, roughness: 0.75 }, 'skin');
    const clothMat = mat({ color: 0xffffff, roughness: 0.9 }, 'cloth');
    const bronze = mat({ color: 0xb8863e, metalness: 0.85, roughness: 0.35 }, 'helm');
    const crest = mat({ color: 0x7a1c14, roughness: 0.9 }, 'crest');
    const n = spots.length;
    const skin = new THREE.InstancedMesh(skinGeo, skinMat, n);
    const cloth = new THREE.InstancedMesh(clothGeo, clothMat, n);
    const helm = new THREE.InstancedMesh(helmetGeo, bronze, n);
    const crests = new THREE.InstancedMesh(crestGeo, crest, n);
    const M = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    spots.forEach(([x, s, face, hasHelm], i) => {
      const sc = 0.95 + ((i * 37) % 10) * 0.012;
      M.makeRotationY(face).scale(new THREE.Vector3(sc, sc, sc)).setPosition(x, deckY(s), zOf(s));
      skin.setMatrixAt(i, M);
      cloth.setMatrixAt(i, M);
      cloth.setColorAt(i, new THREE.Color(tunic[i % tunic.length]));
      helm.setMatrixAt(i, hasHelm ? M : hidden);
      crests.setMatrixAt(i, hasHelm ? M : hidden);
    });
    for (const m of [skin, cloth, helm, crests]) {
      m.castShadow = true;
      this.group.add(m);
    }
  }

  /** per-frame visual update from physics/crew state */
  update(physics: ShipPhysics, crew: Crew, night: number, time: number, alpha = 1) {
    // Only interpolate the same physical joints; no parallel stroke/contact controller.
    for (const slot of this.slots) {
      physics.rowing.renderPose(slot.id, alpha, this.oarPose);
      this.oars[slot.bank].setMatrixAt(this.instanceIds[slot.id], this.oarPose.matrix);
      this.bladeWorld[slot.id].copy(this.oarPose.center).applyMatrix4(this.group.matrixWorld);
      this.bladeIn[slot.id] = physics.rowing.current.contact[slot.id] !== 0;
    }
    for (const mesh of this.oars) mesh.instanceMatrix.needsUpdate = true;

    // sail
    const su = this.sailUniforms;
    const furl = 1 - physics.sailSet;
    su.uFurl.value = furl;
    su.uBillow.value += (physics.sailPressure - su.uBillow.value) * 0.05;
    su.uFlutter.value = (1 - Math.min(1, Math.abs(physics.sailPressure) * 3)) * (1 - furl) * 0.8;
    this.yard.rotation.y = physics.yardAngle;

    // steering oars twist with the rudder angle
    for (const s of this.steer) {
      const base = (s as any).baseQuat as THREE.Quaternion;
      s.quaternion.copy(base).multiply(this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), physics.rudderAngle));
    }

    // lantern
    const flicker = 0.85 + 0.15 * Math.sin(time * 13.1) * Math.sin(time * 7.3 + 1.1);
    this.lantern.intensity = night * 14 * flicker;
    this.lanternMat.emissiveIntensity = 0.3 + night * 5 * flicker;
  }
}
