import type { Chart } from './chart';
import type { WorldGenResult } from '../world/worldgenTypes';

/**
 * Small camera-up minimap in the corner: a rotating window onto the parchment sea chart, the ship
 * as a red arrow in the middle, north marked on the rim. Redrawn at ~20 Hz.
 */
export class Minimap {
  readonly root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private px = 150; // CSS size
  private range = 1100; // m, centre to rim
  private acc = 0;

  constructor(private chart: Chart, private gen: WorldGenResult) {
    this.root.className = 'minimap';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(this.px * dpr);
    this.canvas.style.width = this.canvas.style.height = `${this.px}px`;
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** x,z: map centre (ship or eagle); camHeading / shipHeading: compass bearings (rad) */
  update(dt: number, x: number, z: number, camHeading: number, shipX: number, shipZ: number, shipHeading: number) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const g = this.ctx;
    const W = this.canvas.width;
    const c = W / 2;
    const r = c - W * 0.045;
    const base = this.chart.canvas;
    const S = this.gen.worldSize;
    const k = base.width / S; // chart px per metre
    const scale = r / (this.range * k); // canvas px per chart px
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#d6c8a0';
    g.fillRect(0, 0, W, W);
    g.translate(c, c);
    g.rotate(-camHeading);
    g.scale(scale, scale);
    g.imageSmoothingQuality = 'high';
    g.drawImage(base, -(x + S / 2) * k, -(z + S / 2) * k);
    g.restore();
    // vignette toward the rim
    const vg = g.createRadialGradient(c, c, r * 0.55, c, c, r);
    vg.addColorStop(0, 'rgba(60,40,20,0)');
    vg.addColorStop(1, 'rgba(60,40,20,0.35)');
    g.fillStyle = vg;
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fill();
    // ship arrow (relative to the camera-up map)
    const sx = c + ((shipX - x) * k * scale * Math.cos(-camHeading) - (shipZ - z) * k * scale * Math.sin(-camHeading));
    const sy = c + ((shipX - x) * k * scale * Math.sin(-camHeading) + (shipZ - z) * k * scale * Math.cos(-camHeading));
    g.save();
    g.translate(sx, sy);
    g.rotate(shipHeading - camHeading);
    const u = W / 150;
    g.fillStyle = '#9a2c1c';
    g.strokeStyle = 'rgba(40,20,10,0.7)';
    g.lineWidth = u;
    g.beginPath();
    g.moveTo(0, -9 * u);
    g.lineTo(5 * u, 7 * u);
    g.lineTo(0, 4 * u);
    g.lineTo(-5 * u, 7 * u);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // bronze rim
    g.lineWidth = W * 0.035;
    const rg = g.createLinearGradient(0, 0, W, W);
    rg.addColorStop(0, '#e6c681');
    rg.addColorStop(0.5, '#8a6a34');
    rg.addColorStop(1, '#d4b06a');
    g.strokeStyle = rg;
    g.beginPath();
    g.arc(c, c, r + g.lineWidth * 0.5, 0, Math.PI * 2);
    g.stroke();
    // north marker on the rim
    const na = -camHeading;
    const nx = c + Math.sin(na) * (r - 11 * u),
      ny = c - Math.cos(na) * (r - 11 * u);
    g.fillStyle = '#7a2616';
    g.font = `600 ${11 * u}px Cinzel, serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny);
  }
}
