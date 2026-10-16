import './talk.css';

/**
 * Talking with a stall trader (docs/kormakos-and-traders-spec.md, part B): a small panel over the quay with
 * the conversation and a line to type into. Keyboard-first: Enter says the line, Tab opens the ledger, Esc
 * leaves. The panel only shows and collects text; the trade layer talks to the model.
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
  private readonly input = el('input', 'talk-input');
  private src: TalkSource | null = null;
  private pending = false;
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
    this.panel.append(head, this.log, this.input, keys);
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
    if (this.pending) {
      const p = el('p', 'tl them wait');
      const n = el('span', 'tl-who');
      n.textContent = s.name;
      p.append(n, '…');
      this.log.append(p);
    }
    this.log.scrollTop = this.log.scrollHeight;
    this.input.disabled = this.pending;
    if (!this.pending && document.activeElement !== this.input) this.input.focus();
  }

  private async send(): Promise<void> {
    const s = this.src;
    const text = this.input.value.trim();
    if (!s || this.pending || !text) return;
    this.input.value = '';
    this.pending = true;
    try {
      // say() appends your line before it waits, so the redraw shows it under the trader's pending '…'
      const answered = s.say(text);
      this.render();
      await answered;
    } finally {
      this.pending = false;
      if (this.src === s) this.render();
    }
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
      if (!e.repeat) void this.send();
    }
  }
}
