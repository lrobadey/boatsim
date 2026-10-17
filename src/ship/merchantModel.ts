import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial, shared } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { makeSailTexture } from '../gfx/textures';
import type { SurfaceMaps } from '../gfx/assets';
import type { OarSlot } from './oarLayout';
import { createKinematics, evaluateOar, nominalDip } from './rowing';
import { buildOarGeometry } from './oarGeometry';
import type { Crew } from './crew';
import type { ModelKit } from '../gfx/models';
import type { ShipPhysics } from './physics';
import type { ShipVisual } from './shipVisual';
import { WindTells } from './windTells';
import type { ShipDesign } from './design';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** a grating swings up 80 degrees in 1.5 s when the hatches open */
const HATCH_ANGLE = (80 * Math.PI) / 180;
const HATCH_TIME = 1.5;

const mat = (p: THREE.MeshStandardMaterialParameters, key = '') => patchMaterial(new THREE.MeshStandardMaterial(p), undefined, key);

/**
 * The visual Kyrenia-type merchant ship, built procedurally from the ship design so that what is drawn
 * matches the physics hull. Same contract as the trireme model (see shipVisual.ts).
 */
export class MerchantModel implements ShipVisual {
  readonly group = new THREE.Group();
  /** Hull, deck, cap rails and posts only; moving and interactive parts stay game-owned. */
  readonly staticShell = new THREE.Group();
  private authoredShell: THREE.Object3D | null = null;
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
  private tmpQ = new THREE.Quaternion();
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
  private windTells: WindTells;
  /** 0 run out .. 1 shipped (drawn inboard), per side [port, starboard]; animated toward oarStowTarget */
  readonly oarStow = [0, 0];
  readonly oarStowTarget = [0, 0];
  private stowJoint = { sweep: 0, dip: 0, feather: 0, dSweep: 0, dDip: 0, dFeather: 0 };
  /** hatch openings, ship local (merchant with a cargo hold only) */
  readonly hatchRects: { s0: number; s1: number; halfWidth: number; z0: number; z1: number; deckY: number }[] = [];
  /** one pivot per grating, on its starboard edge; rotation.z swings it up */
  private hatchPivots: THREE.Group[] = [];
  private hatchT = 0;
  private hatchTarget = 0;

  /** Read-back of the actual rendered rig for opt-in browser acceptance scenes. */
  sailingVisualState() {
    return {
      deployment: 1 - this.sailUniforms.uFurl.value,
      pressure: this.sailUniforms.uBillow.value,
      flutter: this.sailUniforms.uFlutter.value,
      yardAngle: this.yard.rotation.y,
      width: this.design.rig.width,
      fullHeight: this.design.rig.height,
      visible: this.sailMesh.visible,
    };
  }

  constructor(planks: SurfaceMaps, slots: readonly OarSlot[], models: ModelKit, readonly design: ShipDesign) {
    const hull = design.hull, deck = design.deck, rig = design.rig;
    const g = this.group;
    g.add(this.staticShell);
    // The scan's grain runs vertically. Hull UVs run lengthwise in U; deck UVs run lengthwise in V.
    const hullMaps = [planks.color, planks.normal, planks.roughness].map((source) => {
      const tex = source.clone();
      tex.center.set(0.5, 0.5);
      tex.rotation = Math.PI / 2;
      tex.needsUpdate = true;
      return tex;
    });

    // ---------- hull ----------
    const hullMat = mat({ map: hullMaps[0], normalMap: hullMaps[1], roughnessMap: hullMaps[2], normalScale: new THREE.Vector2(0.4, 0.4), vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }, 'hull_merchant');
    const hullMesh = new THREE.Mesh(this.hullGeometry(), hullMat);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    hullMesh.layers.enable(LAYER_REFRACT);
    this.staticShell.add(hullMesh);

    // ---------- deck ----------
    const deckMat = mat({ map: planks.color, normalMap: planks.normal, roughnessMap: planks.roughness, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 1, color: new THREE.Color().setRGB(1.25, 1.14, 1.02) }, 'deck_merchant');
    const deckMesh = new THREE.Mesh(this.deckGeometry(), deckMat);
    deckMesh.receiveShadow = true;
    deckMesh.castShadow = true;
    this.staticShell.add(deckMesh);

    // wood and rope are shared by the rails, stem, sternpost and rigging below
    const woodDark = mat({ color: 0x6e4c32, roughness: 0.7 }, 'wooddark');
    const ropeMat = mat({ color: 0x6b5a40, roughness: 0.95 }, 'rope');

    // ---------- cap rails ----------
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 24; i++) {
        const s = 0.02 + i * 0.04;
        pts.push(new THREE.Vector3(side * hull.halfBeam(s), hull.sheer(s) + 0.03, hull.zOf(s)));
      }
      const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.045, 6, false), woodDark);
      rail.castShadow = true;
      this.staticShell.add(rail);
    }

    // ---------- stem & sternpost ----------
    this.staticShell.add(
      this.curvedPiece(
        [
          [0, -hull.keelDepth(0.02), hull.zOf(0.02)],
          [0, hull.sheer(0) * 0.5, hull.zOf(0) - 0.12],
          [0, hull.sheer(0) + 0.1, hull.zOf(0) - hull.bowOverhang],
          [0, hull.sheer(0) + 0.45, hull.zOf(0) - hull.bowOverhang - 0.05],
        ],
        0.1,
        0.06,
        woodDark,
      ),
    );
    this.staticShell.add(
      this.curvedPiece(
        [
          [0, -hull.keelDepth(0.97), hull.zOf(0.97)],
          [0, hull.sheer(1) * 0.6, hull.zOf(1) + 0.1],
          [0, hull.sheer(1) + 0.2, hull.zOf(1) + hull.sternOverhang],
          [0, hull.sheer(1) + 0.9, hull.zOf(1) + hull.sternOverhang - 0.1],
          [0, hull.sheer(1) + 1.3, hull.zOf(1) + hull.sternOverhang - 0.45],
        ],
        0.1,
        0.05,
        woodDark,
      ),
    );

    // ---------- oars (sweeps) ----------
    this.slots = slots;
    this.instanceIds = new Int16Array(slots.length);
    const oarMat = this.oarMaterial(hullMaps);
    for (let bank = 0; bank < design.oars.bankCount; bank++) {
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
    const mastZ = rig.yardZ;
    const mastBase = rig.mastBaseY;
    const mastH = rig.mastHeight;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, mastH + 0.4, 10), woodDark);
    mast.position.set(0, mastBase + mastH / 2 - 0.2, mastZ);
    mast.castShadow = true;
    g.add(mast);
    this.mastTop.set(0, mastBase + mastH, mastZ);
    this.yard = new THREE.Group();
    this.yard.position.set(0, rig.yardY, mastZ);
    g.add(this.yard);
    const yardMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, rig.yardLength, 8).rotateZ(Math.PI / 2), woodDark);
    yardMesh.castShadow = true;
    this.yard.add(yardMesh);
    const sailTex = makeSailTexture();
    const sailMat = new THREE.MeshStandardMaterial({ map: sailTex, side: THREE.DoubleSide, roughness: 0.9 });
    const sailDeformation = `vec3 transformed = vec3(position);
             // The cloth spans the shared rig width and deploys downward from the yard.
             float u = transformed.x / ${ (rig.width / 2).toFixed(1) };
             float v = -transformed.y / ${ rig.height.toFixed(1) }; // 0 top .. 1 foot
             float h = ${ rig.height.toFixed(1) } * (1.0 - uFurl);
             transformed.y = -v * h;
             float belly = (1.0 - u * u) * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
             float flap = sin(transformed.x * 1.3 + uTime * 7.0 + v * 4.0) * sin(v * 3.14159) * uFlutter;
             transformed.z += (uBillow * 1.6 * belly) * (1.0 - uFurl) + flap * 0.35;
             // folds when brailed
             // brailed-up cloth: a rounded bundle under the yard with irregular folds
             transformed.z += uFurl * (0.28 * sin(3.14159 * v) + sin(v * 40.0 + u * 3.0) * 0.08) * (1.0 - 0.3 * u * u);
             transformed.y -= uFurl * 0.08 * sin(u * 9.0) * v;`;
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
            sailDeformation + '\n vSailShade = belly;',
          )
          .replace(
            '#include <beginnormal_vertex>',
            `#include <beginnormal_vertex>
             {
               float u = position.x / ${ (rig.width / 2).toFixed(1) }; float v = -position.y / ${ rig.height.toFixed(1) };
               float dbdu = -2.0 * u * sin(3.14159 * clamp(v * 0.85 + 0.1, 0.0, 1.0));
               objectNormal = normalize(vec3(-uBillow * 1.6 * dbdu / ${ (rig.width / 2).toFixed(1) } * (1.0 - uFurl), 0.0, 1.0));
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
      'sail_merchant',
    );
    const sailGeo = new THREE.PlaneGeometry(rig.width, rig.height, 24, 18).translate(0, -rig.height / 2, 0);
    this.sailMesh = new THREE.Mesh(sailGeo, sailMat);
    this.sailMesh.position.set(0, -rig.clothTopDrop, rig.clothOffsetZ);
    // The shadow silhouette must furl and billow with the visible cloth.
    for (const depth of [new THREE.MeshDepthMaterial({depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide}), new THREE.MeshDistanceMaterial({side: THREE.DoubleSide})]) {
      depth.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.sailUniforms, {uTime: shared.uTime});
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uBillow; uniform float uFurl; uniform float uFlutter; uniform float uTime;')
          .replace('#include <begin_vertex>', sailDeformation);
      };
      depth.customProgramCacheKey = () => 'merchant-sail-shadow-' + rig.width + '-' + rig.height;
      if (depth instanceof THREE.MeshDepthMaterial) this.sailMesh.customDepthMaterial = depth;
      else this.sailMesh.customDistanceMaterial = depth;
    }
    this.sailMesh.castShadow = true;
    this.sailMesh.frustumCulled = false;
    this.yard.add(this.sailMesh);
    this.windTells = new WindTells(g, this.mastTop, this.sailMesh, rig.width, rig.height);

    // ---------- rigging ----------
    const top = new THREE.Vector3(0, mastBase + mastH - 0.2, mastZ);
    const rope = (a: THREE.Vector3, b: THREE.Vector3, r = 0.018) => {
      const d = b.clone().sub(a);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 4), ropeMat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      g.add(m);
    };
    rope(top, new THREE.Vector3(0, hull.sheer(0.03) + 0.2, hull.zOf(0.03)));
    rope(top, new THREE.Vector3(0, deck.deckY(0.9) + 0.3, hull.zOf(0.9)));
    for (const side of [-1, 1]) {
      for (const s of [0.36, 0.46]) rope(top, new THREE.Vector3(side * hull.halfBeam(s), hull.sheer(s), hull.zOf(s)), 0.014);
    }

    // ---------- quarter rudders ----------
    const steerMat = mat({ color: 0x5a3d25, roughness: 0.7 }, 'steer');
    const r = design.rudder;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Vector3(side * (hull.halfBeam(r.s) + 0.15), hull.sheer(r.s) - 0.1, hull.zOf(r.s) - 0.3);
      const bladeC = new THREE.Vector3(side * (hull.halfBeam(r.s) + r.xOut), r.y, hull.zOf(r.s) + r.dz);
      const dir = bladeC.clone().sub(pivot);
      const len = dir.length();
      dir.normalize();
      const grp = new THREE.Group();
      grp.position.copy(pivot);
      grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const shaftM = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.075, len + 1.4, 8).translate(0, -(len + 1.4) / 2 + 1.4, 0), steerMat);
      const bladeM = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.4).translate(0, -len, 0.1), steerMat);
      const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.0, 6).rotateX(Math.PI / 2).translate(0, 1.3, -0.45), steerMat);
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
    const lanternPos = new THREE.Vector3(0, deck.deckY(0.93) + 1.4, hull.zOf(0.93));
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 8), this.lanternMat);
    lamp.position.copy(lanternPos);
    g.add(lamp);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), woodDark);
    post.position.copy(lanternPos).add(new THREE.Vector3(0, -0.75, 0));
    g.add(post);
    this.lantern = new THREE.PointLight(0xff9a40, 0, 30, 1.6);
    this.lantern.position.copy(lanternPos);
    g.add(this.lantern);

    // ---------- cargo hold: hatches, gratings, hold floor (cargo-trade spec §7.1) ----------
    if (design.cargo) this.buildHatchesAndHold(g, planks, woodDark);

    // ---------- crew ----------
    // (model -z is facing, so yaw -pi/2 faces +x (starboard) and +pi/2 faces -x (port))
    // crew ships: the animated rowers (CrewAnimator, owned by game.ts) replace these static stand-ins
    for (const [name, x, s, yaw] of design.oars.system === 'crew' ? [] : design.crewSpots) {
      const fig = models.get(name);
      fig.position.set(x, deck.deckY(s), hull.zOf(s));
      fig.rotation.y = yaw;
      g.add(fig);
    }

    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).receiveShadow = true;
    });
  }

  /** Change linen maps while retaining the existing furl, billow and wind-tell shader. */
  setSailSurface(surface: SurfaceMaps) {
    // Quiet thin linen: avoid self-shadow interference while retaining its animated cast shadow.
    this.sailMesh.receiveShadow = false;
    const material = this.sailMesh.material as THREE.MeshStandardMaterial;
    material.map = surface.color;
    material.normalMap = surface.normal;
    material.roughnessMap = surface.roughness;
    material.normalScale.set(0.12, 0.12);
    material.needsUpdate = true;
  }

  /** Install a metre-scale, Y-up shell at the design waterline. No physics or joint state changes.
   * Caller owns imported resources and must apply the game's material patch before installation.
   * Passing null restores the original procedural shell without reloading the vessel.
   */
  setAuthoredShell(shell: THREE.Object3D | null) {
    if (this.authoredShell) this.group.remove(this.authoredShell);
    this.authoredShell = shell;
    this.staticShell.visible = !shell;
    if (shell) {
      shell.traverse(o => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = o.receiveShadow = true;
          o.layers.enable(LAYER_REFRACT);
        }
      });
      this.group.add(shell);
    }
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

  private hullGeometry() {
    const hull = this.design.hull;
    const NS = 72,
      NG = 20;
    const pos: number[] = [],
      uv: number[] = [],
      col: number[] = [],
      idx: number[] = [];
    const p = { x: 0, y: 0 };
    const row = 2 * NG + 1;
    for (let i = 0; i <= NS; i++) {
      const s = 0.5 - 0.5 * Math.cos((Math.PI * i) / NS);
      const z = hull.zOf(s);
      const S = hull.sheer(s);
      // arc length along the girth for UVs
      let arc = 0;
      let px = 0,
        py = -hull.keelDepth(s);
      const arcs: number[] = [];
      for (let j = 0; j <= NG; j++) {
        hull.section(s, j / NG, p);
        arc += Math.hypot(p.x - px, p.y - py);
        px = p.x;
        py = p.y;
        arcs.push(arc);
      }
      for (let k = 0; k < row; k++) {
        const j = Math.abs(k - NG);
        const side = k < NG ? -1 : 1;
        hull.section(s, j / NG, p);
        pos.push(side * p.x, p.y, z);
        uv.push(z / 8, (side * arcs[j]) / 3.2 + 0.5);
        // paint scheme: pitch below the waterline, dark wale, red ochre line, oiled planking
        let c: [number, number, number];
        const y = p.y;
        if (y < 0.12) c = [0.09, 0.075, 0.065];
        else if (y > S - 0.38 && y < S - 0.24) c = [0.42, 0.27, 0.16];
        else if (y > S - 0.12 && y < S - 0.06) c = [0.75, 0.2, 0.1];
        else c = [1.02, 0.86, 0.68];
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

  /**
   * Deck planking: per station row three bands across the beam (outboard of the hatch edge, the centre
   * band, and outboard on the other side), station rows inserted at each hatch's s0 and s1, and the centre
   * band left out between them. Without hatches it is the plain deck.
   */
  private deckGeometry() {
    const hull = this.design.hull, deck = this.design.deck, cargo = this.design.cargo;
    const hatches = cargo?.hatches ?? [];
    const HW = cargo?.hatchHalfWidth ?? 0;
    const NS = 60;
    const stations: number[] = [];
    for (let i = 0; i <= NS; i++) stations.push(deck.s0 + ((deck.s1 - deck.s0) * i) / NS);
    for (const h of hatches) stations.push(h.s0, h.s1);
    stations.sort((x, y) => x - y);
    const rows = stations.filter((v, i) => i === 0 || v - stations[i - 1] > 1e-9);
    const pos: number[] = [],
      uv: number[] = [],
      idx: number[] = [];
    // four x positions per row: -w, -xb, xb, w, with xb the hatch edge (or the beam where the hull is narrower)
    for (const s of rows) {
      const y = deck.deckY(s);
      const w = hull.halfWidthAt(s, y);
      const z = hull.zOf(s);
      const xb = Math.min(HW, w);
      for (const x of [-w, -xb, xb, w]) {
        pos.push(x, y, z);
        uv.push(x / 3, z / 3);
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a0 = rows[i], a1 = rows[i + 1];
      const inHatch = hatches.some((h) => a0 >= h.s0 - 1e-9 && a1 <= h.s1 + 1e-9);
      const bands = inHatch ? [0, 2] : [0, 1, 2];
      for (const k of bands) {
        const A = i * 4 + k, B = A + 1, C = A + 4, D = C + 1;
        idx.push(A, C, B, B, C, D);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /**
   * Coaming lips inside each hatch rectangle, the gratings (one mesh each, 0.05 m bars at 0.16 m pitch,
   * top flush with the deck) on pivots at their starboard edge, and the hold's floor of ceiling planks.
   */
  private buildHatchesAndHold(g: THREE.Group, planks: SurfaceMaps, woodDark: THREE.Material) {
    const hull = this.design.hull, deck = this.design.deck, cargo = this.design.cargo!;
    const HW = cargo.hatchHalfWidth, LIP_H = cargo.lip, LIP_W = 0.06, SEG = 10;
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const lips: THREE.BufferGeometry[] = [];
    for (const h of cargo.hatches) {
      const zA = hull.zOf(h.s0), zB = hull.zOf(h.s1), dir = Math.sign(zB - zA);
      for (const sx of [-1, 1]) {
        for (let i = 0; i < SEG; i++) {
          const sa = h.s0 + ((h.s1 - h.s0) * i) / SEG, sb = h.s0 + ((h.s1 - h.s0) * (i + 1)) / SEG;
          const za = hull.zOf(sa), zb = hull.zOf(sb);
          lips.push(box(LIP_W, LIP_H, Math.abs(zb - za), sx * (HW - LIP_W / 2), deck.deckY((sa + sb) / 2) + LIP_H / 2, (za + zb) / 2));
        }
      }
      // end lips sit inside the rectangle, at s0 and s1
      lips.push(box(2 * (HW - LIP_W), LIP_H, LIP_W, 0, deck.deckY(h.s0) + LIP_H / 2, zA + (dir * LIP_W) / 2));
      lips.push(box(2 * (HW - LIP_W), LIP_H, LIP_W, 0, deck.deckY(h.s1) + LIP_H / 2, zB - (dir * LIP_W) / 2));
    }
    const lipMesh = new THREE.Mesh(mergeGeometries(lips, false), woodDark);
    lipMesh.castShadow = true;
    g.add(lipMesh);

    for (const h of cargo.hatches) {
      const zA = hull.zOf(h.s0), zB = hull.zOf(h.s1);
      const zLo = Math.min(zA, zB), zHi = Math.max(zA, zB), zMid = (zLo + zHi) / 2, L = zHi - zLo;
      const sMid = (h.s0 + h.s1) / 2;
      const yPivot = deck.deckY(sMid);
      // local to the pivot (x = 0 at the starboard edge, the grating lies inboard, along -x)
      const bars: THREE.BufferGeometry[] = [];
      const nAcross = Math.max(1, Math.round(L / 0.16));
      for (let k = 0; k < nAcross; k++) {
        const z = zLo + ((k + 0.5) * L) / nAcross;
        bars.push(box(2 * HW, 0.05, 0.05, -HW, deck.deckY(hull.sOf(z)) - 0.025 - yPivot, z - zMid));
      }
      const nAlong = Math.max(1, Math.round((2 * HW) / 0.16));
      for (let j = 0; j < nAlong; j++) {
        const x = -HW + ((j + 0.5) * 2 * HW) / nAlong;
        bars.push(box(0.05, 0.05, L, x - HW, deck.deckY(sMid) - 0.025 - yPivot, 0));
      }
      const grating = new THREE.Mesh(mergeGeometries(bars, false), woodDark);
      grating.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.set(HW, yPivot, zMid);
      pivot.add(grating);
      g.add(pivot);
      this.hatchPivots.push(pivot);
      this.hatchRects.push({ s0: h.s0, s1: h.s1, halfWidth: HW, z0: zLo, z1: zHi, deckY: yPivot });
    }

    // hold floor: ceiling planks at floorY(s) across the hold's width, the deck planks darkened to 0.55
    const holdMat = mat(
      { map: planks.color, normalMap: planks.normal, roughnessMap: planks.roughness, normalScale: new THREE.Vector2(0.45, 0.45), roughness: 1, color: new THREE.Color().setRGB(1.25, 1.14, 1.02).multiplyScalar(0.55) },
      'deck_hold',
    );
    const NS = 16, NX = 4;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const h = cargo.hold;
    for (let i = 0; i <= NS; i++) {
      const s = h.sFrom + ((h.sTo - h.sFrom) * i) / NS;
      const y = -hull.keelDepth(s) + h.floorAboveKeel;
      const w = hull.halfWidthAt(s, y);
      const z = hull.zOf(s);
      for (let k = 0; k <= NX; k++) {
        const x = -w + (2 * w * k) / NX;
        pos.push(x, y, z);
        uv.push(x / 3, z / 3);
      }
    }
    for (let i = 0; i < NS; i++)
      for (let k = 0; k < NX; k++) {
        const A = i * (NX + 1) + k, B = A + 1, C = A + NX + 1, D = C + 1;
        idx.push(A, C, B, B, C, D);
      }
    const floorGeo = new THREE.BufferGeometry();
    floorGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    floorGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    floorGeo.setIndex(idx);
    floorGeo.computeVertexNormals();
    const floor = new THREE.Mesh(floorGeo, holdMat);
    floor.receiveShadow = true;
    g.add(floor);
  }

  /** gratings: true swings them up to stand against the outboard side of their coamings, false lays them back */
  setHatchesOpen(open: boolean) {
    this.hatchTarget = open ? 1 : 0;
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

  /** per-frame visual update from physics/crew state */
  update(physics: ShipPhysics, crew: Crew, night: number, time: number, alpha = 1) {
    // Only interpolate the same physical joints; no parallel stroke/contact controller.
    // shipping oars: the crew draws each loom inboard through its port, rippling from bow to stern
    const dtv = this.lastTime > 0 ? Math.min(0.1, Math.max(0, time - this.lastTime)) : 0;
    this.lastTime = time;
    for (let i = 0; i < 2; i++) this.oarStow[i] += Math.max(-dtv * 0.45, Math.min(dtv * 0.45, this.oarStowTarget[i] - this.oarStow[i]));
    const L = this.design.hull.length;
    for (const slot of this.slots) {
      physics.rowing.renderPose(slot.id, alpha, this.oarPose);
      // a crew system ships its oars physically (the rowers hold them); only scripted banks stow here
      const st = this.design.oars.system === 'crew' ? 0 : this.oarStow[slot.side < 0 ? 0 : 1];
      if (st > 0) {
        // boated: from the rest pose each oar swings aft and levels off, lying fore-and-aft along
        // the outrigger, clear of a quay alongside
        const lag = (slot.z + L / 2) / L;
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
    this.windTells.update(physics, time, deployment, su.uBillow.value, su.uFlutter.value);

    // steering oars twist with the rudder angle
    for (const s of this.steer) {
      const base = (s as any).baseQuat as THREE.Quaternion;
      s.quaternion.copy(base).multiply(this.tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), physics.rudderAngle));
    }

    // hatch gratings swing over HATCH_TIME
    if (this.hatchPivots.length) {
      const step = dtv / HATCH_TIME;
      this.hatchT += Math.max(-step, Math.min(step, this.hatchTarget - this.hatchT));
      for (const p of this.hatchPivots) p.rotation.z = -HATCH_ANGLE * smooth(0, 1, this.hatchT);
    }

    // lantern
    const flicker = 0.85 + 0.15 * Math.sin(time * 13.1) * Math.sin(time * 7.3 + 1.1);
    this.lantern.intensity = night * 14 * flicker;
    this.lanternMat.emissiveIntensity = 0.3 + night * 5 * flicker;
  }
}
