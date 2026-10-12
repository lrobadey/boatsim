// Money (cargo-trade-spec §4.1). Stored as integer centidrachmas (1 dr = 100). Never float drachmas.
// Computed amounts round in the port's favour: the player pays ceil, receives floor.

export const CENTS_PER_DR = 100;

/** Thin no-break space, the thousands separator above 9 999 dr. */
export const THIN_NBSP = ' ';

/** Drachmas (a decimal number) to whole centidrachmas. For constants and test data only. */
export function drToC(dr: number): number {
  return Math.round(dr * CENTS_PER_DR);
}

/**
 * Display: one decimal, "7.5 dr". Thousands separator (U+202F) once the integer part has five or more
 * digits: "12 450.0 dr", but "9999.5 dr". Negative values use the minus sign U+2212.
 */
export function formatDr(c: number): string {
  const sign = c < 0 ? '−' : '';
  const [whole, frac] = (Math.abs(c) / CENTS_PER_DR).toFixed(1).split('.');
  const grouped = whole.length >= 5 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_NBSP) : whole;
  return `${sign}${grouped}.${frac} dr`;
}

/** Amount the player pays for a computed amount: rounds up (in the port's favour). */
export function payCeil(x: number): number {
  return Math.ceil(x);
}

/** Amount the player receives for a computed amount: rounds down (in the port's favour). */
export function receiveFloor(x: number): number {
  return Math.floor(x);
}
