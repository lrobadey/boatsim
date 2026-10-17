// Voyage save (cargo-trade-spec §11; v2 and the v1 migration, expectations-mvp-spec §7). Pure JSON
// handling plus thin localStorage wrappers that never throw and work where localStorage is missing
// (headless tests return false / null). An unreadable save is kept aside, never deleted.

import type { EconomySnapshot } from './economy';
import { GOOD_IDS } from './goods';
import { restoreJob, type Units } from './job';
import type { VoyageState } from './voyage';
import { checkBooks, rebuildBooks } from './books';
import type { PriceRecord } from './news';

export interface SaveClock {
  dayCount: number;
  hours: number;
  dayOfYear: number;
  moonPhase: number;
}

export interface SaveData {
  v: 2;
  seed: number;
  heightmapSize: number;
  savedAt: number;
  clock: SaveClock;
  windTime: number;
  berth: { id: number; bowOut: boolean };
  /** the voyage with its books: lots, receipts and nextId */
  voyage: VoyageState;
  economy: EconomySnapshot;
  /** traders (optional; older saves have none): the price news heard at each port and each trader's note on you, keyed 'trader:{port}' */
  talk?: { news: PriceRecord[]; notes: Record<string, string> };
}

export const SAVE_VERSION = 2;
/** The previous save version, read once and migrated (expectations-mvp-spec §7, save migration). */
const LEGACY_VERSION = 1;

/** localStorage key for a world: trieres.voyage.v2.{seed}.{heightmapSize}. */
export function saveKey(seed: number, heightmapSize: number): string {
  return `trieres.voyage.v${SAVE_VERSION}.${seed}.${heightmapSize}`;
}

/** The v1 key for a world, read when there is no v2 save and removed once a v2 save reads back. */
export function legacySaveKey(seed: number, heightmapSize: number): string {
  return `trieres.voyage.v${LEGACY_VERSION}.${seed}.${heightmapSize}`;
}

/** Where an unreadable save is kept aside: stamp is its savedAt when readable, else the time it was found. */
export function rejectedSaveKey(seed: number, heightmapSize: number, stamp: number): string {
  return `trieres.voyage.rejected.${seed}.${heightmapSize}.${stamp}`;
}

/** The trader character id for a port's trader; talk notes are saved under it. */
export function traderId(port: number): string {
  return `trader:${port}`;
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

/** Structural check of the parts the restore reads, common to v1 and v2. */
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

/** The voyage with its job validated against the cargo (restoreJob), as the restore expects it. */
function normalizeVoyage(d: Record<string, unknown>): VoyageState {
  const voyage = d.voyage as Record<string, unknown>;
  const normalized = { ...voyage } as unknown as VoyageState;
  if (voyage.job !== null) {
    normalized.job = restoreJob(voyage.job, (d.economy as Record<string, unknown>).T as number, voyage.manifest as Units);
  }
  return normalized;
}

/** World check shared by both versions; warns and returns false on a mismatch. */
function sameWorld(d: Record<string, unknown>, seed: number, heightmapSize: number): boolean {
  if (d.seed === seed && d.heightmapSize === heightmapSize) return true;
  console.warn(`voyage save ignored: world ${String(d.seed)}/${String(d.heightmapSize)}, expected ${seed}/${heightmapSize}`);
  return false;
}

/**
 * Parses a v2 save. Returns null, with a console warning, when the JSON is corrupt, the version,
 * seed or heightmapSize differ, the shape is wrong, the job does not fit the cargo, or the books do
 * not balance (checkBooks). Never throws.
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
    if (!sameWorld(d, seed, heightmapSize)) return null;
    if (!shapeOk(d) || !isNum((d.voyage as Record<string, unknown>).nextId)) {
      console.warn('voyage save ignored: malformed');
      return null;
    }
    const voyage = normalizeVoyage(d);
    checkBooks(voyage);
    return { ...d, voyage } as unknown as SaveData;
  } catch (err) {
    console.warn('voyage save ignored: unreadable', err);
    return null;
  }
}

/**
 * Migrates a parsed v1 save to v2 (expectations-mvp-spec §7): the books are rebuilt from the purse,
 * manifest and job (rebuildBooks, at the economy's time), talk notes keyed by port index move to that
 * port's trader id, and everything else is kept. The opening is never injected. Throws a RangeError on
 * a malformed v1 save. Does not check the world.
 */
export function migrateV1(d: unknown): SaveData {
  if (!isObj(d)) throw new RangeError('v1 save is not an object');
  if (d.v !== LEGACY_VERSION) throw new RangeError(`not a v1 save: version ${String(d.v)}`);
  if (!shapeOk(d)) throw new RangeError('malformed v1 save');
  const voyage = normalizeVoyage(d);
  rebuildBooks(voyage, (d.economy as Record<string, unknown>).T as number);
  checkBooks(voyage);
  const out: Record<string, unknown> = { ...d, v: SAVE_VERSION, voyage };
  const talk = d.talk;
  if (isObj(talk) && isObj(talk.notes)) {
    const notes: Record<string, unknown> = {};
    // a key that is a port index becomes that port's trader id; any other key is kept as it is
    for (const [k, note] of Object.entries(talk.notes)) notes[/^(0|[1-9]\d*)$/.test(k) ? traderId(Number(k)) : k] = note;
    out.talk = { ...talk, notes };
  }
  return out as unknown as SaveData;
}

/** A v1 save JSON for this world, migrated; null with a console warning when it cannot be read. Never throws. */
function parseLegacy(json: string, seed: number, heightmapSize: number): SaveData | null {
  try {
    const d: unknown = JSON.parse(json);
    if (isObj(d) && !sameWorld(d, seed, heightmapSize)) return null;
    return migrateV1(d);
  } catch (err) {
    console.warn('voyage save ignored: unreadable v1 save', err);
    return null;
  }
}

/** A v2 save via parseSave, or a v1 save migrated via migrateV1; null when neither reads. Never throws. */
export function parseAnySave(json: string, seed: number, heightmapSize: number): SaveData | null {
  let version: unknown;
  try {
    const d: unknown = JSON.parse(json);
    version = isObj(d) ? d.v : undefined;
  } catch {
    version = undefined;
  }
  return version === LEGACY_VERSION ? parseLegacy(json, seed, heightmapSize) : parseSave(json, seed, heightmapSize);
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

/** The raw save at a key, or null when absent or unreadable. */
function getRaw(s: Storage, key: string): string | null {
  try {
    return s.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes the v2 save for this world, reads it back and parses it, and only then removes the v1 save.
 * Returns false when storage is missing or full, or the save does not read back (the v1 save is then
 * kept). Never throws.
 */
export function writeSave(seed: number, heightmapSize: number, data: SaveData): boolean {
  const s = storage();
  if (!s) return false;
  const key = saveKey(seed, heightmapSize);
  try {
    s.setItem(key, JSON.stringify(data));
  } catch {
    return false;
  }
  const back = getRaw(s, key);
  if (back === null || parseSave(back, seed, heightmapSize) === null) return false;
  try {
    s.removeItem(legacySaveKey(seed, heightmapSize));
  } catch {
    // the v1 save stays; the v2 save is read first
  }
  return true;
}

/**
 * The save for this world, or null (no save, no storage, or a rejected save): the v2 save if present,
 * otherwise the v1 save migrated in memory. Read-only: nothing is moved or removed. Never throws.
 */
export function readSave(seed: number, heightmapSize: number): SaveData | null {
  const s = storage();
  if (!s) return null;
  const v2 = getRaw(s, saveKey(seed, heightmapSize));
  if (v2 !== null) return parseSave(v2, seed, heightmapSize);
  const v1 = getRaw(s, legacySaveKey(seed, heightmapSize));
  if (v1 !== null) return parseLegacy(v1, seed, heightmapSize);
  return null;
}

export type LoadResult =
  | { status: 'none' }
  | { status: 'ok'; data: SaveData; from: 'v2' | 'v1' }
  | { status: 'rejected'; key: string };

/**
 * Copies the save at a key to its rejected key (never over a different rejected save) and then removes
 * it. Returns the rejected key, or null when the copy failed (the save is then left where it was).
 */
function keepAside(s: Storage, key: string, raw: string, seed: number, heightmapSize: number): string | null {
  let stamp = Date.now();
  try {
    const d: unknown = JSON.parse(raw);
    if (isObj(d) && isNum(d.savedAt)) stamp = d.savedAt;
  } catch {
    // unreadable JSON: stamped with the time it was found
  }
  try {
    let aside = rejectedSaveKey(seed, heightmapSize, stamp);
    for (let held = s.getItem(aside); held !== null && held !== raw; held = s.getItem(aside)) {
      stamp++;
      aside = rejectedSaveKey(seed, heightmapSize, stamp);
    }
    s.setItem(aside, raw);
    if (s.getItem(aside) !== raw) return null;
    s.removeItem(key);
    return aside;
  } catch {
    return null;
  }
}

/**
 * Loads the save for this world at boot: the v2 save if present and readable, otherwise the v1 save,
 * migrated (the v1 key stays until a v2 save reads back). A present but unreadable save is copied to its
 * rejected key and removed from its own key; nothing else is moved or deleted. 'rejected' only when no
 * save could be read, naming the first save kept aside. Never throws.
 */
export function loadSave(seed: number, heightmapSize: number): LoadResult {
  try {
    const s = storage();
    if (!s) return { status: 'none' };
    const slots = [
      { key: saveKey(seed, heightmapSize), from: 'v2' as const, parse: parseSave },
      { key: legacySaveKey(seed, heightmapSize), from: 'v1' as const, parse: parseLegacy },
    ];
    let rejected: string | null = null;
    for (const slot of slots) {
      const raw = getRaw(s, slot.key);
      if (raw === null) continue;
      const data = slot.parse(raw, seed, heightmapSize);
      if (data) return { status: 'ok', data, from: slot.from };
      const aside = keepAside(s, slot.key, raw, seed, heightmapSize) ?? slot.key;
      rejected ??= aside;
    }
    return rejected === null ? { status: 'none' } : { status: 'rejected', key: rejected };
  } catch {
    return { status: 'none' };
  }
}

/**
 * Keeps aside a save that parsed but could not be restored (for example, its berth no longer exists),
 * as loadSave does for an unreadable one. Returns the rejected key, or null. Never throws.
 */
export function keepSaveAside(seed: number, heightmapSize: number, from: 'v2' | 'v1'): string | null {
  const s = storage();
  if (!s) return null;
  const key = from === 'v2' ? saveKey(seed, heightmapSize) : legacySaveKey(seed, heightmapSize);
  const raw = getRaw(s, key);
  return raw === null ? null : keepAside(s, key, raw, seed, heightmapSize);
}

/**
 * Deletes the v2 and v1 saves for this world (only for an explicit New voyage). Rejected saves are kept.
 * Returns false when storage is missing. Never throws.
 */
export function deleteSave(seed: number, heightmapSize: number): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.removeItem(saveKey(seed, heightmapSize));
    s.removeItem(legacySaveKey(seed, heightmapSize));
    return true;
  } catch {
    return false;
  }
}
