// Whole-package hold and quay visuals (geometry and collision bounds; no browser/renderer).
import './register-ts.mjs';
import assert from 'node:assert/strict';
const THREE = await import('three');
const { MERCHANT } = await import('../src/ship/design.ts');
const { Hold } = await import('../src/cargo/hold.ts');
const { CargoVisual } = await import('../src/cargo/cargoVisual.ts');
const { getDunnagePlatforms, packVisibleCargo } = await import('../src/cargo/cargoPacking.ts');
const { QuayStack } = await import('../src/cargo/quayStack.ts');
const { GOODS } = await import('../src/trade/goods.ts');
const { lookGeometry } = await import('../src/cargo/cargoModels.ts');

let checks = 0;
function check(label, condition, detail = '') {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`);
  checks++;
  console.log(`PASS ${label}${detail ? ` [${detail}]` : ''}`);
}
const hold = new Hold(MERCHANT);
const platforms = getDunnagePlatforms(MERCHANT);
check('static dunnage platform available under every fitting hatch', platforms.length === MERCHANT.cargo.hatches.length);
for (const platform of platforms) {
  check(`hatch ${platform.hatchIndex} has three hull-supported bearers`, platform.bearers.length === 3 && platform.bearers.every((b) => b.y1 === platform.top - platform.thickness));
  let bearingEndsFit = true;
  for (const bearer of platform.bearers) for (const z of [bearer.z0, (bearer.z0 + bearer.z1) / 2, bearer.z1]) {
    const half = MERCHANT.hull.halfWidthAt(MERCHANT.hull.sOf(z), bearer.y0);
    if (Math.abs(bearer.x0) > half - 0.005 + 1e-6 || Math.abs(bearer.x1) > half - 0.005 + 1e-6) bearingEndsFit = false;
  }
  check(`hatch ${platform.hatchIndex} bearer ends meet hull profile`, bearingEndsFit);
}
const open = (p) => MERCHANT.cargo.hatches.some((h) => {
  const a = MERCHANT.hull.zOf(h.s0), b = MERCHANT.hull.zOf(h.s1);
  return p.bounds.min.x >= -MERCHANT.cargo.hatchHalfWidth + 0.075 - 1e-6 &&
    p.bounds.max.x <= MERCHANT.cargo.hatchHalfWidth - 0.075 + 1e-6 &&
    p.bounds.min.z >= Math.min(a, b) + 0.075 - 1e-6 && p.bounds.max.z <= Math.max(a, b) - 0.075 + 1e-6;
});
const floorOk = (p) => {
  const zs = [p.bounds.min.z, p.bounds.max.z, (p.bounds.min.z + p.bounds.max.z) / 2];
  const floor = Math.max(...zs.map((z) => -MERCHANT.hull.keelDepth(MERCHANT.hull.sOf(z)) + MERCHANT.cargo.hold.floorAboveKeel));
  return p.bounds.min.y >= floor + 0.01 - 1e-6;
};
const hullClear = (p) => {
  const geometry = lookGeometry(p.look), attr = geometry.getAttribute('position');
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  let clear = true;
  for (let i = 0; i < attr.count; i++) {
    const x = p.position.x + c * attr.getX(i) + s * attr.getZ(i);
    const y = p.position.y + attr.getY(i);
    const z = p.position.z - s * attr.getX(i) + c * attr.getZ(i);
    if (Math.abs(x) > MERCHANT.hull.halfWidthAt(MERCHANT.hull.sOf(z), y) - 0.025 + 1e-6) clear = false;
  }
  geometry.dispose();
  return clear;
};
const supported = (p) => platforms.some((d) =>
  p.bounds.min.x >= d.x0 - 1e-6 && p.bounds.max.x <= d.x1 + 1e-6 &&
  p.bounds.min.z >= d.z0 - 1e-6 && p.bounds.max.z <= d.z1 + 1e-6 &&
  Math.abs(p.bounds.min.y - (d.top + 0.01)) < 1e-6);
const mastClear = (p) => {
  const mastZ = MERCHANT.hull.zOf(MERCHANT.rig.mastStation);
  const dx = p.bounds.min.x <= 0 && p.bounds.max.x >= 0 ? 0 : Math.min(Math.abs(p.bounds.min.x), Math.abs(p.bounds.max.x));
  const dz = mastZ < p.bounds.min.z ? p.bounds.min.z - mastZ : mastZ > p.bounds.max.z ? mastZ - p.bounds.max.z : 0;
  return Math.hypot(dx, dz) >= 0.3 - 1e-6;
};
const belowCeiling = (p) => [p.bounds.min.z, p.bounds.max.z].every((z) => {
  const s = MERCHANT.hull.sOf(z);
  return p.bounds.max.y <= MERCHANT.deck.deckY(s) - MERCHANT.cargo.hold.ceilingBelowDeck + 1e-6;
});
const nonIntersect = (placements) => placements.every((a, i) => placements.slice(i + 1).every((b) =>
  !(a.bounds.min.x < b.bounds.max.x + 0.015 - 1e-6 && a.bounds.max.x + 0.015 - 1e-6 > b.bounds.min.x &&
    a.bounds.min.y < b.bounds.max.y + 0.015 - 1e-6 && a.bounds.max.y + 0.015 - 1e-6 > b.bounds.min.y &&
    a.bounds.min.z < b.bounds.max.z + 0.015 - 1e-6 && a.bounds.max.z + 0.015 - 1e-6 > b.bounds.min.z)));
const wineOne = packVisibleCargo({ wine: 1 }, MERCHANT);
const honeyOne = packVisibleCargo({ honey: 1 }, MERCHANT);
check('one wine maps to one whole visible amphora', wineOne.length === 1 && wineOne[0].id === 'wine:1');
check('one honey maps to one whole visible jar', honeyOne.length === 1 && honeyOne[0].id === 'honey:1');

const prefixes = new Map();
const expectedVisible = { wine: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], honey: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
for (const good of ['wine', 'honey']) {
  for (let n = 1; n <= 10; n++) {
    const items = packVisibleCargo({ [good]: n }, MERCHANT);
    const own = items.filter((p) => p.good === good);
    check(`${good} ${n}: exact whole-package visible subset`, own.length === expectedVisible[good][n - 1] && own.length <= n && own.length <= 400, `${own.length} visible of ${n} physical`);
    check(`${good} ${n}: IDs are good ordinals`, own.every((p, i) => p.id === `${good}:${i + 1}`));
    if (n > 1) {
      const prior = prefixes.get(`${good}:${n - 1}`);
      check(`${good} ${n}: same-good prefix stable`, prior.every((p, i) => p.id === own[i].id && p.position.distanceTo(own[i].position) < 1e-9 && p.yaw === own[i].yaw));
    }
    prefixes.set(`${good}:${n}`, own);
  }
}
const cases = [
  {}, { wine: 10 }, { honey: 10 }, { wheat: 12 }, { firewood: 8 },
  { wine: 7, oil: 3, honey: 8, wheat: 5, pitch: 4 },
];
for (const manifest of cases) {
  const a = packVisibleCargo(manifest, MERCHANT), b = packVisibleCargo(manifest, MERCHANT);
  check(`deterministic packing ${JSON.stringify(manifest)}`, JSON.stringify(a.map((p) => [p.id, p.position.toArray(), p.yaw])) === JSON.stringify(b.map((p) => [p.id, p.position.toArray(), p.yaw])));
  const counts = {};
  for (const p of a) counts[p.good] = (counts[p.good] ?? 0) + 1;
  check(`visible subset within physical inventory ${JSON.stringify(manifest)}`, Object.entries(counts).every(([g, n]) => n <= (manifest[g] ?? 0)) && a.length <= GOODS.length * 400);
  check(`models fit hatch, supported platform, hull, mast, ceiling and do not intersect ${JSON.stringify(manifest)}`,
    a.every((p) => open(p) && floorOk(p) && supported(p) && hullClear(p) && mastClear(p) && belowCeiling(p)) && nonIntersect(a));
}

// Confirm placement bounds correspond to actual mesh vertices after the instance transform.
for (const p of packVisibleCargo({ honey: 8, wheat: 8, firewood: 4 }, MERCHANT)) {
  const geometry = lookGeometry(p.look), attr = geometry.getAttribute('position');
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  const actual = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    const x = attr.getX(i), y = attr.getY(i), z = attr.getZ(i);
    actual.expandByPoint(v.set(p.position.x + c * x + s * z, p.position.y + y, p.position.z - s * x + c * z));
  }
  check(`actual vertex bounds match ${p.id}`, actual.min.distanceTo(p.bounds.min) < 1e-5 && actual.max.distanceTo(p.bounds.max) < 1e-5);
  geometry.dispose();
}

// Explicit manifest wins; the compatibility path globally sums cell volumes and rounds once per good.
{
  const visual = new CargoVisual(hold, MERCHANT);
  check('fixed dunnage is rendered when cargo inventory is empty', visual.group.children.filter((m) => !m.isInstancedMesh).length === platforms.length * 8);
  for (const platform of platforms) {
    const boards = visual.group.children.filter((m) => m.name.startsWith(`cargo-dunnage-${platform.hatchIndex}-plank-`));
    const bearers = visual.group.children.filter((m) => m.name.startsWith(`cargo-dunnage-${platform.hatchIndex}-bearer-`));
    check(`hatch ${platform.hatchIndex} renders five boards and three bearers`, boards.length === 5 && bearers.length === 3);
    const boardFits = boards.every((m) => {
      const b = new THREE.Box3().setFromObject(m);
      return b.min.x >= platform.x0 - 1e-6 && b.max.x <= platform.x1 + 1e-6 &&
        b.min.z >= platform.z0 - 1e-6 && b.max.z <= platform.z1 + 1e-6 &&
        Math.abs(b.max.y - platform.top) < 1e-6;
    });
    check(`hatch ${platform.hatchIndex} board geometry covers only its supported rect`, boardFits);
  }
  const winePlatform = visual.dunnagePlatforms[0];
  visual.update(hold.stow({ wine: 1 }), { wine: 1 });
  check('wine package rests 1 cm above its wooden platform', visual.placements[0].bounds.min.y === winePlatform.top + 0.01);
  const ten = hold.stow({ wine: 10 });
  visual.update(ten, { wine: 1 });
  check('CargoVisual honors exact manifest argument', visual.visibleCounts.wine === 1 && visual.placements.length === 1);
  visual.update(ten);
  check('CargoVisual compatibility derives global inventory before visible packing', visual.visibleCounts.wine === packVisibleCargo({ wine: 10 }, MERCHANT).length);
  visual.update(hold.stow({ wine: 4 }), { wine: 4 });
  const added = visual.placements.slice();
  visual.update(hold.stow({ wine: 2 }), { wine: 2 });
  check('CargoVisual add/remove transitions preserve same-good prefix', visual.placements.length === 2 && visual.placements.every((p, i) => p.id === added[i].id && p.position.distanceTo(added[i].position) < 1e-9));
  visual.update(hold.stow({ honey: 3, wheat: 2 }));
  const expected = packVisibleCargo({ honey: 3, wheat: 2 }, MERCHANT);
  check('CargoVisual mixed compatibility inventory remains exact', (visual.visibleCounts.honey ?? 0) === expected.filter((p) => p.good === 'honey').length && (visual.visibleCounts.wheat ?? 0) === expected.filter((p) => p.good === 'wheat').length);
}

function transformedBounds(mesh, index, axes) {
  const matrix = new THREE.Matrix4(); mesh.getMatrixAt(index, matrix);
  const geometry = mesh.geometry, attr = geometry.getAttribute('position');
  const box = new THREE.Box3(); const v = new THREE.Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.set(attr.getX(i), attr.getY(i), attr.getZ(i)).applyMatrix4(matrix);
    const dx = v.x - axes.fx, dz = v.z - axes.fz;
    box.expandByPoint(new THREE.Vector3(dx * axes.ax + dz * axes.az - axes.uPlank, v.y, -(dx * axes.nx + dz * axes.nz)));
  }
  return box;
}
function insideSolid(box, solid, axes, tolerance = 0.03) {
  const dx = solid.cx - axes.fx, dz = solid.cz - axes.fz;
  const cu = dx * axes.ax + dz * axes.az - axes.uPlank;
  const cd = -(dx * axes.nx + dz * axes.nz);
  return box.min.x >= cu - solid.hx - tolerance && box.max.x <= cu + solid.hx + tolerance &&
    box.min.z >= cd - solid.hz - tolerance && box.max.z <= cd + solid.hz + tolerance &&
    box.min.y >= solid.y0 - tolerance && box.max.y <= solid.y1 + tolerance;
}
{
  const qs = new QuayStack();
  for (const rot of [0.48, -0.71]) for (const offset of [5, 12]) {
    const ax = Math.cos(rot), az = -Math.sin(rot), nx = Math.sin(rot), nz = Math.cos(rot);
    const berth = { id: 0, name: 'rotated', cx: 4, cz: 8, ax, az, nx, nz, length: 40, top: 1.8, face: 3, bollards: [] };
    const fx = berth.cx - nx * berth.face, fz = berth.cz - nz * berth.face;
    const plank = { shoreWorld: new THREE.Vector3(fx + ax * offset, berth.top, fz + az * offset) };
    const axes = { ax, az, nx, nz, fx, fz, uPlank: offset };
    const solids = qs.update(berth, plank, { wine: 14, honey: 12, wheat: 8 }, []);
    check(`quay rotated ${rot}, plank ${offset}: getters match returned output`, qs.solids === solids && Object.values(qs.instanceCounts).reduce((a, n) => a + n, 0) === 34);
    check(`quay rotated ${rot}, plank ${offset}: expected pile collision halves`, solids.length === 2 && solids.every((b) => b.walkTop === false));
    let contained = true;
    const all = [];
    for (const mesh of qs.group.children) for (let i = 0; i < mesh.count; i++) {
      const box = transformedBounds(mesh, i, axes);
      all.push(box);
      if (!solids.some((solid) => insideSolid(box, solid, axes))) contained = false;
    }
    check(`quay rendered bounds inside collision boxes at offset ${offset}`, contained);
    check(`quay cargo clears plank landing at offset ${offset}`, all.every((box) => box.min.x > 0.35 || box.max.x < -0.35));
    // Actual transformed mesh bounds in berth axes avoid false world-AABB overlaps on rotated berths.
    let layerClear = true;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const horizontal = a.min.x < b.max.x - 1e-5 && a.max.x > b.min.x + 1e-5 && a.min.z < b.max.z - 1e-5 && a.max.z > b.min.z + 1e-5;
      if (horizontal && a.min.y < b.max.y - 1e-5 && a.max.y > b.min.y + 1e-5) layerClear = false;
    }
    check(`quay actual mesh bounds do not overlap at offset ${offset}`, layerClear);
  }
  const cleared = qs.update(null, null, {}, []);
  check('quay getters clear together', cleared.length === 0 && qs.solids.length === 0 && Object.values(qs.instanceCounts).every((n) => n === 0));
}
console.log(`\n${checks} cargo visual checks passed`);
