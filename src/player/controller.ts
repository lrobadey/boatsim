import * as THREE from 'three';
import { clamp, damp } from '../core/util';
import type { Input } from '../core/input';
import { deckY, sOf, zOf, DECK_S0, DECK_S1 } from '../ship/hull';
import { deckHalfWidth } from '../ship/trireme';
import type { Terrain } from '../world/terrain';
import type { WaveField } from '../world/waves';

export type CamMode = 'deck' | 'helm' | 'chase' | 'eagle';

const HELM_S = 0.885;
const EYE = 1.66;

/**
 * First-person crew member walking the deck in the ship's moving frame, taking the helm,
 * AC-style chase camera, Ikaros (eagle) free flight, and the spyglass.
 */
export class PlayerController {
  mode: CamMode = 'helm';
  prevShipMode: CamMode = 'helm';
  // deck-local state
  lx = 0;
  lz = zOf(HELM_S);
  yaw = 0; // relative to ship forward
  pitch = -0.05;
  private bob = 0;
  // chase
  chaseYaw = Math.PI * 0.85;
  chasePitch = 0.28;
  chaseDist = 42;
  /** raises the look-at point (cinematic framing puts the ship low in frame) */
  chaseLift = 0;
  // eagle
  eaglePos = new THREE.Vector3();
  eagleVel = new THREE.Vector3();
  eagleYaw = 0;
  eaglePitch = 0;
  eagleBank = 0;
  // spyglass
  zoom = 0;
  levelFactor = 0.6; // how much the inner ear keeps the horizon level (0 = locked to ship)
  baseFov = 70;

  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private m = new THREE.Matrix4();

  constructor(private camera: THREE.PerspectiveCamera, private input: Input) {}

  get atHelm() {
    return this.mode === 'helm';
  }
  get nearHelm() {
    return this.mode === 'deck' && Math.abs(sOf(this.lz) - HELM_S) < 0.04 && Math.abs(this.lx) < 1.2;
  }

  toggleHelm() {
    if (this.mode === 'helm') {
      this.mode = 'deck';
      this.lz = zOf(HELM_S - 0.02);
      this.lx = 0;
    } else if (this.nearHelm) {
      this.mode = 'helm';
      this.yaw = 0;
    }
  }

  cycleCamera() {
    if (this.mode === 'chase') this.mode = this.prevShipMode;
    else if (this.mode !== 'eagle') {
      this.prevShipMode = this.mode;
      this.mode = 'chase';
    }
  }

  toggleEagle(shipPos: THREE.Vector3) {
    if (this.mode === 'eagle') {
      this.mode = this.prevShipMode;
    } else {
      if (this.mode !== 'chase') this.prevShipMode = this.mode;
      this.mode = 'eagle';
      this.eaglePos.copy(this.camera.position).add(new THREE.Vector3(0, 6, 0));
      const d = this.camera.getWorldDirection(this.tmpV);
      this.eagleYaw = Math.atan2(-d.x, -d.z);
      this.eaglePitch = 0.1;
      this.eagleVel.set(-Math.sin(this.eagleYaw), 0.4, -Math.cos(this.eagleYaw)).multiplyScalar(18);
    }
  }

  update(dt: number, shipPos: THREE.Vector3, shipQuat: THREE.Quaternion, terrain: Terrain, waves: WaveField, time: number) {
    const inp = this.input;
    const sensK = 1 / (1 + this.zoom * 5);
    const mdx = inp.mouseDX * inp.sensitivity * sensK;
    const mdy = inp.mouseDY * inp.sensitivity * sensK * (inp.invertY ? -1 : 1);

    // spyglass
    const wantZoom = inp.rmb && this.mode !== 'eagle' ? 1 : 0;
    this.zoom = damp(this.zoom, wantZoom, 10, dt);
    this.camera.fov = this.baseFov / (1 + this.zoom * 5.5);

    if (this.mode === 'deck' || this.mode === 'helm') {
      this.yaw -= mdx;
      this.pitch = clamp(this.pitch - mdy, -1.35, 1.35);
      if (this.mode === 'helm') this.yaw = clamp(this.yaw, -2.6, 2.6);
      let eyeLocal: THREE.Vector3;
      if (this.mode === 'deck') {
        // walk in the ship frame
        const fwd = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0);
        const str = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
        const run = inp.down('ShiftLeft') || inp.down('ShiftRight');
        const sp = (run ? 4.2 : 1.9) * dt;
        const len = Math.hypot(fwd, str);
        if (len > 0) {
          const f = fwd / len,
            s = str / len;
          const sy = Math.sin(this.yaw),
            cy = Math.cos(this.yaw);
          this.lx += (s * cy - f * sy) * sp;
          this.lz += (-s * sy - f * cy) * sp;
          this.bob += dt * (run ? 11 : 7.5);
        }
        const s = clamp(sOf(this.lz), DECK_S0 + 0.01, DECK_S1 - 0.01);
        this.lz = zOf(s);
        const hw = Math.max(0.2, deckHalfWidth(s));
        this.lx = clamp(this.lx, -hw, hw);
        const bobY = Math.sin(this.bob) * 0.035 * (len > 0 ? 1 : 0);
        eyeLocal = this.tmpV.set(this.lx, deckY(s) + EYE + bobY, this.lz);
      } else {
        eyeLocal = this.tmpV.set(0, deckY(HELM_S) + EYE + 0.1, zOf(HELM_S) + 0.25);
      }
      // world transform: ship pose (CoG-based pose passed as mesh transform)
      this.camera.position.copy(eyeLocal).applyQuaternion(shipQuat).add(shipPos);
      // look orientation in ship frame, then partially re-level to the horizon
      const look = this.tmpQ.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
      const qShip = this.tmpQ2.copy(shipQuat).multiply(look);
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(qShip);
      const level = new THREE.Quaternion().setFromRotationMatrix(this.m.lookAt(new THREE.Vector3(), f, new THREE.Vector3(0, 1, 0)));
      this.camera.quaternion.copy(qShip).slerp(level, this.levelFactor);
    } else if (this.mode === 'chase') {
      this.chaseYaw -= mdx;
      this.chasePitch = clamp(this.chasePitch + mdy, -0.05, 1.3);
      this.chaseDist = clamp(this.chaseDist * (1 + inp.wheel * 0.08), 14, 160);
      // follow ship heading loosely (AC style): camera yaw is relative to ship heading
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(shipQuat);
      const heading = Math.atan2(-fwd.x, -fwd.z);
      const yaw = heading + this.chaseYaw;
      const target = shipPos.clone().add(new THREE.Vector3(0, 4 + this.chaseLift, 0));
      const d = this.chaseDist;
      const off = new THREE.Vector3(Math.sin(yaw) * Math.cos(this.chasePitch), Math.sin(this.chasePitch), Math.cos(yaw) * Math.cos(this.chasePitch)).multiplyScalar(d);
      const pos = target.clone().add(off);
      const minY = Math.max(waves.heightAt(pos.x, pos.z, time), terrain.heightAt(pos.x, pos.z)) + 1.5;
      if (pos.y < minY) pos.y = minY;
      this.camera.position.copy(pos);
      this.camera.lookAt(target);
    } else if (this.mode === 'eagle') {
      // Ikaros: bank to turn, dive to gain speed, climb to trade it
      this.eagleYaw -= mdx * 1.2;
      this.eaglePitch = clamp(this.eaglePitch - mdy, -1.2, 1.1);
      const boost = inp.down('KeyW') ? 1 : 0;
      const brake = inp.down('KeyS') ? 1 : 0;
      const dir = new THREE.Vector3(-Math.sin(this.eagleYaw) * Math.cos(this.eaglePitch), Math.sin(this.eaglePitch), -Math.cos(this.eagleYaw) * Math.cos(this.eaglePitch));
      let speed = this.eagleVel.length();
      speed += (-Math.sin(this.eaglePitch) * 9.81 * 0.6 + boost * 14 - brake * 12 - (speed - 22) * 0.15) * dt;
      speed = clamp(speed, 8, 75);
      this.eagleVel.copy(dir).multiplyScalar(speed);
      this.eaglePos.addScaledVector(this.eagleVel, dt);
      const ground = Math.max(terrain.heightAt(this.eaglePos.x, this.eaglePos.z), waves.heightAt(this.eaglePos.x, this.eaglePos.z, time)) + 2;
      if (this.eaglePos.y < ground) {
        this.eaglePos.y = ground;
        this.eaglePitch = Math.max(this.eaglePitch, 0.1);
      }
      this.eaglePos.y = Math.min(this.eaglePos.y, 1600);
      this.eagleBank = damp(this.eagleBank, clamp(-inp.mouseDX * 0.02, -0.7, 0.7), 4, dt);
      this.camera.position.copy(this.eaglePos);
      this.camera.quaternion.setFromEuler(new THREE.Euler(this.eaglePitch, this.eagleYaw, this.eagleBank, 'YXZ'));
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }
}
