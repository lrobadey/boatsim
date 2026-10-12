// Headless walker tests: frames, rail and vault, plank to quay, swim to beach, hull, climb, feel.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { Walker, shipYaw } = await import('../src/player/walker.ts');
const { CameraFeel } = await import('../src/player/cameraFeel.ts');
const { Interactions } = await import('../src/player/interact.ts');
const { WalkGeometry } = await import('../src/world/walkable.ts');
const { deckY, halfBeam, zOf, DECK_S0, DECK_S1 } = await import('../src/ship/hull.ts');
const { PlayerController } = await import('../src/player/controller.ts');
const { deckHalfWidth, outrigger } = await import('../src/ship/trireme.ts');

const DT = 1 / 60;
let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (e) {
    failures++;
    console.error('FAIL', name, (e.stack ?? e.message).split('\n').slice(0, 4).join(' | '));
  }
}
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b} (tol ${e})`);

// ── mocks ──
const sea = {
  heightAt: () => -5,
  normalAt: (x, z, out) => out.set(0, 1, 0),
};
const waves = { heightAt: () => 0 };
const Y = new THREE.Vector3(0, 1, 0);

function pose({ origin = [0, 0, 0], yaw = 0, plank = null, solids = new WalkGeometry(null) } = {}) {
  return {
    origin: new THREE.Vector3(...origin),
    quat: new THREE.Quaternion().setFromAxisAngle(Y, -yaw),
    cgWorld: new THREE.Vector3(origin[0], origin[1] + 0.3, origin[2]),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    plank,
    solids,
  };
}

function seaWorld(extra = []) {
  const g = new WalkGeometry(sea);
  for (const s of extra) g.add(s);
  return g;
}

/** run `seconds` of sim; `keys` gives fwd/strafe/run and a one-shot jump; `view.yaw` follows frame events */
function sim(w, seconds, keys, ship, W, view = { yaw: 0 }) {
  const events = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    w.update(DT, { fwd: keys.fwd ?? 0, strafe: keys.strafe ?? 0, run: !!keys.run, jump: i === 0 && !!keys.jump, yaw: view.yaw }, ship, W, waves, 0);
    for (const e of w.events) {
      if (e.type === 'frame') view.yaw += e.yawDelta;
      events.push(e);
    }
  }
  return events;
}

const deckAt = (s) => new THREE.Vector3(0, deckY(s), zOf(s));

// ── tests ──

test('frame round trip keeps the foot and the view continuous', () => {
  const ship = pose({ origin: [3, 1, -4], yaw: 0.7 });
  const s = 0.62;
  const hw = deckHalfWidth(s);
  ship.plank = {
    station: s,
    side: 1,
    deployed: 1,
    deckLocal: new THREE.Vector3(hw, deckY(s), zOf(s)),
    shoreWorld: new THREE.Vector3(3 + hw + 1.6, 1.8, -4 + zOf(s)),
    width: 0.7,
  };
  const W = seaWorld();
  const w = new Walker();
  // just outside the deck edge, inside the plank opening: stepping out leaves the footprint
  const A = new THREE.Vector3(hw + 0.02, deckY(s), zOf(s));
  w.placeOnDeck(A);
  const view = { yaw: 0.4 };
  const before = A.clone().applyQuaternion(ship.quat).add(ship.origin);
  w.update(0, { fwd: 0, strafe: 0, run: false, jump: false, yaw: view.yaw }, ship, W, waves, 0);
  assert.equal(w.frame, 'world');
  const f1 = w.events.find((e) => e.type === 'frame');
  assert.ok(f1, 'frame event');
  assert.ok(w.world.distanceTo(before) < 1e-3, `foot moved ${w.world.distanceTo(before)} m on switch`);
  near(f1.yawDelta, shipYaw(ship.quat), 1e-9);
  view.yaw += f1.yawDelta;
  // the view direction in the world equals the ship-relative view rotated by the ship
  const fwdWorld = new THREE.Vector3(-Math.sin(view.yaw), 0, -Math.cos(view.yaw));
  const fwdShip = new THREE.Vector3(-Math.sin(0.4), 0, -Math.cos(0.4)).applyQuaternion(ship.quat);
  near(fwdWorld.x, fwdShip.x, 1e-9);
  near(fwdWorld.z, fwdShip.z, 1e-9);

  // back onto the deck: the same ship pose maps the world point to the same local point
  const B = new THREE.Vector3(0.1, deckY(0.85) + 0.05, zOf(0.85));
  w.pos.copy(B).applyQuaternion(ship.quat).add(ship.origin);
  const worldB = w.pos.clone();
  w.update(0, { fwd: 0, strafe: 0, run: false, jump: false, yaw: view.yaw }, ship, W, waves, 0);
  assert.equal(w.frame, 'ship');
  const f2 = w.events.find((e) => e.type === 'frame');
  assert.ok(f2 && f2.frame === 'ship');
  assert.ok(w.pos.distanceTo(B) < 1e-6, `local foot off by ${w.pos.distanceTo(B)}`);
  assert.ok(w.world.distanceTo(worldB) < 1e-6, 'world foot changed on board');
  near(f2.yawDelta, -shipYaw(ship.quat), 1e-9);
  view.yaw += f2.yawDelta;
  near(view.yaw, 0.4, 1e-9);
});

test('the bow and stern rails stop the walker', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  w.placeOnDeck(deckAt(0.5));
  const view = { yaw: 0 };
  // yaw 0 looks along −z (the bow)
  sim(w, 10, { fwd: 1 }, ship, W, view);
  assert.equal(w.frame, 'ship', 'left the deck at the bow');
  assert.ok(Math.abs(w.pos.z - zOf(DECK_S0)) < 1e-6, `bow rail at ${w.pos.z}`);
  assert.equal(w.touchingEnd, -1, 'bow rail prompt not raised');
  sim(w, 20, { fwd: -1 }, ship, W, view);
  assert.equal(w.frame, 'ship', 'left the deck at the stern');
  assert.ok(Math.abs(w.pos.z - zOf(DECK_S1)) < 1e-6, `stern rail at ${w.pos.z}`);
  assert.equal(w.touchingEnd, 1, 'stern rail prompt not raised');
});

test('vault over the bow or stern rail launches along the ship', () => {
  const ship = pose();
  const W = seaWorld();
  for (const [fwd, sign] of [[-1, 1], [1, -1]]) {
    const w = new Walker();
    w.placeOnDeck(deckAt(0.5));
    const view = { yaw: 0 };
    const end = sign > 0 ? zOf(DECK_S1) : zOf(DECK_S0);
    sim(w, 10, { fwd }, ship, W, view); // walk to the end rail
    const ev = sim(w, 0.02, { fwd, jump: true }, ship, W, view);
    assert.ok(ev.some((e) => e.type === 'vault'), `no vault at the ${sign > 0 ? 'stern' : 'bow'}`);
    assert.equal(w.frame, 'world');
    sim(w, 0.5, {}, ship, W, view);
    const out = (w.world.z - end) * sign;
    assert.ok(out > 1.0, `vault did not clear the rail (${out} m beyond)`);
    // the hull's side zone at the bow and stern tips pushes a foot that lands there out sideways
    assert.ok(Math.abs(w.world.x) < 1.0, `vault drifted sideways (x ${w.world.x})`);
  }
});

test('the walkable strip stays at least 0.35 m wide at the stern', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  // the aft deck is nearly a line; a foot 0.3 m off the centreline still stands aboard
  w.placeOnDeck(new THREE.Vector3(0.3, deckY(0.92), zOf(0.92)));
  sim(w, 1, {}, ship, W, { yaw: 0 });
  assert.equal(w.frame, 'ship', 'squeezed off the deck at the stern');
});

test('rail blocks without Space', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  const s = 0.5;
  w.placeOnDeck(deckAt(s));
  const view = { yaw: 0 };
  // push starboard into the rail for 3 s
  sim(w, 3, { strafe: 1 }, ship, W, view);
  const lim = deckHalfWidth(s) - 0.3;
  assert.equal(w.frame, 'ship', 'left the deck');
  assert.ok(Math.abs(w.pos.x) <= lim + 1e-6, `x ${w.pos.x} beyond rail ${lim}`);
  assert.ok(w.pos.x > lim - 0.05, `did not reach the rail (x ${w.pos.x})`);
  assert.equal(w.touchingRail, 1, 'rail prompt not raised');
});

test('vault goes over the side and lands in the world frame', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  w.placeOnDeck(deckAt(0.5));
  const view = { yaw: 0 };
  sim(w, 1, { strafe: 1 }, ship, W, view);
  const ev = sim(w, 0.02, { strafe: 1, jump: true }, ship, W, view);
  assert.ok(ev.some((e) => e.type === 'vault'), 'no vault event');
  assert.equal(w.frame, 'world');
  assert.ok(w.scripted, 'vault not scripted');
  sim(w, 0.6, {}, ship, W, view);
  assert.equal(w.scripted, false, 'vault still scripted');
  assert.equal(w.frame, 'world', 'not in the world frame after the vault');
  const hw = deckHalfWidth(0.5);
  assert.ok(w.world.x > hw, `vault did not clear the rail (x ${w.world.x})`);
  // the sea below takes her
  sim(w, 2, {}, ship, W, view);
  assert.ok(w.swimming, 'did not reach the water after the vault');
});

test('walking down the gangplank reaches the quay', () => {
  const s = 0.62;
  const hw = deckHalfWidth(s);
  const ship = pose({
    plank: {
      station: s,
      side: 1,
      deployed: 1,
      deckLocal: new THREE.Vector3(hw, deckY(s), zOf(s)),
      shoreWorld: new THREE.Vector3(hw + 1.6, 1.8, zOf(s)),
      width: 0.7,
    },
  });
  const quay = { kind: 'box', cx: hw + 1.6 + 8, cz: zOf(s), hx: 8, hz: 30, rot: 0, y0: -5, y1: 1.8, surface: 'stone', walkTop: true };
  const W = seaWorld([quay]);
  const w = new Walker();
  w.placeOnDeck(deckAt(s));
  const view = { yaw: 0 };
  // stroll starboard along the plank and onto the quay
  sim(w, 7, { strafe: 1 }, ship, W, view);
  assert.equal(w.frame, 'world', 'never left the deck');
  assert.ok(!w.swimming, 'fell in instead of walking the plank');
  near(w.world.y, 1.8, 0.02);
  assert.ok(w.world.x > hw + 2, `did not reach the quay (x ${w.world.x})`);
});

test('a deck below the quay: up the plank from its inboard foot onto the quay, and back down to the deck', () => {
  // the merchant's case: the quay top 1.2 m above her deck, the plank's foot set inboard, resting on the
  // quay's top edge and overhanging it (Mooring.updatePlank)
  const s = 0.62;
  const hw = deckHalfWidth(s);
  const dy = deckY(s);
  const top = dy + 1.2;
  const face = hw + 0.44;
  const footX = 0.3;
  const a = Math.atan2(top - dy, face - footX);
  const L = 3.1;
  const ship = pose({
    plank: {
      station: s,
      side: 1,
      deployed: 1,
      deckLocal: new THREE.Vector3(footX, dy, zOf(s)),
      shoreWorld: new THREE.Vector3(footX + L * Math.cos(a), dy + L * Math.sin(a), zOf(s)),
      width: 0.7,
      length: L,
      resting: true,
      restWorld: new THREE.Vector3(face, top, zOf(s)),
    },
  });
  const quay = { kind: 'box', cx: face + 8, cz: zOf(s), hx: 8, hz: 30, rot: 0, y0: -5, y1: top, surface: 'stone', walkTop: true };
  const W = seaWorld([quay]);
  const w = new Walker();
  w.placeOnDeck(deckAt(s));
  const view = { yaw: 0 };
  sim(w, 2.5, { strafe: 1 }, ship, W, view);
  assert.equal(w.frame, 'world', 'never left the deck');
  assert.ok(!w.swimming, 'fell in instead of climbing the plank');
  near(w.world.y, top, 0.02);
  assert.ok(w.world.x > face + 0.5, `did not reach the quay (x ${w.world.x})`);
  sim(w, 4, { strafe: -1 }, ship, W, view);
  assert.equal(w.frame, 'ship', 'did not come back aboard');
  assert.ok(!w.swimming, 'fell in on the way down');
  near(w.pos.y, dy, 0.02);
});

test('a plank that is not resting on the quay cannot be walked', () => {
  const s = 0.62;
  const hw = deckHalfWidth(s);
  const ship = pose({
    plank: {
      station: s, side: 1, deployed: 1, width: 0.7, resting: false,
      deckLocal: new THREE.Vector3(hw, deckY(s), zOf(s)),
      shoreWorld: new THREE.Vector3(hw + 1.6, 1.8, zOf(s)),
    },
  });
  const quay = { kind: 'box', cx: hw + 1.6 + 8, cz: zOf(s), hx: 8, hz: 30, rot: 0, y0: -5, y1: 1.8, surface: 'stone', walkTop: true };
  const W = seaWorld([quay]);
  const w = new Walker();
  w.placeOnDeck(deckAt(s));
  sim(w, 7, { strafe: 1 }, ship, W, { yaw: 0 });
  assert.ok(w.frame === 'ship' || w.swimming || w.world.y < 1.7, 'walked a plank that is not on the quay');
});

test('swim to the beach exits to walking', () => {
  // sea floor -5 until x = -20, shelving to 0 at x = 0, then land at 0.4
  const beach = {
    heightAt: (x) => (x < -20 ? -5 : x < 0 ? -5 + 0.25 * (x + 20) : 0.4),
    normalAt: (x, z, out) => {
      const sl = x > -20 && x < 0 ? 0.25 : 0;
      const l = Math.hypot(sl, 1);
      return out.set(-sl / l, 1 / l, 0);
    },
  };
  const W = new WalkGeometry(beach);
  const ship = pose();
  const w = new Walker();
  w.frame = 'world';
  w.pos.set(-15, -0.5, 0);
  const view = { yaw: -Math.PI / 2 };
  sim(w, 1, { fwd: 1 }, ship, W, view);
  assert.ok(w.swimming, 'did not swim in deep water');
  let exited = false;
  for (let t = 0; t < 60 && !exited; t += DT) {
    sim(w, DT, { fwd: 1 }, ship, W, view);
    if (!w.swimming) exited = true;
  }
  assert.ok(exited, 'never walked out of the water');
  assert.ok(w.grounded, 'not grounded after landing on the beach');
  assert.ok(w.world.x > -6, `left the water too early (x ${w.world.x})`);
  // and it keeps walking on land
  sim(w, 2, { fwd: 1 }, ship, W, view);
  assert.ok(w.world.x > -4, 'did not walk on the beach');
  assert.equal(w.swimming, false);
});

test('hull pushes a swimmer out', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  w.frame = 'world';
  w.pos.set(2.0, -1.54, 0);
  w.update(DT, { fwd: 0, strafe: 0, run: false, jump: false, yaw: 0 }, ship, W, waves, 0);
  const side = halfBeam(0.5) + outrigger(0.5) + 0.3;
  assert.ok(w.swimming, 'not swimming');
  assert.ok(w.pos.x >= side - 1e-3, `not pushed out: x ${w.pos.x} < ${side}`);
});

test('climb aboard from the water within reach, refused beyond it', () => {
  const ship = pose();
  const W = seaWorld();
  const outer = halfBeam(0.5) + outrigger(0.5);
  const near1 = new Walker();
  near1.frame = 'world';
  near1.pos.set(outer + 1.0, -1.54, 0);
  near1.update(DT, { fwd: 0, strafe: 0, run: false, jump: false, yaw: 0 }, ship, W, waves, 0);
  assert.ok(near1.swimming, 'not swimming before climbing');
  assert.ok(near1.climbAboard(ship), 'climb refused within 2.2 m');
  assert.ok(near1.scripted);
  const view = { yaw: 0 };
  const ev = sim(near1, 1, {}, ship, W, view);
  assert.ok(ev.some((e) => e.type === 'frame' && e.frame === 'ship'), 'no return to the ship frame');
  assert.equal(near1.frame, 'ship');
  assert.equal(near1.scripted, false);
  const hw = deckHalfWidth(sOfZ(near1.pos.z));
  near(near1.pos.x, hw - 0.4, 1e-3);

  const far = new Walker();
  far.frame = 'world';
  far.pos.set(outer + 3.5, -1.54, 0);
  far.update(DT, { fwd: 0, strafe: 0, run: false, jump: false, yaw: 0 }, ship, W, waves, 0);
  assert.equal(far.climbAboard(ship), false, 'climb accepted beyond 2.2 m');
});

test('a jump peaks at about 0.62 m on deck', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  w.placeOnDeck(deckAt(0.5));
  const base = deckY(0.5);
  let peak = 0;
  const view = { yaw: 0 };
  sim(w, 0.02, { jump: true }, ship, W, view);
  for (let i = 0; i < 120; i++) {
    sim(w, DT, {}, ship, W, view);
    peak = Math.max(peak, w.pos.y - base);
  }
  assert.ok(Math.abs(peak - 0.624) < 0.03, `apex ${peak}`);
  assert.ok(w.grounded, 'did not land');
});

test('the mast blocks the walker', () => {
  const mz = zOf(0.42);
  const solids = new WalkGeometry(null);
  solids.add({ kind: 'cyl', cx: 0, cz: mz, r: 0.25, y0: 0, y1: 9, surface: 'wood', walkTop: false });
  const ship = pose({ solids });
  const W = seaWorld();
  const w = new Walker();
  w.placeOnDeck(new THREE.Vector3(0, deckY(0.5), mz + 1.2));
  sim(w, 3, { fwd: 1 }, ship, W, { yaw: 0 });
  const d = Math.hypot(w.pos.x, w.pos.z - mz);
  assert.ok(d >= 0.25 + 0.3 - 0.01, `walked into the mast (distance ${d})`);
});

test('stride feel emits footsteps and bob while walking', () => {
  const ship = pose();
  const W = seaWorld();
  const w = new Walker();
  w.placeOnDeck(deckAt(0.5));
  const feel = new CameraFeel();
  const view = { yaw: 0 };
  let steps = 0;
  let minY = 0;
  const n = Math.round(2 / DT);
  for (let i = 0; i < n; i++) {
    const input = { fwd: 1, strafe: 0, run: false, jump: false, yaw: view.yaw };
    w.update(DT, input, ship, W, waves, 0);
    feel.update(DT, w, input, ship);
    steps += feel.events.filter((e) => e.type === 'step').length;
    minY = Math.min(minY, feel.offset.y);
  }
  assert.ok(steps >= 4, `only ${steps} footsteps in 2 s`);
  assert.ok(minY < -0.02, `no bob (min ${minY})`);
  assert.ok(feel.fovAdd < 1, 'run FOV kick while walking');
});

test('interactions pick the nearest in the cone and within radius', () => {
  const ints = new Interactions();
  const eye = new THREE.Vector3(0, 0, 0);
  const view = new THREE.Vector3(0, 0, -1);
  const mk = (id, x, z, radius = 2.2) => ({ id, label: id, frame: 'world', pos: new THREE.Vector3(x, 0, z), radius, enabled: () => true, act() {} });
  const a = mk('ahead', 0, -1.0);
  const b = mk('off25', Math.sin(0.44) * 1.0, -Math.cos(0.44) * 1.0);
  const far = mk('far', 0, -3.0);
  const wide = mk('wide40', Math.sin(0.7) * 1.0, -Math.cos(0.7) * 1.0);
  const disabled = { ...mk('dis', 0, -0.8), enabled: () => false };
  ints.list.push(b, far, wide, disabled, a);
  ints.update(eye, view, new THREE.Vector3(), new THREE.Quaternion());
  assert.equal(ints.target?.id, 'ahead');
  ints.list = [b, far, wide];
  ints.update(eye, view, new THREE.Vector3(), new THREE.Quaternion());
  assert.equal(ints.target?.id, 'off25');
  ints.list = [far, wide];
  ints.update(eye, view, new THREE.Vector3(), new THREE.Quaternion());
  assert.equal(ints.target, null);
});

// ── camera (controller) ──
const terrainMock = { heightAt: () => 0 };
function rig() {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 5000);
  const keys = new Set();
  const pressed = new Set();
  const input = {
    mouseDX: 0, mouseDY: 0, lookX: 0, lookY: 0, sensitivity: 0.0022, invertY: false, rmb: false, wheel: 0,
    down: (c) => keys.has(c),
    hit: (c) => pressed.has(c),
    look: () => ({ yaw: 0, pitch: 0 }),
  };
  const ctl = new PlayerController(camera, input);
  return { ctl, camera, keys, pressed };
}
function camFrame(r, ship, n = 1, dt = 1 / 60) {
  for (let i = 0; i < n; i++) {
    r.ctl.update(dt, ship, seaWorld(), terrainMock, waves, 0);
    r.pressed.clear();
  }
}
const forwardOf = (q) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

test('world view: after the ramp the camera is pure yaw/pitch, matching the input', () => {
  const ship = pose({ origin: [3, 1, -4], yaw: 0.7 });
  // a tilted ship: the view must not inherit any of it once it is in the world
  ship.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.12));
  ship.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.06));
  const r = rig();
  r.ctl.mode = 'foot';
  r.ctl.walker.placeOnDeck(deckAt(0.5));
  r.ctl.yaw = 0.3;
  r.ctl.pitch = 0.2;
  camFrame(r, ship, 20);
  // walk to the starboard rail and vault over it
  r.keys.add('KeyD');
  camFrame(r, ship, 60);
  const before = forwardOf(r.camera.quaternion).clone();
  r.pressed.add('Space');
  camFrame(r, ship, 1);
  assert.equal(r.ctl.walker.frame, 'world', 'vault did not switch to the world frame');
  // no snap at the switch: the on-screen direction is preserved
  const after = forwardOf(r.camera.quaternion);
  assert.ok(before.angleTo(after) < 1e-3, `view snapped by ${before.angleTo(after)} rad at the switch`);
  r.keys.clear();
  camFrame(r, ship, 60); // the 0.6 s ramp, then a second of settling
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.ctl.pitch, r.ctl.yaw, 0, 'YXZ'));
  assert.ok(r.camera.quaternion.angleTo(expected) < 1e-3, `not pure yaw/pitch: off by ${r.camera.quaternion.angleTo(expected)} rad`);
  const f = forwardOf(r.camera.quaternion);
  near(Math.asin(f.y), r.ctl.pitch, 1e-3);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(r.camera.quaternion);
  near(right.y, 0, 1e-3);
});

test('boarding from the world keeps the view and levels the ship view back in', () => {
  const ship = pose({ origin: [3, 1, -4], yaw: 0.7 });
  ship.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.1));
  const r = rig();
  r.ctl.mode = 'foot';
  r.ctl.walker.frame = 'world';
  r.ctl.walker.pos.copy(new THREE.Vector3(3, -1.5, -4).add(new THREE.Vector3(0, 0, 0)));
  r.ctl.walker.pos.set(30, -1.5, 0);
  r.ctl.yaw = 0.8;
  r.ctl.pitch = -0.1;
  camFrame(r, ship, 60);
  const before = forwardOf(r.camera.quaternion).clone();
  // step back onto the deck footprint
  const B = new THREE.Vector3(0.1, deckY(0.5) + 0.05, zOf(0.5));
  r.ctl.walker.swimming = false;
  r.ctl.walker.grounded = true;
  r.ctl.walker.pos.copy(B).applyQuaternion(ship.quat).add(ship.origin);
  camFrame(r, ship, 1);
  assert.equal(r.ctl.walker.frame, 'ship', 'did not board');
  const after = forwardOf(r.camera.quaternion);
  assert.ok(before.angleTo(after) < 1e-3, `view snapped by ${before.angleTo(after)} rad on boarding`);
  // and the ship-referenced view settles on its own yaw/pitch
  camFrame(r, ship, 60);
  assert.equal(r.ctl.walker.frame, 'ship');
});

function sOfZ(z) {
  return z / 34 + 0.5;
}

console.log(failures ? `${failures} failing` : 'all walker tests passed');
process.exitCode = failures ? 1 : 0;
