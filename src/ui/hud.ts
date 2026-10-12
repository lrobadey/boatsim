import { KNOTS, clamp } from '../core/util';
import { Astrolabe } from './astrolabe';
import { SailDial, Telegraph, mountMaterials, addBezel } from './gauges';
import type { Game } from '../game';
import * as THREE from 'three';
// the draft and freeboard readout's style is in ledger.css (loaded here so the HUD never shows it unstyled)
import './ledger.css';

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
 * Sailing HUD: the sail dial bottom left and the oar telegraph bottom right (gauges.ts), speed and helm
 * bottom centre, heading tape top centre, sky dial top left; prompts, toasts and arrival moments centre.
 * Instruments show while they matter; in minimal density, steady readouts step back until they change.
 */
export class Hud {
  root = el('div', 'hud');
  density: HudDensity = 'minimal';
  private location = el('div', 'location');
  private ship = el('div', 'ship');
  private speedRow = el('div', 'speed-row');
  private speed = el('div', 'speed');
  private anchor = el('div', 'anchor-badge', `
  <svg class="ring" viewBox="0 0 34 34" aria-hidden="true"><circle class="track" cx="17" cy="17" r="15"/><circle class="prog" cx="17" cy="17" r="15"/></svg>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="4.8" r="2.1"/><path d="M12 6.9V20.6"/><path d="M7.6 10.2h8.8"/>
    <path d="M4.6 13.4c0 4.1 3.3 7.3 7.4 7.3s7.4-3.2 7.4-7.3"/>
    <path d="M4.6 13.4l-1.4 1.5M4.6 13.4l2 .5M19.4 13.4l1.4 1.5M19.4 13.4l-2 .5"/>
  </svg>`);
  private telegraph = new Telegraph();
  private sailDial: SailDial | null = null;
  private lastSpeed = NaN;
  private accel = 0;
  private tape = el('div', 'tape');
  private tapeCanvas = document.createElement('canvas');
  private hdg = el('div', 'hdg');
  private helm = el('div', 'helm', `<div class="turn"><i></i></div><div class="track"><div class="oar"></div><div class="needle"></div></div>`);
  private prompt = el('div', 'prompt');
  private debug = el('div', 'debug');
  private helpHint = el('div', 'help-hint', key('?'));
  private card = el('div', 'controls-card glass');
  private toast = el('div', 'toast');
  private note = el('div', 'note');
  private astroSlot = el('div', 'astro-slot');
  private astro = new Astrolabe();
  private noteT = 0;
  private toastT = 0;
  private toastText = '';
  private toastQ: string[] = [];
  private debugOn = false;
  private locName = '';
  private locT = 0;
  private hintT = 12;
  private lookAge = 0;
  private lastHdg = NaN;
  private yawRate = 0;
  private cache = new Map<string, string>();
  private fwd = new THREE.Vector3();
  // ui-text:begin
  /** draft and freeboard beside the speed (full density, merchant only) */
  private hullRead = el('div', 'hull-read', '<span></span><span></span>');
  private hullL = new THREE.Vector3();
  private hullW = new THREE.Vector3();
  private hullDraft = NaN;
  private hullFree = NaN;
  // ui-text:end

  constructor() {
    const ui = document.getElementById('ui')!;
    this.speedRow.append(this.speed, this.hullRead, this.anchor);
    this.anchor.setAttribute('role', 'img');
    this.ship.append(this.speedRow);
    this.tapeCanvas.width = TAPE_W * 2;
    this.tapeCanvas.height = TAPE_H * 2;
    this.tape.append(this.tapeCanvas, this.hdg);
    this.astroSlot.append(this.astro.root);
    addBezel(this.astro.root.querySelector('.astro-dial') as HTMLElement, 128);
    this.card.innerHTML = `
      <div class="card-title">Controls</div>
      <div><h4 class="label">At the helm</h4>
        <div>${key('W')}${key('S')} Stroke order</div>
        <div>${key('A')}${key('D')} Steer · ${key('X')} Centre</div>
        <div>${key('Space')} Hold water (brake)</div>
        <div>${key('F')} Raise / brail sail · ${key('G')} full / half</div>
        <div>${key('J')}${key('L')} Trim yard · ${key('K')} crew trim</div>
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
        <div>${key('I')} Hold book</div>
        <div>${key('[')}${key(']')} Time speed</div>
        <div>${key('T')} Skip to dawn, noon, dusk, night</div>
        <div>${key('H')} Interface: full, minimal, off</div>
        <div>${key('N')} Mute</div>
        <div>${key('Esc')} Pause and settings</div></div>`;
    for (const n of [this.ship, this.tape, this.helm]) n.dataset.p = '';
    this.root.append(this.location, this.telegraph.root, this.ship, this.tape, this.astroSlot, this.helm, this.prompt, this.debug, this.helpHint, this.card, this.toast, this.note);
    mountMaterials(this.root);
    ui.appendChild(this.root);
    try {
      const d = localStorage.getItem('trieres.hud') as HudDensity | null;
      if (d && DENSITIES.includes(d)) this.density = d;
    } catch {
      // storage unavailable: keep the default
    }
    this.applyDensity();
  }

  /** orders this crew can't be given (e.g. no ramming speed on a merchant ship) leave the telegraph */
  setMaxOrder(maxOrder: number) {
    this.telegraph.setMaxOrder(maxOrder);
  }

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

  /**
   * One toast line for 3 s. While a line shows, the next lines queue (at most 3); a line equal to the one
   * showing is dropped. Queued lines show in turn, each for its own 3 s.
   */
  showToast(text: string) {
    if (this.toastT > 0) {
      if (text !== this.toastText && this.toastQ.length < 3) this.toastQ.push(text);
      return;
    }
    this.showNow(text);
  }

  private showNow(text: string) {
    this.toastText = text;
    this.toast.textContent = text;
    this.toast.classList.add('on');
    this.toastT = 3;
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

    // speed with a trend caret: the quickest way to tell whether a change helped
    const a = Number.isNaN(this.lastSpeed) ? 0 : (ship.speed - this.lastSpeed) / Math.max(dt, 1e-3);
    this.lastSpeed = ship.speed;
    this.accel += (a - this.accel) * (1 - Math.exp(-dt / 1));
    const caret = this.accel > 0.02 ? 'up' : this.accel < -0.02 ? 'down' : '';
    this.set('spd', `${kn.toFixed(1)}|${caret}`, () => (this.speed.innerHTML = `${kn.toFixed(1)}<small>kn</small><i class="caret ${caret}"></i>`));
    this.updateHull(g, dt);
    const moor = g.ship.mooring;
    const phase = g.design.anchoringEnabled ? moor.anchorPhase : 'none';
    this.set('anc', phase, (v) => {
      this.anchor.dataset.phase = v;
      const label = v === 'stowed' ? 'Anchor stowed' : v === 'dropping' ? 'Letting go the anchor' : v === 'holding' ? 'Anchored' : v === 'weighing' ? 'Weighing anchor' : v === 'lifting' ? 'Anchor coming up' : '';
      this.anchor.setAttribute('aria-label', label);
      this.anchor.title = label;
    });
    const prog = phase === 'holding' ? 1 : phase === 'dropping' || phase === 'weighing' || phase === 'lifting' ? moor.anchorProgress : 0;
    this.set('ancp', prog.toFixed(3), (v) => this.anchor.style.setProperty('--p', v));
    this.steady(this.ship, ashore);

    // instruments: shown while commanding; the sail dial only with sail set
    if (!this.sailDial) {
      this.sailDial = new SailDial(g.design.kind === 'merchant' ? 'merchant' : 'trireme', g.design.rig.area);
      this.root.insertBefore(this.sailDial.root, this.telegraph.root);
    }
    this.sailDial.update(g, dt, commanding);
    this.telegraph.update(g, dt, commanding);

    // helm
    this.helm.classList.toggle('on', commanding);
    this.set('helm', (50 + ship.helm * 50).toFixed(1), (v) => ((this.helm.querySelector('.needle') as HTMLElement).style.left = `${v}%`));
    // where the steering oars actually are: they swing toward the helm at a limited rate
    const oar = -ship.rudderAngle / g.design.rudder.maxAngle;
    this.set('oar', (50 + clamp(oar, -1, 1) * 50).toFixed(1), (v) => ((this.helm.querySelector('.oar') as HTMLElement).style.left = `${v}%`));
    // rate of turn, starboard positive; smoothed over ~0.6 s so wave yaw doesn't hide the trend
    const yawDeg = (-ship.angVel.y * 180) / Math.PI;
    this.yawRate += (yawDeg - this.yawRate) * (1 - Math.exp(-dt / 0.6));
    const rot = Math.abs(this.yawRate);
    // square-root scale: the first fraction of a degree per second is visible, 8°/s fills the bar
    const bar = Math.sign(this.yawRate) * Math.min(1, Math.sqrt(rot / 8));
    this.set('rotbar', bar.toFixed(3), (v) => ((this.helm.querySelector('.turn i') as HTMLElement).style.transform = `scaleX(${v})`));

    // heading tape: the bow while commanding (a caret marks where you look), the view otherwise
    g.camera.getWorldDirection(this.fwd);
    const camHd = ((Math.atan2(this.fwd.x, -this.fwd.z) * 180) / Math.PI + 360) % 360;
    const hd = commanding ? (((ship.heading * 180) / Math.PI) % 360 + 360) % 360 : camHd;
    const look = commanding ? ((camHd - hd + 540) % 360) - 180 : 0;
    const turning = Number.isNaN(this.lastHdg) ? 0 : Math.abs(((hd - this.lastHdg + 540) % 360) - 180) / Math.max(dt, 1e-3);
    this.lastHdg = hd;
    this.lookAge = turning > 6 ? 0 : this.lookAge + dt;
    const relativeWind = g.wind.from - (hd * Math.PI / 180);
    const windOffset = Math.atan2(Math.sin(relativeWind), Math.cos(relativeWind));
    const windOn = g.wind.speed >= 0.3;
    this.drawTape(hd, windOffset * 180 / Math.PI, windOn, Math.abs(look) > 10 ? look : NaN);
    this.set('hdg', Math.round(hd % 360).toString().padStart(3, '0'), (v) => (this.hdg.textContent = `${v}°`));
    this.steady(this.tape, !commanding && this.lookAge > 5 && !windOn);

    this.astro.update(g);

    // contextual prompt
    let prompt = '';
    if (p.prompt) prompt = p.prompt;
    else if (p.mode === 'helm' && kn < 0.3 && g.crew.orderIndex === 1 && ship.sailTarget < 0.5 && !g.ship.mooring.onLines) prompt = `${key('W')} Row`;
    else if (p.mode === 'eagle') prompt = `${key('Q')} Back to ship · ${key('W')} Dive`;
    if (p.zoom > 0.5) prompt = '';
    if (ship.grounding > 0.05) prompt = '<span class="warn">Aground</span>';
    if (g.crew.exhausted) prompt = '<span class="warn">Rowers exhausted</span>';
    this.set('prompt', prompt, (v) => (this.prompt.innerHTML = v));

    this.toastT -= dt;
    if (this.toastT <= 0) {
      const next = this.toastQ.shift();
      if (next !== undefined) this.showNow(next);
      else this.toast.classList.remove('on');
    }
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
        sail load ${(ship.sailing.telemetry.load / 1000).toFixed(1)} kN · fill ${ship.sailing.current.fill.toFixed(2)} · yard ${((ship.sailing.current.yardAngle * 180) / Math.PI).toFixed(0)}°<br>
        Hs ${g.waves.hs.toFixed(2)} m · λp ${g.waves.peakLambda.toFixed(0)} m`;
    }
  }

  // ui-text:begin
  /**
   * Draft (the keel's depth below the water, amidships) and freeboard (the lower sheer above it), from the
   * physics each frame and smoothed over 2 s. Merchant only; the readout shows on the full HUD.
   */
  private updateHull(g: Game, dt: number) {
    const merchant = g.design.kind === 'merchant';
    if (this.hullRead.classList.contains('on') !== merchant) this.hullRead.classList.toggle('on', merchant);
    if (!merchant || this.density !== 'full') return;
    const ship = g.ship;
    const hull = g.design.hull;
    const waves = g.waves;
    const t = ship.time;
    const fmt = (v: number) => (v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' m';
    const keel = ship.toWorld(this.hullL.set(0, -hull.keelDepth(0.5), hull.zOf(0.5)), this.hullW);
    const draftNow = waves.heightAt(keel.x, keel.z, t) - keel.y;
    const z = hull.zOf(0.5);
    const hb = hull.halfBeam(0.5);
    const sheer = hull.sheer(0.5);
    let freeNow = Infinity;
    for (const x of [-hb, hb]) {
      const p = ship.toWorld(this.hullL.set(x, sheer, z), this.hullW);
      freeNow = Math.min(freeNow, p.y - waves.heightAt(p.x, p.z, t));
    }
    const k = 1 - Math.exp(-dt / 2);
    this.hullDraft = Number.isNaN(this.hullDraft) ? draftNow : this.hullDraft + (draftNow - this.hullDraft) * k;
    this.hullFree = Number.isNaN(this.hullFree) ? freeNow : this.hullFree + (freeNow - this.hullFree) * k;
    this.set('draft', fmt(this.hullDraft), (v) => (this.hullRead.children[0].textContent = 'Draft ' + v));
    this.set('free', fmt(this.hullFree), (v) => (this.hullRead.children[1].textContent = 'Freeboard ' + v));
  }
  // ui-text:end

  /** ticks every 5°, taller every 15°, compass points every 45°; terracotta lubber mark */
  private drawTape(hd: number, windOffset: number, windOn: boolean, look: number) {
    const k = `${Math.round(hd * 10) / 10}:${windOn ? Math.round(windOffset * 10) / 10 : 'off'}:${Number.isNaN(look) ? '' : Math.round(look)}`;
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
    if (windOn) {
      if (Math.abs(windOffset) <= span) {
        const x = mid + windOffset * PX_PER_DEG;
        c.strokeStyle = 'rgba(210,166,94,0.95)';
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(x - 3, 16);
        c.lineTo(x, 20);
        c.lineTo(x + 3, 16);
        c.stroke();
        c.fillStyle = 'rgba(210,166,94,0.9)';
        c.fillRect(Math.round(x), 21, 1, 7);
      } else {
        const drawEdge = (side: -1 | 1) => {
          const x = side < 0 ? 6 : TAPE_W - 6;
          c.strokeStyle = 'rgba(210,166,94,0.5)';
          c.lineWidth = 1.5;
          c.beginPath();
          if (side < 0) {
            c.moveTo(x + 3, 16);
            c.lineTo(x, 20);
            c.lineTo(x + 3, 24);
          } else {
            c.moveTo(x - 3, 16);
            c.lineTo(x, 20);
            c.lineTo(x - 3, 24);
          }
          c.stroke();
        };
        if (Math.abs(windOffset) > 175) {
          drawEdge(-1);
          drawEdge(1);
        } else {
          drawEdge(windOffset < 0 ? -1 : 1);
        }
      }
    }
    // where the camera looks, when it isn't along the bow: a hollow caret
    if (!Number.isNaN(look) && Math.abs(look) <= span) {
      const x = mid + look * PX_PER_DEG;
      c.strokeStyle = 'rgba(243,238,228,0.8)';
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(x - 4, TAPE_H);
      c.lineTo(x, TAPE_H - 6);
      c.lineTo(x + 4, TAPE_H);
      c.closePath();
      c.stroke();
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
