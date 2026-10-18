// Opening round-trip budget (expectations-mvp-spec §7, gate 1b) on the default world, headless.
//   node scripts/budget-opening.mjs [outbound hours] [return hours]
// Crossing times default to 14 h out and 16 h back: the merchant's physics speed under the default wind
// and waves (4.05 m/s out, 3.51 m/s back, measured October 16, 2026) over the pier distance × 1.25,
// the NPC route factor. It reports what the simulation does; it never tunes anything.
import './register-ts.mjs';
const B = '../src/';
const { Wind } = await import(B + 'world/wind.ts');
const holder = { postMessage() {}, onmessage: null };
globalThis.self = holder;
await import(B + 'world/worldgen.worker.ts');
let generated = null;
holder.postMessage = (m) => { if (m.type === 'done') generated = m.result; };
holder.onmessage({ data: { seed: 1729, size: 2048, worldSize: 12000, windFrom: new Wind(3).baseFrom, vegetationDensity: 0.7, authoredHarbour: true } });
const { GOOD_IDS, goodById } = await import(B + 'trade/goods.ts');
const { Economy, WAGE_PER_HAND_DAY } = await import(B + 'trade/economy.ts');
const { TradeSession } = await import(B + 'trade/session.ts');
const { newVoyage } = await import(B + 'trade/voyage.ts');
const { resetBooks } = await import(B + 'trade/books.ts');
const { landUseProfile } = await import(B + 'trade/landUse.ts');
const { planOf } = await import(B + 'world/ormosLayout.ts');
const { freshWorld, CelebrationActor } = await import(B + 'trade/world.ts');
const { Hold } = await import(B + 'cargo/hold.ts');
const { MERCHANT } = await import(B + 'ship/design.ts');
const OUT_H = Number(process.argv[2] ?? 14), BACK_H = Number(process.argv[3] ?? 16);
const sites = generated.sites.harbours;
const ports = sites.map(s => ({ id: s.id, profile: landUseProfile(s.profile, planOf(s)?.landUse), x: s.pier.x, z: s.pier.z }));
const doyAt = (T) => (((172 + Math.floor(T / 24)) % 365) + 365) % 365;
const hands = MERCHANT.oars.crew?.hands ?? 0;
const dr = (c) => (c / 100).toFixed(2);
const mkWorld = () => freshWorld({ ports, celebrationDay: 17 });

// ---- §3.5 re-measure: no player, 60 days ----
{
  const world = mkWorld();
  const e = new Economy({ seed: 1729, ports, doyAt, hands: 0, startT: 7.4, actors: [new CelebrationActor(world)] });
  for (const p of [0, 1]) { const m = e.market(p, 'wine'); console.log(`start wine port ${p}: bid ${dr(m.bid())} ask ${dr(m.ask())} S/S_ref ${(m.S / m.S_ref).toFixed(2)} P/D ${(m.P_ref / m.D_ref).toFixed(2)}`); }
  const path = []; let arrivals = [];
  for (let d = 1; d <= 60; d++) { e.advanceTo(d * 24 + 7.4); for (const ev of e.drainEvents()) if (ev.type === 'arrival' && ev.good === 'wine') arrivals.push(`d${(ev.T / 24).toFixed(1)}→${ev.port}:${ev.qty}`); if (d % 5 === 0 || d === 13 || d === 17) path.push(`d${d} ask ${dr(e.market(1, 'wine').ask())}`); }
  console.log('Kormakos wine path:', path.join(', '));
  console.log('wine arrivals:', arrivals.join(' '));
}

// ---- the round trip, through the 1c commands (Dealings) ----
const { MailActor } = await import(B + 'trade/world.ts');
const { Dealings, homeValue } = await import(B + 'trade/consignment.ts');
const { checkWorld } = await import(B + 'trade/books.ts');
const world = mkWorld();
const philon = world.characters.find(c => c.id === 'philon'), damaris = world.characters.find(c => c.id === 'damaris');
const lotsOf = (id) => world.lots.filter(l => l.owner === `char:${id}`).reduce((a, l) => a + l.qty, 0);
let session = null;
const economy = new Economy({ seed: 1729, ports, doyAt, hands, startT: 7.4, actors: [new CelebrationActor(world, () => session?.voyage.lots ?? []), new MailActor(world)] });
console.log(`Philon after pre-run: ${lotsOf('philon')} jars, wallet ${dr(philon.wallet)}; requirement ${world.celebration.requirement}`);
const voyage = newVoyage(); resetBooks(voyage, { purse: 30000, cargo: {}, T: 7.4 });
const CONSIGN = 40, wine = goodById('wine');
session = new TradeSession({ economy, voyage, holdCapacity: new Hold(MERCHANT).capacity, world });
damaris.trustBase = homeValue(economy, 0, CONSIGN) * CONSIGN;
// no price news in this run: the "sold below known prices" rule has nothing to judge against
const dealings = new Dealings({ world, session, heardBid: () => null });
const damaris0 = damaris.wallet;
let T = 7.4, wages = 0, n = 0; const log = [];
const must = (r, what) => { if (!r.ok) throw new Error(`${what} refused: ${r.reason}`); checkWorld(world, voyage); return r; };
const tick = (h) => { const end = T + h; while (T < end) { T = Math.min(end, Math.floor(T) + 1); for (const ev of session.tick(T)) if (ev.type === 'wages') wages += ev.amount; } };
const work = () => { while (session.pendingUnits > 0) tick(1); session.castOff(); };
// home: Damaris proposes, the player accepts, her jars load (she pays porterage from her reserve), then own wine
const p = must(dealings.propose('p1', 'damaris', { good: 'wine', qty: CONSIGN, alternateSale: true, buyer: 'philon', opportunityT: world.celebration.cutoffT }), 'proposal');
const A = must(dealings.accept('a1', p.proposal, p.revision), 'accept').agreement;
const res = must(dealings.startLoading('l1', A, 0, 0), 'loading');
log.push(`T${T.toFixed(1)} agreement ${A}: v ${dr(p.terms.perJar)}/jar, expected back T${world.agreements[0].expectedT.toFixed(1)}; Damaris reserves ${dr(res.reserved)}`);
const reserve = 3 * hands * WAGE_PER_HAND_DAY;
const lim = session.limits(0, {}, 'wine').max;
while (n + 1 <= lim && -session.quote(0, { wine: n + 1 }).total <= voyage.purse - reserve) n++;
const buy = session.confirm(0, 0, { wine: n }); work(); checkWorld(world, voyage);
log.push(`T${T.toFixed(1)} loaded 40 consigned + bought ${n} own wine for ${dr(buy.bought[0]?.total ?? 0)} + porterage; purse ${dr(voyage.purse)}`);
tick(OUT_H); log.push(`T${T.toFixed(1)} arrive Kormakos after ${OUT_H} h`);
// Philon: his real alternative price; the consignment unloads first
const want = Math.min(CONSIGN, dealings.buyerDemand('philon'));
const quote = dealings.buyerQuote('philon', 1, want);
const sold = must(dealings.sellToBuyer('s1', { buyer: 'philon', port: 1, berth: 0, from: A, qty: want, quoted: quote }), 'sale to Philon');
log.push(`T${T.toFixed(1)} Philon takes ${want} of hers for ${dr(sold.total)} (${dr(sold.total / want)}/jar; market bid ${dr(economy.market(1, 'wine').bid())}); duty ${dr(sold.duty)}; lands by T${sold.landT.toFixed(2)}, cutoff T${world.celebration.cutoffT}`);
const sell = session.confirm(1, 0, { wine: -n }); work(); checkWorld(world, voyage);
log.push(`T${T.toFixed(1)} sold ${n} own wine at Kormakos for ${dr(sell.sold[0]?.total ?? 0)}; purse ${dr(voyage.purse)}`);
let best = null;
for (const g of GOOD_IDS) { const l = session.limits(1, {}, g).max; if (l <= 0) continue; const cost = -session.quote(1, { [g]: l }).total; const back = economy.market(0, g).quoteSell(l).total - l * Math.ceil(0.25 * goodById(g).mass); const m = back - cost; if (!best || m > best.m) best = { g, l, cost, m }; }
if (best && best.m > 0) { session.confirm(1, 0, { [best.g]: best.l }); work(); log.push(`T${T.toFixed(1)} bought ${best.l} ${best.g} for ${dr(best.cost)} (expected margin at today's home price ${dr(best.m)})`); }
else log.push('no profitable return cargo');
tick(BACK_H); log.push(`T${T.toFixed(1)} home after ${BACK_H} h`);
if (best && best.m > 0) { const s = session.confirm(0, 0, { [best.g]: -best.l }); work(); log.push(`T${T.toFixed(1)} sold ${best.l} ${best.g} at home for ${dr(s.sold[0]?.total ?? 0)}`); }
// settlement (whole venture)
const acc = dealings.account(A);
log.push(`account: G ${dr(acc.G)}, C ${dr(acc.C)}, N ${dr(acc.N)}, profit ${dr(acc.profit)}, commission ${dr(acc.share)}, payable ${dr(acc.payable)}, closed ${acc.closed}`);
const st = must(dealings.settle('st1', { agreement: A, port: 0, amount: acc.available }), 'settlement');
log.push(`T${T.toFixed(1)} settled ${dr(st.paid)}, full ${st.full}; Damaris wallet ${dr(damaris0)} → ${dr(damaris.wallet)} (net ${dr(damaris.wallet - damaris0)}, reserved ${dr(damaris.reserved)}) vs selling at home ${dr(homeValue(economy, 0, CONSIGN) * CONSIGN)} today`);
log.push(`player: purse ${dr(voyage.purse)} vs start 300.00; wages ${dr(wages)}; days ${(T / 24).toFixed(2)}`);
if (T < 18 * 24) tick(18 * 24 - T);
const heard = world.records.filter(r => r.kind === 'heard-sale').map(r => `${r.holder} at T${r.T.toFixed(1)}`);
log.push(`Philon: consumed ${world.celebration.consumed}, shortfall ${world.celebration.shortfall}, fallback done ${world.celebration.fallbackDone}, wallet left ${dr(philon.wallet)}; his thanks heard: ${heard.join(', ') || 'not yet'}`);
checkWorld(world, voyage);
console.log(log.join('\n'));
