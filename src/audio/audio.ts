import type { Game } from '../game';
import type { Crew } from '../ship/crew';
import { clamp } from '../core/util';

/**
 * Procedural soundscape (Web Audio, no samples): sea, hull wash, wind in the rigging,
 * the keleustes' drum, oar splashes, timber creaks, gulls, grounding.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private seaGain!: GainNode;
  private washGain!: GainNode;
  private washFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private whistleGain!: GainNode;
  private rumbleGain!: GainNode;
  private muted = false;
  volume = 0.8;
  private creakT = 0;
  private gullT = 3;
  private lastGame: Game | null = null;

  init() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // 3 s of pinkish noise
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = this.noise.getChannelData(c);
      let b0 = 0,
        b1 = 0,
        b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
    }
    const loop = () => {
      const s = ctx.createBufferSource();
      s.buffer = this.noise;
      s.loop = true;
      s.loopStart = Math.random();
      s.start(0, Math.random() * 2);
      return s;
    };
    // sea: two bands, slow swell modulation
    this.seaGain = ctx.createGain();
    const seaLp = ctx.createBiquadFilter();
    seaLp.type = 'lowpass';
    seaLp.frequency.value = 520;
    loop().connect(seaLp).connect(this.seaGain).connect(this.master);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 180;
    lfo.connect(lfoG).connect(seaLp.frequency);
    lfo.start();
    // hull wash
    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0;
    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = 'bandpass';
    this.washFilter.frequency.value = 900;
    this.washFilter.Q.value = 0.6;
    loop().connect(this.washFilter).connect(this.washGain).connect(this.master);
    // wind
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 1.2;
    loop().connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0;
    const wh = ctx.createBiquadFilter();
    wh.type = 'bandpass';
    wh.frequency.value = 1450;
    wh.Q.value = 18;
    loop().connect(wh).connect(this.whistleGain).connect(this.master);
    // grounding rumble
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rl = ctx.createBiquadFilter();
    rl.type = 'lowpass';
    rl.frequency.value = 180;
    loop().connect(rl).connect(this.rumbleGain).connect(this.master);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }
  setVolume(v: number) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  }

  private burst(when: number, freq: number, q: number, dur: number, gain: number, pan = 0, type: BiquadFilterType = 'bandpass') {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(this.master);
    s.start(when, Math.random() * 2);
    s.stop(when + dur + 0.05);
  }

  /** at each stroke catch: drum beat, then the splash of 170 blades, then the release */
  stroke(crew: Crew) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    const intensity = clamp(crew.order.effort, 0.3, 1);
    // drum: pitched membrane + skin noise
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55 * intensity, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.5);
    this.burst(t, 180, 1.2, 0.12, 0.25 * intensity, 0, 'lowpass');
    // blades entering
    this.burst(t + 0.07, 1300, 0.7, 0.35, 0.28 * intensity, -0.6);
    this.burst(t + 0.09, 1500, 0.7, 0.35, 0.28 * intensity, 0.6);
    // release (blades leave, water drips)
    const rel = t + crew.driveTime;
    this.burst(rel, 2400, 0.9, 0.5, 0.12 * intensity, -0.5);
    this.burst(rel + 0.02, 2600, 0.9, 0.5, 0.12 * intensity, 0.5);
    // oars knock in the tholes
    this.burst(t + crew.driveTime * 0.5, 420, 8, 0.08, 0.05 * intensity, (Math.random() - 0.5) * 0.8);
  }

  private gull() {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.02;
    const n = 2 + Math.floor(Math.random() * 3);
    const pan = (Math.random() - 0.5) * 1.6;
    for (let i = 0; i < n; i++) {
      const s = t + i * (0.22 + Math.random() * 0.1);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const f0 = 1500 + Math.random() * 400;
      o.frequency.setValueAtTime(f0, s);
      o.frequency.linearRampToValueAtTime(f0 * 1.25, s + 0.05);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, s + 0.2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.035, s + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.22);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      o.connect(bp).connect(g).connect(p).connect(this.master);
      o.start(s);
      o.stop(s + 0.25);
    }
  }

  update(dt: number, g: Game) {
    this.lastGame = g;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const ship = g.ship;
    const eagle = g.player.mode === 'eagle';
    const camH = g.camera.position.y;
    const nearSea = clamp(1 - (camH - 3) / 120, 0.05, 1);
    const sp = Math.abs(ship.speed);
    const aw = ship.apparentWind.length();
    const eagleSpeed = eagle ? g.player.eagleVel.length() : 0;
    this.seaGain.gain.setTargetAtTime((0.35 + g.waves.hs * 0.3) * nearSea, t, 0.3);
    this.washGain.gain.setTargetAtTime(eagle ? 0 : clamp(sp / 5, 0, 1.2) * 0.5, t, 0.2);
    this.washFilter.frequency.setTargetAtTime(600 + sp * 160, t, 0.2);
    const windLevel = eagle ? clamp(eagleSpeed / 40, 0.2, 1.4) : clamp(aw / 12, 0.05, 1.2);
    this.windGain.gain.setTargetAtTime(windLevel * 0.35, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(eagle ? 500 + eagleSpeed * 20 : 350 + aw * 45, t, 0.3);
    this.whistleGain.gain.setTargetAtTime(eagle ? 0 : clamp((aw - 7) / 8, 0, 1) * 0.12, t, 0.5);
    this.rumbleGain.gain.setTargetAtTime(clamp(ship.grounding * 3, 0, 1) * clamp(sp, 0.2, 2) * 0.6, t, 0.1);
    // timber creaks with the roll
    if (!eagle) {
      this.creakT -= dt;
      const roll = Math.abs(ship.angVel.x) + Math.abs(ship.angVel.z);
      if (this.creakT <= 0 && roll > 0.015) {
        this.creakT = 0.6 + Math.random() * 2.5;
        const f = 280 + Math.random() * 400;
        this.burst(t + 0.01, f, 25, 0.25 + Math.random() * 0.3, 0.05 + roll * 0.6, (Math.random() - 0.5) * 1.4);
      }
    }
    // gulls when near land by day
    this.gullT -= dt;
    if (this.gullT <= 0) {
      this.gullT = 3 + Math.random() * 9;
      const p = g.camera.position;
      let nearLand = false;
      for (let a = 0; a < 6 && !nearLand; a++) {
        const x = p.x + Math.cos(a) * 400,
          z = p.z + Math.sin(a) * 400;
        if (g.terrain.heightAt(x, z) > 0) nearLand = true;
      }
      if (nearLand && g.sky.night < 0.5 && !this.muted) this.gull();
    }
  }
}
