import * as THREE from 'three';

/**
 * Look-at-and-press interactions (spec §3.5). Each frame the controller picks the enabled entry
 * closest to the view centre, inside its radius and a 30° cone. `pos` is ship-local for 'ship'
 * entries and world for 'world' ones; the controller may move it between frames (climb point).
 */
export interface Interactable {
  id: string;
  label: string;
  frame: 'ship' | 'world';
  pos: THREE.Vector3;
  /** max distance from the eye (m) */
  radius: number;
  enabled(): boolean;
  act(): void;
}

const CONE = Math.cos((30 * Math.PI) / 180);

export class Interactions {
  list: Interactable[] = [];
  target: Interactable | null = null;
  private w = new THREE.Vector3();
  private d = new THREE.Vector3();

  update(eyeWorld: THREE.Vector3, viewDirWorld: THREE.Vector3, shipOrigin: THREE.Vector3, shipQuat: THREE.Quaternion): void {
    let best: Interactable | null = null;
    let bestCos = CONE;
    const view = this.d.copy(viewDirWorld);
    if (view.lengthSq() < 1e-12) {
      this.target = null;
      return;
    }
    view.normalize();
    for (const it of this.list) {
      if (!it.enabled()) continue;
      if (it.frame === 'ship') this.w.copy(it.pos).applyQuaternion(shipQuat).add(shipOrigin);
      else this.w.copy(it.pos);
      const dx = this.w.x - eyeWorld.x;
      const dy = this.w.y - eyeWorld.y;
      const dz = this.w.z - eyeWorld.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > it.radius || dist < 1e-3) continue;
      const cos = (dx * view.x + dy * view.y + dz * view.z) / dist;
      if (cos >= bestCos) {
        bestCos = cos;
        best = it;
      }
    }
    this.target = best;
  }
}
