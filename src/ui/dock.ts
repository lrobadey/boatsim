import type { ApproachInfo, Mooring } from '../ship/mooring';
import type { DockingDesign } from '../ship/design';
import { KNOTS } from '../core/util';
import { MiniGauge } from './gauges';

const el = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/** what the panel needs to know about the ship */
export interface DockShape {
  halfLength: number;
  halfBeam: number;
  faceOffset: number;
  capture: DockingDesign['capture'];
}
const DEG = 180 / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// a rope loop and an anchor, for the key hints
const ROPE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 12 C3 5 13 5 13 9 C13 13 6 13 6 9 C6 6 10 6 11 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const ANCHOR = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="3" r="1.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.4V14 M5 7h6 M3 10.5c0 2.3 2.2 3.5 5 3.5s5-1.2 5-3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

/**
 * Docking instruments, top centre under the tape: shown at the helm when a berth is within 120 m or the ship
 * is on lines / at anchor. Three small round gauges (speed, distance off, angle), each against its capture
 * band; a hand outside its band turns red. No sentences: the distance to the berth is the only number,
 * the next key carries a small icon, and a refused R pulses the gauge that is out of its band.
 * Also the rating title card and the red bump vignette.
 */
export class DockPanel {
  readonly root = el('div', 'dock-root');
  private panel = el('div', 'dock');
  private dist = el('div', 'dock-dist');
  private gaugeRow = el('div', 'dock-gauges');
  private prog = el('div', 'dock-prog', '<i></i>');
  private cta = el('div', 'dock-cta');
  private gauges: { spd: MiniGauge; lat: MiniGauge; ang: MiniGauge };
  private bad = { spd: false, lat: false, ang: false };
  private approaching = false;
  private rating = el('div', 'dock-rating');
  private bump = el('div', 'dock-bump');
  private ratingT = 0;
  // last value written per field, so per-frame updates touch the DOM only on change
  private cache = new Map<string, string>();

  constructor(shape: DockShape) {
    const c = shape.capture;
    this.gauges = {
      spd: new MiniGauge('speed', 0, 6, 0, c.sog * KNOTS),
      lat: new MiniGauge('off', -3, 12, c.latMin, c.latMax),
      ang: new MiniGauge('ang', -60, 60, -c.head * DEG, c.head * DEG),
    };
    this.gaugeRow.append(this.gauges.spd.root, this.gauges.lat.root, this.gauges.ang.root);
    this.panel.append(this.dist, this.gaugeRow, this.prog, this.cta);
    this.root.append(this.panel, this.rating, this.bump);
    this.rating.append(el('div', 'r-name'), el('div', 'r-sub'));
  }

  /** true when the value is unchanged; otherwise records it, so the caller writes */
  private same(k: string, v: string) {
    if (this.cache.get(k) === v) return true;
    this.cache.set(k, v);
    return false;
  }

  /** once per frame; shipHeading is the ship's compass heading (rad, 0 = north, clockwise) */
  update(dt: number, mooring: Mooring, atHelm: boolean, shipHeading: number): void {
    if (this.ratingT > 0) {
      this.ratingT -= dt;
      if (this.ratingT <= 0) this.rating.classList.remove('on');
    }
    const a = mooring.approach;
    const lp = mooring.linePhase;
    const anchorOut = mooring.anchorOut;
    const show = atHelm && ((a !== null && a.dist <= 120) || lp !== 'none' || anchorOut);
    if (!this.same('show', String(show))) this.panel.classList.toggle('on', show);
    this.approaching = show && !!a && lp === 'none';
    if (!show) return;

    const dist = a && lp === 'none' ? `${Math.round(a.dist)} m` : '';
    if (!this.same('dist', dist)) this.dist.textContent = dist;
    if (!this.same('gauges', String(this.approaching))) this.gaugeRow.classList.toggle('on', this.approaching);
    if (a && this.approaching) this.approachView(a, shipHeading, mooring.docking.capture);

    let cta = '';
    let pulse = false;
    let prog = -1;
    if (lp === 'hauling') {
      cta = `<kbd>R</kbd>${ROPE}`;
      prog = mooring.warpProgress;
    } else if (lp === 'docked') cta = `<kbd>R</kbd>${ROPE}`;
    else if (lp === 'out' || lp === 'casting') cta = ROPE;
    else if (a && a.canMakeFast) {
      cta = `<kbd>R</kbd>${ROPE}`;
      pulse = true;
    }
    if (!cta && anchorOut) cta = mooring.anchorPhase === 'holding' ? `<kbd>Z</kbd>${ANCHOR}` : ANCHOR;
    if (!this.same('cta', cta)) this.cta.innerHTML = cta;
    if (!this.same('pulse', String(pulse))) this.cta.classList.toggle('pulse', pulse);
    // lines straining against a stall show as the bar holding still
    const progOn = prog >= 0;
    if (!this.same('prog', String(progOn))) this.prog.classList.toggle('on', progOn);
    if (progOn) {
      const w = `${(prog * 100).toFixed(1)}%`;
      if (!this.same('progw', w)) (this.prog.firstElementChild as HTMLElement).style.width = w;
      if (!this.same('stall', String(mooring.stalled))) this.prog.classList.toggle('stalled', mooring.stalled);
    }
  }

  private approachView(a: ApproachInfo, hd: number, cap: DockingDesign['capture']) {
    const b = a.berth;
    // bow direction in the berth frame: x = along the pier (+a, seaward), y = lateral (+n)
    const sn = Math.sin(hd);
    const cs = Math.cos(hd);
    const fa = sn * b.ax - cs * b.az;
    const fn = sn * b.nx - cs * b.nz;
    const phi = Math.atan2(fn, fa);
    const err = a.bowOut ? phi : wrap(phi - Math.PI); // signed error to the nearest allowed heading
    this.bad.spd = a.sog > cap.sog;
    this.bad.lat = a.lateral < cap.latMin || a.lateral > cap.latMax;
    this.bad.ang = Math.abs(err) > cap.head;
    this.gauges.spd.set(a.sog * KNOTS, this.bad.spd);
    this.gauges.lat.set(a.lateral, this.bad.lat);
    this.gauges.ang.set(err * DEG, this.bad.ang);
  }

  /** a refused R during an approach: pulse the gauges out of band instead of explaining; true if handled */
  refuse(): boolean {
    if (!this.approaching) return false;
    let any = false;
    for (const k of ['spd', 'lat', 'ang'] as const) {
      if (this.bad[k]) {
        this.gauges[k].pulse();
        any = true;
      }
    }
    return any;
  }

  /** centred title card: the rating word and the contact speed (m/s, shown in knots); fades after 4 s */
  showRating(rating: string, contactSpeed: number): void {
    const [name, sub] = [this.rating.children[0], this.rating.children[1]] as HTMLElement[];
    name.textContent = rating;
    sub.textContent = `${(contactSpeed * KNOTS).toFixed(1)} kn`;
    this.rating.classList.toggle('rough', /^Rough/.test(rating));
    this.rating.classList.add('on');
    this.ratingT = 4;
  }

  /** red edge vignette, scaled by the quay contact speed (m/s); under 1 m/s it does nothing */
  flashBump(speed: number): void {
    if (speed <= 1) return;
    const k = 0.2 + 0.7 * Math.min(1, Math.max(0, (speed - 1) / 3));
    this.bump.animate([{ opacity: k }, { opacity: 0 }], { duration: 500, easing: 'ease-out' });
  }
}

/**
 * Centre dot, 4 px at 55% bone; grows to a 14 px terracotta ring while an interactable is targeted.
 * Shown only in foot and build modes (the lead passes `visible`).
 */
export class Crosshair {
  readonly root = el('div', 'crosshair', '<i></i>');
  private on = false;
  private tgt = false;

  update(visible: boolean, targeted: boolean): void {
    if (visible !== this.on) {
      this.on = visible;
      this.root.classList.toggle('on', visible);
    }
    if (targeted !== this.tgt) {
      this.tgt = targeted;
      this.root.classList.toggle('target', targeted);
    }
  }
}
