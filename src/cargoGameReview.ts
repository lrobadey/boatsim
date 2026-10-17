import * as THREE from 'three';
import type { Game } from './game';
import { GOODS, type GoodId } from './trade/goods';
import { jobSummary } from './trade/job';
import type { Berth } from './world/harbour';

/** Dev-only controls for reviewing cargo handling in the real merchant voyage. */
export function installCargoGameReview(game: Game): void {
  const trade = game.trade;
  if (!trade || game.design.kind !== 'merchant') return;

  const initialBerth = game.ship.mooring.berth;
  const berthByKey = new Map<string, Berth>();
  const rememberBerth = (berth: Berth) => berthByKey.set(`${berth.port}:${berth.id}`, berth);
  if (initialBerth) rememberBerth(initialBerth);
  const allBerths = game.harbourLayouts.flatMap((harbour) => harbour.berths);
  const otherBerth = initialBerth
    ? allBerths.find((berth) => berth.port !== initialBerth.port || berth.id !== initialBerth.id)
    : undefined;
  allBerths.forEach(rememberBerth);

  game.clock.timeScale = 0;
  const root = document.createElement('section');
  root.id = 'cargo-game-review';
  Object.assign(root.style, {
    pointerEvents: 'auto', position: 'fixed', top: '12px', left: '12px', zIndex: '99',
    maxWidth: 'min(760px, calc(100vw - 24px))', padding: '8px',
    color: '#f6f0df', background: 'rgba(24, 29, 31, .92)',
    border: '1px solid rgba(245, 230, 190, .35)', borderRadius: '4px',
    font: '12px/1.35 system-ui, sans-serif',
  });
  const controls = document.createElement('div');
  Object.assign(controls.style, { display: 'flex', flexWrap: 'wrap', gap: '5px' });
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  Object.assign(status.style, { marginTop: '6px', maxWidth: '70ch', overflow: 'hidden' });
  const state = document.createElement('script');
  state.id = 'cargo-game-review-state';
  state.type = 'application/json';

  const setStatus = (message: string) => {
    status.textContent = message.split('\n').slice(0, 3).join(' · ');
    state.dataset.status = status.textContent;
  };
  const act = (label: string, fn: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    Object.assign(button.style, {
      color: '#f6f0df', background: '#343b3c', border: '1px solid #747b76',
      borderRadius: '3px', padding: '4px 7px', font: 'inherit', cursor: 'pointer',
    });
    button.addEventListener('click', () => {
      try { fn(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(`Error · ${message}`);
      }
    });
    controls.append(button);
  };
  const currentBerth = () => {
    const berth = game.ship.mooring.berth;
    if (!berth || game.ship.mooring.linePhase !== 'docked') throw new Error('The merchant is not docked at a berth');
    rememberBerth(berth);
    return berth;
  };
  const order = (good: GoodId, units: number) => {
    const berth = currentBerth();
    const orders = { [good]: units };
    const result = trade.session.confirm(berth.port, berth.id, orders);
    trade.update();
    const verb = units < 0 ? 'Sold' : 'Bought';
    setStatus(`${verb} ${Math.abs(units)} ${good} · ${result.sold.length + result.bought.length} trade line(s) confirmed`);
  };
  const advance = (minutes: number) => {
    game.clock.advanceHours(minutes / 60);
    trade.update();
    game.sky.forceEnvironment();
    setStatus(`Advanced ${minutes} minutes · ${game.clock.totalHours.toFixed(3)} game hours`);
  };
  const run = (scale: number) => {
    game.paused = false;
    game.clock.timeScale = scale;
    setStatus(`Clock running at ×${scale}`);
  };

  act('Sell 10 wine', () => order('wine', -10));
  act('Buy 10 wine', () => order('wine', 10));
  act('Buy 10 honey', () => order('honey', 10));
  act('Buy 100 wheat', () => order('wheat', 100));
  act('Sell 1 wine', () => order('wine', -1));
  act('Buy 1 wine', () => order('wine', 1));
  act('Buy 1 honey', () => order('honey', 1));
  act('Advance 1 min', () => advance(1));
  act('Advance 6 min', () => advance(6));
  act('Advance 15 min', () => advance(15));
  act('Advance 1 day', () => advance(1440));
  act('Empty hold', () => {
    trade.newVoyage();
    trade.voyage.manifest = {};
    trade.voyage.purse = 100000;
    game.clock.timeScale = 0;
    trade.update();
    setStatus('Empty-hold inspection fixture · real voyage reset, manifest cleared, purse set to 100000');
  });
  act('Reset review', () => {
    trade.newVoyage();
    game.clock.timeScale = 0;
    trade.update();
    setStatus('Review reset · base voyage with 70 wine');
  });
  act('Run ×1', () => run(1));
  act('Run ×8', () => run(8));
  act('Freeze', () => { game.clock.timeScale = 0; setStatus('Clock frozen'); });
  act('Trade book', () => { const berth = currentBerth(); trade.openLedger(berth.port); setStatus('Trade book open'); });
  act('Hold book', () => { trade.openHoldBook(); setStatus('Hold book open'); });
  act('Close book', () => { trade.ledger.close(); setStatus('Book closed'); });
  act('Cast off', () => {
    if (!trade.canCastOff()) throw new Error(`Cast off refused · ${trade.session.pendingUnits} packages still moving`);
    game.ship.mooring.castOff();
    setStatus('Cast off through the mooring system');
  });
  act('Release lines (test)', () => {
    game.ship.mooring.castOff();
    trade.update();
    setStatus('Test release · mooring cast off directly; cargo job remains in memory');
  });
  act('Return to job berth', () => {
    const job = trade.voyage.job;
    const saved = job
      ? berthByKey.get(`${job.port}:${job.berth}`) ?? allBerths.find((berth) => berth.port === job.port && berth.id === job.berth)
      : initialBerth;
    if (!saved) throw new Error('The saved job berth is unavailable');
    game.placeDocked(saved, true);
    trade.update();
    setStatus(`Returned to ${saved.name} · active cargo job preserved`);
  });
  if (otherBerth) {
    act('Other berth (test)', () => {
      game.placeDocked(otherBerth, true);
      trade.update();
      setStatus(`Test berth · ${otherBerth.name}; current cargo job remains at its recorded berth`);
    });
  }
  act('View quay', () => {
    const berth = currentBerth();
    const plank = game.ship.mooring.plank;
    if (!plank) throw new Error('The berth has no gangplank');
    const outward = new THREE.Vector3(game.ship.pos.x - plank.shoreWorld.x, 0, game.ship.pos.z - plank.shoreWorld.z).normalize();
    const target = (plank.restWorld ?? plank.shoreWorld).clone();
    game.reviewCamera = { position: target.clone().addScaledVector(outward, 8).add(new THREE.Vector3(0, 6, 0)), target };
    setStatus(`Quay view · berth ${berth.id}`);
  });
  const viewHold = (index: number, label: string) => {
    currentBerth();
    const hatch = game.design.cargo?.hatches[index];
    if (!hatch) throw new Error(`The merchant design has no ${label.toLowerCase()} hatch`);
    const hatchMid = game.design.hull.zOf((hatch.s0 + hatch.s1) / 2);
    const deckY = game.design.deck.deckY((hatch.s0 + hatch.s1) / 2);
    const target = game.ship.toWorld(new THREE.Vector3(0, deckY - 0.5, hatchMid), new THREE.Vector3());
    const position = game.ship.toWorld(new THREE.Vector3(0.15, deckY + 3.2, hatchMid + 0.5), new THREE.Vector3());
    game.reviewCamera = { position, target };
    setStatus(`${label} view · overhead cargo inspection`);
  };
  act('View hold', () => viewHold(0, 'Forward hold'));
  act('View aft hold', () => viewHold(1, 'Aft hold'));
  act('View deck', () => { game.reviewCamera = null; setStatus('Deck view · normal player camera'); });
  act('View side', () => {
    const berth = currentBerth();
    const midship = game.ship.toWorld(
      new THREE.Vector3(0, 0, game.design.hull.zOf(0.5)),
      new THREE.Vector3(),
    );
    const waterline = game.waves.heightAt(midship.x, midship.z, game.ship.time);
    const target = midship.clone();
    const position = midship.clone().add(new THREE.Vector3(berth.nx * 12, waterline + 2 - midship.y, berth.nz * 12));
    game.reviewCamera = { position, target };
    setStatus(`Side view · berth ${berth.id} · midships at waterline`);
  });

  root.append(controls, status, state);
  document.getElementById('ui')?.append(root);
  setStatus('Cargo game review ready · real berth and in-memory orders');

  const observe = () => {
    const session = trade.session;
    const voyage = session.voyage;
    const job = voyage.job;
    const physical = session.physicalHoldUse();
    const committed = GOODS.reduce((volume, good) => {
      const units = session.aboard(good.id);
      return volume + units * good.stow;
    }, 0);
    const pending = session.pendingUnits;
    const keel = game.ship.toWorld(
      new THREE.Vector3(0, -game.design.hull.keelDepth(0.5), game.design.hull.zOf(0.5)),
      new THREE.Vector3(),
    );
    const waterAtKeel = game.waves.heightAt(keel.x, keel.z, game.ship.time);
    const mooring = game.ship.mooring;
    const hatchUntil = voyage.hatchUntil ?? null;
    state.textContent = JSON.stringify({
      clock: { totalHours: game.clock.totalHours, hours: game.clock.hours, timeScale: game.clock.timeScale },
      mooring: { linePhase: mooring.linePhase, berth: mooring.berth?.id ?? null },
      ship: {
        mass: game.ship.mass, payloadMass: game.ship.payloadMass, time: game.ship.time,
        position: game.ship.pos.toArray(), draft: waterAtKeel - keel.y,
      },
      manifest: { ...voyage.manifest }, purse: voyage.purse, hatchUntil, job: job ? { ...job } : null,
      jobSummary: job ? jobSummary(job) : null,
      pendingUnits: pending, physicalHoldUse: physical,
      committedHoldUse: { volume: committed, capacity: trade.hold.capacity },
      tradeVisuals: trade.visualState,
      pausedContext: {
        gamePaused: game.paused, linePhase: mooring.linePhase,
        jobPending: pending, cartDelayRemainingHours: hatchUntil === null ? 0 : Math.max(0, hatchUntil - game.clock.totalHours),
      },
      ledgerOpen: trade.ledgerOpen, status: status.textContent,
    });
    if (game.running) requestAnimationFrame(observe);
  };
  requestAnimationFrame(observe);
}
