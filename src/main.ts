import { QUALITY, QualityName } from './core/quality';
import type { WorldGenResult } from './world/worldgenTypes';
import { Wind } from './world/wind';
import { Game } from './game';
import { EMBLEM_SVG, MEANDER_SVG } from './ui/brand';

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

const ui = document.getElementById('ui')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;

const loading = document.createElement('div');
loading.className = 'screen loading';
loading.innerHTML = `
  ${EMBLEM_SVG}
  <div class="title">ΤΡΙΗΡΗΣ</div>
  <div class="subtitle">an Aegean trireme</div>
  <div class="bar"><div class="fill"></div></div>
  <div class="label">Consulting the oracle…</div>`;
ui.appendChild(loading);
const fill = loading.querySelector('.fill') as HTMLElement;
const label = loading.querySelector('.label') as HTMLElement;

function generate(): Promise<WorldGenResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./world/worldgen.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        fill.style.width = `${Math.round(m.p * 85)}%`;
        label.textContent = m.label + '…';
      } else if (m.type === 'done') {
        worker.terminate();
        resolve(m.result);
      }
    };
    worker.onerror = (e) => reject(e);
    const wind = new Wind(3);
    worker.postMessage({ seed, size: quality.heightmapSize, worldSize: 12000, windFrom: wind.baseFrom, vegetationDensity: quality.vegetationDensity });
  });
}

function textures(): Promise<{ noise: Uint8Array; ripple: Uint8Array; cloudShape: Uint8Array; cloudDetail: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./gfx/texgen.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      resolve(e.data);
    };
    w.onerror = reject;
    w.postMessage(null);
  });
}

async function boot() {
  if (dev) console.log('[boot] start', performance.now().toFixed(0));
  const texP = textures();
  const gen = await generate();
  const tex = await texP;
  if (dev) console.log('[boot] gen done', performance.now().toFixed(0));
  label.textContent = 'Fitting out the ship…';
  fill.style.width = '92%';
  await new Promise((r) => setTimeout(r, 30));
  const game = new Game(canvas, quality, gen, tex);
  (window as any).game = game;
  if (dev) console.log('[boot] game built', performance.now().toFixed(0));
  fill.style.width = '100%';
  game.start();
  // warm up shaders a frame before revealing
  await new Promise((r) => setTimeout(r, 250));
  loading.remove();

  const mainIsland = gen.islands[0]?.name || 'the island';
  const title = document.createElement('div');
  title.className = 'screen title-screen';
  title.innerHTML = `
    ${EMBLEM_SVG}
    <div class="title">ΤΡΙΗΡΗΣ</div>
    <div class="subtitle">You command a trireme off the harbour of ${mainIsland}.</div>
    ${MEANDER_SVG}
    <button class="board">Board the ship</button>
    <div class="essentials">
      <span><kbd>W</kbd><kbd>S</kbd> stroke order</span>
      <span><kbd>A</kbd><kbd>D</kbd> steer</span>
      <span><kbd>E</kbd> helm / deck</span>
      <span><kbd>?</kbd> all controls</span>
    </div>
    <div class="quality">
      ${Object.keys(QUALITY).map((k) => `<a href="?q=${k}&seed=${seed}" class="${k === quality.name ? 'on' : ''}">${k}</a>`).join('')}
      &nbsp;·&nbsp; <a href="?q=${quality.name}&seed=${Math.floor(Math.random() * 99999)}">new archipelago</a>
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
    game.player.chaseDist = 58;
    game.player.chaseLift = 13;
  } else game.hud.setVisible(params.get('hud') === '1');

  const pause = document.createElement('div');
  pause.className = 'screen pause';
  pause.innerHTML = `
    <div class="title small">Paused</div>
    ${MEANDER_SVG}
    <button class="resume">Resume</button>
    <div class="settings">
      <label>Mouse sensitivity <input type="range" min="0.4" max="2.5" step="0.05" value="1" data-k="sens"></label>
      <label>Volume <input type="range" min="0" max="1" step="0.05" value="0.8" data-k="vol"></label>
      <label>Horizon leveling <input type="range" min="0" max="1" step="0.05" value="0.6" data-k="level"></label>
      <label>Field of view <input type="range" min="55" max="95" step="1" value="70" data-k="fov"></label>
      <label>Adaptive resolution <input type="checkbox" checked data-k="adapt"></label>
      <label>Invert Y <input type="checkbox" data-k="invert"></label>
    </div>
    <div class="quality">Quality:
      ${Object.keys(QUALITY).map((k) => `<a href="?q=${k}&seed=${seed}" class="${k === quality.name ? 'on' : ''}">${k}</a>`).join(' ')}
    </div>`;
  pause.style.display = 'none';
  ui.appendChild(pause);
  pause.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.k;
      const v = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : Number(inp.value);
      if (k === 'sens') game.input.sensitivity = 0.0022 * v;
      if (k === 'vol') game.audio.setVolume(v);
      if (k === 'level') game.player.levelFactor = v;
      if (k === 'fov') game.player.baseFov = v;
      if (k === 'adapt') game.pipeline.adaptive = !!v;
      if (k === 'invert') game.input.invertY = !!v;
    });
  });
  document.querySelectorAll('.quality a').forEach((a) => a.addEventListener('click', () => localStorage.setItem('trieres.quality', (a as HTMLAnchorElement).textContent!)));

  // Starting the voyage is independent of pointer lock: if the browser refuses the lock, the view
  // follows plain mouse movement (and click-drag) instead.
  let started = false;
  const setPaused = (p: boolean) => {
    game.paused = p;
    pause.style.display = p ? '' : 'none';
  };
  const begin = () => {
    if (!started) {
      started = true;
      title.remove();
      if (game.cinematic) {
        game.cinematic = false;
        game.player.mode = 'helm';
        game.player.chaseLift = 0;
        game.player.chaseDist = 42;
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
  pause.querySelector('.resume')!.addEventListener('click', board);
  canvas.addEventListener('click', () => {
    if (!game.input.locked && !game.cinematic) board();
  });
  game.input.onLockChange = (locked) => {
    if (locked) begin();
    else if (started && !game.input.hoverLook) setPaused(true); // Esc released the mouse
  };
  window.addEventListener('keydown', (e) => {
    // without pointer lock, Esc toggles the pause menu itself
    if (e.code === 'Escape' && started && !game.input.locked) setPaused(!game.paused);
  });
}

boot().catch((e) => {
  console.error(e);
  label.textContent = 'Failed to start: ' + (e?.message ?? e);
});
