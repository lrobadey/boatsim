import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
const path = process.argv[2];
const buf = fs.readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
const skinned = [];
gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });
console.log('scene children:', gltf.scene.children.map((c) => `${c.type}:${c.name}`).join(', '));
console.log('skinned meshes:', skinned.map((m) => `${m.name} mat=${m.material.name}`).join(' | '));
const sk = skinned[0].skeleton;
console.log('bones', sk.bones.length, sk.bones.map((b) => b.name).join(','));
console.log('all primitives share skeleton:', skinned.every((m) => m.skeleton === sk), 'bindMode', skinned[0].bindMode);
// inverse bind sanity: boneMatrixWorld * boneInverse should be ~identity in bind pose
gltf.scene.updateMatrixWorld(true);
let maxErr = 0;
for (let i = 0; i < sk.bones.length; i++) {
  const m = new THREE.Matrix4().multiplyMatrices(sk.bones[i].matrixWorld, sk.boneInverses[i]);
  const e = m.elements; const id = new THREE.Matrix4().elements;
  for (let k = 0; k < 16; k++) maxErr = Math.max(maxErr, Math.abs(e[k] - id[k]));
}
console.log('max |boneWorld*inverseBind - I| in bind pose:', maxErr.toExponential(2));
// weights
let tris = 0, verts = 0, badW = 0, maxInf = 0;
for (const m of skinned) {
  const g = m.geometry; verts += g.attributes.position.count; tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  const w = g.attributes.skinWeight;
  for (let i = 0; i < w.count; i++) { const s = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i); if (Math.abs(s - 1) > 1e-3) badW++; let n=0; for (const c of [w.getX(i),w.getY(i),w.getZ(i),w.getW(i)]) if (c>0) n++; maxInf=Math.max(maxInf,n); }
}
console.log(`tris ${tris} verts ${verts} weight-sum errors ${badW} max influences ${maxInf}`);
const bb = new THREE.Box3();
for (const m of skinned) { m.computeBoundingBox?.(); }
bb.setFromObject(gltf.scene, true);
console.log('bbox', bb.min.toArray().map(v=>v.toFixed(3)), bb.max.toArray().map(v=>v.toFixed(3)));
console.log('animations:', gltf.animations.map((a) => `${a.name} ${a.duration.toFixed(2)}s tracks=${a.tracks.map(t=>t.name).join(',')}`));
// clone + mixer
const clone = SkeletonUtils.clone(gltf.scene);
let csk; clone.traverse((o) => { if (o.isSkinnedMesh) csk = o.skeleton; });
console.log('SkeletonUtils.clone gives own skeleton:', csk !== sk, 'plain clone shares:', (() => { let s2; gltf.scene.clone(true).traverse(o=>{ if (o.isSkinnedMesh) s2=o.skeleton;}); return s2 === sk; })());
const mixer = new THREE.AnimationMixer(clone);
const act = mixer.clipAction(gltf.animations[0]); act.play(); mixer.update(2.0);
const chest = clone.getObjectByName('chest');
console.log('mixer drove chest quaternion at t=2s:', chest.quaternion.toArray().map(v=>v.toFixed(4)));
// rest-pose bone local axes: which local axis points to the child?
for (const n of ['upperarm_L','thigh_L','spine','hand_L']) {
  const b = gltf.scene.getObjectByName(n); const c = b.children.find(x=>x.isBone);
  if (c) console.log(n, 'child offset (local):', c.position.toArray().map(v=>v.toFixed(3)));
}
