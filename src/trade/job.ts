// The cargo job's behaviour (cargo-trade-spec §6.2). Pure: acts on a CargoJob and the VoyageState.
// Driven by TradeSession. The type lives in voyage.ts.
//
// pending is signed per good (+ coming aboard, − going ashore), so a sell and a buy of the same good
// across two orders net into one figure. Porterage is charged per unit moved.

import { GOODS, GOOD_IDS, type GoodId } from './goods';
import { LOAD_RATE, porterFeePerUnit, type CargoJob, type VoyageState } from './voyage';

/** Units per good, positive counts. */
export type Units = Partial<Record<GoodId, number>>;

export interface StepResult {
  /** manifest change per good over this step (only goods that moved) */
  moved: { good: GoodId; delta: number }[];
  /** 'stowed' or 'landed' when pending became empty during this step (the last kind of move), else null */
  done: 'stowed' | 'landed' | null;
  /** game hours from the start of this step to the unit that finished the job (0 when done is null) */
  usedHours: number;
}

export function newJob(port: number, berth: number): CargoJob {
  return { port, berth, pending: {}, quay: {}, carry: 0 };
}

/** Units still to move, both directions. */
export function pendingUnits(job: CargoJob): number {
  let n = 0;
  for (const id of GOOD_IDS) n += Math.abs(job.pending[id] ?? 0);
  return n;
}

function clean(rec: Partial<Record<GoodId, number>>, id: GoodId): void {
  if ((rec[id] ?? 0) === 0) delete rec[id];
}

/**
 * Adds a confirmed order. Sells leave pending (going ashore) and do not touch the quay until they land.
 * Buys enter pending (coming aboard) and start on the quay at once. Both arguments hold positive counts.
 */
export function addOrder(job: CargoJob, sells: Units, buys: Units): void {
  for (const id of GOOD_IDS) {
    const s = sells[id] ?? 0;
    if (s > 0) {
      job.pending[id] = (job.pending[id] ?? 0) - s;
      clean(job.pending, id);
    }
    const b = buys[id] ?? 0;
    if (b > 0) {
      job.pending[id] = (job.pending[id] ?? 0) + b;
      job.quay[id] = (job.quay[id] ?? 0) + b;
      clean(job.pending, id);
    }
  }
}

/** The next unit to move: unloading first (table order), then loading (table order). */
function nextGood(job: CargoJob): GoodId | null {
  for (const g of GOODS) if ((job.pending[g.id] ?? 0) < 0) return g.id;
  for (const g of GOODS) if ((job.pending[g.id] ?? 0) > 0) return g.id;
  return null;
}

/**
 * Moves cargo for `hours` game hours at LOAD_RATE units per hour (fractions carried in job.carry).
 * Each unit: manifest ±1, quay ∓1 (a load takes it off the quay) or ±1 (a landing puts it on),
 * porterage charged to the purse. Mutates job and voyage.
 */
export function stepJob(job: CargoJob, voyage: VoyageState, hours: number): StepResult {
  const delta: Partial<Record<GoodId, number>> = {};
  if (pendingUnits(job) === 0) {
    job.carry = 0;
    return { moved: [], done: null, usedHours: 0 };
  }
  const carryIn = job.carry;
  const budget = carryIn + LOAD_RATE * hours;
  const n = Math.floor(budget + 1e-9);
  job.carry = Math.max(0, budget - n);
  let done: StepResult['done'] = null;
  let usedHours = 0;
  for (let k = 1; k <= n; k++) {
    const id = nextGood(job);
    if (id === null) break;
    const good = GOODS.find((g) => g.id === id)!;
    const p = job.pending[id] ?? 0;
    let kind: 'stowed' | 'landed';
    if (p < 0) {
      job.pending[id] = p + 1;
      job.quay[id] = (job.quay[id] ?? 0) + 1;
      voyage.manifest[id] = (voyage.manifest[id] ?? 0) - 1;
      delta[id] = (delta[id] ?? 0) - 1;
      kind = 'landed';
    } else {
      job.pending[id] = p - 1;
      job.quay[id] = (job.quay[id] ?? 0) - 1;
      voyage.manifest[id] = (voyage.manifest[id] ?? 0) + 1;
      delta[id] = (delta[id] ?? 0) + 1;
      kind = 'stowed';
    }
    clean(job.pending, id);
    clean(job.quay, id);
    clean(voyage.manifest, id);
    voyage.purse -= porterFeePerUnit(good);
    if (pendingUnits(job) === 0) {
      done = kind;
      // unit k completes (k − carryIn) / LOAD_RATE hours after the step started
      usedHours = Math.min(hours, Math.max(0, (k - carryIn) / LOAD_RATE));
      job.carry = 0;
      break;
    }
  }
  const moved = GOOD_IDS.filter((id) => (delta[id] ?? 0) !== 0).map((id) => ({ good: id, delta: delta[id]! }));
  return { moved, done, usedHours };
}
