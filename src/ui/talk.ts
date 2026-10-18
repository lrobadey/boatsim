import './talk.css';

/**
 * Talking with a stall trader (docs/kormakos-and-traders-spec.md, part B): a small panel over the quay with
 * the conversation and a line to type into. Keyboard-first: Enter says the line, Tab opens the ledger, Esc
 * leaves; the buttons under the line (Trade, Show letter, Review agreement) are ordinary focusable buttons, reached
 * with Shift+Tab (Tab and Shift+Tab move between the panel's buttons and the line, and Enter presses a button). When the trader has a card for you (a proposal, a sale, an account), Ctrl+Enter confirms it and
 * Ctrl+Backspace declines it; you can keep talking meanwhile. The panel only shows and collects input; the trade layer talks to the model.
 */
export interface TalkLine {
  /** 'doc': a document shown to you, quoted in the conversation (never sent to the model or saved) */
  who: 'you' | 'them' | 'info' | 'doc';
  text: string;
}

export interface TalkSource {
  /** the trader's name and the port */
  name: string;
  port: string;
  /** the conversation so far at this stall (kept by the caller across openings) */
  lines: TalkLine[];
  /** says a line; resolves when the trader has answered (the caller appends to `lines`) */
  say(text: string): Promise<void>;
  /** the card waiting for you, or null */
  card(): { title: string; lines: string[] } | null;
  /** Ctrl+Enter on a card: runs it; resolves when the trader has answered */
  confirm(): Promise<void>;
  /** Ctrl+Backspace on a card: declines it; resolves when the trader has answered */
  decline(): Promise<void>;
  /** Tab or the Trade button: leave the conversation for the ledger */
  ledger(): void;
  /** true when you hold a letter you could show */
  canShowLetter(): boolean;
  /** the Show letter button: shows your letter (or lets you choose one); resolves when the trader has answered */
  showLetter(): void;
  /** true when you have an agreement to review */
  hasAgreement(): boolean;
  /** the Review agreement button: opens the personal menu's expectations over the conversation */
  review(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export class Talk {
  private readonly root = el('div', 'talk-root');
  private readonly panel = el('div', 'talk');
  private readonly nameEl = el('h2', 'talk-name');
  private readonly portEl = el('div', 'talk-port');
  private readonly log = el('div', 'talk-log');
  private readonly cardEl = el('div', 'talk-card');
  private readonly cardBody = el('div', 'talk-card-body');
  private readonly input = el('input', 'talk-input');
  private readonly buttons = el('div', 'talk-buttons');
  private readonly tradeBtn = el('button', 'talk-btn');
  private readonly letterBtn = el('button', 'talk-btn');
  private readonly reviewBtn = el('button', 'talk-btn');
  private readonly confirmBtn = el('button', 'talk-btn primary');
  private readonly declineBtn = el('button', 'talk-btn');
  private src: TalkSource | null = null;
  /** conversations waiting on a reply, by their `lines` (the caller builds a new source on every opening) */
  private readonly pending = new WeakSet<TalkLine[]>();
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);
  onClose?: () => void;
  /** after each exchange has answered (or failed): screens over the conversation may redraw */
  onSettled?: () => void;
  /** true while another screen (the personal menu) is over the conversation: keys and focus are left to it */
  covered: () => boolean = () => false;

  constructor() {
    const head = el('div', 'talk-head');
    head.append(this.nameEl, this.portEl);
    this.input.type = 'text';
    this.input.maxLength = 300;
    this.input.placeholder = 'Say something';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    const keys = el('div', 'talk-keys');
    keys.innerHTML = '<span><kbd>Enter</kbd> Say</span><span><kbd>Tab</kbd> Ledger</span><span><kbd>Esc</kbd> Leave</span>';
    const cardKeys = el('div', 'talk-keys');
    cardKeys.innerHTML = '<span><kbd>Ctrl</kbd><kbd>Enter</kbd> Confirm</span><span><kbd>Ctrl</kbd><kbd>Backspace</kbd> Decline</span>';
    const cardButtons = el('div', 'talk-buttons');
    for (const [b, text] of [[this.confirmBtn, 'Confirm'], [this.declineBtn, 'Decline'], [this.tradeBtn, 'Trade'], [this.letterBtn, 'Show letter'], [this.reviewBtn, 'Review agreement']] as const) {
      b.type = 'button';
      b.textContent = text;
    }
    this.confirmBtn.addEventListener('click', () => this.src && void this.act(this.src, true));
    this.declineBtn.addEventListener('click', () => this.src && void this.act(this.src, false));
    this.tradeBtn.addEventListener('click', () => this.src?.ledger());
    this.letterBtn.addEventListener('click', () => this.src?.showLetter());
    this.reviewBtn.addEventListener('click', () => this.src?.review());
    cardButtons.append(this.confirmBtn, this.declineBtn);
    this.buttons.append(this.tradeBtn, this.letterBtn, this.reviewBtn);
    this.cardEl.hidden = true;
    this.cardEl.append(this.cardBody, cardButtons, cardKeys);
    this.panel.append(head, this.log, this.cardEl, this.input, this.buttons, keys);
    this.root.append(this.panel);
    document.getElementById('ui')!.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.src !== null;
  }

  /** the open conversation is waiting on the trader's answer */
  get waiting(): boolean {
    return this.src !== null && this.pending.has(this.src.lines);
  }

  open(src: TalkSource): void {
    this.src = src;
    this.nameEl.textContent = src.name;
    this.portEl.textContent = src.port;
    this.input.value = '';
    this.root.classList.add('on');
    window.addEventListener('keydown', this.onKeyDown, true);
    this.render();
    requestAnimationFrame(() => this.input.focus());
  }

  close(): void {
    if (!this.src) return;
    this.src = null;
    this.root.classList.remove('on');
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.input.blur();
    this.onClose?.();
  }

  /** redraws the conversation (cheap: a few dozen short lines at most) */
  render(): void {
    const s = this.src;
    if (!s) return;
    const waiting = this.pending.has(s.lines);
    this.log.replaceChildren(
      ...s.lines.map((l) => {
        const p = el('p', 'tl ' + l.who);
        if (l.who === 'them') {
          const n = el('span', 'tl-who');
          n.textContent = s.name;
          p.append(n);
        }
        p.append(l.text);
        return p;
      }),
    );
    if (waiting) {
      const p = el('p', 'tl them wait');
      const n = el('span', 'tl-who');
      n.textContent = s.name;
      p.append(n, '…');
      this.log.append(p);
    }
    const card = waiting ? null : s.card();
    this.cardEl.hidden = !card;
    if (card) {
      const title = el('h3', 'talk-card-title');
      title.textContent = card.title;
      const lines = card.lines.map((text) => {
        const p = el('p', 'talk-card-line');
        p.textContent = text;
        return p;
      });
      this.cardBody.replaceChildren(title, ...lines);
    }
    // scroll once the card is laid out: it takes room from the log
    this.log.scrollTop = this.log.scrollHeight;
    this.input.disabled = waiting;
    this.confirmBtn.disabled = this.declineBtn.disabled = waiting;
    this.letterBtn.hidden = !s.canShowLetter();
    this.letterBtn.disabled = waiting;
    this.reviewBtn.hidden = !s.hasAgreement();
    if (!waiting && !this.covered() && document.activeElement !== this.input) this.input.focus();
  }

  /** one exchange with the trader (a line, a card's outcome, a letter shown): the panel shows the wait until it has answered */
  async run(exchange: () => Promise<void>): Promise<void> {
    const s = this.src;
    if (!s || this.pending.has(s.lines)) return;
    this.pending.add(s.lines);
    try {
      // the caller appends your line before it waits, so the redraw shows it under the trader's pending '…'
      const answered = exchange();
      this.render();
      await answered;
    } finally {
      this.pending.delete(s.lines);
      // the panel may have been closed and reopened meanwhile with a new source over the same lines
      if (this.src) this.render();
      this.onSettled?.();
    }
  }

  private async send(s: TalkSource): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.pending.has(s.lines)) return;
    this.input.value = '';
    await this.run(() => s.say(text));
  }

  private async act(s: TalkSource, confirm: boolean): Promise<void> {
    if (!s.card() || this.pending.has(s.lines)) return;
    await this.run(() => (confirm ? s.confirm() : s.decline()));
  }

  /** the next (dir 1) or previous (−1) of the panel's usable controls in screen order, from the focused one */
  private moveFocus(dir: 1 | -1): void {
    const card = this.cardEl.hidden ? [] : [this.confirmBtn, this.declineBtn];
    const all: HTMLElement[] = [...card, this.input, this.tradeBtn, this.letterBtn, this.reviewBtn];
    const usable = all.filter((x) => !x.hidden && !(x as HTMLButtonElement | HTMLInputElement).disabled);
    if (!usable.length) return;
    const i = usable.indexOf(document.activeElement as HTMLElement);
    const n = i < 0 ? (dir > 0 ? 0 : usable.length - 1) : (i + dir + usable.length) % usable.length;
    usable[n].focus();
  }

  private handleKey(e: KeyboardEvent): void {
    const s = this.src;
    if (!s || this.covered()) return;
    // the game never sees keys while the panel is open; the text field still receives them
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Tab') {
      // Tab from the text line opens the ledger; otherwise focus moves around the panel's controls, wrapping
      e.preventDefault();
      if (document.activeElement === this.input && !e.shiftKey) s.ledger();
      else this.moveFocus(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter') {
      if (e.ctrlKey) {
        e.preventDefault();
        if (!e.repeat && s.card()) void this.act(s, true);
      } else if (document.activeElement === this.input) {
        e.preventDefault();
        if (!e.repeat) void this.send(s);
      }
      // on a button, Enter presses it
    } else if (e.key === 'Backspace' && e.ctrlKey && s.card()) {
      e.preventDefault();
      if (!e.repeat) void this.act(s, false);
    }
  }
}
