/** Subtle brand marks: a line-drawn trireme emblem and a Greek key meander rule. Both are terracotta. */
export const EMBLEM_SVG = (() => {
  const oars: string[] = [];
  for (let i = 0; i < 17; i++) {
    const x = 78 + i * 9.2;
    oars.push(`<line x1="${x}" y1="58" x2="${x - 7}" y2="79" />`);
  }
  return `
  <svg class="emblem" viewBox="0 0 320 110" fill="none" stroke="#d0693e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <!-- sea -->
    <path d="M20 86 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" opacity="0.55"/>
    <path d="M50 96 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" opacity="0.3"/>
    <!-- hull with ram and aphlaston -->
    <path d="M38 70 L62 70 Q70 62 84 60 L236 60 Q256 60 266 50 Q276 38 272 26 Q268 18 260 22" />
    <path d="M38 70 L46 74 L60 74 Q70 72 84 72 L230 72 Q250 70 262 58" />
    <path d="M62 70 L54 64 Q58 58 66 56" />
    <circle cx="74" cy="65" r="2" fill="#d0693e" stroke="none"/>
    <path d="M272 26 q6 -6 12 -2 M272 26 q4 -9 11 -8 M270 30 q8 -2 12 3" opacity="0.8"/>
    <!-- oars -->
    <g opacity="0.75">${oars.join('')}</g>
    <!-- mast, yard, furled sail -->
    <line x1="150" y1="60" x2="150" y2="14" />
    <path d="M112 18 L188 18" />
    <path d="M114 20 Q150 30 186 20" opacity="0.7"/>
    <!-- stays -->
    <path d="M150 15 L70 58 M150 15 L244 58" opacity="0.4"/>
  </svg>`;
})();

/**
 * One continuous Greek key across 200 px, 10 px tall. Coordinates sit on half pixels so the
 * 1 px stroke lands on whole device pixels.
 */
/** running Greek key: six open units on a baseline, drawn large enough to stay crisp */
export const MEANDER_SVG = (() => {
  const u = 26;
  let d = 'M1 13';
  for (let i = 0; i < 6; i++) {
    const x = 1 + i * u;
    d += ` H${x + 4} V1 H${x + 20} V9 H${x + 10} V5 H${x + 15}`;
    d += ` M${x + 4} 13 H${x + u}`;
  }
  return `<svg class="meander" viewBox="0 0 ${6 * u + 2} 14" width="${6 * u + 2}" height="14" fill="none" stroke="#d0693e" stroke-width="1.3" stroke-linecap="square" aria-hidden="true">
    <path d="${d}"/></svg>`;
})();
