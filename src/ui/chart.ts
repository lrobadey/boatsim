import type { WorldGenResult } from '../world/worldgenTypes';
import type { Terrain } from '../world/terrain';
import type { ShipPhysics } from '../ship/physics';
import type { PlayerController } from '../player/controller';

const BONE = '243,238,228';
const BRONZE = '#d2a65e';
const TERRA = '#d0693e';
const TAU = Math.PI * 2;

/** Small anchor glyph centred on (x, y); s scales it (about 13 s px tall). Shared with the minimap. */
export function drawAnchorGlyph(g: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  g.save();
  g.translate(x, y);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = Math.max(1, 1.4 * s);
  g.lineCap = 'round';
  g.beginPath();
  g.arc(0, -5 * s, 1.6 * s, 0, TAU); // eye
  g.stroke();
  g.beginPath();
  g.moveTo(0, -3.2 * s);
  g.lineTo(0, 6 * s); // shank
  g.stroke();
  g.beginPath();
  g.moveTo(-3.6 * s, -0.8 * s);
  g.lineTo(3.6 * s, -0.8 * s); // stock
  g.stroke();
  g.beginPath();
  g.moveTo(-6 * s, 2.2 * s);
  g.quadraticCurveTo(-6 * s, 6.6 * s, 0, 6.6 * s);
  g.quadraticCurveTo(6 * s, 6.6 * s, 6 * s, 2.2 * s); // arms
  g.stroke();
  g.restore();
}

/**
 * Sea chart, full-screen on M: night scrim, a glass frame with the title "Map", the chart raster
 * (land, shallows, coast over transparent sea), a 1 km graticule, island names, the harbour and
 * temple, berths as bronze anchors and the ship as a terracotta arrow with a short heading line.
 * The raster is shared with the minimap; the overlays are drawn at device resolution.
 */
export class Chart {
  private root = document.createElement('div');
  private frame = document.createElement('div');
  private plate = document.createElement('div');
  /** the chart raster (land, shallows, coast), shared with the minimap */
  readonly canvas = document.createElement('canvas');
  /** graticule and names, redrawn when the plate size changes */
  private stat = document.createElement('canvas');
  private sg = this.stat.getContext('2d')!;
  /** ship, berths and eagle, redrawn every frame while open */
  private dyn = document.createElement('canvas');
  private dg = this.dyn.getContext('2d')!;
  private open = false;
  private size = 1024;
  private css = 0; // plate size in CSS px
  private dpr = Math.min(2, window.devicePixelRatio || 1);
  private statKey = '';
  private fontsOk = false;
  private berths: { cx: number; cz: number }[] = [];
  private ports: { name: string; x: number; z: number }[] = [];

  /** berth positions (world xz) for the anchor icons */
  setBerths(berths: { cx: number; cz: number }[]) {
    this.berths = berths;
  }

  /** harbour names, each drawn at its pier root (the shore end of the mole); replaces the single "Harbour" label */
  setPorts(ports: { name: string; x: number; z: number }[]) {
    this.ports = ports;
    this.statKey = '';
    this.layout();
  }

  constructor(private gen: WorldGenResult, private terrain: Terrain) {
    this.root.className = 'chart';
    this.frame.className = 'chart-frame';
    this.plate.className = 'chart-plate';
    this.canvas.width = this.canvas.height = this.size;
    this.plate.append(this.canvas, this.stat, this.dyn);
    const kmPct = ((1000 / gen.worldSize) * 100).toFixed(3);
    const title = document.createElement('h2');
    title.className = 'chart-title';
    title.textContent = 'Map';
    const foot = document.createElement('div');
    foot.className = 'chart-foot';
    foot.innerHTML = `<div class="chart-scale" style="width:${kmPct}%"><i></i><span>1 km</span></div><div class="chart-legend"><kbd>M</kbd> Close</div>`;
    this.frame.append(title, this.plate, foot);
    this.root.appendChild(this.frame);
    document.getElementById('ui')!.appendChild(this.root);
    this.paintRaster();
    if (document.fonts) {
      Promise.all([document.fonts.load('500 26px "Cormorant Garamond"'), document.fonts.load('500 12px "Inter Tight"')])
        .then(() => {
          this.fontsOk = true;
          if (this.open) this.layout();
        })
        .catch(() => undefined);
    }
    window.addEventListener('resize', () => {
      if (this.open) this.layout();
    });
  }

  toggle() {
    this.open = !this.open;
    this.root.classList.toggle('open', this.open);
    if (this.open) this.layout();
  }

  private toPx(x: number, z: number): [number, number] {
    const S = this.gen.worldSize;
    return [((x + S / 2) / S) * this.css, ((z + S / 2) / S) * this.css];
  }

  /** land fill, shallows and a coast ink line; sea stays transparent so the glass shows */
  private paintRaster() {
    const N = this.size;
    const S = this.gen.worldSize;
    const H = new Float32Array(N * N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) H[j * N + i] = this.terrain.heightAt((i / N) * S - S / 2, (j / N) * S - S / 2);
    const g = this.canvas.getContext('2d')!;
    const img = g.createImageData(N, N);
    const d = img.data;
    for (let k = 0; k < N * N; k++) {
      const h = H[k];
      const o = k * 4;
      if (h > 0) {
        d[o] = 243;
        d[o + 1] = 238;
        d[o + 2] = 228;
        d[o + 3] = 33; // rgba(243,238,228,0.13)
      } else if (h > -10) {
        d[o] = 120;
        d[o + 1] = 170;
        d[o + 2] = 190;
        d[o + 3] = 31; // rgba(120,170,190,0.12)
      }
    }
    // coast: a pixel whose land/sea state differs from its right or lower neighbour
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const k = j * N + i;
        const land = H[k] > 0;
        if (land !== (H[k + 1] > 0) || land !== (H[k + N] > 0)) {
          const o = k * 4;
          d[o] = 243;
          d[o + 1] = 238;
          d[o + 2] = 228;
          d[o + 3] = 115; // rgba(243,238,228,0.45)
        }
      }
    g.putImageData(img, 0, 0);
  }

  /** resize the overlays to the plate and redraw the graticule and names */
  private layout() {
    const css = Math.round(this.plate.getBoundingClientRect().width);
    if (!css) return;
    const key = `${css}|${this.fontsOk}`;
    if (key === this.statKey) return;
    this.statKey = key;
    this.css = css;
    const px = Math.round(css * this.dpr);
    this.stat.width = this.stat.height = px;
    this.dyn.width = this.dyn.height = px;
    this.drawStatic();
  }

  private drawStatic() {
    const g = this.sg;
    const s = this.css;
    const S = this.gen.worldSize;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, s, s);

    // graticule, every 1 km
    g.strokeStyle = `rgba(${BONE},0.06)`;
    g.lineWidth = 1;
    g.beginPath();
    for (let m = -S / 2 + 1000; m < S / 2; m += 1000) {
      const p = Math.round(((m + S / 2) / S) * s) + 0.5;
      g.moveTo(p, 0);
      g.lineTo(p, s);
      g.moveTo(0, p);
      g.lineTo(s, p);
    }
    g.stroke();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(6,10,16,0.85)';
    g.shadowBlur = 6;
    for (const isl of this.gen.islands) {
      if (!isl.name) continue;
      const [x, y] = this.toPx(isl.cx, isl.cz);
      const big = isl.area > 2e6;
      const mid = isl.area > 6e5;
      g.font = `500 ${big ? 26 : mid ? 18 : 14}px "Cormorant Garamond", Georgia, serif`;
      g.fillStyle = `rgba(${BONE},${big ? 0.92 : 0.78})`;
      g.fillText(isl.name, x, y);
    }
    const { temple, harbour } = this.gen.sites;
    const [tx, ty] = this.toPx(temple.x, temple.z);
    g.fillStyle = `rgba(${BONE},0.85)`;
    g.beginPath();
    g.arc(tx, ty, 2.4, 0, TAU);
    g.fill();
    g.font = '500 12px "Inter Tight", system-ui, sans-serif';
    g.fillStyle = `rgba(${BONE},0.72)`;
    g.textAlign = 'left';
    g.fillText('Temple', tx + 7, ty);
    g.textAlign = 'center';
    if (this.ports.length) {
      for (const p of this.ports) {
        const [px, py] = this.toPx(p.x, p.z);
        g.fillText(p.name, px, py - 16);
      }
    } else {
      const [hx, hy] = this.toPx(harbour.x, harbour.z);
      g.fillText('Harbour', hx, hy - 16);
    }
    g.shadowBlur = 0;

    // north, top right inside the plate
    const nx = s - 16;
    g.font = '600 11px "Inter Tight", system-ui, sans-serif';
    g.fillStyle = `rgba(${BONE},0.72)`;
    g.fillText('N', nx, 12);
    g.strokeStyle = `rgba(${BONE},0.4)`;
    g.beginPath();
    g.moveTo(nx + 0.5, 22);
    g.lineTo(nx + 0.5, 42);
    g.stroke();
  }

  update(ship: ShipPhysics, player: PlayerController) {
    if (!this.open) return;
    const g = this.dg;
    const s = this.css;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, s, s);
    for (const b of this.berths) {
      const [bx, by] = this.toPx(b.cx, b.cz);
      drawAnchorGlyph(g, bx, by, 1.1, BRONZE);
    }
    const [px, py] = this.toPx(ship.pos.x, ship.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(ship.heading);
    g.strokeStyle = 'rgba(208,105,62,0.75)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -14);
    g.lineTo(0, -40);
    g.stroke();
    g.fillStyle = TERRA;
    g.strokeStyle = 'rgba(10,16,24,0.7)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(6, 8);
    g.lineTo(0, 4.5);
    g.lineTo(-6, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    if (player.mode === 'eagle') {
      const [ex, ey] = this.toPx(player.eaglePos.x, player.eaglePos.z);
      g.strokeStyle = `rgba(${BONE},0.9)`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(ex, ey, 5, 0, TAU);
      g.stroke();
      g.fillStyle = `rgba(${BONE},0.9)`;
      g.beginPath();
      g.arc(ex, ey, 1.8, 0, TAU);
      g.fill();
    }
  }
}
