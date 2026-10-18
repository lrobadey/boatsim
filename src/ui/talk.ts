import './talk.css';

/**
 * Talking with a stall trader (docs/kormakos-and-traders-spec.md, part B): a small panel over the quay with
 * the conversation and a line to type into. Keyboard-first: Enter says the line, Tab opens the ledger, Esc
 * leaves. When the trader has a card for you (a proposal, a sale, an account), Ctrl+Enter confirms it and
 * Ctrl+Backspace declines it; you can keep talking meanwhile. The panel only shows and collects input; the trade layer talks to the model.
 */
export interface TalkLine {
  who: 'you' | 'them' | 'info';
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
  /** Tab: leave the conversation for the ledger */
  ledger(): void;
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
  private src: TalkSource | null = null;
  /** conversations waiting on a reply, by their `lines` (the caller builds a new source on every opening) */
  private readonly pending = new WeakSet<TalkLine[]>();
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);
  onClose?: () => void;

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
    this.cardEl.hidden = true;
    this.cardEl.append(this.cardBody, cardKeys);
    this.panel.append(head, this.log, this.cardEl, this.input, keys);
    this.root.append(this.panel);
    document.getElementById('ui')!.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.src !== null;
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
    this.log.scrollTop = this.log.scrollHeight;
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
    this.input.disabled = waiting;
    if (!waiting && document.activeElement !== this.input) this.input.focus();
  }

  /** one exchange with the trader (a line, or a card's outcome): the panel shows the wait until it has answered */
  private async run(exchange: () => Promise<void>): Promise<void> {
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

  private handleKey(e: KeyboardEvent): void {
    const s = this.src;
    if (!s) return;
    // the game never sees keys while the panel is open; the text field still receives them
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      s.ledger();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      if (e.ctrlKey && s.card()) void this.act(s, true);
      else if (!e.ctrlKey) void this.send(s);
    } else if (e.key === 'Backspace' && e.ctrlKey && s.card()) {
      e.preventDefault();
      if (!e.repeat) void this.act(s, false);
    }
  }
}
