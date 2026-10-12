/** Standalone development inspection entry. No imports from the normal game entry into this file. */
import type { Game } from './game';
import * as THREE from 'three';
import { shared } from './gfx/shared';
import { createLightingFixtures } from './gfx/lightingFixtures';

const params = new URLSearchParams(location.search);
const programKeysRequested = params.get('programKeys') === '1';
if (!params.has('dev')) {
  params.set('dev', '');
  location.replace(`${location.pathname}?${params}`);
} else {
  void import('./main').then(waitForGame);
}

function waitForGame() {
  const game = (window as unknown as { game?: Game }).game;
  if (!game?.running) { requestAnimationFrame(waitForGame); return; }
  install(game);
}

function parseFixture(value: string | null): { camera: number[]; ship: number[] } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { camera?: unknown; ship?: unknown };
    const validPose = (pose: unknown): pose is number[] => Array.isArray(pose) && pose.length === 7
      && pose.every(v => typeof v === 'number' && Number.isFinite(v));
    if (validPose(parsed.camera) && validPose(parsed.ship)) return { camera: parsed.camera, ship: parsed.ship };
  } catch { /* malformed review fixture leaves the normal deterministic startup pose in place */ }
  return null;
}

function install(g: Game) {
  g.paused = true;
  g.clock.timeScale = 0;
  g.showHud = false;
  g.audio.toggleMute();
  let fixedWeather = true;
  let benchmarkRunning = false;
  let fastForwardRunning = false;
  let reviewLive = false;
  let fastForwardCameraHold = false;
  let benchmarkStartedAt = 0;
  let benchmarkPreviousState: { paused: boolean; timeScale: number; cinematic: boolean; fixedWeather: boolean } | null = null;
  // main.ts owns pause through title and pointer-lock handlers. In this development-only entry,
  // the review checkbox owns live state so unrelated main-entry events cannot thaw a fixture or
  // pause half of a timed benchmark. The normal game entry never imports this module.
  Object.defineProperty(g, 'paused', {
    configurable:true,
    enumerable:true,
    get:() => benchmarkRunning || fastForwardRunning ? false : !reviewLive,
    set:(_value: boolean) => { /* review controls are the only pause owner in this entry */ },
  });
  const singleEnvRequested = params.get('singleEnv') === '1';
  let singleEnvMaterialCount = 0;
  let singleEnvConditionCount = 0;
  if (singleEnvRequested) {
    const materials = new Set<THREE.Material>();
    g.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) mesh.material.forEach(material => materials.add(material));
      else if (mesh.material) materials.add(mesh.material);
    });
    for (const material of materials) {
      const originalCompile = material.onBeforeCompile.bind(material);
      const originalCacheKey = material.customProgramCacheKey.bind(material);
      const preservedCacheKey = originalCacheKey();
      material.onBeforeCompile = (shader, renderer) => {
        originalCompile(shader, renderer);
        const conditions = shader.fragmentShader.match(/uEnvBlend\s*<=\s*0(?:\.0+)?/g);
        if (!conditions?.length) return;
        singleEnvConditionCount += conditions.length;
        shader.fragmentShader = shader.fragmentShader.replace(/uEnvBlend\s*<=\s*0(?:\.0+)?/g, 'true');
      };
      material.customProgramCacheKey = () => `${preservedCacheKey}review-single-env`;
      material.needsUpdate = true;
      singleEnvMaterialCount++;
    }
  }
  const cloudWind = g.clouds.uniforms.uCloudWind.value as import('three').Vector2;
  const fixture = parseFixture(params.get('fixture'));
  if (fixture) {
    g.ship.pos.fromArray(fixture.ship.slice(0, 3));
    g.ship.prevPos.copy(g.ship.pos);
    g.ship.quat.fromArray(fixture.ship.slice(3));
    g.ship.quat.normalize();
    g.ship.prevQuat.copy(g.ship.quat);
    g.ship.vel.set(0, 0, 0);
    g.ship.angVel.set(0, 0, 0);
  }
  g.ship.time = 0;
  shared.uTime.value = 0;
  // Review captures use stationary cloud fields. Zero the displacement itself as well as the
  // per-frame wind input, so a previously accumulated weather offset cannot drift between views.
  cloudWind.set(0, 0);
  // Keep cloud geometry/coverage identical across clock samples; continue normal shading/history.
  const cloudStep = g.clouds.step.bind(g.clouds);
  g.clouds.step = (...args: Parameters<typeof cloudStep>) => {
    if (fixedWeather) {
      g.clouds.coverage = 0.4;
      cloudWind.set(0, 0);
      args[1] = 0; args[2] = 0;
    }
    cloudStep(...args);
    if (forceAfterCloudUpdate) {
      forceAfterCloudUpdate = false;
      g.sky.bakeEnvironment();
    }
  };
  const cloudsWithSplitApi = g.clouds as unknown as {
    advanceWeather?: (dt: number, windX: number, windZ: number) => void;
    applyLighting?: (...args: unknown[]) => void;
  };
  if (cloudsWithSplitApi.advanceWeather) {
    const advanceWeather = cloudsWithSplitApi.advanceWeather.bind(g.clouds);
    cloudsWithSplitApi.advanceWeather = (dt, windX, windZ) => {
      if (fixedWeather) { cloudWind.set(0, 0); windX = 0; windZ = 0; }
      advanceWeather(dt, windX, windZ);
    };
  }
  if (cloudsWithSplitApi.applyLighting) {
    const applyLighting = cloudsWithSplitApi.applyLighting.bind(g.clouds);
    cloudsWithSplitApi.applyLighting = (...args) => {
      if (fixedWeather) g.clouds.coverage = 0.4;
      applyLighting(...args);
      if (forceAfterCloudUpdate) {
        forceAfterCloudUpdate = false;
        g.sky.bakeEnvironment();
      }
    };
  }
  let bakeCount = 0, lastBakeCpuMs = 0, maxBakeCpuMs = 0;
  const bake = g.sky.bakeEnvironment.bind(g.sky);
  g.sky.bakeEnvironment = () => {
    const start = performance.now(); bake();
    lastBakeCpuMs = performance.now() - start;
    maxBakeCpuMs = Math.max(maxBakeCpuMs, lastBakeCpuMs); bakeCount++;
  };

  const presentTimes: number[] = [];
  let presentTimesLimit = 240;
  const beginGpuTimer = g.pipeline.beginGpuTimer.bind(g.pipeline);
  g.pipeline.beginGpuTimer = () => {
    presentTimes.push(performance.now());
    if (presentTimes.length > presentTimesLimit) presentTimes.shift();
    beginGpuTimer();
  };

  // The review entry is deliberately fixed at one render scale. Adaptive policy is disabled only
  // for this opt-in entry, after applying the requested scale once.
  const requestedScale = Number(params.get('scale') ?? 1);
  if (Number.isFinite(requestedScale)) g.pipeline.setRenderScale(requestedScale);
  g.pipeline.adaptive = false;

  // Freeze the shared shader clock around presentation. Simulation, ship and camera are already
  // paused below; this closes the remaining animation-time source for review screenshots.
  const render = g.pipeline.render.bind(g.pipeline);
  let benchmarkSimulationSeconds = 0;
  let benchmarkClockUpdates = 0;
  const clockUpdate = g.clock.update.bind(g.clock);
  g.clock.update = (dt: number) => {
    if (benchmarkRunning) { benchmarkSimulationSeconds += dt; benchmarkClockUpdates++; }
    clockUpdate(dt);
  };
  g.pipeline.render = ((...args: Parameters<typeof render>) => {
    const oldTime = shared.uTime.value;
    const mutedLights: Array<{ light: THREE.Light; visible: boolean }> = [];
    if (activeLightingMode === 'environment-only') g.scene.traverse(object => {
      if (object instanceof THREE.Light && object !== g.sky.hemi) {
        mutedLights.push({ light:object, visible:object.visible });
        object.visible = false;
      }
    });
    // Keep review captures fixed, but let the explicit live benchmark exercise animation time.
    shared.uTime.value = benchmarkRunning ? oldTime : 0;
    if (fixedExposure !== null) {
      g.pipeline.grade.uniforms.get('exposure')!.value = fixedExposure;
      g.pipeline.bloom.luminanceMaterial.threshold = 5.0 / fixedExposure;
    }
    try { return render(...args); }
    finally {
      shared.uTime.value = oldTime;
      for (const {light, visible} of mutedLights) light.visible = visible;
    }
  }) as typeof render;

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:10000;background:rgba(12,19,24,.88);color:#eee;padding:10px 14px;font:12px/1.5 system-ui;border:1px solid #87949b;pointer-events:auto';
  panel.innerHTML = `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <strong>Lighting review</strong>
    <label>Hour <input aria-label="Hour" type="number" min="0" max="23.99" step="0.05" value="9" style="width:65px"></label>
    <label>View <select aria-label="View"><option value="deck">Deck</option><option value="harbour">Harbour</option><option value="sun">Toward sun</option><option value="moon">Toward moon</option><option value="occlusion">Moon behind sail</option></select></label>
    <label>Moon phase <input aria-label="Moon phase" type="number" min="0" max="1" step="0.01" value="0.43" style="width:65px"></label>
    <label>Quality <select aria-label="Quality"><option>low</option><option>medium</option><option>high</option><option>ultra</option></select></label>
    <label><input aria-label="Raised sail" type="checkbox"> Raised sail</label>
    <label><input aria-label="Live simulation" type="checkbox"> Live simulation</label>
    <label><input aria-label="Fixed clouds" type="checkbox" checked> Fixed clouds</label>
    <label><input aria-label="Forced-current reference" type="checkbox"> Forced-current reference</label>
    <label>Sky shadow coupling <select aria-label="Sky shadow coupling"><option value="legacy1">legacy1</option><option value="coherent0">coherent0</option></select></label>
    <label>Lighting mode <select aria-label="Lighting mode"><option value="combined">Combined</option><option value="direct-only">Direct only</option><option value="environment-only">Environment only</option></select></label>
    <label>Fixed exposure <input aria-label="Fixed exposure" type="number" min="0.05" max="8" step="0.05" placeholder="auto" style="width:65px"></label>
    <label><input aria-label="Staged captures" type="checkbox"> Staged captures</label>
    <label><input aria-label="Profile environment GPU" type="checkbox"> Profile environment GPU</label>
    <label><input aria-label="Neutral calibration fixtures" type="checkbox"> Neutral fixtures</label>
    <button type="button" data-apply>Apply scene</button><button type="button" data-reset>Reset measurements</button>
    <button type="button" data-benchmark>Run 60-second benchmark</button><button type="button" data-download>Download measurements</button><button type="button" data-screenshot title="Hide review controls; press H to restore">Canvas only</button>
    <button type="button" data-read-hdr>Read neutral HDR</button><button type="button" data-context-restore>Test context restore</button><button type="button" data-fast-forward>Test suppressed fast-forward</button>
    </div><output id="lighting-review-metrics" style="display:block;margin-top:5px"></output>`;
  document.body.appendChild(panel);
  const hour = panel.querySelector<HTMLInputElement>('[aria-label="Hour"]')!;
  const view = panel.querySelector<HTMLSelectElement>('[aria-label="View"]')!;
  const phase = panel.querySelector<HTMLInputElement>('[aria-label="Moon phase"]')!;
  const quality = panel.querySelector<HTMLSelectElement>('[aria-label="Quality"]')!;
  const metrics = panel.querySelector<HTMLOutputElement>('output')!;
  const liveToggle = panel.querySelector<HTMLInputElement>('[aria-label="Live simulation"]')!;
  const forced = panel.querySelector<HTMLInputElement>('[aria-label="Forced-current reference"]')!;
  const shadowCoupling = panel.querySelector<HTMLSelectElement>('[aria-label="Sky shadow coupling"]')!;
  const staged = panel.querySelector<HTMLInputElement>('[aria-label="Staged captures"]')!;
  const fixtureToggle = panel.querySelector<HTMLInputElement>('[aria-label="Neutral calibration fixtures"]')!;
  const profileToggle = panel.querySelector<HTMLInputElement>('[aria-label="Profile environment GPU"]')!;
  const benchmarkButton = panel.querySelector<HTMLButtonElement>('[data-benchmark]')!;
  const lightingMode = panel.querySelector<HTMLSelectElement>('[aria-label="Lighting mode"]')!;
  const fixedExposureInput = panel.querySelector<HTMLInputElement>('[aria-label="Fixed exposure"]')!;
  const readHdrButton = panel.querySelector<HTMLButtonElement>('[data-read-hdr]')!;
  const contextButton = panel.querySelector<HTMLButtonElement>('[data-context-restore]')!;
  const fastForwardButton = panel.querySelector<HTMLButtonElement>('[data-fast-forward]')!;
  const fixtures = createLightingFixtures(g.scene, g.camera);
  const sceneLighting = g.scene as THREE.Scene & { environmentIntensity?: number };
  const originalEnvironmentIntensity = sceneLighting.environmentIntensity ?? 1;
  const originalSkyLightVisible = g.sky.light.visible;
  const originalHemiVisible = g.sky.hemi.visible;
  const originalHemiIntensity = g.sky.hemi.intensity;
  const fogEnvironmentScale = (shared as unknown as { uFogEnvScale?: { value: number } }).uFogEnvScale;
  const originalFogEnvironmentScale = fogEnvironmentScale?.value ?? 1;
  let activeLightingMode: 'combined' | 'direct-only' | 'environment-only' = 'combined';
  let fixedExposure: number | null = null;
  const applyLightingMode = () => {
    activeLightingMode = lightingMode.value as typeof activeLightingMode;
    sceneLighting.environmentIntensity = activeLightingMode === 'direct-only' ? 0 : originalEnvironmentIntensity;
    g.sky.light.visible = activeLightingMode === 'environment-only' ? false : originalSkyLightVisible;
    g.sky.hemi.visible = activeLightingMode === 'direct-only' ? false : originalHemiVisible;
    g.sky.hemi.intensity = originalHemiIntensity;
    if (fogEnvironmentScale) fogEnvironmentScale.value = activeLightingMode === 'direct-only' ? 0 : originalFogEnvironmentScale;
  };
  const skyControls = g.sky as unknown as { forceCurrent?: boolean; stagedCaptures?: boolean };
  const skyShadowUniform = (shared as unknown as { uSkyShadowCoupling?: { value: number } }).uSkyShadowCoupling;
  forced.disabled = !('forceCurrent' in skyControls);
  staged.disabled = !('stagedCaptures' in skyControls);
  shadowCoupling.disabled = !skyShadowUniform;
  const initialYaw = g.player.yaw, initialPitch = g.player.pitch;
  if (fixture) {
    g.camera.position.fromArray(fixture.camera.slice(0, 3));
    g.camera.quaternion.fromArray(fixture.camera.slice(3));
    g.camera.quaternion.normalize();
    g.camera.updateMatrixWorld();
  }
  const deckOrigin = g.camera.position.clone();
  const deckRotation = g.camera.quaternion.clone();
  const playerUpdate = g.player.update.bind(g.player);
  g.player.update = (...args: Parameters<typeof playerUpdate>) => {
    if (!g.paused && !benchmarkRunning && !fastForwardCameraHold) playerUpdate(...args);
  };
  quality.value = params.get('q') ?? 'ultra';
  hour.value = params.get('hour') ?? '9';
  phase.value = params.get('phase') ?? '0.43';
  view.value = params.get('view') ?? 'deck';
  lightingMode.value = params.get('lightingMode') ?? 'combined';
  fixedExposureInput.value = params.get('exposure') ?? '';
  const initialExposure = Number(fixedExposureInput.value);
  fixedExposure = fixedExposureInput.value.trim() && Number.isFinite(initialExposure)
    ? Math.max(0.05, Math.min(8, initialExposure)) : null;
  fixedExposureInput.value = fixedExposure === null ? '' : String(fixedExposure);
  forced.checked = params.get('forced') === '1';
  shadowCoupling.value = params.get('shadow') ?? (skyShadowUniform?.value === 0 ? 'coherent0' : 'legacy1');
  staged.checked = params.has('staged') ? params.get('staged') === '1' : skyControls.stagedCaptures ?? false;
  const measurements: Record<string, unknown>[] = [];
  let lastBenchmarkResult: Record<string, unknown> | null = null;
  let benchmarkInitialScene: Record<string, unknown> | null = null;
  const benchmarkState = document.createElement('script');
  benchmarkState.type = 'application/json';
  benchmarkState.id = 'lighting-review-benchmark';
  document.body.appendChild(benchmarkState);
  const rendererResources = () => {
    const programs = g.pipeline.renderer.info.programs as unknown as Array<{
      cacheKey?: string; id?: number; usedTimes?: number;
    }> | null;
    return {
      textures:g.pipeline.renderer.info.memory.textures,
      geometries:g.pipeline.renderer.info.memory.geometries,
      programs:programs?.length ?? null,
      ...(programKeysRequested ? {
        programKeys:programs?.map(program => ({
          cacheKey:program.cacheKey ?? null,
          id:program.id ?? null,
          usedTimes:program.usedTimes ?? null,
        })).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)) ?? null,
      } : {}),
    };
  };
  const benchmarkScene = () => ({
    hours:g.clock.hours, phase:g.clock.moonPhase, shipTime:g.ship.time,
    clockTimeScale:g.clock.timeScale, paused:g.paused,
    camera:g.camera.position.toArray(), cameraQuaternion:g.camera.quaternion.toArray(),
    shipPosition:g.ship.pos.toArray(), cloudWind:cloudWind.toArray(), cloudCoverage:g.clouds.coverage,
    captures:(g.sky as unknown as {environmentTelemetry?: {captures:number}}).environmentTelemetry?.captures ?? bakeCount,
    quality:quality.value, scale:g.pipeline.renderScale, lightingMode:activeLightingMode,
    singleEnvShaderMode:singleEnvRequested ? 'enabled-scene-materials-only' : 'disabled',
    singleEnvMaterialCount, singleEnvConditionCount,
    rendererResources:rendererResources(),
  });
  let benchmarkStartedAtIso = '';
  let forceAfterCloudUpdate = false;
  let profilerStartedAt = 0;
  const environmentProfiler = (g.sky as unknown as { environmentProfiler?: {
    enabled: boolean; available: boolean; samples: { stage: string; ms: number; at: number }[]; reset?: () => void;
  } }).environmentProfiler;
  const wholeFrameGpuSamples = () => (g.pipeline as unknown as { gpuSamples?: number[] }).gpuSamples ?? null;
  const resetWholeFrameGpuSamples = (limit = 600) => {
    const pipeline = g.pipeline as unknown as { resetGpuSamples?: (limit?: number) => void; gpuSamples?: number[] };
    if (pipeline.resetGpuSamples) pipeline.resetGpuSamples(limit);
    else if (pipeline.gpuSamples) pipeline.gpuSamples.length = 0;
  };
  const renderer = g.pipeline.renderer;
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const debugRendererInfo = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const deviceMetadata = {
    userAgent:navigator.userAgent, platform:navigator.platform, devicePixelRatio,
    webglVersion:renderer.capabilities.isWebGL2 ? 2 : 1,
    vendor:debugRendererInfo ? gl.getParameter(debugRendererInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer:debugRendererInfo ? gl.getParameter(debugRendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxCubeMapSize:gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize:gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxTextures:renderer.capabilities.maxTextures,
    maxTextureUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxSamples:gl.getParameter(gl.MAX_SAMPLES),
    drawingBuffer:(() => { const size = renderer.getDrawingBufferSize(new THREE.Vector2()); return [size.x, size.y]; })(),
    canvasPixels:[renderer.domElement.width, renderer.domElement.height],
    timerQueryAvailable:!!gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    halfFloatColorBufferAvailable:!!gl.getExtension('EXT_color_buffer_float'),
  };
  const forceEnvironment = () => {
    const sky = g.sky as unknown as { forceEnvironment?: () => void };
    if (sky.forceEnvironment) sky.forceEnvironment();
    else forceAfterCloudUpdate = true;
  };
  let contextTestStatus = 'idle';
  let controlTest: 'context-restore' | 'fast-forward' | null = null;
  let fastForwardResult: Record<string, unknown> | null = null;
  let fastForwardStartedAt = 0;
  const canvas = renderer.domElement;
  const contextLossExtension = gl.getExtension('WEBGL_lose_context');
  const updateTestButtonState = () => {
    contextButton.disabled = !contextLossExtension || controlTest !== null || benchmarkRunning;
    fastForwardButton.disabled = controlTest !== null || benchmarkRunning;
  };
  updateTestButtonState();
  canvas.addEventListener('webglcontextlost', () => { contextTestStatus = 'context lost; restore pending'; });
  canvas.addEventListener('webglcontextrestored', () => {
    contextTestStatus = 'context restored';
    if (controlTest === 'context-restore') controlTest = null;
    updateTestButtonState();
  });
  contextButton.addEventListener('click', () => {
    if (!contextLossExtension) { contextTestStatus = 'unsupported: WEBGL_lose_context unavailable'; return; }
    if (benchmarkRunning || controlTest !== null) { contextTestStatus = `blocked: ${benchmarkRunning ? 'benchmark' : controlTest} active`; return; }
    controlTest = 'context-restore'; updateTestButtonState();
    contextTestStatus = 'loss requested';
    renderer.forceContextLoss();
    window.setTimeout(() => {
      contextTestStatus = 'restore requested';
      renderer.forceContextRestore();
    }, 500);
    window.setTimeout(() => {
      if (controlTest !== 'context-restore') return;
      controlTest = null; contextTestStatus = 'restore timeout'; updateTestButtonState();
    }, 10000);
  });
  const environmentCounts = () => {
    const telemetry = (g.sky as unknown as { environmentTelemetry?: { generation?: number; captures?: number } }).environmentTelemetry;
    return { generation:telemetry?.generation ?? null, captures:telemetry?.captures ?? bakeCount };
  };
  fastForwardButton.addEventListener('click', () => {
    if (benchmarkRunning || controlTest !== null) {
      fastForwardResult = { status:`blocked: ${benchmarkRunning ? 'benchmark' : controlTest} active` };
      return;
    }
    const fastForward = (g as unknown as { fastForward?: (seconds: number, step?: number) => void }).fastForward;
    if (!fastForward) { fastForwardResult = { status:'unsupported: Game.fastForward API unavailable' }; return; }
    controlTest = 'fast-forward'; updateTestButtonState();
    const before = environmentCounts();
    const oldPaused = g.paused, oldTimeScale = g.clock.timeScale, oldCinematic = g.cinematic;
    const durationSeconds = 5, testTimeScale = 480;
    fastForwardResult = { status:'running', before, durationSeconds, timeScale:testTimeScale,
      api:'Game.fastForward(seconds, 1/60)', capturedAt:new Date().toISOString() };
    fastForwardStartedAt = performance.now();
    fastForwardCameraHold = true; fastForwardRunning = true;
    g.cinematic = true; g.clock.timeScale = testTimeScale;
    let failed = false;
    let failure: unknown;
    try { fastForward.call(g, durationSeconds, 1 / 60); }
    catch (error) { failed = true; failure = error; }
    finally {
      g.paused = oldPaused; g.cinematic = oldCinematic; g.clock.timeScale = oldTimeScale;
      fastForwardCameraHold = false; fastForwardRunning = false;
    }
    if (failed) {
      fastForwardResult = { status:'error', message:failure instanceof Error ? failure.message : String(failure),
        before, durationSeconds, api:'Game.fastForward(seconds, 1/60)' };
      controlTest = null; updateTestButtonState();
      return;
    }
    const afterSuppressed = environmentCounts();
    fastForwardResult = { status:'awaiting-reconciliation', before, afterSuppressed, durationSeconds,
      timeScale:testTimeScale, api:'Game.fastForward(seconds, 1/60)', elapsedMs:performance.now()-fastForwardStartedAt,
      forcedReconcileQueued:typeof (g.sky as unknown as { forceEnvironment?: unknown }).forceEnvironment === 'function',
      capturedAt:new Date().toISOString() };
    try { forceEnvironment(); }
    catch (error) {
      fastForwardResult = { ...fastForwardResult, status:'error', stage:'force-reconcile',
        message:error instanceof Error ? error.message : String(error) };
      controlTest = null; updateTestButtonState();
    }
  });
  const readbackState: { status: string; stages: Record<string, unknown>; accuracyLimits: Record<string, unknown> } = {
    status:'idle', stages:{}, accuracyLimits:{
      sample:'single pixel at the projected fixture center; not a surface-area average',
      precision:'HalfFloatType targets are decoded from binary16; target and quantization precision are reported per stage',
      preGrade:'scene and cloud-composited buffers are linear HDR when the composer target is HalfFloatType',
      postGrade:'post-grade sample is after tone mapping and before final display encoding; it is not scene-linear radiance',
      bounds:'projected sphere bounds and center-pixel bounds are checked; occlusion by other geometry is not tested',
      readback:'one-shot synchronous GPU readback can stall the review frame; disabled unless requested',
    },
  };
  let readbackPending = false;
  let lastFixtureReadback: Record<string, unknown> | null = null;
  const projectedSample = (point: ReturnType<typeof fixtures.getSamplePoints>[number], target: THREE.WebGLRenderTarget) => {
    g.camera.updateWorldMatrix(true, false);
    const ndc = new THREE.Vector3(...point.position).project(g.camera);
    const x = Math.floor((ndc.x * 0.5 + 0.5) * target.width);
    const y = Math.floor((ndc.y * 0.5 + 0.5) * target.height);
    const local = new THREE.Vector3(...point.position).applyMatrix4(g.camera.matrixWorldInverse);
    const depth = -local.z;
    const radiusPx = depth > 0 ? point.radius * target.height / (2 * depth * Math.tan(THREE.MathUtils.degToRad(g.camera.fov) / 2)) : 0;
    const bounds = { left:x-radiusPx, right:x+radiusPx, bottom:y-radiusPx, top:y+radiusPx };
    const centerInBounds = x >= 0 && y >= 0 && x < target.width && y < target.height;
    const sphereIntersectsTarget = bounds.right >= 0 && bounds.left < target.width && bounds.top >= 0 && bounds.bottom < target.height;
    return { x, y, ndc:ndc.toArray(), depth, radiusPx, bounds, centerInBounds, sphereIntersectsTarget };
  };
  const readLinearPixel = (target: THREE.WebGLRenderTarget, x: number, y: number) => {
    const type = target.texture.type;
    if (type === THREE.HalfFloatType) {
      const sample = new Uint16Array(4);
      renderer.readRenderTargetPixels(target, x, y, 1, 1, sample);
      return { rgba:Array.from(sample, value => THREE.DataUtils.fromHalfFloat(value)), encoding:'binary16-decoded', linear:type === THREE.HalfFloatType };
    }
    if (type === THREE.FloatType) {
      const sample = new Float32Array(4);
      renderer.readRenderTargetPixels(target, x, y, 1, 1, sample);
      return { rgba:Array.from(sample), encoding:'float32', linear:true };
    }
    if (type === THREE.UnsignedByteType) {
      const sample = new Uint8Array(4);
      renderer.readRenderTargetPixels(target, x, y, 1, 1, sample);
      return { rgba:Array.from(sample, value => value / 255), encoding:'unorm8', linear:target.texture.colorSpace === THREE.NoColorSpace };
    }
    throw new Error(`Unsupported composer readback texture type ${type}`);
  };
  const captureFixtureStage = (stage: string, target: THREE.WebGLRenderTarget) => {
    if (!readbackPending) return;
    try {
      const samples = fixtures.getSamplePoints().map(point => {
        const projected = projectedSample(point, target);
        const rgba = projected.centerInBounds ? readLinearPixel(target, projected.x, projected.y) : null;
        return { name:point.name, label:point.label, roughness:point.roughness, worldPosition:point.position,
          ...projected, rgba };
      });
      readbackState.stages[stage] = { width:target.width, height:target.height, format:target.texture.format,
        type:target.texture.type, colorSpace:target.texture.colorSpace, samples };
      if (stage === 'postGradeToneMapped') {
        readbackPending = false;
        readbackState.status = 'complete';
        lastFixtureReadback = { capturedAt:new Date().toISOString(), hours:g.clock.hours, phase:g.clock.moonPhase,
          lightingMode:activeLightingMode, fixedExposure, camera:g.camera.position.toArray(),
          cloudCoverage:g.clouds.coverage, cloudWind:cloudWind.toArray(), stages:readbackState.stages,
          accuracyLimits:readbackState.accuracyLimits };
      }
    } catch (error) {
      readbackPending = false;
      readbackState.status = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const composer = g.pipeline.composer as unknown as { passes: Array<{ name?: string; render?: (...args: unknown[]) => void; effects?: unknown[] }> };
  const reviewPasses = composer.passes ?? [];
  const renderScenePass = reviewPasses.find(pass => pass.name === 'RenderPass');
  const cloudCompositePass = reviewPasses.find(pass => pass.name === 'CloudPass');
  const gradePass = reviewPasses.find(pass => pass.effects?.includes(g.pipeline.grade));
  const installPassSampler = (pass: typeof reviewPasses[number] | undefined, stage: string, targetArg: number) => {
    if (!pass?.render) return false;
    const original = pass.render.bind(pass);
    pass.render = (...args: unknown[]) => {
      const result = original(...args);
      const target = args[targetArg] as THREE.WebGLRenderTarget | undefined;
      if (target?.isWebGLRenderTarget) captureFixtureStage(stage, target);
      return result;
    };
    return true;
  };
  // RenderPass writes the scene to outputBuffer; its inputBuffer is the previous empty composer target.
  const sceneStageAvailable = installPassSampler(renderScenePass, 'sceneBeforeClouds', 2);
  const cloudStageAvailable = installPassSampler(cloudCompositePass, 'cloudComposited', 2);
  let preGradeStageAvailable = false;
  let postGradeStageAvailable = false;
  if (gradePass?.render) {
    const original = gradePass.render.bind(gradePass);
    gradePass.render = (...args: unknown[]) => {
      const input = args[1] as THREE.WebGLRenderTarget | undefined;
      if (input?.isWebGLRenderTarget) captureFixtureStage('preGradeHDR', input);
      const result = original(...args);
      const output = args[2] as THREE.WebGLRenderTarget | undefined;
      if (output?.isWebGLRenderTarget) captureFixtureStage('postGradeToneMapped', output);
      return result;
    };
    preGradeStageAvailable = postGradeStageAvailable = true;
  }
  readbackState.accuracyLimits = { ...readbackState.accuracyLimits, sceneStageAvailable,
    cloudStageAvailable, preGradeStageAvailable, postGradeStageAvailable,
    composerBufferType:composer.passes.length ? g.pipeline.composer.inputBuffer.texture.type : null };
  readHdrButton.disabled = !preGradeStageAvailable || !postGradeStageAvailable;
  function setView() {
    if (view.value === 'deck') {
      g.player.mode = 'helm'; g.player.yaw = initialYaw; g.player.pitch = initialPitch;
      g.camera.position.copy(deckOrigin); g.camera.quaternion.copy(deckRotation);
    } else {
      g.player.mode = 'eagle'; g.player.eagleVel.set(0, 0, 0);
      if (view.value === 'harbour') {
        const b = g.harbourLayout.berths[0];
        g.player.eaglePos.set(b.cx + b.nx * 90, 16, b.cz + b.nz * 90);
        g.player.eagleYaw = Math.atan2(b.nx, b.nz);
        g.player.eaglePitch = -0.10;
      } else if (view.value === 'occlusion') {
        const rig = g.ship.design.rig;
        const center = deckOrigin.clone().set(0, rig.yardY - rig.clothTopDrop - rig.height / 2, rig.yardZ + rig.clothOffsetZ);
        g.model.group.localToWorld(center);
        g.player.eaglePos.copy(center).addScaledVector(g.clock.moonDir, -18);
        g.player.eagleYaw = Math.atan2(-g.clock.moonDir.x, -g.clock.moonDir.z);
        g.player.eaglePitch = Math.asin(g.clock.moonDir.y);
        g.ship.sailSet = 1; g.ship.sailTarget = 1; g.ship.sailing.reset();
        panel.querySelector<HTMLInputElement>('[aria-label="Raised sail"]')!.checked = true;
      } else {
        const dir = view.value === 'sun' ? g.clock.sunDir : g.clock.moonDir;
        g.player.eaglePos.copy(deckOrigin).add({x:0,y:6,z:0});
        g.player.eagleYaw = Math.atan2(-dir.x, -dir.z);
        g.player.eaglePitch = 0;
      }
    }
    if (view.value !== 'deck') {
      g.camera.position.copy(g.player.eaglePos);
      g.camera.rotation.set(g.player.eaglePitch, g.player.eagleYaw, 0, 'YXZ');
    }
    g.camera.updateMatrixWorld();
    fixtures.align(g.camera);
    g.clouds.resetHistory();
  }
  function setTime() {
    const h = Number(hour.value), p = Number(phase.value);
    if (!Number.isFinite(h) || !Number.isFinite(p)) return;
    g.clock.hours = Math.max(0, Math.min(23.99, h));
    g.clock.moonPhase = Math.max(0, Math.min(1, p)); g.clock.compute();
    g.sky.updateLighting(0, g.camera, true);
    g.clouds.resetHistory();
    // SkySystem queues this request for the next game frame, after weather and lighting update.
    forceEnvironment();
    if (view.value === 'sun' || view.value === 'moon' || view.value === 'occlusion') setView();
  }
  hour.addEventListener('change', setTime); phase.addEventListener('change', setTime);
  view.addEventListener('change', setView);
  lightingMode.addEventListener('change', applyLightingMode);
  fixedExposureInput.addEventListener('change', () => {
    const raw = fixedExposureInput.value.trim();
    const parsed = Number(raw);
    fixedExposure = raw && Number.isFinite(parsed) ? Math.max(0.05, Math.min(8, parsed)) : null;
    fixedExposureInput.value = fixedExposure === null ? '' : String(fixedExposure);
  });
  const commitFixedExposure = () => {
    const raw = fixedExposureInput.value.trim();
    const parsed = Number(raw);
    fixedExposure = raw && Number.isFinite(parsed) ? Math.max(0.05, Math.min(8, parsed)) : null;
    fixedExposureInput.value = fixedExposure === null ? '' : String(fixedExposure);
  };
  fixedExposureInput.addEventListener('input', commitFixedExposure);
  quality.addEventListener('change', () => {
    const p = new URLSearchParams(location.search);
    p.set('q', quality.value); p.set('hour', hour.value); p.set('phase', phase.value); p.set('view', view.value);
    p.set('lightingMode', lightingMode.value);
    if (fixedExposure !== null) p.set('exposure', String(fixedExposure)); else p.delete('exposure');
    location.href = `${location.pathname}?${p}`;
  });
  panel.querySelector<HTMLInputElement>('[aria-label="Raised sail"]')!.addEventListener('change', e => {
    g.ship.sailSet = (e.target as HTMLInputElement).checked ? 1 : 0;
    g.ship.sailTarget = g.ship.sailSet; g.ship.sailing.reset(); g.clouds.resetHistory();
  });
  panel.querySelector<HTMLInputElement>('[aria-label="Live simulation"]')!.addEventListener('change', e => {
    const live = (e.target as HTMLInputElement).checked;
    reviewLive = live; g.clock.timeScale = live ? 1 : 0;
  });
  panel.querySelector<HTMLInputElement>('[aria-label="Fixed clouds"]')!.addEventListener('change', e => {
    fixedWeather = (e.target as HTMLInputElement).checked;
    if (fixedWeather) cloudWind.set(0, 0);
    g.clouds.resetHistory();
  });
  forced.addEventListener('change', () => {
    const env = g.sky as unknown as { forceCurrent?: boolean };
    if ('forceCurrent' in env) env.forceCurrent = forced.checked;
    forceEnvironment();
  });
  shadowCoupling.addEventListener('change', () => {
    const uniform = skyShadowUniform;
    if (uniform) uniform.value = shadowCoupling.value === 'coherent0' ? 0 : 1;
  });
  staged.addEventListener('change', () => {
    const env = g.sky as unknown as { stagedCaptures?: boolean };
    if ('stagedCaptures' in env) env.stagedCaptures = staged.checked;
  });
  fixtureToggle.addEventListener('change', () => {
    fixtures.setVisible(fixtureToggle.checked);
    fixtures.align(g.camera);
  });
  readHdrButton.addEventListener('click', () => {
    if (!fixtureToggle.checked) {
      fixtureToggle.checked = true;
      fixtures.setVisible(true);
      fixtures.align(g.camera);
    }
    readbackState.status = 'pending: next frame readback';
    readbackState.stages = {};
    lastFixtureReadback = null;
    readbackPending = true;
  });
  panel.querySelector('[data-apply]')!.addEventListener('click', () => { commitFixedExposure(); setTime(); setView(); });
  panel.querySelector('[data-reset]')!.addEventListener('click', () => {
    bakeCount = 0; maxBakeCpuMs = 0; presentTimes.length = 0; presentTimesLimit = 240;
    measurements.length = 0; lastBenchmarkResult = null; resetWholeFrameGpuSamples(600);
    environmentProfiler?.reset?.(); profilerStartedAt = performance.now();
  });
  profileToggle.disabled = !environmentProfiler?.available;
  profileToggle.addEventListener('change', () => {
    if (!environmentProfiler?.available) return;
    environmentProfiler.enabled = profileToggle.checked;
    environmentProfiler.reset?.();
    resetWholeFrameGpuSamples(600);
    profilerStartedAt = performance.now();
  });
  const finishBenchmark = () => {
    if (!benchmarkRunning || !benchmarkPreviousState) return;
    const elapsedMs = performance.now() - benchmarkStartedAt;
    lastBenchmarkResult = {
      initialScene:benchmarkInitialScene, finalScene:benchmarkScene(),
      startedAt:benchmarkStartedAtIso, finishedAt:new Date().toISOString(), elapsedSeconds:elapsedMs / 1000,
      simulationSeconds:benchmarkSimulationSeconds,
      expectedSimulationSeconds:elapsedMs / 1000,
      simulationWallRatio:benchmarkSimulationSeconds / Math.max(elapsedMs / 1000, 0.001),
      clockUpdateCount:benchmarkClockUpdates,
      presentIntervalsMs:presentTimes.slice(1).map((time, index) => time - presentTimes[index]),
      wholeFrameGpuSamples:[...(wholeFrameGpuSamples() ?? [])],
      wholeFrameGpuSamplesValid:!environmentProfiler?.enabled,
      environmentStageSamples:environmentProfiler?.samples.map(sample => ({ ...sample })) ?? [],
      gpuTimingMode:environmentProfiler?.enabled ? 'environment-stages-only' : 'whole-frame',
      device:deviceMetadata,
    };
    benchmarkState.textContent = JSON.stringify(lastBenchmarkResult);
    benchmarkRunning = false;
    reviewLive = !benchmarkPreviousState.paused;
    g.clock.timeScale = benchmarkPreviousState.timeScale;
    liveToggle.checked = !g.paused;
    g.cinematic = benchmarkPreviousState.cinematic;
    fixedWeather = benchmarkPreviousState.fixedWeather;
    panel.querySelector<HTMLInputElement>('[aria-label="Fixed clouds"]')!.checked = fixedWeather;
    g.clouds.resetHistory();
    if (environmentProfiler?.available) environmentProfiler.enabled = profileToggle.checked;
    profileToggle.disabled = !environmentProfiler?.available;
    benchmarkButton.textContent = 'Run 60-second benchmark';
    benchmarkPreviousState = null;
    updateTestButtonState();
  };
  benchmarkButton.addEventListener('click', () => {
    if (benchmarkRunning) { finishBenchmark(); return; }
    if (controlTest !== null) { benchmarkState.textContent = JSON.stringify({ status:`blocked: ${controlTest} test active` }); return; }
    benchmarkPreviousState = { paused:g.paused, timeScale:g.clock.timeScale, cinematic:g.cinematic, fixedWeather };
    benchmarkRunning = true;
    lastBenchmarkResult = null;
    measurements.length = 0; presentTimes.length = 0; presentTimesLimit = 7200; resetWholeFrameGpuSamples(7200);
    liveToggle.checked = true;
    g.clock.timeScale = 1;
    g.cinematic = true;
    if (fixture) {
      g.ship.pos.fromArray(fixture.ship.slice(0, 3)); g.ship.prevPos.copy(g.ship.pos);
      g.ship.quat.fromArray(fixture.ship.slice(3)).normalize(); g.ship.prevQuat.copy(g.ship.quat);
      g.ship.vel.set(0, 0, 0); g.ship.angVel.set(0, 0, 0);
    }
    g.ship.time = 0;
    shared.uTime.value = 0;
    cloudWind.set(0, 0);
    fixedWeather = false;
    panel.querySelector<HTMLInputElement>('[aria-label="Fixed clouds"]')!.checked = false;
    g.clouds.resetHistory();
    if (environmentProfiler?.available) {
      environmentProfiler.enabled = profileToggle.checked;
      environmentProfiler.reset?.();
      resetWholeFrameGpuSamples(7200);
      profilerStartedAt = benchmarkStartedAt;
    }
    profileToggle.disabled = true;
    benchmarkSimulationSeconds = 0;
    benchmarkClockUpdates = 0;
    benchmarkStartedAt = performance.now();
    benchmarkStartedAtIso = new Date().toISOString();
    benchmarkInitialScene = benchmarkScene();
    benchmarkState.textContent = '';
    benchmarkButton.textContent = 'Stop benchmark';
    updateTestButtonState();
  });
  panel.querySelector('[data-download]')!.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), device:deviceMetadata,
      benchmark:lastBenchmarkResult, fastForward:fastForwardResult, contextTestStatus,
      fixtureReadback:lastFixtureReadback, fixtureReadbackStatus:readbackState.status,
      fixtureReadbackAccuracy:readbackState.accuracyLimits, samples: measurements }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'lighting-review-measurements.json'; link.click(); URL.revokeObjectURL(url);
  });
  panel.querySelector('[data-screenshot]')!.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('keydown', e => {
    if (e.key.toLowerCase() === 'h' && panel.style.display === 'none') panel.style.display = '';
  });
  setTime(); setView(); applyLightingMode();
  // Apply opt-in environment controls once they exist. Unsupported controls remain visible in the
  // telemetry as unavailable rather than silently pretending to have changed renderer behavior.
  forced.dispatchEvent(new Event('change'));
  shadowCoupling.dispatchEvent(new Event('change'));
  staged.dispatchEvent(new Event('change'));
  const state = document.createElement('script'); state.type = 'application/json';
  state.id = 'lighting-review-state'; document.body.appendChild(state);
  const timer = setInterval(() => {
    if (!g.running) { clearInterval(timer); return; }
    if (benchmarkRunning && performance.now() - benchmarkStartedAt >= 60000) finishBenchmark();
    if (fastForwardResult?.status === 'awaiting-reconciliation') {
      const afterSuppressed = fastForwardResult.afterSuppressed as { generation: number | null; captures: number };
      const current = environmentCounts();
      const reconciled = current.captures > afterSuppressed.captures
        && (afterSuppressed.generation === null || current.generation === null || current.generation > afterSuppressed.generation);
      if (reconciled) {
        fastForwardResult = { ...fastForwardResult, status:'reconciled', reconciled:current,
          elapsedToReconcileMs:performance.now()-fastForwardStartedAt };
        controlTest = null; updateTestButtonState();
      } else if (performance.now() - fastForwardStartedAt > 10000) {
        fastForwardResult = { ...fastForwardResult, status:'reconciliation-timeout', current,
          elapsedToReconcileMs:performance.now()-fastForwardStartedAt };
        controlTest = null; updateTestButtonState();
      }
    }
    if (!g.paused && fixtureToggle.checked) fixtures.align(g.camera);
    const sunAlt = Math.asin(g.clock.sunDir.y) * 180 / Math.PI;
    const moonAlt = Math.asin(g.clock.moonDir.y) * 180 / Math.PI;
    const intervals = presentTimes.slice(1).map((t, i) => t - presentTimes[i]);
    const sorted = [...intervals].sort((a, b) => a-b);
    const frameMeanMs = intervals.reduce((a,b) => a+b, 0) / Math.max(intervals.length,1);
    const frameP95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const skyTelemetry = g.sky as unknown as { lightingState?: unknown; environmentTelemetry?: Record<string, unknown>; forceCurrent?: boolean; stagedCaptures?: boolean };
    const environmentTelemetry = skyTelemetry.environmentTelemetry ?? null;
    const env = environmentTelemetry as { generation?: unknown; ageMs?: unknown; previousAgeMs?: unknown; nextAgeMs?: unknown;
      dirtyReason?: unknown; captureMs?: unknown; filterMs?: unknown; blend?: unknown; appliedBlend?: unknown;
      stagedLatencyMs?: unknown; captures?: unknown; stagedFace?: unknown } | null;
    const stagedFace = typeof env?.stagedFace === 'number' ? env.stagedFace : -1;
    const blendAlpha = typeof env?.blend === 'number' ? env.blend : 1;
    const cacheStatus = !environmentTelemetry ? 'unavailable'
      : stagedFace >= 0 ? `staging face ${stagedFace + 1}/6`
        : blendAlpha < 1 ? `blending ${(blendAlpha * 100).toFixed(0)}%` : 'ready';
    const gpuSamples = wholeFrameGpuSamples();
    const gpuStageSamples = environmentProfiler?.samples ?? [];
    const stageGroups = new Map<string, number[]>();
    for (const sample of gpuStageSamples) {
      const group = stageGroups.get(sample.stage) ?? [];
      group.push(sample.ms); stageGroups.set(sample.stage, group);
    }
    const gpuStageSummary = Object.fromEntries([...stageGroups].map(([stage, samples]) => [stage, {
      sampleCount:samples.length, meanMs:samples.reduce((sum, value) => sum + value, 0) / samples.length,
      minMs:Math.min(...samples), maxMs:Math.max(...samples),
    }]));
    const gpuTimingLabel = environmentProfiler?.enabled
      ? `environment GPU ${JSON.stringify(gpuStageSummary)} · ${benchmarkRunning ? Math.min(60, (performance.now() - benchmarkStartedAt) / 1000).toFixed(1) : (profilerStartedAt ? ((performance.now() - profilerStartedAt) / 1000).toFixed(1) : '0.0')} s`
      : `whole-frame GPU EMA ${g.pipeline.gpuMs.toFixed(1)} ms${gpuSamples ? ` · ${gpuSamples.length} samples` : ''}`;
    const sortedGpuSamples = gpuSamples ? [...gpuSamples].sort((a, b) => a - b) : [];
    const percentile = (p: number) => sortedGpuSamples.length
      ? sortedGpuSamples[Math.min(sortedGpuSamples.length - 1, Math.floor((sortedGpuSamples.length - 1) * p))]
      : null;
    const snapshot = { hours:g.clock.hours, phase:g.clock.moonPhase, sunAlt, moonAlt,
      night:g.sky.night, exposure:g.sky.exposure, direct:shared.uSunColor.value.toArray(),
      frameMeanMs, frameP95Ms, presentedFrames:intervals.length, gpuEmaMs:g.pipeline.gpuMs, scale:g.pipeline.renderScale, quality:quality.value,
      viewport:[innerWidth,innerHeight], camera:g.camera.position.toArray(),
      cameraQuaternion:g.camera.quaternion.toArray(), shaderTime:shared.uTime.value, shipTime:g.ship.time,
      shipPose:{position:g.ship.pos.toArray(),quaternion:g.ship.quat.toArray(),velocity:g.ship.vel.toArray(),angularVelocity:g.ship.angVel.toArray()},
      fixtureVisible:fixtureToggle.checked, fixturePose:fixtures.getWorldPose(),
      cloudWind:cloudWind.toArray(), lightingState:skyTelemetry.lightingState ?? null,
      environment:environmentTelemetry, gpuSamples,
      gpuTimingMode:environmentProfiler?.enabled ? 'environment-stages-only' : 'whole-frame',
      wholeFrameGpuSamplesValid:!environmentProfiler?.enabled,
      gpuStageSamples, gpuStageSummary,
      measurementElapsedSeconds:benchmarkRunning ? Math.min(60, (performance.now() - benchmarkStartedAt) / 1000)
        : Number(lastBenchmarkResult?.elapsedSeconds ?? (environmentProfiler?.enabled && profilerStartedAt ? (performance.now() - profilerStartedAt) / 1000 : 0)),
      benchmarkRunning,
      benchmarkResult: lastBenchmarkResult ? { elapsedSeconds:lastBenchmarkResult.elapsedSeconds,
        presentIntervalCount:Array.isArray(lastBenchmarkResult.presentIntervalsMs) ? lastBenchmarkResult.presentIntervalsMs.length : 0,
        wholeFrameGpuSampleCount:Array.isArray(lastBenchmarkResult.wholeFrameGpuSamples) ? lastBenchmarkResult.wholeFrameGpuSamples.length : 0,
        environmentStageSampleCount:Array.isArray(lastBenchmarkResult.environmentStageSamples) ? lastBenchmarkResult.environmentStageSamples.length : 0,
        gpuTimingMode:lastBenchmarkResult.gpuTimingMode } : null,
      lightingMode:activeLightingMode, fixedExposure,
      singleEnvShaderMode:singleEnvRequested ? 'enabled-scene-materials-only' : 'disabled',
      singleEnvMaterialCount, singleEnvConditionCount,
      rendererResources:rendererResources(),
      contextTestStatus, fastForwardResult,
      fixtureReadbackStatus:readbackState.status, fixtureReadback: lastFixtureReadback,
      fixtureReadbackAccuracy:readbackState.accuracyLimits,
      device:deviceMetadata,
      environmentStatus:cacheStatus,
      gpuFrameSummaryMs:{sampleCount:sortedGpuSamples.length,median:percentile(0.5),p95:percentile(0.95),p99:percentile(0.99)},
      reviewControls:{forcedCurrent:forced.checked, shadowCoupling:shadowCoupling.value, stagedCaptures:staged.checked,
        forcedCurrentAvailable:'forceCurrent' in skyTelemetry,
        shadowCouplingAvailable:!!skyShadowUniform,
        stagedCapturesAvailable:'stagedCaptures' in skyTelemetry},
      view:view.value, raisedSail:g.ship.sailSet, reversedDepth:g.pipeline.reversedDepth, frozen:g.paused, fixedClouds:fixedWeather, cloudCoverage:g.clouds.coverage,
      bakeCount, lastBakeCpuMs, maxBakeCpuMs };
    measurements.push(snapshot);
    if (measurements.length > 2000) measurements.shift();
    state.textContent = JSON.stringify(snapshot);
    const reasons = env?.dirtyReason ? [env.dirtyReason] : [];
    const stageCounters = { captures:env?.captures ?? bakeCount, captureCpuMs:env?.captureMs ?? lastBakeCpuMs,
      filterCpuMs:env?.filterMs ?? null, stagedFace:env?.stagedFace ?? -1, stagedLatencyMs:env?.stagedLatencyMs ?? null,
      blend:env?.blend ?? null, appliedBlend:env?.appliedBlend ?? null,
      previousAgeMs:env?.previousAgeMs ?? null, nextAgeMs:env?.nextAgeMs ?? null };
    metrics.textContent = `${g.clock.timeString} · sun ${sunAlt.toFixed(1)}° · moon ${moonAlt.toFixed(1)}° · mode ${activeLightingMode} · exposure ${fixedExposure?.toFixed(2) ?? `auto ${g.sky.exposure.toFixed(2)}`} · night ${g.sky.night.toFixed(2)} · ${gpuTimingLabel} · scale ${g.pipeline.renderScale.toFixed(2)} · frame ${frameMeanMs.toFixed(1)} ms / p95 ${frameP95Ms.toFixed(1)} ms · whole-frame GPU p50/p95/p99 ${percentile(0.5)?.toFixed(1) ?? 'n/a'}/${percentile(0.95)?.toFixed(1) ?? 'n/a'}/${percentile(0.99)?.toFixed(1) ?? 'n/a'} ms${environmentProfiler?.enabled ? ' (excluded during stage profiling)' : ''} · generation ${String(env?.generation ?? 'n/a')} · cache ${cacheStatus} · age ${String(env?.ageMs ?? 'n/a')} ms · last reason ${JSON.stringify(reasons)} · stages ${JSON.stringify(stageCounters)} · readback ${readbackState.status} · context ${contextTestStatus} · fast-forward ${String(fastForwardResult?.status ?? 'idle')} · ${benchmarkRunning ? 'benchmark running' : g.paused ? 'simulation frozen' : 'live simulation'}`;
  }, 500);
}
