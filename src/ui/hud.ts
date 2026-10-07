import { ORDERS } from '../ship/crew';
import { KNOTS } from '../core/util';
import { Astrolabe } from './astrolabe';
import type { Game } from '../game';
import * as THREE from 'three';

const el = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const key = (k: string) => `<kbd>${k}</kbd>`;

export type HudDensity = 'full' | 'minimal' | 'none';
const DENSITIES: HudDensity[] = ['full', 'minimal', 'none'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const TAPE_W = 360;
const TAPE_H = 34;
const PX_PER_DEG = 3;

/**
 * Sailing HUD: ship state bottom left (speed, stroke-order ladder, stamina, sail), heading tape top
 * centre, helm bottom centre, astrolabe bottom right; prompts, toasts and arrival moments centre.
 * In minimal density, readouts that have stopped changing step back until they change again.
 */
export class Hud {
  root = el('div', 'hud');
  density: HudDensity = 'minimal';
  private location = el('div', 'location');
  private ship = el('div', 'ship');
  private speed = el('div', 'speed');
  private ladder = el('div', 'ladder');
  private orderRow = el('div', 'order-row');
  private order = el('span', 'order');
  private orderKeys = el('span', 'order-keys', `${key('W')}${key('S')}`);
  private stamina = el('div', 'stamina', '<i></i>');
  private sail = el('div', 'sail-state');
  private tape = el('div', 'tape');
  private tapeCanvas = document.createElement('canvas');
  private hdg = el('div', 'hdg');
  private helm = el('div', 'helm', `<div class="track"><div class="needle"></div></div><div class="ends"><span class="label">${key('A')} Port</span><span class="label">Stbd ${key('D')}</span></div>`);
  private prompt = el('div', 'prompt');
  private debug = el('div', 'debug');
  private helpHint = el('div', 'help-hint', `${key('?')} Controls`);
  private card = el('div', 'controls-card glass');
  private toast = el('div', 'toast');
  private note = el('div', 'note');
  private astroSlot = el('div', 'astro-slot');
  private astro = new Astrolabe();
  private rungs: HTMLElement[] = [];
  private noteT = 0;
  private toastT = 0;
  private debugOn = false;
  private lastOrder = -1;
  private orderAge = 99;
  private sailText = '';
  private sailAge = 99;
  private locName = '';
  private locT = 0;
  private hintT = 12;
  private lookAge = 0;
  private lastHdg = NaN;
  private cache = new Map<string, string>();
  private fwd = new THREE.Vector3();

  constructor() {
    const ui = document.getElementById('ui')!;
    for (let i = 0; i < ORDERS.length; i++) {
      const r = el('i');
      if (i === ORDERS.length - 1) r.classList.add('ram');
      this.ladder.appendChild(r);
      this.rungs.push(r);
    }
    this.orderRow.append(this.order, this.orderKeys);
    this.ship.append(this.speed, this.ladder, this.orderRow, this.stamina, this.sail);
    this.tapeCanvas.width = TAPE_W * 2;
    this.tapeCanvas.height = TAPE_H * 2;
    this.tape.append(this.tapeCanvas, this.hdg);
    this.astroSlot.append(this.astro.root);
    this.card.innerHTML = `
      <div class="card-title">Controls</div>
      <div><h4 class="label">At the helm</h4>
        <div>${key('W')}${key('S')} Stroke order</div>
        <div>${key('A')}${key('D')} Steer · ${key('X')} Centre</div>
        <div>${key('Space')} Hold water (brake)</div>
        <div>${key('F')} Raise / lower sail</div>
        <div>${key('R')} Moor / cast off</div>
        <div>${key('Z')} Drop / raise anchor</div>
        <div>${key('E')} Leave the helm</div></div>
      <div><h4 class="label">On foot</h4>
        <div>${key('W')}${key('A')}${key('S')}${key('D')} Walk · ${key('Shift')} Run</div>
        <div>${key('Space')} Jump · swim up</div>
        <div>${key('E')} Use · take the helm</div>
        <div>${key('B')} Build on deck</div>
        <h4 class="label">Look</h4>
        <div>${key('←')}${key('→')}${key('↑')}${key('↓')} Look around</div>
        <div>${key('V')} Spyglass · ${key('−')}${key('=')} Zoom</div>
        <div>${key('C')} Chase camera · ${key('Q')} Eagle view</div></div>
      <div><h4 class="label">World</h4>
        <div>${key('M')} Map</div>
        <div>${key('[')}${key(']')} Time speed</div>
        <div>${key('T')} Skip to dawn, noon, dusk, night</div>
        <div>${key('H')} Interface: full, minimal, off</div>
        <div>${key('N')} Mute</div>
        <div>${key('Esc')} Pause and settings</div></div>`;
    for (const n of [this.ship, this.tape, this.helm, this.sail, this.ladder, this.orderRow, this.stamina]) n.dataset.p = '';
    this.root.append(this.location, this.ship, this.tape, this.astroSlot, this.helm, this.prompt, this.debug, this.helpHint, this.card, this.toast, this.note);
    ui.appendChild(this.root);
    try {
      const d = localStorage.getItem('trieres.hud') as HudDensity | null;
      if (d && DENSITIES.includes(d)) this.density = d;
    } catch {
      // storage unavailable: keep the default
    }
    this.applyDensity();
  }

  /** add a widget that shows/hides with the HUD */
  mount(node: HTMLElement) {
    this.root.appendChild(node);
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  /** H: full → minimal → off */
  cycleDensity() {
    this.density = DENSITIES[(DENSITIES.indexOf(this.density) + 1) % DENSITIES.length];
    try {
      localStorage.setItem('trieres.hud', this.density);
    } catch {
      // not persisted
    }
    this.applyDensity();
    this.showToast(this.density === 'full' ? 'Interface: full' : this.density === 'minimal' ? 'Interface: minimal' : 'Interface: off');
  }

  private applyDensity() {
    for (const d of DENSITIES) this.root.classList.toggle(d, this.density === d);
  }

  toggleDebug() {
    this.debugOn = !this.debugOn;
    this.debug.style.display = this.debugOn ? 'block' : 'none';
  }
  toggleHelp() {
    this.card.classList.toggle('open');
    this.hintT = 0;
  }
  /** one quiet line of guidance, fades after a few seconds */
  showNote(html: string, seconds = 6) {
    this.note.innerHTML = html;
    this.note.classList.add('on');
    this.noteT = seconds;
  }

  showToast(text: string) {
    this.toast.textContent = text;
    this.toast.classList.add('on');
    this.toastT = 1.8;
  }

  private set(k: string, v: string, apply: (v: string) => void) {
    if (this.cache.get(k) === v) return;
    this.cache.set(k, v);
    apply(v);
  }
  private steady(node: HTMLElement, on: boolean) {
    if (node.classList.contains('steady') !== on) node.classList.toggle('steady', on);
  }

  update(g: Game, frames: number[], dt: number) {
    this.root.classList.toggle('spy', g.player.zoom > 0.4);
    const ship = g.ship;
    const p = g.player;
    const commanding = p.mode === 'helm' || (p.mode === 'chase' && p.prevShipMode === 'helm');
    const ashore = (p.mode === 'foot' || p.mode === 'build') && p.walker.frame === 'world';
    const kn = Math.abs(ship.speed * KNOTS);

    // ship block
    this.set('spd', kn.toFixed(1), (v) => (this.speed.innerHTML = `${v}<small>kn</small>`));
    const o = g.crew.order;
    this.set('ord', g.crew.holdWater ? 'Hold water' : o.name, (v) => (this.order.textContent = v));
    if (g.crew.orderIndex !== this.lastOrder) {
      if (this.lastOrder !== -1) this.showToast(o.name);
      this.lastOrder = g.crew.orderIndex;
      this.orderAge = 0;
      this.rungs.forEach((r, i) => r.classList.toggle('on', i === g.crew.orderIndex));
    }
    this.orderAge = g.crew.holdWater ? 0 : this.orderAge + dt;
    this.orderKeys.classList.toggle('on', commanding);
    const stam = g.crew.stamina;
    this.set('stam', (stam * 100).toFixed(1), (v) => ((this.stamina.firstChild as HTMLElement).style.width = `${v}%`));
    this.stamina.classList.toggle('low', stam < 0.25);
    const sail = ship.sailTarget > 0.5 ? (ship.sailForce > 50 ? `Sail drawing · ${(ship.sailForce / 1000).toFixed(1)} kN` : 'Sail luffing') : '';
    if (sail.split('·')[0] !== this.sailText.split('·')[0]) this.sailAge = 0;
    this.sailText = sail;
    this.sailAge += dt;
    this.set('sail', sail, (v) => (this.sail.textContent = v));
    this.steady(this.ship, ashore);
    this.steady(this.ladder, this.orderAge > 4);
    this.steady(this.orderRow, this.orderAge > 4 && !commanding);
    this.steady(this.stamina, stam > 0.995);
    this.steady(this.sail, this.sailAge > 4);

    // helm
    this.helm.classList.toggle('on', commanding);
    this.set('helm', (50 + ship.helm * 50).toFixed(1), (v) => ((this.helm.querySelector('.needle') as HTMLElement).style.left = `${v}%`));

    // heading tape: where the camera looks (the ship's bow at the helm)
    g.camera.getWorldDirection(this.fwd);
    const hd = ((Math.atan2(this.fwd.x, -this.fwd.z) * 180) / Math.PI + 360) % 360;
    const turning = Number.isNaN(this.lastHdg) ? 0 : Math.abs(((hd - this.lastHdg + 540) % 360) - 180) / Math.max(dt, 1e-3);
    this.lastHdg = hd;
    this.lookAge = turning > 6 ? 0 : this.lookAge + dt;
    this.drawTape(hd);
    this.set('hdg', Math.round(hd % 360).toString().padStart(3, '0'), (v) => (this.hdg.textContent = `${v}°`));
    this.steady(this.tape, !commanding && this.lookAge > 5);

    this.astro.update(g);

    // contextual prompt
    let prompt = '';
    if (p.prompt) prompt = p.prompt;
    else if (p.mode === 'helm' && kn < 0.3 && g.crew.orderIndex === 1 && ship.sailTarget < 0.5 && g.ship.mooring.state === 'free') prompt = `${key('W')} Row`;
    else if (p.mode === 'eagle') prompt = `${key('Q')} Back to ship · ${key('W')} Dive`;
    if (p.zoom > 0.5) prompt = '';
    if (ship.grounding > 0.05) prompt = `<span class="warn">Aground</span> · ${key('S')} Back water`;
    if (g.crew.exhausted) prompt = '<span class="warn">Rowers exhausted</span>';
    this.set('prompt', prompt, (v) => (this.prompt.innerHTML = v));

    this.toastT -= dt;
    if (this.toastT <= 0) this.toast.classList.remove('on');
    this.noteT -= dt;
    if (this.noteT <= 0) this.note.classList.remove('on');
    this.hintT -= dt;
    this.helpHint.classList.toggle('dim', this.hintT <= 0);

    // arrival moment when the nearest named place changes
    const near = g.nearestIsland();
    const name = near && near.dist < 2600 ? near.name : '';
    if (name !== this.locName) {
      this.locName = name;
      if (name) {
        this.location.innerHTML = `<div class="loc-name">${name}</div><div class="loc-rule"></div><div class="loc-sub">${near!.kind}</div>`;
        this.location.classList.add('on');
        this.locT = 5;
      }
    }
    this.locT -= dt;
    if (this.locT <= 0) this.location.classList.remove('on');

    if (this.debugOn) {
      const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
      const info = g.pipeline.renderer.info;
      this.debug.innerHTML = `${(1000 / avg).toFixed(0)} fps · ${avg.toFixed(1)} ms<br>scale ${g.pipeline.renderScale.toFixed(2)} · ${g.pipeline.refreshRate.toFixed(0)} Hz · gpu ${g.pipeline.gpuMs.toFixed(1)} ms<br>tris ${(info.render.triangles / 1e6).toFixed(2)}M<br>
        displ ${(ship.displacement / 1000).toFixed(1)} t · heel ${((ship.heel * 180) / Math.PI).toFixed(1)}° · pitch ${((ship.pitch * 180) / Math.PI).toFixed(1)}°<br>
        oar thrust ${(ship.oarThrust / 1000).toFixed(1)} kN · ${g.crew.rate.toFixed(0)} spm<br>
        Hs ${g.waves.hs.toFixed(2)} m · λp ${g.waves.peakLambda.toFixed(0)} m`;
    }
  }

  /** ticks every 5°, taller every 15°, compass points every 45°; terracotta lubber mark */
  private drawTape(hd: number) {
    const k = Math.round(hd * 10) / 10;
    if (this.cache.get('tape') === String(k)) return;
    this.cache.set('tape', String(k));
    const c = this.tapeCanvas.getContext('2d')!;
    c.setTransform(2, 0, 0, 2, 0, 0);
    c.clearRect(0, 0, TAPE_W, TAPE_H);
    const mid = TAPE_W / 2;
    const span = mid / PX_PER_DEG;
    c.font = '600 11px "Inter Tight", system-ui, sans-serif';
    c.textAlign = 'center';
    c.shadowColor = 'rgba(0,0,0,0.45)';
    c.shadowBlur = 6;
    for (let d = Math.ceil((hd - span) / 5) * 5; d <= hd + span; d += 5) {
      const x = mid + (d - hd) * PX_PER_DEG;
      const fade = 1 - Math.pow(Math.abs(x - mid) / mid, 2);
      const deg = ((d % 360) + 360) % 360;
      const major = deg % 15 === 0;
      const point = deg % 45 === 0;
      c.fillStyle = `rgba(243,238,228,${(point ? 0.85 : major ? 0.55 : 0.32) * fade})`;
      c.fillRect(Math.round(x), point ? 18 : major ? 21 : 23, 1, point ? 10 : major ? 7 : 4);
      if (point) {
        c.fillStyle = deg === 0 ? `rgba(208,105,62,${fade})` : `rgba(243,238,228,${0.85 * fade})`;
        c.fillText(COMPASS[deg / 45], x, 12);
      }
    }
    c.shadowBlur = 0;
    c.fillStyle = '#d0693e';
    c.beginPath();
    c.moveTo(mid - 4, TAPE_H);
    c.lineTo(mid, TAPE_H - 6);
    c.lineTo(mid + 4, TAPE_H);
    c.fill();
  }
}
