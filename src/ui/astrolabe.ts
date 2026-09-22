import type { Game } from '../game';
import { clamp, KNOTS } from '../core/util';

const NS = 'http://www.w3.org/2000/svg';
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Bronze astrolabe instrument: outer compass ring rotating with the ship's heading (wind marked on the
 * ring), and an inner day/night dial where the sun and moon ride a rotating arm across a sky that
 * changes colour with the sun's altitude, setting below a sea horizon. Moon drawn in its real phase.
 */
export class Astrolabe {
  readonly root = document.createElement('div');
  private ring!: SVGGElement;
  private arm!: SVGGElement;
  private skyTop!: SVGStopElement;
  private skyMid!: SVGStopElement;
  private skyHor!: SVGStopElement;
  private stars!: SVGGElement;
  private moonShadow!: SVGPathElement;
  private sunGlow!: SVGCircleElement;
  private wind!: SVGGElement;
  private time = document.createElement('div');
  private sub = document.createElement('div');

  constructor() {
    this.root.className = 'astrolabe';
    const ticks: string[] = [];
    for (let d = 0; d < 360; d += 5) {
      const major = d % 45 === 0;
      const mid = d % 15 === 0;
      const r0 = major ? 78 : mid ? 82 : 85;
      const a = ((d - 90) * Math.PI) / 180;
      ticks.push(
        `<line x1="${(100 + Math.cos(a) * r0).toFixed(2)}" y1="${(100 + Math.sin(a) * r0).toFixed(2)}" x2="${(100 + Math.cos(a) * 89).toFixed(2)}" y2="${(100 + Math.sin(a) * 89).toFixed(2)}" stroke="${major ? '#f1dca0' : '#c9a86a'}" stroke-width="${major ? 1.6 : 0.8}" opacity="${major ? 1 : 0.75}"/>`,
      );
    }
    const labels = POINTS.map((p, i) => {
      const a = ((i * 45 - 90) * Math.PI) / 180;
      const r = i % 2 ? 71 : 69;
      const size = i % 2 ? 7.5 : 12;
      const fill = i === 0 ? '#e0664a' : i % 2 ? '#c9b58a' : '#f4e7c4';
      return `<text x="${(100 + Math.cos(a) * r).toFixed(2)}" y="${(100 + Math.sin(a) * r).toFixed(2)}" font-size="${size}" fill="${fill}" text-anchor="middle" dominant-baseline="central" transform="rotate(${i * 45} ${(100 + Math.cos(a) * r).toFixed(2)} ${(100 + Math.sin(a) * r).toFixed(2)})">${p}</text>`;
    }).join('');
    // sun rays
    const rays = Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return `<line x1="${Math.cos(a) * 8.5}" y1="${Math.sin(a) * 8.5}" x2="${Math.cos(a) * (i % 2 ? 11 : 12.5)}" y2="${Math.sin(a) * (i % 2 ? 11 : 12.5)}" stroke="#ffd98a" stroke-width="1.4" stroke-linecap="round"/>`;
    }).join('');
    const starDots = Array.from({ length: 16 }, (_, i) => {
      const x = 62 + ((i * 37) % 76);
      const y = 52 + ((i * 53) % 44);
      return `<circle cx="${x}" cy="${y}" r="${i % 4 === 0 ? 0.9 : 0.55}" fill="#fff"/>`;
    }).join('');

    this.root.innerHTML = `
      <svg viewBox="0 0 200 200" width="100%" height="100%">
        <defs>
          <radialGradient id="bz" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stop-color="#c79a52"/><stop offset="70%" stop-color="#8a5f2c"/><stop offset="100%" stop-color="#4a3016"/>
          </radialGradient>
          <linearGradient id="bzRim" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#f2d58e"/><stop offset="50%" stop-color="#9c6d32"/><stop offset="100%" stop-color="#e2bd72"/>
          </linearGradient>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop class="st" offset="0%" stop-color="#2b6fb4"/>
            <stop class="sm" offset="70%" stop-color="#7fb6e0"/>
            <stop class="sh" offset="100%" stop-color="#f3d6a4"/>
          </linearGradient>
          <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1d4f73"/><stop offset="100%" stop-color="#0a2236"/>
          </linearGradient>
          <radialGradient id="glow"><stop offset="0%" stop-color="#fff2c0" stop-opacity="0.9"/><stop offset="100%" stop-color="#ffcf70" stop-opacity="0"/></radialGradient>
          <clipPath id="dial"><circle cx="100" cy="100" r="56"/></clipPath>
          <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-opacity="0.55"/></filter>
        </defs>
        <g filter="url(#sh)">
          <circle cx="100" cy="100" r="97" fill="url(#bzRim)"/>
          <circle cx="100" cy="100" r="93" fill="#1a130b" opacity="0.92"/>
        </g>
        <g class="ring">
          ${ticks.join('')}
          <g font-family="Cinzel, serif" font-weight="700">${labels}</g>
          <g class="wind"><path d="M100 11 l-4.5 -6 h9 z" fill="#9fd3e6"/><path d="M96 4 q4 -3 8 0" stroke="#9fd3e6" fill="none" stroke-width="1"/></g>
        </g>
        <circle cx="100" cy="100" r="60" fill="none" stroke="url(#bzRim)" stroke-width="3"/>
        <g clip-path="url(#dial)">
          <rect x="40" y="40" width="120" height="62" fill="url(#sky)"/>
          <g class="stars">${starDots}</g>
          <g class="arm">
            <line x1="100" y1="100" x2="100" y2="62" stroke="#e8c98a" stroke-width="0.8" opacity="0.35"/>
            <line x1="100" y1="100" x2="100" y2="138" stroke="#e8c98a" stroke-width="0.8" opacity="0.35"/>
            <g transform="translate(100 62)">
              <circle class="sunglow" r="18" fill="url(#glow)"/>
              ${rays}
              <circle r="7.5" fill="#ffd36a" stroke="#fff1c4" stroke-width="1"/>
            </g>
            <g transform="translate(100 138) rotate(180)">
              <circle r="7" fill="#f2efe4"/>
              <path class="moonsh" d="" fill="#16202c" opacity="0.92"/>
              <circle r="7" fill="none" stroke="#fff" stroke-width="0.6" opacity="0.6"/>
            </g>
          </g>
          <rect x="40" y="101" width="120" height="60" fill="url(#sea)" opacity="0.94"/>
          <path d="M44 101 q8 -6 16 -2 q6 -7 14 -1 q5 -3 9 1 L83 101 Z" fill="#12314a" opacity="0.85"/>
          <path d="M126 101 q10 -9 22 -3 q4 -2 8 1 L156 101 Z" fill="#12314a" opacity="0.85"/>
          <line x1="40" y1="101" x2="160" y2="101" stroke="#f1dca0" stroke-width="0.9" opacity="0.8"/>
          <g stroke="#9cc6e0" stroke-width="0.6" opacity="0.35" fill="none">
            <path d="M52 110 q6 -2 12 0 t12 0"/><path d="M104 118 q6 -2 12 0 t12 0"/><path d="M70 130 q6 -2 12 0 t12 0"/>
          </g>
        </g>
        <circle cx="100" cy="100" r="56" fill="none" stroke="#2a1d10" stroke-width="1.2"/>
        <path d="M100 3 l-5.5 9 h11 z" fill="#f1dca0" stroke="#5a3a18" stroke-width="0.8"/>
      </svg>`;
    const svg = this.root.querySelector('svg')!;
    this.ring = svg.querySelector('.ring') as SVGGElement;
    this.arm = svg.querySelector('.arm') as SVGGElement;
    this.skyTop = svg.querySelector('.st') as SVGStopElement;
    this.skyMid = svg.querySelector('.sm') as SVGStopElement;
    this.skyHor = svg.querySelector('.sh') as SVGStopElement;
    this.stars = svg.querySelector('.stars') as SVGGElement;
    this.moonShadow = svg.querySelector('.moonsh') as SVGPathElement;
    this.sunGlow = svg.querySelector('.sunglow') as SVGCircleElement;
    this.wind = svg.querySelector('.wind') as SVGGElement;
    this.time.className = 'astro-time';
    this.sub.className = 'astro-sub';
    this.root.append(this.time, this.sub);
  }

  private static mix(a: number[], b: number[], t: number) {
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  }

  update(g: Game) {
    const deg = (g.ship.heading * 180) / Math.PI;
    this.ring.setAttribute('transform', `rotate(${(-deg).toFixed(2)} 100 100)`);
    const windDeg = (g.wind.from * 180) / Math.PI;
    this.wind.setAttribute('transform', `rotate(${windDeg.toFixed(1)} 100 100)`);
    // arm: sun at the top at local noon
    const h = g.clock.hours;
    this.arm.setAttribute('transform', `rotate(${(((h - 12) / 24) * 360).toFixed(2)} 100 100)`);
    // sky colour from the actual sun altitude
    const sy = g.clock.sunDir.y;
    const day = clamp((sy + 0.05) / 0.35, 0, 1);
    const golden = clamp(1 - Math.abs(sy - 0.04) / 0.14, 0, 1);
    const night = [12, 20, 40],
      dayTop = [40, 110, 180],
      dayMid = [128, 182, 224],
      dayHor = [214, 232, 240],
      gold = [245, 170, 95];
    this.skyTop.setAttribute('stop-color', Astrolabe.mix(night, dayTop, day));
    this.skyMid.setAttribute('stop-color', Astrolabe.mix(Astrolabe.mixArr(night, [30, 40, 70], 0.6), dayMid, day));
    this.skyHor.setAttribute('stop-color', Astrolabe.mix(Astrolabe.mixArr([25, 35, 60], dayHor, day), gold, golden * 0.85));
    this.stars.setAttribute('opacity', (1 - day).toFixed(2));
    this.sunGlow.setAttribute('opacity', (0.4 + 0.6 * golden).toFixed(2));
    // moon phase: terminator as an ellipse arc
    const p = g.clock.moonPhase; // 0 new .. 0.5 full
    const r = 7;
    const k = Math.cos(p * Math.PI * 2); // 1 new -> -1 full
    const waxing = p < 0.5;
    const ex = Math.abs(k) * r;
    // shadow covers the unlit part: half disc + ellipse
    const sweepHalf = waxing ? 0 : 1;
    const sweepEll = k > 0 ? (waxing ? 0 : 1) : waxing ? 1 : 0;
    this.moonShadow.setAttribute('d', `M0 ${-r} A${r} ${r} 0 0 ${sweepHalf} 0 ${r} A${ex.toFixed(2)} ${r} 0 0 ${sweepEll} 0 ${-r} Z`);

    this.time.innerHTML = `${g.clock.timeString}${g.clock.timeScale > 1 ? `<small> ×${g.clock.timeScale}</small>` : ''}`;
    const wd = ((windDeg % 360) + 360) % 360;
    this.sub.innerHTML = `Wind ${POINTS[Math.round(wd / 45) % 8]} ${(g.wind.speed * KNOTS).toFixed(0)} kn`;
  }

  private static mixArr(a: number[], b: number[], t: number) {
    return a.map((v, i) => v + (b[i] - v) * t);
  }
}
