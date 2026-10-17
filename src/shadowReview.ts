/** Development-only measurements of the actual production render path. */
import type { Game } from './game';
import type { CrewAnimator } from './crew/crewAnimator';
import type { DirectionalShadowFrame } from './gfx/directionalShadowFrame';
import * as THREE from 'three';
import { GpuProfiler } from './gfx/gpuProfiler';

const params = new URLSearchParams(location.search);
if (!params.has('dev')) throw new Error('Shadow review requires ?dev');
void import('./main').then(() => {
  const wait = () => {
    const game = (window as unknown as { game?: Game }).game;
    if (!game?.running) { requestAnimationFrame(wait); return; }
    install(game);
  };
  wait();
});

type ShadowDraw = { stage: string; calls: number; triangles: number; cpuMs: number; layers: number; casters: number };
type Frame = { intervalMs: number; shadows: ShadowDraw[] };
type Measurement = { mode: string; view: string; hour: number; live: boolean; frames: Frame[]; gpu: { stage: string; ms: number }[]; state: unknown };

function summary(values: number[]) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { count: sorted.length, median: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}

function install(g: Game) {
  const r = g.pipeline.renderer;
  const profiler = new GpuProfiler(r);
  let baseline = params.get('policy') === 'baseline';
  const shadowFrame = (g.pipeline as unknown as { directionalShadows: DirectionalShadowFrame }).directionalShadows;
  const sharedFrame = shadowFrame.render.bind(shadowFrame);
  // The A/B switch exists only in this entry. Bypassing the scope restores the
  // original reflection/refraction/main shadow policy without changing game code.
  shadowFrame.render = <T>(work: () => T): T => baseline ? work() : sharedFrame(work);
  let live = false;
  Object.defineProperty(g, 'paused', { configurable: true, get: () => !live, set: () => {} });
  g.clock.timeScale = 0;
  g.pipeline.adaptive = false;
  g.pipeline.setRenderScale(Number(params.get('scale') ?? 2));
  g.pipeline.targetFps = Number(params.get('cap') ?? 60);
  g.showHud = false;
  g.hud.setVisible(false);
  const weather = g.clouds.advanceWeather.bind(g.clouds);
  g.clouds.advanceWeather = (dt, x, z) => weather(live ? dt : 0, x, z);
  const birdUpdate = g.birds.update.bind(g.birds);
  g.birds.update = (dt, camera) => birdUpdate(live ? dt : 0, camera);
  const animator = (g as unknown as { crewAnimator: CrewAnimator | null }).crewAnimator;
  if (animator) {
    const animate = animator.update.bind(animator);
    animator.update = (dt, alpha, ship) => animate(live ? dt : 0, alpha, ship);
  }

  const panel = document.createElement('div');
  panel.id = 'shadow-controls';
  panel.style.cssText = 'position:fixed;bottom:10px;left:10px;right:10px;z-index:1000;background:#162127ed;color:#eee;padding:9px 12px;font:12px/1.5 system-ui;pointer-events:auto';
  panel.innerHTML = `<b>Directional shadows · fixed Ultra scale ${g.pipeline.renderScale}</b>
    <button id="measure-shadow">Measure shadows</button>
    <button id="measure-frame">Measure whole frame</button>
    <button id="measure-cadence">Measure cadence</button>
    <button id="shadow-live">Run simulation</button>
    <button id="shadow-policy">${baseline ? 'Use shared shadows' : 'Use baseline shadows'}</button>
    <label>Frame cap <select id="shadow-cap" aria-label="Frame cap"><option value="60">60</option><option value="15">15</option></select></label>
    <button id="export-shadow">Export measurements</button>
    <output id="shadow-status">Ready</output>`;
  document.getElementById('ui')!.append(panel);
  const stateElement = document.createElement('script');
  stateElement.id = 'shadow-review-state'; stateElement.type = 'application/json'; panel.append(stateElement);
  const reportElement = document.createElement('script');
  reportElement.id = 'shadow-review-report'; reportElement.type = 'application/json'; panel.append(reportElement);
  const status = panel.querySelector('output')!;
  (panel.querySelector('#shadow-cap') as HTMLSelectElement).value = String(g.pipeline.targetFps);
  const measurements: Measurement[] = [];
  let mode: 'idle' | 'shadow' | 'frame' | 'cadence' = 'idle';
  let warmup = 0, drain = 0;
  let collecting = false;
  let samples: Frame[] = [];
  let frame: Frame = { intervalMs: 0, shadows: [] };
  let previous = performance.now();
  let inside: ShadowDraw | null = null;
  let casters = new Set<THREE.Object3D>();
  const begin = g.pipeline.beginGpuTimer.bind(g.pipeline);
  const end = g.pipeline.endGpuTimer.bind(g.pipeline);
  const shadowRender = r.shadowMap.render.bind(r.shadowMap);
  const direct = r.renderBufferDirect.bind(r);
  r.renderBufferDirect = (...args) => {
    if (inside) {
      const [, , geometry, , object, group] = args;
      inside.calls++;
      inside.triangles += (group?.count ?? geometry.index?.count ?? geometry.attributes.position.count) / 3
        * ((object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh).count : 1);
      casters.add(object);
    }
    return direct(...args);
  };
  r.shadowMap.render = (lights, scene, camera) => {
    const active = r.shadowMap.enabled && (r.shadowMap.autoUpdate || r.shadowMap.needsUpdate)
      && lights.some(light => light instanceof THREE.DirectionalLight && (light.shadow.autoUpdate || light.shadow.needsUpdate));
    if (scene !== g.scene || !active) return shadowRender(lights, scene, camera);
    const stage = camera.layers.mask === 7 ? 'shared' : camera === g.reflection.camera ? 'reflection' : camera.layers.mask === 2 ? 'refraction' : 'main';
    const sample: ShadowDraw = { stage, calls: 0, triangles: 0, cpuMs: 0, layers: camera.layers.mask, casters: 0 };
    inside = sample; casters = new Set();
    const t = performance.now();
    try { return profiler.measure(stage, () => shadowRender(lights, scene, camera)); }
    finally {
      sample.cpuMs = performance.now() - t; sample.casters = casters.size; inside = null;
      frame.shadows.push(sample);
    }
  };

  const metadata = () => {
    const gl = r.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { policy: baseline ? 'baseline' : 'shared', cap: g.pipeline.targetFps,
      quality: params.get('q'), scale: g.pipeline.renderScale, viewport: [innerWidth, innerHeight],
      drawingBuffer: [r.domElement.width, r.domElement.height], shadowMap: g.sky.light.shadow.mapSize.toArray(),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable',
      userAgent: navigator.userAgent, timerQueryAvailable: profiler.available,
      camera: g.camera.position.toArray(), cameraQuaternion: g.camera.quaternion.toArray(),
      ship: g.ship.pos.toArray(), shipQuaternion: g.ship.quat.toArray(), shipTime: g.ship.time,
      environment: g.sky.environmentTelemetry.generation,
      revision: params.get('revision') ?? 'unlabelled' };
  };
  const publish = () => {
    const last = measurements.at(-1);
    const byStage: Record<string, number[]> = {};
    for (const sample of last?.gpu ?? []) (byStage[sample.stage] ??= []).push(sample.ms);
    stateElement.textContent = JSON.stringify({ mode, collecting, warmup, drain, samples: samples.length,
      measurements: measurements.length, state: metadata(), latest: last ? {
        mode: last.mode, view: last.view, hour: last.hour, live: last.live,
        frameIntervals: summary(last.frames.map(f => f.intervalMs)),
        updatesPerFrame: summary(last.frames.map(f => f.shadows.length)),
        drawsPerFrame: summary(last.frames.map(f => f.shadows.reduce((n, s) => n + s.calls, 0))),
        trianglesPerFrame: summary(last.frames.map(f => f.shadows.reduce((n, s) => n + s.triangles, 0))),
        shadowCpuMs: summary(last.frames.map(f => f.shadows.reduce((n, s) => n + s.cpuMs, 0))),
        stages: Object.fromEntries(Object.entries(byStage).map(([stage, values]) => [stage, summary(values)])),
        firstFrame: last.frames[0], state: last.state,
      } : null });
  };
  g.pipeline.beginGpuTimer = () => {
    const now = performance.now(); frame = { intervalMs: now - previous, shadows: [] }; previous = now;
    if (mode === 'frame' && (warmup > 0 || collecting)) begin();
  };
  g.pipeline.endGpuTimer = () => {
    if (mode === 'frame') end();
    profiler.poll();
    if (mode === 'idle') return;
    if (warmup > 0) {
      if (--warmup === 0) { samples = []; profiler.reset(); g.pipeline.resetGpuSamples(1000); collecting = true; }
    } else if (collecting) {
      samples.push(frame);
      if (samples.length >= 240) { collecting = false; profiler.enabled = false; drain = 20; }
    } else if (drain > 0 && --drain === 0) {
      measurements.push({ mode, view: document.getElementById('ormos-review')?.dataset.view ?? 'normal',
        hour: g.clock.hours, live, frames: samples.slice(),
        gpu: mode === 'shadow' ? profiler.samples.map(s => ({ stage: s.stage, ms: s.ms }))
          : mode === 'frame' ? g.pipeline.gpuSamples.map(ms => ({ stage: 'frame', ms })) : [], state: metadata() });
      // Serialize raw history once, outside the sampled frame loop.
      reportElement.textContent = JSON.stringify({ measurements });
      mode = 'idle'; profiler.enabled = false; status.textContent = `Finished measurement ${measurements.length}`;
    }
    if (mode !== 'idle') status.textContent = `${mode}: ${warmup ? 'warming' : collecting ? `${samples.length}/240 frames` : 'draining GPU queries'}`;
    if (mode === 'idle' || (collecting && samples.length % 30 === 0)) publish();
  };
  const measure = (next: 'shadow' | 'frame' | 'cadence') => {
    if (mode !== 'idle') return;
    mode = next; warmup = 60; collecting = false; samples = []; drain = 0;
    profiler.reset(); profiler.enabled = next === 'shadow'; g.sky.environmentProfiler.enabled = false;
    g.pipeline.resetGpuSamples(1000); publish();
  };
  panel.querySelector('#measure-shadow')!.addEventListener('click', () => measure('shadow'));
  panel.querySelector('#measure-frame')!.addEventListener('click', () => measure('frame'));
  panel.querySelector('#measure-cadence')!.addEventListener('click', () => measure('cadence'));
  panel.querySelector('#shadow-live')!.addEventListener('click', e => {
    live = !live; (e.target as HTMLElement).textContent = live ? 'Freeze simulation' : 'Run simulation'; publish();
  });
  panel.querySelector('#shadow-policy')!.addEventListener('click', e => {
    if (mode !== 'idle') return;
    baseline = !baseline;
    (e.target as HTMLElement).textContent = baseline ? 'Use shared shadows' : 'Use baseline shadows'; publish();
  });
  panel.querySelector('#shadow-cap')!.addEventListener('change', e => {
    g.pipeline.targetFps = Number((e.target as HTMLSelectElement).value); publish();
  });
  panel.querySelector('#export-shadow')!.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([reportElement.textContent ?? ''], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `shadow-${params.get('revision') ?? 'review'}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  publish();
}
