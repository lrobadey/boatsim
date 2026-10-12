import { makeShip, Tow, KN, MERCHANT, THREE } from './harness.mjs';
const H = MERCHANT.hull;
const out = { resistance: [] };
for (const F of [10, 25, 50, 100, 150, 200, 300, 400, 600, 900]) {
  const tow = new Tow(F); const { ship } = makeShip({ sys: tow });
  let v = 0; for (let i = 0; i < 400 * 120; i++) ship.step(1 / 120);
  v = ship.speed; out.resistance.push({ F, v: +v.toFixed(4), kn: +(v * KN).toFixed(3), cR: +(F / (v * v)).toFixed(1) });
}
{ const { ship } = makeShip({ sys: new Tow(0) }); out.mass = ship.mass; out.inertia = ship.inertia.toArray(); out.cg = ship.cg.toArray(); out.posY = ship.pos.y; out.pitch = ship.pitch;
  // coast-down from 2 kn
  ship.vel.set(0, 0, -2 / KN); let x = 0, t = 0; while (ship.speed > 0.2 && t < 2000) { ship.step(1 / 120); t += 1 / 120; x += ship.speed / 120; } out.coastFrom2kn = { t, x }; }
// crew payload effect: 6 rowers + 2 reliefs + helmsman, 65 kg each
const z = (s) => H.zOf(s), dy = (s) => H.sheer(s) - 0.3 + 1.0;
const stations = [0.17, 0.25, 0.33, 0.62, 0.70, 0.78];
const crewPts = stations.map((s) => ({ mass: 65, local: [0, dy(s), z(s) - 0.3] })).concat([{ mass: 65, local: [0, dy(0.40), z(0.40)] }, { mass: 65, local: [0, dy(0.58), z(0.58)] }, { mass: 65, local: [0, dy(0.86), z(0.86)] }]);
for (const [name, payload] of [['none', []], ['crew9', crewPts], ['reliefWalksFwd', crewPts.map((p, i) => i === 7 ? { ...p, local: [0, dy(0.25), z(0.25)] } : p)]]) {
  const { ship } = makeShip({ sys: new Tow(0), payload, settle: 30 });
  const tow = new Tow(150); const s2 = makeShip({ sys: tow, payload, settle: 2 }).ship; for (let i = 0; i < 400 * 120; i++) s2.step(1 / 120);
  out[name] = { cgWorldY: +ship.pos.y.toFixed(4), pitchDeg: +(ship.pitch * 180 / Math.PI).toFixed(3), heelDeg: +(ship.heel * 180 / Math.PI).toFixed(3), knAt150N: +(s2.speed * KN).toFixed(3), payload: payload.reduce((a, p) => a + p.mass, 0) };
}
for (const s of [0.1, 0.15, 0.17, 0.2, 0.25, 0.3, 0.33, 0.35, 0.4, 0.44, 0.6, 0.62, 0.65, 0.7, 0.75, 0.77, 0.78, 0.8, 0.86]) (out.hull ??= []).push({ s, z: +H.zOf(s).toFixed(3), hb: +H.halfBeam(s).toFixed(3), sheer: +H.sheer(s).toFixed(3), deckY: +(H.sheer(s) - 0.3).toFixed(3), deckHW: +MERCHANT.deck.deckHalfWidth(s).toFixed(3) });
console.log(JSON.stringify(out, null, 1));
