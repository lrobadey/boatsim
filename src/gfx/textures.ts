import * as THREE from 'three';
import { rng } from '../core/util';

/**
 * Procedural textures generated at load. No image assets.
 */

/** Wrap raw RGBA8 data (from the texture worker) as a tiling, mipmapped texture. */
export function dataTexture(data: Uint8Array, size: number, anisotropy = 1): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  draw(g);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Hull planking: horizontal strakes with seams and grain; u = along hull (m), v = girth (m) */
export function makePlankTexture() {
  const r = rng(21);
  return canvasTex(1024, 512, (g) => {
    const W = 1024,
      H = 512;
    g.fillStyle = '#6b4a2e';
    g.fillRect(0, 0, W, H);
    const plankH = 32;
    for (let y = 0; y < H; y += plankH) {
      const base = 0.8 + r() * 0.35;
      // plank segments with butt joints
      let x = -r() * 300;
      while (x < W) {
        const len = 260 + r() * 360;
        const tone = base * (0.88 + r() * 0.2);
        g.fillStyle = `rgb(${190 * tone},${146 * tone},${100 * tone})`;
        g.fillRect(x, y, len, plankH);
        // grain
        for (let k = 0; k < 18; k++) {
          g.strokeStyle = `rgba(40,24,12,${0.05 + r() * 0.12})`;
          g.lineWidth = 0.6 + r() * 1.2;
          g.beginPath();
          const yy = y + r() * plankH;
          g.moveTo(x, yy);
          for (let s = 0; s <= 8; s++) g.lineTo(x + (len * s) / 8, yy + Math.sin(s * 1.3 + k) * 1.5 * r());
          g.stroke();
        }
        g.fillStyle = 'rgba(25,15,8,0.8)';
        g.fillRect(x, y, 2, plankH);
        x += len;
      }
      g.fillStyle = 'rgba(20,12,6,0.85)';
      g.fillRect(0, y, W, 2);
      g.fillStyle = 'rgba(255,230,190,0.07)';
      g.fillRect(0, y + 2, W, 2);
      // trenails
      for (let x2 = 20; x2 < W; x2 += 64) {
        g.fillStyle = 'rgba(30,18,10,0.6)';
        g.beginPath();
        g.arc(x2 + r() * 4, y + plankH / 2, 1.6, 0, 7);
        g.fill();
      }
    }
  });
}

/** Deck planks (running fore-aft) */
export function makeDeckTexture() {
  const r = rng(33);
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#8a6a48';
    g.fillRect(0, 0, 512, 512);
    const pw = 32;
    for (let x = 0; x < 512; x += pw) {
      let y = -r() * 200;
      while (y < 512) {
        const len = 180 + r() * 260;
        const t = 0.85 + r() * 0.25;
        g.fillStyle = `rgb(${205 * t},${170 * t},${125 * t})`;
        g.fillRect(x, y, pw, len);
        for (let k = 0; k < 10; k++) {
          g.strokeStyle = `rgba(60,40,20,${0.05 + r() * 0.1})`;
          g.lineWidth = 0.8;
          g.beginPath();
          const xx = x + r() * pw;
          g.moveTo(xx, y);
          g.lineTo(xx + (r() - 0.5) * 3, y + len);
          g.stroke();
        }
        g.fillStyle = 'rgba(30,20,10,0.7)';
        g.fillRect(x, y, pw, 2);
        y += len;
      }
      g.fillStyle = 'rgba(25,15,8,0.8)';
      g.fillRect(x, 0, 2, 512);
    }
    // wear
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '255,240,210' : '40,25,10'},${r() * 0.04})`;
      g.beginPath();
      g.arc(r() * 512, r() * 512, 4 + r() * 30, 0, 7);
      g.fill();
    }
  });
}

/** Linen sail with seams, weathering, red border and an emblem */
export function makeSailTexture() {
  const r = rng(5);
  return canvasTex(1024, 1024, (g) => {
    const S = 1024;
    g.fillStyle = '#e6dcc4';
    g.fillRect(0, 0, S, S);
    // vertical cloth panels
    for (let x = 0; x < S; x += 64) {
      g.fillStyle = `rgba(120,100,70,${0.04 + r() * 0.05})`;
      g.fillRect(x, 0, 64, S);
      g.fillStyle = 'rgba(90,70,45,0.25)';
      g.fillRect(x, 0, 3, S);
    }
    // horizontal reinforcing bands (where brails run)
    for (let y = 0; y < S; y += 128) {
      g.fillStyle = 'rgba(90,70,45,0.18)';
      g.fillRect(0, y, S, 6);
    }
    // stains
    for (let i = 0; i < 120; i++) {
      g.fillStyle = `rgba(110,85,50,${r() * 0.05})`;
      g.beginPath();
      g.ellipse(r() * S, r() * S, 20 + r() * 120, 10 + r() * 80, r() * 3, 0, 7);
      g.fill();
    }
    // meander border
    const drawBand = (y: number, h: number) => {
      g.fillStyle = '#8f2a1c';
      g.fillRect(0, y, S, h);
      g.strokeStyle = '#e6dcc4';
      g.lineWidth = 5;
      const u = h * 0.7;
      const y0 = y + h * 0.15;
      g.beginPath();
      for (let x = 0; x < S; x += u * 1.4) {
        g.moveTo(x, y0 + u);
        g.lineTo(x, y0);
        g.lineTo(x + u, y0);
        g.lineTo(x + u, y0 + u * 0.7);
        g.lineTo(x + u * 0.35, y0 + u * 0.7);
        g.lineTo(x + u * 0.35, y0 + u * 0.35);
      }
      g.stroke();
    };
    drawBand(30, 60);
    drawBand(S - 90, 60);
    // central emblem: Athena's owl, stylised as concentric shapes
    const cx = S / 2,
      cy = S / 2 + 20;
    g.fillStyle = '#8f2a1c';
    g.beginPath();
    g.ellipse(cx, cy + 40, 150, 210, 0, 0, 7);
    g.fill();
    g.fillStyle = '#e6dcc4';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(cx + s * 62, cy - 60, 52, 0, 7);
      g.fill();
    }
    g.fillStyle = '#1d140c';
    for (const s of [-1, 1]) {
      g.beginPath();
      g.arc(cx + s * 62, cy - 60, 24, 0, 7);
      g.fill();
    }
    g.fillStyle = '#c9a24a';
    g.beginPath();
    g.moveTo(cx - 18, cy - 20);
    g.lineTo(cx + 18, cy - 20);
    g.lineTo(cx, cy + 20);
    g.fill();
    // wing feathers
    g.strokeStyle = '#e6dcc4';
    g.lineWidth = 7;
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.arc(cx, cy + 60 + i * 30, 90 - i * 8, 0.2 * Math.PI, 0.8 * Math.PI);
      g.stroke();
    }
  });
}

/** The painted eye (ophthalmos) on the bow */
export function makeEyeTexture() {
  return canvasTex(256, 128, (g) => {
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = '#f2ead8';
    g.beginPath();
    g.moveTo(10, 64);
    g.quadraticCurveTo(128, -20, 246, 64);
    g.quadraticCurveTo(128, 148, 10, 64);
    g.fill();
    g.lineWidth = 8;
    g.strokeStyle = '#1b120c';
    g.stroke();
    g.fillStyle = '#9b2c1e';
    g.beginPath();
    g.arc(128, 64, 34, 0, 7);
    g.fill();
    g.fillStyle = '#120b07';
    g.beginPath();
    g.arc(128, 64, 17, 0, 7);
    g.fill();
  });
}
