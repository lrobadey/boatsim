// Exercise production material shader hooks against Three's unexpanded built-in shader template.
import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const { patchMaterial, shared } = await import('../src/gfx/shared.ts');
const { CLOUD_GLSL } = await import('../src/gfx/clouds.ts');
const { getEnvironmentShaderVariantStats, setEnvironmentShaderBlend } = await import('../src/gfx/environmentMaterials.ts');
const physicalChunk = THREE.ShaderChunk.envmap_physical_pars_fragment;
const registeredBefore = getEnvironmentShaderVariantStats().registered;
const material = patchMaterial(new THREE.MeshStandardMaterial({ roughness: 0.7 }));
assert.equal(getEnvironmentShaderVariantStats().registered, registeredBefore + 1,
  'patched PBR material must join the environment variant registry');
const shader = {
  uniforms: {},
  vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader,
};

assert.equal(typeof material.onBeforeCompile, 'function');
material.onBeforeCompile(shader, {});

assert.equal(THREE.ShaderChunk.envmap_physical_pars_fragment, physicalChunk,
  'patch must leave Three global shader chunks unchanged');
assert.ok(!shader.fragmentShader.includes('#include <envmap_physical_pars_fragment>'),
  'the physical environment include must be replaced locally');
assert.ok(shader.fragmentShader.includes('vec3 samplePbrEnv'),
  'patched physical chunk must define the paired environment sampler');
assert.equal(material.defines.SKY_ENV_BLEND, 0, 'new PBR materials start in the settled compile variant');
assert.match(shader.fragmentShader, /#if SKY_ENV_BLEND\s+uniform sampler2D uPbrEnvNext;/,
  'PBR next-environment sampler must only exist in the transition variant');
assert.match(shader.fragmentShader, /#if SKY_ENV_BLEND\s+vec3 nextEnv = textureCubeUV\( uPbrEnvNext, direction, roughness \)\.rgb;[\s\S]*?#else\s+return currentRadiance;/,
  'PBR second read must compile out for settled materials');
assert.match(shader.fragmentShader, /#if SKY_ENV_BLEND\s+uniform samplerCube uFogEnvNext;/,
  'raw fog next-environment sampler must only exist in the transition variant');
assert.ok(shader.fragmentShader.includes('return currentRadiance;'),
  'settled PBR variant must return the one-sample environment result');
for (const direction of ['worldNormal', 'reflectVec', 'retroVec']) {
  assert.ok(shader.fragmentShader.includes(`samplePbrEnv( envMapRotation * ${direction}`),
    `Three PBR ${direction} sampling must use the paired helper`);
}
assert.equal(shader.uniforms.uPbrEnvNext, shared.uPbrEnvNext);
assert.equal(shader.uniforms.uEnvBlend, shared.uEnvBlend);
assert.ok(shader.fragmentShader.includes('uniform float uSkyShadowCoupling;'),
  'patched material must declare the shared sky-shadow coupling uniform');
assert.match(CLOUD_GLSL, /#if SKY_ENV_BLEND && !defined\(CLOUD_HAZE_SINGLE_SOURCE\)\s+uniform samplerCube uCloudHazeSkyNext;/,
  'paired haze sampler must be omitted from settled and capture variants at preprocessing time');
assert.match(CLOUD_GLSL, /#if SKY_ENV_BLEND && !defined\(CLOUD_HAZE_SINGLE_SOURCE\)[\s\S]*?#else\s+return currentRadiance;/,
  'settled and capture cloud variants must sample only the frozen clear-sky cube');
const settledVersion = material.version;
setEnvironmentShaderBlend(true);
assert.equal(material.defines.SKY_ENV_BLEND, 1, 'registry must select the transition PBR variant');
assert.ok(material.version > settledVersion, 'variant changes must invalidate the material exactly at the boundary');
const blendingVersion = material.version;
setEnvironmentShaderBlend(true);
assert.equal(material.version, blendingVersion, 'same-state blend updates must not recompile materials');
setEnvironmentShaderBlend(false);
assert.equal(material.defines.SKY_ENV_BLEND, 0, 'registry must restore the settled PBR variant');
material.dispose();
assert.equal(getEnvironmentShaderVariantStats().registered, registeredBefore,
  'disposing a registered material must unregister it');
console.log('PASS standard material environment shader hooks');
