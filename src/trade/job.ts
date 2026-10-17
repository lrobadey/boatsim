// Cargo handling work (cargo-handling-spec). Pure: acts on a CargoJob and VoyageState; the cargo lots,
// manifest and purse move through books.ts.

import { GOODS, GOOD_IDS, goodById, type GoodId } from './goods';
import { porterFeePerUnit, type CargoJob, type VoyageState } from './voyage';
import { landUnit, recordPorterage, stowUnit } from './books';

export const CARGO_WORK_KG_PER_HOUR = 400;
/** Hours from the last unit landing or stowing to the quay being cleared (§6.2). */
export const CART_AFTER_JOB = 1;
export type Units = Partial<Record<GoodId, number>>;

export interface StepResult {
  moved: { good: GoodId; delta: number }[];
  done: 'stowed' | 'landed' | null;
  /** Game hours from the start of this step to completion, or 0 when no job completed. */
  usedHours: number;
}

export interface JobSummary {
  phase: 'load' | 'unload' | null;
  good: GoodId | null;
  units: number;
  remainingKg: number;
  hours: number;
}

export function newJob(port: number, berth: number): CargoJob {
  return { version: 2, port, berth, incoming: {}, outgoing: {}, quay: {}, active: null, cartAt: null };
}

export function pendingUnits(job: CargoJob): number {
  let n = 0;
  for (const id of GOOD_IDS) n += (job.incoming[id] ?? 0) + (job.outgoing[id] ?? 0);
  return n;
}

function clean(rec: Partial<Record<GoodId, number>>, id: GoodId): void {
  if ((rec[id] ?? 0) === 0) delete rec[id];
}

/** Add independent confirmed obligations. Confirm's session-level checks enforce physical availability. */
export function addOrder(job: CargoJob, sells: Units, buys: Units): void {
  for (const id of GOOD_IDS) {
    const sell = sells[id] ?? 0;
    const buy = buys[id] ?? 0;
    if (sell > 0) job.outgoing[id] = (job.outgoing[id] ?? 0) + sell;
    if (buy > 0) {
      job.incoming[id] = (job.incoming[id] ?? 0) + buy;
      job.quay[id] = (job.quay[id] ?? 0) + buy;
    }
  }
  job.cartAt = null;
}

function nextUnit(job: CargoJob): { good: GoodId; direction: 'load' | 'unload' } | null {
  for (const g of GOODS) if ((job.outgoing[g.id] ?? 0) > 0) return { good: g.id, direction: 'unload' };
  for (const g of GOODS) if ((job.incoming[g.id] ?? 0) > 0) return { good: g.id, direction: 'load' };
  return null;
}

function remainingWorkKg(job: CargoJob): number {
  let kg = 0;
  for (const id of GOOD_IDS) {
    const mass = goodById(id).mass;
    kg += ((job.incoming[id] ?? 0) + (job.outgoing[id] ?? 0)) * mass;
  }
  return Math.max(0, kg - (job.active?.workKg ?? 0));
}

export function jobSummary(job: CargoJob): JobSummary {
  const pending = pendingUnits(job);
  const next = job.active ?? nextUnit(job);
  const remainingKg = remainingWorkKg(job);
  return {
    phase: next?.direction ?? null,
    good: next?.good ?? null,
    units: pending,
    remainingKg,
    hours: remainingKg / CARGO_WORK_KG_PER_HOUR,
  };
}

/**
 * Advance physical work; a unit crosses only after its entire mass has been handled. Each unit moved pays
 * its porterage: one receipt per lot moved from, at T (the start of this step).
 */
export function stepJob(job: CargoJob, voyage: VoyageState, hours: number, T: number): StepResult {
  if (!Number.isFinite(hours) || hours < 0) throw new RangeError(`invalid cargo time step: ${hours}`);
  const delta: Partial<Record<GoodId, number>> = {};
  if (pendingUnits(job) === 0 || hours === 0) return { moved: [], done: null, usedHours: 0 };
  const porterage = new Map<string, { lot: string; good: GoodId; qty: number; fee: number }>();
  let budget = hours * CARGO_WORK_KG_PER_HOUR;
  let workedKg = 0;
  let done: StepResult['done'] = null;
  while (budget > 0) {
    if (!job.active) {
      const next = nextUnit(job);
      if (!next) break;
      job.active = { ...next, workKg: 0 };
    }
    const active = job.active;
    const good = goodById(active.good);
    const needed = good.mass - active.workKg;
    const amount = Math.min(budget, needed);
    active.workKg += amount;
    budget -= amount;
    workedKg += amount;
    if (active.workKg + 1e-10 < good.mass) break;

    const id = active.good;
    let lot: string;
    if (active.direction === 'unload') {
      job.outgoing[id] = (job.outgoing[id] ?? 0) - 1;
      job.quay[id] = (job.quay[id] ?? 0) + 1;
      lot = landUnit(voyage, job, id);
      delta[id] = (delta[id] ?? 0) - 1;
      done = 'landed';
    } else {
      job.incoming[id] = (job.incoming[id] ?? 0) - 1;
      job.quay[id] = (job.quay[id] ?? 0) - 1;
      lot = stowUnit(voyage, id);
      delta[id] = (delta[id] ?? 0) + 1;
      done = 'stowed';
    }
    clean(job.outgoing, id);
    clean(job.incoming, id);
    clean(job.quay, id);
    const paid = porterage.get(lot);
    if (paid) paid.qty++;
    else porterage.set(lot, { lot, good: id, qty: 1, fee: porterFeePerUnit(good) });
    job.active = null;
    if (pendingUnits(job) === 0) break;
  }
  recordPorterage(voyage, job.port, T, porterage.values());
  const moved = GOOD_IDS.filter((id) => (delta[id] ?? 0) !== 0).map((id) => ({ good: id, delta: delta[id]! }));
  return { moved, done: pendingUnits(job) === 0 ? done : null, usedHours: pendingUnits(job) === 0 ? workedKg / CARGO_WORK_KG_PER_HOUR : 0 };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const knownId = (v: string): v is GoodId => (GOOD_IDS as readonly string[]).includes(v);

function readCounts(raw: unknown): Partial<Record<GoodId, number>> {
  if (!isObj(raw)) throw new RangeError('malformed cargo counts');
  const out: Partial<Record<GoodId, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!knownId(key) || !Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`malformed cargo count: ${key}`);
    if (value !== 0) out[key] = value as number;
  }
  return out;
}

/**
 * Validate a v2 job or migrate the legacy signed pending/carry representation, then check it against
 * the physical cargo: incoming never exceeds what waits on the quay, outgoing never exceeds the manifest.
 */
export function restoreJob(raw: unknown, now: number, manifest: Units): CargoJob {
  const job = readJob(raw, now);
  for (const id of GOOD_IDS) {
    if ((job.incoming[id] ?? 0) > (job.quay[id] ?? 0)) throw new RangeError(`incoming ${id} exceeds quay cargo`);
    if ((job.outgoing[id] ?? 0) > (manifest[id] ?? 0)) throw new RangeError(`outgoing ${id} exceeds physical cargo`);
  }
  return job;
}

function readJob(raw: unknown, now: number): CargoJob {
  if (!isObj(raw) || !finite(now)) throw new RangeError('malformed cargo job');
  if (raw.version !== undefined && raw.version !== 2) throw new RangeError('unknown cargo job version');
  if (raw.version === 2) {
    if (!finite(raw.port) || !Number.isSafeInteger(raw.port) || !finite(raw.berth) || !Number.isSafeInteger(raw.berth)) throw new RangeError('malformed cargo location');
    const incoming = readCounts(raw.incoming);
    const outgoing = readCounts(raw.outgoing);
    const quay = readCounts(raw.quay);
    let active: CargoJob['active'] = null;
    if (raw.active !== null) {
      if (!isObj(raw.active) || typeof raw.active.good !== 'string' || !knownId(raw.active.good) || (raw.active.direction !== 'load' && raw.active.direction !== 'unload') || !finite(raw.active.workKg)) throw new RangeError('malformed active cargo work');
      const count = raw.active.direction === 'load' ? incoming[raw.active.good] ?? 0 : outgoing[raw.active.good] ?? 0;
      if (count <= 0 || raw.active.workKg < 0 || raw.active.workKg >= goodById(raw.active.good).mass) throw new RangeError('active work has no pending unit');
      active = { good: raw.active.good, direction: raw.active.direction, workKg: raw.active.workKg };
    }
    if (raw.cartAt !== null && !finite(raw.cartAt)) throw new RangeError('malformed cart time');
    const hasPending = Object.values(incoming).some((n) => (n ?? 0) > 0) || Object.values(outgoing).some((n) => (n ?? 0) > 0);
    if (hasPending && raw.cartAt !== null) throw new RangeError('pending cargo cannot have a cart time');
    if (!hasPending && raw.cartAt === null) throw new RangeError('empty cargo job needs a cart time');
    return { version: 2, port: raw.port, berth: raw.berth, incoming, outgoing, quay, active, cartAt: raw.cartAt as number | null };
  }

  const carry = raw.carry === undefined ? 0 : raw.carry;
  if (!finite(raw.port) || !Number.isSafeInteger(raw.port) || !finite(raw.berth) || !Number.isSafeInteger(raw.berth) || !isObj(raw.pending) || !finite(carry) || carry < 0 || carry >= 1) throw new RangeError('malformed legacy cargo job');
  const incoming: Partial<Record<GoodId, number>> = {};
  const outgoing: Partial<Record<GoodId, number>> = {};
  for (const [key, value] of Object.entries(raw.pending)) {
    if (!knownId(key) || !Number.isSafeInteger(value)) throw new RangeError(`malformed legacy pending count: ${key}`);
    if ((value as number) > 0) incoming[key] = value as number;
    else if ((value as number) < 0) outgoing[key] = -(value as number);
  }
  const quay = readCounts(raw.quay);
  const legacy: CargoJob = { version: 2, port: raw.port, berth: raw.berth, incoming, outgoing, quay, active: null, cartAt: null };
  if (carry > 0) {
    const next = nextUnit(legacy);
    if (!next) throw new RangeError('legacy carry has no pending unit');
    legacy.active = { ...next, workKg: carry * goodById(next.good).mass };
  }
  if (pendingUnits(legacy) === 0) legacy.cartAt = now + CART_AFTER_JOB;
  return legacy;
}
