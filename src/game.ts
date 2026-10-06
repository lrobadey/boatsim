import * as THREE from 'three';
import { Pipeline, LAYER_REFRACT, LAYER_NOREFLECT } from './core/pipeline';
import { Quality } from './core/quality';
import { Input } from './core/input';
import { shared } from './gfx/shared';
import { dataTexture } from './gfx/textures';
import type { VisualAssets } from './gfx/assets';
import { AstroClock } from './world/astro';
import { Wind } from './world/wind';
import { WaveField } from './world/waves';
import { SkySystem } from './world/sky';
import { Ocean } from './world/ocean';
import { OceanFFT } from './world/oceanFFT';
import { Terrain } from './world/terrain';
import { FoamSystem } from './world/foam';
import { Props } from './world/props';
import { Birds } from './world/birds';
import type { WorldGenResult } from './world/worldgenTypes';
import { ShipPhysics } from './ship/physics';
import { Trireme } from './ship/trireme';
import { Crew, ORDERS } from './ship/crew';
import { hullWidthTable, HULL_LENGTH } from './ship/hull';
import { PlayerController } from './player/controller';
import { Hud } from './ui/hud';
import { Chart } from './ui/chart';
import { Minimap } from './ui/minimap';
import { PlanarReflection } from './gfx/reflection';
import { SunShadowBake } from './gfx/sunShadowBake';
import { Clouds } from './gfx/clouds';
import { AudioEngine } from './audio/audio';
import { noise1, clamp, smoothstep } from './core/util';

const SIM_DT = 1 / 120;

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly pipeline: Pipeline;
  readonly input: Input;
  readonly clock = new AstroClock();
  readonly wind = new Wind(3);
  readonly waves: WaveField;
  readonly sky: SkySystem;
  readonly ocean: Ocean;
  readonly fft: OceanFFT;
  private hoverHinted = false;
  readonly minimap: Minimap;
  readonly reflection: PlanarReflection;
  private sunBake: SunShadowBake;
  readonly clouds: Clouds;
  private cloudAmbTop = new THREE.Color();
  private cloudAmbBottom = new THREE.Color();
  private lastCloudLightDir = new THREE.Vector3();
  private lastCloudLightColor = new THREE.Color();
  private lastCloudAmbTop = new THREE.Color();
  private lastCloudHour = 0;
  private lastCloudDayCount = 0;
  private cloudLightingReady = false;
  private lightingJump = false;
  readonly terrain: Terrain;
  readonly foam: FoamSystem;
  readonly props: Props;
  readonly birds: Birds;
  readonly crew = new Crew();
  readonly ship: ShipPhysics;
  readonly model: Trireme;
  readonly player: PlayerController;
  readonly hud: Hud;
  readonly chart: Chart;
  readonly audio = new AudioEngine();
  private acc = 0;
  private last = performance.now();
  private simTime = 0;
  private shipPos = new THREE.Vector3();
  private shipQuat = new THREE.Quaternion();
  private waveRetarget = 0;
  running = false;
  /** title-screen camera orbit; gameplay input disabled */
  cinematic = false;
  paused = false;
  showHud = true;
  private frameMs: number[] = [];
  private islands: { name: string; x: number; z: number; r: number; kind: string }[] = [];
  private harbour: { x: number; z: number; name: string } | null = null;

  /** nearest named place (island or its harbour) to the camera, for the location title */
  nearestIsland() {
    const p = this.player.mode === 'eagle' ? this.camera.position : this.shipPos;
    if (this.harbour && Math.hypot(p.x - this.harbour.x, p.z - this.harbour.z) < 450) return { name: this.harbour.name, dist: 0, kind: 'Harbour' };
    let best: { name: string; dist: number; kind: string } | null = null;
    for (const i of this.islands) {
      const d = Math.max(0, Math.hypot(p.x - i.x, p.z - i.z) - i.r);
      if (!best || d < best.dist) best = { name: i.name, dist: d, kind: i.kind };
    }
    return best;
  }

  constructor(canvas: HTMLCanvasElement, private quality: Quality, gen: WorldGenResult, tex: { noise: Uint8Array; ripple: Uint8Array; cloudShape: Uint16Array; cloudDetail: Uint16Array; cloudWeather: Uint8Array }, assets: VisualAssets) {
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 60000);
    this.pipeline = new Pipeline(canvas, this.scene, this.camera, quality);
    this.input = new Input(canvas);
    const r = this.pipeline.renderer;

    this.clock.compute();
    this.waves = new WaveField(this.wind, 11);

    const devLog = location.search.includes('dev');
    const T = (l: string) => devLog && console.log('[game]', l, performance.now().toFixed(0));
    T('begin');
    const noise = dataTexture(tex.noise, 256);
    const ripple = dataTexture(tex.ripple, 512, 8);

    T('textures');
    this.sky = new SkySystem(r, this.clock);
    this.scene.add(this.sky.group, this.sky.light, this.sky.light.target, this.sky.hemi);
    this.clouds = new Clouds(tex.cloudShape, tex.cloudDetail, dataTexture(tex.cloudWeather, 256), quality.cloudScale || 0.3);
    this.clouds.enabled = quality.cloudScale > 0;
    this.clouds.steps = quality.cloudSteps || 56;
    if (this.clouds.enabled) {
      this.sky.attachClouds(this.clouds);
      this.pipeline.attachClouds(this.clouds);
    }
    const sl = this.sky.light;
    // lights must also be on the refraction layer or the seabed pre-pass renders unlit
    sl.layers.enable(LAYER_REFRACT);
    this.camera.layers.enable(LAYER_NOREFLECT);
    this.sky.hemi.layers.enable(LAYER_REFRACT);
    sl.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const sc = sl.shadow.camera;
    sc.left = -75;
    sc.right = 75;
    sc.top = 75;
    sc.bottom = -75;
    sc.near = 1;
    sc.far = 400;

    this.terrain = new Terrain(gen, noise, quality.terrainChunkLods, assets.sand);
    this.scene.add(this.terrain.group);
    shared.uHeightTex.value = this.terrain.heightTexture;
    const aoTex = new THREE.DataTexture(gen.ao, gen.aoSize, gen.aoSize, THREE.RedFormat, THREE.UnsignedByteType);
    aoTex.magFilter = aoTex.minFilter = THREE.LinearFilter;
    aoTex.needsUpdate = true;
    shared.uAOTex.value = aoTex;
    shared.uTerrainSize.value = gen.worldSize;
    let maxH = 0;
    for (let i = 0; i < gen.heights.length; i += 7) maxH = Math.max(maxH, gen.heights[i]);
    shared.uTerrainMax.value = maxH + 20;
    this.sunBake = new SunShadowBake(this.pipeline.renderer, quality.heightmapSize);

    T('terrain');
    this.fft = new OceanFFT(quality.fftSize);
    this.fft.retarget(this.wind.meanSpeed, this.wind.from + Math.PI, this.waves.fetch, true);
    this.ocean = new Ocean(this.waves, this.fft, { ripple, noise, height: this.terrain.heightTexture, terrainSize: gen.worldSize }, { grid: quality.oceanGrid, levels: 13, cell0: 0.25 });
    this.scene.add(this.ocean.group);
    this.reflection = new PlanarReflection(quality.reflectionScale || 0.5);
    this.reflection.enabled = quality.reflectionScale > 0;
    this.ocean.uniforms.uReflect.value = this.reflection.target.texture;
    this.ocean.uniforms.uReflMatrix.value = this.reflection.textureMatrix;
    this.ocean.uniforms.uReflOn.value = this.reflection.enabled ? 1 : 0;
    this.ocean.uniforms.uHullW.value = hullWidthTable();
    this.ocean.uniforms.uHullLen.value = HULL_LENGTH;

    this.foam = new FoamSystem(quality.name === 'low' ? 512 : 1024);
    this.ocean.uniforms.uFoamMap.value = this.foam.target.texture;
    this.ocean.uniforms.uFoamSize.value = this.foam.size;
    this.ocean.uniforms.uFoamCenter.value = this.foam.center;

    this.props = new Props(gen, this.terrain, this.waves, noise, quality, assets);
    this.scene.add(this.props.group);
    this.birds = new Birds(gen);
    this.scene.add(this.birds.group);

    T('props');
    this.ship = new ShipPhysics(this.waves, this.wind, this.terrain, this.crew);
    this.model = new Trireme(assets.planks, this.ship.rowing.slots);
    this.scene.add(this.model.group);
    this.ship.place(gen.sites.start.x, gen.sites.start.z, gen.sites.start.heading);
    // settle on the water before the player arrives
    for (let i = 0; i < 240; i++) this.ship.step(SIM_DT);
    this.ship.vel.set(0, 0, 0);
    this.ship.angVel.set(0, 0, 0);

    T('ship');
    this.player = new PlayerController(this.camera, this.input);
    this.hud = new Hud();
    this.chart = new Chart(gen, this.terrain);
    this.minimap = new Minimap(this.chart, gen);
    this.hud.mount(this.minimap.root);
    // named places, described from their terrain
    for (const i of gen.islands) {
      if (!i.name) continue;
      const kind = i.area > 4e6 ? (i.peak > 220 ? 'Mountainous island' : 'Island') : i.area > 6e5 ? 'Islet' : 'Rocky islet';
      this.islands.push({ name: i.name, x: i.cx, z: i.cz, r: Math.sqrt(i.area / Math.PI), kind });
    }
    if (gen.islands[0]?.name) this.harbour = { x: gen.sites.harbour.x, z: gen.sites.harbour.z, name: `Harbour of ${gen.islands[0].name}` };


    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.sky.updateLighting(0, this.camera, true);
    this.updateCloudInputs(0);
    this.sky.updateEnvironment(0, true);
    this.scene.environment = this.sky.envMap;
    // sky irradiance relative to the sun (~1:4-5 on a clear Aegean day)
    this.scene.environmentIntensity = 0.85;
    T('done');
  }

  resize() {
    this.pipeline.setSize(window.innerWidth, window.innerHeight);
  }

  /** Keep the cloud pass and sky environment capture on the same weather and celestial state. */
  private updateCloudInputs(dt: number) {
    const sunY = this.clock.sunDir.y;
    const day = clamp((sunY + 0.08) / 0.33, 0, 1);
    const daylight = day * day * (3 - 2 * day);
    const phase = 0.5 - 0.5 * Math.cos(this.clock.moonPhase * Math.PI * 2);
    const moonlight = phase * smoothstep(-0.02, 0.1, this.clock.moonDir.y) * this.sky.night;
    // Faint airglow remains under a new moon; the stronger blue lunar fill follows phase and altitude.
    const airglow = 0.012;
    const solarFill = airglow + (1 - airglow) * daylight;
    this.cloudAmbTop.setRGB(
      0.36 * solarFill + 0.018 * moonlight,
      0.46 * solarFill + 0.027 * moonlight,
      0.62 * solarFill + 0.045 * moonlight,
    );
    this.cloudAmbBottom.setRGB(
      0.09 * solarFill + 0.004 * moonlight,
      0.1 * solarFill + 0.006 * moonlight,
      0.115 * solarFill + 0.01 * moonlight,
    );
    const direct = shared.uSunColor.value;
    const elapsedHours = Math.abs((this.clock.dayCount - this.lastCloudDayCount) * 24 + this.clock.hours - this.lastCloudHour);
    const priorDirect = Math.max(this.lastCloudLightColor.r, this.lastCloudLightColor.g, this.lastCloudLightColor.b);
    const directDelta = Math.max(
      Math.abs(direct.r - this.lastCloudLightColor.r),
      Math.abs(direct.g - this.lastCloudLightColor.g),
      Math.abs(direct.b - this.lastCloudLightColor.b),
    );
    const ambientDelta = Math.max(
      Math.abs(this.cloudAmbTop.r - this.lastCloudAmbTop.r),
      Math.abs(this.cloudAmbTop.g - this.lastCloudAmbTop.g),
      Math.abs(this.cloudAmbTop.b - this.lastCloudAmbTop.b),
    );
    const discontinuity = this.cloudLightingReady && (
      elapsedHours > 0.05 ||
      this.lastCloudLightDir.dot(shared.uSunDir.value) < Math.cos(0.05) ||
      directDelta > Math.max(0.025, priorDirect * 0.25) ||
      ambientDelta > 0.025
    );
    this.lastCloudLightDir.copy(shared.uSunDir.value);
    this.lastCloudLightColor.copy(direct);
    this.lastCloudAmbTop.copy(this.cloudAmbTop);
    this.lastCloudHour = this.clock.hours;
    this.lastCloudDayCount = this.clock.dayCount;
    this.cloudLightingReady = true;
    // Weather advances even while presentation is suppressed by fastForward().
    this.clouds.coverage = 0.36 + 0.18 * noise1(this.clock.hours / 5 + this.simTime / 3000, 17);
    this.clouds.step(dt, this.wind.vx, this.wind.vz, direct, this.cloudAmbTop, this.cloudAmbBottom, this.camera.position);
    return discontinuity;
  }

  start() {
    this.running = true;
    this.last = performance.now();
    // frame cap: on a 120 Hz display present every other vsync for a locked 60, keeping the
    // schedule on a fixed grid so the cadence doesn't drift into judder
    let next = 0;
    const loop = (t: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const interval = 1000 / this.pipeline.targetFps;
      if (t < next - 2.5) return;
      next = t - next > interval * 2 || next === 0 ? t + interval : next + interval;
      this.frame();
    };
    requestAnimationFrame(loop);
  }

  private handleInput(dt: number) {
    const inp = this.input;
    const p = this.player;
    if (inp.hit('KeyE')) p.toggleHelm();
    if (inp.hit('KeyC')) p.cycleCamera();
    if (inp.hit('KeyQ')) p.toggleEagle(this.shipPos);
    if (inp.hit('KeyM')) this.chart.toggle();
    if (inp.hit('Slash') || inp.hit('F1')) this.hud.toggleHelp();
    if (inp.hit('KeyH')) {
      this.showHud = !this.showHud;
      this.hud.setVisible(this.showHud);
    }
    if (inp.hit('F3') || inp.hit('Backquote')) this.hud.toggleDebug();
    if (inp.hit('KeyN')) this.audio.toggleMute();
    if (inp.hit('BracketRight')) this.clock.timeScale = Math.min(480, this.clock.timeScale * 2);
    if (inp.hit('BracketLeft')) this.clock.timeScale = Math.max(1, this.clock.timeScale / 2);
    if (inp.hit('KeyT')) {
      // jump to the next of dawn / midday / dusk / night
      const marks = [5.6, 12.5, 19.3, 23.0];
      const h = this.clock.hours;
      const next = marks.find((m) => m > h + 0.05) ?? marks[0] + 24;
      this.clock.hours = next % 24;
      this.clock.compute();
      this.lightingJump = true;
    }
    // helm controls (orders are shouted from the helm; also allowed in chase view)
    const commanding = p.mode === 'helm' || (p.mode === 'chase' && p.prevShipMode === 'helm');
    if (commanding) {
      if (inp.hit('KeyW')) this.crew.setOrder(this.crew.orderIndex + 1);
      if (inp.hit('KeyS')) this.crew.setOrder(this.crew.orderIndex - 1);
      if (inp.hit('KeyF')) this.ship.sailTarget = this.ship.sailTarget > 0.5 ? 0 : 1;
      const steer = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
      if (steer !== 0) this.ship.helm = clamp(this.ship.helm + steer * dt * 0.9, -1, 1);
      else if (inp.down('KeyX')) this.ship.helm *= Math.exp(-dt * 4);
      this.crew.holdWater = inp.down('Space');
    } else {
      this.crew.holdWater = false;
    }
    // helm self-centres slowly when not held (the steering oars trail in the flow)
    if (!(commanding && (inp.down('KeyA') || inp.down('KeyD')))) this.ship.helm *= Math.exp(-dt * 0.25);
  }

  /** dev/testing: run the whole game forward at a fixed step without presenting frames */
  fastForward(seconds: number, step = 1 / 60) {
    if (seconds > 0) this.clouds.resetHistory();
    for (let t = 0; t < seconds; t += step) this.frame(step, false);
  }

  private frame(fixedDt?: number, present = true) {
    const now = performance.now();
    const frameMs = now - this.last;
    let dt = fixedDt ?? frameMs / 1000;
    this.last = now;
    dt = Math.min(dt, 0.1);
    if (fixedDt === undefined) {
      this.frameMs.push(frameMs);
      if (this.frameMs.length > 120) this.frameMs.shift();
      this.pipeline.adapt(frameMs, dt);
    }

    let cameraCut = false;
    if (!this.paused) {
      if (this.cinematic) this.player.chaseYaw += dt * 0.035;
      else {
        const previousMode = this.player.mode;
        this.handleInput(dt);
        cameraCut = this.player.mode !== previousMode;
      }
      this.clock.update(dt);
      this.wind.update(dt);
      this.waveRetarget -= dt;
      if (this.waveRetarget <= 0) {
        this.waves.retarget(this.wind);
        this.fft.retarget(this.wind.meanSpeed, this.wind.from + Math.PI, this.waves.fetch);
        const wc = this.fft.whitecaps(this.wind.meanSpeed, this.waves.jVar);
        this.ocean.uniforms.uWhiteJ.value = wc.threshold;
        this.ocean.uniforms.uWhiteRamp.value = wc.ramp;
        this.waveRetarget = 1;
      }
      this.waves.update(dt);
      shared.uWindDir.value.set(this.wind.dirX, this.wind.dirZ);
      shared.uWindStrength.value = clamp(this.wind.speed / 12, 0, 1.3);

      // fixed-step simulation
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 12) {
        this.ship.step(SIM_DT);
        this.simTime += SIM_DT;
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps >= 12) this.acc = 0;
    }
    shared.uTime.value = this.ship.time;

    // ship pose for rendering (interpolated)
    const alpha = this.acc / SIM_DT;
    this.ship.pose(alpha, this.shipPos, this.shipQuat);
    const cgW = this.ship.cg.clone().applyQuaternion(this.shipQuat);
    this.model.group.position.copy(this.shipPos).sub(cgW);
    this.model.group.quaternion.copy(this.shipQuat);
    this.model.group.updateMatrixWorld(true);
    (this.ocean.uniforms.uShipInv.value as THREE.Matrix4).copy(this.model.group.matrixWorld).invert();

    this.player.shipSpeed = this.ship.speed;
    this.player.autoCenter = !this.cinematic;
    this.input.lookEnabled = !this.paused && !this.cinematic;
    if (this.input.hoverLook && !this.hoverHinted && !this.cinematic) {
      this.hoverHinted = true;
      this.hud.showNote('No mouse capture here — rest the cursor at a screen edge, or use the arrow keys, to keep turning', 9);
    }
    this.player.update(dt, this.model.group.position, this.shipQuat, this.terrain, this.waves, this.ship.time);
    // world systems
    this.sky.updateLighting(dt, this.camera, this.lightingJump);
    this.model.update(this.ship, this.crew, this.sky.night, this.ship.time, alpha);
    const lightingDiscontinuity = this.updateCloudInputs(dt);
    if (cameraCut || this.lightingJump || lightingDiscontinuity) this.clouds.resetHistory();
    const timed = present && fixedDt === undefined;
    if (timed) this.pipeline.beginGpuTimer();
    this.sky.updateEnvironment(dt, this.lightingJump);
    this.lightingJump = false;
    if (this.scene.environment !== this.sky.envMap) this.scene.environment = this.sky.envMap;
    this.pipeline.grade.uniforms.get('exposure')!.value = this.sky.exposure;
    // bloom thresholds the raw HDR scene: keep it relative to the adapted exposure so only true
    // highlights (sun, glitter, fire) bloom at any time of day
    this.pipeline.bloom.luminanceMaterial.threshold = 5.0 / this.sky.exposure;
    this.pipeline.grade.uniforms.get('nightTint')!.value = this.sky.night;
    this.pipeline.grade.uniforms.get('spyglass')!.value = this.player.zoom;
    const sl = this.sky.light;
    const focus = this.player.mode === 'eagle' ? this.camera.position : this.shipPos;
    sl.target.position.copy(focus);
    sl.position.copy(focus).addScaledVector(shared.uSunDir.value, 200);
    sl.target.updateMatrixWorld();
    this.sunBake.update(!present);
    if (present) this.fft.update(this.pipeline.renderer, this.ship.time, dt);
    this.ocean.update(this.camera);
    this.props.update(dt, this.ship.time, this.camera, this.sky.night);
    this.birds.update(dt, this.camera);
    this.foam.update(this.paused ? 0 : dt, this.ship, this.model, this.pipeline.renderer, this.ship.time - SIM_DT + alpha * SIM_DT, present && !this.paused);

    const rt = this.pipeline.refractTarget;
    const size = this.pipeline.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.ocean.setRefraction(rt.texture, rt.depthTexture!, size.x, size.y, this.camera.near, this.camera.far);

    if (!present) return;
    if (this.clouds.enabled) {
      this.clouds.renderShadow(this.pipeline.renderer, this.camera.position);
    }
    if (this.reflection.enabled) {
      const r = this.pipeline.reflectSize;
      if (r.x !== this.reflection.target.width || r.y !== this.reflection.target.height) this.reflection.target.setSize(r.x, r.y);
      this.reflection.render(this.pipeline.renderer, this.scene, this.camera, [this.ocean.group, this.sky.group]);
    }
    this.pipeline.render(dt, () => {});
    if (timed) this.pipeline.endGpuTimer();

    // audio & UI
    if (!this.paused) this.audio.rowingEvents(this.ship.rowing, this.ship.time - SIM_DT + alpha * SIM_DT);
    this.audio.update(dt, this);
    if (this.showHud) this.hud.update(this, this.frameMs, dt);
    this.chart.update(this.ship, this.player);
    if (this.showHud) {
      const cd = this.camera.getWorldDirection(new THREE.Vector3());
      const eagle = this.player.mode === 'eagle';
      const cx = eagle ? this.camera.position.x : this.shipPos.x;
      const cz = eagle ? this.camera.position.z : this.shipPos.z;
      this.minimap.update(dt, cx, cz, Math.atan2(cd.x, -cd.z), this.shipPos.x, this.shipPos.z, this.ship.heading);
    }
    this.input.endFrame();
  }
}
