import './ledger.css';

/**
 * The ledger (cargo spec §9): a centred panel for one port's goods (trade, or read-only when the ship
 * isn't at this quay), the notebook of prices seen at each port (Tab), and the Hold book (mode 'hold').
 * It reads everything through a LedgerSource, so the economy can change without touching the panel.
 * Keyboard-first; the mouse works too (row click selects, wheel changes the amount).
 */

/** trade: orders on; read: prices only, no ship at this quay; hold: the Hold book */
export type LedgerMode = 'trade' | 'read' | 'hold';

/** one good as a row of the goods table. Money is centidrachmas, volumes m³, masses kg. */
export interface LedgerRow {
  /** stable key, e.g. 'wine' */
  id: string;
  /** ledger name, sentence case, e.g. 'Olive oil' */
  name: string;
  /** singular and plural unit word, e.g. ['jar', 'jars'] */
  unit: [string, string];
  /** whole units in the port */
  stock: number;
  /** ask: what the player pays per unit at the current stock */
  buy: number;
  /** bid: what the player gets per unit at the current stock */
  sell: number;
  /** units aboard: manifest plus pending in, minus pending out (never below 0) */
  aboard: number;
  /** mass of one unit, kg */
  massKg: number;
  /** hold volume of one unit including broken stowage, m³ (added: the clamp needs it) */
  stowM3: number;
}

/** what an order comes to. total is signed (+ = money in) and includes duty and porterage; duty and porters are magnitudes */
export interface LedgerQuote {
  total: number;
  duty: number;
  porters: number;
}

/**
 * The allowed order for one row, given the other rows as in `orders` (the row's own entry is ignored).
 * min is always −aboard. max is the buy limit. limitedBy names what sets max ('purse', 'hold' or 'stock'),
 * or null when nothing does. Only 'purse' and 'hold' pulse a footer figure.
 * (The spec lists 'aboard' here too; it is not used, since a sell limit is silent.)
 */
export interface LedgerLimit {
  min: number;
  max: number;
  limitedBy: 'purse' | 'hold' | 'stock' | null;
}

/** the notebook: columns are ports, rows are goods; a null cell means the price was never seen */
export interface LedgerNotebook {
  ports: string[];
  /** index into ports of the port the ledger is open at; its column always reads 'now' */
  current: number;
  rows: { name: string; cells: ({ ask: number; bid: number; ageHours: number } | null)[] }[];
}

/**
 * Everything the ledger shows and writes. The lead implements it on the real economy; `fakeLedgerSource`
 * is a static stand-in for the dev preview.
 */
export interface LedgerSource {
  /** trade, read or hold (see LedgerMode); read on a port the ship isn't moored at */
  mode: LedgerMode;
  /** the port's name, the title in trade and read modes */
  portName: string;
  /** the game clock as shown, e.g. 'Day 3 · 14:20' */
  timeLabel: string;
  /** the goods in table order; called every frame while open */
  rows(): LedgerRow[];
  /** the signed net of the orders (+ = money in), with duty and porterage; empty orders are never quoted */
  quote(orders: Record<string, number>): LedgerQuote;
  /** the allowed order for row `id`, given the other rows as in `orders` (see LedgerLimit) */
  limits(orders: Record<string, number>, id: string): LedgerLimit;
  /** the purse, centidrachmas (may be negative: wages owed) */
  purse: number;
  /**
   * The hold now: `used` is Σ aboard × stowM3 and `tonnes` is Σ aboard × massKg / 1000, both without the
   * ledger's pending order; capacity is the hold's volume, m³. The ledger adds the order on top.
   */
  hold: { tonnes: number; used: number; capacity: number };
  /** wages, centidrachmas per game day (shown in the Hold book) */
  wagesPerDay: number;
  /** the cargo job line, e.g. 'Loading · 23 left' or 'Unloading · 12 left', or null when no job runs. Shown in trade and Hold book. */
  jobLine: string | null;
  /** the notebook: this port's prices now and the latest seen at the others */
  notebook(): LedgerNotebook;
  /**
   * Settle the orders: money and port stock at once, the cargo moves over game time. Orders are cleared
   * after. Returns the toast lines, one per row, sells first (e.g. 'Sold 30 wine · 246.0 dr').
   */
  confirm(orders: Record<string, number>): string[];
  /** called each time the ledger opens; the source writes the notebook's current prices here */
  opened?(): void;
}

type View = 'goods' | 'notebook';

const THIN_SPACE = ' ';
const MINUS = '−';
/** the placeholder for a zero or unseen figure */
const NONE = '—';
const PULSE_RED = '#e36a4b';
const PULSE_BONE = '#f3eee4';
/** the least gap between two pulses of the same figure, ms */
const PULSE_GAP_MS = 400;
const ZERO_QUOTE: LedgerQuote = { total: 0, duty: 0, porters: 0 };

const el = (tag: string, cls = '', html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** thin-space groups once a whole number reaches 10 000 (the house rule for money and counts) */
function grp(whole: string): string {
  return whole.length > 4 ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE) : whole;
}

/** money in centidrachmas as the ledger shows it: one decimal, `12 450.0 dr`; `signed` adds a + to gains */
export function fmtDr(c: number, signed = false): string {
  const s = (Math.abs(c) / 100).toFixed(1);
  if (s === '0.0') return '0.0 dr';
  const [whole, frac] = s.split('.');
  const body = grp(whole) + '.' + frac + ' dr';
  if (c < 0) return MINUS + body;
  return signed ? '+' + body : body;
}

/** a unit price in centidrachmas as the goods table shows it: one decimal, no unit */
const fmtPrice = (c: number) => (c / 100).toFixed(1);
const countText = (n: number) => grp(String(Math.round(n)));

/** the notebook's age column: 'now' under an hour, then hours, then days */
function ageText(h: number): string {
  if (h < 1) return 'now';
  if (h < 48) return Math.floor(h) + ' h';
  return Math.floor(h / 24) + ' d';
}

const KEY = (k: string) => '<kbd>' + k + '</kbd>';
type Hint = [string[], string];
/** the key line at the foot: each key(s) then its action */
function hints(items: Hint[]): string {
  return items
    .map(([keys, label]) => '<span class="kh">' + keys.map(KEY).join('') + (label ? ' ' + label : '') + '</span>')
    .join('');
}

const GOODS_HEAD: [string, string][] = [
  ['Goods', ''],
  ['Stock', 'r c-market'],
  ['Buy', 'r c-market'],
  ['Sell', 'r c-market'],
  ['Aboard', 'r'],
  ['Order', 'r c-order'],
];
const COL_CLASS = ['nm', 'r c-market', 'r c-market', 'r c-market', 'r', 'r c-order'];

function nbCell(c: { ask: number; bid: number; ageHours: number } | null, now: boolean): string {
  if (!c) return '<td class="r nb-none">' + NONE + '</td>';
  const age = now ? 'now' : ageText(c.ageHours);
  return '<td class="r"><div class="nb-p">' + fmtPrice(c.ask) + ' / ' + fmtPrice(c.bid) + '</div><div class="nb-a">' + age + '</div></td>';
}

/**
 * The ledger panel. Mounted once under #ui and hidden until open(source). Writes the DOM only when a
 * value changes (cache keyed like dock.ts), so update() is cheap to call every frame.
 */
export class Ledger {
  /** called once per line after an order is confirmed, e.g. 'Sold 30 wine · 246.0 dr' */
  onToast?: (text: string) => void;

  private readonly root = el('div', 'ledger-root');
  private readonly panel = el('div', 'ledger');
  private readonly title = el('h2', 'ledger-title');
  private readonly time = el('div', 'ledger-time');
  private readonly goodsTable = el('table', 'ledger-table ledger-goods');
  private readonly goodsBody = el('tbody');
  private readonly nbTable = el('table', 'ledger-table ledger-nb');
  private readonly orderBox = el('div', 'ledger-order');
  private readonly totalEl = el('b', 'lo-val');
  private readonly dutyEl = el('b');
  private readonly portersEl = el('b');
  private readonly purseEl = el('span', 'lf-purse');
  private readonly holdEl = el('span', 'lf-hold');
  private readonly wagesEl = el('span', 'lx-wages');
  private readonly jobEl = el('span', 'lx-job');
  private readonly keysEl = el('div', 'ledger-keys');
  private rowEls: { tr: HTMLTableRowElement; cells: HTMLElement[] }[] = [];
  private src: LedgerSource | null = null;
  private view: View = 'goods';
  private sel = 0;
  private orders: Record<string, number> = {};
  private rows: LedgerRow[] = [];
  private cache = new Map<string, string>();
  private lastPulse = new Map<HTMLElement, number>();
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);

  constructor() {
    const head = el('div', 'ledger-head');
    head.append(this.title, this.time);

    const thead = el('thead');
    const headRow = el('tr');
    for (const [label, cls] of GOODS_HEAD) {
      const th = el('th', cls);
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    this.goodsTable.append(thead, this.goodsBody);

    const orderLine = el('div', 'lo-main');
    const totalLabel = el('span', 'lo-tot');
    totalLabel.innerHTML = '<span class="lo-label">Order total</span>';
    totalLabel.append(this.totalEl);
    const dutyFig = el('span', 'lo-fig');
    dutyFig.append('Duty ', this.dutyEl);
    const porterFig = el('span', 'lo-fig');
    porterFig.append('Porters ', this.portersEl);
    orderLine.append(totalLabel, dutyFig, porterFig);
    const readLine = el('div', 'lo-read', "Your ship isn't at this quay");
    this.orderBox.append(orderLine, readLine);

    const funds = el('div', 'ledger-funds');
    funds.append(this.purseEl, this.holdEl);
    const extra = el('div', 'ledger-extra');
    extra.append(this.wagesEl, this.jobEl);

    this.panel.append(head, this.goodsTable, this.nbTable, this.orderBox, funds, extra, this.keysEl);
    this.root.append(this.panel);
    document.getElementById('ui')!.appendChild(this.root);

    // rows are clicked to select; the wheel changes the selected row's amount
    this.panel.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        if (!this.src) return;
        e.preventDefault();
        const d = e.deltaY || e.deltaX;
        if (d !== 0) this.step((d < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
        this.update();
      },
      { passive: false },
    );
  }

  get isOpen(): boolean {
    return this.src !== null;
  }

  /** show the panel for a port (or the Hold book); orders start empty */
  open(src: LedgerSource): void {
    this.src = src;
    this.view = 'goods';
    this.sel = 0;
    this.orders = {};
    this.root.classList.add('on');
    window.addEventListener('keydown', this.onKeyDown, true);
    src.opened?.();
    this.update();
  }

  /** hide the panel; unconfirmed orders are dropped */
  close(): void {
    if (!this.src) return;
    this.src = null;
    this.orders = {};
    this.root.classList.remove('on');
    window.removeEventListener('keydown', this.onKeyDown, true);
  }

  /** once per frame while open: refreshes values from the source, touching the DOM only on change */
  update(): void {
    const s = this.src;
    if (!s) return;
    const mode = s.mode;
    const notebook = this.view === 'notebook';
    const trade = mode === 'trade' && !notebook;
    const hold = mode === 'hold';

    this.put('mode', mode, (v) => (this.panel.dataset.mode = v));
    this.put('view', notebook ? 'notebook' : 'goods', (v) => (this.panel.dataset.view = v));
    this.put('title', notebook ? 'Notebook' : hold ? 'Hold' : s.portName, (v) => (this.title.textContent = v));
    this.put('time', s.timeLabel, (v) => (this.time.textContent = v));

    this.rows = s.rows();
    if (this.rows.length !== this.rowEls.length) this.buildRows(this.rows.length);
    if (this.sel >= this.rows.length) this.sel = Math.max(0, this.rows.length - 1);

    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      const { tr, cells } = this.rowEls[i];
      const o = this.orders[r.id] ?? 0;
      const on = trade && i === this.sel;
      this.put('on' + i, on ? '1' : '0', (v) => tr.classList.toggle('on', v === '1'));
      this.put('n' + i, r.name, (v) => (cells[0].textContent = v));
      this.put('st' + i, countText(r.stock), (v) => (cells[1].textContent = v));
      this.put('b' + i, fmtPrice(r.buy), (v) => (cells[2].textContent = v));
      this.put('s' + i, fmtPrice(r.sell), (v) => (cells[3].textContent = v));
      const aboard = hold
        ? r.aboard > 0
          ? countText(r.aboard) + ' ' + (r.aboard === 1 ? r.unit[0] : r.unit[1]) + ' · ' + ((r.aboard * r.massKg) / 1000).toFixed(1) + ' t'
          : '—'
        : r.aboard > 0
          ? countText(r.aboard)
          : '—';
      this.put('ab' + i, aboard, (v) => (cells[4].textContent = v));
      const oText = o === 0 ? '—' : (o > 0 ? '+' : MINUS) + Math.abs(o);
      this.put('o' + i, oText, (v) => (cells[5].textContent = v));
      this.put('oc' + i, o > 0 ? 'buy' : o < 0 ? 'sell' : '', (v) => (cells[5].className = 'r c-order ' + v));
    }

    // order footer and the purse and hold figures (the hold includes the pending order)
    const quote = trade && Object.keys(this.orders).length > 0 ? s.quote(this.orders) : ZERO_QUOTE;
    let used = s.hold.used;
    let tonnes = s.hold.tonnes;
    for (const r of this.rows) {
      const o = this.orders[r.id] ?? 0;
      if (o !== 0) {
        used += o * r.stowM3;
        tonnes += (o * r.massKg) / 1000;
      }
    }
    this.put('tot', fmtDr(quote.total, true), (v) => (this.totalEl.textContent = v));
    this.put('totc', quote.total > 0 ? 'in' : quote.total < 0 ? 'out' : '', (v) => (this.totalEl.className = 'lo-val ' + v));
    this.put('duty', fmtDr(quote.duty), (v) => (this.dutyEl.textContent = v));
    this.put('porters', fmtDr(quote.porters), (v) => (this.portersEl.textContent = v));
    this.put('purse', 'Purse ' + fmtDr(s.purse), (v) => (this.purseEl.textContent = v));
    const holdText = 'Hold ' + tonnes.toFixed(1) + ' t · ' + used.toFixed(1) + ' of ' + s.hold.capacity.toFixed(1) + ' m³';
    this.put('hold', holdText, (v) => (this.holdEl.textContent = v));
    this.put('wages', 'Wages ' + fmtDr(s.wagesPerDay) + ' a day', (v) => (this.wagesEl.textContent = v));
    this.put('job', s.jobLine ?? '', (v) => (this.jobEl.textContent = v));

    if (notebook) this.putNotebook(s.notebook());

    const keys = notebook
      ? hints([[['Tab'], hold ? 'Hold' : 'Goods'], [['Esc'], 'Close']])
      : trade
        ? hints([
            [['↑', '↓'], 'Select'],
            [['←', '→'], 'Amount'],
            [['Shift'], '×10'],
            [['Enter'], 'Confirm'],
            [['Tab'], 'Notebook'],
            [['Esc'], 'Close'],
          ])
        : hints([[['Tab'], 'Notebook'], [['Esc'], 'Close']]);
    this.put('keys', keys, (v) => (this.keysEl.innerHTML = v));
  }

  private put(k: string, v: string, apply: (v: string) => void): void {
    if (this.cache.get(k) === v) return;
    this.cache.set(k, v);
    apply(v);
  }

  private putNotebook(nb: LedgerNotebook): void {
    const head = '<tr><th>Goods</th>' + nb.ports.map((p) => '<th class="r">' + esc(p) + '</th>').join('') + '</tr>';
    const body = nb.rows
      .map((row) => '<tr><td class="nm">' + esc(row.name) + '</td>' + row.cells.map((c, j) => nbCell(c, j === nb.current)).join('') + '</tr>')
      .join('');
    const html = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
    this.put('nb', html, (v) => (this.nbTable.innerHTML = v));
  }

  private buildRows(n: number): void {
    this.goodsBody.replaceChildren();
    this.rowEls = [];
    this.cache.clear();
    for (let i = 0; i < n; i++) {
      const tr = el('tr') as HTMLTableRowElement;
      const cells = COL_CLASS.map((cls) => el('td', cls));
      tr.append(...cells);
      tr.addEventListener('click', () => {
        this.sel = i;
        this.update();
      });
      this.goodsBody.append(tr);
      this.rowEls.push({ tr, cells });
    }
  }

  /** a red flash on a footer figure: the one refusal signal the ledger gives; at most once per 0.4 s per figure */
  private pulse(node: HTMLElement): void {
    const now = performance.now();
    if (now - (this.lastPulse.get(node) ?? -Infinity) < PULSE_GAP_MS) return;
    this.lastPulse.set(node, now);
    node.animate([{ color: PULSE_RED }, { color: PULSE_BONE }], { duration: 520, easing: 'ease-out' });
  }

  /** moves the selected row's order by d, clamped; a clamp against purse or hold pulses that figure */
  private step(d: number): void {
    const s = this.src;
    if (!s || s.mode !== 'trade' || this.view !== 'goods') return;
    const r = this.rows[this.sel];
    if (!r) return;
    const cur = this.orders[r.id] ?? 0;
    const want = cur + d;
    const lim = s.limits(this.orders, r.id);
    const next = Math.min(Math.max(want, lim.min), lim.max);
    if (want > lim.max && (lim.limitedBy === 'purse' || lim.limitedBy === 'hold')) {
      this.pulse(lim.limitedBy === 'purse' ? this.purseEl : this.holdEl);
    }
    if (next === cur) return;
    if (next === 0) delete this.orders[r.id];
    else this.orders[r.id] = next;
  }

  /** Enter: every non-zero row settles (the source does the money); one toast line per line the source returns */
  private confirm(): void {
    const s = this.src;
    if (!s || s.mode !== 'trade' || this.view !== 'goods') return;
    if (Object.keys(this.orders).length === 0) return;
    const orders = { ...this.orders };
    this.orders = {};
    const lines = s.confirm(orders);
    for (const line of lines) this.onToast?.(line);
    this.update();
  }

  private handleKey(e: KeyboardEvent): void {
    const s = this.src;
    if (!s || e.ctrlKey || e.metaKey || e.altKey) return;
    const goods = this.view === 'goods';
    const trade = s.mode === 'trade' && goods;
    const last = Math.max(0, this.rows.length - 1);
    let handled = true;
    switch (e.key) {
      case 'Escape':
        this.close();
        break;
      case 'Tab':
        this.view = goods ? 'notebook' : 'goods';
        break;
      case 'ArrowUp':
        if (trade) this.sel = Math.max(0, this.sel - 1);
        break;
      case 'ArrowDown':
        if (trade) this.sel = Math.min(last, this.sel + 1);
        break;
      case 'ArrowLeft':
        if (trade) this.step(e.shiftKey ? -10 : -1);
        break;
      case 'ArrowRight':
        if (trade) this.step(e.shiftKey ? 10 : 1);
        break;
      case 'Enter':
        if (trade && !e.repeat) this.confirm();
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    this.update();
  }
}

/* ---------- dev preview: static data for the eight goods ---------- */

const FAKE_GOODS: { id: string; name: string; unit: [string, string]; mass: number; stow: number; pRef: number; stock: number; aboard: number }[] = [
  { id: 'wine', name: 'Wine', unit: ['jar', 'jars'], mass: 42, stow: 0.075, pRef: 800, stock: 412, aboard: 70 },
  { id: 'oil', name: 'Olive oil', unit: ['jar', 'jars'], mass: 40, stow: 0.075, pRef: 2400, stock: 88, aboard: 0 },
  { id: 'wheat', name: 'Wheat', unit: ['sack', 'sacks'], mass: 40, stow: 0.065, pRef: 600, stock: 140, aboard: 0 },
  { id: 'almonds', name: 'Almonds', unit: ['jar', 'jars'], mass: 30, stow: 0.075, pRef: 900, stock: 230, aboard: 0 },
  { id: 'fish', name: 'Salt fish', unit: ['jar', 'jars'], mass: 40, stow: 0.075, pRef: 1000, stock: 61, aboard: 0 },
  { id: 'honey', name: 'Honey', unit: ['jar', 'jars'], mass: 25, stow: 0.04, pRef: 2000, stock: 37, aboard: 12 },
  { id: 'firewood', name: 'Firewood', unit: ['bundle', 'bundles'], mass: 25, stow: 0.06, pRef: 80, stock: 520, aboard: 0 },
  { id: 'pitch', name: 'Pitch', unit: ['jar', 'jars'], mass: 35, stow: 0.06, pRef: 800, stock: 44, aboard: 0 },
];
const FAKE_CAPACITY = 21.8;

/**
 * A static LedgerSource for the dev preview: eight goods with plausible prices, 70 jars of wine aboard,
 * a 300.0 dr purse. Orders settle locally (purse, stock and aboard change) so the panel can be tried.
 * Open it from the console: `new Ledger().open(fakeLedgerSource('trade'))` ('read' and 'hold' also work).
 */
export function fakeLedgerSource(mode: LedgerMode = 'trade'): LedgerSource {
  const byId = new Map(FAKE_GOODS.map((g) => [g.id, g] as const));
  const buyOf = (g: (typeof FAKE_GOODS)[number]) => Math.round(g.pRef * 1.03);
  const sellOf = (g: (typeof FAKE_GOODS)[number]) => Math.round(g.pRef * 0.97);
  let purse = 30000;

  /** one row's quote, settled as the spec's duty and porterage rules: pay ceil, receive floor */
  const one = (id: string, q: number): LedgerQuote => {
    const g = byId.get(id)!;
    const porters = Math.abs(q) * Math.ceil(0.25 * g.mass);
    if (q > 0) {
      const gross = q * buyOf(g);
      const pay = Math.ceil(gross * 1.02);
      return { total: -(pay + porters), duty: pay - gross, porters };
    }
    if (q < 0) {
      const gross = -q * sellOf(g);
      const receive = Math.floor(gross * 0.98);
      return { total: receive - porters, duty: gross - receive, porters };
    }
    return ZERO_QUOTE;
  };
  const quote = (orders: Record<string, number>): LedgerQuote => {
    const out = { total: 0, duty: 0, porters: 0 };
    for (const id of Object.keys(orders)) {
      const q = one(id, orders[id]);
      out.total += q.total;
      out.duty += q.duty;
      out.porters += q.porters;
    }
    return out;
  };
  const usedOf = (skip: string | null, orders: Record<string, number>) => {
    let v = 0;
    for (const g of FAKE_GOODS) {
      if (g.id === skip) continue;
      v += (g.aboard + (orders[g.id] ?? 0)) * g.stow;
    }
    return v;
  };

  return {
    mode,
    portName: 'Serrothos',
    timeLabel: 'Day 3 · 14:20',
    rows: () =>
      FAKE_GOODS.map((g) => ({
        id: g.id,
        name: g.name,
        unit: g.unit,
        stock: g.stock,
        buy: buyOf(g),
        sell: sellOf(g),
        aboard: g.aboard,
        massKg: g.mass,
        stowM3: g.stow,
      })),
    quote,
    limits(orders, id) {
      const g = byId.get(id)!;
      const others: Record<string, number> = { ...orders };
      delete others[id];
      const netOthers = quote(others).total;
      const maxStock = Math.floor(g.stock * 0.9);
      // purse: the most units the money after the other rows can pay for
      let maxPurse = 0;
      while (maxPurse < maxStock && purse + netOthers + one(id, maxPurse + 1).total >= 0) maxPurse++;
      // hold: the room left after the others, in units of this good
      const room = FAKE_CAPACITY - usedOf(id, others);
      const maxHold = Math.floor(room / g.stow);
      const cands: [number, 'purse' | 'hold' | 'stock'][] = [
        [maxPurse, 'purse'],
        [maxHold, 'hold'],
        [maxStock, 'stock'],
      ];
      let max = Infinity;
      let limitedBy: LedgerLimit['limitedBy'] = null;
      for (const [v, k] of cands) {
        if (v < max) {
          max = v;
          limitedBy = k;
        }
      }
      return { min: -g.aboard, max, limitedBy };
    },
    get purse() {
      return purse;
    },
    get hold() {
      let used = 0;
      let tonnes = 0;
      for (const g of FAKE_GOODS) {
        used += g.aboard * g.stow;
        tonnes += (g.aboard * g.mass) / 1000;
      }
      return { tonnes, used, capacity: FAKE_CAPACITY };
    },
    wagesPerDay: 1200,
    get jobLine() {
      return mode === 'read' ? null : 'Loading · 23 left';
    },
    notebook() {
      const ports = ['Serrothos', 'Kormakos', 'Korkia'];
      return {
        ports,
        current: 0,
        rows: FAKE_GOODS.map((g, i) => ({
          name: g.name,
          cells: [
            { ask: buyOf(g), bid: sellOf(g), ageHours: 0 },
            i % 3 === 2 ? null : { ask: Math.round(buyOf(g) * 1.1), bid: Math.round(sellOf(g) * 0.95), ageHours: 5 + i * 4 },
            i % 2 === 0 ? { ask: Math.round(buyOf(g) * 0.92), bid: Math.round(sellOf(g) * 0.9), ageHours: 72 } : null,
          ],
        })),
      };
    },
    confirm(orders) {
      const lines: string[] = [];
      for (const id of Object.keys(orders)) {
        const g = byId.get(id)!;
        const o = orders[id];
        if (o < 0) lines.push('Sold ' + -o + ' ' + g.name.toLowerCase() + ' · ' + fmtDr(Math.abs(one(id, o).total)));
      }
      for (const id of Object.keys(orders)) {
        const g = byId.get(id)!;
        const o = orders[id];
        if (o > 0) lines.push('Bought ' + o + ' ' + g.name.toLowerCase() + ' · ' + fmtDr(Math.abs(one(id, o).total)));
      }
      purse += quote(orders).total;
      for (const id of Object.keys(orders)) {
        const g = byId.get(id)!;
        g.aboard += orders[id];
        g.stock -= orders[id];
      }
      return lines;
    },
  };
}
