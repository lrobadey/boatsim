// Exercises the IndexedDB adapter itself against a transactional, asynchronous in-memory IDB model.
//   node scripts/test-startup-storage.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { IndexedDbWorldCacheStorage, loadCachedWorld, worldCacheKey } = await import('../src/core/worldCache.ts');

class FakeRequest {
  result;
  error = null;
  onsuccess = null;
  onerror = null;
}

class FakeIndexedDB {
  constructor(options = {}) {
    this.options = options;
    this.records = new Map();
    this.storeExists = false;
    this.indexExists = false;
    this.dbObjects = [];
    this.transactions = [];
    this.putRequests = 0;
  }

  open(name, version) {
    assert.equal(name, 'trieres-startup');
    assert.equal(version, 2);
    const req = new FakeRequest();
    const db = new FakeDatabase(this);
    req.result = db;
    this.dbObjects.push(db);
    if (this.options.openNever) return req;
    if (this.options.blocked) {
      setTimeout(() => req.onblocked?.({ target: req }), 0);
      setTimeout(() => req.onsuccess?.({ target: req }), this.options.openDelay ?? 20);
      return req;
    }
    setTimeout(() => {
      if (!this.storeExists) {
        const tx = new FakeUpgradeTransaction();
        req.transaction = tx;
        req.onupgradeneeded?.({ target: req, oldVersion: 0 });
        this.storeExists = true;
      }
      req.onsuccess?.({ target: req });
    }, this.options.openDelay ?? 0);
    return req;
  }
}

class FakeUpgradeTransaction {
  objectStore() { return new FakeObjectStoreDefinition(); }
  abort() {}
}
class FakeObjectStoreDefinition {
  createIndex(name) { if (name === 'createdAt') this.owner.indexExists = true; return {}; }
  deleteIndex(name) { if (name === 'usedAt') this.owner.indexExists = false; }
  clear() { this.owner.records.clear(); }
  get indexNames() { return { contains: name => name === 'createdAt' && this.owner?.indexExists }; }
}

class FakeDatabase {
  constructor(owner) { this.owner = owner; this.closed = false; this.closeCount = 0; }
  get objectStoreNames() { return { contains: name => name === 'worlds' && this.owner.storeExists }; }
  createObjectStore(name, options) {
    assert.equal(name, 'worlds');
    assert.deepEqual(options, { keyPath: 'key' });
    this.owner.storeExists = true;
    const store = new FakeObjectStoreDefinition();
    store.owner = this.owner;
    return store;
  }
  transaction(name, mode) {
    assert.equal(name, 'worlds');
    assert.ok(mode === 'readwrite' || mode === 'readonly');
    const tx = new FakeTransaction(this.owner, this.owner.options);
    this.owner.transactions.push(tx);
    return tx;
  }
  close() { this.closed = true; this.closeCount++; }
}

class FakeTransaction {
  constructor(owner, options) {
    this.owner = owner;
    this.options = options;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.queue = [];
    this.running = false;
    this.finished = false;
    this.snapshot = structuredClone(owner.records);
    this.abortCount = 0;
  }
  objectStore() { return new FakeObjectStore(this); }
  enqueue(request, run) {
    if (this.finished) return request;
    this.queue.push({ request, run });
    this.pump();
    return request;
  }
  pump() {
    if (this.running || this.finished || this.options.hangTransactions) return;
    this.running = true;
    setTimeout(() => {
      this.running = false;
      if (this.finished) return;
      const task = this.queue.shift();
      if (task) {
        try {
          task.request.result = task.run();
          task.request.onsuccess?.({ target: task.request });
        } catch (error) {
          this.fail(task.request, error);
          return;
        }
        this.pump();
        return;
      }
      // Let handlers enqueue follow-on requests before committing the transaction.
      setTimeout(() => {
        if (this.queue.length) this.pump();
        else if (!this.finished) {
          this.finished = true;
          this.oncomplete?.({ target: this });
        }
      }, 0);
    }, 0);
  }
  fail(request, error) {
    if (this.finished) return;
    this.error = error;
    request.error = error;
    request.onerror?.({ target: request });
    this.abort();
  }
  abort() {
    if (this.finished) return;
    this.abortCount++;
    this.finished = true;
    this.queue.length = 0;
    this.owner.records = structuredClone(this.snapshot);
    this.onabort?.({ target: this });
  }
}

class FakeObjectStore {
  constructor(tx) { this.tx = tx; }
  get(key) {
    return this.tx.enqueue(new FakeRequest(), () => {
      const record = this.tx.owner.records.get(key);
      return record === undefined ? undefined : structuredClone(record);
    });
  }
  put(record) {
    this.tx.owner.putRequests++;
    return this.tx.enqueue(new FakeRequest(), () => {
      this.tx.owner.records.set(record.key, structuredClone(record));
      return record.key;
    });
  }
  count() {
    if (this.tx.options.throwOnCountEnqueue) throw new Error('injected synchronous count enqueue failure');
    return this.tx.enqueue(new FakeRequest(), () => this.tx.owner.records.size);
  }
  delete(key) {
    return this.tx.enqueue(new FakeRequest(), () => {
      if (this.tx.options.failDeleteKey === key) throw new Error('injected IndexedDB delete failure');
      this.tx.owner.records.delete(key);
      return undefined;
    });
  }
  index(name) {
    assert.equal(name, 'createdAt');
    return { openKeyCursor: () => this.openKeyCursor() };
  }
  openKeyCursor() {
    const req = new FakeRequest();
    let keys;
    let at = 0;
    const emit = () => this.tx.enqueue(req, () => {
      if (!keys) keys = [...this.tx.owner.records.values()].sort((a, b) => a.createdAt - b.createdAt).map(record => record.key);
      const key = keys[at];
      if (key === undefined) return null;
      return {
        primaryKey: key,
        continue: () => { at++; emit(); },
      };
    });
    emit();
    return req;
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error?.stack ?? error}`); }
}
function install(fake) {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = fake;
  return () => { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; };
}

await check('adapter bounds cache to three written entries and read-only hits do not refresh FIFO age', async () => {
  const fake = new FakeIndexedDB();
  const restore = install(fake);
  const now = Date.now;
  let tick = 1_000;
  Date.now = () => tick++;
  try {
    const storage = new IndexedDbWorldCacheStorage();
    const request = seed => ({ seed, size: 2, worldSize: 10, windFrom: 0, vegetationDensity: 0 });
    const world = () => {
      const house = { x: 0, z: 0, y: 0, maxY: 1, w: 1, l: 1, hgt: 1, rot: 0 };
      const pier = { x: 0, z: 0, angle: 0, length: 1, width: 1, top: 0, berthStart: 0 };
      const harbour = { id: 0, island: 0, name: 'Test', harbour: { x: 0, z: 0, openAngle: 0 }, shore: { x: 0, z: 0 }, pier, houses: [house], detail: 1,
        profile: { houses: 1, area: 1, features: Object.fromEntries(['wine', 'oil', 'wheat', 'almonds', 'fish', 'honey', 'firewood', 'pitch'].map(g => [g, 1])) } };
      const map = { originX: 0, originZ: 0, cell: 1, n: 1, F: new Float32Array(16), S: new Float32Array(16), W: new Float32Array(16), hb: new Float32Array(1), land: new Uint8Array(1) };
      return { heights: new Float32Array(4), size: 2, worldSize: 10, islands: [{ id: 0, name: 'Test', cx: 0, cz: 0, area: 1, peak: 1, peakX: 0, peakZ: 0 }],
        sites: { harbour: { x: 0, z: 0, openAngle: 0 }, shore: { x: 0, z: 0 }, temple: { x: 0, z: 0, y: 0 }, houses: [house], pier, start: { x: 0, z: 0, heading: 0 }, harbours: [harbour] },
        vegetation: new Float32Array(0), ao: new Uint8Array(1), aoSize: 1, seaState: { dirs: 16, maps: [map, structuredClone(map)], ms: 0 } };
    };
    const a = request(1), b = request(2), c = request(3), d = request(4);
    const keyA = worldCacheKey(a, 'r');
    for (const req of [a, b, c]) {
      const key = worldCacheKey(req, 'r');
      await storage.put(key, { schema: 1, key, result: world() });
    }
    const putsBeforeHit = fake.putRequests;
    let generated = 0;
    await loadCachedWorld(a, 'r', async () => { generated++; return world(); });
    assert.equal(generated, 0);
    assert.equal(fake.putRequests, putsBeforeHit, 'cache hit must not write the world again');
    const keyD = worldCacheKey(d, 'r');
    await storage.put(keyD, { schema: 1, key: keyD, result: world() });
    assert.deepEqual([...fake.records.keys()].sort(), [worldCacheKey(b, 'r'), worldCacheKey(c, 'r'), keyD].sort());
    assert.equal(fake.records.has(keyA), false, 'the older accessed record is evicted FIFO');
  } finally { Date.now = now; restore(); }
});

await check('prune failure aborts atomically and preserves prior cache records', async () => {
  const fake = new FakeIndexedDB({ failDeleteKey: 'a' });
  const restore = install(fake);
  try {
    const storage = new IndexedDbWorldCacheStorage();
    await storage.put('a', { value: 'a' });
    await storage.put('b', { value: 'b' });
    await storage.put('c', { value: 'c' });
    const before = structuredClone(fake.records);
    await assert.rejects(storage.put('d', { value: 'd' }));
    assert.deepEqual(fake.records, before);
    assert.equal(fake.transactions.at(-1).abortCount, 1);
  } finally { restore(); }
});

await check('synchronous enqueue failure aborts already queued write', async () => {
  const fake = new FakeIndexedDB({ throwOnCountEnqueue: true });
  const restore = install(fake);
  try {
    const storage = new IndexedDbWorldCacheStorage();
    await assert.rejects(storage.put('partial', { value: 'must roll back' }), /synchronous count enqueue failure/);
    assert.equal(fake.records.has('partial'), false);
    assert.equal(fake.transactions[0].abortCount, 1);
  } finally { restore(); }
});

await check('blocked open falls back and closes a late successful connection', async () => {
  const fake = new FakeIndexedDB({ blocked: true, openDelay: 30 });
  const restore = install(fake);
  try {
    let generated = 0;
    await loadCachedWorld({ seed: 1, size: 2, worldSize: 10, windFrom: 0, vegetationDensity: 0 }, 'r', async () => { generated++; return { generated: true }; });
    await delay(40);
    assert.equal(generated, 1);
    assert.equal(fake.dbObjects[0].closed, true);
  } finally { restore(); }
});

await check('open timeout falls back and closes the connection when late open succeeds', async () => {
  const fake = new FakeIndexedDB({ openDelay: 1_100 });
  const restore = install(fake);
  try {
    let generated = 0;
    await loadCachedWorld({ seed: 1, size: 2, worldSize: 10, windFrom: 0, vegetationDensity: 0 }, 'r', async () => { generated++; return { generated: true }; });
    assert.equal(generated, 1);
    await delay(150);
    assert.equal(fake.dbObjects[0].closed, true);
  } finally { restore(); }
});

await check('transaction timeout aborts, closes database, and falls back to generation', async () => {
  const fake = new FakeIndexedDB({ hangTransactions: true });
  const restore = install(fake);
  try {
    let generated = 0;
    await loadCachedWorld({ seed: 1, size: 2, worldSize: 10, windFrom: 0, vegetationDensity: 0 }, 'r', async () => { generated++; return { generated: true }; });
    assert.equal(generated, 1);
    assert.equal(fake.transactions[0].abortCount, 1);
    assert.equal(fake.dbObjects[0].closed, true);
  } finally { restore(); }
});

if (failures) {
  console.error(`\n${failures} startup-storage test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll startup-storage adapter tests passed.');
}
