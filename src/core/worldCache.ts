import type { WorldGenRequest, WorldGenResult } from '../world/worldgenTypes';
import { GOOD_IDS } from '../trade/goods';

export interface WorldCacheStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

const DB_NAME = 'trieres-startup';
const STORE_NAME = 'worlds';
const DB_VERSION = 2;
const MAX_RECORDS = 3;
const OP_TIMEOUT_MS = 1000;

export function worldCacheKey(request: WorldGenRequest, revision: string): string {
  // Keep this order explicit: changing it changes the on-disk cache namespace.
  return JSON.stringify([
    revision,
    request.seed,
    request.size,
    request.worldSize,
    request.windFrom,
    request.vegetationDensity,
    Boolean(request.authoredHarbour),
  ]);
}

type Envelope = { schema: 1; key: string; result: WorldGenResult };

export async function loadCachedWorld(
  request: WorldGenRequest,
  revision: string,
  generate: () => Promise<WorldGenResult>,
  options: { storage?: WorldCacheStorage; onStatus?: (status: 'hit' | 'miss' | 'unavailable') => void } = {},
): Promise<WorldGenResult> {
  const key = worldCacheKey(request, revision);
  const storage = options.storage ?? createWorldCacheStorage();
  const status = options.onStatus;
  let cached: unknown;
  try {
    cached = await storage.get(key);
  } catch {
    status?.('unavailable');
    return generate();
  }

  const envelope = cached as Partial<Envelope> | null;
  if (envelope && envelope.schema === 1 && envelope.key === key && isWorldGenResult(envelope.result)
    && matchesRequest(envelope.result, request)) {
    status?.('hit');
    return envelope.result;
  }
  status?.('miss');
  if (cached !== undefined && cached !== null) {
    try { await storage.remove(key); } catch { /* A stale entry must not block regeneration. */ }
  }

  const result = await generate();
  if (isWorldGenResult(result)) {
    try {
      // Await the clone/write before handing ownership to gameplay; no later write can observe mutations.
      await storage.put(key, { schema: 1, key, result } satisfies Envelope);
    } catch { /* Startup must work when storage is unavailable or full. */ }
  }
  return result;
}

export function createWorldCacheStorage(): WorldCacheStorage {
  return new IndexedDbWorldCacheStorage();
}

/** Exported to permit direct adapter tests with fake IndexedDB implementations. */
export class IndexedDbWorldCacheStorage implements WorldCacheStorage {
  async get(key: string): Promise<unknown> {
    const db = await openDatabase();
    try {
      const record = await transactionRequest<CacheRecord | undefined>(db, 'readonly', store => store.get(key));
      if (!record) return undefined;
      return record.value;
    } finally { db.close(); }
  }

  async put(key: string, value: unknown): Promise<void> {
    const db = await openDatabase();
    try {
      await transactionRequest<void>(db, 'readwrite', store => {
        store.put({ key, value, createdAt: Date.now() } satisfies CacheRecord);
        const count = store.count();
        count.onsuccess = () => {
          const excess = Math.max(0, count.result - MAX_RECORDS);
          if (!excess) return;
          let removed = 0;
          const cursor = store.index('createdAt').openKeyCursor();
          cursor.onsuccess = () => {
            const item = cursor.result;
            if (!item || removed >= excess) return;
            store.delete(item.primaryKey);
            removed++;
            item.continue();
          };
        };
      });
    } finally { db.close(); }
  }

  async remove(key: string): Promise<void> {
    const db = await openDatabase();
    try { await transactionRequest<void>(db, 'readwrite', store => { store.delete(key); }); }
    finally { db.close(); }
  }

}

interface CacheRecord { key: string; value: unknown; createdAt: number; }

function openDatabase(): Promise<IDBDatabase> {
  let timedOut = false;
  let cancelled = false;
  return bounded(new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) { reject(error); return; }
    request.onupgradeneeded = event => {
      if (cancelled) { request.transaction?.abort(); return; }
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      // These records contain only regenerable world data, so schema upgrades may discard them.
      if ((event as IDBVersionChangeEvent).oldVersion > 0 && event.oldVersion < DB_VERSION) store.clear();
      if (store.indexNames.contains('usedAt')) store.deleteIndex('usedAt');
      if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
    };
    request.onsuccess = () => {
      if (timedOut || cancelled) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => { cancelled = true; reject(new Error('IndexedDB open blocked')); };
  }), 'IndexedDB open timed out', () => { timedOut = true; cancelled = true; });
}

function transactionRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  enqueue: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  let transaction: IDBTransaction | undefined;
  return bounded(new Promise<T>((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_NAME, mode);
      transaction = tx;
      const request = enqueue(tx.objectStore(STORE_NAME));
      let value: unknown;
      if (request) {
        const onSuccess = request.onsuccess;
        request.onsuccess = event => {
          value = request.result;
          onSuccess?.call(request, event);
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      }
      tx.oncomplete = () => resolve(value as T);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    } catch (error) {
      try { transaction?.abort(); } catch { /* The transaction may already be inactive. */ }
      reject(error);
    }
  }), 'IndexedDB transaction timed out', () => transaction?.abort());
}

function bounded<T>(promise: Promise<T>, message: string, abort?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        try { abort?.(); } catch { /* Abort is best effort. */ }
        reject(new Error(message));
      }, OP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isWorldGenResult(value: unknown): value is WorldGenResult {
  if (!isRecord(value)) return false;
  const size = value.size;
  const aoSize = value.aoSize;
  if (!positiveInt(size) || !positiveFinite(value.worldSize) || !positiveInt(aoSize)) return false;
  if (!(value.heights instanceof Float32Array) || value.heights.length !== size * size) return false;
  if (!(value.vegetation instanceof Float32Array) || value.vegetation.length % 6 !== 0) return false;
  if (!(value.ao instanceof Uint8Array) || value.ao.length !== aoSize * aoSize) return false;
  if (!Array.isArray(value.islands) || !value.islands.every(isIsland)) return false;
  if (!isSites(value.sites)) return false;
  if (value.seaState === undefined || !isSeaState(value.seaState)) return false;
  return true;
}

function matchesRequest(result: WorldGenResult, request: WorldGenRequest): boolean {
  return result.size === request.size && result.worldSize === request.worldSize
    && result.seaState!.maps.length === result.sites.harbours.length + 1
    && result.sites.harbours.every((harbour, index) => harbour.detail === index + 1);
}

function isSeaState(value: unknown): boolean {
  if (!isRecord(value) || value.dirs !== 16 || !finite(value.ms) || !Array.isArray(value.maps) || value.maps.length === 0) return false;
  return value.maps.every(map => {
    if (!isRecord(map) || !finite(map.originX) || !finite(map.originZ) || !positiveFinite(map.cell) || !positiveInt(map.n)) return false;
    const cells = map.n * map.n;
    return map.F instanceof Float32Array && map.F.length === cells * 16
      && map.S instanceof Float32Array && map.S.length === cells * 16
      && map.W instanceof Float32Array && map.W.length === cells * 16
      && map.hb instanceof Float32Array && map.hb.length === cells
      && map.land instanceof Uint8Array && map.land.length === cells;
  });
}

function isSites(value: unknown): boolean {
  if (!isRecord(value) || !point(value.harbour, ['x', 'z', 'openAngle']) || !point(value.shore, ['x', 'z'])
    || !point(value.temple, ['x', 'z', 'y']) || !isPier(value.pier) || !point(value.start, ['x', 'z', 'heading'])
    || !Array.isArray(value.houses) || !value.houses.every(isHouse)
    || !Array.isArray(value.harbours) || !value.harbours.every(isHarbour)) return false;
  return true;
}

function isHarbour(value: unknown): boolean {
  return isRecord(value) && finite(value.id) && finite(value.island) && typeof value.name === 'string'
    && point(value.harbour, ['x', 'z', 'openAngle']) && point(value.shore, ['x', 'z'])
    && isPier(value.pier) && Array.isArray(value.houses) && value.houses.every(isHouse)
    && finite(value.detail) && isProfile(value.profile);
}
function isProfile(value: unknown): boolean {
  return isRecord(value) && finite(value.houses) && finite(value.area) && isRecord(value.features)
    && GOOD_IDS.every(id => finite(value.features[id]))
    && Object.keys(value.features).every(id => (GOOD_IDS as readonly string[]).includes(id) && finite(value.features[id]));
}
function isHouse(value: unknown): boolean { return isRecord(value) && ['x', 'z', 'y', 'maxY', 'w', 'l', 'hgt', 'rot'].every(k => finite(value[k])); }
function isPier(value: unknown): boolean { return isRecord(value) && ['x', 'z', 'angle', 'length', 'width', 'top', 'berthStart'].every(k => finite(value[k])); }
function isIsland(value: unknown): boolean { return isRecord(value) && finite(value.id) && typeof value.name === 'string' && ['cx', 'cz', 'area', 'peak', 'peakX', 'peakZ'].every(k => finite(value[k])); }
function point(value: unknown, keys: string[]): boolean { return isRecord(value) && keys.every(k => finite(value[k])); }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function positiveFinite(value: unknown): value is number { return finite(value) && value > 0; }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
