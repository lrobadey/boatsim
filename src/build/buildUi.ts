import { PIECES, PAYLOAD_LIMIT } from './pieces';

const el = (tag: string, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

const t2 = (kg: number) => (kg / 1000).toFixed(2);

// Line icons on a 24 × 24 grid, one per PIECES id. Bone stroke at 1.3, no fill.
const AMPHORA = 'M-1.1 0h2.2v2.4c1.5.9 2.4 2.6 2.4 4.6 0 2.9-1.8 5.2-3.5 6-1.7-.8-3.5-3.1-3.5-6 0-2 .9-3.7 2.4-4.6z';
const ICON: Record<string, string> = {
  crate: '<rect x="4" y="7" width="16" height="13"/><path d="M4 11h16M10 7v13"/>',
  amphora_rack:
    '<path d="M2.5 4h19M2.5 20h19"/>' +
    [6, 12, 18].map((x) => `<path transform="translate(${x} 6) scale(.8)" d="${AMPHORA}"/>`).join(''),
  pithos: '<path d="M8 4h8M9 4v2.5C6 8 5 11 5 14c0 3.3 2.9 6 7 6s7-2.7 7-6c0-3-1-6-4-7.5V4"/>',
  rope_coil: '<ellipse cx="12" cy="9" rx="8" ry="3.8"/><path d="M4 9v4.5c0 2.1 3.6 3.8 8 3.8s8-1.7 8-3.8V9"/><ellipse cx="12" cy="9" rx="3.5" ry="1.6"/>',
  net_pile: '<rect x="3.5" y="6.5" width="17" height="11" rx="1"/><path d="M3.5 11l5.5-4.5M3.5 17l11.5-10M9 17.5l11.5-10M15 17.5l5.5-4.5"/>',
  lamp_post: '<path d="M12 2.5v2.5"/><path d="M9.5 5h5L16 9v6l-1.5 3h-5L8 15V9z"/><path d="M8 9h8M8 15h8M9 20.5h6"/>',
  brazier: '<path d="M5 9h14c0 4-3 7-7 7s-7-3-7-7z"/><path d="M12 2.5c1.6 1.8 2.3 3.3 0 5.5-2.3-2.2-1.6-3.7 0-5.5z"/><path d="M9 16l-2 5M15 16l2 5M12 16v5"/>',
  awning: '<path d="M2.5 9C5 5 19 5 21.5 9"/><path d="M2.5 9q2.375 3.5 4.75 0q2.375 3.5 4.75 0q2.375 3.5 4.75 0q2.375 3.5 4.75 0"/>',
  altar: '<path d="M5 21h14M7 21v-9h10v9M5.5 12h13"/><path d="M8.5 12c0-1.8 1.6-2.8 3.5-2.8s3.5 1 3.5 2.8"/><path d="M12 8.5c.9-1 .9-2 0-3-.9 1-.9 2 0 3z"/>',
  bench: '<path d="M3 10h18v2.5H3z"/><path d="M5 12.5V20M19 12.5V20"/>',
  shield_rack: '<path d="M3 6h18M3 19h18M3.5 6v13M20.5 6v13"/><circle cx="6.5" cy="12.5" r="2.6"/><circle cx="12" cy="12.5" r="2.6"/><circle cx="17.5" cy="12.5" r="2.6"/>',
  banner: '<path d="M6 21V3"/><path d="M6 4h11l-2.5 3.5L17 11H6"/>',
};
const iconSvg = (id: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="#f3eee4" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[id] ?? ''}</svg>`;

/**
 * Deck-building palette (spec §8): one glass bar of piece cards with the deck load at its end.
 * Above the bar: the selected piece's description and the hint row (keys, or the reason a
 * placement is refused, in caution). Display only; the DeckBuilder drives it. Text writes are
 * cached so per-frame calls are cheap.
 */
export class BuildUi {
  readonly root: HTMLElement = el('div', 'build-root');
  private panel: HTMLElement = el('div', 'build');
  private blurb: HTMLElement = el('div', 'build-blurb');
  private hint: HTMLElement = el('div', 'build-hint');
  private bar: HTMLElement = el('div', 'build-bar glass');
  private cardRow: HTMLElement = el('div', 'build-cards');
  private cards: HTMLElement[] = [];
  private load: HTMLElement = el('div', 'build-load');
  private loadValue: HTMLElement = el('div', 'build-load-v');
  private loadFill: HTMLElement = el('i', 'build-load-fill');
  private cache = new Map<string, string>();

  constructor() {
    PIECES.forEach((p, i) => {
      const card = el('div', 'build-card');
      const key = el('span', 'build-card-key', i < 10 ? String((i + 1) % 10) : '');
      const tile = el('div', 'build-card-ic');
      tile.innerHTML = iconSvg(p.id);
      // DOM order is key, name, mass, icon; panels.css `order` puts the icon on top
      card.append(key, el('div', 'build-card-name', p.name), el('div', 'build-card-mass', `${p.mass} kg`), tile);
      this.cards.push(card);
      this.cardRow.appendChild(card);
    });
    const track = el('div', 'build-load-track');
    track.appendChild(this.loadFill);
    this.load.append(el('div', 'label', 'Deck load'), this.loadValue, track);
    this.bar.append(this.cardRow, this.load);
    this.panel.append(this.blurb, this.hint, this.bar);
    this.root.appendChild(this.panel);
  }

  setVisible(on: boolean) {
    this.root.classList.toggle('on', on);
  }

  /** highlights a card and shows its blurb; index into PIECES. Keeps the card in view on a scrolling bar */
  select(index: number) {
    this.cards.forEach((c, i) => c.classList.toggle('on', i === index));
    const card = this.cards[index];
    if (card && this.cardRow.scrollWidth > this.cardRow.clientWidth) {
      card.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    const text = PIECES[index]?.blurb ?? '';
    this.put('blurb', text, () => (this.blurb.textContent = text));
  }

  /** keys by default; `bad` shows a refused placement or a message in the caution colour */
  setHint(html: string, bad: boolean) {
    this.put('hint', `${bad ? 1 : 0}|${html}`, () => {
      this.hint.innerHTML = html;
      this.hint.classList.toggle('bad', bad);
    });
  }

  /** payload in kg against PAYLOAD_LIMIT */
  setLoad(kg: number) {
    const pct = Math.min(100, (kg / PAYLOAD_LIMIT) * 100);
    const over = kg > PAYLOAD_LIMIT;
    this.put('load', `${kg}|${over}`, () => {
      this.loadValue.innerHTML = `${t2(kg)} <small>/ ${t2(PAYLOAD_LIMIT)} t</small>`;
      this.loadFill.style.width = `${pct.toFixed(1)}%`;
      this.load.classList.toggle('over', over);
    });
  }

  /** writes only when the value changed */
  private put(key: string, value: string, write: () => void) {
    if (this.cache.get(key) === value) return;
    this.cache.set(key, value);
    write();
  }
}
