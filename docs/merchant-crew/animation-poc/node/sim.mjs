// Drive RowerRig with synthetic, varying sweep strokes on the merchant's starboard fore sweep (slot 1)
// and measure what the skinned skeleton actually does (bone FK through three.js, not the solver's own
// numbers). Usage: node sim.mjs <glb> <scenario: full|reduced> [snapdir]
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RowerRig } from './rowerIK.mjs';

const [, , glbPath, scenario = 'full', snapDir] = process.argv;
const buf = fs.readFileSync(glbPath);
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));

// --- merchant slot 1 (starboard, s 0.2) from DESIGNS.merchant.oars.slots()
const slot = { side: 1, x: 1.5766986, y: 1.1713450, z: -4.13361, inboard: 1.5, bladeRadius: 3.65 };
const deckY = 0.7513;
const wetDepth = 0.12; // assumption (ROWING_CONSTANTS.wetDepth not read)
const dipOf = (wet) => Math.asin(Math.min(0.9, Math.max(-0.2, (slot.y + (wet ? wetDepth : -0.42)) / slot.bladeRadius)));
function oar(sweep, dip, out) {
  const s = slot.side, ca = Math.cos(sweep), sa = Math.sin(sweep), cd = Math.cos(dip), sd = Math.sin(dip);
  out.axis.set(s * cd * ca, -sd, -cd * sa);
  out.pivot.set(slot.x, slot.y, slot.z);
  out.end.copy(out.pivot).addScaledVector(out.axis, -(slot.inboard - 0.08));   // end hand
  out.inner.copy(out.pivot).addScaledVector(out.axis, -(slot.inboard - 0.08 - GRIP)); // second hand, 54 cm along
  return out;
}
const GRIP = +(process.env.GRIP ?? 0.45), D0 = +(process.env.D0 ?? 0.60), LAT = +(process.env.LAT ?? 0.15);
const O = { axis: new THREE.Vector3(), pivot: new THREE.Vector3(), end: new THREE.Vector3(), inner: new THREE.Vector3() };

const ARC = scenario === 'reduced' ? { fwd: 0.45, back: -0.38 } : { fwd: 0.72, back: -0.58 };

// --- scene: ship group (identity = ship-local) -> figure
const ship = new THREE.Group();
const fig = SkeletonUtils.clone(gltf.scene);
ship.add(fig);
const facing = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(0, 1, 0);
// stance from the oar geometry: centre d0 behind the mid-stroke handle, on the deck
oar((ARC.fwd + ARC.back) / 2, dipOf(true), O);
const Hmid = O.end.clone().add(O.inner).multiplyScalar(0.5);
const center = new THREE.Vector3(Hmid.x + LAT, deckY, Hmid.z - D0);
fig.position.copy(center); fig.position.y = deckY;
fig.rotation.y = Math.PI;
ship.updateMatrixWorld(true);
const rig = new RowerRig(fig, { seed: 3, minimalTwist: process.env.MINTWIST === '1' });
rig.setStance(center, facing, up, +(process.env.SPF ?? 0.40), +(process.env.SPB ?? 0.30), 0.16);
let skinned = []; fig.traverse((o) => { if (o.isSkinnedMesh) skinned.push(o); });

// --- stroke generator: every stroke draws a new length, rate, drive ratio and effort
let rnd = 12345; const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
const dt = 1 / 60, T = 40;
let stroke = null, tIn = 0;
function newStroke(t) {
  const amp = 0.55 + 0.45 * rand();
  const spm = 14 + 16 * rand();
  const period = 60 / spm, drive = Math.min(0.48 * period, 0.9 + 0.5 * rand());
  const mid = (ARC.fwd + ARC.back) / 2, half = (ARC.fwd - ARC.back) / 2 * amp;
  return { t0: t, period, drive, c: mid + half + (rand() - 0.5) * 0.08, f: mid - half, effort: 0.3 + 0.7 * rand(), amp, spm };
}
const ease = (x) => x * x * (3 - 2 * x);
function stateAt(t) {
  // 0-28 s rowing (varied), 28-33 s hold water, 33-40 s easy rowing again
  if (t >= 28 && t < 33) {
    const k = Math.min(1, (t - 28) / 0.6);
    const sweep = (1 - k) * (stroke ? stroke.lastSweep : 0.07) + k * (0.07 + 0.03 * Math.sin(t * 3));
    if (stroke) { stroke.lastSweep = sweep; stroke.period = 0; }   // next stroke starts from here
    return { sweep, dip: dipOf(true), feather: 0, effort: 0.9, driving: true, mode: 'hold' };
  }
  if (!stroke || t - stroke.t0 >= stroke.period) { const last = stroke?.lastSweep; stroke = newStroke(t); if (last !== undefined) stroke.from = last; }
  const tau = t - stroke.t0, D = stroke.drive, R = stroke.period - D;
  let sweep, dip, feather, driving;
  if (tau < D) { const x = ease(tau / D); sweep = (stroke.from ?? stroke.c) + (stroke.f - (stroke.from ?? stroke.c)) * x; dip = dipOf(true); feather = 0; driving = true; }
  else { const x = ease((tau - D) / R); sweep = stroke.f + (stroke.c - stroke.f) * x; dip = dipOf(true) + (dipOf(false) - dipOf(true)) * Math.sin(Math.PI * Math.min(1, x * 1.15)); feather = 0.25 * Math.sin(Math.PI * x); driving = false; }
  stroke.lastSweep = sweep;
  return { sweep, dip, feather, effort: stroke.effort, driving, mode: 'row' };
}

// --- metrics
const W = new THREE.Vector3(), tmp = new THREE.Vector3();
const handTip = (s) => { const b = rig.bones['hand_' + s]; return tmp.set(0, rig.len.hand, 0).applyMatrix4(b.matrixWorld).clone(); };
const toeOf = (s) => new THREE.Vector3(0, 0.19, 0).applyMatrix4(rig.bones['foot_' + s].matrixWorld);
let toe0 = null;
const prevQ = {}; for (const n in rig.bones) prevQ[n] = new THREE.Quaternion();
const stats = { hand: [], toe: 0, angStep: 0, angStepBone: '', unreach: 0, frames: 0, solveMs: [], twistMax: 0, elbowMin: 9, kneeMin: 9, pitchMin: 9, pitchMax: -9, byAmp: {} };
const snaps = [];
const shipQ = new THREE.Quaternion();
let solveTotal = 0;
for (let i = 0; i < T / dt; i++) {
  const t = i * dt;
  const st = stateAt(t);
  oar(st.sweep, st.dip, O);
  // which hand is the figure's right? larger component along body right (f x u)
  const r = new THREE.Vector3().crossVectors(facing, up);
  const endIsRight = O.end.clone().sub(center).dot(r) > O.inner.clone().sub(center).dot(r);
  const gripR = endIsRight ? O.end : O.inner, gripL = endIsRight ? O.inner : O.end;
  // ship motion: roll 6 deg / 7 s, pitch 2 deg / 5.3 s; heave 0.4 m / 6 s
  const roll = 0.105 * Math.sin(2 * Math.PI * t / 7), pitch = 0.035 * Math.sin(2 * Math.PI * t / 5.3);
  shipQ.setFromEuler(new THREE.Euler(pitch, 0, roll));
  const worldUp = new THREE.Vector3(0, 1, 0).applyQuaternion(shipQ.clone().invert());
  const heaveAcc = -0.4 * (2 * Math.PI / 6) ** 2 * Math.sin(2 * Math.PI * t / 6);
  // gaze: the stroke leader aft (another rower at the after sweeps) most of the time, the helm now and then
  const gaze = (Math.floor(t / 5) % 3 === 2) ? new THREE.Vector3(0, 2.5, 5.2) : new THREE.Vector3(-0.5, 2.2, 3.4);
  const t0 = performance.now();
  rig.solve({ gripL, gripR, loomAxis: O.axis, feather: st.feather, effort: st.effort, driving: st.driving, gaze, worldUp, heaveAcc }, dt);
  fig.updateMatrixWorld(true);
  for (const m of skinned) m.skeleton.update();
  if (process.env.TRACE2 && i % 6 === 0 && t < 8) console.log('tr', t.toFixed(2), st.mode, st.driving ? 'D' : 'R', 'sweep', st.sweep.toFixed(2), 'd', rig.debug.d.toFixed(2), 'pf', rig.debug.pelvisFwd.toFixed(2), 'th', rig.debug.pitch.toFixed(2), 'def', rig.debug.reachDeficit.toFixed(2), 'err', rig.debug.err.L.toFixed(2), rig.debug.err.R.toFixed(2), 'ext', rig.debug.extL.toFixed(2), rig.debug.extR.toFixed(2), 'shErr', rig.debug.shErrL.toFixed(3), rig.debug.shErrR.toFixed(3), 'pel', rig.debug.pelErr.toFixed(3), 'wg', rig.debug.wgErrL.toFixed(3));
  const ms = performance.now() - t0;
  if (i > 60) { stats.solveMs.push(ms); solveTotal += ms; }
  if (i < 30) { for (const n in rig.bones) prevQ[n].copy(rig.bones[n].getWorldQuaternion(new THREE.Quaternion())); continue; } // settle
  if (!toe0) toe0 = { L: toeOf('L'), R: toeOf('R') };
  stats.frames++;
  const eR = handTip('R').distanceTo(gripR), eL = handTip('L').distanceTo(gripL);
  const e = Math.max(eR, eL);
  stats.hand.push(e);
  (stats.split ||= { L: 0, R: 0, wL: 0, wR: 0, n: 0 });
  stats.split.L += eL; stats.split.R += eR; stats.split.wL += rig.debug.err.L; stats.split.wR += rig.debug.err.R; stats.split.n++;
  if (e > 0.03) stats.unreach++;
  const ampKey = st.mode === 'hold' ? 'hold' : (stroke.amp < 0.7 ? 'amp<0.70' : stroke.amp < 0.85 ? 'amp0.70-0.85' : 'amp>0.85');
  const b = (stats.byAmp[ampKey] ||= { n: 0, max: 0, sum: 0, bad: 0 });
  b.n++; b.max = Math.max(b.max, e); b.sum += e; if (e > 0.03) b.bad++;
  for (const s of ['L', 'R']) {
    const toeSlide = toeOf(s).distanceTo(toe0[s]);
    stats.toe = Math.max(stats.toe, toeSlide);
  }
  for (const n in rig.bones) {
    const q = rig.bones[n].getWorldQuaternion(new THREE.Quaternion());
    const a = 2 * Math.acos(Math.min(1, Math.abs(q.dot(prevQ[n])))) * 180 / Math.PI;
    if (process.env.TRACE && a > 8) console.log('step', n, a.toFixed(1), 't', t.toFixed(3), 'mode', st.mode, 'sweep', st.sweep.toFixed(3), 'dip', st.dip.toFixed(3), 'pitch', rig.debug.pitch.toFixed(3), 'def', rig.debug.reachDeficit.toFixed(3), 'errR', rig.debug.err.R.toFixed(3));
    if (a > stats.angStep) { stats.angStep = a; stats.angStepBone = `${n} @${t.toFixed(2)}s`; }
    prevQ[n].copy(q);
  }
  const bone = (n) => rig.bones[n].getWorldPosition(new THREE.Vector3());
  for (const s of ['L', 'R']) {
    const elb = bone('upperarm_' + s).sub(bone('forearm_' + s)).angleTo(bone('hand_' + s).sub(bone('forearm_' + s)));
    const kn = bone('thigh_' + s).sub(bone('shin_' + s)).angleTo(bone('foot_' + s).sub(bone('shin_' + s)));
    stats.elbowMin = Math.min(stats.elbowMin, elb); if (kn < stats.kneeMin) { stats.kneeMin = kn; stats.kneeAt = `${s} t=${t.toFixed(2)} pf=${rig.debug.pelvisFwd.toFixed(2)} d=${rig.debug.d.toFixed(2)}`; }
    stats.twistMax = Math.max(stats.twistMax, rig.twistAngle[s]);
  }
  stats.deficit = Math.max(stats.deficit || 0, rig.debug.reachDeficit);
  stats.pitchMin = Math.min(stats.pitchMin, rig.debug.pitch); stats.pitchMax = Math.max(stats.pitchMax, rig.debug.pitch);
  // snapshots: catch, mid-drive, finish, mid-recovery of one long stroke, and hold water
  if (snapDir) {
    const tau = st.mode === 'row' ? t - stroke.t0 : -1;
    const want = [];
    if (st.mode === 'row' && stroke.amp > 0.8 && snaps.filter((x) => x.tag.startsWith('row')).length < 4) {
      const ph = tau / stroke.period, D = stroke.drive / stroke.period;
      for (const [tag, p] of [['row1_catch', 0.0], ['row2_middrive', D * 0.5], ['row3_finish', D], ['row4_midrecovery', D + (1 - D) * 0.5]])
        if (Math.abs(ph - p) < dt / stroke.period * 0.51 && !snaps.find((x) => x.tag === tag)) want.push(tag);
    }
    if (st.mode === 'hold' && Math.abs(t - 31) < dt / 2) want.push('row5_hold');
    for (const tag of want) snaps.push({ tag, t, obj: dumpOBJ(tag), err: e });
  }
}
function dumpOBJ(tag) {
  let s = `# ${tag}\n`, vi = 1;
  const v = new THREE.Vector3();
  for (const m of skinned) {
    const g = m.geometry, p = g.attributes.position, idx = g.index;
    s += `o ${m.material.name}\nusemtl ${m.material.name}\n`;
    for (let i = 0; i < p.count; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); s += `v ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}\n`; }
    for (let i = 0; i < idx.count; i += 3) s += `f ${idx.getX(i) + vi} ${idx.getX(i + 1) + vi} ${idx.getX(i + 2) + vi}\n`;
    vi += p.count;
  }
  // loom: thin box from end to pivot
  const a = O.end.clone().addScaledVector(O.axis, -0.05), b = O.pivot.clone().addScaledVector(O.axis, 0.6);
  const ax = O.axis, n1 = new THREE.Vector3().crossVectors(ax, up).normalize().multiplyScalar(0.035), n2 = new THREE.Vector3().crossVectors(ax, n1).normalize().multiplyScalar(0.035);
  s += 'o loom\nusemtl wood\n';
  const corners = [];
  for (const P of [a, b]) for (const [i, j] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) corners.push(P.clone().addScaledVector(n1, i).addScaledVector(n2, j));
  for (const c of corners) s += `v ${c.x.toFixed(4)} ${c.y.toFixed(4)} ${c.z.toFixed(4)}\n`;
  for (const [p, q, r2, w] of [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [0, 3, 2, 1], [4, 5, 6, 7]]) s += `f ${vi + p} ${vi + q} ${vi + r2} ${vi + w}\n`;
  vi += 8;
  // deck patch
  s += 'o deck\nusemtl deck\n';
  for (const [x, z] of [[-0.6, -5.6], [1.6, -5.6], [1.6, -2.6], [-0.6, -2.6]]) s += `v ${x} ${deckY} ${z}\n`;
  s += `f ${vi} ${vi + 3} ${vi + 2} ${vi + 1}\n`;
  const path = `${snapDir}/${tag}.obj`;
  fs.writeFileSync(path, s);
  return path;
}

const sorted = [...stats.hand].sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor(p * (sorted.length - 1))];
const ms = [...stats.solveMs].sort((a, b) => a - b);
console.log(`scenario ${scenario}: arc +${ARC.fwd}/${ARC.back} rad, ${stats.frames} frames @60 Hz, ship roll 6 deg/pitch 2 deg`);
console.log(`hand-to-grip error: median ${(pct(0.5) * 100).toFixed(1)} cm, p95 ${(pct(0.95) * 100).toFixed(1)} cm, max ${(pct(1) * 100).toFixed(1)} cm; frames > 3 cm: ${(100 * stats.unreach / stats.frames).toFixed(1)}%`);
for (const [k, b] of Object.entries(stats.byAmp)) console.log(`   ${k.padEnd(13)} frames ${b.n}, mean ${(100 * b.sum / b.n).toFixed(1)} cm, max ${(100 * b.max).toFixed(1)} cm, >3cm ${(100 * b.bad / b.n).toFixed(1)}%`);
console.log(`max reach deficit at full lean (shoulder->wrist beyond desired): ${((stats.deficit || 0) * 100).toFixed(1)} cm`);
{ const q = stats.split; console.log(`mean tip error L ${(100*q.L/q.n).toFixed(1)} R ${(100*q.R/q.n).toFixed(1)} cm; mean solver wrist error L ${(100*q.wL/q.n).toFixed(1)} R ${(100*q.wR/q.n).toFixed(1)} cm`); }
console.log(`toe slide on deck (planted feet, heel lift allowed): max ${(stats.toe * 100).toFixed(2)} cm`);
console.log(`max per-frame bone rotation: ${stats.angStep.toFixed(1)} deg (${stats.angStepBone})`);
console.log('min knee at', stats.kneeAt);
console.log(`min elbow angle ${(stats.elbowMin * 180 / Math.PI).toFixed(0)} deg, min knee angle ${(stats.kneeMin * 180 / Math.PI).toFixed(0)} deg, max forearm twist ${(stats.twistMax * 180 / Math.PI).toFixed(0)} deg, trunk pitch ${(stats.pitchMin * 57.3).toFixed(0)}..${(stats.pitchMax * 57.3).toFixed(0)} deg`);
console.log(`solve+matrixWorld+skeleton.update per rower: median ${(ms[ms.length >> 1] * 1000).toFixed(0)} us, p99 ${(ms[Math.floor(ms.length * 0.99)] * 1000).toFixed(0)} us`);
if (snapDir) { fs.writeFileSync(`${snapDir}/snaps.json`, JSON.stringify(snaps, null, 1)); console.log('snapshots:', snaps.map((s) => `${s.tag}@${s.t.toFixed(2)}s err ${(s.err * 100).toFixed(1)}cm`).join(', ')); }
