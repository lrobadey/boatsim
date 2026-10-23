import type {OrmosHarbour} from './world/ormosHarbour';
import * as THREE from 'three';
import { Pipeline, LAYER_REFRACT, LAYER_NOREFLECT } from './core/pipeline';
import { Quality } from './core/quality';
import { Input } from './core/input';
import { shared } from './gfx/shared';
import { setEnvironmentShaderBlend } from './gfx/environmentMaterials';
import { dataTexture } from './gfx/textures';
import type { VisualAssets } from './gfx/assets';
import type { ModelKit } from './gfx/models';
import { AstroClock } from './world/astro';
import { Wind } from './world/wind';
import { WaveField } from './world/waves';
import { SeaStateField } from './world/seaState';
import { SkySystem } from './world/sky';
import { Ocean } from './world/ocean';
import { OceanFFT } from './world/oceanFFT';
import { Terrain } from './world/terrain';
import { FoamSystem } from './world/foam';
import { OarWater } from './world/oarWater';
import { Props } from './world/props';
import { Birds } from './world/birds';
import type { WorldGenResult } from './world/worldgenTypes';
import { ShipPhysics } from './ship/physics';
import { Trireme } from './ship/trireme';
import { MerchantModel } from './ship/merchantModel';
import { CrewRowing } from './ship/crew/crewRowing';
import { CrewAnimator } from './crew/crewAnimator';
import { CrewSolids } from './crew/crewSolids';
import type { ShipVisual } from './ship/shipVisual';
import { TRIREME, type ShipDesign } from './ship/design';
import { Crew, ORDERS, ORDER_STOP } from './ship/crew';
import { buildHarbours, type HarbourLayout, type Berth } from './world/harbour';
import { TradeLayer } from './tradeLayer';
import { WalkGeometry } from './world/walkable';
import type { ShipPose } from './player/walker';
import { HarbourRig } from './world/harbourRig';
import { BerthMarker } from './world/berthMarker';
import { DockPanel, Crosshair } from './ui/dock';
import { DeckBuilder } from './build/deckBuilder';
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

/** Opt-in development vessels can supply their authored exterior without entering saved voyages. */
export interface DevVessel {
  createModel(ship: ShipPhysics): ShipVisual;
  buildSolids(solids: WalkGeometry): void;
  start: WorldGenResult['sites']['start'];
  /** A positive offset renders two hull cutouts, leaving water visible in the channel. */
  hullOffset: number;
  hullWidths: Float32Array;
}

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
  readonly oarWater: OarWater;
  readonly props: Props;
  readonly birds: Birds;
  readonly crew = new Crew();
  readonly ship: ShipPhysics;
  readonly model: ShipVisual;
  /** the merchant's animated rowers; null for every other ship (no crew, or one whose rowers are not drawn) */
  private crewAnimator: CrewAnimator | null = null;
  /** walker collision for the agent crew: hands and stances on shipSolids.dynamic */
  private crewSolids: CrewSolids | null = null;
  readonly player: PlayerController;
  readonly hud: Hud;
  readonly chart: Chart;
  readonly audio = new AudioEngine();
  /** every harbour's layout; [0] is the main harbour */
  readonly harbourLayouts: HarbourLayout[];
  /** the main harbour (kept for main.ts and other sessions' tools) */
  get harbourLayout(): HarbourLayout {
    return this.harbourLayouts[0];
  }
  /** cargo and ports (merchant only), set up by initTrade */
  trade: TradeLayer | null = null;
  private gen: WorldGenResult;
  /** world walk geometry (terrain + quay, houses, temple) and ship-local deck solids */
  readonly walk: WalkGeometry;
  readonly shipSolids = new WalkGeometry(null);
  private shipPose: ShipPose;
  readonly harbourRig: HarbourRig;
  readonly berthMarker: BerthMarker;
  readonly dock: DockPanel;
  readonly crosshair = new Crosshair();
  readonly builder: DeckBuilder;
  private invShip = new THREE.Matrix4();
  private steeringInput = false;
  private sailSelection = 1;
  private acc = 0;
  private last = performance.now();
  private simTime = 0;
  private shipPos = new THREE.Vector3();
  private shipQuat = new THREE.Quaternion();
  private waveRetarget = 0;
  /** wave size by place (docs/sea-state-spec.md); null when the world has no sea state bake */
  seaState: SeaStateField | null = null;
  /** Optional fixed inspection camera; production controls never set this. */
  reviewCamera: {position:THREE.Vector3;target:THREE.Vector3}|null=null;
  running = false;
  /** title-screen camera orbit; gameplay input disabled */
  cinematic = false;
  paused = false;
  showHud = true;
  private frameMs: number[] = [];
  private islands: { name: string; x: number; z: number; r: number; kind: string }[] = [];
  private harbours: { x: number; z: number; name: string }[] = [];

  /** Selected exposure restored by F after the sail has been fully brailed. */
  get sailDeploymentSelection() { return this.sailSelection; }

  /** nearest named place (island or its harbour) to the camera, for the location title */
  nearestIsland() {
    const p = this.player.mode === 'eagle' ? this.camera.position : this.shipPos;
    for (const h of this.harbours) if (Math.hypot(p.x - h.x, p.z - h.z) < 450) return { name: h.name, dist: 0, kind: 'Harbour' };
    let best: { name: string; dist: number; kind: string } | null = null;
    for (const i of this.islands) {
      const d = Math.max(0, Math.hypot(p.x - i.x, p.z - i.z) - i.r);
      if (!best || d < best.dist) best = { name: i.name, dist: d, kind: i.kind };
    }
    return best;
  }

  constructor(canvas: HTMLCanvasElement, private quality: Quality, gen: WorldGenResult, tex: { noise: Uint8Array; ripple: Uint8Array; cloudShape: Uint16Array; cloudDetail: Uint16Array; cloudWeather: Uint8Array }, assets: VisualAssets, readonly models: ModelKit, readonly design: ShipDesign = TRIREME, ormos?:OrmosHarbour, devVessel?: DevVessel) {
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
    this.sky = new SkySystem(r, this.clock, quality.environmentSize);
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
    // sea state (docs/sea-state-spec.md): wave size by place from the baked fetch, shelter and depth.
    // The waves, the ocean shader and the sail's wind all read the same envelope.
    if (gen.seaState) {
      const sea = new SeaStateField(gen.seaState, this.waves, [this.fft.cascades[0].kMin, this.fft.cascades[0].kMax]);
      this.seaState = sea;
      sea.compose(this.wind.meanSpeed, this.wind.from, this.waves.swellFrom);
      this.waves.field = sea;
      this.ocean.setSeaState(sea);
      const e0 = new Float64Array(4), e1 = new Float64Array(4);
      this.wind.shelterAt = (x, z, out) => {
        sea.sample(x, z, e0, e1);
        out.s = e1[1];
        out.g = e1[3];
      };
      console.info(`Sea state bake: ${Math.round(gen.seaState.ms)} ms`);
    }
    this.scene.add(this.ocean.group);
    this.reflection = new PlanarReflection(quality.reflectionScale || 0.5);
    this.reflection.enabled = quality.reflectionScale > 0;
    this.ocean.uniforms.uReflect.value = this.reflection.target.texture;
    this.ocean.uniforms.uReflMatrix.value = this.reflection.textureMatrix;
    this.ocean.uniforms.uReflOn.value = this.reflection.enabled ? 1 : 0;
    this.ocean.uniforms.uHullW.value = devVessel?.hullWidths ?? design.hull.hullWidthTable();
    this.ocean.uniforms.uHullOffset.value = devVessel?.hullOffset ?? 0;
    this.ocean.uniforms.uHullLen.value = design.hull.length;
    this.ocean.uniforms.uHullDeck.value = devVessel || design.kind === 'merchant' ? design.deck.deckY(0.5) : 2.0;

    this.foam = new FoamSystem(quality.name === 'low' ? 512 : 1024, design.hull);
    this.ocean.uniforms.uFoamMap.value = this.foam.target.texture;
    this.ocean.uniforms.uFoamSize.value = this.foam.size;
    this.ocean.uniforms.uFoamCenter.value = this.foam.center;
    this.oarWater = new OarWater(quality.name === 'low' ? 512 : 1024, design.hull);
    this.ocean.uniforms.uOarMap.value = this.oarWater.target.texture;
    this.ocean.uniforms.uOarSize.value = this.oarWater.size;
    this.ocean.uniforms.uOarCenter.value = this.oarWater.center;
    this.scene.add(this.oarWater.spray);

    this.props = new Props(gen, this.terrain, this.waves, noise, quality, assets, this.models,ormos);
    this.scene.add(this.props.group);
    this.birds = new Birds(gen);
    this.scene.add(this.birds.group);

    T('props');
    this.ship = new ShipPhysics(this.waves, this.wind, this.terrain, this.crew, design);
    this.model = devVessel ? devVessel.createModel(this.ship) : design.kind === 'merchant'
      ? new MerchantModel(ormos?.wood??assets.planks, this.ship.rowing.slots, this.models, design)
      : new Trireme(assets.planks, this.ship.rowing.slots, this.models);
    if(ormos && this.model instanceof MerchantModel){this.model.setAuthoredShell(ormos.shell);this.model.setSailSurface(ormos.linen);}
    this.scene.add(this.model.group);
    this.crewAnimator = design.oars.system === 'crew' && design.oars.crew?.animated && this.ship.rowing instanceof CrewRowing
      ? new CrewAnimator(this.models, this.model.group, this.ship.rowing, design)
      : null;
    this.crewSolids = this.crewAnimator ? new CrewSolids(this.shipSolids, design) : null;
    this.gen = gen;
    this.harbourLayouts = buildHarbours(gen, this.terrain,!!ormos);
    this.ship.mooring.setHarbours(this.harbourLayouts);
    this.walk = new WalkGeometry(this.terrain);
    for (const l of this.harbourLayouts) for (const sol of l.solids) this.walk.add(sol);
    for (const sol of this.props.solids) this.walk.add(sol);
    if (devVessel) devVessel.buildSolids(this.shipSolids);
    else this.buildShipSolids();
    this.shipPose = { origin: new THREE.Vector3(), quat: new THREE.Quaternion(), cgWorld: new THREE.Vector3(), vel: new THREE.Vector3(), angVel: new THREE.Vector3(), plank: null, solids: this.shipSolids };
    this.harbourRig = new HarbourRig(design);
    this.harbourRig.setPlankModel(ormos && design.kind==='merchant' ? ormos.plank : this.models.get('gangplank'),ormos && design.kind==='merchant' ? 3.1 : 3,!!ormos && design.kind==='merchant');
    this.harbourRig.setAnchorModel(this.models.get('anchor'));
    this.scene.add(this.harbourRig.group);
    this.berthMarker = new BerthMarker(this.harbourLayouts, design);
    this.scene.add(this.berthMarker.group);
    const start = devVessel?.start ?? gen.sites.start;
    this.ship.place(start.x, start.z, start.heading);
    // settle on the water before the player arrives
    for (let i = 0; i < 240; i++) this.ship.step(SIM_DT);
    // one clock: the wind starts where the ship's time is
    this.wind.update(this.ship.time - this.wind.time);
    this.ship.vel.set(0, 0, 0);
    this.ship.angVel.set(0, 0, 0);

    T('ship');
    this.player = new PlayerController(this.camera, this.input, design);
    this.hud = new Hud();
    this.hud.setMaxOrder(design.oars.maxOrder);
    this.audio.drumEnabled = design.oars.drum;
    this.chart = new Chart(gen, this.terrain);
    this.minimap = new Minimap(this.chart, gen);
    this.hud.mount(this.minimap.root);
    const hull = design.hull;
    this.dock = new DockPanel({
      halfLength: (hull.length + hull.bowOverhang + hull.sternOverhang) / 2,
      halfBeam: this.ship.mooring.faceOffset - design.docking.gap,
      faceOffset: this.ship.mooring.faceOffset,
      capture: design.docking.capture,
    });
    this.hud.mount(this.dock.root);
    this.hud.mount(this.crosshair.root);
    this.builder = new DeckBuilder(this.models, this.model.group, this.ship.payload, this.shipSolids, this.player.interactions, this.crew, design.buildingEnabled);
    this.hud.mount(this.builder.ui.root);
    const allBerths = this.harbourLayouts.flatMap((l) => l.berths);
    this.minimap.setBerths(allBerths);
    this.chart.setBerths(allBerths);
    const ports = gen.sites.harbours ?? [];
    this.chart.setPorts(ports.map((h) => ({ name: h.name, x: h.pier.x, z: h.pier.z })));
    // named places, described from their terrain
    for (const i of gen.islands) {
      if (!i.name) continue;
      const kind = i.area > 4e6 ? (i.peak > 220 ? 'Mountainous island' : 'Island') : i.area > 6e5 ? 'Islet' : 'Rocky islet';
      this.islands.push({ name: i.name, x: i.cx, z: i.cz, r: Math.sqrt(i.area / Math.PI), kind });
    }
    if (ports.length) for (const h of ports) this.harbours.push({ x: h.harbour.x, z: h.harbour.z, name: `Harbour of ${h.name}` });
    else if (gen.islands[0]?.name) this.harbours.push({ x: gen.sites.harbour.x, z: gen.sites.harbour.z, name: `Harbour of ${gen.islands[0].name}` });


    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.advanceCloudWeather(0);
    this.sky.updateLighting(0, this.camera, true);
    this.updateCloudInputs(0);
    this.sky.updateEnvironment(0, true);
    this.scene.environment = this.sky.envMap;
    // sky irradiance relative to the sun (~1:4-5 on a clear Aegean day)
    this.scene.environmentIntensity = 0.85;
    T('done');
  }

  /** fixed deck furniture people bump into (ship-local) */
  private buildShipSolids() {
    if (this.design.kind === 'trireme') {
      const add = (x: number, s: number, r: number, h: number) =>
        this.shipSolids.add({ kind: 'cyl', cx: x, cz: this.design.hull.zOf(s), r, y0: this.design.deck.deckY(s), y1: this.design.deck.deckY(s) + h, surface: 'wood', walkTop: false });
      add(0, 0.42, 0.25, 11.5); // mast
      for (let i = 0; i < 8; i++) add((i < 4 ? -1 : 1) * 0.7, 0.47 + (i % 4) * 0.012, 0.2, 0.9); // amphorae
      // deck crew
      for (const [x, s] of [[1.05, 0.5], [-1.1, 0.53], [0.95, 0.38], [-1.0, 0.33], [0.8, 0.2], [-0.75, 0.17], [0.2, 0.12], [0.9, 0.66]]) add(x, s, 0.25, 1.75);
      const s = 0.905;
      this.shipSolids.add({ kind: 'box', cx: 0, cz: this.design.hull.zOf(s), hx: 0.8, hz: 0.25, rot: 0, y0: this.design.deck.deckY(0.9), y1: this.design.deck.deckY(0.9) + 0.45, surface: 'wood', walkTop: true });
      return;
    }
    // merchant: the mast and the crew's standing figures as solid cylinders. The spec's unbound
    // method references are wrapped: TableHull.zOf reads `this`, so it must be called as a method.
    const d = this.design;
    const deckY = (s: number) => d.deck.deckY(s);
    const zOf = (s: number) => d.hull.zOf(s);
    this.shipSolids.add({ kind: 'cyl', cx: 0, cz: zOf(d.rig.mastStation), r: 0.18, y0: deckY(d.rig.mastStation), y1: deckY(d.rig.mastStation) + d.rig.mastHeight, surface: 'wood', walkTop: false });
    // crew ships: the animated rowers replace the static stand-ins, so no fixed cylinders here
    // the deck figures' colliders, unless they are an animated crew's stand-ins (CrewSolids moves with the rowers)
    if (!(d.oars.system === 'crew' && d.oars.crew?.animated)) for (const [, x, s] of d.crewSpots) this.shipSolids.add({ kind: 'cyl', cx: x, cz: zOf(s), r: 0.25, y0: deckY(s), y1: deckY(s) + 1.75, surface: 'wood', walkTop: false });
  }

  resize() {
    this.pipeline.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * Put her straight into the docked state at a berth (a new start, or a loaded voyage): place her by her
   * design CG on the berth pose, attach lines and plank, settle, and stand the player on deck at the plank.
   */
  placeDocked(b: Berth, bowOut: boolean) {
    const ship = this.ship;
    const moor = ship.mooring;
    const p = moor.berthPose(b, { x: 0, z: 0 });
    ship.place(p.x, p.z, Math.atan2(b.ax, -b.az) + (bowOut ? 0 : Math.PI));
    // the berth pose is for the design CG; cargo may have moved the CG, so land that hull point on it
    const r = ship.refPoint(new THREE.Vector3());
    ship.pos.x += p.x - r.x;
    ship.pos.z += p.z - r.z;
    ship.prevPos.copy(ship.pos);
    moor.restoreDocked(b, bowOut);
    for (let i = 0; i < 240; i++) ship.step(SIM_DT);
    ship.vel.set(0, 0, 0);
    ship.angVel.set(0, 0, 0);
    const d = this.design;
    this.player.walker.placeOnDeck(new THREE.Vector3(0, d.deck.deckY(d.docking.plankS), d.hull.zOf(d.docking.plankS)));
  }

  /** the default start: docked at the main harbour, bow out (the merchant's voyage does this itself) */
  startInHarbour() {
    const b = this.harbourLayouts[0]?.berths[0];
    if (b && this.design.docking.enabled) this.placeDocked(b, true);
  }

  /** time-skip is allowed docked or lying to the anchor */
  get timeSkipAllowed() {
    const m = this.ship.mooring;
    return m.linePhase === 'docked' || m.anchorPhase === 'holding';
  }

  /** Change the game's time multiplier through the same mooring gate used by the time keys. */
  changeTimeSpeed(factor: number) {
    if (!this.timeSkipAllowed) {
      this.hud.showToast('Speed up time when docked or at anchor');
      return false;
    }
    this.clock.timeScale = Math.min(480, Math.max(1, this.clock.timeScale * factor));
    return true;
  }

  /** the ledger, a conversation or the personal menu owns the keyboard */
  get ledgerOpen() {
    return !!this.trade?.ledgerOpen;
  }

  /** the world is stopped: the settings sheet, or a conversation or the personal menu (the ledger stays live) */
  get worldStopped() {
    return this.paused || !!this.trade?.holdsWorld;
  }

  /** cargo and ports for a merchant: continue this world's saved voyage or start a new one docked at home */
  initTrade(world: { seed: number; heightmapSize: number },review=false): 'continue' | 'new' | 'rejected' | null {
    if (!this.design.cargo || !this.gen.sites.harbours?.length) return null;
    this.trade = new TradeLayer(this, this.gen, this.harbourLayouts, world,review);
    return this.trade.init();
  }


  /** Integrate weather once before evaluating this frame's light and capture inputs. */
  private advanceCloudWeather(dt: number) {
    this.clouds.coverage = 0.36 + 0.18 * noise1(this.clock.hours / 5 + this.simTime / 3000, 17);
    this.clouds.advanceWeather(dt, this.wind.vx, this.wind.vz);
  }

  /** Live clouds and environment captures share the same evaluated celestial light. */
  private updateCloudInputs(_dt: number) {
    const state = this.sky.lightingState;
    this.cloudAmbTop.fromArray(state.cloudAmbTopRGB);
    this.cloudAmbBottom.fromArray(state.cloudAmbBottomRGB);
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
    this.clouds.applyLighting(direct, this.cloudAmbTop, this.cloudAmbBottom, this.camera.position);
    return discontinuity;
  }

  /** Compile the settled and transition paths before the first playable frame. */
  async prepareLightingShaders() {
    const renderer = this.pipeline.renderer;
    const cameraLayerMask = this.camera.layers.mask;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderLayerMasks = [cameraLayerMask, 1 << LAYER_REFRACT];
    try {
      this.ocean.prepareEnvironmentTextures(renderer);
      // Scene draws happen into offscreen targets; Three keys those programs with
      // the working color space, while a null target uses the display output space.
      renderer.setRenderTarget(this.pipeline.refractTarget);
      for (const blending of [true, false]) {
        setEnvironmentShaderBlend(blending);
        for (const layerMask of renderLayerMasks) {
          this.camera.layers.mask = layerMask;
          renderer.domElement.dataset.shaderWarmup=`scene:${blending}:${layerMask}`;
          await renderer.compileAsync(this.scene, this.camera);
        }
        this.camera.layers.mask = cameraLayerMask;
        renderer.domElement.dataset.shaderWarmup=`reflection:${blending}`;
        await this.reflection.compileEnvironmentVariant(renderer, this.scene, this.camera);
        renderer.domElement.dataset.shaderWarmup=`clouds:${blending}`;
        await this.clouds.compileEnvironmentVariant(renderer);
      }
      renderer.domElement.dataset.shaderWarmup='ready';
    } finally {
      setEnvironmentShaderBlend(false);
      this.camera.layers.mask = cameraLayerMask;
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
    }
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
    if (inp.hit('KeyB')) {
      if (p.mode === 'build') p.mode = 'foot';
      else if (p.mode === 'foot' && p.walker.frame === 'ship') {
        if (this.design.buildingEnabled) p.mode = 'build';
        else this.hud.showToast("Building isn't available on the merchant ship yet");
      }
      else if (p.mode === 'foot') this.hud.showToast('Build on the ship deck');
    }
    if (p.mode === 'build' && p.walker.frame !== 'ship') p.mode = 'foot';
    if (inp.hit('KeyC') && p.mode !== 'build') p.cycleCamera();
    if (inp.hit('KeyQ')) p.toggleEagle(this.shipPos);
    if (inp.hit('KeyM')) this.chart.toggle();
    if (inp.hit('Slash') || inp.hit('F1')) this.hud.toggleHelp();
    if (inp.hit('KeyH')) this.hud.cycleDensity();
    if (inp.hit('F3') || inp.hit('Backquote')) this.hud.toggleDebug();
    if (inp.hit('KeyN')) this.audio.toggleMute();
    // time-skip only while docked or lying to the anchor (merchant plan §11.6)
    if (inp.hit('BracketRight')) this.changeTimeSpeed(2);
    if (inp.hit('BracketLeft')) this.changeTimeSpeed(0.5);
    if (inp.hit('KeyT')) {
      if (!this.timeSkipAllowed) this.hud.showToast('Speed up time when docked or at anchor');
      else {
          // jump to the next of dawn / midday / dusk / night; time only ever runs forward
          const marks = [5.6, 12.5, 19.3, 23.0];
          const h = this.clock.hours;
          const next = marks.find((m) => m > h + 0.05) ?? marks[0] + 24;
          this.clock.advanceHours(next - h);
          this.lightingJump = true;
      }
    }
    this.trade?.handleInput();
    // helm controls (orders are shouted from the helm; also allowed in chase view)
    const commanding = p.mode === 'helm' || (p.mode === 'chase' && p.prevShipMode === 'helm');
    const moor = this.ship.mooring;
    if (commanding) {
      if (inp.hit('KeyW') || inp.hit('KeyS')) {
        // docked the oars are shipped; on the lines or at anchor the crew can still row to help
        if (moor.linePhase === 'docked' || moor.linePhase === 'casting') this.hud.showToast('Docked · cast off first (R)');
        else this.crew.setOrder(this.crew.orderIndex + (inp.hit('KeyW') ? 1 : -1));
      }
      if (inp.hit('KeyR')) {
        if (!this.design.docking.enabled) this.hud.showToast(`Docking isn't available on the ${this.design.name.toLowerCase()}`);
        else if (moor.linePhase === 'casting') this.hud.showToast('Casting off');
        else if (moor.onLines) {
          if (!this.trade || this.trade.canCastOff()) moor.castOff();
        }
        else if (!moor.approach) this.hud.showToast('No berth in range');
        else moor.makeFast();
      }
      if (inp.hit('KeyZ')) {
        const ph = moor.anchorPhase;
        if (!this.design.anchoringEnabled) this.hud.showToast("This ship can't anchor");
        else if (ph === 'holding' || ph === 'dropping') moor.weighAnchor();
        else if (ph === 'weighing') this.hud.showToast('Weighing anchor');
        else if (ph === 'lifting') this.hud.showToast('Anchor coming up');
        else moor.dropAnchor();
      }
      if (inp.hit('KeyF') && (moor.linePhase === 'docked' || moor.linePhase === 'casting')) this.hud.showToast('Docked · cast off first (R)');
      else if (inp.hit('KeyF')) {
        if (this.ship.sailing.deploymentTarget > 0) {
          this.sailSelection = this.ship.sailing.deploymentTarget;
          this.ship.sailing.deploymentTarget = 0;
        } else {
          this.ship.sailing.deploymentTarget = this.sailSelection;
        }
      }
      if (inp.hit('KeyG')) {
        this.sailSelection = this.sailSelection > 0.75 ? 0.5 : 1;
        // Keep the selection while furled or brailing; a changed target remains lowered.
        if (this.ship.sailing.deploymentTarget > 0) this.ship.sailing.deploymentTarget = this.sailSelection;
      }
      const yardDirection = (inp.down('KeyL') ? 1 : 0) - (inp.down('KeyJ') ? 1 : 0);
      if (yardDirection !== 0) {
        const sailing = this.ship.sailing;
        if (sailing.trimMode !== 'manual') sailing.manualYardTarget = sailing.current.yardAngle;
        sailing.trimMode = 'manual';
        sailing.manualYardTarget = clamp(
          sailing.manualYardTarget + yardDirection * dt * 0.35,
          -this.ship.sailing.rig.maxYardAngle,
          this.ship.sailing.rig.maxYardAngle,
        );
      }
      if (inp.hit('KeyK')) this.ship.sailing.trimMode = 'auto';
      const steer = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
      this.steeringInput = steer !== 0 || inp.hit('KeyW') || inp.hit('KeyS');
      if (steer !== 0) this.ship.helm = clamp(this.ship.helm + steer * dt * 0.9, -1, 1);
      else if (inp.down('KeyX')) this.ship.helm *= Math.exp(-dt * 4);
      this.crew.holdWater = inp.down('Space');
    } else {
      this.steeringInput = false;
      this.crew.holdWater = false;
    }
    // helm self-centres slowly when not held (the steering oars trail in the flow)
    if (!(commanding && (inp.down('KeyA') || inp.down('KeyD')))) this.ship.helm *= Math.exp(-dt * 0.25);
  }

  /** mooring events, crew reactions, shipped oars, lines and plank visuals, harbour audio */
  private updateMooring(dt: number) {
    const moor = this.ship.mooring;
    for (const e of moor.drain()) {
      if (e.type === 'lines-out') {
        // the crew stops rowing and brails the sail; the captain can order a stroke to help her in
        this.audio.ropeThrow();
        this.crew.setOrder(ORDER_STOP);
        this.crew.holdWater = false;
        this.ship.sailTarget = 0;
        this.hud.showToast('Lines out');
      } else if (e.type === 'docked') {
        this.dock.showRating(e.rating, e.contactSpeed);
        this.hud.showToast('Docked · R to cast off');
        this.trade?.onDocked();
      } else if (e.type === 'haul-stalled') this.hud.showToast(e.reason);
      else if (e.type === 'haul-resumed') this.hud.showToast('Hauling in');
      else if (e.type === 'lines-eased') this.hud.showToast('Lines eased · too much strain');
      else if (e.type === 'casting-off') this.hud.showToast('Casting off');
      else if (e.type === 'cast-off') {
        this.audio.ropeThrow();
        this.hud.showToast('Cast off');
      } else if (e.type === 'bump') {
        this.audio.hullBump(clamp(e.speed / 2, 0.1, 1));
        this.player.addTrauma(e.speed / 2.5);
        this.dock.flashBump(e.speed);
      } else if (e.type === 'anchor-down') {
        this.audio.anchorDrop();
        this.crew.setOrder(ORDER_STOP);
        this.hud.showToast('Anchor down');
      } else if (e.type === 'anchor-weighing') {
        this.audio.anchorWeigh(3);
        this.hud.showToast('Weighing anchor');
      } else if (e.type === 'anchor-up') {
        this.hud.showToast('Anchor up');
      } else if (e.type === 'plank') this.audio.plank(e.down);
      else if (e.type === 'denied') {
        this.audio.buildDeny();
        // during an approach the dock gauges answer (the one out of band pulses); no sentence
        if (!this.dock.refuse()) this.hud.showToast(e.reason);
      }
    }
    // the crew won't let the ship wander off with the captain ashore or overboard
    if (this.player.walker.frame === 'world' && !moor.onLines && !moor.anchorOut) {
      if (this.crew.orderIndex !== ORDER_STOP) this.crew.setOrder(ORDER_STOP);
      if (this.design.anchoringEnabled && Math.hypot(this.ship.vel.x, this.ship.vel.z) < 1.2 && moor.dropAnchor(true)) this.hud.showNote('Anchor dropped while you are off the ship', 5);
    }
    // ship oars on the quay side for the last metres, both sides once she's tied up
    // docked: oars shipped, sail brailed, no orders (the ladder is locked at the keys)
    const docked = moor.linePhase === 'docked' || moor.linePhase === 'casting';
    if (docked) {
      if (this.crew.orderIndex !== ORDER_STOP) this.crew.setOrder(ORDER_STOP);
      if (this.ship.sailing.deploymentTarget > 0) this.ship.sailing.deploymentTarget = 0;
    }
    const a = moor.approach;
    const tied = moor.onLines;
    const side = tied ? moor.plank?.side ?? 1 : a?.side ?? 1;
    const quaySide = tied || (!!a && a.dist < 30 && Math.abs(a.lateral) < 6 && this.crew.orderIndex === ORDER_STOP);
    const si = side < 0 ? 0 : 1;
    this.model.oarStowTarget[si] = quaySide ? 1 : 0;
    this.model.oarStowTarget[1 - si] = docked ? 1 : 0;
    this.ship.rowing.setShipped(side < 0 ? -1 : 1, quaySide);
    this.ship.rowing.setShipped(side < 0 ? 1 : -1, docked);
    this.harbourRig.update(moor, this.model.group);
    const t = this.ship.time;
    this.berthMarker.exposure = this.sky.exposure;
    this.berthMarker.update(dt, moor, (x, z) => this.waves.heightAt(x, z, t), this.camera.position);
    const commanding = this.player.mode === 'helm' || (this.player.mode === 'chase' && this.player.prevShipMode === 'helm');
    this.dock.update(dt, moor, commanding, this.ship.heading);
    const onFoot = this.player.mode === 'foot' || this.player.mode === 'build';
    this.crosshair.update(onFoot && this.player.zoom < 0.3, !!this.player.interactions.target);
    this.updateBuilder(dt);
    let tension = 0;
    for (const l of moor.lines) tension = Math.max(tension, l.tension);
    this.audio.lineCreak(tension);
    let near = Infinity;
    for (const h of this.harbourLayouts) {
      const mx = h.root.x + h.dir.x * h.length * 0.6,
        mz = h.root.y + h.dir.y * h.length * 0.6;
      near = Math.min(near, Math.hypot(this.camera.position.x - mx, this.camera.position.z - mz));
    }
    this.audio.setHarbourProximity(clamp(1 - (near - 60) / 400, 0, 1));
    for (const e of this.player.feel.events) {
      if (e.type === 'step') this.audio.footstep(e.kind, e.intensity);
      else if (e.type === 'land') this.audio.land(e.kind, e.speed);
      else if (e.type === 'splash') this.audio.splash(e.size);
      else if (e.type === 'stroke') this.audio.swimStroke();
    }
  }

  private updateBuilder(dt: number) {
    const b = this.builder;
    const on = this.player.mode === 'build';
    if (b.active !== on) b.setActive(on);
    this.invShip.copy(this.model.group.matrixWorld).invert();
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const dir = this.camera.getWorldDirection(new THREE.Vector3()).add(eye);
    b.update(dt, {
      input: this.input,
      eyeLocal: eye.clone().applyMatrix4(this.invShip),
      dirLocal: dir.applyMatrix4(this.invShip).sub(eye.clone().applyMatrix4(this.invShip)).normalize(),
      night: this.sky.night,
      dayCount: this.clock.dayCount,
      cameraWorld: eye,
    });
    for (const e of b.events) {
      if (e.type === 'place') this.audio.buildPlace();
      else if (e.type === 'remove') this.audio.buildRemove();
      else if (e.type === 'deny') this.audio.buildDeny();
      else if (e.type === 'offering') this.hud.showToast('Crew stamina restored');
    }
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
    const stopped = this.worldStopped;
    if (!stopped) {
      if (this.cinematic) this.player.chaseYaw += dt * 0.035;
      else if (!this.ledgerOpen) {
        const previousMode = this.player.mode;
        this.handleInput(dt);
        cameraCut = this.player.mode !== previousMode;
      }
      if (this.clock.timeScale !== 1 && !this.timeSkipAllowed) this.clock.timeScale = 1;
      this.clock.update(dt);
      // one clock (sea-state spec §4.3): wind and sea advance by the simulated time of this frame's
      // fixed steps, so they stay on the ship's time through frame hitches
      let n = 0;
      for (let a = this.acc + dt; a >= SIM_DT && n < 12; a -= SIM_DT) n++;
      const simDt = n * SIM_DT;
      this.wind.update(simDt);
      this.waveRetarget -= simDt;
      if (this.waveRetarget <= 0) {
        this.waves.retarget(this.wind);
        this.fft.retarget(this.wind.meanSpeed, this.wind.from + Math.PI, this.waves.fetch);
        const wc = this.fft.whitecaps(this.wind.meanSpeed, this.waves.jVar);
        this.ocean.uniforms.uWhiteJ.value = wc.threshold;
        this.ocean.uniforms.uWhiteRamp.value = wc.ramp;
        this.seaState?.compose(this.wind.meanSpeed, this.wind.from, this.waves.swellFrom);
        this.waveRetarget = 1;
      }
      this.waves.update(simDt);
      this.seaState?.tick(simDt);
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
    // chase camera framing hints: steering input, turn rate (+ = to starboard), berth proximity
    const hints = this.player.chaseHints;
    hints.steering = this.steeringInput;
    hints.yawRate = -this.ship.angVel.y;
    const ap = this.ship.mooring.approach;
    const lp = this.ship.mooring.linePhase;
    hints.docking = ap && (lp === 'none' || lp === 'out' || lp === 'hauling') ? clamp((90 - ap.dist) / 50, 0, 1) : 0;
    // felt contact: shake only for real contact (grounding here, quay bumps in updateMooring); the
    // swell already moves the ship, and bowSlam is a column sum that runs high in an ordinary sea
    if (!stopped && !this.cinematic && this.ship.grounding > 0.02) this.player.addTrauma(Math.min(0.6, this.ship.grounding) * dt * 3);
    const sp = this.shipPose;
    sp.origin.copy(this.model.group.position);
    sp.quat.copy(this.shipQuat);
    sp.cgWorld.copy(this.shipPos);
    sp.vel.copy(this.ship.vel);
    sp.angVel.copy(this.ship.angVel);
    sp.plank = this.ship.mooring.plank;
    if (this.crewSolids && this.ship.rowing instanceof CrewRowing) this.crewSolids.update(this.ship.rowing.crewView, this.ship.rowing);
    this.player.update(dt, sp, this.walk, this.terrain, this.waves, this.ship.time);
    if(this.reviewCamera){this.camera.position.copy(this.reviewCamera.position);this.camera.lookAt(this.reviewCamera.target);this.camera.updateMatrixWorld(true);}
    if (!stopped) {
      this.updateMooring(dt);
      this.trade?.update();
    } else this.trade?.updateStopped();
    // world systems
    this.advanceCloudWeather(dt);
    this.sky.updateLighting(dt, this.camera, this.lightingJump);
    this.model.update(this.ship, this.crew, this.sky.night, this.ship.time, alpha);
    this.crewAnimator?.update(dt, alpha, this.ship);
    const lightingDiscontinuity = this.updateCloudInputs(dt);
    if (cameraCut || this.lightingJump || lightingDiscontinuity) this.clouds.resetHistory();
    const timed = present && fixedDt === undefined;
    this.pipeline.profileEnvironment = this.sky.environmentProfiler.enabled;
    if (timed) this.pipeline.beginGpuTimer();
    this.sky.updateEnvironment(dt, this.lightingJump, present);
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
    this.foam.update(stopped ? 0 : dt, this.ship, this.model, this.pipeline.renderer, this.ship.time - SIM_DT + alpha * SIM_DT, present && !stopped);
    this.oarWater.update(stopped ? 0 : dt, this.ship, this.model, this.waves, this.pipeline.renderer, this.ship.time - SIM_DT + alpha * SIM_DT, present && !stopped);

    const rt = this.pipeline.refractTarget;
    const size = this.pipeline.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.ocean.setRefraction(rt.texture, rt.depthTexture!, size.x, size.y, this.camera.near, this.camera.far);

    if (!present) return;
    if (this.clouds.enabled) {
      this.clouds.renderShadow(this.pipeline.renderer, this.camera.position);
    }
    this.pipeline.render(dt, () => {}, () => {
      if (this.reflection.enabled) {
        const r = this.pipeline.reflectSize;
        if (r.x !== this.reflection.target.width || r.y !== this.reflection.target.height) this.reflection.target.setSize(r.x, r.y);
        this.reflection.render(this.pipeline.renderer, this.scene, this.camera, [this.ocean.group, this.sky.group]);
      }
    });
    if (timed) this.pipeline.endGpuTimer();

    // audio & UI
    if (!stopped) this.audio.rowingEvents(this.ship.rowing, this.ship.time - SIM_DT + alpha * SIM_DT);
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
