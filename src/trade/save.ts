// Voyage save (cargo-trade-spec §11). Pure JSON handling plus thin localStorage wrappers that never
// throw and work where localStorage is missing (headless tests return false / null).

import type { EconomySnapshot } from './economy';
import { GOOD_IDS } from './goods';
import { restoreJob, type Units } from './job';
import type { VoyageState } from './voyage';
import type { PriceRecord } from './news';

export interface SaveClock {
  dayCount: number;
  hours: number;
  dayOfYear: number;
  moonPhase: number;
}

export interface SaveData {
  v: 1;
  seed: number;
  heightmapSize: number;
  savedAt: number;
  clock: SaveClock;
  windTime: number;
  berth: { id: number; bowOut: boolean };
  voyage: VoyageState;
  economy: EconomySnapshot;
  /** traders (optional; older saves have none): the price news heard at each port and each trader's note on you */
  talk?: { news: PriceRecord[]; notes: Record<string, string> };
}

export const SAVE_VERSION = 1;

/** localStorage key for a world: trieres.voyage.v1.{seed}.{heightmapSize}. */
export function saveKey(seed: number, heightmapSize: number): string {
  return `trieres.voyage.v${SAVE_VERSION}.${seed}.${heightmapSize}`;
}

/** The save object (§11). savedAt defaults to Date.now(). */
export function buildSave(o: {
  seed: number;
  heightmapSize: number;
  clock: SaveClock;
  windTime: number;
  berth: { id: number; bowOut: boolean };
  voyage: VoyageState;
  economy: EconomySnapshot;
  talk?: SaveData['talk'];
  savedAt?: number;
}): SaveData {
  return {
    v: SAVE_VERSION,
    seed: o.seed,
    heightmapSize: o.heightmapSize,
    savedAt: o.savedAt ?? Date.now(),
    clock: { ...o.clock },
    windTime: o.windTime,
    berth: { ...o.berth },
    voyage: o.voyage,
    economy: o.economy,
    ...(o.talk ? { talk: o.talk } : {}),
  };
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Structural check of the parts the restore reads. */
function shapeOk(d: Record<string, unknown>): boolean {
  const c = d.clock;
  const b = d.berth;
  const v = d.voyage;
  const e = d.economy;
  if (!isNum(d.savedAt) || !isNum(d.windTime)) return false;
  if (!isObj(c) || !isNum(c.dayCount) || !isNum(c.hours) || !isNum(c.dayOfYear) || !isNum(c.moonPhase)) return false;
  if (!isObj(b) || !isNum(b.id) || typeof b.bowOut !== 'boolean') return false;
  if (!isObj(v) || !isNum(v.purse) || !isObj(v.manifest) || !Array.isArray(v.notebook)) return false;
  if (v.job !== null && !isObj(v.job)) return false;
  if ('hatchUntil' in v && v.hatchUntil !== null && !isNum(v.hatchUntil)) return false;
  for (const [id, count] of Object.entries(v.manifest)) {
    if (!(GOOD_IDS as readonly string[]).includes(id) || !Number.isSafeInteger(count) || (count as number) < 0) return false;
  }
  if (!isObj(e) || !isNum(e.T) || !Array.isArray(e.stocks) || !Array.isArray(e.shipments)) return false;
  if (!Array.isArray(e.fleetBusyUntil) || !isNum(e.frac)) return false;
  return true;
}

/**
 * Parses a save. Returns null, with a console warning, when the JSON is corrupt, the version,
 * seed or heightmapSize differ, or the shape is wrong. Never throws.
 */
export function parseSave(json: string, seed: number, heightmapSize: number): SaveData | null {
  try {
    const d: unknown = JSON.parse(json);
    if (!isObj(d)) {
      console.warn('voyage save ignored: not an object');
      return null;
    }
    if (d.v !== SAVE_VERSION) {
      console.warn(`voyage save ignored: version ${String(d.v)}`);
      return null;
    }
    if (d.seed !== seed || d.heightmapSize !== heightmapSize) {
      console.warn(`voyage save ignored: world ${String(d.seed)}/${String(d.heightmapSize)}, expected ${seed}/${heightmapSize}`);
      return null;
    }
    if (!shapeOk(d)) {
      console.warn('voyage save ignored: malformed');
      return null;
    }
    const voyage = d.voyage as Record<string, unknown>;
    const normalized = { ...voyage } as unknown as VoyageState;
    if (voyage.job !== null) {
      normalized.job = restoreJob(voyage.job, (d.economy as Record<string, unknown>).T as number, voyage.manifest as Units);
    }
    return { ...d, voyage: normalized } as unknown as SaveData;
  } catch (err) {
    console.warn('voyage save ignored: unreadable', err);
    return null;
  }
}

/**
 * localStorage, or null where there is none (headless, storage blocked, or a stub without the
 * methods, as Node's global can be). Never throws.
 */
function storage(): Storage | null {
  try {
    const s: unknown = typeof localStorage === 'undefined' ? null : localStorage;
    if (s === null || typeof s !== 'object') return null;
    const st = s as Storage;
    if (typeof st.getItem !== 'function' || typeof st.setItem !== 'function' || typeof st.removeItem !== 'function') {
      return null;
    }
    return st;
  } catch {
    return null;
  }
}

/** Writes the save for this world. Returns false when storage is missing or full. Never throws. */
export function writeSave(seed: number, heightmapSize: number, data: SaveData): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(saveKey(seed, heightmapSize), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** The save for this world, or null (no save, no storage, or a rejected save). Never throws. */
export function readSave(seed: number, heightmapSize: number): SaveData | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(saveKey(seed, heightmapSize));
  } catch {
    return null;
  }
  if (raw === null) return null;
  return parseSave(raw, seed, heightmapSize);
}

/** Deletes the save for this world ("New voyage"). Returns false when storage is missing. Never throws. */
export function deleteSave(seed: number, heightmapSize: number): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.removeItem(saveKey(seed, heightmapSize));
    return true;
  } catch {
    return false;
  }
}
