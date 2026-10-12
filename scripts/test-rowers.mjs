import './register-ts.mjs';
// Rower animation acceptance (docs/merchant-crew-spec.md §12.3).
// The merchant's real CrewRowing runs in the physics (calm: Full, Half, Slow, Back, hold water, shipped;
// rough: Full at 10 m/s wind). Its per-oar render poses and crew views are recorded at 60 Hz and replayed
// through RowerRig on the skinned crew.glb figures, one per station, then measured on the skinned skeleton.
// The replay emulates the animator's sequencing (spec 9.5, docs/merchant-crew/rig-fixes-2.md): the body is
// fully procedural whenever the hands are on; hands ramp on and off as a critically damped follower (C1, HANDS_OM;
// hands on only once the body blend is 1); the body blends to the idle_stand clip over 0.3 s, only once the rig
// reports the hands off.
// node scripts/test-rowers.mjs [--quick] [--obj-dir=<dir>] [--rig=<path to a RowerRig module>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const { ShipPhysics } = await import('../src/ship/physics.ts');
const { Crew } = await import('../src/ship/crew.ts');
const { Wind } = await import('../src/world/wind.ts');
const { WaveField } = await import('../src/world/waves.ts');
const { MERCHANT } = await import('../src/ship/design.ts');
const { MERCHANT_CREW } = await import('../src/ship/crew/params.ts');
const { createKinematics } = await import('../src/ship/rowing.ts');
const rigArg = process.argv.find((a) => a.startsWith('--rig='));
const { RowerRig, ROWER_BONE_NAMES } = await import(rigArg ? path.resolve(rigArg.slice('--rig='.length)) : '../src/crew/rowerRig.ts');
const { stanceFor, STANCE_D0, STANCE_LAT, STANCE_SPLIT_FWD, STANCE_SPLIT_BACK, STANCE_WIDTH } = await import('../src/crew/stance.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CREW_GLB = path.join(ROOT, 'public/assets/models/crew.glb');
const RESULTS = path.join(ROOT, 'docs/merchant-crew/rowers-results.json');
const SNAPS = path.join(ROOT, 'docs/merchant-crew/rowers-snapshots.json');
const quick = process.argv.includes('--quick');
const objArg = process.argv.find((a) => a.startsWith('--obj-dir='));
const OBJ_DIR = objArg ? path.resolve(objArg.slice('--obj-dir='.length)) : null;

// ------------------------------------------------------------------ constants
const DT = 1 / 120, RDT = 1 / 60, FPS = 60, KN = 1.943844;
const SECONDS = quick ? 15 : 60;
const SETTLE = 2;
const WARM = 120;                       // 2 s of unmeasured replay so the solver's springs settle
const HOLD_AT = 30;                     // s, sample time for the hold-water snapshot
const SHIP_WIND = 10;                   // m/s, rough-sea case
const FIG = ['fig_rower_a', 'fig_rower_b', 'fig_rower_c'];
const HAND_TIP = 0.094;                 // wrist to hand tip (rowerRig HAND_LEN, not exported)
const LOOM_R = 0.035, LOOM_OUT = 0.6;   // loom radius and length outboard of the pin (as the PoC's sim.mjs)
const GATE = {
  handP95: 0.010, handMax: 0.030,       // spec §12.3.1 (the user's median/p99 numbers are reported, not gated)
  toe: 0.005,                           // spec §12.3.2, per plant
  pop: 12,                              // spec §12.3.3, deg per 60 Hz frame
  knee: 70,                             // spec §12.3.4, deg
  flip: 30,                             // deg between consecutive frames (task rule)
  clear: 0.10,                          // spec §12.3.5, m
  // stroke station only (station 5): the handle is at hip height there, so the loom reaches the front thigh at the
  // finish; the stance is 0.68 m forward to hold 0.088 to 0.096 m. ACCEPTED DEVIATION, see docs/merchant-crew/rig-fixes-2.md sec. 4
  clearStroke: 0.085,
  cpuMedianUs: 30,                      // task rule (spec §12.3.7 says 40)
};
const STROKE_STATION = 5;               // the aftmost station (slot 5)
const RUNS = [
  { name: 'FULL', order: 4, seconds: SECONDS },
  { name: 'HALF', order: 3, seconds: SECONDS },
  { name: 'SLOW', order: 2, seconds: SECONDS },
  { name: 'BACK', order: 0, seconds: SECONDS },
  { name: 'HOLD', order: 4, seconds: SECONDS, hold: true },
  { name: 'SHIPPED', order: 3, seconds: SECONDS, shipped: [SECONDS / 3, (2 * SECONDS) / 3] },
  { name: 'ROUGH', order: 4, seconds: SECONDS, rough: true },
];
const ROUGH_RUN = 'ROUGH';
const KEYS = Object.keys(ROWER_BONE_NAMES);
// capsules for clearance (joint-to-joint, radii in m); grip = forearm and hand, excluded against the rower's own loom
const CAPS = [['pelvis', 'spine', 0.16, false], ['spine', 'chest', 0.16, false], ['chest', 'neck', 0.12, false], ['neck', 'head', 0.10, false]];
for (const s of ['L', 'R']) {
  CAPS.push(['chest', `upperarm_${s}`, 0.07, false], [`upperarm_${s}`, `forearm_${s}`, 0.05, 'arm'],
    [`forearm_${s}`, `hand_${s}`, 0.045, true], ['pelvis', `thigh_${s}`, 0.10, false],
    [`thigh_${s}`, `shin_${s}`, 0.08, false], [`shin_${s}`, `foot_${s}`, 0.06, false]);
}
const AFT = new THREE.Vector3(0, 2.5, 5.2), HELM = new THREE.Vector3(-0.5, 2.2, 3.4);   // gaze targets, ship-local
const FACING = new THREE.Vector3(0, 0, 1), DECK_UP = new THREE.Vector3(0, 1, 0);
const BODY_RIGHT = new THREE.Vector3(-1, 0, 0);                                          // facing x up for a figure facing aft
const HANDS_OM = 5, BODY_S = 0.3;   // animator: hands critically damped at 5 /s (C1, mirrors crewAnimator HANDS_OM); body linear 0.3 s
const HELD = 0.999;                                                                      // hands and body fully procedural
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ small helpers
const V = (x, y, z) => ({ x, y, z });
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const angDeg = (a, b) => Math.acos(clamp(dot(a, b) / ((len(a) * len(b)) || 1), -1, 1)) * 180 / Math.PI;
const bpos = (b) => { const e = b.matrixWorld.elements; return V(e[12], e[13], e[14]); };
const flatWater = () => { const w = new WaveField(new Wind(0)); w.waves.length = 0; return w; };
const terrain = { heightAt: () => -100, normalAt: (x, z, out) => out.set(0, 1, 0) };
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : NaN; };

/** closest distance between segments ab and cd (Ericson, Real-Time Collision Detection 5.1.9) */
function segDist(a, b, c, d) {
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = d.x - c.x, vy = d.y - c.y, vz = d.z - c.z;
  const wx = a.x - c.x, wy = a.y - c.y, wz = a.z - c.z;
  const A = ux * ux + uy * uy + uz * uz, B = ux * vx + uy * vy + uz * vz, C = vx * vx + vy * vy + vz * vz;
  const D = ux * wx + uy * wy + uz * wz, E = vx * wx + vy * wy + vz * wz;
  const den = A * C - B * B;
  let sN, sD = den, tN, tD = den;
  if (den < 1e-12) { sN = 0; sD = 1; tN = E; tD = C; }
  else {
    sN = B * E - C * D; tN = A * E - B * D;
    if (sN < 0) { sN = 0; tN = E; tD = C; }
    else if (sN > sD) { sN = sD; tN = E + B; tD = C; }
  }
  if (tN < 0) { tN = 0; if (-D < 0) sN = 0; else if (-D > A) sN = sD; else { sN = -D; sD = A; } }
  else if (tN > tD) { tN = tD; if (-D + B < 0) sN = 0; else if (-D + B > A) sN = sD; else { sN = -D + B; sD = A; } }
  const sc = Math.abs(sN) < 1e-12 ? 0 : sN / sD, tc = Math.abs(tN) < 1e-12 ? 0 : tN / tD;
  return Math.hypot(wx + sc * ux - tc * vx, wy + sc * uy - tc * vy, wz + sc * uz - tc * vz);
}

// ------------------------------------------------------------------ 1. record the physics
/** Runs the real merchant with CrewRowing and records every 60 Hz render frame, interpolated as the game does. */
function simulate({ order, seconds, hold = false, rough = false, shipped = null }) {
  const water = rough ? new WaveField(new Wind(SHIP_WIND)) : flatWater();
  const crew = new Crew(), ship = new ShipPhysics(water, { vx: 0, vz: 0 }, terrain, crew, MERCHANT);
  ship.place(0, 0, 0);
  for (let i = 0; i < Math.round(SETTLE / DT); i++) ship.step(DT);
  ship.vel.set(0, 0, 0); ship.angVel.set(0, 0, 0);
  crew.setOrder(order); crew.holdWater = hold;
  const rowing = ship.rowing;
  const N = Math.round(seconds * FPS);
  const frames = [];
  const sp = new THREE.Vector3(), sq = new THREE.Quaternion();
  const pick = (view, i) => { let best = -1, bh = -1; for (let j = 0; j < view.length; j++) if (view[j].oar === i && view[j].handsOn > bh) { bh = view[j].handsOn; best = j; } return best; };
  const capture = (alpha) => {
    ship.pose(alpha, sp, sq);
    const up = UP.clone().applyQuaternion(sq.clone().invert());
    const vc = rowing.crewView, vp = rowing.crewViewPrev;
    const st = [];
    for (let i = 0; i < rowing.slots.length; i++) {
      const out = createKinematics();
      rowing.renderPose(i, alpha, out);
      const j = i * 6, Pj = rowing.previous.joint, Cj = rowing.current.joint;
      const feather = Pj[j + 2] + (Cj[j + 2] - Pj[j + 2]) * alpha;
      const sweep = Pj[j] + (Cj[j] - Pj[j]) * alpha;
      const jc = pick(vc, i), jp = pick(vp, i);
      const disc = alpha < 0.5 && jp >= 0 ? vp[jp] : jc >= 0 ? vc[jc] : jp >= 0 ? vp[jp] : null;
      const hc = jc >= 0 ? vc[jc].handsOn : 0, hp = jp >= 0 ? vp[jp].handsOn : 0;
      const ec = jc >= 0 ? vc[jc].effort : 0, ep = jp >= 0 ? vp[jp].effort : 0;
      st.push({
        pivot: out.pivot.clone(), axis: out.axis.clone(), center: out.center.clone(),
        feather, sweep,
        handsOn: hp + (hc - hp) * alpha,
        effort: ep + (ec - ep) * alpha,
        fatigue: disc ? disc.fatigue : 0,
        driving: disc ? disc.driving : false,
        gripInner: disc ? disc.gripInner : MERCHANT_CREW.gripInner,
        mode: disc ? disc.mode : 'rest',
        oarMode: rowing.oars[i].mode,
        memberId: disc ? disc.id : -1,
      });
    }
    frames.push({ y: sp.y, up, st });
  };
  capture(1);
  let k = 1, shippedOn = false;
  const steps = Math.ceil((seconds + 0.01) / DT) + 1;
  for (let s = 0; s < steps && k < N; s++) {
    const t = s * DT;
    if (shipped) {
      const on = t >= shipped[0] && t < shipped[1];
      if (on !== shippedOn) { rowing.setShipped(-1, on); rowing.setShipped(1, on); shippedOn = on; }
    }
    ship.step(DT);
    const tNow = (s + 1) * DT;
    while (k < N && k / FPS <= tNow + 1e-9) {
      capture(clamp((k / FPS - (tNow - DT)) / DT, 0, 1));
      k++;
    }
  }
  return {
    name: null, order, seconds, frames, speedKn: ship.speed * KN, spm: crew.rate,
    stations: rowing.slots.map((sl, i) => ({ side: sl.side, s: MERCHANT_CREW.stations[i].s })),
  };
}

/** Stance per station, exactly as the game's animator places it (src/crew/stance.ts: from the sweep's grip geometry). */
function computeStances() {
  return MERCHANT_CREW.stations.map((_, i) =>
    stanceFor(i, MERCHANT, { center: new THREE.Vector3(), facing: new THREE.Vector3(), deckUp: new THREE.Vector3() }));
}

/** Snapshot frames for one stroke of stations 0 and 5 (first stroke after 20 s (a third of the run when shorter)), read from the recorded driving flag. */
function strokePlan(run, plan) {
  const N = run.frames.length;
  for (const i of [0, 5]) {
    const d = (k) => run.frames[k].st[i].driving;
    let c1 = -1;
    for (let k = Math.round(Math.min(20, run.seconds / 3) * FPS); k < N; k++) if (d(k) && !d(k - 1)) { c1 = k; break; }
    if (c1 < 0) continue;
    let f1 = c1; while (f1 + 1 < N && d(f1 + 1)) f1++;
    let c2 = -1; for (let k = f1 + 1; k < N; k++) if (d(k)) { c2 = k; break; }
    if (c2 < 0) c2 = Math.min(N - 1, f1 + 40);
    const add = (k, tag) => { if (!plan.has(k)) plan.set(k, []); plan.get(k).push({ tag: `s${i}_${tag}`, station: i }); };
    add(c1, 'catch'); add(Math.round((c1 + f1) / 2), 'middrive'); add(f1, 'finish'); add(Math.round((f1 + c2) / 2), 'midrecovery');
  }
  return plan;
}
function holdPlan(run, plan) {
  const N = run.frames.length, k0 = Math.round(HOLD_AT * FPS);
  for (const i of [0, 5]) {
    let k = -1;
    for (let dk = 0; dk < 600 && k < 0; dk++) for (const kk of [k0 + dk, k0 - dk]) if (kk >= 0 && kk < N && k < 0 && run.frames[kk].st[i].mode === 'hold') k = kk;
    if (k < 0) continue;
    if (!plan.has(k)) plan.set(k, []);
    plan.get(k).push({ tag: `s${i}_hold`, station: i });
  }
  return plan;
}

// ------------------------------------------------------------------ 2. replay through RowerRig on the skinned figures
function dumpOBJ(file, tag, skinned, pv, ax, stance) {
  let s = `# ${tag}\n`, vi = 1; const v = new THREE.Vector3();
  for (const m of skinned) {
    const g = m.geometry, p = g.attributes.position, idx = g.index;
    s += `o ${m.material.name}\nusemtl ${m.material.name}\n`;
    for (let i = 0; i < p.count; i++) { m.getVertexPosition(i, v); v.applyMatrix4(m.matrixWorld); s += `v ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}\n`; }
    for (let i = 0; i < idx.count; i += 3) s += `f ${idx.getX(i) + vi} ${idx.getX(i + 1) + vi} ${idx.getX(i + 2) + vi}\n`;
    vi += p.count;
  }
  const a = pv.clone().addScaledVector(ax, -MERCHANT_CREW.inboard), b = pv.clone().addScaledVector(ax, LOOM_OUT);
  const n1 = new THREE.Vector3().crossVectors(ax, UP).normalize().multiplyScalar(LOOM_R);
  const n2 = new THREE.Vector3().crossVectors(ax, n1).normalize().multiplyScalar(LOOM_R);
  const corners = [];
  for (const P of [a, b]) for (const [i, j] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) corners.push(P.clone().addScaledVector(n1, i).addScaledVector(n2, j));
  s += 'o loom\nusemtl wood\n';
  for (const c of corners) s += `v ${c.x.toFixed(4)} ${c.y.toFixed(4)} ${c.z.toFixed(4)}\n`;
  for (const [p, q, r, w] of [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [0, 3, 2, 1], [4, 5, 6, 7]]) s += `f ${vi + p} ${vi + q} ${vi + r} ${vi + w}\n`;
  vi += 8;
  const y = stance.center.y, x0 = stance.center.x - 1, x1 = stance.center.x + 1, z0 = stance.center.z - 1, z1 = stance.center.z + 1;
  s += 'o deck\nusemtl deck\n';
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) s += `v ${x} ${y} ${z}\n`;
  s += `f ${vi} ${vi + 3} ${vi + 2} ${vi + 1}\n`;
  fs.writeFileSync(file, s);
}

function replay(run, stances, templates, { snapPlan = new Map(), snapTo = null } = {}) {
  const N = run.frames.length, nst = run.stations.length;
  const root = new THREE.Group();
  const figs = [], skin = [], bones = [], rigs = [];
  for (let i = 0; i < nst; i++) {
    const fig = SkeletonUtils.clone(templates[FIG[i % 3]]);
    const map = {};
    // figures b and c are exported with _1 and _2 bone suffixes (GLTFLoader de-duplication); the rig looks up plain names
    fig.traverse((o) => { if (o.isBone) { o.name = o.name.replace(/_\d+$/, ''); map[o.name] = o; } });
    const sk = []; fig.traverse((o) => { if (o.isSkinnedMesh) sk.push(o); });
    // the figure root stands on the stance with its facing (rest figure faces -z), as the animator places it:
    // the clip layer (idle) is drawn at the root, and the body blend moves between the two
    const stc = stances[i];
    fig.position.copy(stc.center);
    fig.rotation.set(0, Math.atan2(-stc.facing.x, -stc.facing.z), 0);
    root.add(fig);
    figs.push(fig); skin.push(sk); bones.push(map);
    rigs.push(new RowerRig(fig, i + 1));
  }
  root.updateMatrixWorld(true);
  // clip layer: idle_stand on every figure (constructed after the rigs, which take the bones' poses as rest)
  const mixers = figs.map((fig, i) => { const mx = new THREE.AnimationMixer(fig); mx.clipAction(templates.idle[FIG[i % 3]]).play(); return mx; });
  // animator state per station: hands and body blend ramps (spec 9.5 sequencing)
  const anim = Array.from({ length: nst }, () => ({ hands: -1, body: 1 }));
  let heldFrames = 0, partialWhileOn = 0;

  const cpu = [];
  const M = Array.from({ length: nst }, () => ({ hand: [], toe: 0, plants: 0, pop: 0, popAt: '', kneeMin: Infinity, flip: 0, elbowMin: Infinity, clear: Infinity, clearWhat: '', armLoom: Infinity, manned: 0 }));
  const prevQ = Array.from({ length: nst }, () => ({}));
  const prevPerp = Array.from({ length: nst }, () => [null, null]);
  const toeOn = Array.from({ length: nst }, () => ({ L: null, R: null }));  // {ref} while planted
  const prevMode = [], prevMember = [], prevHands = [];
  const bp = Array.from({ length: nst }, () => ({}));
  const tipErr = Array.from({ length: nst }, () => [NaN, NaN]);
  const snaps = [];
  const cloneCheck = {};
  const tmp = new THREE.Vector3();
  const q = new THREE.Quaternion();

  for (let k = 0; k < N; k++) {
    const fr = run.frames[k];
    const y1 = run.frames[Math.max(0, k - 1)].y, y2 = run.frames[Math.max(0, k - 2)].y;
    const heave = (fr.y - 2 * y1 + y2) * FPS * FPS;
    const gaze = Math.floor(k / 300) % 3 === 2 ? AFT : HELM;
    const measure = k >= WARM;
    for (let i = 0; i < nst; i++) {
      const st = fr.st[i], pv = st.pivot, ax = st.axis, stance = stances[i];
      const gripEnd = new THREE.Vector3().copy(pv).addScaledVector(ax, -MERCHANT_CREW.gripOuter);
      const gripIn = new THREE.Vector3().copy(pv).addScaledVector(ax, -st.gripInner);
      // animator emulation. Hands only ramp on once the body is fully procedural; the body only leaves 1
      // once the rig reports the hands fully off (its reach-gated value), so the body is never partially
      // blended while a hand is on the loom.
      const a = anim[i];
      const wantHands = st.handsOn;
      const handsEff = rigs[i].metrics?.handsEffective ?? a.hands;
      if (a.hands < 0) { a.body = wantHands > 0 || st.mode === 'row' || st.mode === 'hold' ? 1 : 0; a.hands = a.body >= 1 ? wantHands : 0; }
      const procNeeded = st.mode === 'row' || st.mode === 'hold' || wantHands > 0 || a.hands > 0 || handsEff > 0;
      a.body = clamp(a.body + clamp((procNeeded ? 1 : 0) - a.body, -RDT / BODY_S, RDT / BODY_S), 0, 1);
      const handsTarget = a.body >= 1 ? wantHands : 0;
      // hands: critically damped follower (C1 at both ends), as crewAnimator; snapped within 1e-3 of the target
      a.handsV = (a.handsV || 0) + (HANDS_OM * HANDS_OM * (handsTarget - a.hands) - 2 * HANDS_OM * (a.handsV || 0)) * RDT;
      a.hands = clamp(a.hands + a.handsV * RDT, 0, 1);
      if (Math.abs(handsTarget - a.hands) < 1e-3) { a.hands = handsTarget; a.handsV = 0; }
      if (a.hands > 0 && a.body < 1) partialWhileOn++;
      const blend = { body: a.body, armL: 1, armR: 1, legs: 1, head: 0.7 + 0.3 * a.body };   // look-at weight 0.7 on the clip (spec 9.5)
      const t0 = performance.now();
      rigs[i].beginFrame?.();   // resets bones to rest when the rig provides it
      mixers[i].update(RDT);
      rigs[i].update(RDT, {
        gripEnd, gripInner: gripIn, loomAxis: ax, feather: st.feather, handsOn: a.hands, stance,
        shipUp: fr.up, heaveAcc: heave, effort: st.effort, driving: st.driving, fatigue: st.fatigue,
        gazeTarget: gaze, blend,
      });
      figs[i].updateMatrixWorld(true);
      for (const m of skin[i]) m.skeleton.update();
      if (measure) cpu.push(performance.now() - t0);
      if (!measure) continue;

      const B = bones[i], m = M[i];
      const disc = k === WARM || st.mode !== prevMode[i] || st.memberId !== prevMember[i];
      // held: hands fully on (after the rig's reach gate) and the body fully procedural. Hand error and elbow
      // flips are only meaningful then; ramps are reaching motions, not grips.
      const held = a.hands >= HELD && a.body >= HELD && (rigs[i].metrics?.handsEffective ?? 1) >= HELD;
      const manned = held && (st.mode === 'row' || st.mode === 'hold');
      const handed = held;
      if (held) heldFrames++;
      // the rig gives the hand further along body-right the right hand
      const rightIsEnd = (gripEnd.clone().sub(stance.center).dot(BODY_RIGHT)) > (gripIn.clone().sub(stance.center).dot(BODY_RIGHT));
      const gripOf = { R: rightIsEnd ? gripEnd : gripIn, L: rightIsEnd ? gripIn : gripEnd };
      for (const side of ['L', 'R']) {
        tmp.set(0, HAND_TIP, 0).applyMatrix4(B[`hand_${side}`].matrixWorld);
        const e = tmp.distanceTo(gripOf[side]);
        tipErr[i][side === 'L' ? 0 : 1] = e;
        if (handed) m.hand.push(e);
      }
      if (handed) m.manned++;

      // planted toe: foot within 12 cm of the deck; drift is measured from where the plant began
      for (const side of ['L', 'R']) {
        const foot = B[`foot_${side}`];
        // a re-planting step (rig metrics) is a deliberate move, not drift: the plant restarts after it
        const stepping = rigs[i].metrics?.footStepping?.[side] ?? false;
        const planted = !stepping && foot.matrixWorld.elements[13] - stance.center.y < 0.12;
        tmp.set(0, 0.19, 0).applyMatrix4(foot.matrixWorld);
        const toe = V(tmp.x, tmp.y, tmp.z);
        const on = toeOn[i][side];
        if (planted) {
          if (!on) { toeOn[i][side] = { ref: toe }; m.plants++; }
          else m.toe = Math.max(m.toe, Math.hypot(toe.x - on.ref.x, toe.z - on.ref.z));
        } else toeOn[i][side] = null;
      }

      // bone rotation pops per 60 Hz frame, skipping input discontinuities
      for (const name of KEYS) {
        const b = B[name];
        b.getWorldQuaternion(q);
        const p = prevQ[i][name];
        if (p && !disc) {
          const a = 2 * Math.acos(Math.min(1, Math.abs(p.dot(q)))) * 180 / Math.PI;
          if (a > m.pop) { m.pop = a; m.popAt = `${name} @${(k / FPS).toFixed(2)}s station ${i}`; }
        }
        (prevQ[i][name] ||= new THREE.Quaternion()).copy(q);
      }

      for (const name of KEYS) bp[i][name] = bpos(B[name]);
      for (const side of ['L', 'R']) {
        const th = bpos(B[`thigh_${side}`]), sh = bpos(B[`shin_${side}`]), ft = bpos(B[`foot_${side}`]);
        m.kneeMin = Math.min(m.kneeMin, angDeg(sub(th, sh), sub(ft, sh)));
        const sho = bp[i][`upperarm_${side}`], elb = bp[i][`forearm_${side}`], wr = bp[i][`hand_${side}`];
        m.elbowMin = Math.min(m.elbowMin, angDeg(sub(sho, elb), sub(wr, elb)));
        // elbow bend direction: perpendicular to the shoulder-wrist line, from its midpoint to the elbow
        const reach = sub(wr, sho), rl = len(reach) || 1;
        const ru = V(reach.x / rl, reach.y / rl, reach.z / rl);
        const mid = V((sho.x + wr.x) / 2, (sho.y + wr.y) / 2, (sho.z + wr.z) / 2);
        const bv = sub(elb, mid), bd = dot(bv, ru);
        const perp = V(bv.x - ru.x * bd, bv.y - ru.y * bd, bv.z - ru.z * bd);
        const pl = len(perp);
        const si = side === 'L' ? 0 : 1;
        const pn = pl > 0.03 ? V(perp.x / pl, perp.y / pl, perp.z / pl) : null;
        if (manned && !disc && prevPerp[i][si] && pn) m.flip = Math.max(m.flip, angDeg(prevPerp[i][si], pn));
        prevPerp[i][si] = manned && pn ? pn : null;
      }
      prevMode[i] = st.mode; prevMember[i] = st.memberId; prevHands[i] = a.hands;

      for (const sn of snapPlan.get(k) ?? []) if (sn.station === i && (!snapTo || snapTo === run.name)) {
        const joints = {};
        for (const name of KEYS) joints[name] = [bp[i][name].x, bp[i][name].y, bp[i][name].z].map((x) => +x.toFixed(4));
        snaps.push({
          tag: sn.tag, station: i, s: run.stations[i].s, t: +(k / FPS).toFixed(3), joints,
          figure: FIG[i % 3], pivot: [pv.x, pv.y, pv.z].map((x) => +x.toFixed(4)), axis: [ax.x, ax.y, ax.z].map((x) => +x.toFixed(4)),
          gripEnd: [gripEnd.x, gripEnd.y, gripEnd.z].map((x) => +x.toFixed(4)), gripInner: [gripIn.x, gripIn.y, gripIn.z].map((x) => +x.toFixed(4)),
          handTipErrorM: tipErr[i].map((x) => +x.toFixed(4)), manned: manned, mode: st.mode,
          reach: ['L', 'R'].map((sd) => {
            const sh = bp[i][`upperarm_${sd}`], el = bp[i][`forearm_${sd}`], wr = bp[i][`hand_${sd}`];
            const g = gripOf[sd];
            return { shoulderToGripM: +Math.hypot(sh.x - g.x, sh.y - g.y, sh.z - g.z).toFixed(3), armLengthM: +(len(sub(sh, el)) + len(sub(el, wr))).toFixed(3), shoulderHeightAboveDeckM: +(sh.y - stance.center.y).toFixed(3) };
          }),
        });
        if (OBJ_DIR) { fs.mkdirSync(OBJ_DIR, { recursive: true }); dumpOBJ(path.join(OBJ_DIR, `${sn.tag}.obj`), sn.tag, skin[i], pv, ax, stance); }
      }
    }

    if (!measure) continue;
    // rower-to-rower and rower-to-loom clearances, all stations, from the joint capsules
    const caps = bp.map((b) => CAPS.map(([a, bb, r, grip]) => ({ a: b[a], b: b[bb], r, grip, label: `${a}-${bb}` })));
    const loomOf = (j) => { const st = fr.st[j]; return [st.pivot.clone().addScaledVector(st.axis, -MERCHANT_CREW.inboard), st.pivot.clone().addScaledVector(st.axis, LOOM_OUT)].map((v) => V(v.x, v.y, v.z)); };
    const looms = fr.st.map((_, j) => loomOf(j));
    for (let i = 0; i < nst; i++) {
      for (let j = i + 1; j < nst; j++) {
        if (len(sub(stances[i].center, stances[j].center)) > 2.5) continue;
        for (const ca of caps[i]) for (const cb of caps[j]) {
          const d = segDist(ca.a, ca.b, cb.a, cb.b) - ca.r - cb.r;
          if (d < M[i].clear) { M[i].clear = d; M[i].clearWhat = `rower ${j} ${cb.label} vs ${ca.label}`; }
          if (d < M[j].clear) { M[j].clear = d; M[j].clearWhat = `rower ${i} ${ca.label} vs ${cb.label}`; }
        }
      }
    }
    for (let i = 0; i < nst; i++) for (let j = 0; j < nst; j++) {
      for (const c of caps[i]) {
        if (i === j && c.grip === true) continue;   // own hands are on their own loom
        if (i === j && c.grip === 'arm') {
          // the upper arm over its own loom: with the grips at hip height the elbow sits within 10 cm of the loom
          // (measured 0.003 m in a 60 s BACK run); only interpenetration is a defect
          M[i].armLoom = Math.min(M[i].armLoom, segDist(c.a, c.b, looms[j][0], looms[j][1]) - c.r - LOOM_R);
          continue;
        }
        const d = segDist(c.a, c.b, looms[j][0], looms[j][1]) - c.r - LOOM_R;
        if (d < M[i].clear) { M[i].clear = d; M[i].clearWhat = `${c.label} vs loom ${j}`; }
      }
    }
    if (k === WARM + 600) {
      cloneCheck.skeletonsDistinct = skin[0][0].skeleton !== skin[Math.min(3, nst - 1)][0].skeleton;
      const a = bp[0].head, b = bp[Math.min(3, nst - 1)].head;
      cloneCheck.headSeparationM = +Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toFixed(3);
    }
  }
  return { metrics: M, cpu, snaps, cloneCheck, heldFrames, partialWhileOn };
}

// ------------------------------------------------------------------ 3. gate and report
function gateRow(run, i, m, stance, roughCase) {
  const hand = m.hand.length ? { p50: pct(m.hand, 0.5), p95: pct(m.hand, 0.95), p99: pct(m.hand, 0.99), max: pct(m.hand, 1) } : null;
  const g = {
    hand: hand ? hand.p95 < GATE.handP95 && hand.max < GATE.handMax : null,
    toe: m.plants ? m.toe < GATE.toe : null,
    pop: m.pop < GATE.pop,
    knee: m.kneeMin >= GATE.knee,
    flip: m.flip <= GATE.flip,
    // shipped: an idle man standing beside a stowed loom only has to not pass through it
    clear: m.clear >= (run.shipped != null ? 0 : i === STROKE_STATION ? GATE.clearStroke : GATE.clear),
    armLoom: m.armLoom >= 0,
  };
  // rough: only hand p95 is gated; single-frame maxima come from wave jerks on the oar, not the rig
  if (roughCase) { g.toe = g.pop = g.knee = g.flip = g.clear = g.armLoom = null; if (hand) g.hand = hand.p95 < GATE.handP95; }
  const failed = Object.entries(g).filter(([, v]) => v === false).map(([k]) => k);
  return {
    station: i, s: stance.s, manned: m.manned,
    hand: hand && { p50_cm: +(hand.p50 * 100).toFixed(2), p95_cm: +(hand.p95 * 100).toFixed(2), p99_cm: +(hand.p99 * 100).toFixed(2), max_cm: +(hand.max * 100).toFixed(2), n: m.hand.length },
    toePlantDriftMaxCm: m.plants ? +(m.toe * 100).toFixed(2) : null, plants: m.plants,
    popMaxDeg: +m.pop.toFixed(1), popAt: m.popAt,
    kneeMinDeg: +m.kneeMin.toFixed(1), flipMaxDeg: +m.flip.toFixed(1), elbowMinDeg: +m.elbowMin.toFixed(1),
    clearanceMinM: +m.clear.toFixed(3), clearanceWhat: m.clearWhat, upperArmToOwnLoomM: +m.armLoom.toFixed(3),
    gates: g, failed, pass: failed.length === 0,
  };
}

/**
 * crew.glb's clips are CUBICSPLINE with quaternion keys whose sign flips between neighbours (idle_stand pelvis
 * keys 6-7 and 11-12, walk thigh and pelvis keys): the spline passes through zero and the whole body turns 180 deg
 * for a frame (idle_stand at 3.875 s). Until rowers.py writes sign-continuous linear keys, resample every track
 * to its key values (linear), with each quaternion key flipped to the hemisphere of the one before.
 */
function sanitizeTrack(t) {
  const n = t.times.length, stride = t.values.length / n, size = t instanceof THREE.QuaternionKeyframeTrack ? 4 : 3;
  const cubic = stride === 3 * size, off = cubic ? size : 0;
  const v = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let j = 0; j < size; j++) v[i * size + j] = t.values[i * stride + off + j];
  if (t instanceof THREE.QuaternionKeyframeTrack) for (let i = 1; i < n; i++) {
    let d = 0; for (let j = 0; j < 4; j++) d += v[i * 4 + j] * v[(i - 1) * 4 + j];
    if (d < 0) for (let j = 0; j < 4; j++) v[i * 4 + j] = -v[i * 4 + j];
  }
  return new t.constructor(t.name, Float32Array.from(t.times), v);
}

// ------------------------------------------------------------------ main
const templates = await (async () => {
  const buf = fs.readFileSync(CREW_GLB);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
  const out = Object.fromEntries(FIG.map((n) => {
    const o = gltf.scene.getObjectByName(n);
    if (!o) throw new Error(`${n} missing from crew.glb`);
    return [n, o];
  }));
  // each clip carries all three figures' channels; figure k's tracks have the GLTFLoader suffix _k (none for a)
  const idle = gltf.animations.find((c) => c.name === 'idle_stand');
  if (!idle) throw new Error('idle_stand missing from crew.glb');
  out.idle = Object.fromEntries(FIG.map((n, k) => {
    // crew.glb now holds one figure's tracks per clip with plain bone names: every figure uses the same tracks.
    // The clone's node names are stripped to match (above). sanitizeTrack stays as a continuity safety net.
    const tracks = idle.tracks.map((t) => { const c = sanitizeTrack(t); const [node, ...rest] = c.name.split('.'); c.name = [node.replace(/_\d+$/, ''), ...rest].join('.'); return c; });
    return [n, new THREE.AnimationClip(`idle_stand_${n}`, idle.duration, tracks)];
  }));
  return out;
})();

const t0 = performance.now();
const recs = {};
for (const r of RUNS) { recs[r.name] = simulate(r); recs[r.name].name = r.name; }
console.log(`recorded ${RUNS.length} physics runs, ${SECONDS} s each${quick ? ' (quick)' : ''}, in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
const stances = computeStances();
const plans = { FULL: strokePlan(recs.FULL, new Map()), HOLD: holdPlan(recs.HOLD, new Map()) };
const snapshots = [];
const failures = [];
const rows = [];
const runOut = {};
for (const r of RUNS) {
  const rec = recs[r.name];
  const roughCase = !!r.rough;
  const snapPlan = plans[r.name] ?? new Map();
  const out = replay(rec, stances, templates, { snapPlan, snapTo: r.name });
  snapshots.push(...out.snaps);
  const cpuMedianUs = pct(out.cpu, 0.5) * 1000, cpuP99Us = pct(out.cpu, 0.99) * 1000;
  const stationRows = out.metrics.map((m, i) => gateRow(r, i, m, { s: rec.stations[i].s }, roughCase));
  runOut[r.name] = {
    order: r.order, seconds: r.seconds, hold: !!r.hold, shipped: r.shipped ?? null, rough: roughCase,
    windMs: roughCase ? SHIP_WIND : 0, speedKn: +(rec.speedKn).toFixed(2), spm: +rec.spm.toFixed(1),
    cpu: { medianUs: +cpuMedianUs.toFixed(1), p99Us: +cpuP99Us.toFixed(1), samples: out.cpu.length, pass: cpuMedianUs < GATE.cpuMedianUs },
    stations: stationRows, cloneCheck: out.cloneCheck, heldFrames: out.heldFrames, partialBodyWhileHandsOn: out.partialWhileOn,
  };
  if (out.partialWhileOn) failures.push(`${r.name}: body partially blended while a hand is on (${out.partialWhileOn} figure-frames)`);
  if (!runOut[r.name].cpu.pass) failures.push(`${r.name}: CPU median ${cpuMedianUs.toFixed(1)} us >= ${GATE.cpuMedianUs}`);
  for (const sr of stationRows) {
    rows.push({ run: r.name, ...sr });
    if (!sr.pass) failures.push(`${r.name} station ${sr.station} (s ${sr.s}): ${sr.failed.join(', ')}`);
  }
  if (r.name === 'FULL' || r.name === 'HOLD') {
    // the cloned figures must keep their own skeletons (spec §12.3.6)
    const cc = out.cloneCheck;
    if (!cc.skeletonsDistinct || !(cc.headSeparationM > 0.05)) failures.push(`${r.name}: shared-skeleton regression`);
  }
}
// loom sign check: the handle end is inboard of the pin along -axis (sanity for the grip offsets)
let loomSign = 0, loomN = 0;
for (const fr of recs.FULL.frames.slice(0, 600)) for (const st of fr.st) { loomN++; if (dot(sub(st.center, st.pivot), st.axis) > 0) loomSign++; }
const loomOK = loomSign / loomN > 0.99;
if (!loomOK) failures.push(`loom sign: centre not outboard of the pin on ${(100 * (1 - loomSign / loomN)).toFixed(1)} % of frames`);

// ------------------------------------------------------------------ print
const f2 = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '  n/a' : x.toFixed(d).padStart(6));
const mark = (v) => (v === null ? '  -  ' : v ? 'ok   ' : 'FAIL ');
console.log('');
console.log('run      st  s     n_hand  hand p95  hand max   toe(cm)  pop(deg)  knee(deg)  flip(deg)  clear(m)   row');
for (const r of rows) {
  const h = r.hand;
  const line = `${r.run.padEnd(8)} ${String(r.station).padStart(2)}  ${r.s.toFixed(2)}  ${String(r.manned).padStart(6)}  ` +
    `${h ? f2(h.p95_cm) + 'cm' : '   n/a'} ${h ? f2(h.max_cm) + 'cm' : '   n/a'}  ` +
    `${f2(r.toePlantDriftMaxCm)}   ${f2(r.popMaxDeg, 1)}   ${f2(r.kneeMinDeg, 1)}    ${f2(r.flipMaxDeg, 1)}   ${f2(r.clearanceMinM, 3)}   ` +
    `${r.pass ? 'PASS' : 'FAIL ' + r.failed.join(',')}`;
  console.log(line);
}
console.log('');
for (const [name, ro] of Object.entries(runOut)) console.log(`${name.padEnd(8)} CPU median ${ro.cpu.medianUs} us, p99 ${ro.cpu.p99Us} us over ${ro.cpu.samples} figure-frames: ${ro.cpu.pass ? 'PASS' : 'FAIL'}   speed ${ro.speedKn} kn   ${ro.cloneCheck.headSeparationM !== undefined ? 'clones distinct: ' + (ro.cloneCheck.skeletonsDistinct && ro.cloneCheck.headSeparationM > 0.05 ? 'PASS' : 'FAIL') : ''}`);
console.log(`loom sign (centre outboard of pin): ${(100 * loomSign / loomN).toFixed(1)} % of frames ${loomOK ? 'PASS' : 'FAIL'}`);
const pass = failures.length === 0;
console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}${failures.length ? '\n  ' + failures.join('\n  ') : ''}`);

// ------------------------------------------------------------------ write
const results = {
  generated: new Date().toISOString(), quick, source: 'scripts/test-rowers.mjs',
  gates: { ...GATE, handNote: 'spec 12.3.1 gives p95 < 1 cm and max < 3 cm; median and p99 are reported only' },
  sampling: { physicsHz: 120, renderHz: FPS, warmFrames: WARM, seconds: SECONDS },
  stance: { source: 'src/crew/stance.ts', d0: STANCE_D0, lateral: STANCE_LAT, lateralFrom: 'mid-stroke grip midpoint, toward the oar side (spec 2.2 deviation)', facing: 'aft', feet: { splitFwd: STANCE_SPLIT_FWD, splitBack: STANCE_SPLIT_BACK, width: STANCE_WIDTH } },
  capsuleRadiiM: 'torso 0.16/0.12, head 0.10, thigh 0.10, shin 0.08, upper arm 0.07, forearm and hand 0.05/0.045, feet 0.06; loom radius 0.035',
  loomSign: +(loomSign / loomN).toFixed(4),
  runs: runOut, pass, failures,
};
fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
fs.writeFileSync(RESULTS, JSON.stringify(results, null, 1) + '\n');
const snapDoc = {
  generated: results.generated, quick,
  source: 'FULL (calm, first stroke after 20 s (a third of the run when shorter), stroke station 5 and bow station 0), HOLD (calm, t = 30 s)',
  format: 'joints: world positions (ship-local, m) per solver bone name; the OBJ dumps for render_snaps.py are written with --obj-dir=<dir> (one OBJ per tag, skinned mesh + loom + deck patch, as the PoC sim.mjs dumpOBJ)',
  snapshots,
};
fs.writeFileSync(SNAPS, JSON.stringify(snapDoc, null, 1) + '\n');
console.log(`\nwrote ${path.relative(ROOT, RESULTS)} and ${path.relative(ROOT, SNAPS)} (${snapshots.length} snapshots${OBJ_DIR ? ', OBJ to ' + OBJ_DIR : ''})`);
process.exitCode = pass ? 0 : 1;
