/**
 * One axis of arrow-key look. The angular rate is a first-order (critically damped) approach to a target
 * that ramps with the hold time: a tap is a fine adjustment, a hold sweeps. Release decays to zero.
 */
class ArrowAxis {
  private hold = 0;
  private rate = 0;

  /** rad this frame for a direction in {−1, 0, 1}; rates in rad/s at a tap and at a long hold */
  step(dt: number, dir: number, tap: number, hold: number, scale: number): number {
    this.hold = dir !== 0 ? this.hold + dt : 0;
    const ramp = Math.min(1, this.hold / ARROW_RAMP);
    const target = dir * (tap + (hold - tap) * ramp) * scale;
    this.rate += (target - this.rate) * (1 - Math.exp(-dt / ARROW_TAU));
    return this.rate * dt;
  }
}
const ARROW_TAU = 0.08; // s
const ARROW_RAMP = 0.4; // s of hold to reach the fast rate

/** Keyboard/mouse state. Look is by arrow keys; the mouse looks only when mouse look is switched on. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>(); // edge-triggered this frame
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  rmb = false;
  lmb = false;
  locked = false;
  /**
   * Mouse look (opt-in, pause menu). Off by default: no pointer lock is requested, and mouse movement
   * does not turn the view. On: pointer-lock deltas look, or LMB drag where the lock is refused.
   */
  mouseLook = false;
  /** kept for the game's HUD: never set now (there is no hover look) */
  hoverLook = false;
  /** rad per px of mouse look */
  sensitivity = 0.0022;
  /** scale on the arrow-key look rates (pause menu "Look speed") */
  lookSpeed = 1;
  /** the game allows continuous arrow-key look right now (not paused, no menu) */
  lookEnabled = true;
  invertY = false;
  onLockChange: ((locked: boolean) => void) | null = null;
  /**
   * A click for build placement, edge-triggered: an LMB press and release with under 4 px of movement
   * between them, or Enter.
   */
  clicked = false;

  private arrowYaw = new ArrowAxis();
  private arrowPitch = new ArrowAxis();
  /** path length of the LMB press in progress, px; −1 when no press is in progress */
  private pressTravel = -1;

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.clicked = true;
      if (['Space', 'Tab', 'F3', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (this.pressTravel >= 0) this.pressTravel += Math.hypot(e.movementX, e.movementY);
      if (!this.mouseLook) return;
      // locked: always look. unlocked: look only while dragging with LMB, wherever the drag is.
      if (!this.locked && !this.lmb) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.rmb = true;
      if (e.button === 0) {
        this.lmb = true;
        this.pressTravel = 0;
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.rmb = false;
      if (e.button === 0) {
        this.lmb = false;
        if (this.pressTravel >= 0 && this.pressTravel < 4) this.clicked = true;
        this.pressTravel = -1;
      }
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => (this.wheel += Math.sign(e.deltaY)), { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      this.onLockChange?.(this.locked);
    });
  }

  /** request pointer lock; only when mouse look is on, so by default the browser is never asked */
  lock() {
    if (!this.mouseLook) return;
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      // the lock is refused: drag-to-look still works
    }
  }

  /** raw arrow directions in [-1, 1] per axis (right / down positive) */
  get lookX() {
    return Math.max(-1, Math.min(1, (this.down('ArrowRight') ? 1 : 0) - (this.down('ArrowLeft') ? 1 : 0)));
  }
  get lookY() {
    return Math.max(-1, Math.min(1, (this.down('ArrowDown') ? 1 : 0) - (this.down('ArrowUp') ? 1 : 0)));
  }

  /**
   * Arrow-key look for this frame, in rad (yaw: right positive; pitch: down positive). Call once per frame.
   * Yaw rates 0.7 → 2.2 rad/s and pitch 0.5 → 1.3 rad/s over the first 0.4 s of a hold.
   */
  look(dt: number): { yaw: number; pitch: number } {
    const s = this.lookSpeed;
    return {
      yaw: this.arrowYaw.step(dt, this.lookX, 0.7, 2.2, s),
      pitch: this.arrowPitch.step(dt, this.lookY, 0.5, 1.3, s),
    };
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
    this.clicked = false;
  }
}
