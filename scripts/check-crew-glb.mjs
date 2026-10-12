// Checks public/assets/models/crew.glb written by tools/blender/rowers.py.
// Parses the GLB JSON chunk: armature nodes, bones per figure, triangles, primitives, clips.
// Clip checks: no sign-flipped quaternion keys, no bone rotating more than 20 deg between 120 Hz samples of
// an AnimationMixer on each figure, and every track targets an unsuffixed bone name.
// Run from the repo root: node scripts/check-crew-glb.mjs [path]
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const file = process.argv[2] ?? path.resolve('public/assets/models/crew.glb');
const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));

const nodes = gltf.nodes ?? [];
const meshes = gltf.meshes ?? [];
const skins = gltf.skins ?? [];
const accessors = gltf.accessors ?? [];
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

// armature nodes: the nodes that hold a skinned mesh child, named by figure
const figNodes = nodes.map((n, i) => ({ n, i })).filter(({ n }) => /^fig_rower_[abc]$/.test(n.name ?? ''));
console.log('armature nodes:', figNodes.map(({ n }) => n.name).join(', ') || '(none)');
check(figNodes.length === 3, `expected 3 armature nodes, found ${figNodes.length}`);

const countTris = (mesh) => mesh.primitives.reduce((sum, p) => {
  const mode = p.mode ?? 4;
  if (mode !== 4) return sum;
  const n = p.indices !== undefined ? accessors[p.indices].count : accessors[p.attributes.POSITION].count;
  return sum + n / 3;
}, 0);

const allBones = new Set();
for (const { n } of figNodes) {
  // mesh node named <fig>_mesh, or a child mesh of the armature node
  const meshNode = nodes.find((m) => m.name === `${n.name}_mesh` && m.mesh !== undefined)
    ?? nodes.find((m) => m.mesh !== undefined && m.skin !== undefined && m.name?.startsWith(n.name));
  check(!!meshNode, `${n.name}: no mesh node named ${n.name}_mesh`);
  const skin = meshNode ? skins[meshNode.skin] : undefined;
  const mesh = meshNode ? meshes[meshNode.mesh] : undefined;
  const bones = skin ? skin.joints.map((j) => nodes[j].name) : [];
  bones.forEach((b) => allBones.add(b));
  const dotted = bones.filter((b) => b.includes('.'));
  check(dotted.length === 0, `${n.name}: bone names with dots: ${dotted.join(',')}`);
  const tris = mesh ? countTris(mesh) : 0;
  const prims = mesh ? mesh.primitives.length : 0;
  const nonDeform = bones.filter((b) => b === 'root').length;
  console.log(`\n${n.name}`);
  console.log(`  mesh node: ${meshNode?.name ?? '-'}  primitives: ${prims}  triangles: ${tris}`);
  console.log(`  bones: ${bones.length}  ${bones.join(' ')}`);
  check(bones.length === 20, `${n.name}: expected 20 bones, found ${bones.length}`);
  check(prims === 1, `${n.name}: expected 1 primitive, found ${prims}`);
  check(nonDeform <= 1, `${n.name}: root listed more than once`);
  check(tris > 1500 && tris < 2600, `${n.name}: triangles ${tris} outside 1500..2600`);
}

const anims = gltf.animations ?? [];
console.log('\nclips:');
for (const a of anims) {
  const targets = new Set(a.channels.map((c) => `${nodes[c.target.node]?.name}`));
  const perPath = a.channels.reduce((m, c) => (m[c.target.path] = (m[c.target.path] ?? 0) + 1, m), {});
  console.log(`  ${a.name}: channels ${a.channels.length}, bones ${targets.size}, by path ${JSON.stringify(perPath)}`);
}
const clipNames = anims.map((a) => a.name);
for (const c of ['walk', 'idle_stand', 'rest_sit']) check(clipNames.includes(c), `missing clip ${c}`);
check(anims.every((a) => a.channels.length < 66), 'a clip has 66 or more channels');

console.log(`\nunique bone names across figures: ${allBones.size}`);

// ------------------------------------------------------------------ clip checks
const binStart = 20 + jsonLen + 8;
const bin = buf.subarray(binStart);
const readVec4 = (idx) => {
  const acc = accessors[idx], bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride = bv.byteStride ?? 16;
  const out = [];
  for (let e = 0; e < acc.count; e++) {
    const off = base + e * stride;
    out.push([0, 1, 2, 3].map((c) => bin.readFloatLE(off + 4 * c)));
  }
  return out;
};
// spline values sit at index 1 of each (in, value, out) triplet
const keyValues = (smp) => {
  const vals = readVec4(smp.output);
  return smp.interpolation === 'CUBICSPLINE' ? vals.filter((_, i) => i % 3 === 1) : vals;
};

let flipCount = 0;
for (const a of anims) {
  for (const c of a.channels) {
    if (c.target.path !== 'rotation') continue;
    const q = keyValues(a.samplers[c.sampler]);
    for (let i = 1; i < q.length; i++) {
      const d = q[i].reduce((sum, v, j) => sum + v * q[i - 1][j], 0);
      if (d < 0) {
        flipCount++;
        if (flipCount <= 5) console.log(`  flip: ${a.name} ${nodes[c.target.node].name} key ${i}, dot ${d.toFixed(3)}`);
      }
    }
  }
}
check(flipCount === 0, `${flipCount} consecutive quaternion keys with negative dot`);

// every track must target an unsuffixed bone of fig_rower_a (the figure whose clips the runtime uses)
const figA = figNodes.find(({ n }) => n.name === 'fig_rower_a');
const aBones = new Set(figA ? (skins[nodes.find((m) => m.name === 'fig_rower_a_mesh')?.skin]?.joints ?? []) : []);
for (const a of anims) {
  const bad = a.channels.filter((c) => !aBones.has(c.target.node)).length;
  check(bad === 0, `${a.name}: ${bad} channels target nodes outside fig_rower_a's skeleton`);
}

const loaded = await new Promise((res, rej) => new GLTFLoader().parse(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
for (const a of loaded.animations) {
  const suffixed = a.tracks.filter((t) => /_\d+$/.test(t.name.split('.')[0]));
  check(suffixed.length === 0, `${a.name}: ${suffixed.length} tracks target suffixed names, e.g. ${suffixed[0]?.name}`);
}

// sample each clip at 120 Hz on each figure; the figure's bones are renamed without the loader suffix,
// as the runtime does when it clones the figure
const FIG_NAMES = ['fig_rower_a', 'fig_rower_b', 'fig_rower_c'];
const MAX_STEP_DEG = 20;
const worst = {};
for (const figName of FIG_NAMES) {
  const root = loaded.scene.getObjectByName(figName);
  if (!root) { check(false, `${figName} missing from loaded scene`); continue; }
  const bones = [];
  root.traverse((o) => { if (o.isBone) { o.name = o.name.replace(/_\d+$/, ''); bones.push(o); } });
  for (const clip of loaded.animations) {
    for (const b of bones) b.quaternion.set(0, 0, 0, 1);
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
    const dt = 1 / 120;
    let prev = null, maxDeg = 0, maxBone = '';
    for (let k = 0; k * dt < clip.duration; k++) {
      mixer.setTime(k * dt);
      if (prev) {
        bones.forEach((b, i) => {
          const d = Math.min(1, Math.abs(prev[i].dot(b.quaternion)));
          const deg = 2 * Math.acos(d) * 180 / Math.PI;
          if (deg > maxDeg) { maxDeg = deg; maxBone = b.name; }
        });
      }
      prev = bones.map((b) => b.quaternion.clone());
    }
    mixer.uncacheRoot(root);
    worst[`${figName}/${clip.name}`] = { maxDeg: +maxDeg.toFixed(2), bone: maxBone };
    check(maxDeg <= MAX_STEP_DEG, `${figName} ${clip.name}: ${maxBone} rotates ${maxDeg.toFixed(1)} deg in one 120 Hz step`);
  }
}
console.log('\nlargest bone step per figure and clip (120 Hz):');
for (const [k, v] of Object.entries(worst)) console.log(`  ${k}: ${v.maxDeg} deg (${v.bone})`);

if (failures.length) {
  console.log('\nFAILED:\n  ' + failures.join('\n  '));
  process.exitCode = 1;
} else {
  console.log('\nOK');
}
