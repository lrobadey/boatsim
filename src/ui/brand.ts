/** Subtle brand marks: a line-drawn trireme emblem and a Greek meander rule. */
export const EMBLEM_SVG = (() => {
  const oars: string[] = [];
  for (let i = 0; i < 17; i++) {
    const x = 78 + i * 9.2;
    oars.push(`<line x1="${x}" y1="58" x2="${x - 7}" y2="79" />`);
  }
  return `
  <svg class="emblem" viewBox="0 0 320 110" fill="none" stroke="#d9b56a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <!-- sea -->
    <path d="M20 86 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" opacity="0.55"/>
    <path d="M50 96 q10 -4 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" opacity="0.3"/>
    <!-- hull with ram and aphlaston -->
    <path d="M38 70 L62 70 Q70 62 84 60 L236 60 Q256 60 266 50 Q276 38 272 26 Q268 18 260 22" />
    <path d="M38 70 L46 74 L60 74 Q70 72 84 72 L230 72 Q250 70 262 58" />
    <path d="M62 70 L54 64 Q58 58 66 56" />
    <circle cx="74" cy="65" r="2" fill="#d9b56a" stroke="none"/>
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

export const MEANDER_SVG = (() => {
  let d = '';
  for (let i = 0; i < 11; i++) {
    const x = i * 20;
    d += `M${x} 9 V1 H${x + 16} V7 H${x + 5} V4 H${x + 11} `;
  }
  return `<svg class="meander" viewBox="0 0 220 10" fill="none" stroke="#d9b56a" stroke-width="1.1">
    <path d="${d}"/></svg>`;
})();
