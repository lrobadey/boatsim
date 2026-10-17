import { Hold } from './cargo/hold';
import { Economy, type EconPort } from './trade/economy';
import { GOODS, GOOD_IDS, type GoodId } from './trade/goods';
import { jobSummary } from './trade/job';
import { TradeSession } from './trade/session';
import { buildSave, parseSave } from './trade/save';
import { newVoyage } from './trade/voyage';
import { MERCHANT } from './ship/design';
import { Ledger } from './ui/ledger';
import { tradeLedgerSource } from './ui/ledgerSource';

const SEED = 1729;
const HEIGHTMAP_SIZE = 2048;
const T0 = 2408;
const START_PURSE = 100_000;
const HANDS = 8;
const PORT_NAMES: Record<number, string> = { 0: 'Serrothos', 1: 'Kormakos' };
const HOLD = new Hold(MERCHANT);
const STATUS = document.getElementById('cargo-review-status') as HTMLOutputElement;
const STATE = document.getElementById('cargo-review-state') as HTMLPreElement;

// These synthetic profiles match the home and Kormakos entries in scripts/test-voyage.mjs.
type ProfileShape = { houses: number; area: number; s: Partial<Record<GoodId, number>> };
const SHAPES: { home: ProfileShape; kormakos: ProfileShape } = {
  home: { houses: 140, area: 60e6, s: { wheat: 0.14, oil: 0.1, honey: 0.08, pitch: 0.05, wine: 0.12, almonds: 0.03, fish: 0.01, firewood: 0.2 } },
  kormakos: { houses: 40, area: 4e6, s: { wheat: 0.22, oil: 0.12, honey: 0.04, pitch: 0.02, wine: 0.15, almonds: 0.05, fish: 0.03, firewood: 0.2 } },
};

function profileOf({ houses, area, s }: ProfileShape) {
  const features = Object.fromEntries(GOOD_IDS.map((id) => [id, (s[id] ?? 0) * area])) as Record<GoodId, number>;
  return { houses, area, features };
}

const ports = (): EconPort[] => [
  { id: 0, profile: profileOf(SHAPES.home), x: 0, z: 0 },
  { id: 1, profile: profileOf(SHAPES.kormakos), x: 3000, z: 0 },
];
const doyAt = (T: number) => (((65 + Math.floor(T / 24)) % 365) + 365) % 365;

let T = T0;
let economy: Economy;
let voyage: ReturnType<typeof newVoyage>;
let session: TradeSession;
let ledger: Ledger | null = null;
let mode: 'trade' | 'hold' = 'hold';
let lastEvent: unknown = 'initial state';
let statusText = 'Starting the cargo review…';
let saveJson: string | null = null;

function makeEconomy(startT: number): Economy {
  return new Economy({ seed: SEED, ports: ports(), doyAt, hands: HANDS, startT });
}

function makeSource(nextMode: 'trade' | 'hold') {
  return tradeLedgerSource({
    session,
    port: 0,
    portName: PORT_NAMES[0],
    berth: 0,
    mode: nextMode,
    clock: () => ({ dayCount: Math.floor(T / 24), hours: T % 24 }),
    T: () => T,
    wagesPerDay: HANDS * 150,
    holdCapacity: HOLD.capacity,
    portNames: PORT_NAMES,
  });
}

function openLedger(nextMode: 'trade' | 'hold') {
  mode = nextMode;
  if (!ledger) ledger = new Ledger();
  ledger.close();
  ledger.open(makeSource(nextMode));
}

function staticLoadDelta(): number {
  return HOLD.staticLoad(voyage.manifest).reduce((total, item) => total + item.mass, 0);
}

function physicalCargoMass(): number {
  return GOODS.reduce((total, good) => total + (voyage.manifest[good.id] ?? 0) * good.mass, 0);
}

function telemetry() {
  const job = voyage.job;
  const minuteOfDay = Math.floor((T % 24) * 60 + 1e-9);
  const counts: Record<string, { physical: number; committed: number }> = {};
  for (const good of GOODS) {
    const physical = voyage.manifest[good.id] ?? 0;
    const committed = session.aboard(good.id);
    if (physical || committed) counts[good.id] = { physical, committed };
  }
  return {
    port: PORT_NAMES[0],
    clock: `Day ${Math.floor(T / 24) + 1} · ${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`,
    absoluteHour: T,
    purse: voyage.purse,
    manifest: { ...voyage.manifest },
    committedCounts: counts,
    job: job ? { ...job } : null,
    jobSummary: job ? jobSummary(job) : null,
    physicalCargoMassKg: physicalCargoMass(),
    staticLoadDeltaKg: staticLoadDelta(),
    pendingUnits: session.pendingUnits,
    hatchesOpen: session.hatchesOpen(T),
    lastEvent,
    status: statusText,
  };
}

function refresh() {
  if (ledger?.isOpen) ledger.update();
  STATE.textContent = JSON.stringify(telemetry(), null, 2);
}

function setStatus(text: string) {
  statusText = text;
  STATUS.value = statusText;
  refresh();
}

function reset() {
  T = T0;
  economy = makeEconomy(T0);
  voyage = newVoyage();
  voyage.purse = START_PURSE;
  voyage.manifest = { wine: 70 };
  session = new TradeSession({ economy, voyage, holdCapacity: HOLD.capacity });
  saveJson = null;
  lastEvent = 'Reset to initial in-memory state';
  statusText = 'Reset · Serrothos · Day 101 · 08:00';
  openLedger('hold');
  STATUS.value = statusText;
  refresh();
}

function saveAndRestore() {
  const dayCount = Math.floor(T / 24);
  const hours = T - dayCount * 24;
  const data = buildSave({
    seed: SEED,
    heightmapSize: HEIGHTMAP_SIZE,
    clock: { dayCount, hours, dayOfYear: doyAt(T), moonPhase: 0 },
    windTime: 0,
    berth: { id: 0, bowOut: false },
    voyage,
    economy: economy.snapshot(),
    savedAt: 42,
  });
  saveJson = JSON.stringify(data);
  const restored = parseSave(saveJson, SEED, HEIGHTMAP_SIZE);
  if (!restored) throw new Error('The in-memory save was rejected');
  T = restored.clock.dayCount * 24 + restored.clock.hours;
  economy = makeEconomy(T);
  economy.restore(restored.economy);
  voyage = restored.voyage;
  session = new TradeSession({ economy, voyage, holdCapacity: HOLD.capacity });
  lastEvent = 'Saved and restored through buildSave / parseSave / Economy.restore';
  statusText = 'Save restored · in-memory only';
  openLedger(mode);
  STATUS.value = statusText;
  refresh();
}

function act(action: string) {
  try {
    switch (action) {
      case 'trade':
        openLedger('trade');
        setStatus('Trade ledger open · Serrothos');
        return;
      case 'hold':
        openLedger('hold');
        setStatus('Hold ledger open');
        return;
      case 'sell': {
        const result = session.confirm(0, 0, { wine: -10 });
        lastEvent = { action: 'confirm sell 10 wine', result };
        setStatus('Confirmed sale · cargo crosses as it is handled');
        return;
      }
      case 'wine': {
        const result = session.confirm(0, 0, { wine: 10 });
        lastEvent = { action: 'confirm buy 10 wine', result };
        setStatus('Confirmed wine purchase · cargo crosses as it is handled');
        return;
      }
      case 'honey': {
        const result = session.confirm(0, 0, { honey: 10 });
        lastEvent = { action: 'confirm buy 10 honey', result };
        setStatus('Confirmed honey purchase · cargo crosses as it is handled');
        return;
      }
      case 'advance15':
      case 'advance60': {
        T += action === 'advance15' ? 0.25 : 1;
        const events = session.tick(T);
        lastEvent = events.length ? events : 'time advanced; no session events';
        setStatus(`Advanced to ${T.toFixed(2)} · ${events.length ? events.map((e) => e.type).join(', ') : 'no event'}`);
        return;
      }
      case 'restore':
        saveAndRestore();
        return;
      case 'castoff':
        session.castOff();
        lastEvent = 'Cast off';
        setStatus('Cast off');
        return;
      case 'reset':
        reset();
        return;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastEvent = { error: message };
    statusText = `Error · ${message}`;
    STATUS.value = statusText;
    refresh();
  }
}

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
  button.addEventListener('click', () => act(button.dataset.action ?? ''));
});

reset();
