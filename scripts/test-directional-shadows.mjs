import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const { DirectionalShadowFrame } = await import('../src/gfx/directionalShadowFrame.ts');

const scene = new THREE.Scene(), otherScene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(); camera.layers.mask = 5;
const reflectionCamera = new THREE.PerspectiveCamera(); reflectionCamera.layers.mask = 1;
const refractionCamera = new THREE.PerspectiveCamera(); refractionCamera.layers.mask = 2;
const sun = new THREE.DirectionalLight(), point = new THREE.PointLight();
const casters = [0, 1, 2].map(layer => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.layers.set(layer); mesh.name = `layer-${layer}`; scene.add(mesh); return mesh;
});
const updates = [];
const map = { enabled: true, autoUpdate: true, needsUpdate: false,
  render(lights, world, view) {
    if (this.enabled && (this.autoUpdate || this.needsUpdate) && lights.length) {
      updates.push({ lights: [...lights], scene: world, camera: view, layers: view.layers.mask,
        casters: casters.filter(object => object.layers.test(view.layers)).map(object => object.name) });
      this.needsUpdate = false;
    }
  },
};
const original = map.render;
const renderer = { shadowMap: map };
const frame = new DirectionalShadowFrame(renderer, scene, camera, 2);
const renderReflection = () => {
  const auto = map.autoUpdate; map.autoUpdate = false;
  try { map.render([sun], scene, reflectionCamera); }
  finally { map.autoUpdate = auto; }
};
frame.render(() => {
  renderReflection(); map.render([sun], scene, refractionCamera); map.render([sun], scene, camera);
});
assert.equal(updates.length, 1, 'one update across the three real pass orders');
assert.deepEqual(updates[0].casters, ['layer-0', 'layer-1', 'layer-2'], 'union of main and underwater casters');
assert.equal(updates[0].camera, camera);
assert.equal(updates[0].layers, 7);
assert.equal(camera.layers.mask, 5); assert.equal(reflectionCamera.layers.mask, 1);
assert.equal(map.render, original); assert.equal(map.autoUpdate, true);

// A new frame, moving light/ship or camera cut must get a fresh map. Reflection is optional.
frame.render(() => { map.render([sun], scene, refractionCamera); map.render([sun], scene, camera); });
assert.equal(updates.length, 2);
frame.render(() => {
  camera.layers.mask = 2;
  try { map.render([sun], scene, camera); }
  finally { camera.layers.mask = 5; }
  map.render([sun], scene, camera);
});
assert.deepEqual(updates.at(-1).casters, ['layer-0', 'layer-1', 'layer-2'], 'refraction reuses the main camera with temporary layers');
frame.render(() => { map.render([], otherScene, camera); renderReflection(); });
assert.equal(updates.length, 4, 'offscreen work cannot consume the world shadow update');

// Scene LOD selection for shadows uses the main viewpoint, not the mirrored viewpoint.
const lod = new THREE.LOD(); let lodCamera = null;
lod.update = view => { lodCamera = view; }; scene.add(lod);
frame.render(renderReflection); assert.equal(lodCamera, camera);

// Existing unrelated shadow types still render; disabled shadows stay disabled.
const beforePoint = updates.length;
frame.render(() => { map.render([sun, point], scene, camera); map.render([sun, point], scene, camera); });
assert.equal(updates.length, beforePoint + 2); assert.deepEqual(updates.at(-1).lights, [point]);
map.enabled = false;
frame.render(() => map.render([sun], scene, camera));
assert.equal(updates.length, beforePoint + 2); map.enabled = true;

// Failure restores the renderer hook, camera layers and caller update flags.
assert.throws(() => frame.render(() => { renderReflection(); throw new Error('pass failed'); }), /pass failed/);
assert.equal(map.render, original); assert.equal(camera.layers.mask, 5); assert.equal(map.autoUpdate, true);
const throwing = () => { throw new Error('shadow failed'); }; map.render = throwing; map.needsUpdate = true;
assert.throws(() => frame.render(renderReflection), /shadow failed/);
assert.equal(map.render, throwing); assert.equal(map.needsUpdate, true); assert.equal(camera.layers.mask, 5);
map.render = original;
frame.render(renderReflection); assert.equal(map.render, original);
const restoredMap = { ...map, render: original };
renderer.shadowMap = restoredMap;
const beforeRestore = updates.length;
frame.render(() => { restoredMap.render([sun], scene, camera); restoredMap.render([sun], scene, camera); });
assert.equal(updates.length, beforeRestore + 1, 'restored renderer shadow map is used');
assert.equal(restoredMap.render, original);
console.log('PASS directional shadows: one fresh full-caster update, reflection on/off, LOD viewpoint, other lights, disabled mode and failure recovery');
