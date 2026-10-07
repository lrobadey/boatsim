// Headless camera tests (spec §9): transitions, mouse and clicks, chase spring arm, trauma shake.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { smootherstep, CameraRig, newPose, copyPose } = await import('../src/player/cameraRig.ts');
const { PlayerController } = await import('../src/player/controller.ts');
const { Input } = await import('../src/core/input.ts');
const { WalkGeometry } = await import('../src/world/walkable.ts');
const { deckY, zOf } = await import('../src/ship/hull.ts');

// a minimal DOM: Input records its listeners so tests can fire events at it
const dom = { window: {}, document: {} };
const onDom = (target) => (type, fn) => (dom[target][type] ??= []).push(fn);
const fireDom = (target, type, ev) => (dom[target][type] ?? []).forEach((f) => f(ev));
globalThis.window = { addEventListener: onDom('window'), innerWidth: 1000, innerHeight: 800 };
globalThis.document = { addEventListener: onDom('document'), pointerLockElement: null };
const fakeEl = (calls = { n: 0 }) => ({ requestPointerLock: () => (calls.n++, undefined) });

const DT = 1 / 60;
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (e) {
    failures++;
    console.error('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 3).join(' | '));
  }
}
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b} (tol ${e})`);
const Y = new THREE.Vector3(0, 1, 0);

// ── mocks ──
const flatSea = { heightAt: () => 0 };
const waves = { heightAt: () => 0 };
const sea = { heightAt: () => -5, normalAt: (x, z, out) => out.set(0, 1, 0) };
const flat = { heightAt: () => 0 };

function pose({ origin = [0, 0, 0], yaw = 0, cg = null, vel = [0, 0, 0] } = {}) {
  const quat = new THREE.Quaternion().setFromAxisAngle(Y, -yaw);
  const o = new THREE.Vector3(...origin);
  return {
    origin: o,
    quat,
    cgWorld: cg ? new THREE.Vector3(...cg) : o.clone().add(new THREE.Vector3(0, 0.3, 0)),
    vel: new THREE.Vector3(...vel),
    angVel: new THREE.Vector3(),
    plank: null,
    solids: new WalkGeometry(null),
  };
}

function rig() {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  const input = new Input(fakeEl());
  const ctl = new PlayerController(camera, input);
  return { ctl, camera, input, keys: input.keys, pressed: input.pressed };
}
function frames(r, ship, n, terrain = flat, w = waves) {
  for (let i = 0; i < n; i++) {
    r.ctl.update(DT, ship, new WalkGeometry(sea), terrain, w, 0);
    r.input.endFrame();
  }
}

/** smootherstep's largest per-step slope is 15/8 of the average: a blend can move at most this fast */
const MAX_SLOPE = 15 / 8;

// ── tests ──

test('smootherstep: endpoints, monotonic, flat at both ends', () => {
  near(smootherstep(0), 0, 1e-12);
  near(smootherstep(1), 1, 1e-12);
  near(smootherstep(0.5), 0.5, 1e-12);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const v = smootherstep(i / 100);
    assert.ok(v >= prev - 1e-12, 'not monotonic');
    prev = v;
  }
  near(smootherstep(1e-4) / 1e-4, 0, 1e-3);
});

test('rig: a blend between two moving targets moves no faster than the targets plus the blend itself', () => {
  // The blend is P = lerp(S, B(t), k(t)) from a fixed snapshot S, so each step is
  //   ΔP = k·ΔB + Δk·(B − S),  |Δk| ≤ (15/8)·dt/dur (smootherstep's steepest slope).
  // The bound below is that, with ΔB taken from the target's own per-frame motion.
  const r = new CameraRig();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  const A = newPose();
  const B = newPose();
  const placeA = (t) => {
    A.position.set(Math.cos(t * 0.8) * 5, 2, Math.sin(t * 0.8) * 5);
    A.quaternion.setFromEuler(new THREE.Euler(0.2 * Math.sin(t), t * 0.3, 0, 'YXZ'));
  };
  const placeB = (t) => {
    B.position.set(20 + Math.sin(t * 0.1) * 0.3, 3, 0);
    B.quaternion.setFromEuler(new THREE.Euler(0, 0.4 + Math.sin(t * 0.1) * 0.05, 0, 'YXZ'));
  };
  let t = 0;
  for (let i = 0; i < 120; i++, t += DT) {
    placeA(t);
    r.update(DT, cam, A);
  }
  const ownA = 5 * 0.8 * DT * 1.01; // A's own orbit speed, per frame
  const dur = 0.7;
  r.transition(dur);
  const S = r.pose.position.clone();
  const SQ = r.pose.quaternion.clone();
  let prevPos = r.pose.position.clone();
  let prevQ = r.pose.quaternion.clone();
  let prevB = new THREE.Vector3();
  let prevBQ = new THREE.Quaternion();
  placeB(t);
  prevB.copy(B.position);
  prevBQ.copy(B.quaternion);
  for (let i = 0; i < 90; i++, t += DT) {
    placeB(t);
    const dB = B.position.distanceTo(prevB);
    r.update(DT, cam, B);
    const step = r.pose.position.distanceTo(prevPos);
    const bound = Math.max(dB, ownA) + S.distanceTo(B.position) * MAX_SLOPE * DT / dur + 1e-6;
    assert.ok(step <= bound, `frame ${i}: step ${step} > bound ${bound}`);
    const ang = r.pose.quaternion.angleTo(prevQ);
    const angBound = B.quaternion.angleTo(prevBQ) + SQ.angleTo(B.quaternion) * MAX_SLOPE * DT / dur + 1e-6;
    assert.ok(ang <= angBound, `frame ${i}: angle ${ang} > bound ${angBound}`);
    prevPos.copy(r.pose.position);
    prevQ.copy(r.pose.quaternion);
    prevB.copy(B.position);
    prevBQ.copy(B.quaternion);
  }
  // it lands on the target
  for (let i = 0; i < 30; i++) r.update(DT, cam, B);
  assert.ok(r.pose.position.distanceTo(B.position) < 1e-9, 'did not land on the target');
});

test('rig: re-toggling mid-blend restarts from the current pose, with no jump', () => {
  const r = new CameraRig();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  const A = newPose();
  A.position.set(0, 2, 0);
  const B = newPose();
  B.position.set(10, 4, 0);
  r.update(DT, cam, A);
  r.transition(0.45);
  for (let i = 0; i < 12; i++) r.update(DT, cam, B);
  const mid = r.pose.position.clone();
  // toggle back: the snapshot is the current blended pose, so the first frame cannot jump
  r.transition(0.45);
  r.update(DT, cam, A);
  const jump = r.pose.position.distanceTo(mid);
  const bound = mid.distanceTo(A.position) * MAX_SLOPE * DT / 0.45 + 1e-6;
  assert.ok(jump <= bound, `re-toggle jumped ${jump} (bound ${bound})`);
  for (let i = 0; i < 40; i++) r.update(DT, cam, A);
  assert.ok(r.pose.position.distanceTo(A.position) < 1e-9, 'did not land on the target');
});

test('controller: foot and helm blends, including a re-toggle mid-blend, stay inside the blend bound', () => {
  const ship = pose({ origin: [3, 1, -4], yaw: 0.5 });
  const r = rig();
  r.ctl.mode = 'foot';
  r.ctl.walker.placeOnDeck(new THREE.Vector3(0, deckY(0.5), zOf(0.5)));
  frames(r, ship, 40); // the first frame snaps; the rest is static
  // one segment: blend from the current pose toward `target` for `n` frames, bounded by the
  // blend formula with the snapshot at the segment start and the (static) target
  const segment = (n, target) => {
    const S = r.ctl.rig.pose.position.clone();
    const SQ = r.ctl.rig.pose.quaternion.clone();
    r.ctl.mode = target;
    let prev = S.clone();
    let prevQ = SQ.clone();
    for (let i = 0; i < n; i++) {
      frames(r, ship, 1);
      const B = r.ctl.livePose.position;
      const BQ = r.ctl.livePose.quaternion;
      const cur = r.ctl.rig.pose.position;
      const curQ = r.ctl.rig.pose.quaternion;
      const jump = cur.distanceTo(prev);
      const ang = curQ.angleTo(prevQ);
      const bound = S.distanceTo(B) * MAX_SLOPE * DT / 0.45 + 2e-4;
      const angBound = SQ.angleTo(BQ) * MAX_SLOPE * DT / 0.45 + 2e-4;
      assert.ok(jump <= bound, `${target}: jump ${jump} > bound ${bound} at frame ${i}`);
      assert.ok(ang <= angBound, `${target}: angle ${ang} > bound ${angBound} at frame ${i}`);
      prev = cur.clone();
      prevQ = curQ.clone();
    }
  };
  segment(27, 'foot'); // helm → foot, full blend
  frames(r, ship, 40);
  segment(10, 'helm'); // foot → helm, then re-toggled
  segment(27, 'foot'); // mid-blend re-toggle: snapshot is wherever the blend was
  frames(r, ship, 40);
  assert.equal(r.ctl.mode, 'foot');
});

test('controller: pitch is held to ±85 degrees on foot', () => {
  const ship = pose();
  const r = rig();
  r.ctl.mode = 'foot';
  r.ctl.walker.placeOnDeck(new THREE.Vector3(0, deckY(0.5), zOf(0.5)));
  r.input.mouseDY = 1e6;
  frames(r, ship, 1);
  assert.ok(Math.abs(r.ctl.pitch) <= (85 * Math.PI) / 180 + 1e-9, `pitch ${r.ctl.pitch}`);
  r.input.mouseDY = -1e6;
  frames(r, ship, 1);
  assert.ok(Math.abs(r.ctl.pitch) <= (85 * Math.PI) / 180 + 1e-9, `pitch ${r.ctl.pitch}`);
});

test('chase: the pivot leads along the ship velocity, clamped to 6 m', () => {
  const ship = pose({ origin: [0, 0, 0], vel: [20, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.autoCenter = false;
  frames(r, ship, 300);
  const cg = ship.cgWorld;
  near(r.ctl.chase.pivot.x - cg.x, 6, 0.05);
  near(r.ctl.chase.pivot.z - cg.z, 0, 0.05);
});

test('chase: spring arm never ends below terrain + 1.4 m on a synthetic hill, and pulls in', () => {
  // a 40 m hill with its crest where the orbit camera would sit 25 m out
  const hillX = Math.sin(0.5) * Math.cos(0.28) * 25;
  const hillZ = Math.cos(0.5) * Math.cos(0.28) * 25;
  const hill = {
    heightAt: (x, z) => 40 * Math.exp(-((x - hillX) ** 2 + (z - hillZ) ** 2) / (2 * 6 * 6)),
    normalAt: (x, z, out) => out.set(0, 1, 0),
  };
  const ship = pose({ origin: [0, 0, 0], yaw: 0, cg: [0, 1.3, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.autoCenter = false;
  r.ctl.chaseYaw = 0.5;
  r.ctl.chasePitch = 0.28;
  r.ctl.chaseDist = 42;
  frames(r, ship, 180, hill);
  const pulled = r.ctl.chase.arm;
  assert.ok(pulled < 42 - 1, `arm not pulled in: ${pulled}`);
  // now sweep the orbit through the hill
  for (let i = 0; i < 600; i++) {
    r.ctl.chaseYaw += 0.01;
    frames(r, ship, 1, hill);
    const c = r.camera.position;
    const floor = hill.heightAt(c.x, c.z) + 1.4;
    assert.ok(c.y >= floor - 1e-6, `camera y ${c.y} below terrain+1.4 (${floor}) at sweep ${i}`);
  }
});

test('chase: steering shortens the idle delay before the recentre', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const settle = (steering) => {
    const r = rig();
    r.ctl.mode = 'chase';
    r.ctl.chaseYaw = 1.0;
    r.ctl.shipSpeed = 3;
    r.ctl.chaseHints = { steering, yawRate: 0, docking: 0 };
    frames(r, ship, 72); // 1.2 s with no look input
    return r.ctl.chaseYaw;
  };
  assert.ok(settle(true) < 0.95, `steering did not recentre: ${settle(true)}`);
  near(settle(false), 1.0, 1e-9); // 1.2 s is inside the 2 s delay
});

test('chase: a constant yaw rate settles to the clamped turn offset (outside of the turn)', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const offsetAt = (rate) => {
    const r = rig();
    r.ctl.mode = 'chase';
    r.ctl.chaseHints = { steering: false, yawRate: rate, docking: 0 };
    frames(r, ship, 480); // 8 s idle
    return r.ctl.chaseAutoYaw;
  };
  near(offsetAt(0.5), -0.35, 0.01); // turning to starboard: camera swings to port, clamped at 0.35 rad
  near(offsetAt(0.05), -0.11, 0.01); // small rate: linear, 2.2 × rate
  near(offsetAt(-0.5), 0.35, 0.01);
});

test('chase: docking pulls the pitch toward 0.62 and the distance out to 48 m', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.chaseDist = 42;
  r.ctl.chaseHints = { steering: false, yawRate: 0, docking: 1 };
  frames(r, ship, 14 * 60);
  near(r.ctl.chasePitch, 0.62, 0.02);
  near(r.ctl.chase.arm, 48, 0.5);
});

test('chase: speed lowers the pitch goal and widens the distance by up to 15%', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.chaseDist = 42;
  r.ctl.shipSpeed = 5;
  frames(r, ship, 12 * 60); // idle, under way
  near(r.ctl.chasePitch, 0.18, 0.02);
  near(r.ctl.chase.arm, 42 * 1.15, 0.5);
});

test('chase: manual look wins; a pending turn offset folds into the user yaw without a jump', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.chaseHints = { steering: false, yawRate: 0.5, docking: 0 };
  frames(r, ship, 300);
  const offset = r.ctl.chaseAutoYaw;
  assert.ok(offset < -0.3, `no turn offset: ${offset}`);
  const c0 = r.ctl.chaseYaw;
  r.input.mouseDX = 20;
  r.ctl.update(DT, ship, new WalkGeometry(sea), flat, waves, 0);
  near(r.ctl.chaseAutoYaw, 0, 1e-12);
  near(r.ctl.chaseYaw, c0 + offset - 20 * 0.0022, 1e-6);
});

test('shake: trauma decays to zero within 0.8 s from one; shake stays a few degrees', () => {
  const r = new CameraRig();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  const live = newPose();
  live.quaternion.setFromEuler(new THREE.Euler(0.1, 0.2, 0, 'YXZ'));
  r.update(DT, cam, live);
  r.addTrauma(1);
  let maxAngle = 0;
  for (let i = 0; i < 48; i++) {
    r.update(DT, cam, live);
    maxAngle = Math.max(maxAngle, cam.quaternion.angleTo(live.quaternion));
  }
  near(r.trauma, 0, 1e-9);
  assert.ok(maxAngle > 0.005 && maxAngle < 0.12, `shake angle ${maxAngle}`);
  // the base pose is free of shake
  near(r.pose.quaternion.angleTo(live.quaternion), 0, 1e-6); // acos rounding near 1 is ~3e-8
});

test('input: no pointer lock by default; the mouse only looks when mouse look is on', () => {
  const calls = { n: 0 };
  const inp = new Input(fakeEl(calls));
  inp.lock();
  assert.equal(calls.n, 0, 'pointer lock requested by default');
  const move = (movementX, movementY = 0) => fireDom('document', 'mousemove', { movementX, movementY, target: {} });
  const down = () => fireDom('document', 'mousedown', { button: 0 });
  const up = () => fireDom('document', 'mouseup', { button: 0 });
  move(40);
  down();
  move(30, 5);
  assert.equal(inp.mouseDX, 0, 'mouse turned the view by default');
  up();
  inp.endFrame();
  inp.mouseLook = true;
  inp.lock();
  assert.equal(calls.n, 1, 'mouse look did not request the lock');
  down();
  move(30, 5);
  assert.equal(inp.mouseDX, 30, 'drag did not look with mouse look on');
  assert.equal(inp.mouseDY, 5);
  up();
  assert.equal(inp.clicked, false, 'a drag counted as a click');
  inp.endFrame();
  assert.equal(inp.hoverLook, false, 'hover look is gone');
});

test('input: a short LMB press is a click; Enter is a click; a drag is not', () => {
  const inp = new Input(fakeEl());
  const move = (movementX, movementY = 0) => fireDom('document', 'mousemove', { movementX, movementY, target: {} });
  const down = () => fireDom('document', 'mousedown', { button: 0 });
  const up = () => fireDom('document', 'mouseup', { button: 0 });
  down();
  move(1, 2); // about 2.2 px
  up();
  assert.equal(inp.clicked, true, 'short press not a click');
  inp.endFrame();
  assert.equal(inp.clicked, false, 'click did not clear');
  down();
  move(10);
  up();
  assert.equal(inp.clicked, false, 'a drag counted as a click');
  inp.endFrame();
  fireDom('window', 'keydown', { code: 'Enter', repeat: false });
  assert.equal(inp.clicked, true, 'Enter is not a click');
  inp.endFrame();
  fireDom('window', 'keydown', { code: 'NumpadEnter', repeat: false });
  assert.equal(inp.clicked, true, 'NumpadEnter is not a click');
  inp.endFrame();
});

test('arrow look: a tap is a fine adjustment, a hold sweeps, and the rate changes smoothly', () => {
  const inp = new Input(fakeEl());
  const dt = DT;
  inp.keys.add('ArrowRight');
  const first = inp.look(dt).yaw;
  // the first frame must not step to the fast rate
  assert.ok(first < 0.004, `first frame stepped: ${first} rad`); // a step to 0.7 rad/s would be 0.012
  let tap = first;
  for (let i = 0; i < 2; i++) tap += inp.look(dt).yaw;
  inp.keys.clear();
  for (let i = 0; i < 60; i++) tap += inp.look(dt).yaw; // release: decays to zero
  assert.ok(tap > 0.01 && tap < 0.05, `tap turned ${tap} rad (want a fine adjustment)`);
  // a one-second hold: the rate ramps 0.7 → 2.2 rad/s over the first 0.4 s, then holds
  inp.keys.add('ArrowRight');
  let prevRate = 0;
  let maxStep = 0;
  let rate = 0;
  let hold = 0;
  for (let i = 0; i < 60; i++) {
    const d = inp.look(dt).yaw;
    rate = d / dt;
    hold += d;
    maxStep = Math.max(maxStep, Math.abs(rate - prevRate));
    prevRate = rate;
  }
  near(rate, 2.2, 0.05);
  assert.ok(hold > 1.5 && hold < 2.5, `hold turned ${hold} rad`);
  assert.ok(maxStep < 0.2, `rate stepped by ${maxStep} rad/s in one frame`);
  // pitch: 0.5 → 1.3 rad/s, and look speed scales both
  inp.keys.clear();
  inp.keys.add('ArrowDown');
  let pr = 0;
  for (let i = 0; i < 60; i++) pr = inp.look(dt).pitch / dt;
  near(pr, 1.3, 0.05);
  inp.keys.clear();
  for (let i = 0; i < 60; i++) inp.look(dt);
  inp.lookSpeed = 0.5;
  inp.keys.add('ArrowRight');
  for (let i = 0; i < 60; i++) rate = inp.look(dt).yaw / dt;
  near(rate, 1.1, 0.03);
});

test('chase: Minus zooms out and Equal zooms in, smoothly while held', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.chaseDist = 42;
  frames(r, ship, 1);
  r.keys.add('Minus');
  frames(r, ship, 60);
  near(r.ctl.chaseDist, 42 * Math.exp(0.9), 0.5);
  r.keys.clear();
  r.keys.add('Equal');
  frames(r, ship, 120);
  assert.ok(r.ctl.chaseDist < 42 * Math.exp(0.9) * 0.5, `Equal did not zoom in: ${r.ctl.chaseDist}`);
});

test('chase: arrow keys orbit, and count as manual look for the auto-recentre timer', () => {
  const ship = pose({ origin: [0, 0, 0] });
  const r = rig();
  r.ctl.mode = 'chase';
  r.ctl.shipSpeed = 3;
  r.ctl.chaseYaw = 0.5;
  r.keys.add('ArrowRight');
  frames(r, ship, 30);
  assert.ok(r.ctl.chaseYaw < 0.5 - 0.1, `arrow did not orbit: ${r.ctl.chaseYaw}`);
  r.keys.clear();
  assert.equal(r.ctl.chaseHints.steering, false);
  // let the release tail die away (τ = 0.08 s); then, still inside the 2 s idle delay, nothing recentres
  frames(r, ship, 30);
  const before = r.ctl.chaseYaw;
  frames(r, ship, 60);
  // a recentre would move ~0.27 rad in this second; the release tail left is ~3e-4
  near(r.ctl.chaseYaw, before, 0.005);
});

console.log(failures ? `${failures} failing` : 'all camera tests passed');
process.exitCode = failures ? 1 : 0;
