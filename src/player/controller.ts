import * as THREE from 'three';
import { clamp, damp } from '../core/util';
import type { Input } from '../core/input';
import { TRIREME, type ShipDesign } from '../ship/design';
import type { Terrain } from '../world/terrain';
import type { WaveField } from '../world/waves';
import type { WalkGeometry } from '../world/walkable';
import { Walker, shipYaw, type ShipPose, type WalkFrame, type WalkInput } from './walker';
import { CameraFeel } from './cameraFeel';
import { Interactions, type Interactable } from './interact';
import { CameraRig, newPose, type Pose } from './cameraRig';
import { ChaseCamera } from './chaseCamera';

export type CamMode = 'foot' | 'helm' | 'chase' | 'eagle' | 'build';

/** what the game knows about the ship for the chase camera's automatic framing (spec §9.3 addendum) */
export interface ChaseHints {
  /** A/D held or the order changed this frame */
  steering: boolean;
  /** ship yaw rate, rad/s; + = turning to starboard */
  yawRate: number;
  /** 0..1: 1 within 40 m of a berth, 0 beyond 90 m */
  docking: number;
}

const EYE = 1.66;
const CLIMB_RANGE = 2.2;
const LEVEL_TIME = 0.6; // frame-switch ramp inside foot mode (WS-A)
const PITCH_MAX = (85 * Math.PI) / 180;
const SPYGLASS_KEEP = 0.3; // head bob and shake at this share while the spyglass is up

/**
 * Crew member on foot (walker + camera feel + interactions), taking the helm, AC-style chase camera,
 * Ikaros (eagle) free flight, and the spyglass. 'build' walks exactly like 'foot'.
 * Each mode produces a live target pose; `rig` blends between modes and owns the final camera (spec §9).
 */
export class PlayerController {
  mode: CamMode = 'helm';
  prevShipMode: CamMode = 'helm';
  /** view yaw in the walker's frame: relative to the ship on deck, absolute in the world */
  yaw = 0;
  pitch = -0.05;
  // chase
  chaseYaw = Math.PI * 0.85;
  chasePitch = 0.28;
  /** the user's chase distance choice (set from the design in the constructor) */
  chaseDist: number;
  /** raises the look-at point (cinematic framing puts the ship low in frame) */
  chaseLift = 0;
  /** chase camera swings back behind the ship after the player stops looking around */
  autoCenter = true;
  shipSpeed = 0;
  /** automatic framing inputs from the game; zeros = none */
  chaseHints: ChaseHints = { steering: false, yawRate: 0, docking: 0 };
  /** the automatic look into turns: an orbit yaw offset, eased in while the view is idle (rad) */
  chaseAutoYaw = 0;
  /** eased docking factor 0..1 (framing toward the berth) */
  chaseDocking = 0;
  private distBoost = 0; // eased speed widening of the distance, fraction
  private lookIdle = 0;
  private chaseHeading = NaN; // smoothed ship heading the chase camera trails
  private distS: number; // smoothed zoom
  private readonly chase: ChaseCamera;
  // eagle
  eaglePos = new THREE.Vector3();
  eagleVel = new THREE.Vector3();
  eagleYaw = 0;
  eaglePitch = 0;
  eagleBank = 0;
  // spyglass
  zoom = 0;
  /** how much the inner ear keeps the horizon level (0 = locked to ship, 1 = level) */
  levelFactor = 0.75;
  baseFov = 70;

  /** foot movement, camera feel and interactions */
  readonly walker: Walker;
  readonly feel = new CameraFeel();
  readonly interactions = new Interactions();
  /** the camera rig: transitions between modes and trauma shake (spec §9) */
  readonly rig = new CameraRig();
  /** HTML hint for the HUD, or null */
  prompt: string | null = null;

  /** the live target pose of the current mode, before the rig */
  private readonly live: Pose = newPose();
  private lastMode: CamMode = 'helm';
  /**
   * Foot-mode frame switches (WS-A): 0 = the ship-referenced view, 1 = a pure world yaw/pitch view.
   * Ramps over LEVEL_TIME after a switch; both ends share the view direction at the switch.
   */
  private worldBlend = 0;
  private footActive = false;
  /** the view in the frame the walker is not in: yaw/pitch as the other frame expresses them */
  private altYaw = 0;
  private altPitch = 0;
  private qDisp = new THREE.Quaternion();
  private fNow = new THREE.Vector3();
  private lastShip: ShipPose | null = null;
  private climbDist = Infinity;
  private walkIn: WalkInput = { fwd: 0, strafe: 0, run: false, jump: false, yaw: 0 };
  private readonly helm: Interactable;
  private readonly climb: Interactable;

  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpQ3 = new THREE.Quaternion();
  private tmpQ4 = new THREE.Quaternion();
  private tmpQ5 = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpV3 = new THREE.Vector3();
  private tmpV4 = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private readonly zero = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly zAxis = new THREE.Vector3(0, 0, 1);

  constructor(private camera: THREE.PerspectiveCamera, private input: Input, readonly design: ShipDesign = TRIREME) {
    this.walker = new Walker(design);
    this.chase = new ChaseCamera(design.camera.chasePivotUp);
    this.chaseDist = design.camera.chaseDist;
    this.distS = design.camera.chaseDist;
    this.helm = {
      id: 'helm',
      label: 'Take helm',
      frame: 'ship',
      pos: new THREE.Vector3(0, this.design.deck.deckY(this.design.camera.helmS) + 1.0, this.design.hull.zOf(this.design.camera.helmS)),
      radius: 2.5,
      enabled: () => this.onFoot && this.walker.frame === 'ship' && !this.walker.scripted,
      act: () => {
        this.mode = 'helm';
        this.yaw = 0;
      },
    };
    this.climb = {
      id: 'climb',
      label: 'Climb aboard',
      frame: 'world',
      pos: new THREE.Vector3(),
      // the hull point is 3 m away at most; the walker's own 2.2 m check gates the prompt
      radius: 3,
      enabled: () => this.onFoot && this.walker.frame === 'world' && this.walker.swimming && !this.walker.scripted && this.climbDist <= CLIMB_RANGE,
      act: () => {
        if (this.lastShip) this.walker.climbAboard(this.lastShip);
      },
    };
    this.interactions.list.push(this.helm, this.climb);
  }

  get atHelm() {
    return this.mode === 'helm';
  }

  /** the current mode's live target pose, before the rig blends it (read-only, for tests and debug) */
  get livePose(): Pose {
    return this.live;
  }

  private get onFoot() {
    return this.mode === 'foot' || this.mode === 'build';
  }

  /** a shake impulse for the camera rig (spec §9.5): quay bump, grounding, bow slam */
  addTrauma(x: number) {
    this.rig.addTrauma(x);
  }

  /** leave the helm, or act on the targeted interactable (E) */
  toggleHelm() {
    if (this.mode === 'helm') {
      this.mode = 'foot';
      const z = this.design.hull.zOf(this.design.camera.helmS - 0.02);
      this.walker.placeOnDeck(new THREE.Vector3(0, this.design.deck.deckY(this.design.hull.sOf(z)), z));
      return;
    }
    const t = this.interactions.target;
    if (t && t.enabled()) t.act();
  }

  cycleCamera() {
    if (this.mode === 'chase') this.mode = this.prevShipMode;
    else if (this.mode !== 'eagle') {
      this.prevShipMode = this.mode;
      this.mode = 'chase';
    }
  }

  toggleEagle(shipPos: THREE.Vector3) {
    void shipPos;
    if (this.mode === 'eagle') {
      this.mode = this.prevShipMode;
    } else {
      if (this.mode !== 'chase') this.prevShipMode = this.mode;
      this.mode = 'eagle';
      this.eaglePos.copy(this.rig.pose.position).add(new THREE.Vector3(0, 6, 0));
      const d = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rig.pose.quaternion);
      this.eagleYaw = Math.atan2(-d.x, -d.z);
      this.eaglePitch = 0.1;
      this.eagleVel.set(-Math.sin(this.eagleYaw), 0.4, -Math.cos(this.eagleYaw)).multiplyScalar(18);
    }
  }

  update(dt: number, ship: ShipPose, world: WalkGeometry, terrain: Terrain, waves: WaveField, time: number) {
    const inp = this.input;
    const sensK = 1 / (1 + this.zoom * 5);
    // arrow keys (tap = fine, hold = sweep), plus mouse deltas when mouse look is on; the spyglass slows both
    const look = inp.look(dt);
    const mdx = (inp.mouseDX * inp.sensitivity + look.yaw) * sensK;
    const mdy = (inp.mouseDY * inp.sensitivity + look.pitch) * sensK * (inp.invertY ? -1 : 1);
    const manualNow = inp.mouseDX !== 0 || inp.mouseDY !== 0 || inp.lookX !== 0 || inp.lookY !== 0;
    this.lookIdle = manualNow ? 0 : this.lookIdle + dt;
    this.lastShip = ship;

    // spyglass: right button or hold V
    const wantZoom = (inp.rmb || inp.down('KeyV')) && this.mode !== 'eagle' ? 1 : 0;
    this.zoom = damp(this.zoom, wantZoom, 10, dt);

    const live = this.live;
    if (this.mode === 'helm') {
      this.yaw = clamp(this.yaw - mdx, -2.6, 2.6);
      this.pitch = clamp(this.pitch - mdy, -PITCH_MAX, PITCH_MAX);
      this.helmPose(ship, live);
      this.interactions.target = null;
      this.prompt = null;
    } else if (this.onFoot) {
      this.yaw -= mdx;
      this.pitch = clamp(this.pitch - mdy, -PITCH_MAX, PITCH_MAX);
      this.footPose(dt, ship, world, waves, time, live);
    } else {
      this.interactions.target = null;
      this.prompt = null;
    }
    if (!this.onFoot) this.footActive = false;

    if (this.mode === 'chase') this.chasePose(dt, ship, mdx, mdy, terrain, waves, time, live);
    else if (this.mode === 'eagle') this.eaglePose(dt, mdx, mdy, terrain, waves, time, live);

    // spyglass narrows the FOV for every mode
    live.fov /= 1 + this.zoom * 5.5;

    if (this.mode !== this.lastMode) {
      if (this.rig.started) this.rig.transition(transitionTime(this.lastMode, this.mode));
      this.lastMode = this.mode;
    }
    // head bob and shake drop to 30% through the spyglass
    this.rig.update(dt, this.camera, live, 1 - (1 - SPYGLASS_KEEP) * this.zoom);
  }

  /** on foot: walk, feel, look, and the nearby prompts */
  private footPose(dt: number, ship: ShipPose, world: WalkGeometry, waves: WaveField, time: number, live: Pose) {
    const inp = this.input;
    const w = this.walkIn;
    w.fwd = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0);
    w.strafe = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
    w.run = inp.down('ShiftLeft') || inp.down('ShiftRight');
    w.jump = inp.hit('Space');
    w.yaw = this.yaw;

    const before = this.walker.frame;
    if (!this.footActive) {
      // entering on foot: start from the view's own frame, no ramp
      this.footActive = true;
      this.worldBlend = before === 'world' ? 1 : 0;
    }
    // the direction on screen right now; it must survive a frame switch unchanged
    this.displayOrientation(ship, before, this.qDisp);
    this.fNow.set(0, 0, -1).applyQuaternion(this.qDisp);

    this.walker.update(dt, w, ship, world, waves, time);
    if (this.walker.frame !== before) this.handOverView(this.fNow, ship, this.walker.frame);
    this.feel.update(dt, this.walker, w, ship);

    const target = this.walker.frame === 'world' ? 1 : 0;
    const step = dt / LEVEL_TIME;
    if (target > this.worldBlend) this.worldBlend = Math.min(target, this.worldBlend + step);
    else if (target < this.worldBlend) this.worldBlend = Math.max(target, this.worldBlend - step);

    this.displayOrientation(ship, this.walker.frame, live.quaternion);
    const sg = 1 - (1 - SPYGLASS_KEEP) * this.zoom;
    live.quaternion.multiply(this.tmpQ4.setFromAxisAngle(this.zAxis, this.feel.roll * sg));

    const eye = this.walker.eye(ship, this.tmpV2);
    live.position.copy(eye).add(this.tmpV3.copy(this.feel.offset).multiplyScalar(sg).applyQuaternion(live.quaternion));
    live.fov = this.baseFov + this.feel.fovAdd;

    this.updateClimb(ship);
    const viewDir = this.tmpV4.set(0, 0, -1).applyQuaternion(live.quaternion);
    this.interactions.update(eye, viewDir, ship.origin, ship.quat);
    const t = this.interactions.target;
    if ((this.walker.touchingRail !== 0 || this.walker.touchingEnd !== 0) && !this.walker.swimming) this.prompt = '<kbd>Space</kbd> Jump overboard';
    else if (t) this.prompt = `<kbd>E</kbd> ${t.label}`;
    else this.prompt = null;
  }

  /**
   * Orientation of the on-foot view. The ship-referenced part is the ship's attitude times the
   * look, levelled by levelFactor; the world part is a pure yaw/pitch view. `worldBlend` mixes them.
   * Each side reads the view in its own frame: the active one from yaw/pitch, the other from alt.
   */
  private displayOrientation(ship: ShipPose, frame: WalkFrame, out: THREE.Quaternion): THREE.Quaternion {
    const onShip = frame === 'ship';
    const yS = onShip ? this.yaw : this.altYaw;
    const pS = onShip ? this.pitch : this.altPitch;
    const yW = onShip ? this.altYaw : this.yaw;
    const pW = onShip ? this.altPitch : this.pitch;
    const look = this.tmpQ.setFromEuler(new THREE.Euler(pS, yS, 0, 'YXZ'));
    const base = this.tmpQ2.copy(ship.quat).multiply(look);
    const f = this.tmpV.set(0, 0, -1).applyQuaternion(base);
    const level = this.tmpQ3.setFromRotationMatrix(this.m.lookAt(this.zero, f, this.up));
    const shipCam = this.tmpQ4.copy(base).slerp(level, this.levelFactor);
    const worldCam = this.tmpQ5.setFromEuler(new THREE.Euler(pW, yW, 0, 'YXZ'));
    return out.copy(shipCam).slerp(worldCam, this.worldBlend);
  }

  /**
   * A frame switch: both representations are rewritten from the view direction on screen, so the
   * orientation is continuous at the switch whatever the blend is at that moment.
   */
  private handOverView(f: THREE.Vector3, ship: ShipPose, to: WalkFrame) {
    const wy = Math.atan2(-f.x, -f.z);
    const wp = Math.asin(clamp(f.y, -1, 1));
    const fl = this.tmpV2.copy(f).applyQuaternion(this.tmpQ.copy(ship.quat).invert());
    const ly = Math.atan2(-fl.x, -fl.z);
    const lp = Math.asin(clamp(fl.y, -1, 1));
    if (to === 'world') {
      this.yaw = wy;
      this.pitch = wp;
      this.altYaw = ly;
      this.altPitch = lp;
    } else {
      this.yaw = ly;
      this.pitch = lp;
      this.altYaw = wy;
      this.altPitch = wp;
    }
  }

  /** the nearest point of the hull side at the walker's station, and the distance to it */
  private updateClimb(ship: ShipPose) {
    const w = this.walker;
    if (w.frame !== 'world' || !w.swimming) {
      this.climbDist = Infinity;
      return;
    }
    const local = this.tmpV4.copy(w.world).sub(ship.origin).applyQuaternion(this.tmpQ.copy(ship.quat).invert());
    const s = clamp(this.design.hull.sOf(local.z), 0, 1);
    const side = local.x < 0 ? -1 : 1;
    const outer = this.design.deck.outerHalfWidth(s);
    this.climbDist = Math.abs(local.x) - outer;
    this.climb.pos.set(side * outer, 0.3, clamp(local.z, -this.design.hull.length / 2, this.design.hull.length / 2)).applyQuaternion(ship.quat).add(ship.origin);
  }

  /** at the helm: fixed eye, ship-referenced look (the earlier deck camera, unchanged) */
  private helmPose(ship: ShipPose, live: Pose) {
    const eyeLocal = this.tmpV.set(0, this.design.deck.deckY(this.design.camera.helmS) + EYE + 0.1, this.design.hull.zOf(this.design.camera.helmS) + 0.25);
    live.position.copy(eyeLocal).applyQuaternion(ship.quat).add(ship.origin);
    const look = this.tmpQ.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const qShip = this.tmpQ2.copy(ship.quat).multiply(look);
    const f = this.tmpV2.set(0, 0, -1).applyQuaternion(qShip);
    const level = this.tmpQ3.setFromRotationMatrix(this.m.lookAt(this.zero, f, this.up));
    live.quaternion.copy(qShip).slerp(level, this.levelFactor);
    live.fov = this.baseFov;
  }

  /**
   * AC-style chase: mouse orbits, wheel zooms, the orbit trails the ship's heading with a lag. With no
   * look input for a while the view comes back behind the ship, looks into turns, and frames speed and
   * docking. Manual look always wins: it folds any automatic turn offset into the user's yaw first.
   */
  private chasePose(dt: number, ship: ShipPose, mdx: number, mdy: number, terrain: Terrain, waves: WaveField, time: number, live: Pose) {
    const inp = this.input;
    const hints = this.chaseHints;
    if (this.lookIdle === 0) {
      this.chaseYaw += this.chaseAutoYaw;
      this.chaseAutoYaw = 0;
    }
    this.chaseYaw = wrapAngle(this.chaseYaw - mdx);
    this.chasePitch = clamp(this.chasePitch + mdy, -0.05, 1.3);
    // wheel, or Minus (out) / Equal (in) held: smooth zoom
    const zoomKey = (inp.down('Minus') || inp.down('NumpadSubtract') ? 1 : 0) - (inp.down('Equal') || inp.down('NumpadAdd') ? 1 : 0);
    this.chaseDist = clamp(this.chaseDist * (1 + inp.wheel * 0.1) * Math.exp(zoomKey * 0.9 * dt), 14, 160);
    const sp = clamp(Math.abs(this.shipSpeed) / 5, 0, 1);
    const delay = hints.steering ? 0.6 : 2.0;
    const auto = this.autoCenter && this.lookIdle > delay;
    this.chaseDocking += (clamp(hints.docking, 0, 1) - this.chaseDocking) * (1 - Math.exp(-dt * 2.5));
    // look into turns: swing the orbit to the outside of the turn, so the bow and the water it turns toward are in frame
    const turnGoal = auto ? -clamp(hints.yawRate * 2.2, -0.35, 0.35) : 0;
    this.chaseAutoYaw += (turnGoal - this.chaseAutoYaw) * (1 - Math.exp(-dt * 1.2));
    // recentre behind the stern, and ease the pitch toward its speed/docking goal
    const recentre = auto && (Math.abs(this.shipSpeed) > 0.8 || this.chaseDocking > 0);
    if (recentre) {
      const k = 1 - Math.exp(-dt * 0.9);
      this.chaseYaw = wrapAngle(this.chaseYaw - this.chaseYaw * k);
      const pitchSpeed = 0.24 + (0.18 - 0.24) * sp;
      const pitchGoal = pitchSpeed + (0.62 - pitchSpeed) * this.chaseDocking;
      this.chasePitch += (pitchGoal - this.chasePitch) * k;
    }
    // distance: speed opens the view by up to 15%, docking widens it toward the design's docking distance; both multiply the user's choice
    this.distBoost += (0.15 * sp - this.distBoost) * (1 - Math.exp(-dt));
    const distBase = this.chaseDist + (Math.max(this.chaseDist, this.design.camera.dockingDist) - this.chaseDist) * this.chaseDocking;
    this.distS = damp(this.distS, clamp(distBase * (1 + this.distBoost), 14, 200), 8, dt);

    const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(ship.quat);
    const heading = Math.atan2(-fwd.x, -fwd.z);
    if (Number.isNaN(this.chaseHeading) || dt > 0.5) this.chaseHeading = heading;
    else this.chaseHeading = wrapAngle(this.chaseHeading + wrapAngle(heading - this.chaseHeading) * (1 - Math.exp(-dt * 1.8)));
    this.chase.solve(dt, ship, terrain, waves, time, this.chaseHeading + this.chaseYaw + this.chaseAutoYaw, this.chasePitch, this.distS, this.chaseLift, this.shipSpeed, this.baseFov, live);
  }

  /** Ikaros: bank to turn, dive to gain speed, climb to trade it */
  private eaglePose(dt: number, mdx: number, mdy: number, terrain: Terrain, waves: WaveField, time: number, live: Pose) {
    const inp = this.input;
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
    this.eagleBank = damp(this.eagleBank, clamp(-(mdx / Math.max(dt, 1e-3)) * 0.3, -0.7, 0.7), 4, dt);
    live.position.copy(this.eaglePos);
    live.quaternion.setFromEuler(new THREE.Euler(this.eaglePitch, this.eagleYaw, this.eagleBank, 'YXZ'));
    live.fov = this.baseFov;
  }
}

/** how long a mode change takes to blend (spec §9.1) */
function transitionTime(a: CamMode, b: CamMode): number {
  if (a === b) return 0;
  if ((a === 'foot' && b === 'build') || (a === 'build' && b === 'foot')) return 0;
  if (a === 'eagle' || b === 'eagle') return 0.6;
  if (a === 'chase' || b === 'chase') return 0.7;
  return 0.45;
}

function wrapAngle(a: number) {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}
