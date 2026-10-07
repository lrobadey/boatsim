// Deck building (WS-F), headless. The DOM palette is exercised through a minimal document stub
// (BuildUi only calls createElement and writes className, textContent, innerHTML, style and
// classList), the browser's localStorage is a Map, and the model kit is a fake whose objects are
// boxes. Each test builds a fresh ship.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.children = [];
    this.cls = new Set();
    this.classList = {
      toggle: (c, force) => {
        const on = force === undefined ? !this.cls.has(c) : !!force;
        if (on) this.cls.add(c);
        else this.cls.delete(c);
        return on;
      },
      add: (c) => this.cls.add(c),
      remove: (c) => this.cls.delete(c),
      contains: (c) => this.cls.has(c),
    };
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  addEventListener() {}
}
globalThis.document = { createElement: (tag) => new FakeEl(tag) };

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { DeckBuilder } = await import('../src/build/deckBuilder.ts');
const { PIECES, PAYLOAD_LIMIT } = await import('../src/build/pieces.ts');
const { deckY, sOf, zOf } = await import('../src/ship/hull.ts');
const { deckHalfWidth } = await import('../src/ship/trireme.ts');
const { WalkGeometry } = await import('../src/world/walkable.ts');

const KEY = 'trieres.deck.v1';
const DT = 1 / 60;
const idx = (id) => PIECES.findIndex((p) => p.id === id);
const KEY_OF = { crate: 'Digit1', amphora_rack: 'Digit2', lamp_post: 'Digit6', brazier: 'Digit7', altar: 'Digit9' };
const TAU = Math.PI * 2;

// Fake kit: every object is a box standing on y = 0, a lamp has a flame with the kit's fire emissive.
function makeKit() {
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  // like the real kit, every flame shares one material
  const fire = new THREE.MeshStandardMaterial({ color: 0x3a2412, emissive: 0xffb060, emissiveIntensity: 0 });
  return {
    objects: new Map(),
    get(name) {
      const g = new THREE.Group();
      g.name = name;
      g.add(new THREE.Mesh(box, new THREE.MeshStandardMaterial({ color: 0x888888 })));
      if (name === 'lamp_post') {
        const flame = new THREE.Mesh(box, fire);
        flame.position.y = 1.8;
        g.add(flame);
      }
      return g;
    },
    geometry: () => [],
  };
}

/** a world with a mast mid-ship, as the lead's ShipSolids would provide */
function newWorld() {
  const shipGroup = new THREE.Group();
  const payload = [];
  const solids = new WalkGeometry(null);
  solids.add({ kind: 'cyl', cx: 0, cz: zOf(0.5), r: 0.3, y0: 0, y1: 10, surface: 'wood', walkTop: false });
  const interactions = { list: [] };
  const crew = { stamina: 0.5 };
  const builder = new DeckBuilder(makeKit(), shipGroup, payload, solids, interactions, crew);
  builder.setActive(true);
  return { builder, shipGroup, payload, solids, interactions, crew };
}

const input = () => ({
  lmb: false,
  clicked: false,
  wheel: 0,
  keys: new Set(),
  hits: new Set(),
  down(c) {
    return this.keys.has(c);
  },
  hit(c) {
    return this.hits.has(c);
  },
});

/** eye 1.5 m above (x, z) on the deck, looking straight down at it */
function ctxAt(inp, x, z, extra = {}) {
  const T = new THREE.Vector3(x, deckY(sOf(z)), z);
  const eye = T.clone().add(new THREE.Vector3(0, extra.height ?? 1.5, 0));
  return {
    input: inp,
    eyeLocal: eye,
    dirLocal: extra.dir ? new THREE.Vector3(...extra.dir) : new THREE.Vector3(0, -1, 0),
    night: extra.night ?? 0,
    dayCount: extra.dayCount ?? 0,
    cameraWorld: new THREE.Vector3(0, 10, 0),
  };
}

/** one frame; returns the events it produced */
function frame(b, ctx, { key, lmb = false, wheel = 0 } = {}) {
  ctx.input.lmb = false;
  ctx.input.clicked = lmb; // Input.clicked: press and release with little travel
  ctx.input.wheel = wheel;
  ctx.input.hits.clear();
  if (key) ctx.input.hits.add(key);
  b.update(DT, ctx);
  const ev = [...b.events];
  ctx.input.hits.clear();
  ctx.input.wheel = 0;
  ctx.input.clicked = false;
  return ev;
}

/** LMB press and release; returns the events of the press frame */
function tap(b, ctx) {
  const ev = frame(b, ctx, { lmb: true });
  frame(b, ctx, { lmb: false });
  return ev;
}

const hintText = (b) => b.ui.hint.innerHTML;
const hintIsBad = (b) => b.ui.hint.cls.has('bad');

let failures = 0;
const report = [];
function test(name, fn) {
  store.clear();
  try {
    fn();
    report.push({ name, status: 'passed' });
    console.log('PASS', name);
  } catch (e) {
    failures++;
    report.push({ name, status: 'failed', error: e.message });
    console.error('FAIL', name, '\n  ', e.message.split('\n').slice(0, 6).join('\n   '));
  }
}
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b} (tol ${e})`);
const onGrid = (v) => Math.round(v / 0.25) * 0.25;
const Z_MID = -3.5; // on the grid, mid-deck (s about 0.4)

test('valid mid-deck placement: solid, payload and events agree', () => {
  const w = newWorld();
  const inp = input();
  const ev = tap(w.builder, ctxAt(inp, 1, Z_MID));
  assert.deepEqual(ev.map((e) => e.type), ['place']);
  assert.equal(w.payload.length, 1);
  near(w.payload[0].mass, 60);
  near(w.builder.payloadKg(), 60);
  assert.equal(w.solids.solids.length, 2, 'mast plus crate');
  const s = w.solids.solids.find((o) => o.kind === 'box');
  near(s.cx, 1);
  near(s.cz, Z_MID);
  near(s.y0, deckY(sOf(Z_MID)), 1e-9);
  near(s.y1 - s.y0, PIECES[0].height);
  assert.equal(s.surface, 'wood');
  assert.equal(s.walkTop, true);
  // the ghost is a MeshBasicMaterial clone; the placed crate keeps the kit's standard material
  const placed = w.shipGroup.children.filter((c) => c.name === 'crate' && c.children[0].material.isMeshStandardMaterial);
  assert.equal(placed.length, 1, 'one placed crate in the ship');
  assert.ok(store.get(KEY), 'saved');
  assert.equal(JSON.parse(store.get(KEY)).length, 1);
});

test('blocked on the mast', () => {
  const w = newWorld();
  const inp = input();
  const ev = tap(w.builder, ctxAt(inp, 0, 0));
  assert.deepEqual(ev, [{ type: 'deny', reason: 'Blocked' }]);
  assert.equal(w.payload.length, 0);
  assert.equal(w.solids.solids.length, 1);
  assert.equal(hintText(w.builder), 'Blocked');
  assert.ok(hintIsBad(w.builder));
});

test('blocked in the helm zone (s above 0.86)', () => {
  const w = newWorld();
  const ev = tap(w.builder, ctxAt(input(), 0, 13.5));
  assert.equal(sOf(13.5) > 0.86, true);
  assert.deepEqual(ev, [{ type: 'deny', reason: 'Keep the helm clear' }]);
  assert.equal(w.payload.length, 0);
});

test('blocked on the gangway side of the plank opening', () => {
  const w = newWorld();
  const zg = onGrid(zOf(0.62));
  const dhw = deckHalfWidth(0.62);
  const x = Math.floor((dhw - 0.6) / 0.25) * 0.25;
  const ev = tap(w.builder, ctxAt(input(), x, zg));
  assert.deepEqual(ev, [{ type: 'deny', reason: 'Keep the gangway clear' }]);
  // the same spot on the other side of the centreline is refused too
  const ev2 = tap(w.builder, ctxAt(input(), -x, zg));
  assert.deepEqual(ev2, [{ type: 'deny', reason: 'Keep the gangway clear' }]);
  // well forward of the plank the piece is fine
  const ev3 = tap(w.builder, ctxAt(input(), x, onGrid(zOf(0.3))));
  assert.deepEqual(ev3.map((e) => e.type), ['place']);
});

test('off the deck when a corner passes the gunwale margin', () => {
  const w = newWorld();
  const dhw = deckHalfWidth(sOf(Z_MID));
  const x = Math.floor((dhw - 0.2) / 0.25) * 0.25;
  const ev = tap(w.builder, ctxAt(input(), x, Z_MID));
  assert.deepEqual(ev, [{ type: 'deny', reason: 'Off the deck' }]);
});

test('out of reach beyond 4 m shows a refused ghost reason', () => {
  const w = newWorld();
  const inp = input();
  const ctx = ctxAt(inp, 1, Z_MID, { height: 5 });
  frame(w.builder, ctx);
  assert.equal(hintText(w.builder), 'Out of reach');
  const ev = tap(w.builder, ctx);
  assert.deepEqual(ev, [{ type: 'deny', reason: 'Out of reach' }]);
});

test('too heavy: projected load in the reason, nothing placed', () => {
  const w = newWorld();
  w.payload.push({ mass: 2400, local: new THREE.Vector3() });
  const inp = input();
  const ctx = ctxAt(inp, -1, Z_MID);
  frame(w.builder, ctx, { key: KEY_OF.amphora_rack });
  const ev = tap(w.builder, ctx);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'deny');
  assert.equal(ev[0].reason, 'Too heavy · 2.66 / 2.50 t');
  assert.equal(hintText(w.builder), 'Too heavy · 2.66 / 2.50 t');
  assert.equal(w.payload.length, 1, 'nothing added');
  assert.equal(w.builder.payloadKg(), 2400);
  assert.ok(PAYLOAD_LIMIT === 2500);
});

test('stacking: two levels of crate, no third', () => {
  const w = newWorld();
  const inp = input();
  const x = -1,
    z = -6;
  const ctx = ctxAt(inp, x, z);
  assert.deepEqual(tap(w.builder, ctx).map((e) => e.type), ['place']);
  // aiming at the crate top stacks a second one
  const top = tap(w.builder, ctxAt(inp, x, z, { height: 1.5 }));
  assert.deepEqual(top.map((e) => e.type), ['place'], 'second level placed');
  assert.equal(w.payload.length, 2);
  const upper = w.payload[1];
  near(upper.local.y, deckY(sOf(z)) + PIECES[0].height + PIECES[0].height / 2, 1e-9);
  near(upper.local.x, x);
  // a third level is refused
  const third = tap(w.builder, ctxAt(inp, x, z, { height: 1.5 }));
  assert.deepEqual(third, [{ type: 'deny', reason: 'Blocked' }]);
  assert.equal(w.payload.length, 2);
});

test('a crate cannot be stacked on a non-stackable piece, and the piece under a crate blocks it', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, Z_MID));
  // amphora rack is not stackable: aiming at the crate top reads as Blocked on the deck
  frame(w.builder, ctxAt(inp, 1, Z_MID, { height: 1.5 }), { key: KEY_OF.amphora_rack });
  assert.equal(hintText(w.builder), 'Blocked');
});

test('removing: the top must go first, then the base; payload and solids follow', () => {
  const w = newWorld();
  const inp = input();
  const x = -1,
    z = -6;
  tap(w.builder, ctxAt(inp, x, z));
  tap(w.builder, ctxAt(inp, x, z, { height: 1.5 }));
  assert.equal(w.payload.length, 2);

  // side ray passes the base crate below its top: the base is refused
  const side = { input: inp, eyeLocal: new THREE.Vector3(x, deckY(sOf(z)) + 0.3, z - 3), dirLocal: new THREE.Vector3(0, 0, 1), night: 0, dayCount: 0, cameraWorld: new THREE.Vector3() };
  const denied = frame(w.builder, side, { key: 'KeyX' });
  assert.deepEqual(denied, [{ type: 'deny', reason: 'Remove the top one first' }]);
  assert.equal(w.payload.length, 2);

  // straight down removes the top crate first
  const ev = frame(w.builder, ctxAt(inp, x, z, { height: 1.5 }), { key: 'KeyX' });
  assert.deepEqual(ev.map((e) => e.type), ['remove']);
  assert.equal(w.payload.length, 1);
  assert.equal(w.solids.solids.filter((o) => o.kind === 'box').length, 1);
  assert.equal(JSON.parse(store.get(KEY)).length, 1);

  // now the base can go
  const ev2 = frame(w.builder, ctxAt(inp, x, z, { height: 1.5 }), { key: 'KeyX' });
  assert.deepEqual(ev2.map((e) => e.type), ['remove']);
  assert.equal(w.payload.length, 0);
  assert.equal(w.solids.solids.length, 1, 'only the mast remains');
  assert.equal(JSON.parse(store.get(KEY)).length, 0);
});

test('the payload meter and the solids stay consistent through a mixed build', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, Z_MID)); // crate 60
  frame(w.builder, ctxAt(inp, -1, -8), { key: KEY_OF.amphora_rack });
  tap(w.builder, ctxAt(inp, -1, -8)); // amphora rack 260 at x=-1
  frame(w.builder, ctxAt(inp, 1, -10), { key: 'Digit3' }); // pithos
  tap(w.builder, ctxAt(inp, 1, -10)); // pithos 180
  near(w.builder.payloadKg(), 60 + 260 + 180);
  const boxes = w.solids.solids.filter((o) => o.kind === 'box').length;
  const stored = JSON.parse(store.get(KEY));
  assert.equal(boxes, stored.length);
  assert.equal(w.payload.length, stored.length);
  near(
    w.payload.reduce((m, p) => m + p.mass, 0),
    w.builder.payloadKg(),
  );
});

test('rotation: R is 90 degrees, Shift+R is 15 degrees, and the solid follows', () => {
  const w = newWorld();
  const inp = input();
  const ctx = ctxAt(inp, 1, Z_MID);
  frame(w.builder, ctx, { key: 'KeyR' });
  tap(w.builder, ctx);
  const box = () => w.solids.solids.find((o) => o.kind === 'box');
  near(box().rot, Math.PI / 2, 1e-9);
  // Shift+R from 90 degrees
  inp.keys.add('ShiftLeft');
  const ctx2 = ctxAt(inp, -1, Z_MID);
  frame(w.builder, ctx2, { key: 'KeyR' });
  inp.keys.delete('ShiftLeft');
  tap(w.builder, ctx2);
  const rots = w.solids.solids.filter((o) => o.kind === 'box').map((o) => ((o.rot % TAU) + TAU) % TAU);
  assert.ok(rots.some((r) => Math.abs(r - (Math.PI / 2 + Math.PI / 12)) < 1e-9), `rots ${rots}`);
});

test('digits and the wheel select pieces; the blurb follows', () => {
  const w = newWorld();
  const inp = input();
  const ctx = ctxAt(inp, 1, Z_MID);
  frame(w.builder, ctx, { key: KEY_OF.altar });
  assert.equal(w.builder.ui.blurb.textContent, PIECES[8].blurb);
  frame(w.builder, ctx, { key: 'Digit0' });
  assert.equal(w.builder.ui.blurb.textContent, PIECES[9].blurb, '0 selects the tenth card');
  frame(w.builder, ctx, { wheel: 1 });
  assert.equal(w.builder.ui.blurb.textContent, PIECES[10].blurb, 'wheel reaches the 11th card');
  frame(w.builder, ctx, { wheel: 2 });
  assert.equal(w.builder.ui.blurb.textContent, PIECES[0].blurb, 'wheel wraps across all 12');
});

test('inactive: no placement, palette hidden, pieces stay', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, Z_MID));
  w.builder.setActive(false);
  assert.equal(w.builder.ui.root.cls.has('on'), false);
  const ev = tap(w.builder, ctxAt(inp, -1, -8));
  assert.deepEqual(ev, []);
  assert.equal(w.payload.length, 1, 'existing piece kept');
  w.builder.setActive(true);
  assert.equal(w.builder.ui.root.cls.has('on'), true);
});

test('lamps: at most three real lights at night, all off by day', () => {
  const w = newWorld();
  const inp = input();
  const spots = [
    [1, -4],
    [-1, -4],
    [1, -9],
    [-1, -9],
  ];
  for (const [x, z] of spots) {
    frame(w.builder, ctxAt(inp, x, z), { key: KEY_OF.lamp_post });
    tap(w.builder, ctxAt(inp, x, z));
  }
  assert.equal(w.payload.length, 4);
  frame(w.builder, ctxAt(inp, 0, -13, { night: 1 }));
  const lights = w.shipGroup.children.filter((c) => c instanceof THREE.PointLight);
  assert.equal(lights.length, 3, 'three pooled lights in the ship');
  const visible = lights.filter((l) => l.visible);
  assert.equal(visible.length, 3);
  for (const l of visible) {
    assert.ok(l.intensity > 0, 'lit at night');
    assert.equal(l.castShadow, false);
  }
  const flame = [];
  w.shipGroup.traverse((o) => {
    if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.emissive && o.material.emissive.getHex() === 0xffb060) flame.push(o.material);
  });
  assert.ok(flame.length > 0);
  frame(w.builder, ctxAt(inp, 0, -13, { night: 0 }));
  assert.equal(lights.filter((l) => l.visible).length, 0, 'no lights by day');
});

test('altar: once per day, restores stamina, interaction tracks the piece', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, -6)); // placeholder so the world is not empty
  frame(w.builder, ctxAt(inp, -1, -10), { key: KEY_OF.altar });
  const ev = tap(w.builder, ctxAt(inp, -1, -10));
  assert.deepEqual(ev.map((e) => e.type), ['place']);
  assert.equal(w.interactions.list.length, 1);
  const it = w.interactions.list[0];
  assert.match(it.id, /^altar-\d+$/);
  assert.equal(it.label, 'Make offering');
  assert.equal(it.frame, 'ship');
  assert.equal(it.radius, 2.2);
  near(it.pos.y, deckY(sOf(-10)) + PIECES[8].height, 1e-9);
  assert.equal(it.enabled(), true);
  it.act();
  near(w.crew.stamina, 0.85, 1e-9);
  assert.deepEqual(w.builder.events.map((e) => e.type), ['offering']);
  assert.equal(it.enabled(), false, 'spent for today');
  // a new day resets it
  frame(w.builder, ctxAt(inp, 1, -6, { dayCount: 1 }));
  assert.equal(it.enabled(), true);
  it.act();
  near(w.crew.stamina, 1, 1e-9);
  // a second altar gets its own id
  frame(w.builder, ctxAt(inp, 0, -12, { dayCount: 1 }), { key: KEY_OF.altar });
  tap(w.builder, ctxAt(inp, 0, -12, { dayCount: 1 }));
  assert.equal(w.interactions.list.length, 2);
  assert.notEqual(w.interactions.list[0].id, w.interactions.list[1].id);
  // removing the altar removes its interaction
  frame(w.builder, ctxAt(inp, -1, -10, { dayCount: 1, height: 1.5 }), { key: 'KeyX' });
  assert.equal(w.interactions.list.length, 1);
});

test('persistence: a new builder restores the same placements', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, Z_MID));
  frame(w.builder, ctxAt(inp, -1, -6), { key: KEY_OF.crate });
  tap(w.builder, ctxAt(inp, -1, -6));
  tap(w.builder, ctxAt(inp, -1, -6, { height: 1.5 }));
  frame(w.builder, ctxAt(inp, 1, -10), { key: KEY_OF.altar });
  tap(w.builder, ctxAt(inp, 1, -10));
  const before = store.get(KEY);
  const beforeKg = w.builder.payloadKg();
  const beforeSolids = w.solids.solids.length;

  const w2 = newWorld_fresh_after_save();
  assert.equal(w2.builder.payloadKg(), beforeKg);
  assert.equal(w2.solids.solids.length, beforeSolids);
  assert.equal(w2.interactions.list.length, 1, 'altar interaction restored');
  w2.builder.save();
  assert.equal(store.get(KEY), before, 'save output unchanged after reload');

  function newWorld_fresh_after_save() {
    const shipGroup = new THREE.Group();
    const payload = [];
    const solids = new WalkGeometry(null);
    solids.add({ kind: 'cyl', cx: 0, cz: zOf(0.5), r: 0.3, y0: 0, y1: 10, surface: 'wood', walkTop: false });
    const interactions = { list: [] };
    const builder = new DeckBuilder(makeKit(), shipGroup, payload, solids, interactions, { stamina: 0.5 });
    return { builder, payload, solids, interactions };
  }
});

test('persistence skips invalid entries and keeps valid ones', () => {
  store.set(
    KEY,
    JSON.stringify([
      { id: 'nope', x: 1, z: Z_MID, rot: 0, level: 0 },
      { id: 'crate', x: 'a', z: Z_MID, rot: 0, level: 0 },
      { id: 'crate', x: 1, z: Z_MID, rot: 0, level: 1 }, // no base beneath
      { id: 'crate', x: 1, z: Z_MID, rot: 0, level: 0 },
      { id: 'amphora_rack', x: 0, z: 0, rot: 0, level: 0 }, // on the mast
    ]),
  );
  const shipGroup = new THREE.Group();
  const payload = [];
  const solids = new WalkGeometry(null);
  solids.add({ kind: 'cyl', cx: 0, cz: zOf(0.5), r: 0.3, y0: 0, y1: 10, surface: 'wood', walkTop: false });
  const b = new DeckBuilder(makeKit(), shipGroup, payload, solids, { list: [] }, { stamina: 0 });
  assert.equal(payload.length, 1);
  near(payload[0].mass, 60);
  assert.equal(b.payloadKg(), 60);
});

test('persistence tolerates unreadable storage', () => {
  store.set(KEY, '{not json');
  const shipGroup = new THREE.Group();
  const payload = [];
  const b = new DeckBuilder(makeKit(), shipGroup, payload, new WalkGeometry(null), { list: [] }, { stamina: 0 });
  assert.equal(payload.length, 0);
  assert.equal(b.payloadKg(), 0);
});

test('palette: a card per piece, keys on the first ten, payload readout', () => {
  const w = newWorld();
  const ui = w.builder.ui;
  assert.equal(ui.cardRow.children.length, PIECES.length);
  assert.equal(ui.cards.length, 12);
  assert.equal(ui.cards[0].children[0].textContent, '1');
  assert.equal(ui.cards[9].children[0].textContent, '0');
  assert.equal(ui.cards[10].children[0].textContent, '');
  assert.equal(ui.cards[0].children[2].textContent, '60 kg');
  frame(w.builder, ctxAt(input(), 1, Z_MID));
  assert.equal(ui.loadValue.innerHTML, '0.00 <small>/ 2.50 t</small>');
  tap(w.builder, ctxAt(input(), 1, Z_MID));
  frame(w.builder, ctxAt(input(), 1, Z_MID));
  assert.equal(ui.loadValue.innerHTML, '0.06 <small>/ 2.50 t</small>');
});

test('events are cleared at the start of each update', () => {
  const w = newWorld();
  const inp = input();
  tap(w.builder, ctxAt(inp, 1, Z_MID));
  frame(w.builder, ctxAt(inp, 1, Z_MID));
  assert.deepEqual(w.builder.events, []);
});

console.log(failures ? `\n${failures} failing` : '\nall build tests passed');
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
process.exitCode = failures ? 1 : 0;
