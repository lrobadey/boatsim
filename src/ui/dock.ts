import type { ApproachInfo, Mooring } from '../ship/mooring';
import { KNOTS } from '../core/util';

const el = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

// plan view: isotropic so the ship's angle reads true; pier is the stone bar across the top.
// Distance along the quay is compressed past 12 m so the hull stays in frame on the run-in.
const S = 2.2; // px per metre
const PW = 140; // plan width (px)
const PH = 76;
const X0 = PW / 2; // plan x of the berth centre
const Y0 = 30; // plan y of the berth centre line (ship lateral 0, snug alongside)
const squash = (a: number) => Math.sign(a) * (Math.abs(a) < 12 ? Math.abs(a) : 12 + 9 * Math.log1p((Math.abs(a) - 12) / 9));
const xOf = (along: number) => X0 + along * S;
const yOf = (lat: number) => Y0 + lat * S;
const HULL = 'M18.5 0 L14 -2.65 L-17 -2.65 L-18.5 -1.8 L-18.5 1.8 L-17 2.65 L14 2.65 Z';
const DEG = 180 / Math.PI;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// rounds first so a value that displays as zero never carries a sign
const signed = (v: number, d: number) => {
  const t = Math.abs(v).toFixed(d);
  return Number(t) === 0 ? t : `${v > 0 ? '+' : '−'}${t}`;
};

// gauge scale and target band (lo/hi = scale ends, blo/bhi = band)
const GAUGES = [
  { k: 'spd', label: 'Speed', lo: 0, hi: 6, blo: 0, bhi: 2.5 },
  { k: 'lat', label: 'Distance off', lo: -3, hi: 12, blo: -0.8, bhi: 4 },
  { k: 'ang', label: 'Angle', lo: -60, hi: 60, blo: -15, bhi: 15 },
];

/**
 * Docking card, bottom centre above the helm bar: shown at the helm when a berth is within 120 m
 * or the ship is tied up / at anchor. Plan view, title with the distance to the berth, three live
 * gauges, and a footer with the reason and the next key. Also the rating title card and the red
 * bump vignette.
 */
export class DockPanel {
  readonly root = el('div', 'dock-root');
  private panel = el('div', 'dock glass');
  private titleName!: HTMLElement;
  private titleDist!: HTMLElement;
  private plan!: SVGPathElement;
  private reason!: HTMLElement;
  private cta!: HTMLElement;
  private prog!: HTMLElement;
  private progFill!: HTMLElement;
  private gauges = new Map<string, { root: HTMLElement; needle: HTMLElement; val: HTMLElement }>();
  private rating = el('div', 'dock-rating');
  private bump = el('div', 'dock-bump');
  private ratingT = 0;
  // last value written per field, so per-frame updates touch the DOM only on change
  private cache = new Map<string, string>();

  constructor() {
    this.root.append(this.panel, this.rating, this.bump);
    const gauges = GAUGES.map((g) => {
      const l = ((g.blo - g.lo) / (g.hi - g.lo)) * 100;
      const w = ((g.bhi - g.blo) / (g.hi - g.lo)) * 100;
      return `<div class="g" data-k="${g.k}"><span class="g-l">${g.label}</span><span class="g-t"><i class="g-band" style="left:${l.toFixed(1)}%;width:${w.toFixed(1)}%"></i><i class="g-n"></i></span><span class="g-v"></span></div>`;
    }).join('');
    const bollards = [-15, 0, 15].map((a) => `<circle class="bol" cx="${xOf(a)}" cy="${yOf(-3.7)}" r="2.2"/>`).join('');
    this.panel.innerHTML = `
      <svg class="dock-plan" viewBox="0 0 ${PW} ${PH}" aria-hidden="true">
        <rect class="pier" x="0" y="${yOf(-9)}" width="${PW}" height="${6 * S}"/>
        ${bollards}
        <rect class="slot" x="${xOf(-18.5)}" y="${yOf(-2.65)}" width="${37 * S}" height="${5.3 * S}"/>
        <path class="hull" d="${HULL}" transform="translate(${X0} ${Y0}) scale(${S})"/>
      </svg>
      <div class="dock-side">
        <div class="dock-title"><span class="dock-name"></span><span class="dock-dist"></span></div>
        <div class="dock-gauges">${gauges}</div>
      </div>
      <div class="dock-foot">
        <div class="dock-reason"></div>
        <div class="dock-prog"><i></i></div>
        <div class="dock-cta"></div>
      </div>`;
    this.titleName = this.panel.querySelector('.dock-name') as HTMLElement;
    this.titleDist = this.panel.querySelector('.dock-dist') as HTMLElement;
    this.plan = this.panel.querySelector('.hull') as SVGPathElement;
    this.reason = this.panel.querySelector('.dock-reason') as HTMLElement;
    this.cta = this.panel.querySelector('.dock-cta') as HTMLElement;
    this.prog = this.panel.querySelector('.dock-prog') as HTMLElement;
    this.progFill = this.prog.firstElementChild as HTMLElement;
    for (const g of GAUGES) {
      const root = this.panel.querySelector(`.g[data-k="${g.k}"]`) as HTMLElement;
      this.gauges.set(g.k, {
        root,
        needle: root.querySelector('.g-n') as HTMLElement,
        val: root.querySelector('.g-v') as HTMLElement,
      });
    }
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
    const st = mooring.state;
    const show = atHelm && ((a !== null && a.dist <= 120) || st !== 'free');
    if (!this.same('show', String(show))) this.panel.classList.toggle('on', show);
    if (!show) return;

    const title = a ? a.berth.name : st === 'anchored' ? 'Anchored' : 'Moored';
    if (!this.same('title', title)) this.titleName.textContent = title;
    const dist = a ? `${Math.round(a.dist)} m` : '';
    if (!this.same('dist', dist)) this.titleDist.textContent = dist;
    if (!this.same('noapp', String(!a))) this.panel.classList.toggle('noapp', !a);
    const ok = !!a && a.canMakeFast;
    if (!this.same('ok', String(ok))) this.panel.classList.toggle('ok', ok);
    if (a) this.approachView(a, shipHeading);

    let reason = '';
    let cta = '';
    let pulse = false;
    let prog = -1;
    if (st === 'free') {
      if (a) reason = a.reason ?? '';
      if (a && a.canMakeFast) {
        cta = '<kbd>R</kbd> Moor';
        pulse = true;
      }
    } else if (st === 'warping') {
      cta = 'Pulling in';
      prog = mooring.warpProgress;
    } else if (st === 'moored') {
      cta = 'Moored · <kbd>R</kbd> Cast off';
    } else {
      cta = mooring.anchorPhase === 'weighing' ? 'Weighing anchor' : mooring.anchorPhase === 'dropping' ? 'Letting go the anchor' : 'Anchored · <kbd>Z</kbd> Raise anchor';
    }
    if (!this.same('reason', reason)) this.reason.textContent = reason;
    if (!this.same('cta', cta)) this.cta.innerHTML = cta;
    if (!this.same('pulse', String(pulse))) this.cta.classList.toggle('pulse', pulse);
    const progOn = prog >= 0;
    if (!this.same('prog', String(progOn))) this.prog.classList.toggle('on', progOn);
    if (progOn) {
      const w = `${(prog * 100).toFixed(1)}%`;
      if (!this.same('progw', w)) this.progFill.style.width = w;
    }
  }

  private approachView(a: ApproachInfo, hd: number) {
    const b = a.berth;
    // bow direction in the berth frame: x = along the pier (+a, seaward), y = lateral (+n)
    const sn = Math.sin(hd);
    const cs = Math.cos(hd);
    const fa = sn * b.ax - cs * b.az;
    const fn = sn * b.nx - cs * b.nz;
    const phi = Math.atan2(fn, fa); // screen angle of the bow in the plan
    const err = a.bowOut ? phi : wrap(phi - Math.PI); // signed error to the nearest allowed heading

    const x = xOf(squash(a.along));
    const y = yOf(clamp(a.lateral, -3, 19));
    const t = `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${(phi * DEG).toFixed(1)}) scale(${S})`;
    if (!this.same('hull', t)) this.plan.setAttribute('transform', t);

    const kn = a.sog * KNOTS;
    this.gauge('spd', kn, `${kn.toFixed(1)} kn`, kn > 2.5);
    this.gauge('lat', a.lateral, `${signed(a.lateral, 1)} m`, a.lateral < -0.8 || a.lateral > 4);
    const deg = err * DEG;
    this.gauge('ang', deg, `${signed(deg, 0)}°`, Math.abs(deg) > 15);
  }

  private gauge(k: string, v: number, text: string, bad: boolean) {
    const g = this.gauges.get(k)!;
    const def = GAUGES.find((d) => d.k === k)!;
    const pct = clamp((v - def.lo) / (def.hi - def.lo), 0, 1) * 100;
    const left = `${pct.toFixed(1)}%`;
    if (!this.same(k + 'n', left)) g.needle.style.left = left;
    if (!this.same(k + 'v', text)) g.val.textContent = text;
    const b = String(bad);
    if (!this.same(k + 'b', b)) g.root.classList.toggle('bad', bad);
  }

  /** centred title card: the rating word and the contact speed (m/s, shown in knots); fades after 4 s */
  showRating(rating: string, contactSpeed: number): void {
    const [name, sub] = [this.rating.children[0], this.rating.children[1]] as HTMLElement[];
    name.textContent = rating;
    sub.textContent = `Contact ${(contactSpeed * KNOTS).toFixed(1)} kn`;
    this.rating.classList.toggle('rough', /^Rough/.test(rating));
    this.rating.classList.add('on');
    this.ratingT = 4;
  }

  /** red edge vignette, scaled by the quay contact speed (m/s); under 1 m/s it does nothing */
  flashBump(speed: number): void {
    if (speed <= 1) return;
    const k = 0.2 + 0.7 * clamp((speed - 1) / 3, 0, 1);
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
