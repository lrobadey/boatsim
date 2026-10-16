// Headless acceptance tests for startup world caching and precomputed textures.
//   node scripts/test-startup-cache.mjs
import './register-ts.mjs';
import assert from 'node:assert/strict';

const { loadCachedWorld, worldCacheKey } = await import('../src/core/worldCache.ts');
const {
  STARTUP_TEXTURE_HEADER_BYTES,
  STARTUP_TEXTURE_LENGTHS,
  decodeStartupTextures,
  encodeStartupTextures,
  loadStartupTextures,
} = await import('../src/gfx/startupTextures.ts');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}\n${error?.stack ?? error}`);
  }
}

const request = {
  seed: 731,
  size: 2,
  worldSize: 12000,
  windFrom: 1.25,
  vegetationDensity: 0.4,
  authoredHarbour: true,
};
const house = { x: 1, z: 2, y: 0, maxY: 5, w: 3, l: 4, hgt: 5, rot: 0.2 };
const pier = { x: 10, z: 12, angle: 0.3, length: 20, width: 4, top: 1, berthStart: 6 };
function worldFixture(offset = 0) {
  const n = 2;
  const map = {
    originX: -1, originZ: -1, cell: 1, n,
    F: new Float32Array(n * n * 16).fill(100 + offset),
    S: new Float32Array(n * n * 16).fill(0.8),
    W: new Float32Array(n * n * 16).fill(0.7),
    hb: new Float32Array(n * n).fill(20),
    land: new Uint8Array(n * n),
  };
  const primary = {
    id: 0, island: 0, name: 'Harbour isle',
    harbour: { x: 1, z: 2, openAngle: 0.3 }, shore: { x: 3, z: 4 }, pier,
    houses: [house], detail: 1,
    profile: { houses: 1, area: 500, features: Object.fromEntries(['wine', 'oil', 'wheat', 'almonds', 'fish', 'honey', 'firewood', 'pitch'].map((good, i) => [good, 50 + i])) },
  };
  return {
    heights: new Float32Array(n * n).fill(offset), size: n, worldSize: 12000,
    islands: [{ id: 0, name: 'Harbour isle', cx: 0, cz: 0, area: 500, peak: 9, peakX: 1, peakZ: 2 }],
    sites: {
      harbour: { x: 1, z: 2, openAngle: 0.3 }, shore: { x: 3, z: 4 }, temple: { x: 0, z: 0, y: 6 },
      houses: [house], pier, start: { x: 5, z: 6, heading: 0.4 }, harbours: [primary],
    },
    vegetation: new Float32Array([1, 2, 3, 1, 0, 2]), ao: new Uint8Array([0, 128, 255, 64]), aoSize: n,
    seaState: { dirs: 16, maps: [map, structuredClone(map)], ms: 1 },
  };
}

class MemoryStorage {
  records = new Map();
  async get(key) { return this.records.has(key) ? structuredClone(this.records.get(key)) : undefined; }
  async put(key, value) { this.records.set(key, structuredClone(value)); }
  async remove(key) { this.records.delete(key); }
}
const equalWorld = (a, b) => assert.deepStrictEqual(a, b);

await checkAsync('cache miss generates and stores a structurally valid world; next load is equal without aliasing', async () => {
  const storage = new MemoryStorage();
  let generated = 0;
  const first = await loadCachedWorld(request, 'rev-a', async () => { generated++; return worldFixture(); }, { storage });
  first.heights[0] = 999;
  const second = await loadCachedWorld(request, 'rev-a', async () => { generated++; return worldFixture(99); }, { storage });
  assert.equal(generated, 1);
  equalWorld(second, worldFixture());
  assert.notEqual(first, second);
  assert.notEqual(first.seaState.maps[0].F, second.seaState.maps[0].F);
});

await checkAsync('cache reports miss then hit', async () => {
  const storage = new MemoryStorage();
  const statuses = [];
  const generate = async () => worldFixture();
  await loadCachedWorld(request, 'rev-status', generate, { storage, onStatus: s => statuses.push(s) });
  await loadCachedWorld(request, 'rev-status', generate, { storage, onStatus: s => statuses.push(s) });
  assert.deepEqual(statuses, ['miss', 'hit']);
});

check('cache key changes for every request input and revision; omitted and false authored harbor match', () => {
  const base = worldCacheKey(request, 'rev-a');
  for (const [field, value] of Object.entries({
    seed: request.seed + 1,
    size: request.size + 1,
    worldSize: request.worldSize + 1,
    windFrom: request.windFrom + 0.1,
    vegetationDensity: request.vegetationDensity + 0.1,
    authoredHarbour: false,
  })) {
    assert.notEqual(worldCacheKey({ ...request, [field]: value }, 'rev-a'), base, `${field} must affect the key`);
  }
  assert.notEqual(worldCacheKey(request, 'rev-b'), base, 'revision must affect the key');
  const { authoredHarbour: _ignored, ...withoutAuthoredHarbour } = request;
  assert.equal(worldCacheKey(withoutAuthoredHarbour, 'rev-a'), worldCacheKey({ ...withoutAuthoredHarbour, authoredHarbour: false }, 'rev-a'));
});

await checkAsync('invalid cached entry is removed and regenerated', async () => {
  const storage = new MemoryStorage();
  const key = worldCacheKey(request, 'rev-invalid');
  storage.records.set(key, { schema: 1, key, result: { size: 999, heights: [] } });
  let generated = 0;
  const result = await loadCachedWorld(request, 'rev-invalid', async () => { generated++; return worldFixture(3); }, { storage });
  assert.equal(generated, 1);
  equalWorld(result, worldFixture(3));
  assert.deepEqual(storage.records.get(key).result, worldFixture(3));
});

for (const [name, mutate] of [
  ['wrong dimensions', world => { world.size++; world.worldSize++; }],
  ['invalid nested sea map arrays', world => { world.seaState.maps[0].F = new Float32Array(1); }],
]) {
  await checkAsync(`cache rejects ${name} and regenerates`, async () => {
    const storage = new MemoryStorage();
    const key = worldCacheKey(request, `rev-${name}`);
    const invalid = worldFixture();
    mutate(invalid);
    storage.records.set(key, { schema: 1, key, result: invalid });
    let generated = 0;
    const result = await loadCachedWorld(request, `rev-${name}`, async () => { generated++; return worldFixture(); }, { storage });
    assert.equal(generated, 1);
    equalWorld(result, worldFixture());
  });
}

await checkAsync('storage read failure still generates and reports unavailable', async () => {
  const statuses = [];
  const storage = { get: async () => { throw new Error('read failed'); }, put: async () => {}, remove: async () => {} };
  let generated = 0;
  const result = await loadCachedWorld(request, 'rev-read-fail', async () => { generated++; return worldFixture(); }, { storage, onStatus: s => statuses.push(s) });
  assert.equal(generated, 1);
  equalWorld(result, worldFixture());
  assert.deepEqual(statuses, ['unavailable']);
});

await checkAsync('storage write failure leaves generated result usable', async () => {
  const storage = { get: async () => undefined, put: async () => { throw new Error('write failed'); }, remove: async () => {} };
  const result = await loadCachedWorld(request, 'rev-write-fail', async () => worldFixture(4), { storage });
  equalWorld(result, worldFixture(4));
});

await checkAsync('default storage absence falls through to world generation', async () => {
  const previous = globalThis.indexedDB;
  try {
    delete globalThis.indexedDB;
    let generated = 0;
    const result = await loadCachedWorld(request, 'rev-no-indexeddb', async () => { generated++; return worldFixture(); });
    assert.equal(generated, 1);
    equalWorld(result, worldFixture());
  } finally {
    if (previous !== undefined) globalThis.indexedDB = previous;
  }
});

await checkAsync('generation failure propagates', async () => {
  const failure = new Error('generation failed');
  await assert.rejects(loadCachedWorld(request, 'rev-gen-fail', async () => { throw failure; }, { storage: new MemoryStorage() }), error => error === failure);
});

await checkAsync('distinct world requests do not collide', async () => {
  const storage = new MemoryStorage();
  let generated = 0;
  const a = await loadCachedWorld(request, 'rev-multi', async () => { generated++; return worldFixture(1); }, { storage });
  const b = await loadCachedWorld({ ...request, seed: request.seed + 1 }, 'rev-multi', async () => { generated++; return worldFixture(2); }, { storage });
  const a2 = await loadCachedWorld(request, 'rev-multi', async () => { generated++; return worldFixture(3); }, { storage });
  assert.equal(generated, 2);
  equalWorld(a, worldFixture(1));
  equalWorld(b, worldFixture(2));
  equalWorld(a2, worldFixture(1));
});

function patternedTextures() {
  const [noiseBytes, rippleBytes, shapeBytes, detailBytes, weatherBytes] = STARTUP_TEXTURE_LENGTHS;
  const noise = new Uint8Array(noiseBytes);
  const ripple = new Uint8Array(rippleBytes);
  const cloudShape = new Uint16Array(shapeBytes / 2);
  const cloudDetail = new Uint16Array(detailBytes / 2);
  const cloudWeather = new Uint8Array(weatherBytes);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + (i >>> 8)) & 255;
  for (let i = 0; i < ripple.length; i++) ripple[i] = (i * 17 + (i >>> 10)) & 255;
  for (let i = 0; i < cloudShape.length; i++) cloudShape[i] = (i * 257 + 0x3c01) & 0xffff;
  for (let i = 0; i < cloudDetail.length; i++) cloudDetail[i] = (i * 101 + 0x7e00) & 0xffff;
  for (let i = 0; i < cloudWeather.length; i++) cloudWeather[i] = (i * 13 + (i >>> 7)) & 255;
  return { noise, ripple, cloudShape, cloudDetail, cloudWeather };
}
const sameTextures = (a, b) => {
  for (const key of ['noise', 'ripple', 'cloudShape', 'cloudDetail', 'cloudWeather']) assert.deepEqual(a[key], b[key], `${key} must round-trip byte exactly`);
};
const expectedTextures = patternedTextures();
const encodedTextures = encodeStartupTextures(expectedTextures);

await checkAsync('texture codec round-trips deterministic arrays bit exactly, including 16-bit patterns', async () => {
  assert.equal(encodedTextures.byteLength, STARTUP_TEXTURE_HEADER_BYTES + STARTUP_TEXTURE_LENGTHS.reduce((a, b) => a + b, 0));
  sameTextures(decodeStartupTextures(encodedTextures), expectedTextures);
});

await checkAsync('valid precomputed asset returns decoded textures without fallback', async () => {
  let fallbackCalls = 0;
  const statuses = [];
  const result = await loadStartupTextures('/startup.bin', async () => { fallbackCalls++; return patternedTextures(); }, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => encodedTextures }),
    onStatus: s => statuses.push(s),
  });
  sameTextures(result, expectedTextures);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(statuses, ['precomputed']);
});

for (const [name, corrupt] of [
  ['truncated asset', buffer => buffer.slice(0, buffer.byteLength - 1)],
  ['bad magic header', buffer => { const copy = buffer.slice(0); new Uint8Array(copy)[0] ^= 0xff; return copy; }],
  ['payload corruption', buffer => { const copy = buffer.slice(0); new Uint8Array(copy)[12] ^= 0xff; return copy; }],
]) {
  await checkAsync(`${name} falls back to generation`, async () => {
    let fallbackCalls = 0;
    const generated = patternedTextures();
    const result = await loadStartupTextures('/broken.bin', async () => { fallbackCalls++; return generated; }, {
      fetcher: async () => ({ ok: true, arrayBuffer: async () => corrupt(encodedTextures) }),
    });
    assert.equal(fallbackCalls, 1);
    sameTextures(result, generated);
  });
}

await checkAsync('fetch rejection falls back to generation', async () => {
  let fallbackCalls = 0;
  const generated = patternedTextures();
  const result = await loadStartupTextures('/offline.bin', async () => { fallbackCalls++; return generated; }, {
    fetcher: async () => { throw new Error('offline'); },
  });
  assert.equal(fallbackCalls, 1);
  sameTextures(result, generated);
});

await checkAsync('fetch that ignores abort is bounded and falls back', async () => {
  let fallbackCalls = 0;
  const generated = patternedTextures();
  const result = await loadStartupTextures('/hung.bin', async () => { fallbackCalls++; return generated; }, {
    fetcher: async () => new Promise(() => {}),
  });
  assert.equal(fallbackCalls, 1);
  sameTextures(result, generated);
});

await checkAsync('hung response body is bounded and falls back', async () => {
  let fallbackCalls = 0;
  const generated = patternedTextures();
  const result = await loadStartupTextures('/hung-body.bin', async () => { fallbackCalls++; return generated; }, {
    fetcher: async () => ({ ok: true, arrayBuffer: async () => new Promise(() => {}) }),
  });
  assert.equal(fallbackCalls, 1);
  sameTextures(result, generated);
});

await checkAsync('fallback generation rejection propagates', async () => {
  const failure = new Error('texture generation failed');
  await assert.rejects(loadStartupTextures('/broken.bin', async () => { throw failure; }, {
    fetcher: async () => { throw new Error('offline'); },
  }), error => error === failure);
});

if (failures) {
  console.error(`\n${failures} startup-cache acceptance test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll startup-cache acceptance tests passed.');
}
