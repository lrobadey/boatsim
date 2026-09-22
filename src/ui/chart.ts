import type { WorldGenResult } from '../world/worldgenTypes';
import type { Terrain } from '../world/terrain';
import type { ShipPhysics } from '../ship/physics';
import type { PlayerController } from '../player/controller';

/** Parchment sea chart drawn from the heightmap, with island names, the temple, and the ship. */
export class Chart {
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private overlay = document.createElement('canvas');
  private open = false;
  private size = 900;

  constructor(private gen: WorldGenResult, private terrain: Terrain) {
    this.root.className = 'chart';
    this.canvas.width = this.overlay.width = this.size;
    this.canvas.height = this.overlay.height = this.size;
    this.root.append(this.canvas, this.overlay);
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = 'M — close chart';
    this.root.appendChild(legend);
    document.getElementById('ui')!.appendChild(this.root);
    this.draw();
  }

  toggle() {
    this.open = !this.open;
    this.root.classList.toggle('open', this.open);
  }

  private toPx(x: number, z: number) {
    const S = this.gen.worldSize;
    return [((x + S / 2) / S) * this.size, ((z + S / 2) / S) * this.size];
  }

  private draw() {
    const g = this.canvas.getContext('2d')!;
    const N = this.size;
    const img = g.createImageData(N, N);
    const S = this.gen.worldSize;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (i / N) * S - S / 2,
          z = (j / N) * S - S / 2;
        const h = this.terrain.heightAt(x, z);
        let r: number, gg: number, b: number;
        if (h > 0) {
          const t = Math.min(1, h / 400);
          r = 196 - t * 70;
          gg = 170 - t * 70;
          b = 120 - t * 50;
          // hachure-like contour lines
          if (Math.abs((h % 50) - 25) < 1.4) {
            r -= 30;
            gg -= 30;
            b -= 25;
          }
        } else {
          const t = Math.min(1, -h / 40);
          r = 214 - t * 30;
          gg = 200 - t * 25;
          b = 160 - t * 10;
          if (h > -1.5) {
            r -= 40;
            gg -= 45;
            b -= 45;
          }
        }
        const n = (Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1;
        const k = 0.94 + 0.06 * n;
        const idx = (j * N + i) * 4;
        img.data[idx] = r * k;
        img.data[idx + 1] = gg * k;
        img.data[idx + 2] = b * k;
        img.data[idx + 3] = 255;
      }
    g.putImageData(img, 0, 0);
    // coastline ink
    g.globalAlpha = 0.6;
    g.fillStyle = '#3b2a18';
    for (let j = 1; j < N - 1; j += 1)
      for (let i = 1; i < N - 1; i += 1) {
        const x = (i / N) * S - S / 2,
          z = (j / N) * S - S / 2;
        const a = this.terrain.heightAt(x, z) > 0;
        const b = this.terrain.heightAt(x + S / N, z) > 0;
        const c = this.terrain.heightAt(x, z + S / N) > 0;
        if (a !== b || a !== c) g.fillRect(i, j, 1.4, 1.4);
      }
    g.globalAlpha = 1;
    // labels
    g.fillStyle = '#3b2a18';
    g.textAlign = 'center';
    for (const isl of this.gen.islands) {
      if (!isl.name) continue;
      const [px, py] = this.toPx(isl.cx, isl.cz);
      g.font = `italic ${isl.area > 2e6 ? 26 : 18}px "EB Garamond", serif`;
      g.fillText(isl.name.toUpperCase(), px, py);
    }
    const [tx, ty] = this.toPx(this.gen.sites.temple.x, this.gen.sites.temple.z);
    g.font = '18px serif';
    g.fillText('🏛', tx, ty - 6);
    const [hx, hy] = this.toPx(this.gen.sites.harbour.x, this.gen.sites.harbour.z);
    g.font = 'italic 14px "EB Garamond", serif';
    g.fillText('⚓ harbour', hx, hy + 16);
    // compass rose
    g.save();
    g.translate(N - 90, N - 90);
    g.strokeStyle = '#3b2a18';
    g.lineWidth = 1.5;
    for (let k = 0; k < 8; k++) {
      g.rotate(Math.PI / 4);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, k % 2 ? -30 : -55);
      g.stroke();
    }
    g.font = 'bold 18px "Cinzel", serif';
    g.fillText('N', 0, -62);
    g.restore();
    // frame
    g.strokeStyle = '#3b2a18';
    g.lineWidth = 6;
    g.strokeRect(8, 8, N - 16, N - 16);
  }

  update(ship: ShipPhysics, player: PlayerController) {
    if (!this.open) return;
    const g = this.overlay.getContext('2d')!;
    g.clearRect(0, 0, this.size, this.size);
    const [px, py] = this.toPx(ship.pos.x, ship.pos.z);
    g.save();
    g.translate(px, py);
    g.rotate(ship.heading);
    g.fillStyle = '#8f2a1c';
    g.beginPath();
    g.moveTo(0, -12);
    g.lineTo(5, 8);
    g.lineTo(-5, 8);
    g.closePath();
    g.fill();
    g.restore();
    if (player.mode === 'eagle') {
      const [ex, ey] = this.toPx(player.eaglePos.x, player.eaglePos.z);
      g.fillStyle = '#1d140c';
      g.beginPath();
      g.arc(ex, ey, 4, 0, 7);
      g.fill();
    }
  }
}
