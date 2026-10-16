// Archived candidate geometry contract; passing this does not establish pixel identity or performance.
import '../../../scripts/register-ts.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { CloudPass } = await import('../../../src/gfx/cloudPass.ts');

for (const reversed of [false, true]) {
  const pass = new CloudPass({ uniforms: {} }, new THREE.PerspectiveCamera(), reversed);
  const source = fs.readFileSync(new URL('./candidate-fragment.glsl', import.meta.url), 'utf8');
  const base = Number(source.match(/const float C_BOTTOM = ([\d.]+);/)[1]);
  const earth = Number(source.match(/const float C_EARTH = ([\d.]+);/)[1]);
  // The predicate is scalar GLSL using operators shared with JS. Interpret its actual return
  // expression so a units, inequality or guard regression changes these test outcomes.
  const expression = source.match(/bool foregroundBeforeClouds\([^)]*\)\s*\{[\s\S]*?return ([\s\S]*?);\s*\}/)[1];
  const skip = new Function('distanceKm', 'cameraHeight', 'C_BOTTOM', `return (${expression});`);
  const eligible = (metres, height) => skip(metres / 1000, height, base);
  assert.equal(pass.material.uniforms.uReversedDepth.value, reversed ? 1 : 0);
  for (const [name, metres, height, expected] of [
    ['near quay', 50, 7, true], ['water', 100, 7, true], ['underwater camera', 100, -10, true],
    ['sky sentinel', -1000, 7, false], ['invalid zero depth', 0, 7, false],
    ['last safe metre', base - 7 - 9, 7, true], ['guard boundary', base - 7 - 8, 7, false],
    ['uncertain boundary', base - 7 - 1, 7, false], ['distant surface', 2000, 7, false],
    ['just below layer', 1, base - 2, false], ['at cloud base', 1, base, false],
    ['eagle inside clouds', 1, 1600, false], ['above clouds', 100, 4000, false],
    ['invalid depth', NaN, 7, false], ['infinite depth', Infinity, 7, false],
  ]) assert.equal(eligible(metres, height), expected, `${name}, reversed=${reversed}`);
  const main = source.slice(source.lastIndexOf('void main()'));
  assert.ok(main.indexOf('foregroundBeforeClouds(distanceKm, uCloudOrigin.y)') < main.indexOf('texture(uCloud,'),
    'the shortcut must precede cloud radiance reads');
  assert.ok(main.indexOf('foregroundBeforeClouds(distanceKm, uCloudOrigin.y)') < main.indexOf('texture(uCloudDepth,'),
    'the shortcut must precede cloud metadata reads');
  assert.match(main, /if \(foregroundBeforeClouds\(distanceKm, uCloudOrigin.y\)\)\s*\{[\s\S]*?fragColor = scene;\s*return;/,
    'qualifying pixels preserve the original scene, including alpha');

  let seed = 1729;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (const height of [-20, 0, 7, 800, 1300, 1390, 1399, 1400, 1600, 4000]) {
    for (let i = 0; i < 1000; i++) {
      const metres = random() * 2000;
      if (!eligible(metres, height)) continue;
      const vertical = random() * 2 - 1, radius = earth + height;
      const b = radius * vertical, c = radius * radius - (earth + base) ** 2;
      const entry = -b + Math.sqrt(b * b - c);
      assert.ok(entry > metres, 'a skipped route must end before the spherical cloud layer');
      // Even the most permissive accepted neighboring depth stays below the base after
      // binary16 quantization. Probe both sides of the actual cloud-entry lower bound.
      const toleranceKm = Math.max(.001, metres * .000001);
      for (const offset of [-2, 0, 1, 2, 8]) {
        const sourceMetres = base - height + offset;
        const packedKm = THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(sourceMetres / 1000));
        if (packedKm <= metres / 1000 + toleranceKm) assert.ok(sourceMetres < base - height);
      }
    }
  }
  pass.dispose();
}
console.log('PASS cloud foreground early-out: sky, camera heights, guard, depth modes, shell geometry and metadata precision');
