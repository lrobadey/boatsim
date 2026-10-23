import * as THREE from 'three';
import { patchMaterial } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { createKinematics } from '../ship/rowing';
import type { ShipPhysics } from '../ship/physics';
import type { ShipVisual } from '../ship/shipVisual';
import type { Crew } from '../ship/crew';
import type { SailingSystem } from '../ship/sailing';
import type { SailRig } from '../ship/design';
import { buildPaddleVariant, disposePaddleVariant } from './paddleVariantModel';
import { PADDLE_VARIANTS, type PaddleVariantId } from './paddleVariants';
import { TwinPaddles } from './twinPaddles';

/** Single-surface exterior materials: awnings, leaves and throws need shadows from both faces. */
const THIN_SHEETS = /linen|foliage|olive|textile/i;

/** Authored pass-five exterior with solver-driven oars, two sails and quarter rudders. */
export class ThalassaModel implements ShipVisual {
  readonly group = new THREE.Group();
  readonly lantern = new THREE.PointLight(0xffc77c, 0, 22);
  readonly mastTop: THREE.Vector3;
  readonly oarStow = [0, 0];
  readonly oarStowTarget = [0, 0];
  readonly bladeWorld: THREE.Vector3[];
  readonly bladeAxis: THREE.Vector3[];
  readonly bladeWidthAxis: THREE.Vector3[];
  readonly bladeNormal: THREE.Vector3[];
  readonly bladeIn: boolean[];
  private readonly kin = createKinematics();
  private readonly banks: { shafts: THREE.InstancedMesh; blades: THREE.InstancedMesh; ids: number[] }[] = [];
  private readonly rudders: THREE.Group[] = [];
  private readonly sails: { update(time: number): void }[];
  readonly paddleDrive?: TwinPaddles;
  private paddleRotors: THREE.Object3D[] = [];
  private variantAssembly?: THREE.Group;
  paddleVariant?: PaddleVariantId;
  paddleEngineering?: ReturnType<typeof buildPaddleVariant>['engineering'];
  private runtimePaddleAxes = false;
  private paddleAnimation?: (angles: number[]) => void;

  constructor(shell: THREE.Group, private readonly ship: ShipPhysics, paddleScene?: THREE.Group, variant?: PaddleVariantId) {
    shell.rotation.y = Math.PI / 2;
    const patched = new Set<THREE.Material>();
    shell.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = object.receiveShadow = true;
      object.layers.enable(LAYER_REFRACT);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof THREE.MeshStandardMaterial && !patched.has(material)) {
          patchMaterial(material); patched.add(material);
          // glTF doubleSided solids would shadow their own lit faces (acne darkens the whole deck);
          // cast from back faces instead. Open sheets keep both sides.
          if (material.side === THREE.DoubleSide && !THIN_SHEETS.test(material.name)) material.shadowSide = THREE.BackSide;
        }
      }
    });
    this.group.add(shell, this.lantern);
    if (paddleScene) {
      this.paddleDrive = new TwinPaddles(ship.crew);
      this.paddleDrive.mount(ship);
      paddleScene.rotation.y = Math.PI / 2;
      paddleScene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.castShadow = object.receiveShadow = true; object.layers.enable(LAYER_REFRACT);
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof THREE.MeshStandardMaterial && !patched.has(material)) {
              patchMaterial(material); patched.add(material);
            }
          }
        }
      });
      this.paddleRotors = ['port', 'starboard'].map(side => paddleScene.getObjectByName(`Paddle_${side}_rotor`)!);
      if (this.paddleRotors.some(rotor => !rotor)) throw new Error('Missing authored paddle shaft');
      this.group.add(paddleScene);
    }
    if (variant) {
      this.paddleDrive = new TwinPaddles(ship.crew);
      this.paddleDrive.mount(ship); this.setPaddleVariant(variant);
    }
    const rig = ship.design.rig;
    this.mastTop = new THREE.Vector3(0, rig.mastBaseY + rig.mastHeight, rig.yardZ);
    this.lantern.position.set(0, 7.5, 16);
    const vectors = () => ship.rowing.slots.map(() => new THREE.Vector3());
    this.bladeWorld = vectors(); this.bladeAxis = vectors();
    this.bladeWidthAxis = vectors(); this.bladeNormal = vectors();
    this.bladeIn = ship.rowing.slots.map(() => false);
    const wood = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x60412c, roughness: 0.65 }));
    const bladeMat = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x8a6641, roughness: 0.7 }));
    for (let bank = 0; bank < (paddleScene || variant ? 0 : 3); bank++) {
      const slots = ship.rowing.slots.filter(s => s.bank === bank), slot = slots[0];
      const shaft = new THREE.CylinderGeometry(0.07, 0.105, slot.length, 8);
      shaft.rotateZ(-Math.PI / 2); shaft.translate(slot.length / 2 - slot.inboard, 0, 0);
      const blade = new THREE.BoxGeometry(slot.bladeLength, slot.bladeWidth, slot.bladeThickness);
      blade.translate(slot.bladeRadius, 0, 0);
      const shafts = new THREE.InstancedMesh(shaft, wood, slots.length);
      const blades = new THREE.InstancedMesh(blade, bladeMat, slots.length);
      for (const mesh of [shafts, blades]) {
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true; mesh.frustumCulled = false; mesh.layers.enable(LAYER_REFRACT);
      }
      this.group.add(shafts, blades); this.banks.push({ shafts, blades, ids: slots.map(s => s.id) });
    }
    for (const side of [-1, 1]) {
      const r = ship.design.rudder, group = new THREE.Group();
      group.position.set(side * (ship.design.hull.halfBeam(r.s) + r.xOut), r.y, ship.design.hull.zOf(r.s) + r.dz);
      const top = new THREE.Vector3(0, 6.5, -4.8), direction = top.clone().negate();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, direction.length(), 10), wood);
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      shaft.position.copy(top).multiplyScalar(0.5);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2, r.area / 2), bladeMat);
      shaft.castShadow = blade.castShadow = true; blade.layers.enable(LAYER_REFRACT);
      group.add(shaft, blade); this.group.add(group); this.rudders.push(group);
    }
    this.sails = [ship.sailing, ...ship.additionalSails].map(system => this.makeSail(system.rig, system, wood));
  }

  setPaddleVariant(id: PaddleVariantId) {
    if (!this.paddleDrive) return;
    const assembly = buildPaddleVariant(id); this.paddleEngineering = assembly.engineering;
    if (this.variantAssembly) { this.group.remove(this.variantAssembly); disposePaddleVariant(this.variantAssembly); }
    this.variantAssembly = assembly.group; this.group.add(assembly.group);
    this.paddleRotors = assembly.rotors; this.paddleAnimation = assembly.animate; this.runtimePaddleAxes = true; this.paddleVariant = id;
    this.paddleDrive.setGeometry(this.ship, { ...PADDLE_VARIANTS[id].geometry,
      inertia: assembly.engineering.rotorInertia, rotorMass: assembly.engineering.rotorMass, machineryMass: assembly.engineering.machineryMass });
  }

  private makeSail(rig: SailRig, system: SailingSystem, wood: THREE.Material) {
    const group = new THREE.Group(); group.position.set(0, rig.yardY, rig.yardZ); this.group.add(group);
    const nu = 32, nv = 16, positions = new Float32Array((nu + 1) * (nv + 1) * 3), indices: number[] = [];
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setIndex(indices);
    const material = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xe1d2aa, roughness: 0.92, side: THREE.DoubleSide }));
    const cloth = new THREE.Mesh(geometry, material); cloth.castShadow = true; cloth.frustumCulled = false;
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.17, rig.width, 12), wood);
    yard.rotation.z = Math.PI / 2; yard.castShadow = true; group.add(cloth, yard);
    return { update(time: number) {
      const dep = Math.max(0.018, system.current.deployment);
      group.rotation.y = system.current.yardAngle;
      for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv, k = (j * (nu + 1) + i) * 3;
        positions[k] = (u - 0.5) * rig.width * (1 - 0.12 * v * dep);
        positions[k + 1] = -rig.height * dep * v + 0.85 * Math.abs(2 * u - 1) ** 3 * v * dep;
        positions[k + 2] = -rig.height * 0.25 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
          * dep * Math.max(0.2, Math.abs(system.current.fill)) + 0.025 * Math.sin(time * 2.5 + u * 25) * v * v * dep;
      }
      geometry.attributes.position.needsUpdate = true; geometry.computeVertexNormals();
    } };
  }

  // Wet-blade particles use the real world-space frames below; this exterior has plain wood shading.
  setOarWet(_id: number, _wetLine: number, _soak: number, _film: number) {}

  sailingVisualState() {
    const s = this.ship.sailing;
    return { deployment: s.current.deployment, pressure: s.telemetry.pressure, flutter: s.current.flutter,
      yardAngle: s.current.yardAngle, width: s.rig.width, fullHeight: s.rig.height, visible: true };
  }

  update(physics: ShipPhysics, _crew: Crew, night: number, time: number, alpha = 1) {
    this.paddleRotors.forEach((rotor, i) => {
      const w = this.paddleDrive!.wheels[i];
      const angle = w.previousAngle + (w.angle - w.previousAngle) * alpha;
      rotor.rotation[this.runtimePaddleAxes ? 'x' : 'z'] = angle;

    });
    this.paddleAnimation?.(this.paddleDrive!.wheels.map(w => w.previousAngle + (w.angle-w.previousAngle)*alpha));
    for (const bank of this.banks) {
      bank.ids.forEach((id, i) => {
        physics.rowing.renderPose(id, alpha, this.kin);
        bank.shafts.setMatrixAt(i, this.kin.matrix); bank.blades.setMatrixAt(i, this.kin.matrix);
        this.bladeWorld[id].copy(this.kin.center).applyMatrix4(this.group.matrixWorld);
        this.bladeAxis[id].copy(this.kin.axis).applyQuaternion(this.group.quaternion);
        this.bladeWidthAxis[id].copy(this.kin.widthAxis).applyQuaternion(this.group.quaternion);
        this.bladeNormal[id].copy(this.kin.normal).applyQuaternion(this.group.quaternion);
        this.bladeIn[id] = physics.rowing.current.contact[id] !== 0;
      });
      bank.shafts.instanceMatrix.needsUpdate = bank.blades.instanceMatrix.needsUpdate = true;
    }
    this.rudders.forEach(r => r.rotation.y = -physics.rudderAngle);
    this.sails.forEach(sail => sail.update(time));
    this.lantern.intensity = night * 4;
  }
}
