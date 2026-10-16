import type * as THREE from 'three';
import { QUALITY, QualityName } from './core/quality';
import type { WorldGenRequest, WorldGenResult } from './world/worldgenTypes';
import { loadCachedWorld } from './core/worldCache';
import { loadStartupTextures, type StartupTextures } from './gfx/startupTextures';
import { worldRevision, textureUrl } from 'virtual:startup-assets';
import { DEFAULT_WIND_SPEED, Wind } from './world/wind';
import {installOrmosReview} from './world/ormosReview';
import {installCargoGameReview} from './cargoGameReview';
import {loadOrmosHarbour} from './world/ormosHarbour';
import { Game } from './game';
import { DESIGNS, chosenShipKind } from './ship/design';
import { RowingSystem } from './ship/rowing';
import { EMBLEM_SVG, MEANDER_SVG } from './ui/brand';
import { loadVisualAssets } from './gfx/assets';
import { loadModels } from './gfx/models';

const params = new URLSearchParams(location.search);
/** default preset from the GPU: Apple Pro/Max/Ultra silicon and discrete GPUs get ultra */
function detectQuality(): QualityName {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const r = String(info ? gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) : '');
    if (/Apple M\d+ (Pro|Max|Ultra)|RTX|Radeon RX|Arc A/i.test(r)) return 'ultra';
    if (/Apple M\d|GeForce|Radeon/i.test(r)) return 'high';
    return 'medium';
  } catch {
    return 'high';
  }
}
const qName = (params.get('q') as QualityName) || (localStorage.getItem('trieres.quality') as QualityName) || detectQuality();
const quality = QUALITY[qName] ?? QUALITY.high;
const seed = Number(params.get('seed') ?? 1729);
const dev = params.has('dev');
const storedShip = (() => { try { return localStorage.getItem('trieres.ship'); } catch { return null; } })();
const shipKind = chosenShipKind(location.search, storedShip);
const design = DESIGNS[shipKind];

const ui = document.getElementById('ui')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;

const loading = document.createElement('div');
loading.className = 'screen loading';
loading.innerHTML = `
  <div class="stack">
    ${EMBLEM_SVG}
    <div class="wordmark">ΤΡΙΗΡΗΣ</div>
    <div class="sub">${design.subtitle}</div>
    <div class="load-track"><div class="load-fill"></div></div>
    <div class="load-status">Loading</div>
  </div>`;
ui.appendChild(loading);
const fill = loading.querySelector('.load-fill') as HTMLElement;
const label = loading.querySelector('.load-status') as HTMLElement;

/** quality segmented control: the key is stored in data-q, the label is sentence case */
const qualitySeg = (seedValue: number | string, current: string) =>
  `<div class="seg" role="group" aria-label="Quality">${Object.keys(QUALITY)
    .map((k) => `<a href="?q=${k}&seed=${seedValue}&ship=${shipKind}" data-q="${k}" class="${k === current ? 'on' : ''}"${k === current ? ' aria-current="true"' : ''}>${k[0].toUpperCase()}${k.slice(1)}</a>`)
    .join('')}</div>`;

/** ship segmented control: picks the ship for the next load and remembers it */
const shipSeg = () => `<div class="seg ship-seg" role="group" aria-label="Ship">${(['trireme', 'merchant'] as const).map((k) => `<a href="?q=${quality.name}&seed=${seed}&ship=${k}" data-ship="${k}" class="${k === shipKind ? 'on' : ''}"${k === shipKind ? ' aria-current="true"' : ''}>${DESIGNS[k].name}</a>`).join('')}</div>`;

function generateWorld(request: WorldGenRequest): Promise<WorldGenResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world/worldgen.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        fill.style.width = `${Math.round(m.p * 85)}%`;
        label.textContent = m.label;
      } else if (m.type === 'done') {
        worker.terminate();
        resolve(m.result);
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
    worker.postMessage(request);
  });
}

function generateTextures(): Promise<StartupTextures> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./gfx/texgen.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage(null);
  });
}

async function startupWorld(): Promise<WorldGenResult> {
  const request: WorldGenRequest = { authoredHarbour: true, seed, size: quality.heightmapSize,
    worldSize: 12000, windFrom: new Wind(3).baseFrom, vegetationDensity: quality.vegetationDensity };
  const started = performance.now();
  let source = 'generated';
  const result = dev && params.get('startupCache') === 'off'
    ? await generateWorld(request)
    : await loadCachedWorld(request, worldRevision, () => generateWorld(request), { onStatus: status => { source = status; } });
  if (source === 'hit') { fill.style.width = '85%'; label.textContent = 'Loading the islands'; }
  if (dev) console.log('[startup] world', { source, ms: Math.round(performance.now() - started), revision: worldRevision });
  return result;
}

async function startupTextures(): Promise<StartupTextures> {
  const started = performance.now();
  let source = 'generated';
  const result = dev && params.get('startupCache') === 'off'
    ? await generateTextures()
    : await loadStartupTextures(`${import.meta.env.BASE_URL}${textureUrl.replace(/^\//, '')}`, generateTextures,
      { onStatus: status => { source = status; } });
  if (dev) console.log('[startup] textures', { source, ms: Math.round(performance.now() - started) });
  return result;
}

async function boot() {
  if (dev) console.log('[boot] start', performance.now().toFixed(0));
  const [gen, tex, assets] = await Promise.all([startupWorld(), startupTextures(), loadVisualAssets()]);
  const [models,ormos] = await Promise.all([loadModels(assets),loadOrmosHarbour(gen)]);
  if (dev) console.log('[boot] gen done', performance.now().toFixed(0));
  label.textContent = 'Preparing the ship';
  fill.style.width = '92%';
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(canvas, quality, gen, tex, assets, models, design,ormos);
  // cargo and ports (merchant): continue this world's saved voyage, or a new one docked at the main harbour
  const voyage = game.initTrade({ seed, heightmapSize: quality.heightmapSize },dev && ['ormosReview','sailingReview','rowingReview','cargoReview'].some(k=>params.has(k)));
  // every ship starts docked at the main harbour (the merchant's voyage has already placed her);
  // ?start=sea keeps the old start outside the harbour mouth
  if (!voyage && params.get('start') !== 'sea') game.startInHarbour();
  // ?wind=<m/s at 10 m> sets the prevailing wind; the sea starts fully developed for it.
  // 3 is light airs, 6 a gentle breeze, 12 the default meltemi, 16+ a near gale.
  const windParam = params.get('wind');
  const windSpeed = windParam === null || windParam.trim() === '' ? NaN : Number(windParam);
  // ?windFrom=<compass degrees> sets the prevailing wind's direction (the world itself is unchanged)
  const fromParam = params.get('windFrom');
  const windFrom = fromParam === null || fromParam.trim() === '' ? NaN : Number(fromParam);
  if (Number.isFinite(windSpeed)) game.wind.baseSpeed = Math.max(0, Math.min(20, windSpeed));
  if (Number.isFinite(windFrom)) game.wind.baseFrom = (((windFrom % 360) + 360) % 360) * (Math.PI / 180);
  if (Number.isFinite(windSpeed) || Number.isFinite(windFrom)) {
    game.wind.update(0);
    game.waves.retarget(game.wind);
    game.waves.update(Infinity);
    game.fft.retarget(game.wind.meanSpeed, game.wind.from + Math.PI, game.waves.fetch, true);
    game.seaState?.compose(game.wind.meanSpeed, game.wind.from, game.waves.swellFrom, true);
  }
  // ?debug=seastate tints the water by local wave size (blue calm, red exposed): a tuning aid
  if (params.get('debug') === 'seastate') game.ocean.uniforms.uSeaDebug.value = 1;
  if (dev && params.get('inspect') === 'harbour') {
    const h = gen.sites.harbour;
    const towardShore = gen.sites.pier.angle + Math.PI;
    game.player.mode = 'eagle';
    game.player.eaglePos.set(h.x, 18, h.z);
    game.player.eagleYaw = Math.atan2(-Math.cos(towardShore), -Math.sin(towardShore));
    game.player.eaglePitch = -0.1;
    game.player.eagleVel.set(0, 0, 0);
  }
  // dev: start 70 m off the first berth, bow toward it along the quay, for docking iteration
  if (dev && params.get('start') === 'berth') {
    // berth ids are global (harbour k owns 2k and 2k+1)
    const all = game.harbourLayouts.flatMap((l) => l.berths);
    const b = all[Number(params.get('berth') ?? 0)] ?? all[0];
    const off = Number(params.get('off') ?? 70);
    const x = b.cx + b.ax * off + b.nx * 4, z = b.cz + b.az * off + b.nz * 4;
    game.ship.place(x, z, Math.atan2(-b.ax, b.az));
    game.ship.step(1 / 120);
  }
  // Reproducible visual-review scenes; opt-in dev URL only, normal controls are unchanged.
  const rowingReview = dev ? params.get('rowingReview') : null;
  if (rowingReview && ['forward', 'back', 'hold', 'pivot', 'rest', 'transition'].includes(rowingReview)) {
    game.cinematic = true; game.player.mode = 'chase'; game.player.prevShipMode = 'helm';
    game.player.chaseYaw = 1.25; game.player.chasePitch = 0.34; game.player.chaseDist = 30;
    game.crew.setOrder(rowingReview === 'back' ? 0 : rowingReview === 'rest' || rowingReview === 'hold' ? 1 : 4);
    game.crew.holdWater = rowingReview === 'hold'; game.ship.helm = rowingReview === 'pivot' ? 1 : 0;
    game.clock.hours = 12.5; game.clock.compute();
    const reviewState = document.createElement('script');
    reviewState.type = 'application/json'; reviewState.id = 'rowing-review-state'; ui.appendChild(reviewState);
    const observeRowing = () => {
      if (rowingReview === 'transition') {
        const t = game.ship.time % 12;
        game.crew.setOrder(t < 4 ? 4 : t < 8 ? 0 : 1);
        game.crew.holdWater = t >= 8 && t < 10;
      }
      reviewState.textContent = JSON.stringify({ scenario: rowingReview, time: game.ship.time,
        speedKn: game.ship.speed * 1.943844, heading: game.ship.heading, heel: game.ship.heel,
        stamina: game.crew.stamina, rate: game.crew.rate, phase: game.crew.phase,
        sides: (game.ship.rowing instanceof RowingSystem ? game.ship.rowing.sides : []).map(s => ({ mode: s.mode, direction: s.direction, effort: s.effort })),
        rowing: game.ship.rowing.telemetry, gpuMs: game.pipeline.gpuMs,
        oarMeshes: game.model.group.children.filter(o => (o as THREE.InstancedMesh).isInstancedMesh && o.layers.isEnabled(1)).map(o => (o as THREE.InstancedMesh).count) });
      if (game.running) requestAnimationFrame(observeRowing);
    };
    requestAnimationFrame(observeRowing);
  }
  // Opt-in sailing acceptance: reproducible open-water setup plus DOM telemetry read-back.
  // These scenes preserve the normal input, rendering, waves and force integration paths.
  const sailingReview = dev ? params.get('sailingReview') : null;
  if (sailingReview && ['wind', 'row', 'combined', 'beam', 'headwind', 'calm'].includes(sailingReview)) {
    game.clock.hours = 12.5; game.clock.compute();
    game.player.mode = 'chase'; game.player.prevShipMode = 'helm';
    game.player.chaseYaw = 0.8; game.player.chasePitch = 0.26; game.player.chaseDist = 38;
    game.hud.density = 'full';
    game.hud.root.classList.remove('minimal', 'none');
    game.hud.root.classList.add('full');
    const requestedWind = params.get('sailingWind');
    const parsedWind = requestedWind === null || requestedWind.trim() === '' ? NaN : Number(requestedWind);
    const sailingWind = Number.isFinite(parsedWind) ? Math.max(0, Math.min(20, parsedWind)) : DEFAULT_WIND_SPEED;
    game.wind.baseSpeed = sailingReview === 'calm' ? 0 : sailingWind;
    game.wind.update(0);
    const heading = game.wind.from + (sailingReview === 'headwind' ? 0 : sailingReview === 'beam' ? Math.PI / 2 : Math.PI);
    const start = gen.sites.start;
    let reviewX = start.x, reviewZ = start.z, foundWater = false;
    for (let ring = 0; ring <= 8 && !foundWater; ring++) {
      for (let k = 0; k < 16 && !foundWater; k++) {
        const x = start.x + ring * 250 * Math.sin(k * Math.PI / 8);
        const z = start.z + ring * 250 * Math.cos(k * Math.PI / 8);
        let clear = true;
        for (const distance of [0, 100, 200, 400, 650]) for (const side of [-50, 0, 50]) {
          const px = x + Math.sin(heading) * distance + Math.cos(heading) * side;
          const pz = z - Math.cos(heading) * distance + Math.sin(heading) * side;
          if (game.terrain.heightAt(px, pz) > -15) clear = false;
        }
        if (clear) { reviewX = x; reviewZ = z; foundWater = true; }
      }
    }
    // A normal voyage begins tied up. Clear those lines through the real cast-off
    // path before relocating the acceptance ship, or the dock hold silently
    // overrides the sail and pulls an offshore review back toward its old berth.
    if(game.ship.mooring.onLines){game.ship.mooring.castOff();for(let i=0;i<720;i++)game.ship.step(1/120);game.ship.mooring.drain();}
    game.ship.place(reviewX, reviewZ, heading);
    game.crew.setOrder(['row', 'combined', 'calm'].includes(sailingReview) ? 4 : 1);
    game.ship.sailTarget = sailingReview === 'row' ? 0 : 1;
    // Prime only the same environmental and physics systems, without presenting frames.
    const requestedPrime = Number(params.get('sailingPrime') ?? 45);
    const prime = Number.isFinite(requestedPrime) ? Math.max(0, Math.min(120, requestedPrime)) : 45;
    for (let i = 0; i < Math.round(prime * 120); i++) {
      game.wind.update(1 / 120);
      if (i % 120 === 0) game.waves.retarget(game.wind);
      game.waves.update(1 / 120);
      game.ship.step(1 / 120);
    }
    const reviewState = document.createElement('script');
    reviewState.type = 'application/json'; reviewState.id = 'sailing-review-state'; ui.appendChild(reviewState);
    const observeSailing = () => {
      const s = game.ship, sail = s.sailing;
      reviewState.textContent = JSON.stringify({ scenario: sailingReview, foundWater, primeSeconds: prime,
        windBaseSpeed: game.wind.baseSpeed, windSpeed: game.wind.speed, windMeanSpeed: game.wind.meanSpeed,
        windFrom: game.wind.from, waveHs: game.waves.hs,
        time: s.time, speedKn: s.speed * 1.943844, heading: s.heading, heel: s.heel, leeway: s.leeway,
        grounding: s.grounding, stamina: game.crew.stamina, order: game.crew.order.name,
        deploymentTarget: sail.deploymentTarget, trimMode: sail.trimMode, manualYardTarget: sail.manualYardTarget,
        current: sail.current, previous: sail.previous, sail: sail.telemetry,
        visual: game.model.sailingVisualState(), rowing: s.rowing.telemetry,
        wetBlades: Array.from(s.rowing.current.wetArea).filter(a => a > 0).length,
        hud: game.hud.density, playerMode: game.player.mode, zoom: game.player.zoom,
        gpuMs: game.pipeline.gpuMs, drawCalls: game.pipeline.renderer.info.render.calls,
        finite: [...s.pos.toArray(), ...s.vel.toArray(), ...s.angVel.toArray(), sail.telemetry.load].every(Number.isFinite) });
      if (game.running || loading.isConnected) requestAnimationFrame(observeSailing);
    };
    requestAnimationFrame(observeSailing);
  }
  if(dev && params.has('ormosReview'))installOrmosReview(game,gen,ormos,params.get('ormosReview')??'overview');
  (window as any).game = game;
  if (dev) console.log('[boot] game built', performance.now().toFixed(0));
  fill.style.width = '100%';
  await game.prepareLightingShaders();
  game.start();
  if (dev && params.get('cargoReview') === '1' && shipKind === 'merchant') installCargoGameReview(game);
  // dev server only (the launcher runs one): F9 records a performance capture into profiles/
  if (import.meta.env.DEV) void import('./core/frameProfiler').then((m) => m.installFrameProfiler(game));
  // warm up shaders a frame before revealing
  await new Promise((r) => setTimeout(r, 250));
  loading.remove();

  const mainIsland = gen.islands[0]?.name || 'the island';
  const title = document.createElement('div');
  title.className = 'screen title-screen';
  title.innerHTML = `
    <div class="scrim"></div>
    <div class="stack">
      <div class="wordmark">ΤΡΙΗΡΗΣ</div>
      <div class="sub">${design.subtitle}</div>
      ${MEANDER_SVG}
      ${shipSeg()}
      <div class="actions">
        ${voyage === 'continue' ? '<button class="pill primary board">Continue voyage</button><button class="pill ghost new-voyage">New voyage</button>' : '<button class="pill primary board">Set sail</button>'}
        <button class="pill ghost open-settings">Settings</button>
      </div>
    </div>
    <div class="foot">
      <div class="keys">
        <span><kbd>W</kbd><kbd>S</kbd> Speed</span>
        <span><kbd>A</kbd><kbd>D</kbd> Steer</span>
        <span><kbd>←</kbd><kbd>→</kbd> Look</span>
        <span><kbd>?</kbd> Controls</span>
      </div>
      ${qualitySeg(seed, quality.name)}
      <a class="new-island" href="?q=${quality.name}&seed=${Math.floor(Math.random() * 99999)}&ship=${shipKind}">New archipelago</a>
    </div>`;
  if (!dev) {
    ui.appendChild(title);
    // cinematic orbit behind the title
    game.hud.setVisible(false);
    game.cinematic = true;
    game.player.prevShipMode = 'helm';
    game.player.mode = 'chase';
    game.player.chaseYaw = 2.4;
    game.player.chasePitch = 0.09;
    game.player.chaseDist = design.camera.titleDist;
    game.player.chaseLift = design.camera.titleLift;
  } else game.hud.setVisible(params.get('hud') === '1');

  const pause = document.createElement('div');
  pause.className = 'screen pause';
  pause.innerHTML = `
    <div class="scrim"></div>
    <div class="card glass">
      <h2 class="sheet-title">Paused</h2>
      <div class="rows">
        <label class="row"><span>Mouse look</span><input type="checkbox" class="switch" data-k="mouselook"></label>
        <label class="row" data-dep="mouselook"><span>Mouse sensitivity</span><input type="range" min="0.4" max="2.5" step="0.05" value="1" data-k="sens"></label>
        <label class="row"><span>Look speed</span><input type="range" min="0.5" max="2" step="0.05" value="1" data-k="lookspeed"></label>
        <label class="row"><span>Volume</span><input type="range" min="0" max="1" step="0.05" value="0.8" data-k="vol"></label>
        <label class="row"><span>Horizon levelling</span><input type="range" min="0" max="1" step="0.05" value="0.75" data-k="level"></label>
        <label class="row"><span>Field of view</span><input type="range" min="55" max="95" step="1" value="70" data-k="fov"></label>
        <label class="row"><span>Adaptive resolution</span><input type="checkbox" class="switch" checked data-k="adapt"></label>
        <label class="row"><span>Invert Y</span><input type="checkbox" class="switch" data-k="invert"></label>
        <div class="row"><span>Quality</span>${qualitySeg(seed, quality.name)}</div>
      </div>
      <div class="card-foot"><button class="pill primary resume">Resume</button></div>
    </div>`;
  pause.style.display = 'none';
  ui.appendChild(pause);
  // mouse look is opt-in and remembered; the keyboard (arrows) looks by default
  let mouseLookOn = false;
  try {
    mouseLookOn = localStorage.getItem('trieres.mouseLook') === '1';
  } catch {
    // storage unavailable: the default stands
  }
  game.input.mouseLook = mouseLookOn;
  const mouseLookBox = pause.querySelector('[data-k="mouselook"]') as HTMLInputElement;
  mouseLookBox.checked = mouseLookOn;
  // range fill: --r is the thumb position as a 0..1 fraction, the track gradient reads it
  const paintRange = (inp: HTMLInputElement) => {
    const lo = Number(inp.min), hi = Number(inp.max);
    inp.style.setProperty('--r', String((Number(inp.value) - lo) / (hi - lo)));
  };
  // sensitivity only means something with mouse look on, so its row goes dim while it is off
  const syncMouseDeps = () => {
    const on = mouseLookBox.checked;
    pause.querySelectorAll<HTMLElement>('[data-dep="mouselook"]').forEach((row) => {
      row.classList.toggle('off', !on);
      row.querySelectorAll('input').forEach((i) => (i.disabled = !on));
    });
  };
  pause.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(paintRange);
  syncMouseDeps();
  pause.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.k;
      const v = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : Number(inp.value);
      if (inp.type === 'range') paintRange(inp);
      if (k === 'sens') game.input.sensitivity = 0.0022 * v;
      if (k === 'vol') game.audio.setVolume(v);
      if (k === 'level') game.player.levelFactor = v;
      if (k === 'fov') game.player.baseFov = v;
      if (k === 'adapt') game.pipeline.adaptive = !!v;
      if (k === 'invert') game.input.invertY = !!v;
      if (k === 'lookspeed') game.input.lookSpeed = v;
      if (k === 'mouselook') {
        game.input.mouseLook = !!v;
        try {
          localStorage.setItem('trieres.mouseLook', v ? '1' : '0');
        } catch {
          // not persisted
        }
        if (!v && game.input.locked) document.exitPointerLock();
        syncMouseDeps();
      }
    });
  });
  // quality links keep their hrefs and remember the choice; only the data-q links count
  pause.querySelectorAll<HTMLAnchorElement>('a[data-q]').forEach((a) => a.addEventListener('click', () => localStorage.setItem('trieres.quality', a.dataset.q!)));
  title.querySelectorAll<HTMLAnchorElement>('a[data-q]').forEach((a) => a.addEventListener('click', () => localStorage.setItem('trieres.quality', a.dataset.q!)));
  title.querySelectorAll<HTMLAnchorElement>('a[data-ship]').forEach((a) => a.addEventListener('click', () => { try { localStorage.setItem('trieres.ship', a.dataset.ship!); } catch {} }));

  // Starting the voyage is independent of pointer lock: if the browser refuses the lock, the view
  // follows plain mouse movement (and click-drag) instead.
  let started = false;
  // one settings card serves two entry points: the pause menu (Resume) and the title (Back)
  const heading = pause.querySelector('.sheet-title') as HTMLElement;
  const resumeBtn = pause.querySelector('.resume') as HTMLButtonElement;
  let settingsFrom: 'pause' | 'title' = 'pause';
  const showSettings = (from: 'pause' | 'title') => {
    settingsFrom = from;
    heading.textContent = from === 'title' ? 'Settings' : 'Paused';
    resumeBtn.textContent = from === 'title' ? 'Back' : 'Resume';
    if (from === 'title') title.style.display = 'none';
    pause.style.display = '';
  };
  const closeTitleSettings = () => {
    pause.style.display = 'none';
    title.style.display = '';
  };
  const setPaused = (p: boolean) => {
    game.paused = p;
    if (p) showSettings('pause');
    else pause.style.display = 'none';
  };
  const begin = () => {
    if (!started) {
      started = true;
      title.remove();
      if (game.cinematic) {
        game.cinematic = false;
        game.player.mode = 'helm';
        game.player.chaseLift = 0;
        game.player.chaseDist = design.camera.chaseDist;
        game.hud.setVisible(true);
      }
    }
    setPaused(false);
  };
  const board = () => {
    game.audio.init();
    begin();
    game.input.lock();
  };
  title.querySelector('.board')!.addEventListener('click', board);
  title.querySelector('.new-voyage')?.addEventListener('click', () => {
    game.trade?.newVoyage();
    board();
  });
  title.querySelector('.open-settings')!.addEventListener('click', () => showSettings('title'));
  resumeBtn.addEventListener('click', () => (settingsFrom === 'title' ? closeTitleSettings() : board()));
  // a click starts or resumes the voyage (and retries the lock); while playing without the lock it is
  // left to the game, where LMB places pieces in build mode and drags the view
  canvas.addEventListener('click', () => {
    if (!game.input.locked && !game.cinematic && (!started || game.paused)) board();
  });
  game.input.onLockChange = (locked) => {
    if (locked) begin();
    else if (started && !game.input.hoverLook) setPaused(true); // Esc released the mouse
  };
  window.addEventListener('keydown', (e) => {
    // the ledger closes itself on Esc (and marks the event handled); it never opens the pause menu
    if (e.code !== 'Escape' || e.defaultPrevented || game.ledgerOpen) return;
    if (settingsFrom === 'title' && pause.style.display !== 'none') closeTitleSettings();
    // without pointer lock, Esc toggles the pause menu itself
    else if (started && !game.input.locked) setPaused(!game.paused);
  });
}

boot().catch((e) => {
  console.error(e);
  label.textContent = 'Could not start: ' + (e?.message ?? e);
});
