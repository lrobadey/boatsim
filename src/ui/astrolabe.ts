import * as THREE from 'three';
import type { Game } from '../game';
import { clamp, KNOTS } from '../core/util';
import { dateOn, formatDate } from '../world/calendar';

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const C = 64; // dial centre in the 128 box
const PAN = 46; // dial px for a half turn of azimuth and for the zenith
const STEADY_S = 6; // the wind line rests after this long without a change
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const NIGHT_TOP = [6, 10, 18], NIGHT_HOR = [22, 34, 50];
const DAY_TOP = [34, 72, 104], DAY_HOR = [150, 178, 190];
const GOLD = [224, 140, 92];
const SEA_NIGHT = [4, 8, 13], SEA_DAY = [18, 40, 56];
const STARS = Array.from({ length: 12 }, (_, i) => ({
  az: ((i * 2.39996) % TAU) - Math.PI,
  alt: (12 + 40 * ((i * 0.618) % 1)) * D2R,
  r: i % 4 === 0 ? 0.8 : 0.5,
}));

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const rgb = (c: number[]) => `rgb(${c.map((v) => Math.round(v)).join(',')})`;
const wrap = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const f2 = (n: number) => n.toFixed(2);
/** sky window position of a bearing and altitude (radians), seen from the camera bearing hc */
const toDial = (az: number, alt: number, hc: number): [number, number] => [C + (wrap(az - hc) / Math.PI) * PAN, C - (alt / (Math.PI / 2)) * PAN];
/** 24-hour ring: noon at the top, hours run clockwise */
const onRing = (r: number, h: number): [number, number] => {
  const a = (h - 12) * (Math.PI / 12);
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
const bearing = (v: THREE.Vector3) => Math.atan2(v.x, -v.z);

/** shadow over the unlit part of the moon, same terminator convention as before */
function moonShadow(p: number) {
  const r = 3.4;
  const k = Math.cos(p * TAU);
  const waxing = p < 0.5;
  const ex = Math.abs(k) * r;
  const sweepHalf = waxing ? 0 : 1;
  const sweepEll = k > 0 ? (waxing ? 0 : 1) : waxing ? 1 : 0;
  return `M0 ${-r} A${r} ${r} 0 0 ${sweepHalf} 0 ${r} A${ex.toFixed(3)} ${r} 0 0 ${sweepEll} 0 ${-r} Z`;
}

const TICKS = Array.from({ length: 24 }, (_, h) => {
  const major = h % 6 === 0;
  const [x0, y0] = onRing(major ? 54 : 57.5, h);
  const [x1, y1] = onRing(61, h);
  return `<line x1="${f2(x0)}" y1="${f2(y0)}" x2="${f2(x1)}" y2="${f2(y1)}" stroke-width="${major ? 1 : 0.6}" stroke-opacity="${major ? 0.8 : 0.42}"/>`;
}).join('');

/**
 * Sky dial, bottom right: the sky in the camera's direction (horizon across the middle, sun and moon
 * at their true bearing and altitude, day/night gradient from the sun's altitude), a fixed 24-hour
 * tick ring with noon at the top, and the wind's bearing relative to the view on the rim. Heading
 * lives on the tape, so the dial is not a compass.
 */
export class Astrolabe {
  readonly root = document.createElement('div');
  private dial = document.createElement('div');
  private time = document.createElement('div');
  private sub = document.createElement('div');
  /** the time and calendar date under the dial; dims while the world is stopped */
  private date = document.createElement('div');
  private dateText = '';
  private skyTop!: SVGStopElement;
  private skyHor!: SVGStopElement;
  private sea!: SVGRectElement;
  private starsG!: SVGGElement;
  private stars!: SVGCircleElement[];
  private sun!: SVGGElement;
  private sunGlow!: SVGCircleElement;
  private moon!: SVGGElement;
  private moonShade!: SVGPathElement;
  private windMark!: SVGGElement;
  private fwd = new THREE.Vector3();
  private skyKey = '';
  private timeText = '';
  private subText = '';
  private subAt = 0;

  constructor() {
    this.root.className = 'astrolabe';
    this.dial.className = 'astro-dial';
    this.dial.innerHTML = `
      <svg viewBox="0 0 128 128" width="128" height="128" aria-hidden="true">
        <defs>
          <linearGradient id="astroSky" x1="0" y1="0" x2="0" y2="1">
            <stop class="st" offset="0"/><stop class="sh" offset="1"/>
          </linearGradient>
          <radialGradient id="astroGlow">
            <stop offset="0" stop-color="#ffb27c" stop-opacity="0.6"/><stop offset="1" stop-color="#ffb27c" stop-opacity="0"/>
          </radialGradient>
          <clipPath id="astroSkyClip"><circle cx="64" cy="64" r="52"/></clipPath>
        </defs>
        <g clip-path="url(#astroSkyClip)">
          <rect x="0" y="0" width="128" height="64" fill="url(#astroSky)"/>
          <g class="stars" opacity="0">${STARS.map((s) => `<circle r="${s.r}" fill="#f3eee4" fill-opacity="0.85"/>`).join('')}</g>
          <rect class="sea" x="0" y="64" width="128" height="64" fill="#04080d"/>
          <line x1="0" y1="64" x2="128" y2="64" stroke="#f3eee4" stroke-opacity="0.42" stroke-width="0.7"/>
          <g class="sun" opacity="0">
            <circle class="glow" r="11" fill="url(#astroGlow)"/>
            <circle r="3.4" fill="#d0693e"/>
          </g>
          <g class="moon" opacity="0">
            <circle r="3.4" fill="#f3eee4"/>
            <path class="moon-sh" d="" fill="#0c141e" fill-opacity="0.92"/>
          </g>
        </g>
        <circle cx="64" cy="64" r="52" fill="none" stroke="#f3eee4" stroke-opacity="0.1" stroke-width="0.6"/>
        <g class="ring" fill="none" stroke="#f3eee4">${TICKS}</g>
        <g class="wind"><path d="M64 2 L67 -2.8 L61 -2.8 Z" fill="#d2a65e"/></g>
        <circle cx="64" cy="64" r="63.5" fill="none" stroke="#f3eee4" stroke-opacity="0.14" stroke-width="1"/>
      </svg>`;
    const q = <T>(sel: string) => this.dial.querySelector(sel) as unknown as T;
    this.skyTop = q<SVGStopElement>('.st');
    this.skyHor = q<SVGStopElement>('.sh');
    this.sea = q<SVGRectElement>('.sea');
    this.starsG = q<SVGGElement>('.stars');
    this.stars = Array.from(this.dial.querySelectorAll<SVGCircleElement>('.stars circle'));
    this.sun = q<SVGGElement>('.sun');
    this.sunGlow = q<SVGCircleElement>('.glow');
    this.moon = q<SVGGElement>('.moon');
    this.moonShade = q<SVGPathElement>('.moon-sh');
    this.windMark = q<SVGGElement>('.wind');
    this.time.className = 'astro-time';
    this.sub.className = 'astro-sub';
    this.date.className = 'astro-date';
    this.root.append(this.dial, this.time, this.sub, this.date);
  }

  update(g: Game) {
    g.camera.getWorldDirection(this.fwd);
    const hc = bearing(this.fwd);
    const sun = g.clock.sunDir;
    const moon = g.clock.moonDir;
    const sAlt = Math.asin(clamp(sun.y, -1, 1));
    const mAlt = Math.asin(clamp(moon.y, -1, 1));
    const altD = sAlt / D2R;
    const day = clamp((altD + 6) / 16, 0, 1);
    const gold = clamp(1 - Math.abs(altD - 3) / 11, 0, 1);

    const key = `${Math.round(day * 60)}|${Math.round(gold * 20)}`;
    if (key !== this.skyKey) {
      this.skyKey = key;
      this.skyTop.setAttribute('stop-color', rgb(mix(NIGHT_TOP, DAY_TOP, day)));
      this.skyHor.setAttribute('stop-color', rgb(mix(mix(NIGHT_HOR, DAY_HOR, day), GOLD, gold * 0.55)));
      this.sea.setAttribute('fill', rgb(mix(SEA_NIGHT, SEA_DAY, day)));
    }
    this.starsG.setAttribute('opacity', clamp(1 - day * 1.3, 0, 0.9).toFixed(2));
    STARS.forEach((s, i) => {
      const [x, y] = toDial(s.az, s.alt, hc);
      this.stars[i].setAttribute('cx', f2(x));
      this.stars[i].setAttribute('cy', f2(y));
    });

    const [sx, sy] = toDial(bearing(sun), sAlt, hc);
    this.sun.setAttribute('transform', `translate(${f2(sx)} ${f2(sy)})`);
    this.sun.setAttribute('opacity', clamp((altD + 1.5) / 3, 0, 1).toFixed(2));
    this.sunGlow.setAttribute('opacity', (0.45 + 0.55 * gold).toFixed(2));

    const [mx, my] = toDial(bearing(moon), mAlt, hc);
    this.moon.setAttribute('transform', `translate(${f2(mx)} ${f2(my)})`);
    this.moon.setAttribute('opacity', clamp((mAlt / D2R + 1.5) / 3, 0, 1).toFixed(2));
    // the lit limb faces the sun on the dial
    const p = g.clock.moonPhase;
    const lit0 = p < 0.5 ? 0 : Math.PI;
    const toSun = Math.atan2(sy - my, sx - mx);
    this.moonShade.setAttribute('d', moonShadow(p));
    this.moonShade.setAttribute('transform', `rotate(${((toSun - lit0) / D2R).toFixed(1)})`);

    // wind from, relative to the view: the marker sits on the rim where the wind comes from
    this.windMark.setAttribute('transform', `rotate(${((g.wind.from - hc) / D2R).toFixed(1)} ${C} ${C})`);

    const scale = g.clock.timeScale > 1 ? ` <small>×${g.clock.timeScale}</small>` : '';
    const tt = g.clock.timeString + scale;
    if (tt !== this.timeText) {
      this.timeText = tt;
      this.time.innerHTML = tt;
    }
    const c = g.clock;
    const dt = `${c.timeString} · ${formatDate(dateOn(c.epoch, c.dayCount))}`;
    if (dt !== this.dateText) {
      this.dateText = dt;
      this.date.textContent = dt;
    }
    const stopped = g.worldStopped;
    if (this.date.classList.contains('stopped') !== stopped) this.date.classList.toggle('stopped', stopped);
    const wd = ((((g.wind.from / D2R) % 360) + 360) % 360);
    const st = `Wind ${POINTS[Math.round(wd / 45) % 8]} ${(g.wind.speed * KNOTS).toFixed(0)} kn`;
    const now = performance.now() / 1000;
    if (st !== this.subText) {
      this.subText = st;
      this.sub.textContent = st;
      this.subAt = now;
    }
    const quiet = now - this.subAt > STEADY_S;
    if (this.sub.classList.contains('steady') !== quiet) this.sub.classList.toggle('steady', quiet);
  }
}
