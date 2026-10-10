/**
 * Ship base building (spec §8). Everything is in the ship-local frame: x starboard, y up, z aft
 * (src/ship/hull.ts). The cursor is a ray from the eye; placed pieces are parented to the ship
 * group, register a ship-local Solid and add their mass to the physics payload.
 */
import * as THREE from 'three';
import type { ModelKit } from '../gfx/models';
import type { Input } from '../core/input';
import type { Interactable } from '../player/interact';
import type { BoxSolid, Solid, WalkGeometry } from '../world/walkable';
import { deckY, sOf, zOf } from '../ship/hull';
import { deckHalfWidth } from '../ship/trireme';
import { PIECES, PIECE_BY_ID, PAYLOAD_LIMIT, type PieceDef, type Placement } from './pieces';
import { BuildUi } from './buildUi';

export interface BuildContext {
  input: Input;
  /** eye position and view direction in SHIP-LOCAL coordinates */
  eyeLocal: THREE.Vector3;
  dirLocal: THREE.Vector3;
  /** 0 day .. 1 night */
  night: number;
  /** game.clock.dayCount (integer days elapsed) */
  dayCount: number;
  cameraWorld: THREE.Vector3;
}

export type BuildEvent = { type: 'place' | 'remove' | 'deny'; reason?: string } | { type: 'offering' };

const STORE_KEY = 'trieres.deck.v1';
const STEP = 0.04;
/** placement reach (m) from the eye */
const REACH = 4.0;
/** how far the aim ray is scanned, so a too-distant deck point can show "Out of reach" */
const SCAN = 12.0;
const GRID = 0.25;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
/** footprint must stay this far inside the deck edge (m) */
const EDGE_MARGIN = 0.1;
/** footprint station range (helm zone starts above S_MAX) */
const S_MIN = 0.1;
const S_MAX = 0.86;
/** plank opening: station, half length along the hull, and inboard clearance from the deck edge */
const PLANK_S = 0.62;
const PLANK_Z_HALF = 1.2;
const PLANK_X_IN = 1.3;
/** growth applied to cylinder solids when testing for overlap (m) */
const CYL_GROW = 0.05;
const EPS = 1e-4;
const POP_T = 0.15;
const GHOST_OK = 0x7fc48a;
const GHOST_BAD = 0xc4492f;
const LIGHT_COLOR = 0xffa050;
const LIGHTS_MAX = 3;
/** emissive colour of the kit's `fire` slot (models.ts) */
const FIRE_EMISSIVE = 0xffb060;
const OFFERING_STAMINA = 0.35;
const ALTAR_RADIUS = 2.2;
const DIGIT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'];
const KEYS_HINT = '<kbd>Enter</kbd> Place · <kbd>R</kbd> Rotate · <kbd>X</kbd> Remove · <kbd>B</kbd> Done';
const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

interface Piece {
  uid: number;
  def: PieceDef;
  x: number;
  z: number;
  rot: number;
  level: 0 | 1;
  /** base height of the piece (deck or the top of the crate below) */
  y: number;
  obj: THREE.Object3D;
  solid: BoxSolid;
  load: { mass: number; local: THREE.Vector3 };
  base: Piece | null;
  top: Piece | null;
  /** seconds since placed (pop animation), capped at POP_T */
  pop: number;
  /** the kit's flame material (lamp posts only) */
  fire: THREE.MeshStandardMaterial | null;
  /** ship-local position of the light, for light pieces */
  lightLocal: THREE.Vector3 | null;
  interact: Interactable | null;
}

interface Aim {
  t: number;
  x: number;
  z: number;
  y: number;
  base: Piece | null;
}

interface Target {
  x: number;
  z: number;
  y: number;
  rot: number;
  level: 0 | 1;
  base: Piece | null;
  valid: boolean;
  reason: string;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const snap = (v: number) => Math.round(v / GRID) * GRID;
const norm = (a: number) => ((a % TAU) + TAU) % TAU;
const kgToT = (kg: number) => (kg / 1000).toFixed(2);

function footprint(hx: number, hz: number, x: number, z: number, rot: number): Array<{ x: number; z: number }> {
  const c = Math.cos(rot),
    s = Math.sin(rot);
  return CORNERS.map(([su, sv]) => {
    const u = su * hx,
      v = sv * hz;
    return { x: x + u * c + v * s, z: z - u * s + v * c };
  });
}

/** does a box (hx, hz, centre x/z, yaw rot) overlap the solid in plan view */
function overlapsSolid(hx: number, hz: number, x: number, z: number, rot: number, o: Solid): boolean {
  const c = Math.cos(rot),
    s = Math.sin(rot);
  if (o.kind === 'cyl') {
    // cylinder centre in the piece's box-local frame, distance to the rectangle
    const dx = o.cx - x,
      dz = o.cz - z;
    const u = dx * c - dz * s,
      v = dx * s + dz * c;
    const cu = Math.max(-hx, Math.min(hx, u)),
      cv = Math.max(-hz, Math.min(hz, v));
    return Math.hypot(u - cu, v - cv) < o.r + CYL_GROW;
  }
  // separating axis test for two rectangles in plan view
  const ac = Math.cos(o.rot),
    as = Math.sin(o.rot);
  const axes: Array<[number, number]> = [
    [c, -s],
    [s, c],
    [ac, -as],
    [as, ac],
  ];
  const dx = o.cx - x,
    dz = o.cz - z;
  for (const [nx, nz] of axes) {
    const d = Math.abs(dx * nx + dz * nz);
    const ra = hx * Math.abs(c * nx - s * nz) + hz * Math.abs(s * nx + c * nz);
    const rb = o.hx * Math.abs(ac * nx - as * nz) + o.hz * Math.abs(as * nx + ac * nz);
    if (d >= ra + rb - EPS) return false;
  }
  return true;
}

/** distance along the ray to a box solid (y from y0 to y1), or null when missed within maxT */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, b: BoxSolid, maxT: number): number | null {
  const c = Math.cos(b.rot),
    s = Math.sin(b.rot);
  const ox = o.x - b.cx,
    oz = o.z - b.cz,
    oy = o.y - b.y0;
  const u0 = ox * c - oz * s,
    v0 = ox * s + oz * c;
  const du = d.x * c - d.z * s,
    dv = d.x * s + d.z * c;
  let t0 = 0,
    t1 = maxT;
  const slab = (p0: number, dp: number, lo: number, hi: number) => {
    if (Math.abs(dp) < 1e-9) return p0 >= lo && p0 <= hi;
    let a = (lo - p0) / dp,
      e = (hi - p0) / dp;
    if (a > e) [a, e] = [e, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, e);
    return t0 <= t1;
  };
  if (!slab(u0, du, -b.hx, b.hx)) return null;
  if (!slab(v0, dv, -b.hz, b.hz)) return null;
  if (!slab(oy, d.y, 0, b.y1 - b.y0)) return null;
  return t0;
}

function isPlacement(e: unknown): e is Placement {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    PIECE_BY_ID.has(o.id) &&
    Number.isFinite(o.x) &&
    Number.isFinite(o.z) &&
    Number.isFinite(o.rot) &&
    (o.level === 0 || o.level === 1)
  );
}

export class DeckBuilder {
  readonly ui: BuildUi;
  /** B toggles this (the lead calls setActive) */
  active = false;
  /** cleared at the start of each update */
  readonly events: BuildEvent[] = [];

  private pieces: Piece[] = [];
  private uid = 0;
  private sel = 0;
  private rot = 0;
  private ghost: THREE.Object3D | null = null;
  private ghostMat = new THREE.MeshBasicMaterial({ color: GHOST_OK, transparent: true, opacity: 0.38, depthWrite: false });
  private ghostValid: boolean | null = null;
  private target: Target | null = null;
  private note = '';
  private noteT = 0;
  private time = 0;
  private dayNow = 0;
  private offeredDay = -1;
  private lights: THREE.PointLight[] = [];
  private fireMat: THREE.MeshStandardMaterial | null = null;
  private tmpDir = new THREE.Vector3();
  private tmpW = new THREE.Vector3();

  constructor(
    private models: ModelKit,
    private shipGroup: THREE.Group,
    private payload: { mass: number; local: THREE.Vector3 }[],
    private shipSolids: WalkGeometry,
    private interactions: { list: Interactable[] },
    private crew: { stamina: number },
    private enabled = true,
  ) {
    this.ui = new BuildUi();
    for (let i = 0; i < LIGHTS_MAX; i++) {
      const l = new THREE.PointLight(LIGHT_COLOR, 0, 9, 2);
      l.castShadow = false;
      l.visible = false;
      shipGroup.add(l);
      this.lights.push(l);
    }
    this.ui.select(this.sel);
    this.rebuildGhost();
    if (this.enabled) this.load();
  }

  setActive(on: boolean): void {
    if (!this.enabled) on = false;
    this.active = on;
    this.ui.setVisible(on);
    if (on) {
      this.ui.select(this.sel);
    } else {
      this.target = null;
      if (this.ghost) this.ghost.visible = false;
      this.noteT = 0;
    }
  }

  /** total ship payload (kg) from the physics payload list */
  payloadKg(): number {
    let m = 0;
    for (const p of this.payload) m += p.mass;
    return m;
  }

  update(dt: number, ctx: BuildContext): void {
    this.events.length = 0;
    this.time += dt;
    this.dayNow = ctx.dayCount;
    this.updatePops(dt);
    if (this.noteT > 0) this.noteT -= dt;
    if (this.active) this.updateBuild(ctx);
    this.updateLights(ctx);
    this.ui.setLoad(this.payloadKg());
  }

  /** restores placements from localStorage (replaces anything already placed) */
  load(): void {
    for (const p of [...this.pieces].reverse()) this.dispose(p);
    let raw: unknown = null;
    try {
      const s = globalThis.localStorage?.getItem(STORE_KEY);
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = null;
    }
    if (!Array.isArray(raw)) return;
    for (const e of raw as unknown[]) {
      if (!isPlacement(e)) continue;
      const def = PIECE_BY_ID.get(e.id)!;
      let base: Piece | null = null;
      if (e.level === 1) {
        base = this.findBase(e.x, e.z);
        if (!base) continue;
      }
      const y = base ? base.solid.y1 : deckY(sOf(e.z));
      if (this.evaluate(def, e.x, e.z, e.rot, e.level, base, y, true) !== null) continue;
      this.spawn(def, e.x, e.z, e.rot, e.level, base);
    }
  }

  save(): void {
    const list: Placement[] = this.pieces.map((p) => ({ id: p.def.id, x: p.x, z: p.z, rot: p.rot, level: p.level }));
    try {
      globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
      // storage blocked or full: placements still work for this session
    }
  }

  // ---------------------------------------------------------------- per frame

  private updateBuild(ctx: BuildContext): void {
    const input = ctx.input;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');

    let sel = this.sel;
    DIGIT_KEYS.forEach((k, i) => {
      if (input.hit(k)) sel = i;
    });
    if (input.wheel) sel = (((sel + Math.round(input.wheel)) % PIECES.length) + PIECES.length) % PIECES.length;
    if (sel !== this.sel) {
      this.sel = sel;
      this.ui.select(sel);
      this.rebuildGhost();
    }

    if (input.hit('KeyR')) this.rot = norm(this.rot + (shift ? 15 : 90) * DEG);

    const eye = ctx.eyeLocal;
    const dir = this.tmpDir.copy(ctx.dirLocal);
    const hasDir = dir.lengthSq() > 1e-12;
    if (hasDir) dir.normalize();
    this.target = hasDir ? this.computeTarget(eye, dir) : null;

    if (input.clicked && this.target) {
      if (this.target.valid) this.placeTarget(this.target);
      else this.events.push({ type: 'deny', reason: this.target.reason });
    }

    if (input.hit('KeyX') && hasDir) {
      const p = this.pickPiece(eye, dir);
      if (p) {
        if (p.top) {
          this.events.push({ type: 'deny', reason: 'Remove the top one first' });
          this.flash('Remove the top one first');
        } else {
          this.removePiece(p);
        }
      }
    }

    this.updateGhost(this.target);
    this.updateHint(this.target);
  }

  private computeTarget(eye: THREE.Vector3, dir: THREE.Vector3): Target | null {
    const def = PIECES[this.sel];
    const hit = this.aim(eye, dir, def.stackable, SCAN);
    if (!hit) return null;
    const inReach = hit.t <= REACH + 1e-9;
    const x = snap(hit.x),
      z = snap(hit.z);
    const base = hit.base;
    const level: 0 | 1 = base ? 1 : 0;
    const y = base ? base.solid.y1 : deckY(sOf(z));
    const reason = this.evaluate(def, x, z, this.rot, level, base, y, inReach);
    return { x, z, y, rot: this.rot, level, base, valid: reason === null, reason: reason ?? '' };
  }

  /**
   * March the ray in STEP increments. It hits the deck where y <= deckY(s), or the top of a
   * stackable placed crate when the selected piece can stack.
   */
  private aim(eye: THREE.Vector3, dir: THREE.Vector3, stackable: boolean, maxT: number): Aim | null {
    for (let t = 0; t <= maxT + 1e-9; t += STEP) {
      const px = eye.x + dir.x * t,
        py = eye.y + dir.y * t,
        pz = eye.z + dir.z * t;
      const s = sOf(pz);
      let surf = -Infinity;
      let base: Piece | null = null;
      if (s >= 0 && s <= 1 && Math.abs(px) <= deckHalfWidth(s)) surf = deckY(s);
      if (stackable) {
        for (const pc of this.pieces) {
          if (pc.level !== 0 || !pc.def.stackable) continue;
          const top = pc.solid.y1;
          if (top > surf && this.shipSolids.inside(pc.solid, px, pz)) {
            surf = top;
            base = pc;
          }
        }
      }
      if (py <= surf) return { t, x: px, z: pz, y: surf, base };
    }
    return null;
  }

  /**
   * Placement rules, in the order they are reported. Returns the reason the piece cannot go
   * here, or null when it can.
   */
  private evaluate(def: PieceDef, x: number, z: number, rot: number, level: 0 | 1, base: Piece | null, y: number, inReach: boolean): string | null {
    if (!inReach) return 'Out of reach';
    if (level === 1 && (!base || !def.stackable || base.level !== 0 || !this.shipSolids.inside(base.solid, x, z))) return 'Blocked';

    const corners = footprint(def.hx, def.hz, x, z, rot);
    const pts = [...corners, { x, z }];
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }

    if (pts.some((p) => sOf(p.z) > S_MAX)) return 'Keep the helm clear';
    if (pts.some((p) => sOf(p.z) < S_MIN || Math.abs(p.x) > deckHalfWidth(sOf(p.z)) - EDGE_MARGIN)) return 'Off the deck';

    const zg = zOf(PLANK_S),
      xg = deckHalfWidth(PLANK_S) - PLANK_X_IN;
    if (maxZ > zg - PLANK_Z_HALF && minZ < zg + PLANK_Z_HALF && (maxX > xg || minX < -xg)) return 'Keep the gangway clear';

    const total = this.payloadKg() + def.mass;
    if (total > PAYLOAD_LIMIT + 1e-6) return `Too heavy · ${kgToT(total)} / ${kgToT(PAYLOAD_LIMIT)} t`;

    const top = y + def.height;
    for (const o of this.shipSolids.solids) {
      if (o.y1 <= y + EPS || o.y0 >= top - EPS) continue;
      if (overlapsSolid(def.hx, def.hz, x, z, rot, o)) return 'Blocked';
    }
    return null;
  }

  private placeTarget(t: Target): void {
    const def = PIECES[this.sel];
    this.spawn(def, t.x, t.z, t.rot, t.level, t.base);
    this.events.push({ type: 'place' });
    this.save();
  }

  private removePiece(p: Piece): void {
    this.dispose(p);
    this.events.push({ type: 'remove' });
    this.save();
  }

  /** nearest placed piece the ray passes through within reach */
  private pickPiece(eye: THREE.Vector3, dir: THREE.Vector3): Piece | null {
    let best: Piece | null = null;
    let bestT = REACH;
    for (const p of this.pieces) {
      const t = rayBox(eye, dir, p.solid, bestT);
      if (t !== null && t <= bestT) {
        best = p;
        bestT = t;
      }
    }
    return best;
  }

  private updateGhost(t: Target | null): void {
    if (!this.ghost) return;
    if (!this.active || !t) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.visible = true;
    this.ghost.position.set(t.x, t.y, t.z);
    this.ghost.rotation.set(0, t.rot, 0);
    if (this.ghostValid !== t.valid) {
      this.ghostMat.color.setHex(t.valid ? GHOST_OK : GHOST_BAD);
      this.ghostValid = t.valid;
    }
  }

  private updateHint(t: Target | null): void {
    if (this.noteT > 0) this.ui.setHint(this.note, true);
    else if (t && !t.valid) this.ui.setHint(t.reason, true);
    else this.ui.setHint(KEYS_HINT, false);
  }

  private flash(text: string): void {
    this.note = text;
    this.noteT = 1.6;
  }

  private rebuildGhost(): void {
    if (this.ghost) this.shipGroup.remove(this.ghost);
    const obj = this.models.get(PIECES[this.sel].model);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.material = this.ghostMat;
        o.castShadow = false;
        o.receiveShadow = false;
        o.renderOrder = 10;
      }
    });
    obj.visible = false;
    this.shipGroup.add(obj);
    this.ghost = obj;
    this.ghostValid = null;
  }

  private updatePops(dt: number): void {
    for (const p of this.pieces) {
      if (p.pop >= POP_T) continue;
      p.pop = Math.min(POP_T, p.pop + dt);
      const k = p.pop / POP_T;
      const sc = k < 0.5 ? 0.85 + (1.04 - 0.85) * (k * 2) : 1.04 + (1 - 1.04) * ((k - 0.5) * 2);
      p.obj.scale.setScalar(sc);
    }
  }

  private updateLights(ctx: BuildContext): void {
    const night = clamp01(ctx.night);
    const lamps = this.pieces.filter((p) => p.def.fn === 'light');

    // flame glow comes from the kit's shared fire material, which the world drives from night

    // nearest lamps get a real light; the rest are emissive only
    const lit = lamps
      .map((p) => ({ p, d: this.shipGroup.localToWorld(this.tmpW.copy(p.lightLocal!)).distanceToSquared(ctx.cameraWorld) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LIGHTS_MAX);
    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      const e = lit[i];
      if (!e || night <= 0.001) {
        L.visible = false;
        continue;
      }
      const brazier = e.p.def.id === 'brazier';
      L.visible = true;
      L.position.copy(e.p.lightLocal!);
      L.distance = brazier ? 12 : 9;
      const flicker = 1 + 0.05 * Math.sin(this.time * 5.3 + e.p.uid) + 0.03 * Math.sin(this.time * 12.1 + e.p.uid * 1.7);
      L.intensity = (brazier ? 14 : 6) * night * flicker;
    }
  }

  // ---------------------------------------------------------------- pieces

  private findBase(x: number, z: number): Piece | null {
    return this.pieces.find((p) => p.level === 0 && p.def.stackable && !p.top && this.shipSolids.inside(p.solid, x, z)) ?? null;
  }

  /** creates the model, solid, payload entry and (for altars) the interaction */
  private spawn(def: PieceDef, x: number, z: number, rot: number, level: 0 | 1, base: Piece | null): Piece {
    const y = base ? base.solid.y1 : deckY(sOf(z));
    const obj = this.models.get(def.model);
    obj.position.set(x, y, z);
    obj.rotation.set(0, rot, 0);
    obj.scale.setScalar(0.85);
    let fire: THREE.MeshStandardMaterial | null = null;
    obj.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const m = o.material;
      if (!Array.isArray(m) && m instanceof THREE.MeshStandardMaterial && m.emissive.getHex() === FIRE_EMISSIVE) fire = m;
    });
    this.shipGroup.add(obj);

    const solid: BoxSolid = {
      kind: 'box',
      cx: x,
      cz: z,
      hx: def.hx,
      hz: def.hz,
      rot,
      y0: y,
      y1: y + def.height,
      surface: 'wood',
      walkTop: def.walkTop,
    };
    this.shipSolids.add(solid);

    const load = { mass: def.mass, local: new THREE.Vector3(x, y + def.height / 2, z) };
    this.payload.push(load);

    let lightLocal: THREE.Vector3 | null = null;
    if (def.fn === 'light') lightLocal = new THREE.Vector3(x, y + (def.id === 'lamp_post' ? 1.78 : 0.92), z);

    const piece: Piece = {
      uid: ++this.uid,
      def,
      x,
      z,
      rot,
      level,
      y,
      obj,
      solid,
      load,
      base,
      top: null,
      pop: 0,
      fire,
      lightLocal,
      interact: null,
    };
    if (base) base.top = piece;

    if (def.fn === 'altar') {
      const interact: Interactable = {
        id: `altar-${piece.uid}`,
        label: 'Make offering',
        frame: 'ship',
        pos: new THREE.Vector3(x, y + def.height, z),
        radius: ALTAR_RADIUS,
        enabled: () => this.offeredDay !== this.dayNow,
        act: () => {
          this.crew.stamina = Math.min(1, this.crew.stamina + OFFERING_STAMINA);
          this.offeredDay = this.dayNow;
          this.events.push({ type: 'offering' });
        },
      };
      piece.interact = interact;
      this.interactions.list.push(interact);
    }

    this.pieces.push(piece);
    return piece;
  }

  /** removes everything a piece owns; no events, no save */
  private dispose(p: Piece): void {
    if (p.base) p.base.top = null;
    this.shipGroup.remove(p.obj);
    this.shipSolids.remove(p.solid);
    const i = this.payload.indexOf(p.load);
    if (i >= 0) this.payload.splice(i, 1);
    if (p.interact) {
      const j = this.interactions.list.indexOf(p.interact);
      if (j >= 0) this.interactions.list.splice(j, 1);
    }
    const k = this.pieces.indexOf(p);
    if (k >= 0) this.pieces.splice(k, 1);
  }
}
