import { drawAnchorGlyph, type Chart } from './chart';
import { addBezel } from './gauges';
import type { WorldGenResult } from '../world/worldgenTypes';

const PX = 132; // CSS size of the round minimap
const RANGE = 1100; // m, centre to rim
const TAU = Math.PI * 2;
const BONE = '243,238,228';
const BRONZE = '#d2a65e';
const TERRA = '#d0693e';

/**
 * Round minimap, top right: a camera-up window onto the sea chart over the night glass. Land and
 * shallows come from the chart raster, the ship is a terracotta arrow at the centre, berths are
 * bronze anchors, and "N" sits on the rim at true north. Redrawn at ~20 Hz.
 */
export class Minimap {
  readonly root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private dpr: number;
  private acc = 0;
  private berths: { cx: number; cz: number }[] = [];

  /** berth positions (world xz) for the anchor icons; redraws on the next frame */
  setBerths(berths: { cx: number; cz: number }[]) {
    this.berths = berths;
    this.acc = 1;
  }

  constructor(private chart: Chart, private gen: WorldGenResult) {
    this.root.className = 'minimap';
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(PX * this.dpr);
    this.canvas.style.width = this.canvas.style.height = `${PX}px`;
    this.root.appendChild(this.canvas);
    addBezel(this.root, PX);
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** x,z: map centre (ship or eagle); camHeading / shipHeading: compass bearings (rad) */
  update(dt: number, x: number, z: number, camHeading: number, shipX: number, shipZ: number, shipHeading: number) {
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const g = this.ctx;
    const d = this.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, PX, PX);
    const c = PX / 2;
    const r = c - 0.5;
    const base = this.chart.canvas;
    const S = this.gen.worldSize;
    const k = base.width / S; // chart raster px per metre
    const s = r / (RANGE * k); // chart raster px -> minimap CSS px
    const cs = Math.cos(-camHeading);
    const sn = Math.sin(-camHeading);
    // world xz -> minimap CSS px, camera-up
    const toMini = (wx: number, wz: number): [number, number] => {
      const dx = (wx - x) * k * s;
      const dz = (wz - z) * k * s;
      return [c + dx * cs - dz * sn, c + dx * sn + dz * cs];
    };

    g.save();
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.clip();
    g.translate(c, c);
    g.rotate(-camHeading);
    g.scale(s, s);
    g.imageSmoothingQuality = 'high';
    g.drawImage(base, -(x + S / 2) * k, -(z + S / 2) * k);
    g.restore();

    // the glass darkens slightly toward the rim
    const vg = g.createRadialGradient(c, c, r * 0.6, c, c, r);
    vg.addColorStop(0, 'rgba(6,10,16,0)');
    vg.addColorStop(1, 'rgba(6,10,16,0.4)');
    g.fillStyle = vg;
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.fill();

    for (const b of this.berths) {
      const [bx, by] = toMini(b.cx, b.cz);
      if (Math.hypot(bx - c, by - c) > r - 8) continue;
      drawAnchorGlyph(g, bx, by, 0.8, BRONZE);
    }

    const [sx, sy] = toMini(shipX, shipZ);
    g.save();
    g.translate(sx, sy);
    g.rotate(shipHeading - camHeading);
    g.fillStyle = TERRA;
    g.strokeStyle = 'rgba(10,16,24,0.6)';
    g.lineWidth = 0.7;
    g.shadowColor = 'rgba(208,105,62,0.55)';
    g.shadowBlur = 6;
    g.beginPath();
    g.moveTo(0, -5.6);
    g.lineTo(3.6, 4.4);
    g.lineTo(0, 2.2);
    g.lineTo(-3.6, 4.4);
    g.closePath();
    g.fill();
    g.shadowBlur = 0;
    g.stroke();
    g.restore();

    g.strokeStyle = `rgba(${BONE},0.16)`;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.stroke();

    // north on the rim: same projection as the map (north is -z in world, up at zero heading)
    const nx = c - Math.sin(camHeading) * (r - 10);
    const ny = c - Math.cos(camHeading) * (r - 10);
    g.fillStyle = `rgba(${BONE},0.72)`;
    g.font = '600 8px "Inter Tight", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny);
  }
}
