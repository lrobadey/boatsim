import './personal.css';
import type { JournalItem, JournalView } from '../social/journal';

/**
 * The personal menu (expectations-mvp-spec §5): Belongings, Ship cargo, Expectations and Accounts. Opened from the
 * pause menu, the ledger, or a conversation's Review agreement; the world is stopped while it is open. Buttons and
 * tabs are ordinary focusable elements (Tab moves between them); Esc closes it. It only shows and collects input.
 */
export type PersonalTab = 'belongings' | 'cargo' | 'expectations' | 'accounts';

export interface PersonalSource {
  view(): JournalView;
  /** the person you could show a document to right now (an open conversation), or null */
  showTo(): string | null;
  /** shows the document to that person; resolves once the menu should close and the conversation go on */
  show(document: string): void;
}

const TABS: [PersonalTab, string][] = [
  ['belongings', 'Belongings'],
  ['cargo', 'Ship cargo'],
  ['expectations', 'Expectations'],
  ['accounts', 'Accounts'],
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class PersonalMenu {
  private readonly root = el('div', 'pm-root');
  private readonly panel = el('div', 'pm');
  private readonly tabsEl = el('div', 'pm-tabs');
  private readonly body = el('div', 'pm-body');
  private readonly tabButtons = new Map<PersonalTab, HTMLButtonElement>();
  private src: PersonalSource | null = null;
  private tab: PersonalTab = 'belongings';
  /** the letter being read, if any */
  private reading: string | null = null;
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);
  onClose?: () => void;

  constructor() {
    const head = el('div', 'pm-head');
    head.append(el('h2', 'pm-title', 'Belongings and accounts'));
    const close = el('button', 'pm-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(close);
    this.tabsEl.setAttribute('role', 'tablist');
    for (const [id, label] of TABS) {
      const b = el('button', 'pm-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.select(id));
      this.tabButtons.set(id, b);
      this.tabsEl.append(b);
    }
    this.body.setAttribute('role', 'tabpanel');
    this.panel.append(head, this.tabsEl, this.body);
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Belongings and accounts');
    this.root.append(this.panel);
    document.getElementById('ui')!.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.src !== null;
  }

  open(src: PersonalSource, tab: PersonalTab = 'belongings'): void {
    if (!this.src) window.addEventListener('keydown', this.onKeyDown, true);
    this.src = src;
    this.reading = null;
    this.root.classList.add('on');
    this.select(tab);
  }

  close(): void {
    if (!this.src) return;
    this.src = null;
    this.root.classList.remove('on');
    window.removeEventListener('keydown', this.onKeyDown, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.onClose?.();
  }

  private select(tab: PersonalTab): void {
    this.tab = tab;
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    this.render();
    this.tabButtons.get(tab)!.focus();
  }

  private render(): void {
    const s = this.src;
    if (!s) return;
    const v = s.view();
    const parts: HTMLElement[] = [];
    if (this.tab === 'belongings') {
      if (!v.belongings.length) parts.push(el('p', 'pm-empty', "You aren't carrying anything."));
      const to = s.showTo();
      for (const d of v.belongings) {
        const item = this.item(d);
        const actions = el('div', 'pm-actions');
        const read = el('button', 'pm-btn', this.reading === d.id ? 'Put away' : 'Read');
        read.type = 'button';
        read.dataset.key = `read:${d.id}`;
        read.addEventListener('click', () => {
          this.reading = this.reading === d.id ? null : d.id;
          this.render();
        });
        actions.append(read);
        if (to) {
          const show = el('button', 'pm-btn primary', `Show to ${to}`);
          show.type = 'button';
          show.dataset.key = `show:${d.id}`;
          show.addEventListener('click', () => {
            this.close();
            s.show(d.id);
          });
          actions.append(show);
        }
        if (this.reading === d.id) item.append(el('blockquote', 'pm-letter', d.body));
        item.append(actions);
        parts.push(item);
      }
    } else if (this.tab === 'cargo') {
      if (!v.cargo.length) parts.push(el('p', 'pm-empty', 'The hold is empty.'));
      const list = el('ul', 'pm-list');
      for (const line of v.cargo) list.append(el('li', undefined, line));
      if (v.cargo.length) parts.push(list);
    } else if (this.tab === 'expectations') {
      if (!v.expectations.length) parts.push(el('p', 'pm-empty', 'No agreements or promises.'));
      for (const x of v.expectations) parts.push(this.item(x));
    } else {
      const purse = el('div', 'pm-purse');
      purse.append(el('span', 'pm-label', 'Purse'), el('b', undefined, v.accounts.purse));
      parts.push(purse);
      for (const x of v.accounts.ventures) parts.push(this.item(x));
      if (v.accounts.recent.length) {
        parts.push(el('h3', 'pm-sub', 'Recent'));
        const list = el('ul', 'pm-list pm-recent');
        for (const line of v.accounts.recent) list.append(el('li', undefined, line));
        parts.push(list);
      }
    }
    // a redraw replaces the buttons: keep the keyboard on the one that had it
    const had = (document.activeElement as HTMLElement | null)?.dataset?.key;
    this.body.replaceChildren(...parts);
    if (had) this.body.querySelector<HTMLElement>(`[data-key="${had}"]`)?.focus();
  }

  private item(x: JournalItem): HTMLElement {
    const box = el('section', 'pm-item');
    box.append(el('h3', 'pm-item-title', x.title));
    for (const line of x.lines) box.append(el('p', 'pm-line', line));
    return box;
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.src) return;
    // the game and the conversation underneath never see keys while the menu is open
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (!(document.activeElement as HTMLElement | null)?.classList.contains('pm-tab')) return;
      e.preventDefault();
      const i = TABS.findIndex(([id]) => id === this.tab);
      const n = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      this.select(TABS[n][0]);
    }
  }
}
