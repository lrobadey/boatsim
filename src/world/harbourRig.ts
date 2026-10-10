import * as THREE from 'three';
import { patchMaterial } from '../gfx/shared';
import { TRIREME, type ShipDesign } from '../ship/design';
import type { Mooring } from '../ship/mooring';

const SEG = 12;
const MAX_ROPES = 5;
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _aq = new THREE.Quaternion();
const _ay = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
// anchor lying on the foredeck in ship-local space: shank fore-aft, stock across the deck, flukes up.
// The kit's anchor is built shank-up (y), stock along z, flukes along x: this cyclic map sends (x, y, z) to (z, x, y).
const ANCHOR_BASIS = new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/**
 * Visible ship-to-shore rigging: mooring lines sagging between cleats and bollards, the anchor rode
 * running down from the bow, and the gangplank swinging out onto the quay.
 */
export class HarbourRig {
  readonly group = new THREE.Group();
  private ropes: THREE.InstancedMesh;
  private plank: THREE.Object3D;
  private plankLen = 3;
  private anchor: THREE.Object3D | null = null;
  /** height of the anchor model's ring end above its origin (model is built shank-up along +y) */
  private anchorTop = 1;
  /** rode fairlead at the bow and the stowed anchor's pose, ship-local, for this ship's deck */
  private readonly bow: THREE.Vector3;
  private readonly anchorLocal: THREE.Matrix4;

  constructor(design: ShipDesign = TRIREME) {
    const { deck, hull } = design;
    this.bow = new THREE.Vector3(0, deck.deckY(design.anchor.s), hull.zOf(design.anchor.s));
    // stowed on the foredeck, inboard of the rail
    const s = design.kind === 'trireme' ? 0.1 : 0.12;
    const x = design.kind === 'trireme' ? 0.6 : Math.max(0, deck.deckHalfWidth(s) - 0.4);
    const dz = design.kind === 'trireme' ? 0.8 : 0.3;
    this.anchorLocal = new THREE.Matrix4().compose(
      new THREE.Vector3(x, deck.deckY(s) + 0.3, hull.zOf(s) + dz),
      new THREE.Quaternion().setFromRotationMatrix(ANCHOR_BASIS),
      new THREE.Vector3(1, 1, 1),
    );
    const rope = patchMaterial(new THREE.MeshStandardMaterial({ color: 0xb9a27a, roughness: 0.92 }), undefined, 'rope');
    this.ropes = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 5, 1, true).translate(0, 0.5, 0), rope, MAX_ROPES * SEG);
    this.ropes.castShadow = true;
    this.ropes.frustumCulled = false;
    this.ropes.count = 0;
    this.group.add(this.ropes);
    const wood = patchMaterial(new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.85 }), undefined, 'plank');
    // fallback plank (origin = ship end, extends along -z), replaced by the modelled one when loaded
    const g = new THREE.Group();
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 3).translate(0, -0.03, -1.5), wood);
    board.castShadow = board.receiveShadow = true;
    g.add(board);
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.03, 0.05).translate(0, 0.015, -0.2 - i * 0.37), wood);
      g.add(c);
    }
    this.plank = g;
    this.plank.visible = false;
    this.group.add(this.plank);
  }

  /** swap in a modelled gangplank (origin at the ship end, extends along -z, top at y = 0) */
  setPlankModel(obj: THREE.Object3D, length: number) {
    this.group.remove(this.plank);
    this.plank = obj;
    this.plankLen = length;
    this.plank.visible = false;
    this.group.add(obj);
  }

  /** the anchor as stowed on the foredeck; shown only while she is not riding to an anchor */
  setAnchorModel(obj: THREE.Object3D) {
    if (this.anchor) this.group.remove(this.anchor);
    // local extent at identity, before the model is placed in the rig
    this.anchorTop = new THREE.Box3().setFromObject(obj).max.y;
    this.anchor = obj;
    this.group.add(obj);
  }

  update(moor: Mooring, ship: THREE.Object3D) {
    let n = 0;
    const rope = (from: THREE.Vector3, to: THREE.Vector3, sag: number) => {
      for (let i = 0; i < SEG && n < MAX_ROPES * SEG; i++) {
        catenary(from, to, sag, i / SEG, _p);
        catenary(from, to, sag, (i + 1) / SEG, _q);
        const len = _p.distanceTo(_q);
        _quat.setFromUnitVectors(UP, _s.subVectors(_q, _p).normalize());
        _m.compose(_p, _quat, _s.set(1, len, 1));
        this.ropes.setMatrixAt(n++, _m);
      }
    };
    for (const l of moor.lines) {
      _a.copy(l.local).applyMatrix4(ship.matrixWorld);
      _b.copy(l.anchor).setY(l.anchor.y + 0.65);
      rope(_a, _b, (1 - l.tension) * 0.06 * _a.distanceTo(_b) + 0.05);
    }
    const phase = moor.anchorPhase;
    if (phase !== 'stowed') {
      _a.copy(this.bow).applyMatrix4(ship.matrixWorld);
      if (phase === 'dropping' || phase === 'lifting') {
        // the rode runs from the fairlead to the anchor ring, nearly straight
        rope(_a, moor.anchorPos, 0.02);
      } else {
        // holding or weighing: slack rode sags, taut rode does not
        const hd = Math.hypot(moor.anchorPos.x - _a.x, moor.anchorPos.z - _a.z);
        rope(_a, moor.anchorPos, Math.max(0.05, 0.2 * (moor.rode - hd)));
      }
    }
    this.ropes.count = n;
    this.ropes.instanceMatrix.needsUpdate = true;

    if (this.anchor) {
      // copy the ship's transform each frame so the anchor rides with her without being a child of her group
      this.anchor.visible = true;
      if (phase === 'stowed') {
        _m.multiplyMatrices(ship.matrixWorld, this.anchorLocal).decompose(this.anchor.position, this.anchor.quaternion, this.anchor.scale);
      } else {
        // ship's yaw from her forward axis
        ship.getWorldQuaternion(_wq);
        _fwd.set(0, 0, -1).applyQuaternion(_wq);
        const yaw = Math.atan2(-_fwd.x, -_fwd.z);
        if (phase === 'dropping' || phase === 'lifting') {
          // hangs from its ring, shank down: built shank-up, so a turn about y leaves the shank vertical
          _ay.setFromAxisAngle(UP, yaw);
          this.anchor.quaternion.copy(_ay);
          this.anchor.position.copy(moor.anchorPos).sub(_b.set(0, this.anchorTop, 0));
        } else {
          // holding or weighing: lies on the seabed, shank along the rode toward the bow
          _a.copy(this.bow).applyMatrix4(ship.matrixWorld);
          const heading = Math.atan2(_a.x - moor.anchorPos.x, _a.z - moor.anchorPos.z);
          _ay.setFromAxisAngle(UP, heading);
          _aq.setFromRotationMatrix(ANCHOR_BASIS);
          this.anchor.quaternion.copy(_ay).multiply(_aq);
          this.anchor.position.copy(moor.anchorPos).add(_b.set(0, 0.15, 0));
        }
      }
    }

    const pl = moor.plank;
    this.plank.visible = !!pl && pl.deployed > 0.01;
    if (pl && this.plank.visible) {
      _a.copy(pl.deckLocal).applyMatrix4(ship.matrixWorld);
      // stowed: standing up on deck; deployed: resting on the quay
      _q.copy(pl.deckLocal).setY(pl.deckLocal.y + this.plankLen).applyMatrix4(ship.matrixWorld);
      const k = pl.deployed * pl.deployed * (3 - 2 * pl.deployed);
      _b.lerpVectors(_q, pl.shoreWorld, k);
      _m.lookAt(_a, _b, UP); // -z (forward) points from the ship end toward the shore
      this.plank.position.copy(_a);
      this.plank.quaternion.setFromRotationMatrix(_m);
      this.plank.scale.set(1, 1, _a.distanceTo(_b) / this.plankLen);
    }
  }
}

/** point on a hanging rope from a to b with midspan sag (approximated by a parabola) */
function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, t: number, out: THREE.Vector3) {
  return out.lerpVectors(a, b, t).setY(out.y - 4 * sag * t * (1 - t));
}
