import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, shared } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { makeSailTexture, makeEyeTexture } from '../gfx/textures';
import type { SurfaceMaps } from '../gfx/assets';
import { halfBeam, keelDepth, sheer, section, zOf, deckY, DECK_S0, DECK_S1, HULL_LENGTH, RAM_LENGTH } from './hull';
import { OAR_BANKS, type OarSlot } from './oarLayout';
import { createKinematics, evaluateOar, nominalDip } from './rowing';
import { buildOarGeometry } from './oarGeometry';
import { Crew } from './crew';
import type { ModelKit } from '../gfx/models';
import type { ShipPhysics } from './physics';
import type { ShipVisual } from './shipVisual';
import { SAIL_RIG } from './sailGeometry';

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
export class Trireme implements ShipVisual {
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
  /** world-space blade frame as drawn: loom axis (outboard), width axis, face normal */
  readonly bladeAxis: THREE.Vector3[] = [];
  readonly bladeWidthAxis: THREE.Vector3[] = [];
  readonly bladeNormal: THREE.Vector3[] = [];
  readonly bladeIn: boolean[] = [];
  /** per instance: wet line (m from the thole), soak, film gloss, load bend (m) */
  private oarFx: THREE.InstancedBufferAttribute[] = [];
  private lastTime = 0;
  readonly mastTop = new THREE.Vector3();
  /** 0 run out .. 1 shipped (drawn inboard), per side [port, starboard]; animated toward oarStowTarget */
  readonly oarStow = [0, 0];
  readonly oarStowTarget = [0, 0];
  private stowJoint = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };

  /** Read-back of the actual rendered rig for opt-in browser acceptance scenes. */
  sailingVisualState() {
    return {
      deployment: 1 - this.sailUniforms.uFurl.value,
      pressure: this.sailUniforms.uBillow.value,
      flutter: this.sailUniforms.uFlutter.value,
      yardAngle: this.yard.rotation.y,
      width: SAIL_RIG.width,
      fullHeight: SAIL_RIG.height,
      visible: this.sailMesh.visible,
    };
  }

  constructor(planks: SurfaceMaps, slots: readonly OarSlot[], models: ModelKit) {
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
    const oarMat = this.oarMaterial(hullMaps);
    for (let bank = 0; bank < OAR_BANKS.length; bank++) {
      const bankSlots = slots.filter(slot => slot.bank === bank);
      const geo = buildOarGeometry(bankSlots[0]);
      const fx = new THREE.InstancedBufferAttribute(new Float32Array(bankSlots.length * 4), 4);
      fx.setUsage(THREE.DynamicDrawUsage);
      for (let k = 0; k < bankSlots.length; k++) fx.setX(k, 99);
      geo.setAttribute('oarFx', fx);
      this.oarFx.push(fx);
      const mesh = new THREE.InstancedMesh(geo, oarMat, bankSlots.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.layers.enable(LAYER_REFRACT);
      bankSlots.forEach((slot, index) => { this.instanceIds[slot.id] = index; });
      this.oars.push(mesh); g.add(mesh);
    }
    for (const slot of slots) {
      this.bladeWorld.push(new THREE.Vector3()); this.bladeIn.push(false);
      this.bladeAxis.push(new THREE.Vector3(slot.side, 0, 0)); this.bladeWidthAxis.push(new THREE.Vector3(0, 1, 0)); this.bladeNormal.push(new THREE.Vector3(0, 0, 1));
    }

    // ---------- mast, yard, sail ----------
    const sm = SAIL_RIG.mastStation;
    const mastZ = zOf(sm);
    const mastBase = deckY(sm);
    const mastH = SAIL_RIG.mastHeight;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.2, mastH, 10), woodDark);
    mast.position.set(0, mastBase + mastH / 2, mastZ);
    mast.castShadow = true;
    g.add(mast);
    this.mastTop.set(0, mastBase + mastH, mastZ);
    this.yard = new THREE.Group();
    this.yard.position.set(0, mastBase + mastH - SAIL_RIG.yardDrop, mastZ);
    g.add(this.yard);
    const yardMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, SAIL_RIG.yardLength, 8).rotateZ(Math.PI / 2), woodDark);
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
             // The cloth spans the shared rig width and deploys downward from the yard.
             float u = transformed.x / ${ (SAIL_RIG.width / 2).toFixed(1) };
             float v = -transformed.y / ${ SAIL_RIG.height.toFixed(1) }; // 0 top .. 1 foot
             float h = ${ SAIL_RIG.height.toFixed(1) } * (1.0 - uFurl);
             transformed.y = -v * h;
             float belly = (1.0 - u * u) * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
             float flap = sin(transformed.x * 1.3 + uTime * 7.0 + v * 4.0) * sin(v * 3.14159) * uFlutter;
             transformed.z += (uBillow * 1.6 * belly) * (1.0 - uFurl) + flap * 0.35;
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
               float u = position.x / ${ (SAIL_RIG.width / 2).toFixed(1) }; float v = -position.y / ${ SAIL_RIG.height.toFixed(1) };
               float dbdu = -2.0 * u * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
               objectNormal = normalize(vec3(-uBillow * 1.6 * dbdu / ${ (SAIL_RIG.width / 2).toFixed(1) } * (1.0 - uFurl), 0.0, 1.0));
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
    const sailGeo = new THREE.PlaneGeometry(SAIL_RIG.width, SAIL_RIG.height, 24, 18).translate(0, -SAIL_RIG.height / 2, 0);
    this.sailMesh = new THREE.Mesh(sailGeo, sailMat);
    this.sailMesh.position.set(0, -SAIL_RIG.clothTopDrop, SAIL_RIG.clothOffsetZ);
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
    this.addCrew(models);

    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = true;
    });
  }

  /**
   * Oar wood with the same grain as the hull, plus two effects driven per instance: the loom bows under
   * the blade's actual load (the blade itself stays where the physics has it), and wood the sea reached
   * is darker and glossy, the film draining within a second or two and the soak lasting longer.
   */
  private oarMaterial(maps: THREE.Texture[]) {
    const m = new THREE.MeshStandardMaterial({ map: maps[0], normalMap: maps[1], normalScale: new THREE.Vector2(0.25, 0.25), color: 0xffe6c8, roughness: 0.62, vertexColors: true });
    return patchMaterial(m, (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 oarFx; attribute float bend;
          varying vec4 vOarFx; varying float vLoomX;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.z += oarFx.w * bend;
          vOarFx = oarFx; vLoomX = position.x;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec4 vOarFx; varying float vLoomX;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // ragged wet line: water creeps up the grain unevenly
          float wl = vOarFx.x + 0.025 * sin(vLoomX * 37.0 + vNormal.y * 5.0);
          float oarWet = smoothstep(wl - 0.02, wl + 0.02, vLoomX);
          diffuseColor.rgb *= mix(1.0, 0.52, oarWet * vOarFx.y);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.14, oarWet * vOarFx.z);`);
    }, 'oar');
  }

  /** written by the oar-water system each frame */
  setOarWet(id: number, wetLine: number, soak: number, film: number) {
    const slot = this.slots[id];
    const a = this.oarFx[slot.bank], k = this.instanceIds[id];
    a.setXYZ(k, wetLine, soak, film);
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

  private addCrew(models: ModelKit) {
    // deck crew from the kit: marines along the rails with their helmets facing outboard, archers at the bow
    // facing forward, a sailor on the centreline and the keleustes amidships calling the stroke to the helm
    // (model -z is facing, so yaw -pi/2 faces +x (starboard) and +pi/2 faces -x (port))
    const spots: [string, number, number, number][] = [
      ['fig_marine', 1.05, 0.5, -Math.PI / 2],
      ['fig_marine', -1.1, 0.53, Math.PI / 2],
      ['fig_marine', 0.95, 0.38, -Math.PI / 2],
      ['fig_marine', -1.0, 0.33, Math.PI / 2],
      ['fig_archer', 0.8, 0.2, 0],
      ['fig_archer', -0.75, 0.17, 0],
      ['fig_sailor_idle', 0.2, 0.12, 0],
      ['fig_keleustes', 0.9, 0.66, Math.PI],
    ];
    for (const [name, x, s, yaw] of spots) {
      const fig = models.get(name);
      fig.position.set(x, deckY(s), zOf(s));
      fig.rotation.y = yaw;
      this.group.add(fig);
    }
  }

  /** per-frame visual update from physics/crew state */
  update(physics: ShipPhysics, crew: Crew, night: number, time: number, alpha = 1) {
    // Only interpolate the same physical joints; no parallel stroke/contact controller.
    // shipping oars: the crew draws each loom inboard through its port, rippling from bow to stern
    const dtv = this.lastTime > 0 ? Math.min(0.1, Math.max(0, time - this.lastTime)) : 0;
    this.lastTime = time;
    for (let i = 0; i < 2; i++) this.oarStow[i] += Math.max(-dtv * 0.45, Math.min(dtv * 0.45, this.oarStowTarget[i] - this.oarStow[i]));
    for (const slot of this.slots) {
      physics.rowing.renderPose(slot.id, alpha, this.oarPose);
      const st = this.oarStow[slot.side < 0 ? 0 : 1];
      if (st > 0) {
        // boated: from the rest pose each oar swings aft and levels off, lying fore-and-aft along
        // the outrigger, clear of a quay alongside
        const lag = (slot.z + HULL_LENGTH / 2) / HULL_LENGTH;
        const k = smooth(0, 1, st * 1.6 - lag * 0.6);
        const j = this.stowJoint;
        const dip0 = nominalDip(slot, false);
        j.sweep = 0.07 + (-1.48 - 0.07) * k;
        j.dip = dip0 + (0.04 - dip0) * k;
        j.feather = Math.PI / 2;
        evaluateOar(slot, j, this.oarPose);
      }
      this.oars[slot.bank].setMatrixAt(this.instanceIds[slot.id], this.oarPose.matrix);
      const id = slot.id;
      this.bladeWorld[id].copy(this.oarPose.center).applyMatrix4(this.group.matrixWorld);
      this.bladeAxis[id].copy(this.oarPose.axis).applyQuaternion(this.group.quaternion);
      this.bladeWidthAxis[id].copy(this.oarPose.widthAxis).applyQuaternion(this.group.quaternion);
      const n = this.bladeNormal[id].copy(this.oarPose.normal).applyQuaternion(this.group.quaternion);
      this.bladeIn[id] = physics.rowing.current.contact[id] !== 0;
      // loom bend: the middle of the loom bows back against the water's push on the blade
      // (~5 cm at a hard drive's blade load; a stiff ash/fir loom of this length)
      const o = id * 3, pf = physics.rowing.previous.forceWorld, cf = physics.rowing.current.forceWorld;
      const fx = pf[o] + (cf[o] - pf[o]) * alpha, fy = pf[o + 1] + (cf[o + 1] - pf[o + 1]) * alpha, fz = pf[o + 2] + (cf[o + 2] - pf[o + 2]) * alpha;
      const fn = fx * n.x + fy * n.y + fz * n.z;
      this.oarFx[slot.bank].setW(this.instanceIds[id], Math.max(-0.08, Math.min(0.08, -fn * 2.2e-4)));
    }
    for (const mesh of this.oars) mesh.instanceMatrix.needsUpdate = true;
    for (const a of this.oarFx) a.needsUpdate = true;

    // Sail cloth follows the same fixed-step state interpolation as the rigid body.
    // Its billow is a visual approximation of planar aerodynamic loading, not a cloth solver.
    const sail = physics.sailing;
    const su = this.sailUniforms;
    const lerp = THREE.MathUtils.lerp;
    const deployment = lerp(sail.previous.deployment, sail.current.deployment, alpha);
    su.uFurl.value = 1 - deployment;
    su.uBillow.value = lerp(sail.previous.pressure, sail.current.pressure, alpha);
    su.uFlutter.value = lerp(sail.previous.flutter, sail.current.flutter, alpha);
    this.yard.rotation.y = lerp(sail.previous.yardAngle, sail.current.yardAngle, alpha);

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
