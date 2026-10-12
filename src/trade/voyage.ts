// The player's books (cargo-trade-spec §4.5 and §6.2). Pure: plain data and helpers, no game imports.

import { GOOD_IDS, type Good, type GoodId } from './goods';
import type { EconEvent } from './economy';

/** The cargo job (§6.2). src/cargo/job.ts implements its behaviour; the type lives here so the save holds it. */
export interface CargoJob {
  port: number; berth: number;
  /** signed units still to move per good: + = coming aboard, − = going ashore */
  pending: Partial<Record<GoodId, number>>;
  /** units on the quay right now per good (the stack's contents) */
  quay: Partial<Record<GoodId, number>>;
  /** fractional progress toward the next unit */
  carry: number;
}

/** Latest prices seen at a port for one good. T is the absolute game hour seen. Prices are centidrachmas. */
export interface NotebookEntry {
  port: number;
  good: GoodId;
  ask: number;
  bid: number;
  T: number;
}

export interface VoyageState {
  /** centidrachmas, may go negative (wages owed) */
  purse: number;
  /** whole units aboard */
  manifest: Partial<Record<GoodId, number>>;
  /** latest per (port, good) */
  notebook: NotebookEntry[];
  job: CargoJob | null;
}

/** Start of a new voyage: 300.0 dr. */
export const START_PURSE = 30000;
/** Porterage per kilogram, per unit moved, rounded up to whole centidrachmas. */
export const PORTER_FEE_PER_KG = 0.25;
/** Units per game hour the cargo job moves, shared by all pending goods. */
export const LOAD_RATE = 10;

/** A new voyage: purse 300.0 dr, seventy jars of wine in the hold, empty notebook, no job. */
export function newVoyage(): VoyageState {
  return { purse: START_PURSE, manifest: { wine: 70 }, notebook: [], job: null };
}

/** Porterage for one unit moved, centidrachmas: ceil(0.25 · mass). */
export function porterFeePerUnit(good: Good): number {
  return Math.ceil(PORTER_FEE_PER_KG * good.mass);
}

/** Replaces the notebook entry for (port, good), or adds it. Mutates the array and returns it. */
export function updateNotebook(notebook: NotebookEntry[], entry: NotebookEntry): NotebookEntry[] {
  const i = notebook.findIndex((e) => e.port === entry.port && e.good === entry.good);
  if (i >= 0) notebook[i] = { ...entry };
  else notebook.push({ ...entry });
  return notebook;
}

/** The part of the economy the notebook reads: current ask and bid per port and good. */
export interface PriceSource {
  market(port: number, good: GoodId): { ask(): number; bid(): number };
}

/** Opening the ledger at a port writes that port's current ask and bid per good, with T. */
export function noteOpened(v: VoyageState, src: PriceSource, port: number, T: number): void {
  for (const good of GOOD_IDS) {
    const m = src.market(port, good);
    updateNotebook(v.notebook, { port, good, ask: m.ask(), bid: m.bid(), T });
  }
}

/**
 * Charges the wages paid at midnights: purse −= the sum of the wages events. Mutates voyage.purse and
 * returns the total charged (centidrachmas), for the caller's toast.
 */
export function applyWages(voyage: VoyageState, events: readonly EconEvent[]): number {
  let total = 0;
  for (const e of events) if (e.type === 'wages') total += e.amount;
  voyage.purse -= total;
  return total;
}
