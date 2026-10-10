import './register-ts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const { TableHull } = await import('../src/ship/tableHull.ts');

const RHO = 1025;
// Rudan et al. measure draft from a keel datum 4 cm above the lowest point of Steffy's keel (false keel)
const RUDAN_DATUM = 0.04;
let failures = 0;
const report = {};
function test(name, fn) {
  try { fn(); console.log('PASS', name); }
  catch (e) { failures++; console.error('FAIL', name, '\n  ', e.message); }
}
const near = (a, b, tol = 1e-9, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

// ---- C. helpers ----------------------------------------------------------------------------

/** Submerged volume (m^3) by midpoint integration over 600 stations and y in steps of 2 mm; yd = waterline height in the ship frame. */
function fineVolume(H, yd) {
  const N = 600, dzLen = H.length / N;
  let vol = 0;
  for (let j = 0; j < N; j++) {
    const s = (j + 0.5) / N;
    const yB = -H.keelDepth(s);
    const yT = Math.min(yd, H.sheer(s));
    if (yT <= yB) continue;
    const steps = Math.ceil((yT - yB) / 0.002);
    const dy = (yT - yB) / steps;
    let area = 0;
    for (let i = 0; i < steps; i++) {
      const y = yB + (i + 0.5) * dy;
      area += 2 * H.halfWidthAt(s, y) * dy;
    }
    vol += area * dzLen;
  }
  return vol;
}

/** Submerged volume (m^3) from the column sampling. */
function columnVolume(cols, yd) {
  let vol = 0;
  for (const c of cols) vol += c.area * Math.min(Math.max(yd - c.bottom, 0), c.top - c.bottom);
  return vol;
}

// ---- A. table hull on a synthetic box ------------------------------------------------------

const boxStation = (s) => ({ s, real: true, pts: [0, -1, 0.5, -1, 1, -1, 1, 0, 1, 1] });
const boxOffsets = {
  length: 10, stemOverhang: 0, postOverhang: 0, keelHalf: 0, waterlineAboveKeel: 1,
  stations: [boxStation(0), boxStation(1)], profileBottom: [], sheerLine: [],
};

test('table hull: a box section reproduces a box', () => {
  const B = new TableHull(boxOffsets);
  near(B.halfWidthAt(0.5, 0), 1, 1e-9, 'halfWidthAt(0.5, 0)');
  near(B.halfWidthAt(0.5, -1.5), 0, 1e-9, 'halfWidthAt(0.5, -1.5)');
  near(B.halfWidthAt(0.5, 2), 1, 1e-9, 'halfWidthAt(0.5, 2)');
  near(B.bottomAt(0.5, 0.3), -1, 1e-9, 'bottomAt(0.5, 0.3)');
  near(B.bottomAt(0.5, 1.2), 1, 1e-9, 'bottomAt(0.5, 1.2)');
  near(B.halfBeam(0.3), 1, 1e-9, 'halfBeam(0.3)');
  near(B.keelDepth(0.3), 1, 1e-9, 'keelDepth(0.3)');
  near(B.sheer(0.3), 1, 1e-9, 'sheer(0.3)');
  near(B.zOf(0), -5, 1e-9, 'zOf(0)');
  near(B.sOf(5), 1, 1e-9, 'sOf(5)');
  const cols = B.buildColumns(10, 4);
  near(columnVolume(cols, 0), 20, 1e-6, 'column volume below y = 0');
  const fine = fineVolume(B, 0);
  assert.ok(Math.abs(fine / 20 - 1) < 0.005, `fine volume ${fine}`);
});

// ---- B. merchant hull (only once the offsets table exists) ---------------------------------

const OFFSETS_URL = new URL('../src/ship/merchantOffsets.ts', import.meta.url);
if (!fs.existsSync(OFFSETS_URL)) {
  console.log('SKIP merchant tests: src/ship/merchantOffsets.ts not generated yet');
} else {
  const { MERCHANT_HULL: H } = await import('../src/ship/merchantHull.ts');
  const pbuf = { x: 0, y: 0 };

  test('contract: sections are monotone', () => {
    for (let k = 0; k <= 200; k++) {
      const s = k / 200;
      let px = -Infinity, py = -Infinity;
      for (let j = 0; j <= 100; j++) {
        const p = H.section(s, j / 100, pbuf);
        assert.ok(p.x >= px - 1e-12, `x not monotone at s=${s}, t=${j / 100}`);
        assert.ok(p.y >= py - 1e-12, `y not monotone at s=${s}, t=${j / 100}`);
        px = p.x;
        py = p.y;
      }
      assert.ok(H.halfBeam(s) >= H.keelHalf - 1e-9, `halfBeam(${s}) below keelHalf`);
    }
  });

  test('dimensions match the published ship', () => {
    const LOA = H.length + H.bowOverhang + H.sternOverhang;
    assert.ok(Math.abs(LOA - 14.2) / 14.2 < 0.01, `LOA ${LOA}`);
    let beam = 0, sStar = 0;
    for (let i = 0; i <= 1000; i++) {
      const s = i / 1000;
      const hb = H.halfBeam(s);
      if (hb > beam) { beam = hb; sStar = s; }
    }
    const B = 2 * beam;
    assert.ok(Math.abs(B - 4.24) / 4.24 < 0.015, `beam ${B}`);
    const depth = H.sheer(sStar) + H.keelDepth(sStar);
    assert.ok(depth >= 1.95 && depth <= 2.3, `depth ${depth} at s=${sStar}`);
    report.dimensions = { LOA, beam: B, depth, sStar };
  });

  test('hydrostatics match Rudan Table A2', () => {
    const table = [[0.5, 0.9], [0.8, 5.4], [1.0, 10.4], [1.2, 16.6], [1.4, 23.5], [1.6, 30.9]];
    const cols = H.buildColumns(22, 8);
    const rows = [];
    report.hydrostatics = rows;
    for (const [d, ref] of table) {
      const yd = d + RUDAN_DATUM - H.waterlineAboveKeel;
      const fine = (RHO * fineVolume(H, yd)) / 1000;
      const column = (RHO * columnVolume(cols, yd)) / 1000;
      const row = {
        draft: d, refTonnes: ref, fineTonnes: fine, columnTonnes: column,
        fineOverRef: fine / ref, columnOverRef: column / ref, columnOverFine: column / fine,
      };
      rows.push(row);
    }
    console.table(rows.map((r) => ({ draft: r.draft, ref: r.refTonnes, fine: +r.fineTonnes.toFixed(2), column: +r.columnTonnes.toFixed(2), 'fine/ref': +r.fineOverRef.toFixed(3), 'column/ref': +r.columnOverRef.toFixed(3), 'column/fine': +r.columnOverFine.toFixed(3) })));
    for (const r of rows.filter((r) => r.draft >= 0.8)) {
      const { draft: d, refTonnes: ref, fineTonnes: fine, columnTonnes: column } = r;
      assert.ok(Math.abs(fine / ref - 1) <= 0.06, `fine at ${d} m: ${fine} t vs ${ref} t`);
      assert.ok(Math.abs(column / ref - 1) <= 0.06, `column at ${d} m: ${column} t vs ${ref} t`);
      assert.ok(Math.abs(column / fine - 1) <= 0.04, `column/fine at ${d} m: ${column / fine}`);
    }
  });

  test('equilibrium drafts', () => {
    const draftFor = (massT) => {
      let lo = 0.2, hi = 2.0;
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) / 2;
        const disp = (RHO * fineVolume(H, m + RUDAN_DATUM - H.waterlineAboveKeel)) / 1000;
        if (disp < massT) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };
    const d9 = draftFor(9), d18 = draftFor(18), d22 = draftFor(22);
    report.equilibrium = { draft9t: d9, draft18t: d18, draft22t: d22 };
    assert.ok(Math.abs(d22 - 1.36) <= 0.06, `22 t draft ${d22}`);
  });

  test('waterline at 1.36 m draft', () => {
    const yd = 1.36 + RUDAN_DATUM - H.waterlineAboveKeel;
    const N = 2000;
    let wet = 0, halfMax = 0;
    for (let i = 0; i <= N; i++) {
      const hw = H.halfWidthAt(i / N, yd);
      if (hw > H.keelHalf + 0.005) wet++;
      halfMax = Math.max(halfMax, hw);
    }
    const LWL = H.length * (wet / (N + 1));
    const BWL = 2 * halfMax;
    assert.ok(Math.abs(LWL - 13.4) / 13.4 < 0.04, `LWL ${LWL}`);
    assert.ok(Math.abs(BWL - 3.87) / 3.87 < 0.03, `BWL ${BWL}`);
    report.waterline = { draft: 1.36, LWL, BWL };
  });

  test('hydrostatics.json written', () => {
    const dir = new URL('../docs/merchant-hull/', import.meta.url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(new URL('hydrostatics.json', dir), JSON.stringify(report, null, 2) + '\n');
    assert.ok(fs.statSync(new URL('hydrostatics.json', dir)).size > 0);
  });

  test('lines.svg written', () => {
    const svg = linesSvg(H);
    const dir = new URL('../docs/merchant-hull/', import.meta.url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(new URL('lines.svg', dir), svg);
    assert.ok(svg.startsWith('<svg') && svg.includes('Body plan'));
  });
}

/** Lines drawing: three panels stacked vertically, 60 px per metre, black 1 px strokes on white. */
function linesSvg(H) {
  const PX = 60, MARGIN = 40, LABEL = 24, GAP = 30, TOP = 20, BOTTOM = 20;
  const half = H.length / 2;
  const S = Array.from({ length: 400 }, (_, i) => i / 399);
  const extent = (lines) => {
    let lo = Infinity, hi = -Infinity;
    for (const l of lines) for (const [, v] of l.pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return [lo, hi];
  };
  const panels = [];

  // Profile: sheer and keel bottom against z, waterline dashed
  {
    const lines = [
      { pts: S.map((s) => [H.zOf(s), H.sheer(s)]) },
      { pts: S.map((s) => [H.zOf(s), -H.keelDepth(s)]) },
    ];
    const [lo, hi] = extent(lines);
    panels.push({ title: 'Profile', uMin: -half, uMax: half, vMin: Math.min(0, lo), vMax: Math.max(0, hi), lines, waterline: true });
  }

  // Half-breadth: half-beam and the waterlines at y = -0.75 .. 0.5
  {
    const lines = [{ pts: S.map((s) => [H.zOf(s), H.halfBeam(s)]) }];
    for (const y of [-0.75, -0.5, -0.25, 0, 0.25, 0.5]) lines.push({ pts: S.map((s) => [H.zOf(s), H.halfWidthAt(s, y)]) });
    const [, hi] = extent(lines);
    panels.push({ title: 'Half-breadth', uMin: -half, uMax: half, vMin: 0, vMax: hi, lines, waterline: false });
  }

  // Body plan: table stations, s >= 0.5 as is, s < 0.5 mirrored
  {
    const T = Array.from({ length: 51 }, (_, j) => j / 50);
    const buf = { x: 0, y: 0 };
    const lines = H.offsets.stations.map((st) => ({
      pts: T.map((t) => {
        const p = H.section(st.s, t, buf);
        return [st.s >= 0.5 ? p.x : -p.x, p.y];
      }),
    }));
    let maxB = 0;
    for (const l of lines) for (const [u] of l.pts) maxB = Math.max(maxB, Math.abs(u));
    const [lo, hi] = extent(lines);
    panels.push({ title: 'Body plan', uMin: -maxB, uMax: maxB, vMin: Math.min(0, lo), vMax: Math.max(0, hi), lines, waterline: true });
  }

  const contentW = Math.max(...panels.map((p) => (p.uMax - p.uMin) * PX));
  const W = Math.ceil(contentW + 2 * MARGIN);
  let y = TOP;
  const body = [];
  panels.forEach((p, idx) => {
    const pw = (p.uMax - p.uMin) * PX;
    const ox = (W - pw) / 2;
    const top = y;
    const X = (u) => ox + (u - p.uMin) * PX;
    const Y = (v) => top + LABEL + (p.vMax - v) * PX;
    body.push(`<text x="${MARGIN}" y="${top + 16}" font-family="sans-serif" font-size="12" fill="#000">${p.title}</text>`);
    body.push('<g fill="none" stroke="#000" stroke-width="1">');
    for (const l of p.lines) {
      const d = 'M' + l.pts.map(([u, v]) => `${X(u).toFixed(2)} ${Y(v).toFixed(2)}`).join(' L');
      body.push(`<path d="${d}"/>`);
    }
    if (p.waterline) {
      body.push(`<line x1="${X(p.uMin).toFixed(2)}" y1="${Y(0).toFixed(2)}" x2="${X(p.uMax).toFixed(2)}" y2="${Y(0).toFixed(2)}" stroke-dasharray="6 4"/>`);
    }
    body.push('</g>');
    y += LABEL + (p.vMax - p.vMin) * PX + (idx < panels.length - 1 ? GAP : 0);
  });
  const Ht = Math.ceil(y + BOTTOM);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Ht}" viewBox="0 0 ${W} ${Ht}">\n<rect width="100%" height="100%" fill="#fff"/>\n${body.join('\n')}\n</svg>\n`;
}

if (failures) process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
console.log(failures ? `${failures} FAILED` : 'all merchant tests passed');
