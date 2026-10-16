// Headless CPU/data-path benchmark. This does not measure browser boot or IndexedDB I/O.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { sourceRevision } from './startup-revisions.mjs';
import { generateStartupTextures, ensureStartupTextures } from './bake-startup-textures.mjs';
import { decodeStartupTextures } from '../src/gfx/startupTextures.ts';
const { loadCachedWorld } = await import('../src/core/worldCache.ts');
const { QUALITY } = await import('../src/core/quality.ts');
const { Wind } = await import('../src/world/wind.ts');

const root = process.cwd();
const rawBaseline = execFileSync('git', ['show', 'HEAD:src/gfx/texdata.ts'], { encoding: 'utf8' });
const baselineJS = ts.transpileModule(rawBaseline, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("'simplex-noise'", JSON.stringify(import.meta.resolve('simplex-noise')));
const baseline = await import(`data:text/javascript;base64,${Buffer.from(baselineJS).toString('base64')}`);
const timed = async fn => { const start = performance.now(); const value = await fn(); return { value, ms: performance.now() - start }; };

const original = await timed(() => {
  const noise = baseline.noiseData(256, 3), ripple = baseline.rippleData(512, 9);
  const cloud = baseline.cloudNoiseData(5);
  return { noise, ripple, cloudShape: cloud.shape, cloudDetail: cloud.detail, cloudWeather: baseline.cloudWeatherData(256, 23) };
});
const current = await timed(generateStartupTextures);
assert.deepStrictEqual(current.value, original.value, 'All five generated textures must match the pre-change generator bit for bit');
const textureRevision = sourceRevision(root, ['src/gfx/texgen.worker.ts', 'src/gfx/startupTextures.ts', 'scripts/bake-startup-textures.mjs']).revision;
const asset = await ensureStartupTextures(root, textureRevision);
const decoded = await timed(async () => {
  const bytes = await fs.readFile(`${root}/public${asset.url}`);
  return decodeStartupTextures(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
});
assert.deepStrictEqual(decoded.value, original.value, 'Baked asset must match the original worker outputs');

let generated;
globalThis.self = { postMessage(message) { if (message.type === 'done') generated = message.result; }, onmessage: null };
await import('../src/world/worldgen.worker.ts');
const request = { seed: 1729, size: QUALITY.ultra.heightmapSize, worldSize: 12000,
  windFrom: new Wind(3).baseFrom, vegetationDensity: QUALITY.ultra.vegetationDensity, authoredHarbour: true };
const records = new Map();
const storage = {
  async get(key) { return structuredClone(records.get(key)); },
  async put(key, value) { records.set(key, structuredClone(value)); },
  async remove(key) { records.delete(key); },
};
let generationCount = 0;
const generate = async () => { generationCount++; self.onmessage({ data: request }); return generated; };
const revision = sourceRevision(root, ['src/world/worldgen.worker.ts']).revision;
const cold = await timed(() => loadCachedWorld(request, revision, generate, { storage }));
const warm = [];
for (let i = 0; i < 5; i++) {
  const hit = await timed(() => loadCachedWorld(request, revision, generate, { storage }));
  assert.deepStrictEqual(hit.value, cold.value, 'Complete cached world, including shelter and sites, must be unchanged');
  warm.push(hit.ms);
}
assert.equal(generationCount, 1, 'All warm runs must skip world generation');
const report = {
  date: new Date().toISOString(), node: process.version, request,
  scope: 'Headless local CPU/data paths; warm world uses structuredClone storage, NOT browser IndexedDB. Times are not total launch times and overlapping tasks must not be added.',
  textures: { originalGenerateMs: original.ms, currentGenerateMs: current.ms, fileReadAndValidateDecodeMs: decoded.ms, bytes: asset.bytes, bitExact: true, revision: textureRevision },
  world: { coldGenerateAndCloneMs: cold.ms, warmCloneReadMs: warm, completeWorldEqual: true, generationCount, revision },
};
await fs.mkdir('docs/startup-cache', { recursive: true });
await fs.writeFile('docs/startup-cache/headless-benchmark.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
