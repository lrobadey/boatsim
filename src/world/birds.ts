import * as THREE from 'three';
import { patchMaterial, shared } from '../gfx/shared';
import { rng } from '../core/util';
import type { WorldGenResult } from './worldgenTypes';

/** Gulls wheeling over headlands and the harbour; wings flap in the vertex shader. */
export class Birds {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private birds: { cx: number; cz: number; cy: number; r: number; speed: number; phase: number; tilt: number }[] = [];
  private M = new THREE.Matrix4();
  private t = 0;

  constructor(gen: WorldGenResult) {
    const r = rng(12);
    const anchors: { x: number; z: number; y: number }[] = [];
    anchors.push({ x: gen.sites.harbour.x, z: gen.sites.harbour.z, y: 25 });
    anchors.push({ x: gen.sites.temple.x, z: gen.sites.temple.z, y: gen.sites.temple.y + 30 });
    for (const isl of gen.islands.slice(0, 6)) anchors.push({ x: isl.cx, z: isl.cz, y: Math.max(40, isl.peak * 0.6) });
    for (const a of anchors)
      for (let i = 0; i < 7; i++)
        this.birds.push({ cx: a.x + (r() - 0.5) * 200, cz: a.z + (r() - 0.5) * 200, cy: a.y + r() * 40, r: 30 + r() * 90, speed: (0.15 + r() * 0.2) * (r() < 0.5 ? -1 : 1), phase: r() * 100, tilt: r() });

    // body + two wings; wing vertices carry a flap weight in uv.x
    const pos = [
      // left wing
      0, 0, -0.15, -0.9, 0.05, 0.05, 0, 0, 0.25,
      -0.9, 0.05, 0.05, -1.5, -0.05, 0.25, -0.3, 0, 0.2,
      // right wing
      0, 0, 0.25, 0.9, 0.05, 0.05, 0, 0, -0.15,
      0.9, 0.05, 0.05, 0.3, 0, 0.2, 1.5, -0.05, 0.25,
      // body
      0, 0.05, -0.4, 0.08, 0, 0.35, -0.08, 0, 0.35,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color: 0xf4f2ee, roughness: 0.8, side: THREE.DoubleSide });
    patchMaterial(
      m,
      (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3(position);
             float span = abs(position.x);
             float ph = instanceMatrix[3][0] * 0.37 + instanceMatrix[3][2] * 0.21;
             float flap = sin(uTime * 7.0 + ph) * (0.5 + 0.5 * sin(uTime * 0.4 + ph)) ;
             transformed.y += flap * span * span * 0.35;`,
          );
      },
      'bird',
    );
    this.mesh = new THREE.InstancedMesh(g, m, this.birds.length);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(dt: number, camera: THREE.Camera) {
    this.t += dt;
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    this.birds.forEach((b, i) => {
      const a = b.phase + this.t * b.speed;
      p.set(b.cx + Math.cos(a) * b.r, b.cy + Math.sin(this.t * 0.3 + b.phase) * 6, b.cz + Math.sin(a) * b.r);
      const heading = -a - (b.speed > 0 ? 0 : Math.PI);
      e.set(0, heading, (b.speed > 0 ? -1 : 1) * 0.35, 'YXZ');
      q.setFromEuler(e);
      this.M.compose(p, q, s);
      this.mesh.setMatrixAt(i, this.M);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
