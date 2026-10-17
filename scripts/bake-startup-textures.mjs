import './register-ts.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloudNoiseData, cloudWeatherData, noiseData, rippleData } from '../src/gfx/texdata.ts';
import { decodeStartupTextures, encodeStartupTextures } from '../src/gfx/startupTextures.ts';

export function generateStartupTextures() {
  const clouds = cloudNoiseData(5);
  return {
    noise: noiseData(256, 3),
    ripple: rippleData(512, 9),
    cloudShape: clouds.shape,
    cloudDetail: clouds.detail,
    cloudWeather: cloudWeatherData(256, 23),
  };
}

export async function ensureStartupTextures(root, revision) {
  if (typeof revision !== 'string' || !/^[A-Za-z0-9._-]+$/.test(revision) || revision === '.' || revision === '..') {
    throw new TypeError('revision must be a non-empty safe filename component');
  }
  const started = performance.now();
  const directory = path.join(root, 'public', 'generated', 'startup-textures');
  const target = path.join(directory, `${revision}.bin`);
  const url = `/generated/startup-textures/${revision}.bin`;
  await fs.mkdir(directory, { recursive: true });
  try {
    const existing = await fs.readFile(target);
    decodeStartupTextures(existing.buffer.slice(existing.byteOffset, existing.byteOffset + existing.byteLength));
    return { url, bytes: existing.byteLength, generated: false, ms: performance.now() - started };
  } catch {}

  const binary = encodeStartupTextures(generateStartupTextures());
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, new Uint8Array(binary));
  await fs.rename(temporary, target);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const fingerprinted = await Promise.all(entries
    .filter(entry => entry.isFile() && /^[a-f0-9]{64}\.bin$/.test(entry.name))
    .map(async entry => ({ name: entry.name, mtimeMs: (await fs.stat(path.join(directory, entry.name))).mtimeMs })));
  fingerprinted.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set([`${revision}.bin`, ...fingerprinted.slice(0, 3).map(entry => entry.name)]);
  await Promise.all(fingerprinted.filter(entry => !keep.has(entry.name))
    .map(entry => fs.rm(path.join(directory, entry.name), { force: true })));
  return { url, bytes: binary.byteLength, generated: true, ms: performance.now() - started };
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const revision = process.argv[2];
  if (!revision) throw new Error('Usage: node scripts/bake-startup-textures.mjs <revision>');
  const result = await ensureStartupTextures(process.cwd(), revision);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
