import * as THREE from 'three';
import type { EnvironmentInput } from './environmentPolicy';
import { environmentAgeLimitMs, environmentDirtyReason } from './environmentPolicy';
import type { GpuProfiler } from './gpuProfiler';

export interface EnvironmentBundle {
  readonly raw: THREE.WebGLCubeRenderTarget;
  readonly clear: THREE.WebGLCubeRenderTarget;
  pmrem: THREE.WebGLRenderTarget | null;
}

export interface TargetAllocationEstimate {
  width: number;
  height: number;
  faces: number;
  mipLevels: number;
  format: string;
  formatValue: number;
  type: string;
  typeValue: number;
  bytesPerPixel: number;
  colorBytes: number;
  depthBytes: number;
  totalBytes: number;
}

export interface BundleAllocationEstimate {
  raw: TargetAllocationEstimate;
  clear: TargetAllocationEstimate;
  pmrem: TargetAllocationEstimate | null;
  totalBytes: number;
}

export interface EnvironmentResourceTelemetry {
  basis: 'source-estimate';
  driverOverhead: 'unknown';
  bundleCount: 2;
  poolReadyCount: number;
  poolReady: boolean;
  bundles: [BundleAllocationEstimate, BundleAllocationEstimate];
  rawTotalBytes: number;
  clearTotalBytes: number;
  pmremTotalBytes: number;
  pairTotalBytes: number;
}

function emptyTargetEstimate(): TargetAllocationEstimate {
  return { width: 0, height: 0, faces: 0, mipLevels: 0, format: 'unknown', formatValue: 0, type: 'unknown', typeValue: 0, bytesPerPixel: 0, colorBytes: 0, depthBytes: 0, totalBytes: 0 };
}

function emptyAllocation(): BundleAllocationEstimate {
  return { raw: emptyTargetEstimate(), clear: emptyTargetEstimate(), pmrem: null, totalBytes: 0 };
}

function componentBytes(type: number): number {
  switch (type) {
    case THREE.UnsignedByteType:
    case THREE.ByteType: return 1;
    case THREE.HalfFloatType:
    case THREE.ShortType:
    case THREE.UnsignedShortType: return 2;
    case THREE.UnsignedInt248Type:
    case THREE.IntType:
    case THREE.UnsignedIntType:
    case THREE.FloatType: return 4;
    default: return 4; // Unknown GPU formats use a conservative four-byte component estimate.
  }
}

function channelCount(format: number): number {
  switch (format) {
    case THREE.RedFormat:
    case THREE.RedIntegerFormat: return 1;
    case THREE.RGFormat:
    case THREE.RGIntegerFormat: return 2;
    case THREE.RGBFormat:
    case THREE.RGBIntegerFormat: return 3;
    case THREE.RGBAFormat:
    case THREE.RGBAIntegerFormat: return 4;
    case THREE.DepthFormat: return 1;
    case THREE.DepthStencilFormat: return 1;
    default: return 4; // Cube and PMREM color targets normally use RGBA.
  }
}

function textureFormatName(format: number): string {
  switch (format) {
    case THREE.RedFormat: return 'RedFormat';
    case THREE.RGFormat: return 'RGFormat';
    case THREE.RGBFormat: return 'RGBFormat';
    case THREE.RGBAFormat: return 'RGBAFormat';
    case THREE.DepthFormat: return 'DepthFormat';
    case THREE.DepthStencilFormat: return 'DepthStencilFormat';
    default: return `format-${format}`;
  }
}

function textureTypeName(type: number): string {
  switch (type) {
    case THREE.UnsignedByteType: return 'UnsignedByteType';
    case THREE.ByteType: return 'ByteType';
    case THREE.HalfFloatType: return 'HalfFloatType';
    case THREE.ShortType: return 'ShortType';
    case THREE.UnsignedShortType: return 'UnsignedShortType';
    case THREE.UnsignedInt248Type: return 'UnsignedInt248Type';
    case THREE.IntType: return 'IntType';
    case THREE.UnsignedIntType: return 'UnsignedIntType';
    case THREE.FloatType: return 'FloatType';
    default: return `type-${type}`;
  }
}

/** Estimate source texture/renderbuffer storage; actual driver allocation and alignment are unknown. */
function estimateTarget(target: THREE.WebGLRenderTarget, cube: boolean): TargetAllocationEstimate {
  const width = target.width;
  const height = target.height;
  const texture = target.texture;
  const mipLevels = texture.generateMipmaps
    ? Math.floor(Math.log2(Math.max(width, height))) + 1
    : Math.max(1, texture.mipmaps?.length ?? 1);
  let texels = width * height;
  if (texture.generateMipmaps) {
    let w = width, h = height;
    for (let level = 1; level < mipLevels; level++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      texels += w * h;
    }
  }
  const faces = cube ? 6 : 1;
  const bytesPerPixel = channelCount(texture.format) * componentBytes(texture.type);
  const colorBytes = texels * faces * bytesPerPixel;
  const depthBytes = target.depthBuffer
    ? width * height * (target.stencilBuffer ? 4 : 2)
    : 0;
  return {
    width, height, faces, mipLevels,
    format: textureFormatName(texture.format), formatValue: texture.format,
    type: textureTypeName(texture.type), typeValue: texture.type, bytesPerPixel,
    colorBytes, depthBytes, totalBytes: colorBytes + depthBytes,
  };
}

export interface EnvironmentTelemetry {
  generation: number;
  ageMs: number;
  previousAgeMs: number;
  nextAgeMs: number;
  dirtyReason: string | null;
  captureMs: number;
  filterMs: number;
  stagedLatencyMs: number;
  appliedBlend: number;
  blendShortened: boolean;
  deadlineMissed: boolean;
  deadlineMisses: number;
  deadlineReason: string | null;
  deadlineReasons: Record<string, number>;
  cancellationCount: number;
  cancellationReasons: Record<string, number>;
  forceCount: number;
  forceReason: string | null;
  forceReasons: Record<string, number>;
  resources: EnvironmentResourceTelemetry;
  blend: number;
  blendDurationMs: number;
  captures: number;
  stagedFace: number;
  stagedCaptures: boolean;
  forceCurrent: boolean;
}

/** Two immutable-to-readers generations with publication only after all radiance products are ready. */
export class SkyEnvironmentCache {
  readonly bundles: [EnvironmentBundle, EnvironmentBundle];
  readonly telemetry: EnvironmentTelemetry = {
    generation: 0, ageMs: Infinity, previousAgeMs: Infinity, nextAgeMs: Infinity, dirtyReason: 'initial', captureMs: 0, filterMs: 0, stagedLatencyMs: 0, appliedBlend: 0, deadlineMissed: false, deadlineMisses: 0,
    blend: 1, blendDurationMs: 0, blendShortened: false, captures: 0, stagedFace: -1, stagedCaptures: false, forceCurrent: false,
    deadlineReason: null, deadlineReasons: {}, cancellationCount: 0, cancellationReasons: {}, forceCount: 0, forceReason: null, forceReasons: {},
    resources: {
      basis: 'source-estimate', driverOverhead: 'unknown', bundleCount: 2, poolReadyCount: 0, poolReady: false,
      bundles: [emptyAllocation(), emptyAllocation()], rawTotalBytes: 0, clearTotalBytes: 0, pmremTotalBytes: 0, pairTotalBytes: 0,
    },
  };
  private readonly cameras: [THREE.CubeCamera, THREE.CubeCamera];
  private readonly clearCameras: [THREE.CubeCamera, THREE.CubeCamera];
  private readonly savedViewport = new THREE.Vector4();
  private readonly savedScissor = new THREE.Vector4();
  private active = 0;
  private next: number | null = null;
  private fade = 1;
  private fadeStartedAt = 0;
  private fadeDurationMs = 200;
  private lastInput: EnvironmentInput | null = null;
  private readonly capturedAt: [number, number] = [-Infinity, -Infinity];
  private pendingReason: string | null = 'initial';
  private forcePending = false;
  private disposed = false;
  private staged: { index: number; input: EnvironmentInput; started: number; captureMs: number } | null = null;
  forceCurrentMode = false;
  stagedCapturesEnabled = false;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    resolution = 256,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly profiler: GpuProfiler | null = null,
  ) {
    const makeRaw = () => new THREE.WebGLCubeRenderTarget(resolution, {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    const makeClear = () => new THREE.WebGLCubeRenderTarget(32, {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    });
    const raw0 = makeRaw(), raw1 = makeRaw(), clear0 = makeClear(), clear1 = makeClear();
    this.bundles = [{ raw: raw0, clear: clear0, pmrem: null }, { raw: raw1, clear: clear1, pmrem: null }];
    this.cameras = [new THREE.CubeCamera(1, 100000, raw0), new THREE.CubeCamera(1, 100000, raw1)];
    this.clearCameras = [new THREE.CubeCamera(1, 100000, clear0), new THREE.CubeCamera(1, 100000, clear1)];
    this.stagedCapturesEnabled = resolution >= 128;
    this.telemetry.stagedCaptures = this.stagedCapturesEnabled;
    this.updateResourceEstimates();
  }

  get current(): EnvironmentBundle { return this.bundles[this.active]; }
  get previous(): EnvironmentBundle { return this.bundles[this.active]; }
  get nextBundle(): EnvironmentBundle { return this.bundles[this.next ?? this.active]; }
  get blend(): number { return this.fade; }
  get isBlending(): boolean { return this.next !== null; }

  request(reason: string) {
    this.pendingReason = reason;
    if (reason.includes('forced') || reason.includes('discontinuity') || reason === 'clock-jump') this.forcePending = true;
  }

  private countReason(counts: Record<string, number>, reason: string) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }

  private cancelStaged(reason: string) {
    if (!this.staged) return;
    this.telemetry.cancellationCount++;
    this.countReason(this.telemetry.cancellationReasons, reason);
    this.staged = null;
    this.telemetry.stagedFace = -1;
  }

  update(
    dt: number,
    force: boolean,
    present: boolean,
    input: EnvironmentInput,
    capture: (bundle: EnvironmentBundle, face?: number) => void,
    beforeOverwrite?: (current: EnvironmentBundle) => void,
  ): void {
    if (this.disposed) return;
    this.telemetry.forceCurrent = this.forceCurrentMode;
    const now = this.monotonicNow();
    this.telemetry.deadlineMissed = false;
    this.updateEndpointAges(now);
    const slack = 300 + Math.max(this.telemetry.captureMs + this.telemetry.filterMs, this.telemetry.stagedLatencyMs);
    const semanticReason = environmentDirtyReason(this.lastInput, input, this.telemetry.ageMs, slack);
    if (semanticReason) this.pendingReason = semanticReason;
    const stagedReason = this.staged
      ? environmentDirtyReason(this.staged.input, input, Math.max(0, now - this.staged.started), slack)
      : null;
    if (stagedReason) this.pendingReason = stagedReason;
    if ([semanticReason, stagedReason].some((reason) => reason === 'clock-discontinuity'
      || reason === 'phase-discontinuity' || reason === 'origin-discontinuity')) this.forcePending = true;
    const forceReason = this.forceCurrentMode ? 'force-current'
      : this.forcePending ? (this.pendingReason ?? 'forced')
        : force ? 'explicit-force' : (this.pendingReason ?? 'forced');
    if (this.forceCurrentMode && present) this.pendingReason = 'force-current';
    if (force) this.forcePending = true;
    if (present && (this.forceCurrentMode || this.forcePending)) {
      force = true;
      this.pendingReason = this.forceCurrentMode ? 'force-current' : 'forced';
    }

    if (this.next !== null) {
      if (this.telemetry.ageMs >= environmentAgeLimitMs(input.lighting)) {
        this.commitExpiredBlend(now, input, force);
      } else {
        this.fade = Math.min(1, Math.max(0, (now - this.fadeStartedAt) / this.fadeDurationMs));
        this.telemetry.blend = this.fade;
        if (this.fade >= 1) this.commitBlend(now, input, force);
      }
    }
    if (!this.pendingReason || !present) return;

    // The initial and forced paths complete before returning, so the caller can render a coherent frame.
    if (this.telemetry.generation === 0 || force) {
      this.cancelStaged(force ? forceReason : 'initial-capture');
      if (force && this.next !== null) {
        this.active = this.next;
        this.next = null;
        this.fade = 1;
        this.fadeStartedAt = 0;
        this.telemetry.blend = 1;
        beforeOverwrite?.(this.bundles[this.active]);
      }
      const target = this.active === 0 ? 1 : 0;
      this.captureBundle(target, input, capture, now);
      if (force) {
        this.telemetry.forceCount++;
        this.telemetry.forceReason = forceReason;
        this.countReason(this.telemetry.forceReasons, forceReason);
      }
      this.active = target;
      this.next = null;
      this.fade = 1;
      this.telemetry.blend = 1;
      this.fadeDurationMs = 0;
      this.telemetry.blendDurationMs = 0;
      this.telemetry.blendShortened = false;
      this.pendingReason = null;
      this.forcePending = false;
      this.updateEndpointAges(this.monotonicNow());
      return;
    }
    // Never write a bundle being sampled. Finish the current fade first, then coalesce to the newest input.
    if (this.next !== null) return;
    if (!this.stagedCapturesEnabled) this.cancelStaged('staging-disabled');
    if (this.stagedCapturesEnabled) {
      if (!this.staged) {
        const index = this.active === 0 ? 1 : 0;
        this.staged = { index, input, started: this.monotonicNow(), captureMs: 0 };
        const freezeStart = this.monotonicNow();
        this.measure('capture-init', () => capture(this.bundles[index], -1)); // freeze source uniforms and clear cube
        this.staged.captureMs += this.monotonicNow() - freezeStart;
        this.telemetry.stagedFace = 0;
      }
      const stage = this.staged;
      const stageStart = this.monotonicNow();
      this.measure('capture-face', () => capture(this.bundles[stage.index], this.telemetry.stagedFace));
      stage.captureMs += this.monotonicNow() - stageStart;
      this.telemetry.stagedFace++;
      if (this.telemetry.stagedFace >= 6) {
        this.telemetry.stagedLatencyMs = this.monotonicNow() - stage.started;
        this.finishBundle(stage.index, stage.input, stage.started, stage.captureMs);
        this.next = stage.index;
        this.fade = 0;
        this.fadeStartedAt = this.monotonicNow();
        this.telemetry.stagedFace = -1;
        this.staged = null;
        this.pendingReason = environmentDirtyReason(stage.input, input, 0, 0);
        this.updateEndpointAges(this.monotonicNow());
        if (this.pendingReason === 'age') this.pendingReason = null;
        this.startDeadlineBoundedBlend(input);
      }
      return;
    }
    const target = this.active === 0 ? 1 : 0;
    this.captureBundle(target, input, capture, now);
    this.next = target;
    this.fade = 0;
    this.fadeStartedAt = this.monotonicNow();
    this.telemetry.forceCurrent = false;
    this.pendingReason = null;
    this.updateEndpointAges(this.monotonicNow());
    this.startDeadlineBoundedBlend(input);
  }

  private startDeadlineBoundedBlend(input: EnvironmentInput) {
    const remaining = Math.max(0, environmentAgeLimitMs(input.lighting) - this.telemetry.ageMs);
    this.fadeDurationMs = Math.min(200, remaining);
    this.telemetry.blendDurationMs = this.fadeDurationMs;
    this.telemetry.blendShortened = this.fadeDurationMs > 0 && this.fadeDurationMs < 200;
    if (this.fadeDurationMs === 0) this.commitExpiredBlend(this.monotonicNow(), input, false);
  }

  private commitExpiredBlend(now: number, input: EnvironmentInput, force: boolean) {
    if (this.next === null) return;
    this.active = this.next;
    this.next = null;
    this.fade = 1;
    this.fadeDurationMs = 0;
    this.telemetry.blendDurationMs = 0;
    this.fadeStartedAt = 0;
    this.telemetry.blend = 1;
    this.telemetry.blendShortened = true;
    this.telemetry.deadlineMissed = true;
    this.telemetry.deadlineMisses++;
    this.telemetry.deadlineReason = 'old-endpoint-age-limit';
    this.countReason(this.telemetry.deadlineReasons, this.telemetry.deadlineReason);
    if (!this.forceCurrentMode && !force) {
      this.pendingReason = environmentDirtyReason(
        this.lastInput,
        input,
        Math.max(0, now - this.capturedAt[this.active]),
        300 + Math.max(this.telemetry.captureMs + this.telemetry.filterMs, this.telemetry.stagedLatencyMs),
      );
    }
    this.updateEndpointAges(now);
  }

  private commitBlend(now: number, input: EnvironmentInput, force: boolean) {
    if (this.next === null) return;
    this.active = this.next;
    this.next = null;
    this.fadeStartedAt = 0;
    this.telemetry.blend = 1;
    const currentAge = Math.max(0, now - this.capturedAt[this.active]);
    if (!this.forceCurrentMode && !force) {
      this.pendingReason = environmentDirtyReason(
        this.lastInput, input, currentAge,
        300 + Math.max(this.telemetry.captureMs + this.telemetry.filterMs, this.telemetry.stagedLatencyMs),
      );
    }
    this.updateEndpointAges(now);
  }

  private captureBundle(index: number, input: EnvironmentInput, capture: (bundle: EnvironmentBundle, face?: number) => void, now: number) {
    const bundle = this.bundles[index];
    const t0 = this.monotonicNow();
    this.measure('capture', () => capture(bundle));
    this.finishBundle(index, input, now, this.monotonicNow() - t0);
  }

  private finishBundle(index: number, input: EnvironmentInput, now: number, captureMs: number) {
    const bundle = this.bundles[index];
    this.telemetry.captureMs = captureMs;
    const filterStart = this.monotonicNow();
    const filter = () => {
      bundle.pmrem = this.pmremFromCubemap(bundle.raw.texture, bundle.pmrem);
    };
    this.measure('filter', filter);
    this.telemetry.filterMs = this.monotonicNow() - filterStart;
    this.updateResourceEstimates();
    this.lastInput = input;
    this.capturedAt[index] = now;
    this.updateEndpointAges(now);
    this.telemetry.dirtyReason = this.pendingReason;
    this.telemetry.generation++;
    this.telemetry.captures++;
  }

  private pmremFromCubemap(cubemap: THREE.CubeTexture, target: THREE.WebGLRenderTarget | null) {
    // PMREMGenerator is injected by the owner to avoid owning renderer-wide state here.
    return this.pmrem(cubemap, target);
  }

  private measure<T>(stage: string, work: () => T): T {
    return this.profiler ? this.profiler.measure(stage, work) : work();
  }

  private updateEndpointAges(now: number) {
    const previousAt = this.capturedAt[this.active];
    const nextIndex = this.next ?? this.active;
    const nextAt = this.capturedAt[nextIndex];
    this.telemetry.previousAgeMs = Number.isFinite(previousAt) ? Math.max(0, now - previousAt) : Infinity;
    this.telemetry.nextAgeMs = Number.isFinite(nextAt) ? Math.max(0, now - nextAt) : Infinity;
    this.telemetry.ageMs = Math.max(this.telemetry.previousAgeMs, this.telemetry.nextAgeMs);
  }

  private updateResourceEstimates() {
    const resources = this.telemetry.resources;
    let rawTotalBytes = 0, clearTotalBytes = 0, pmremTotalBytes = 0;
    for (let i = 0; i < 2; i++) {
      const bundle = this.bundles[i];
      const estimates = resources.bundles[i];
      estimates.raw = estimateTarget(bundle.raw, true);
      estimates.clear = estimateTarget(bundle.clear, true);
      estimates.pmrem = bundle.pmrem ? estimateTarget(bundle.pmrem, false) : null;
      estimates.totalBytes = estimates.raw.totalBytes + estimates.clear.totalBytes + (estimates.pmrem?.totalBytes ?? 0);
      rawTotalBytes += estimates.raw.totalBytes;
      clearTotalBytes += estimates.clear.totalBytes;
      pmremTotalBytes += estimates.pmrem?.totalBytes ?? 0;
    }
    resources.poolReadyCount = this.bundles.reduce((count, bundle) => count + Number(bundle.pmrem !== null), 0);
    resources.poolReady = resources.poolReadyCount === resources.bundleCount;
    resources.rawTotalBytes = rawTotalBytes;
    resources.clearTotalBytes = clearTotalBytes;
    resources.pmremTotalBytes = pmremTotalBytes;
    resources.pairTotalBytes = rawTotalBytes + clearTotalBytes + pmremTotalBytes;
  }
  private pmrem: (cubemap: THREE.CubeTexture, target: THREE.WebGLRenderTarget | null) => THREE.WebGLRenderTarget = () => {
    throw new Error('SkyEnvironmentCache PMREM callback was not configured');
  };
  setPMREMGenerator(generator: THREE.PMREMGenerator) {
    this.pmrem = (cubemap, target) => generator.fromCubemap(cubemap, target ?? undefined);
  }

  captureClear(bundle: EnvironmentBundle, clearScene: THREE.Scene) {
    const index = this.bundles.indexOf(bundle);
    this.clearCameras[index].position.set(0, 0, 0);
    this.clearCameras[index].update(this.renderer, clearScene);
  }

  captureRaw(bundle: EnvironmentBundle, scene: THREE.Scene) {
    const index = this.bundles.indexOf(bundle);
    this.cameras[index].position.set(0, 0, 0);
    this.cameras[index].update(this.renderer, scene);
  }

  captureRawFace(bundle: EnvironmentBundle, scene: THREE.Scene, face: number) {
    const index = this.bundles.indexOf(bundle);
    const target = bundle.raw;
    const texture = target.texture;
    const cube = this.cameras[index];
    if (cube.coordinateSystem !== this.renderer.coordinateSystem) {
      cube.coordinateSystem = this.renderer.coordinateSystem;
      cube.updateCoordinateSystem();
    }
    const camera = this.cameras[index].children[face] as THREE.Camera;
    const previousTarget = this.renderer.getRenderTarget();
    const previousFace = this.renderer.getActiveCubeFace();
    const previousMip = this.renderer.getActiveMipmapLevel();
    const previousXr = this.renderer.xr.enabled;
    const previousScissorTest = this.renderer.getScissorTest();
    this.renderer.getViewport(this.savedViewport);
    this.renderer.getScissor(this.savedScissor);
    const generateMipmaps = texture.generateMipmaps;
    try {
      this.renderer.xr.enabled = false;
      texture.generateMipmaps = face === 5 && generateMipmaps;
      cube.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      this.renderer.setRenderTarget(target, face, 0);
      if (this.renderer.state.buffers.depth.getReversed() && this.renderer.autoClear === false) this.renderer.clearDepth();
      this.renderer.render(scene, camera);
    } finally {
      texture.generateMipmaps = generateMipmaps;
      this.renderer.setRenderTarget(previousTarget, previousFace, previousMip);
      this.renderer.setViewport(this.savedViewport);
      this.renderer.setScissor(this.savedScissor);
      this.renderer.setScissorTest(previousScissorTest);
      this.renderer.xr.enabled = previousXr;
    }
    if (face === 5) texture.needsPMREMUpdate = true;
  }

  get rawCameraTargets(): readonly [THREE.WebGLCubeRenderTarget, THREE.WebGLCubeRenderTarget] {
    return [this.bundles[0].raw, this.bundles[1].raw];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelStaged('dispose');
    for (const bundle of this.bundles) {
      bundle.raw.dispose(); bundle.clear.dispose(); bundle.pmrem?.dispose();
    }
  }
}
