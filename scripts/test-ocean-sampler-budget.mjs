// Check exact short-wave texture packing, FFT foam/Jacobian packing, and combined-stage sampler budget.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
const { packOceanShortWaveTextures } = await import('../src/world/ocean.ts');

const fft = readFileSync(new URL('../src/world/oceanFFT.ts', import.meta.url), 'utf8');
const ocean = readFileSync(new URL('../src/world/ocean.ts', import.meta.url), 'utf8');
const shared = readFileSync(new URL('../src/gfx/shared.ts', import.meta.url), 'utf8');
const wavesSource = readFileSync(new URL('../src/world/waves.ts', import.meta.url), 'utf8');
const fragment = ocean.slice(ocean.indexOf('const FRAG ='));
let vertex = ocean.slice(ocean.indexOf('const VERT ='), ocean.indexOf('const FRAG ='));
// the vertex stage includes the sea state envelope GLSL from waves.ts: count its samplers too
const seaEnvGlsl = wavesSource.slice(wavesSource.indexOf('export const SEA_ENV_GLSL'));
assert.match(vertex, /\$\{SEA_ENV_GLSL\}/, 'vertex stage must include the sea state envelope');
vertex += `\n${seaEnvGlsl}`;

// Verify byte-for-byte layer packing and the corresponding normalized UV mapping.
const rippleData = new Uint8Array(512 * 512 * 4);
const noiseData = new Uint8Array(256 * 256 * 4);
for (let i = 0; i < rippleData.length; i++) rippleData[i] = i % 251;
for (let i = 0; i < noiseData.length; i++) noiseData[i] = (i * 17) % 253;
const ripple = new THREE.DataTexture(rippleData, 512, 512, THREE.RGBAFormat);
const noise = new THREE.DataTexture(noiseData, 256, 256, THREE.RGBAFormat);
const packed = packOceanShortWaveTextures(ripple, noise);
const bytesPerLayer = 512 * 512 * 4;
assert.deepEqual(packed.image.data.subarray(0, bytesPerLayer), rippleData,
  'ripple layer must retain every source byte');
for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
  const packedOffset = bytesPerLayer + (y * 512 + x) * 4;
  const sourceOffset = ((y & 255) * 256 + (x & 255)) * 4;
  assert.deepEqual(packed.image.data.subarray(packedOffset, packedOffset + 4),
    noiseData.subarray(sourceOffset, sourceOffset + 4), 'noise layer must tile the source exactly 2×2');
}
assert.equal(packed.wrapS, THREE.RepeatWrapping);
assert.equal(packed.wrapT, THREE.RepeatWrapping);
assert.equal(packed.minFilter, THREE.LinearMipmapLinearFilter);
assert.equal(packed.anisotropy, ripple.anisotropy || 1);
assert.match(fragment, /uniform highp sampler2DArray uShortWaveTex;/);
assert.match(fragment, /texture\(uShortWaveTex, vec3\([^\n]*, 0\.0\)\)/,
  'ripple samples must read array layer zero');
assert.match(fragment, /textureLod\(uShortWaveTex, vec3\(uv \* 0\.5, 1\.0\), lod\)/,
  'noise samples must read tiled layer one with the original repeat period');
assert.match(fragment, /float lod = max\(0\.0, 0\.5 \* log2\(max\(dot\(dx, dx\), dot\(dy, dy\)\)\)\);/,
  'noise LOD must follow isotropic filtering at the original 256² density');
assert.match(fragment, /#if SKY_ENV_BLEND\s+uniform highp sampler2DArray uShortWaveTex;\s+#else\s+uniform sampler2D uRipple;\s+uniform sampler2D uNoise;/,
  'transition and settled variants must select a single array sampler or the two original samplers');

// FFT packing: slope (sx, sz, sx^2 + sz^2, J) and displacement (Dx, Dy, Dz, persistent foam), so the
// fragment reads foam through the displacement texture the vertex stage already binds (one unit)
assert.match(fft, /oSlope = vec4\(s, dot\(s, s\), J\);/, 'slope output must carry the total mean-square slope and J');
assert.match(fft, /oDisp = vec4\(a\.x \* uChop, a\.y, a\.z \* uChop, max\(prev \* uDecay, src\)\);/,
  'displacement output must carry the persistent foam in w');
assert.doesNotMatch(fft, /oFoam/, 'no third FFT output');
assert.match(fragment, /vec2 foamJacobian = vec2\(texture2D\(uDispA, uvA\)\.w, sA\.w\);/,
  'ocean fragment must read foam from the shared displacement texture and J from the slope sample');
// the sea state envelope (vEnv1.x) scales the cascade's compression and its persistent foam
assert.match(fragment, /float JA = mix\(1\.0, 1\.0 \+ vEnv1\.x \* \(foamJacobian\.g - 1\.0\), fadeF\);/);
assert.match(fragment, /float trail = foamJacobian\.r \* fadeF \* vEnv1\.x \* vEnv1\.x;/);
// the sea state textures are read in the vertex shader only and reach the fragment as varyings
assert.doesNotMatch(fragment, /\$\{SEA_ENV_GLSL\}|uSeaEnv/, 'fragment shader must not sample the sea state textures');
assert.match(vertex, /uniform sampler2D uDispA;/);
assert.match(fragment, /uniform sampler2D uDispA;/,
  'the fragment shares the vertex stage\'s displacement sampler (one unit for both stages)');
assert.doesNotMatch(`${vertex}\n${fragment}`, /uFoamA/, 'the separate foam texture is gone');

function selectEnvironmentVariant(source, enabled) {
  const lines = source.split('\n');
  const stack = [];
  const out = [];
  let visible = true;
  for (const line of lines) {
    const directive = line.trim();
    if (directive === '#if SKY_ENV_BLEND') {
      stack.push({ visible, env: true, value: enabled });
      visible = visible && enabled;
    } else if (directive === '#else' && stack.at(-1)?.env) {
      const frame = stack.at(-1);
      visible = frame.visible && !frame.value;
      frame.value = !frame.value;
    } else if (directive === '#endif' && stack.at(-1)?.env) {
      visible = stack.pop().visible;
    } else if (visible) {
      out.push(line);
    }
  }
  return out.join('\n');
}

// Count active ocean application samplers in both stages for each compiled variant.
// Three's built-in directional map adds one unit. AO helpers and PBR are not active in Ocean.
for (const blending of [false, true]) {
  const sampledSource = selectEnvironmentVariant(`${vertex}\n${fragment}\n${shared}`, blending);
  const declared = [...sampledSource.matchAll(/uniform\s+(?:highp\s+)?sampler(?:2DArray|2D|Cube)\s+(\w+)\s*;/g)]
    .map((match) => match[1]);
  const activeSamplerNames = [...new Set(declared)].filter((name) => !['uHeightTex', 'uAOTex', 'uPbrEnvNext'].includes(name));
  assert.equal(activeSamplerNames.length, 15,
    `${blending ? 'blending' : 'settled'} expected 15 app samplers across both stages, found: ${activeSamplerNames.join(', ')}`);
  assert.ok(activeSamplerNames.includes('uSeaEnv'), 'the sea state envelope sampler is in the combined count');
  assert.ok(activeSamplerNames.includes('uDispA'), 'vertex displacement sampler must remain in the combined count');
  if (blending) {
    assert.ok(activeSamplerNames.includes('uShortWaveTex'), 'paired transition variant must use the packed sampler once');
    assert.ok(!activeSamplerNames.includes('uRipple') && !activeSamplerNames.includes('uNoise'));
  } else {
    assert.ok(activeSamplerNames.includes('uRipple') && activeSamplerNames.includes('uNoise'),
      'settled variant must restore the original separate noise and ripple samplers');
    assert.ok(!activeSamplerNames.includes('uFogEnvNext'), 'settled variant must omit the next sky sampler');
  }
  activeSamplerNames.push('directionalShadowMap');
  assert.equal(activeSamplerNames.length, 16);
}
packed.dispose();
console.log('PASS exact ocean short-wave pack, foam/Jacobian packing, and 16-sampler combined-stage budget');
