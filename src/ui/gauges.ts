import type { Game } from '../game';
import { ORDERS } from '../ship/crew';
import { KNOTS, clamp } from '../core/util';

/**
 * Physical instruments (docs/ui-redesign/mockup.html): aged bronze bezels, a dark guilloché face, hairline
 * engraving and gilt / blued-steel hands. Every reading lives on a face, so it reads on any background,
 * and nothing is written that a shape can show. Materials are one shared <defs> block (ids prefixed g-).
 */

const D2R = Math.PI / 180;
const f = (n: number) => n.toFixed(2);
const pt = (r: number, a: number): [number, number] => [r * Math.cos(a * D2R), -r * Math.sin(a * D2R)];
const div = (cls: string) => {
  const e = document.createElement('div');
  e.className = cls;
  return e;
};

const MATERIALS = `<svg class="gauge-defs" width="0" height="0" aria-hidden="true"><defs>
  <linearGradient id="g-brass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#d9c7a3"/><stop offset=".2" stop-color="#9c7d50"/><stop offset=".42" stop-color="#4f3b22"/>
    <stop offset=".6" stop-color="#8d6f45"/><stop offset=".72" stop-color="#cdb68c"/><stop offset=".88" stop-color="#5e4629"/><stop offset="1" stop-color="#2a1e10"/>
  </linearGradient>
  <linearGradient id="g-brassV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6d3ad"/><stop offset=".45" stop-color="#a3814f"/><stop offset="1" stop-color="#4a3820"/></linearGradient>
  <radialGradient id="g-face" cx=".45" cy=".38" r=".75"><stop offset="0" stop-color="#211d18"/><stop offset=".75" stop-color="#121010"/><stop offset="1" stop-color="#0a0909"/></radialGradient>
  <radialGradient id="g-dome" cx=".35" cy=".3" r=".75"><stop offset="0" stop-color="#efe2c4"/><stop offset=".35" stop-color="#a88a5a"/><stop offset=".8" stop-color="#4a3820"/><stop offset="1" stop-color="#241a0d"/></radialGradient>
  <radialGradient id="g-jewel" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffd2c0"/><stop offset=".25" stop-color="#e0573a"/><stop offset=".8" stop-color="#7a1b0e"/><stop offset="1" stop-color="#3a0904"/></radialGradient>
  <linearGradient id="g-gilt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efdcb2"/><stop offset=".5" stop-color="#c2a06a"/><stop offset="1" stop-color="#7d6239"/></linearGradient>
  <linearGradient id="g-blued" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1d3550"/><stop offset=".5" stop-color="#5d86b3"/><stop offset="1" stop-color="#1d3550"/></linearGradient>
  <filter id="g-metal" x="-15%" y="-15%" width="130%" height="130%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="1.3" result="b"/>
    <feSpecularLighting in="b" surfaceScale="2" specularConstant=".55" specularExponent="38" lighting-color="#f3e6cc" result="sp"><feDistantLight azimuth="225" elevation="38"/></feSpecularLighting>
    <feComposite in="sp" in2="SourceAlpha" operator="in" result="spc"/>
    <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .28 0" result="na"/>
    <feComposite in="na" in2="SourceAlpha" operator="in" result="grain"/>
    <feComposite in="SourceGraphic" in2="spc" operator="arithmetic" k2="1" k3=".75" result="lit"/>
    <feMerge><feMergeNode in="lit"/><feMergeNode in="grain"/></feMerge>
  </filter>
  <filter id="g-grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency=".75" numOctaves="3" seed="2" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 .55  0 0 0 0 .45  0 0 0 0 .32  0 0 0 .05 0" result="na"/>
    <feComposite in="na" in2="SourceAlpha" operator="in" result="g"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="g"/></feMerge>
  </filter>
  <filter id="g-cast" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1" dy="1.6" stdDeviation=".8" flood-color="#000" flood-opacity=".7"/></filter>
  <filter id="g-castBig" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity=".55"/></filter>
  <filter id="g-inner" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="4"/></filter>
</defs></svg>`;

let materialsMounted = false;
/** the shared material defs; call once with the HUD root */
export function mountMaterials(root: HTMLElement) {
  if (materialsMounted) return;
  materialsMounted = true;
  root.insertAdjacentHTML('afterbegin', MATERIALS);
}

const guilloche = (rMax: number) => {
  let h = '';
  for (let r = 6; r < rMax; r += 3) h += `<circle r="${r}" fill="none" stroke="#e8dcc4" stroke-opacity=".035" stroke-width=".5"/>`;
  return h;
};

/** a thin bronze bezel drawn over a round element (the minimap, the sky dial); size is the element's CSS px */
export function addBezel(host: HTMLElement, size: number) {
  const r = size / 2;
  host.insertAdjacentHTML('beforeend', `<svg class="bezel" viewBox="${-r - 6} ${-r - 6} ${size + 12} ${size + 12}" aria-hidden="true">
    <circle r="${r + 1.5}" fill="none" stroke="url(#g-brass)" stroke-width="4.5" filter="url(#g-metal)"/>
    <circle r="${r - 0.8}" fill="none" stroke="#000" stroke-width="1"/>
    <circle r="${r - 1}" fill="none" stroke="#000" stroke-opacity=".55" stroke-width="7" filter="url(#g-inner)"/>
  </svg>`);
}

const HULLS = {
  trireme: 'M0 -60 C7 -42 9.5 -18 9.5 8 C9.5 30 7 44 0 54 C-7 44 -9.5 30 -9.5 8 C-9.5 -18 -7 -42 0 -60 Z',
  merchant: 'M0 -50 C13 -34 17 -10 17 7 C17 26 12 40 0 46 C-12 40 -17 26 -17 7 C-17 -10 -13 -34 0 -50 Z',
};
const YARD_R = 38;
/** px along the keel for a full-scale force (the 4th engraved tick) */
const FORCE_PX = 48;

/**
 * Sail dial, bottom left: a top-down hull, bow up. The bronze yard shows where the yard is (a dashed line
 * shows the manual target), the cloth bulges with the load and tells the state (fluttering amber when
 * luffing, red when aback). Gilt hand: apparent wind; blued hand: true wind with barbs for its strength.
 * Drive grows along the keel against engraved ticks, side force grows to leeward. A spirit level shows heel.
 * No numbers and no best angle: the player finds the trim by watching drive.
 */
export class SailDial {
  readonly root = div('gauge sail-dial');
  private yard: SVGLineElement;
  private yardT: SVGLineElement;
  private belly: SVGPathElement;
  private tw: SVGGElement;
  private aw: SVGGElement;
  private barbs: SVGGElement;
  private driveBar: SVGLineElement;
  private sideBar: SVGLineElement;
  private bubble: SVGEllipseElement;
  private drive = 0;
  private side = 0;
  private heel = 0;
  private barbK = -1;
  private shown = false;
  private t = 0;
  /** full-scale force (N): dynamic pressure of the 12 m/s design wind on the whole sail */
  private ref: number;

  constructor(kind: 'trireme' | 'merchant', sailArea: number) {
    this.ref = 0.5 * 1.225 * 12 * 12 * sailArea * 0.75;
    let ticks = '';
    for (let a = 0; a < 360; a += 2) {
      const s = Math.sin(a * D2R), c = -Math.cos(a * D2R);
      if (a % 10) ticks += `<line x1="${f(s * 92)}" y1="${f(c * 92)}" x2="${f(s * 90.5)}" y2="${f(c * 90.5)}" stroke="#cdb68c" stroke-opacity=".3" stroke-width=".35"/>`;
      else {
        const long = a % 30 === 0, r2 = long ? 85 : 88.5;
        ticks += `<line x1="${f(s * 92)}" y1="${f(c * 92)}" x2="${f(s * r2)}" y2="${f(c * r2)}" stroke="#cdb68c" stroke-opacity="${long ? 0.95 : 0.55}" stroke-width="${long ? 0.9 : 0.5}"/>`;
      }
    }
    const keel = [12, 24, 36, 48].map((y, i) => `<line x1="${i === 3 ? -4 : -3}" x2="${i === 3 ? 4 : 3}" y1="${-y}" y2="${-y}" stroke="#cdb68c" stroke-width="${i === 3 ? 0.6 : 0.5}" opacity="${i === 3 ? 0.9 : 0.7}"/>`).join('');
    // heel level: a curved tube under the stern
    const lv = 'M-16.4 79.3 A81 81 0 0 0 16.4 79.3';
    this.root.innerHTML = `<svg viewBox="-110 -110 220 220" aria-hidden="true">
      <defs><clipPath id="g-sailFace"><circle r="98"/></clipPath></defs>
      <circle r="104" cy="2" fill="#000" opacity=".45" filter="url(#g-castBig)"/>
      <circle r="101.5" fill="none" stroke="url(#g-brass)" stroke-width="5.5" filter="url(#g-metal)"/>
      <circle r="98.4" fill="none" stroke="#000" stroke-width="1"/>
      <circle r="98" fill="url(#g-face)" filter="url(#g-grain)"/>
      <g clip-path="url(#g-sailFace)">${guilloche(96)}<circle r="104" fill="none" stroke="#000" stroke-width="12" opacity=".7" filter="url(#g-inner)"/></g>
      <circle r="92" fill="none" stroke="#b39466" stroke-width=".5" opacity=".7"/>
      <circle r="70" fill="none" stroke="#b39466" stroke-width=".4" opacity=".35"/>
      ${ticks}
      <path d="M0 -92 L2.6 -86.5 L-2.6 -86.5 Z" fill="#c9502f"/>
      <path d="${HULLS[kind]}" fill="rgba(232,220,196,.05)" stroke="#c9b083" stroke-width=".9"/>
      <line x1="0" y1="-52" x2="0" y2="50" stroke="#c9b083" stroke-width=".4" opacity=".5"/>
      <path class="belly" fill="rgba(232,220,196,.16)" stroke="#d9c7a3" stroke-width=".7"/>
      ${keel}
      <g filter="url(#g-cast)"><line class="side" x1="0" y1="0" x2="0" y2="0" stroke="#d6dadb" stroke-width="3" stroke-linecap="round" opacity=".8"/>
        <line class="drive" x1="0" y1="0" x2="0" y2="0" stroke="#dcc08a" stroke-width="4" stroke-linecap="round"/></g>
      <path d="${lv}" fill="none" stroke="#000" stroke-width="6.5" stroke-linecap="round"/>
      <path d="${lv}" fill="none" stroke="#cdb68c" stroke-opacity=".5" stroke-width=".5" transform="translate(0 2.6)"/>
      <line x1="0" y1="76.5" x2="0" y2="83.5" stroke="#cdb68c" stroke-width=".5" opacity=".8"/>
      <ellipse class="bubble" rx="3.2" ry="2.2" fill="#d9e7c8" fill-opacity=".85" stroke="#fff" stroke-opacity=".5" stroke-width=".4"/>
      <line class="yardT" stroke="rgba(217,199,163,.6)" stroke-width=".8" stroke-dasharray="2 2.5"/>
      <g filter="url(#g-cast)"><line class="yard" stroke="#d2b47c" stroke-width="2.6" stroke-linecap="round"/></g>
      <g class="tw" filter="url(#g-cast)"><path d="M0 -90 L1.6 -80 L.7 -78 L.7 -14 L-.7 -14 L-.7 -78 L-1.6 -80 Z" fill="url(#g-blued)"/><g class="barbs" stroke="#6f97c2" stroke-width="1.3" stroke-linecap="round"></g></g>
      <g class="aw" filter="url(#g-cast)"><path d="M0 -94 L2.4 -82 L1.1 -80 L1.1 -12 L2.6 -6 L0 -2 L-2.6 -6 L-1.1 -12 L-1.1 -80 L-2.4 -82 Z" fill="url(#g-gilt)"/><circle cy="-72" r="3.2" fill="none" stroke="url(#g-gilt)" stroke-width="1.1"/></g>
      <circle r="4.2" fill="url(#g-dome)" filter="url(#g-cast)"/><circle r="1.3" fill="#1a1209"/>
      <path d="M-96 -6 A96 96 0 0 1 6 -96 A110 110 0 0 0 -96 -6 Z" fill="#fff" opacity=".05"/>
    </svg>`;
    const q = <T>(s: string) => this.root.querySelector(s) as unknown as T;
    this.yard = q('.yard');
    this.yardT = q('.yardT');
    this.belly = q('.belly');
    this.tw = q('.tw');
    this.aw = q('.aw');
    this.barbs = q('.barbs');
    this.driveBar = q('.drive');
    this.sideBar = q('.side');
    this.bubble = q('.bubble');
  }

  update(g: Game, dt: number, visible: boolean) {
    const sail = g.ship.sailing;
    const tel = sail.telemetry;
    const on = visible && tel.status !== 'furled';
    if (on !== this.shown) {
      this.shown = on;
      this.root.classList.toggle('on', on);
    }
    if (!on) return;
    this.t += dt;
    // smoothed ~0.15 s: J/L must move the bars within a frame or two
    const k = 1 - Math.exp(-dt / 0.15);
    this.drive += (tel.forwardForce - this.drive) * k;
    this.side += (tel.lateralForce - this.side) * k;
    this.heel += (g.ship.heel - this.heel) * (1 - Math.exp(-dt / 0.6));

    // yard: positive yardAngle brings the starboard yardarm forward
    const ya = sail.current.yardAngle;
    const yx = YARD_R * Math.cos(ya), yy = -YARD_R * Math.sin(ya);
    setLine(this.yard, -yx, -yy, yx, yy);
    const manual = sail.trimMode === 'manual';
    this.yardT.style.display = manual ? '' : 'none';
    if (manual) {
      const t = sail.manualYardTarget;
      setLine(this.yardT, -YARD_R * Math.cos(t), YARD_R * Math.sin(t), YARD_R * Math.cos(t), -YARD_R * Math.sin(t));
    }

    // force bars; lateral force is positive to starboard
    const s = FORCE_PX / this.ref;
    const aback = tel.status === 'aback' || this.drive < -0.04 * this.ref;
    this.driveBar.setAttribute('y2', f(-clamp(this.drive * s, -36, 54)));
    this.driveBar.setAttribute('stroke', this.drive < 0 ? '#c8432a' : '#dcc08a');
    this.sideBar.setAttribute('x2', f(clamp(this.side * s, -54, 54)));

    // cloth: bulges along the force it makes, area-scaled by how much sail is set
    const fx = this.side * s, fy = -this.drive * s;
    const mag = Math.hypot(fx, fy);
    const nx = -Math.sin(ya), ny = -Math.cos(ya); // screen normal of the yard
    const sg = fx * nx + fy * ny >= 0 ? 1 : -1;
    const luff = tel.status === 'luffing';
    const flog = (luff ? 3 : 0) * Math.sin(this.t * 31) + tel.flutter * 2 * Math.sin(this.t * 23);
    const b = (Math.min(22, mag * 0.45) + flog) * sail.current.deployment;
    const cx = nx * b * sg * 2, cy = ny * b * sg * 2;
    this.belly.setAttribute('d', `M${f(-yx)} ${f(-yy)} Q${f(cx)} ${f(cy)} ${f(yx)} ${f(yy)} Z`);
    this.belly.setAttribute('fill', aback ? 'rgba(200,67,42,.35)' : luff ? 'rgba(232,162,90,.12)' : 'rgba(232,220,196,.16)');
    this.belly.setAttribute('stroke', aback ? '#e36a4b' : luff ? '#e8a25a' : '#d9c7a3');

    // hands point to where each wind comes from, relative to the bow
    this.aw.setAttribute('transform', `rotate(${f(tel.apparentFrom / D2R)})`);
    this.tw.setAttribute('transform', `rotate(${f((g.wind.from - g.ship.heading) / D2R)})`);
    const kn = Math.round((g.wind.speed * KNOTS) / 5) * 5;
    if (kn !== this.barbK) {
      this.barbK = kn;
      let h = '', y = -88, n = kn;
      while (n >= 10) { h += `<line x1="0" y1="${y}" x2="8" y2="${y - 5}"/>`; y += 5; n -= 10; }
      if (n >= 5) h += `<line x1="0" y1="${y}" x2="4.5" y2="${y - 2.8}"/>`;
      this.barbs.innerHTML = h;
    }

    // the bubble rides to the high side
    const ha = (180 - clamp(this.heel / D2R * 2.2, -11, 11)) * D2R;
    const bx = 81 * Math.sin(ha), by = -81 * Math.cos(ha);
    this.bubble.setAttribute('cx', f(bx));
    this.bubble.setAttribute('cy', f(by));
    this.bubble.setAttribute('transform', `rotate(${f(ha / D2R - 180)} ${f(bx)} ${f(by)})`);
  }
}

const setLine = (l: SVGLineElement, x1: number, y1: number, x2: number, y2: number) => {
  l.setAttribute('x1', f(x1));
  l.setAttribute('y1', f(y1));
  l.setAttribute('x2', f(x2));
  l.setAttribute('y2', f(y2));
};

// order glyphs: chevrons up = ahead (more = harder), chevron down = astern, ring = oars up, solid red = ramming
const chev = (y: number, up = true) => `<path d="M-4.5 ${y + (up ? 2.2 : -2.2)} L0 ${y + (up ? -2.2 : 2.2)} L4.5 ${y + (up ? 2.2 : -2.2)}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`;
const GLYPH = [
  `<g color="#e0a868">${chev(0, false)}</g>`,
  '<circle r="3" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  chev(0),
  chev(-2.3) + chev(2.3),
  chev(-4.4) + chev(0) + chev(4.4),
  '<path d="M0 -5.5 L5 4 L0 1.8 L-5 4 Z" fill="#d0563a" stroke="#d0563a" stroke-width=".6" stroke-linejoin="round"/>',
];

/**
 * Engine-order telegraph for the rowing crew, bottom right. Sectors carry the orders as glyphs; the gilt
 * hand swings to the order given. The jewel sweeps the groove on each drive and drifts back on the
 * recovery, so the stroke rate is seen, not read; holding water parks it. The pale arc is crew stamina,
 * with a small arrow while it falls or recovers. Dims while the oars are up.
 */
export class Telegraph {
  readonly root = div('gauge telegraph');
  private svg: SVGSVGElement;
  private needle!: SVGGElement;
  private jewel!: SVGCircleElement;
  private stArc!: SVGPathElement;
  private trend!: SVGTextElement;
  private secs: SVGPathElement[] = [];
  private glyphs: SVGGElement[] = [];
  private maxOrder = ORDERS.length - 1;
  private angle = NaN;
  private lastStam = NaN;
  private stTrend = 0;
  private shown = false;
  private order = -1;
  private trendText = '';

  constructor() {
    this.root.innerHTML = '<svg viewBox="-110 -110 220 126" aria-hidden="true"></svg>';
    this.svg = this.root.firstElementChild as SVGSVGElement;
    this.build();
  }

  setMaxOrder(maxOrder: number) {
    this.maxOrder = maxOrder;
    this.angle = NaN;
    this.build();
  }

  private sectorTint(i: number, on: boolean) {
    return on ? 'rgba(232,214,176,.09)' : i === 0 ? 'rgba(200,140,70,.10)' : i === 5 ? 'rgba(170,50,30,.18)' : 'rgba(0,0,0,0)';
  }

  private build() {
    const N = this.maxOrder + 1, span = 180 / N;
    const half = (r: number) => `M${-r} 0 A${r} ${r} 0 0 1 ${r} 0`;
    let h = `<defs><clipPath id="g-telFace"><path d="${half(98)} Z"/></clipPath></defs>
      <path d="${half(104)} L104 4 L-104 4 Z" fill="#000" opacity=".45" filter="url(#g-castBig)"/>
      <path d="${half(98)} Z" fill="url(#g-face)" filter="url(#g-grain)"/>
      <g clip-path="url(#g-telFace)">${guilloche(96)}<path d="${half(106)}" fill="none" stroke="#000" stroke-width="12" opacity=".7" filter="url(#g-inner)"/></g>
      <path d="${half(101.5)}" fill="none" stroke="url(#g-brass)" stroke-width="5.5" filter="url(#g-metal)"/>`;
    for (let i = 0; i < N; i++) {
      const a0 = 180 - i * span, a1 = a0 - span, am = a0 - span / 2;
      const [x0, y0] = pt(92, a0), [x1, y1] = pt(92, a1), [x2, y2] = pt(64, a1), [x3, y3] = pt(64, a0);
      h += `<path class="sec" d="M${f(x0)} ${f(y0)} A92 92 0 0 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A64 64 0 0 0 ${f(x3)} ${f(y3)} Z" fill="${this.sectorTint(i, false)}"/>`;
      if (i) {
        const [lx1, ly1] = pt(64, a0);
        h += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(lx1)}" y2="${f(ly1)}" stroke="#cdb68c" stroke-opacity=".7" stroke-width=".5"/>`;
      }
      const [tx, ty] = pt(78, am);
      h += `<g class="glyph" color="#9c8762" transform="translate(${f(tx)} ${f(ty)})">${GLYPH[i]}</g>`;
    }
    for (let d = 0; d <= 180; d += 3) {
      const [ax, ay] = pt(92, d), [bx, by] = pt(d % 15 ? 90.5 : 89, d);
      h += `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" stroke="#cdb68c" stroke-opacity="${d % 15 ? 0.3 : 0.6}" stroke-width=".4"/>`;
    }
    const groove = `M${pt(44, 158).map(f).join(' ')} A44 44 0 0 1 ${pt(44, 22).map(f).join(' ')}`;
    const stam = `M${pt(54, 160).map(f).join(' ')} A54 54 0 0 1 ${pt(54, 20).map(f).join(' ')}`;
    const stTicks = [0.25, 0.5, 0.75].map((k) => {
      const a = 160 - 140 * k, [ax, ay] = pt(57, a), [bx, by] = pt(59, a);
      return `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" stroke="#cdb68c" stroke-width=".4" opacity=".6"/>`;
    }).join('');
    h += `<path d="${half(92)}" fill="none" stroke="#b39466" stroke-width=".5" opacity=".8"/>
      <path d="${half(64)}" fill="none" stroke="#b39466" stroke-width=".4" opacity=".55"/>
      <path d="${groove}" fill="none" stroke="#000" stroke-opacity=".7" stroke-width="3.2" stroke-linecap="round"/>
      <path d="${groove}" fill="none" stroke="#cdb68c" stroke-opacity=".25" stroke-width=".5" transform="translate(0 1.3)"/>
      <path d="${stam}" fill="none" stroke="#000" stroke-opacity=".75" stroke-width="4" stroke-linecap="round"/>
      <path class="stam" pathLength="100" d="${stam}" fill="none" stroke="#e9dfc8" stroke-width="2" stroke-linecap="round" stroke-dasharray="100 100"/>
      ${stTicks}
      <text class="trend" font-family="Inter Tight" font-size="6" text-anchor="middle" fill="#cdb68c"></text>
      <circle class="jewel" r="2.3" fill="url(#g-jewel)"/>
      <g class="needle" filter="url(#g-cast)"><path d="M-18 -1.6 L-6 -1.1 L84 -.7 L94 0 L84 .7 L-6 1.1 L-18 1.6 Z" fill="url(#g-gilt)"/><circle cx="-14" r="3.4" fill="none" stroke="url(#g-gilt)" stroke-width="1.2"/></g>
      <rect x="-104.5" y="-.5" width="209" height="12" rx="1.5" fill="url(#g-brassV)" filter="url(#g-metal)"/>
      <circle r="5" fill="url(#g-dome)" filter="url(#g-cast)"/><circle r="1.4" fill="#1a1209"/>
      <path d="M-94 -6 A94 94 0 0 1 4 -94 A108 108 0 0 0 -94 -6 Z" fill="#fff" opacity=".045"/>`;
    this.svg.innerHTML = h;
    this.needle = this.svg.querySelector('.needle') as SVGGElement;
    this.jewel = this.svg.querySelector('.jewel') as SVGCircleElement;
    this.stArc = this.svg.querySelector('.stam') as SVGPathElement;
    this.trend = this.svg.querySelector('.trend') as SVGTextElement;
    this.secs = Array.from(this.svg.querySelectorAll<SVGPathElement>('.sec'));
    this.glyphs = Array.from(this.svg.querySelectorAll<SVGGElement>('.glyph'));
    this.order = -1;
  }

  update(g: Game, dt: number, visible: boolean) {
    if (visible !== this.shown) {
      this.shown = visible;
      this.root.classList.toggle('on', visible);
    }
    if (!visible) return;
    const crew = g.crew;
    const oi = crew.orderIndex;
    const span = 180 / (this.maxOrder + 1);
    if (oi !== this.order) {
      this.order = oi;
      this.secs.forEach((s, i) => s.setAttribute('fill', this.sectorTint(i, i === oi)));
      this.glyphs.forEach((gl, i) => gl.setAttribute('color', i === oi ? '#f6ecd6' : '#9c8762'));
    }
    const rowing = crew.rate > 0 && !crew.holdWater;
    this.root.classList.toggle('idle', oi === 1 && !crew.holdWater);

    // hand slews to the order and quivers on the catch
    const target = 180 - (oi + 0.5) * span;
    this.angle = Number.isNaN(this.angle) ? target : this.angle + (target - this.angle) * Math.min(1, dt * 7);
    const p = crew.phase;
    const quiver = rowing && p < 0.06 ? Math.sin((p / 0.06) * Math.PI) * 1.4 : 0;
    this.needle.setAttribute('transform', `rotate(${f(-(this.angle + quiver))})`);

    // cadence: fast across on the drive, slow back on the recovery; astern runs the other way
    let a = 90;
    if (rowing) {
      const df = clamp(crew.driveFrac, 0.2, 0.7);
      const drive = p < df;
      const u = drive ? p / df : (p - df) / (1 - df);
      const e = (1 - Math.cos(Math.PI * u)) / 2;
      a = drive ? 150 - 120 * e : 30 + 120 * e;
      if (crew.order.dir < 0) a = 180 - a;
    }
    const [jx, jy] = pt(44, a);
    this.jewel.setAttribute('cx', f(jx));
    this.jewel.setAttribute('cy', f(jy));
    this.jewel.setAttribute('r', crew.holdWater ? '3.4' : '2.3');

    // stamina arc and its trend
    const st = crew.stamina;
    const d = Number.isNaN(this.lastStam) ? 0 : (st - this.lastStam) / Math.max(dt, 1e-3);
    this.lastStam = st;
    this.stTrend += (d - this.stTrend) * (1 - Math.exp(-dt / 0.8));
    this.stArc.setAttribute('stroke-dasharray', `${(st * 100).toFixed(1)} 100`);
    this.stArc.setAttribute('stroke', st < 0.25 ? '#d0563a' : '#e9dfc8');
    const tr = this.stTrend < -0.0015 ? '▼' : this.stTrend > 0.0015 && st < 0.995 ? '▲' : '';
    if (tr !== this.trendText) {
      this.trendText = tr;
      this.trend.textContent = tr;
      this.trend.setAttribute('fill', tr === '▼' ? '#e8a25a' : '#9fcf9f');
    }
    if (tr) {
      const ea = (160 - 140 * st) * D2R;
      this.trend.setAttribute('x', f(62 * Math.cos(ea)));
      this.trend.setAttribute('y', f(-62 * Math.sin(ea) + 2));
    }
  }
}

/** docking icons, drawn in a 26 px box around the origin */
const ICONS = {
  // a hull with wake lines
  speed: '<path d="M-6 0 L4 0 L7 -2.5 L4 -5 L-6 -5 Z" fill="none" stroke="#cdb68c" stroke-width=".9"/><path d="M-9 -1 H-13 M-9 -4 H-12" stroke="#cdb68c" stroke-width=".7" stroke-linecap="round"/>',
  // hull beside the quay edge, the gap between
  off: '<rect x="-11" y="-7" width="3" height="10" fill="#cdb68c" opacity=".8"/><path d="M-5 -6 L6 -6 Q9 -2 6 2 L-5 2 Z" fill="none" stroke="#cdb68c" stroke-width=".9"/><path d="M-8 -2 H-5" stroke="#cdb68c" stroke-width=".6" stroke-dasharray="1 1"/>',
  // two lines meeting at an angle
  ang: '<path d="M-8 2 H8 M-8 2 L5 -7" fill="none" stroke="#cdb68c" stroke-width=".9" stroke-linecap="round"/><path d="M0 2 A8 8 0 0 0 -1.4 -2.6" fill="none" stroke="#cdb68c" stroke-width=".6"/>',
};
export type MiniIcon = keyof typeof ICONS;

const arcD = (r: number, a0: number, a1: number) => {
  const p0 = [r * Math.sin(a0 * D2R), -r * Math.cos(a0 * D2R)], p1 = [r * Math.sin(a1 * D2R), -r * Math.cos(a1 * D2R)];
  return `M${f(p0[0])} ${f(p0[1])} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${f(p1[0])} ${f(p1[1])}`;
};

/** small round gauge, 240° sweep: an icon names it, the green arc is the capture band; the hand turns red outside it */
export class MiniGauge {
  readonly root = div('gauge mini-gauge');
  private hand: SVGGElement;
  private handPath: SVGPathElement;
  private last = '';
  private bad = false;

  constructor(icon: MiniIcon, private lo: number, private hi: number, blo: number, bhi: number) {
    let ticks = '';
    for (let k = 0; k <= 12; k++) {
      const a = -120 + 20 * k, s = Math.sin(a * D2R), c = -Math.cos(a * D2R), r2 = k % 3 ? 37.5 : 36.5;
      ticks += `<line x1="${f(s * 39)}" y1="${f(c * 39)}" x2="${f(s * r2)}" y2="${f(c * r2)}" stroke="#cdb68c" stroke-width=".5" opacity="${k % 3 ? 0.45 : 0.85}"/>`;
    }
    this.root.innerHTML = `<svg viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" cy="1.5" fill="#000" opacity=".4" filter="url(#g-castBig)"/>
      <circle r="41" fill="url(#g-face)" filter="url(#g-grain)"/>
      <circle r="43.5" fill="none" stroke="url(#g-brass)" stroke-width="4" filter="url(#g-metal)"/>
      <path d="${arcD(35, -120, 120)}" fill="none" stroke="#000" stroke-opacity=".7" stroke-width="5"/>
      <path d="${arcD(35, this.ang(blo), this.ang(bhi))}" fill="none" stroke="#7fb08a" stroke-opacity=".75" stroke-width="3.2"/>
      ${ticks}
      <g transform="translate(0 20) scale(1.25)">${ICONS[icon]}</g>
      <g class="hand" filter="url(#g-cast)"><path d="M-1.4 6 L-.8 -30 L0 -36 L.8 -30 L1.4 6 Z" fill="url(#g-gilt)"/></g>
      <circle r="3.4" fill="url(#g-dome)" filter="url(#g-cast)"/>
    </svg>`;
    this.hand = this.root.querySelector('.hand') as SVGGElement;
    this.handPath = this.hand.firstElementChild as SVGPathElement;
  }

  private ang(v: number) {
    return -120 + (240 * (clamp(v, this.lo, this.hi) - this.lo)) / (this.hi - this.lo);
  }

  set(v: number, bad: boolean) {
    const t = `rotate(${this.ang(v).toFixed(1)})`;
    if (t !== this.last) {
      this.last = t;
      this.hand.setAttribute('transform', t);
    }
    if (bad !== this.bad) {
      this.bad = bad;
      this.handPath.setAttribute('fill', bad ? '#d0563a' : 'url(#g-gilt)');
    }
  }

  /** a short red glow, for a refused R */
  pulse() {
    this.root.classList.remove('pulse');
    void this.root.offsetWidth;
    this.root.classList.add('pulse');
  }
}
