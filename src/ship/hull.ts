/**
 * Parametric trireme hull (proportions after the Olympias reconstruction).
 * Ship local frame: x = starboard, y = up (0 = design waterline), z = aft (bow at -L/2).
 * Everything else — the rendered hull, deck, oar ports, buoyancy columns, water cut-out, mass and
 * inertia — is derived from these functions.
 */
export const HULL_LENGTH = 34; // hull proper; the ram adds ~2.4 m forward
export const BEAM_MAX = 1.95; // half-beam at the gunwale
export const RAM_LENGTH = 2.4;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** station s in [0,1] (0 = bow, 1 = stern) -> local z */
export const zOf = (s: number) => -HULL_LENGTH / 2 + s * HULL_LENGTH;
export const sOf = (z: number) => z / HULL_LENGTH + 0.5;

/** half-beam at gunwale */
export function halfBeam(s: number) {
  s = clamp01(s);
  const u = Math.pow(s, 0.92);
  const fore = Math.pow(Math.sin(Math.PI * u), 0.55);
  return BEAM_MAX * fore * (1 - 0.35 * smooth(0.8, 1.0, s));
}

/** keel depth below waterline (negative = keel above water, at the up-swept stern) */
export function keelDepth(s: number) {
  s = clamp01(s);
  const body = 1.05 * Math.pow(Math.sin(Math.PI * Math.min(Math.max(s, 0.0), 0.999) * 0.98 + 0.02), 0.32);
  return body - 2.6 * Math.pow(smooth(0.8, 1.0, s), 1.6);
}

/** gunwale height above waterline (sheer line rises to bow and strongly to stern) */
export function sheer(s: number) {
  s = clamp01(s);
  return 1.72 + 1.1 * Math.pow(1 - s, 8) + 2.4 * Math.pow(s, 7);
}

/** deck (katastroma) height */
/** raised amidships over the rowers, stepping down toward the bow and stern platforms */
export const deckRise = (s: number) => 0.3 + 0.65 * smooth(0.08, 0.2, s) * (1 - smooth(0.8, 0.92, s));
export const deckY = (s: number) => sheer(s) + deckRise(s);
/** walkable deck extents */
export const DECK_S0 = 0.07;
export const DECK_S1 = 0.93;

/** section point: t in [0,1] from keel (t=0) to gunwale (t=1), starboard side */
export function section(s: number, t: number, out: { x: number; y: number }) {
  const B = halfBeam(s);
  const D = keelDepth(s);
  const S = sheer(s);
  const phi = t * Math.PI * 0.5;
  out.x = B * Math.pow(Math.sin(phi), 0.55);
  out.y = -D + (S + D) * Math.pow(1 - Math.cos(phi), 0.85);
  return out;
}

/** hull half-width at height y for station s (0 if y below keel) */
export function halfWidthAt(s: number, y: number) {
  const D = keelDepth(s);
  const S = sheer(s);
  if (y <= -D) return 0;
  if (y >= S) return halfBeam(s);
  // invert section by bisection on t
  let lo = 0,
    hi = 1;
  const p = { x: 0, y: 0 };
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    section(s, m, p);
    if (p.y < y) lo = m;
    else hi = m;
  }
  section(s, (lo + hi) / 2, p);
  return p.x;
}

/** bottom height of the hull at lateral offset x for station s */
export function bottomAt(s: number, x: number) {
  const B = halfBeam(s);
  if (Math.abs(x) >= B) return sheer(s);
  let lo = 0,
    hi = 1;
  const p = { x: 0, y: 0 };
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    section(s, m, p);
    if (p.x < Math.abs(x)) lo = m;
    else hi = m;
  }
  section(s, (lo + hi) / 2, p);
  return p.y;
}

export interface Column {
  x: number;
  z: number;
  bottom: number;
  top: number;
  area: number; // plan area (m^2)
  dz: number; // length along hull
  dx: number; // width across
}

/** Buoyancy/drag columns sampled from the hull shape. */
export function buildColumns(stations = 18, strips = 4): Column[] {
  const cols: Column[] = [];
  for (let i = 0; i < stations; i++) {
    const s0 = i / stations,
      s1 = (i + 1) / stations;
    const s = (s0 + s1) / 2;
    const B = halfBeam(s);
    if (B < 0.05) continue;
    const dz = (s1 - s0) * HULL_LENGTH;
    for (let k = 0; k < strips; k++) {
      const x0 = -B + (2 * B * k) / strips;
      const x1 = -B + (2 * B * (k + 1)) / strips;
      const x = (x0 + x1) / 2;
      cols.push({ x, z: zOf(s), bottom: bottomAt(s, x), top: sheer(s), area: (x1 - x0) * dz, dz, dx: x1 - x0 });
    }
  }
  return cols;
}

/** Waterline half-widths at 16 stations (for the water cut-out shader), taken at deck height */
export function hullWidthTable() {
  const t = new Float32Array(16);
  for (let i = 0; i < 16; i++) t[i] = halfWidthAt(i / 15, 0.4);
  return t;
}
