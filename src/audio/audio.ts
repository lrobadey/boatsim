import type { RowEventCursor } from '../ship/rowing';
import type { OarPropulsion } from '../ship/oarPropulsion';
import type { Game } from '../game';
import type { Crew } from '../ship/crew';
import { clamp } from '../core/util';
import type { SurfaceKind } from '../world/walkable';

/** ±8% per-call variation so repeated one-shots never sound identical */
const vary = (v: number) => v * (1 + (Math.random() * 2 - 1) * 0.08);

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
  // continuous beds, each fed every frame by its caller and faded out by update() if it goes quiet
  private lineBed!: GainNode;
  private lineK = 0;
  private lineCallT = -Infinity;
  private creakCD = 0;
  private voiceGain!: GainNode;
  private voiceF1!: BiquadFilterNode;
  private voiceF2!: BiquadFilterNode;
  private lapGain!: GainNode;
  private harbourCallT = -Infinity;
  private voiceT = 0;
  private hammerT = 2;
  private dogT = 20;

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
    this.buildBeds(loop);
    this.devHook();
  }

  private buildBeds(loop: () => AudioBufferSourceNode) {
    const ctx = this.ctx!;
    const m = this.master;
    // rope under load: a resonant creak whose level is set by lineCreak()
    this.lineBed = ctx.createGain();
    this.lineBed.gain.value = 0;
    const lb = ctx.createBiquadFilter();
    lb.type = 'bandpass';
    lb.frequency.value = 340;
    lb.Q.value = 6;
    loop().connect(lb).connect(this.lineBed).connect(m);
    // harbour murmur: two formants on noise, tremolo'd so it reads as speech rather than hiss
    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;
    const murmur = ctx.createGain();
    murmur.gain.value = 0.5;
    const mLfo = ctx.createOscillator();
    mLfo.frequency.value = 2.7;
    const mDepth = ctx.createGain();
    mDepth.gain.value = 0.4;
    mLfo.connect(mDepth).connect(murmur.gain);
    mLfo.start();
    this.voiceF1 = ctx.createBiquadFilter();
    this.voiceF1.type = 'bandpass';
    this.voiceF1.frequency.value = 650;
    this.voiceF1.Q.value = 3.5;
    this.voiceF2 = ctx.createBiquadFilter();
    this.voiceF2.type = 'bandpass';
    this.voiceF2.frequency.value = 1500;
    this.voiceF2.Q.value = 4;
    loop().connect(this.voiceF1).connect(murmur);
    loop().connect(this.voiceF2).connect(murmur);
    murmur.connect(this.voiceGain).connect(m);
    // lapping against stone: slow swell on low-passed noise
    this.lapGain = ctx.createGain();
    this.lapGain.gain.value = 0;
    const lapAmp = ctx.createGain();
    lapAmp.gain.value = 0.5;
    const lapLfo = ctx.createOscillator();
    lapLfo.frequency.value = 0.17;
    const lapDepth = ctx.createGain();
    lapDepth.gain.value = 0.5;
    lapLfo.connect(lapDepth).connect(lapAmp.gain);
    lapLfo.start();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    loop().connect(lp).connect(lapAmp).connect(this.lapGain).connect(m);
  }

  /** Dev only (`?dev` in the URL): window.audioTest() plays each one-shot once, 0.9 s apart. */
  private devHook() {
    if (typeof location === 'undefined' || !location.search.includes('dev')) return;
    const steps: [string, () => void][] = [
      ['footstep wood', () => this.footstep('wood', 1)],
      ['footstep stone', () => this.footstep('stone', 1)],
      ['footstep rock', () => this.footstep('rock', 1)],
      ['footstep sand', () => this.footstep('sand', 1)],
      ['footstep grass', () => this.footstep('grass', 1)],
      ['footstep shallows', () => this.footstep('shallows', 1)],
      ['land wood', () => this.land('wood', 6)],
      ['splash', () => this.splash(0.8)],
      ['swimStroke', () => this.swimStroke()],
      ['ropeThrow', () => this.ropeThrow()],
      ['hullBump 0.4', () => this.hullBump(0.4)],
      ['hullBump 0.95', () => this.hullBump(0.95)],
      ['anchorDrop', () => this.anchorDrop()],
      ['anchorWeigh 1.5 s', () => this.anchorWeigh(1.5)],
      ['plank down', () => this.plank(true)],
      ['plank up', () => this.plank(false)],
      ['buildPlace', () => this.buildPlace()],
      ['buildRemove', () => this.buildRemove()],
      ['buildDeny', () => this.buildDeny()],
    ];
    (window as any).audioTest = () => {
      steps.forEach(([name, fn], i) =>
        setTimeout(() => {
          console.log('[audioTest]', name);
          fn();
        }, i * 900));
    };
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }
  setVolume(v: number) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  }

  /** Filtered-noise hit (freq may sweep to freqEnd). Nodes disconnect themselves when it ends. */
  private burst(when: number, freq: number, q: number, dur: number, gain: number, pan = 0,
    type: BiquadFilterType = 'bandpass', attack = 0.012, freqEnd = freq) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, when);
    if (freqEnd !== freq) f.frequency.exponentialRampToValueAtTime(freqEnd, when + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(this.master);
    s.start(when, Math.random() * 2);
    s.stop(when + dur + 0.05);
    s.onended = () => {
      s.disconnect();
      f.disconnect();
      g.disconnect();
      p.disconnect();
    };
  }

  /** Pitched one-shot with a fast exponential glide. Nodes disconnect themselves when it ends. */
  private tone(when: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType = 'sine', pan = 0, attack = 0.004) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.05);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
      p.disconnect();
    };
  }

  private live() {
    return !!this.ctx && !this.muted;
  }

  /** The beat marks the current catch; water sounds come only from actual contact events. */
  strokeBeat(intensity: number) {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;
    intensity = clamp(intensity, 0.15, 1);
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
    // Thole knock belongs to this beat, rather than a predicted future extraction.
    this.burst(t, 420, 8, 0.08, 0.05 * intensity, 0);
  }

  oarContact(side: number, enter: boolean, intensity: number) {
    if (!this.ctx || this.muted || intensity <= 0) return;
    this.burst(this.ctx.currentTime + 0.01, enter ? 1400 : 2500, enter ? 0.7 : 0.9,
      enter ? 0.35 : 0.5, (enter ? 0.28 : 0.12) * clamp(intensity, 0, 1), side * 0.6);
  }
  private rowingCursor: RowEventCursor | null = null;
  private lastBeatTime = -Infinity;
  /** the keleustes' drum on each catch (trireme only) */
  drumEnabled = true;
  private contactBins = new Map<number, { bin: number; side: number; enter: boolean; energy: number }>();
  rowingEvents(rowing: OarPropulsion, renderTime: number) {
    if (!this.rowingCursor || this.rowingCursor.epoch !== rowing.events.generation) {
      this.rowingCursor = { next: rowing.events.oldestId, epoch: rowing.events.generation };
      this.lastBeatTime = -Infinity;
      this.contactBins.clear();
    }
    rowing.events.read(this.rowingCursor, renderTime, event => {
      if (event.kind === 'catchBeat') {
        if (this.drumEnabled && event.time - this.lastBeatTime >= 0.08) { this.strokeBeat(event.intensity); this.lastBeatTime = event.time; }
      } else {
        const bin = Math.floor(event.time / 0.05), enter = event.kind === 'enterWater';
        const key = bin * 4 + (event.side > 0 ? 2 : 0) + (enter ? 0 : 1);
        const existing = this.contactBins.get(key);
        if (existing) existing.energy += event.intensity * event.intensity;
        else this.contactBins.set(key, { bin, side: event.side, enter, energy: event.intensity * event.intensity });
      }
    });
    for (const [key, value] of this.contactBins) if ((value.bin + 1) * 0.05 <= renderTime) {
      this.oarContact(value.side, value.enter, Math.min(1, Math.sqrt(value.energy))); this.contactBins.delete(key);
    }
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

  // ---- footsteps, impacts, water (WS-E) ----

  footstep(kind: SurfaceKind, intensity: number) {
    if (!this.live()) return;
    const i = clamp(intensity, 0, 1.5);
    if (i <= 0) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.5;
    switch (kind) {
      case 'wood':
        // hollow body knock with a quick pitch drop, and a dry click on top
        this.tone(t, vary(150), vary(95), 0.07, vary(0.05) * i, 'triangle', pan, 0.002);
        this.burst(t, vary(2600), 3, 0.02, vary(0.012) * i, pan, 'bandpass', 0.001);
        break;
      case 'stone':
        this.burst(t, vary(1800), 2.5, 0.03, vary(0.05) * i, pan, 'bandpass', 0.001);
        this.tone(t, vary(80), vary(45), 0.09, vary(0.02) * i, 'sine', pan, 0.003);
        break;
      case 'rock':
        this.burst(t, vary(1500), 1.2, 0.04, vary(0.045) * i, pan, 'bandpass', 0.001);
        this.burst(t, vary(3800), 1, 0.02, vary(0.02) * i, pan, 'highpass', 0.001);
        this.tone(t, vary(95), vary(55), 0.08, vary(0.02) * i, 'sine', pan, 0.003);
        break;
      case 'sand':
        this.burst(t, vary(1100), 0.7, vary(0.075), vary(0.045) * i, pan, 'lowpass', 0.015);
        break;
      case 'grass':
        this.burst(t, vary(3200), 0.9, vary(0.085), vary(0.03) * i, pan, 'bandpass', 0.012);
        break;
      case 'shallows':
        this.burst(t, vary(1200), 0.9, vary(0.22), vary(0.05) * i, pan, 'bandpass', 0.02);
        for (let k = 0; k < 3; k++)
          this.tone(t + 0.04 + k * 0.06 + Math.random() * 0.02, vary(350 + k * 90), vary(520 + k * 120), 0.035, vary(0.008) * i, 'sine', pan);
        break;
    }
  }

  land(kind: SurfaceKind, speed: number) {
    if (!this.live()) return;
    const k = clamp(Math.abs(speed) / 6, 0.25, 1.4);
    this.footstep(kind, k);
    const t = this.ctx!.currentTime + 0.01;
    this.tone(t, vary(70), vary(38), 0.22, vary(0.06) * k, 'sine', 0, 0.005);
    this.burst(t, vary(320), 0.8, vary(0.14), vary(0.03) * k, 0, 'lowpass', 0.004);
  }

  /** size ~0..1: a descending band-pass wash, longer and deeper for a bigger entry. */
  splash(size: number) {
    if (!this.live()) return;
    const s = clamp(size, 0.1, 1.5);
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.6;
    this.burst(t, vary(3000), 1.2, vary(0.3 + 0.45 * s), vary(0.09) * s, pan, 'bandpass', 0.006, vary(800));
    if (s > 0.5) this.tone(t, vary(110), vary(45), 0.35, vary(0.05) * s, 'sine', pan, 0.004);
  }

  swimStroke() {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.8;
    this.burst(t, vary(1400), 1, vary(0.28), vary(0.04), pan, 'bandpass', 0.05, vary(650));
  }

  ropeThrow() {
    if (!this.live()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.8;
    // whoosh: noise swept up through the band, then back down as the coil leaves the hand
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.5;
    f.frequency.setValueAtTime(vary(400), t);
    f.frequency.exponentialRampToValueAtTime(vary(1800), t + 0.2);
    f.frequency.exponentialRampToValueAtTime(vary(600), t + 0.42);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vary(0.07), t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.44);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(f).connect(g).connect(p).connect(this.master);
    s.start(t, Math.random() * 2);
    s.stop(t + 0.48);
    s.onended = () => {
      s.disconnect();
      f.disconnect();
      g.disconnect();
      p.disconnect();
    };
    // the rope's end slapping down on the deck
    this.burst(t + 0.6, vary(1200), 2, 0.05, vary(0.14), pan, 'bandpass', 0.002);
    this.tone(t + 0.6, vary(180), vary(90), 0.08, vary(0.06), 'triangle', pan, 0.002);
  }

  hullBump(intensity: number) {
    if (!this.live()) return;
    const i = clamp(intensity, 0, 1);
    if (i < 0.02) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.6;
    this.tone(t, vary(64), vary(42), 0.28, vary(0.16) * i, 'sine', 0, 0.004);
    this.burst(t, vary(380), 0.8, vary(0.14), vary(0.09) * i, pan, 'lowpass', 0.003);
    if (i > 0.6) {
      // timber giving way: resonant knock in the 300-500 Hz band, plus grit
      const c = 0.4 + (0.6 * (i - 0.6)) / 0.4;
      this.tone(t + 0.005, vary(440), vary(310), 0.12, vary(0.035) * c, 'triangle', pan, 0.002);
      this.burst(t + 0.005, vary(420), 6, vary(0.2), vary(0.12) * c, pan, 'bandpass', 0.003);
      this.burst(t + 0.02, vary(1400), 1.5, vary(0.06), vary(0.05) * c, pan, 'bandpass', 0.002);
    }
  }

  /** Rope running out through the hawse for ~1.5 s, then the deep splash. */
  anchorDrop() {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    const run = 1.5;
    for (let o = 0; o < run; o += 0.03 + Math.random() * 0.012)
      this.burst(t + o, vary(2400), 4, vary(0.012), vary(0.03), (Math.random() - 0.5) * 0.8, 'bandpass', 0.002);
    const s = t + run;
    this.burst(s, vary(2000), 0.9, vary(0.9), vary(0.12), 0, 'bandpass', 0.008, vary(260));
    this.tone(s, vary(95), vary(40), 0.6, vary(0.12), 'sine', 0, 0.005);
    this.burst(s + 0.15, vary(900), 1.2, vary(0.5), vary(0.05), (Math.random() - 0.5) * 0.6, 'bandpass', 0.01, vary(400));
  }

  /** Hauling on the windlass: a creak and pawl clack per pulse, with drips between. */
  anchorWeigh(seconds: number) {
    if (!this.live()) return;
    const t0 = this.ctx!.currentTime + 0.01;
    const dur = clamp(seconds, 0.3, 30);
    for (let o = 0; o < dur; o += vary(0.9)) {
      const pan = (Math.random() - 0.5) * 0.6;
      this.burst(t0 + o, vary(320), 14, vary(0.22), vary(0.05), pan, 'bandpass', 0.03, vary(260));
      this.burst(t0 + o, vary(1600), 3, 0.02, vary(0.02), pan, 'bandpass', 0.001);
    }
    for (let o = 0.2 + Math.random() * 0.3; o < dur; o += 0.25 + Math.random() * 0.7)
      this.tone(t0 + o, vary(1800), vary(900), 0.06, vary(0.02), 'sine', (Math.random() - 0.5), 0.002);
  }

  plank(down: boolean) {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.4;
    // wood dragged over wood
    this.burst(t, vary(1100), 2.5, vary(0.3), vary(0.05), pan, 'bandpass', 0.06, vary(650));
    const k = t + 0.3;
    if (down) {
      // solid knock as it seats on the quay
      this.tone(k, vary(170), vary(85), 0.09, vary(0.1), 'triangle', pan, 0.002);
      this.burst(k, vary(2400), 3, 0.025, vary(0.04), pan, 'bandpass', 0.001);
    } else {
      // lifted: a softer, lower thump as it comes off its seat
      this.tone(k, vary(90), vary(55), 0.12, vary(0.05), 'sine', pan, 0.004);
    }
  }

  buildPlace() {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.5;
    // wooden knock as the piece is set down
    this.tone(t, vary(210), vary(120), 0.07, vary(0.09), 'triangle', pan, 0.002);
    this.burst(t, vary(2600), 4, 0.015, vary(0.03), pan, 'bandpass', 0.001);
    // soft rope tie: a short rustle a beat later
    this.burst(t + 0.12, vary(2200), 1.5, vary(0.14), vary(0.02), pan, 'bandpass', 0.02, vary(1000));
  }

  buildRemove() {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    const pan = (Math.random() - 0.5) * 0.5;
    this.burst(t, vary(1300), 2.2, vary(0.35), vary(0.05), pan, 'bandpass', 0.06, vary(500));
    this.tone(t + 0.32, vary(110), vary(70), 0.06, vary(0.02), 'sine', pan, 0.003);
  }

  buildDeny() {
    if (!this.live()) return;
    const t = this.ctx!.currentTime + 0.01;
    // dull, muted double knock
    for (const d of [0, 0.14]) {
      this.tone(t + d, vary(130), vary(90), 0.06, vary(0.06), 'sine', 0, 0.003);
      this.burst(t + d, vary(500), 0.7, 0.04, vary(0.03), 0, 'lowpass', 0.002);
    }
  }

  // ---- continuous beds, fed every frame ----

  /** Call every frame with tension 0..1 (0 when not moored). A creak bed follows the load; quick changes add creak bursts. */
  lineCreak(tension: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = clamp(tension, 0, 1);
    const rate = Math.abs(k - this.lineK) / Math.max(t - this.lineCallT, 0.008);
    this.lineK = k;
    this.lineCallT = t;
    this.lineBed.gain.setTargetAtTime(k * 0.05, t, 0.12);
    if (!this.live() || rate < 0.9 || t < this.creakCD) return;
    this.creakCD = t + 0.25 + Math.random() * 0.35;
    const r = clamp(rate / 2.5, 0.3, 1);
    this.burst(t + 0.01, vary(300 + Math.random() * 350), 14, vary(0.18 + Math.random() * 0.15), vary(0.05) * r,
      (Math.random() - 0.5) * 1.2, 'bandpass', 0.006);
  }

  /** Call every frame with proximity 0..1 (0 far off, 1 on the quay). Drives the murmur and lapping; occasional hammering and barks. */
  setHarbourProximity(p: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = clamp(p, 0, 1);
    const dt = clamp(t - this.harbourCallT, 0, 0.25);
    this.harbourCallT = t;
    this.voiceGain.gain.setTargetAtTime(k * k * 0.05, t, 0.4);
    this.lapGain.gain.setTargetAtTime(k * 0.1, t, 0.5);
    this.voiceT -= dt;
    this.hammerT -= dt;
    this.dogT -= dt;
    if (this.voiceT <= 0) {
      // formants wander slowly so the murmur never settles on one vowel
      this.voiceT = 1.2 + Math.random() * 2.5;
      this.voiceF1.frequency.setTargetAtTime(vary(480 + Math.random() * 380), t, 0.7);
      this.voiceF2.frequency.setTargetAtTime(vary(1000 + Math.random() * 1100), t, 0.7);
    }
    if (!this.live()) return;
    if (this.hammerT <= 0) {
      this.hammerT = 3 + Math.random() * 7;
      if (k > 0.25 && Math.random() < 0.7) this.hammerVolley(t, k);
    }
    if (this.dogT <= 0) {
      this.dogT = 25 + Math.random() * 50;
      if (k > 0.5 && Math.random() < 0.35) this.bark(t, k);
    }
  }

  private hammerVolley(t: number, k: number) {
    const pan = (Math.random() - 0.5) * 1.2;
    const n = 3 + Math.floor(Math.random() * 4);
    let s = t + 0.02;
    for (let i = 0; i < n; i++) {
      // distant: quiet, with a faint ring on top
      this.burst(s, vary(1700), 5, 0.05, vary(0.03) * k, pan, 'bandpass', 0.002);
      this.tone(s, vary(1150), vary(980), 0.09, vary(0.006) * k, 'sine', pan, 0.002);
      s += 0.2 + Math.random() * 0.15;
    }
  }

  /** Two short dog barks: a band-passed sawtooth with a falling pitch. */
  private bark(t: number, k: number) {
    const ctx = this.ctx!;
    const pan = (Math.random() - 0.5) * 1.2;
    for (let i = 0; i < 2; i++) {
      const s = t + 0.02 + i * 0.26;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(vary(520), s);
      o.frequency.exponentialRampToValueAtTime(vary(300), s + 0.14);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = vary(900);
      f.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(vary(0.05) * k, s + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, s + 0.16);
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      o.connect(f).connect(g).connect(p).connect(this.master);
      o.start(s);
      o.stop(s + 0.2);
      o.onended = () => {
        o.disconnect();
        f.disconnect();
        g.disconnect();
        p.disconnect();
      };
    }
  }

  update(dt: number, g: Game) {
    this.lastGame = g;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // a bed whose caller has stopped feeding it fades out rather than droning on
    if (t - this.lineCallT > 0.5) this.lineBed.gain.setTargetAtTime(0, t, 0.2);
    if (t - this.harbourCallT > 0.5) {
      this.voiceGain.gain.setTargetAtTime(0, t, 0.3);
      this.lapGain.gain.setTargetAtTime(0, t, 0.3);
    }
    const ship = g.ship;
    const eagle = g.player.mode === 'eagle';
    const camH = g.camera.position.y;
    const nearSea = clamp(1 - (camH - 3) / 120, 0.05, 1);
    const sp = Math.abs(ship.speed);
    const aw = ship.apparentWind.length();
    const eagleSpeed = eagle ? g.player.eagleVel.length() : 0;
    // the sea's voice follows the local wave size: a sheltered harbour is quiet
    const seaRatio = clamp(g.waves.seaRatio(g.camera.position.x, g.camera.position.z), 0, 1);
    this.seaGain.gain.setTargetAtTime((0.35 + g.waves.hs * 0.3) * (0.3 + 0.7 * seaRatio) * nearSea, t, 0.6);
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
