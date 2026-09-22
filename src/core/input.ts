/** Keyboard/mouse state with pointer lock. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>(); // edge-triggered this frame
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  rmb = false;
  lmb = false;
  locked = false;
  /** mouse movement looks around without pointer lock (fallback when the browser refuses lock) */
  hoverLook = false;
  sensitivity = 0.0022;
  /** cursor position in [0,1] (no-lock fallback) */
  cursorX = 0.5;
  cursorY = 0.5;
  cursorIn = false;
  /** the game allows continuous edge/arrow look right now (not paused, no menu) */
  lookEnabled = true;
  invertY = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab', 'F3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      this.cursorX = e.clientX / Math.max(1, window.innerWidth);
      this.cursorY = e.clientY / Math.max(1, window.innerHeight);
      this.cursorIn = e.target === this.el;
      // pointer lock (preferred), click-drag anywhere, or plain hover-look where lock is unavailable
      if (!this.locked && !this.lmb && !this.hoverLook) return;
      if (!this.locked && e.target !== this.el) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockerror', () => {
      this.hoverLook = true;
    });
    document.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) this.cursorIn = false; // left the window: stop edge turning
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.rmb = true;
      if (e.button === 0) this.lmb = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0) this.lmb = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.locked) this.hoverLook = false; // lock works after all (e.g. a retry after Esc)
      this.onLockChange?.(this.locked);
    });
  }

  lock() {
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => (this.hoverLook = true));
    } catch {
      this.hoverLook = true;
    }
  }

  /**
   * Continuous look rate in [-1, 1] per axis: arrow keys always; without pointer lock, resting the
   * cursor near a screen edge keeps turning (a hover-look cursor can't travel past the edge).
   */
  get lookX() {
    let v = (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0);
    if (this.edgeActive) v += edge(this.cursorX) - edge(1 - this.cursorX);
    return Math.max(-1, Math.min(1, v));
  }
  get lookY() {
    let v = (this.down('ArrowDown') ? 1 : 0) - (this.down('ArrowUp') ? 1 : 0);
    if (this.edgeActive) v += 0.7 * (edge(this.cursorY) - edge(1 - this.cursorY));
    return Math.max(-1, Math.min(1, v));
  }
  private get edgeActive() {
    return this.lookEnabled && this.hoverLook && !this.locked && this.cursorIn && !this.lmb;
  }

  down(code: string) {
    return this.keys.has(code);
  }
  hit(code: string) {
    return this.pressed.has(code);
  }
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}

/** 0 inside the screen, ramping to 1 over the outer ~12% toward the edge */
function edge(t: number) {
  const x = Math.max(0, Math.min(1, (t - 0.87) / 0.11));
  return x * x * (3 - 2 * x);
}
