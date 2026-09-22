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
  invertY = false;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab', 'F3'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      // pointer lock (preferred), click-drag anywhere, or plain hover-look where lock is unavailable
      if (!this.locked && !this.lmb && !this.hoverLook) return;
      if (!this.locked && e.target !== this.el) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockerror', () => {
      this.hoverLook = true;
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
