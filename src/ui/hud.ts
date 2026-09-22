import { ORDERS } from '../ship/crew';
import { KNOTS } from '../core/util';
import { Astrolabe } from './astrolabe';
import type { Game } from '../game';

const el = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const key = (k: string) => `<kbd>${k}</kbd>`;

/**
 * Minimal HUD: speed & stroke order (bottom left), helm (bottom centre), astrolabe (bottom right).
 * Controls surface contextually as keycaps next to the thing they operate; the full list lives
 * behind a single "?" card. A location title fades in when you near an island.
 */
export class Hud {
  root = el('div', 'hud');
  private brand = el('div', 'brand', 'ΤΡΙΗΡΗΣ');
  private location = el('div', 'location');
  private speed = el('div', 'speed');
  private orderRow = el('div', 'order-row');
  private order = el('span', 'order');
  private orderKeys = el('span', 'keys', `${key('W')}${key('S')}`);
  private pips = el('div', 'pips');
  private stamina = el('div', 'stamina', '<div class="fill"></div>');
  private sail = el('div', 'sail-state');
  private helm = el('div', 'helm', `<div class="needle"></div><span class="lbl">${key('A')} port</span><span class="lbl r">stbd ${key('D')}</span>`);
  private prompt = el('div', 'prompt');
  private debug = el('div', 'debug');
  private helpHint = el('div', 'help-hint', `${key('?')} controls`);
  private card = el('div', 'controls-card');
  private toast = el('div', 'toast');
  private note = el('div', 'note');
  private noteT = 0;
  private astro = new Astrolabe();
  private debugOn = false;
  private pipEls: HTMLElement[] = [];
  private toastT = 0;
  private lastOrder = -1;
  private locName = '';
  private locT = 0;
  private hintT = 12; // show the "?" hint for a while at start

  constructor() {
    const ui = document.getElementById('ui')!;
    const left = el('div', 'panel left');
    this.orderRow.append(this.order, this.orderKeys);
    left.append(this.speed, this.orderRow, this.pips, this.stamina, this.sail);
    for (let i = 0; i < ORDERS.length; i++) {
      const p = el('div', 'pip');
      p.title = ORDERS[i].name;
      this.pips.appendChild(p);
      this.pipEls.push(p);
    }
    const right = el('div', 'panel right');
    right.append(this.astro.root);
    this.card.innerHTML = `
      <div class="card-title">Controls</div>
      <div class="grp"><h4>At the helm</h4>
        <div>${key('W')}${key('S')} stroke order</div>
        <div>${key('A')}${key('D')} steering oars</div>
        <div>${key('Space')} hold water</div>
        <div>${key('F')} raise / brail sail</div>
        <div>${key('E')} leave the helm</div></div>
      <div class="grp"><h4>On deck</h4>
        <div>${key('W')}${key('A')}${key('S')}${key('D')} walk · ${key('Shift')} run</div>
        <div>${key('E')} take the helm (stern)</div>
        <h4>Look</h4>
        <div>Mouse · click to capture · ${key('←')}${key('→')}</div>
        <div>${key('RMB')} spyglass · wheel zoom (chase)</div>
        <div>${key('C')} chase view · ${key('Q')} Ikaros</div>
        <div>${key('M')} sea chart</div></div>
      <div class="grp"><h4>World</h4>
        <div>${key('[')}${key(']')} pass of time</div>
        <div>${key('T')} skip to dawn / noon / dusk / night</div>
        <div>${key('H')} hide interface · ${key('N')} mute</div>
        <div>${key('Esc')} pause & settings</div></div>`;
    this.root.append(this.brand, this.location, left, right, this.helm, this.prompt, this.debug, this.helpHint, this.card, this.toast, this.note);
    ui.appendChild(this.root);
  }

  /** add a widget that shows/hides with the HUD */
  mount(node: HTMLElement) {
    this.root.appendChild(node);
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }
  toggleDebug() {
    this.debugOn = !this.debugOn;
    this.debug.style.display = this.debugOn ? 'block' : 'none';
  }
  toggleHelp() {
    this.card.classList.toggle('open');
    this.hintT = 0;
  }
  /** a quiet one-line hint (italic, fades after a few seconds) */
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

  update(g: Game, frames: number[], dt: number) {
    this.root.classList.toggle('spy', g.player.zoom > 0.4);
    const ship = g.ship;
    const kn = ship.speed * KNOTS;
    this.speed.innerHTML = `${Math.abs(kn).toFixed(1)}<small>kn</small>`;
    const o = g.crew.order;
    this.order.textContent = g.crew.holdWater ? 'Hold Water' : o.name;
    this.pipEls.forEach((p, i) => p.classList.toggle('on', i === g.crew.orderIndex));
    (this.stamina.firstChild as HTMLElement).style.width = `${g.crew.stamina * 100}%`;
    this.stamina.classList.toggle('low', g.crew.stamina < 0.25);
    this.stamina.classList.toggle('active', g.crew.stamina < 0.995);
    this.sail.textContent = ship.sailTarget > 0.5 ? (ship.sailForce > 50 ? `Sail drawing · ${(ship.sailForce / 1000).toFixed(1)} kN` : 'Sail luffing') : '';

    const commanding = g.player.mode === 'helm' || (g.player.mode === 'chase' && g.player.prevShipMode === 'helm');
    this.helm.classList.toggle('on', commanding);
    this.orderKeys.classList.toggle('on', commanding);
    (this.helm.firstChild as HTMLElement).style.left = `${50 + ship.helm * 50}%`;

    this.astro.update(g);

    // contextual prompt
    let prompt = '';
    if (g.player.nearHelm) prompt = `${key('E')} take the helm`;
    else if (g.player.mode === 'helm' && Math.abs(kn) < 0.3 && g.crew.orderIndex === 1 && ship.sailTarget < 0.5) prompt = `${key('W')} order the rowers to pull`;
    else if (g.player.mode === 'eagle') prompt = `${key('Q')} return to the ship · ${key('W')} dive`;
    else if (g.player.zoom > 0.5) prompt = '';
    if (ship.grounding > 0.05) prompt = `<span class="warn">Aground</span> — back water ${key('S')}`;
    if (g.crew.exhausted) prompt = '<span class="warn">The rowers are spent</span>';
    if (this.prompt.innerHTML !== prompt) this.prompt.innerHTML = prompt;

    if (g.crew.orderIndex !== this.lastOrder) {
      if (this.lastOrder !== -1) this.showToast(o.name);
      this.lastOrder = g.crew.orderIndex;
    }
    this.toastT -= dt;
    if (this.toastT <= 0) this.toast.classList.remove('on');
    this.noteT -= dt;
    if (this.noteT <= 0) this.note.classList.remove('on');

    // "?" hint fades after a while
    this.hintT -= dt;
    this.helpHint.classList.toggle('dim', this.hintT <= 0);

    // location title (Odyssey style) when the nearest island changes
    const near = g.nearestIsland();
    const name = near && near.dist < 2600 ? near.name : '';
    if (name !== this.locName) {
      this.locName = name;
      if (name) {
        this.location.innerHTML = `<div class="loc-name">${name}</div><div class="loc-sub">${near!.kind}</div>`;
        this.location.classList.add('on');
        this.locT = 5;
      }
    }
    this.locT -= dt;
    if (this.locT <= 0) this.location.classList.remove('on');

    if (this.debugOn) {
      const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
      const info = g.pipeline.renderer.info;
      this.debug.innerHTML = `${(1000 / avg).toFixed(0)} fps · ${avg.toFixed(1)} ms<br>scale ${g.pipeline.renderScale.toFixed(2)} · ${g.pipeline.refreshRate.toFixed(0)} Hz<br>tris ${(info.render.triangles / 1e6).toFixed(2)}M<br>
        displ ${(ship.displacement / 1000).toFixed(1)} t · heel ${((ship.heel * 180) / Math.PI).toFixed(1)}° · pitch ${((ship.pitch * 180) / Math.PI).toFixed(1)}°<br>
        oar thrust ${(ship.oarThrust / 1000).toFixed(1)} kN · ${g.crew.rate.toFixed(0)} spm<br>
        Hs ${g.waves.hs.toFixed(2)} m · λp ${g.waves.peakLambda.toFixed(0)} m`;
    }
  }
}
