import * as THREE from 'three';
import type { Game } from '../game';

/**
 * Dev-server frame audit. Press F9 in game (works in the launcher) to record pacing plus CPU and GPU
 * breakdowns while playing; the dev server saves the report to profiles/. Tools on window.trieresProfile:
 *  frame(n, sync)  nested timing of every stage of Game.frame. With sync (default) calls that touch
 *            the GPU are bracketed by gl.finish, so their GPU work is charged to them (this adds sync
 *            stalls; read shares, not absolute fps). sync=false times main-thread CPU only.
 *  scene(n)  ablation: hides one part of the scene at a time and measures how much a full
 *            pipeline.render gets cheaper (its draws in every pass: shadow, reflection, refraction, main).
 * Both print a table to the console and return the rows.
 */

type Row = { stage: string; inclMs: number; selfMs: number; perFrame: number };
type AnyObj = Record<string, any>;

export function installFrameProfiler(game: Game) {
  const g = game as unknown as AnyObj;
  const renderer = g.pipeline.renderer as THREE.WebGLRenderer;
  const gl = renderer.getContext();
  const frames = (n: number) => new Promise<void>((res) => {
    let k = 0;
    const f = () => (++k >= n ? res() : requestAnimationFrame(f));
    requestAnimationFrame(f);
  });

  /** sync=false times CPU only (GPU work overlaps); sync=true charges GPU work to each call */
  async function frame(n = 240, sync = true) {
    const stats = new Map<string, { incl: number; self: number; calls: number }>();
    const stack: { path: string; child: number }[] = [];
    const undo: (() => void)[] = [];
    const wrap = (obj: AnyObj | undefined | null, key: string, label: string | ((...a: any[]) => string), gpu: boolean) => {
      if (!obj || typeof obj[key] !== 'function') return;
      const orig = obj[key];
      const own = Object.prototype.hasOwnProperty.call(obj, key);
      obj[key] = function (this: unknown, ...a: unknown[]) {
        const name = typeof label === 'function' ? label(...a) : label;
        const path = (stack.length ? stack[stack.length - 1].path + ' > ' : '') + name;
        if (gpu && sync) gl.finish();
        const t0 = performance.now();
        const fr = { path, child: 0 };
        stack.push(fr);
        try {
          return orig.apply(this, a);
        } finally {
          if (gpu && sync) gl.finish();
          const dt = performance.now() - t0;
          stack.pop();
          if (stack.length) stack[stack.length - 1].child += dt;
          const s = stats.get(path) ?? { incl: 0, self: 0, calls: 0 };
          s.incl += dt; s.self += dt - fr.child; s.calls++;
          stats.set(path, s);
        }
      };
      undo.push(() => { if (own) obj[key] = orig; else delete obj[key]; });
    };

    wrap(g, 'frame', 'FRAME', true);
    for (const k of ['handleInput', 'updateMooring', 'advanceCloudWeather', 'updateCloudInputs']) wrap(g, k, k, false);
    const cpu: [AnyObj | undefined, string, string][] = [
      [g.pipeline, 'adapt', 'pipeline.adapt'], [g.clock, 'update', 'clock.update'],
      [g.wind, 'update', 'wind.update'], [g.waves, 'update', 'waves.update'], [g.waves, 'retarget', 'waves.retarget'],
      [g.fft, 'retarget', 'fft.retarget'], [g.seaState, 'tick', 'seaState.tick'],
      [g.ship, 'step', 'ship.step'], [g.ship, 'pose', 'ship.pose'],
      [g.player, 'update', 'player.update'], [g.crewSolids, 'update', 'crewSolids.update'], [g.trade, 'update', 'trade.update'],
      [g.sky, 'updateLighting', 'sky.updateLighting'], [g.model, 'update', 'model.update'],
      [g.crewAnimator, 'update', 'crewAnimator.update'], [g.ocean, 'update', 'ocean.update'],
      [g.ocean, 'setRefraction', 'ocean.setRefraction'], [g.props, 'update', 'props.update'], [g.birds, 'update', 'birds.update'],
      [g.audio, 'update', 'audio.update'], [g.audio, 'rowingEvents', 'audio.rowingEvents'], [g.hud, 'update', 'hud.update'],
      [g.chart, 'update', 'chart.update'], [g.minimap, 'update', 'minimap.update'], [g.input, 'endFrame', 'input.endFrame'],
    ];
    for (const [o, k, l] of cpu) wrap(o, k, l, false);
    const gpu: [AnyObj | undefined, string, string][] = [
      [g.seaState, 'compose', 'seaState.compose'], [g.sky, 'updateEnvironment', 'sky.updateEnvironment'],
      [g.sunBake, 'update', 'sunBake.update'], [g.fft, 'update', 'fft.update'], [g.foam, 'update', 'foam.update'],
      [g.oarWater, 'update', 'oarWater.update'], [g.clouds, 'renderShadow', 'clouds.renderShadow'],
      [g.pipeline, 'render', 'pipeline.render'], [g.reflection, 'render', 'reflection.render'],
      [renderer.shadowMap as unknown as AnyObj, 'render', 'sun shadow map'],
    ];
    for (const [o, k, l] of gpu) wrap(o, k, l, true);
    wrap(renderer as unknown as AnyObj, 'render', (_s: THREE.Scene, c: THREE.Camera) => {
      if ((c as THREE.OrthographicCamera).isOrthographicCamera) return 'fullscreen draw';
      const t = renderer.getRenderTarget();
      return `scene draw, layers ${c.layers.mask}, ${t ? `${t.width}x${t.height}` : 'canvas'}`;
    }, true);
    (g.pipeline.composer.passes as AnyObj[]).forEach((ps, i) => wrap(ps, 'render', `composer ${i}: ${ps.name || ps.constructor.name}`, true));

    const interval: number[] = [];
    let last = 0, k = 0;
    try {
      await new Promise<void>((res) => {
        const f = (t: number) => {
          if (last) interval.push(t - last);
          last = t;
          if (++k > n) res(); else requestAnimationFrame(f);
        };
        requestAnimationFrame(f);
      });
    } finally {
      undo.reverse().forEach((u) => u());
    }
    const count = stats.get('FRAME')?.calls || 1;
    const rows: Row[] = [...stats].map(([stage, s]) => ({
      stage, inclMs: +(s.incl / count).toFixed(3), selfMs: +(s.self / count).toFixed(3), perFrame: +(s.calls / count).toFixed(2),
    })).sort((a, b) => a.stage.localeCompare(b.stage));
    interval.sort((a, b) => a - b);
    const summary = {
      frames: count, sync,
      intervalMedianMs: +interval[interval.length >> 1].toFixed(2),
      intervalP95Ms: +interval[Math.floor(interval.length * 0.95)].toFixed(2),
      mode: g.player.mode, cinematic: g.cinematic, renderScale: g.pipeline.renderScale,
      canvas: [renderer.domElement.width, renderer.domElement.height],
    };
    console.log('[profile] frame', summary);
    console.table(rows);
    return { summary, rows };
  }

  /** scene parts: every scene child, with props split into the harbour, vegetation and the rest */
  function parts() {
    const out: { name: string; objects: THREE.Object3D[] }[] = [];
    const scene = g.scene as THREE.Scene;
    const props = g.props.group as THREE.Group;
    const known = new Map<THREE.Object3D, string>([
      [g.sky.group, 'sky'], [g.terrain.group, 'terrain'], [g.ocean.group, 'ocean'], [g.props.group, 'props'],
      [g.birds.group, 'birds'], [g.model.group, 'ship model'], [g.oarWater.spray, 'oar spray'],
    ]);
    if (g.harbourRig) known.set(g.harbourRig.group, 'harbour rig');
    if (g.berthMarker) known.set(g.berthMarker.group, 'berth marker');
    for (const o of scene.children) {
      if (o === props || (o as THREE.Light).isLight) continue;
      out.push({ name: known.get(o) ?? (o.name || o.type), objects: [o] });
    }
    const harbour: THREE.Object3D[] = [], vegetation: THREE.Object3D[] = [], rest: THREE.Object3D[] = [];
    for (const o of props.children) {
      if (o.name === 'Ormos starting harbor') harbour.push(o);
      else if ((o as THREE.InstancedMesh).isInstancedMesh && o.layers.mask === 4) vegetation.push(o);
      else rest.push(o);
    }
    out.push({ name: 'props: Ormos harbour', objects: harbour }, { name: 'props: vegetation', objects: vegetation }, { name: 'props: other', objects: rest });
    return out;
  }

  async function scene(n = 120) {
    const p = g.pipeline;
    const saved = { paused: g.paused, adaptive: p.adaptive };
    g.paused = true;
    p.adaptive = false;
    const orig = p.render;
    const times: number[] = [];
    p.render = function (this: unknown, ...a: unknown[]) {
      gl.finish();
      const t0 = performance.now();
      const r = orig.apply(this, a);
      gl.finish();
      times.push(performance.now() - t0);
      return r;
    };
    const median = async () => {
      await frames(20);
      times.length = 0;
      await frames(n);
      const t = [...times].sort((a, b) => a - b);
      return t[t.length >> 1];
    };
    const rows: { part: string; savedMs: number; renderMs: number }[] = [];
    try {
      const base = await median();
      for (const part of parts()) {
        const vis = part.objects.map((o) => o.visible);
        part.objects.forEach((o) => (o.visible = false));
        const without = await median();
        part.objects.forEach((o, i) => (o.visible = vis[i]));
        rows.push({ part: part.name, savedMs: +(base - without).toFixed(2), renderMs: +without.toFixed(2) });
      }
      rows.sort((a, b) => b.savedMs - a.savedMs);
      rows.unshift({ part: '(everything)', savedMs: 0, renderMs: +base.toFixed(2) });
    } finally {
      p.render = orig;
      g.paused = saved.paused;
      p.adaptive = saved.adaptive;
    }
    console.log('[profile] scene ablation: pipeline.render median, and the time saved with each part hidden');
    console.table(rows);
    return rows;
  }

  /** real frame pacing with nothing else wrapped: rAF interval and Game.frame CPU per frame */
  async function pacing(ms = 8000) {
    const rec: { t: number; cpu: number; steps: number }[] = [];
    let steps = 0;
    const of = g.frame, os = g.ship.step;
    g.ship.step = function (this: unknown, ...a: unknown[]) { steps++; return os.apply(this, a); };
    g.frame = function (this: unknown, ...a: unknown[]) {
      steps = 0;
      const t = performance.now();
      const x = of.apply(this, a);
      rec.push({ t, cpu: performance.now() - t, steps });
      return x;
    };
    try { await new Promise((r) => setTimeout(r, ms)); }
    finally { delete g.frame; delete g.ship.step; }
    const gaps = rec.slice(1).map((f, i) => f.t - rec[i].t).sort((a, b) => a - b);
    const cpu = rec.map((f) => f.cpu).sort((a, b) => a - b);
    const q = (a: number[], p: number) => +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(2);
    const hist: Record<string, number> = {};
    for (const x of gaps) {
      const b = x < 18 ? '<18' : x < 25 ? '18-25' : x < 34 ? '25-34' : x < 50 ? '34-50' : '50+';
      hist[b] = (hist[b] ?? 0) + 1;
    }
    return {
      frames: rec.length, fps: +(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1),
      intervalMs: { median: q(gaps, 0.5), p90: q(gaps, 0.9), p99: q(gaps, 0.99), max: q(gaps, 1) }, intervalHist: hist,
      frameCpuMs: { median: q(cpu, 0.5), p90: q(cpu, 0.9), p99: q(cpu, 0.99), max: q(cpu, 1) },
      stepsPerFrame: rec.reduce((h: Record<number, number>, f) => ((h[f.steps] = (h[f.steps] ?? 0) + 1), h), {}),
    };
  }

  /** F9 in a dev-server build (the launcher): pacing, CPU and GPU breakdowns, saved by the dev server */
  let capturing = false;
  async function capture() {
    if (capturing) return;
    capturing = true;
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99999;padding:8px 12px;background:#000c;color:#fff;font:13px system-ui;border-radius:6px;pointer-events:none';
    const say = (s: string) => (note.textContent = s);
    document.body.appendChild(note);
    try {
      const info = renderer.getContext().getExtension('WEBGL_debug_renderer_info');
      const env = {
        time: new Date().toISOString(), userAgent: navigator.userAgent,
        gpu: info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '',
        quality: g.quality?.name, renderScale: g.pipeline.renderScale, adaptive: g.pipeline.adaptive, targetFps: g.pipeline.targetFps,
        css: [innerWidth, innerHeight], devicePixelRatio, canvas: [renderer.domElement.width, renderer.domElement.height],
        gpuTimer: !!g.pipeline.timerExt, gpuMs: g.pipeline.gpuMs, mode: g.player.mode, paused: g.paused, cinematic: g.cinematic,
        drawCalls: renderer.info.render.calls, programs: renderer.info.programs?.length,
      };
      say('Recording performance: keep playing (1/3)');
      const pace = await pacing(8000);
      say('Recording performance: keep playing (2/3)');
      const cpu = await frame(240, false);
      say('Recording performance: keep playing (3/3)');
      const synced = await frame(120, true);
      const report = { env, pacing: pace, cpu, synced };
      console.log('[profile] capture', report);
      const res = await fetch('/__trieres_profile__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
      say(res.ok ? `Saved ${(await res.json()).file}` : 'Recorded, but the dev server did not save it (see console)');
    } catch (e) {
      say('Performance capture failed: ' + (e as Error).message);
      console.error(e);
    } finally {
      capturing = false;
      setTimeout(() => note.remove(), 6000);
    }
  }
  /** Shift+F9: change one thing at a time and record real fps, to tell GPU, draw-call and pacing limits apart */
  async function experiments(ms = 3000) {
    if (capturing) return;
    capturing = true;
    const p = g.pipeline;
    const note = document.createElement('div');
    note.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99999;padding:8px 12px;background:#000c;color:#fff;font:13px system-ui;border-radius:6px;pointer-events:none';
    document.body.appendChild(note);
    const saved = { adaptive: p.adaptive, scale: p.renderScale, minScale: p.quality.minScale, targetFps: p.targetFps, reflection: g.reflection.enabled };
    const post = p.composer.passes[2];
    const terrain = g.terrain.group as THREE.Object3D;
    const props = g.props.group as THREE.Object3D;
    const scale = (s: number) => { p.quality.minScale = Math.min(saved.minScale, s); p.setRenderScale(s); };
    const savedRefraction = p.quality.refractionScale;
    const refraction = (s: number) => { p.quality.refractionScale = s; p.setSize(p.width, p.height); };
    const terrainMeshes: THREE.Object3D[] = [];
    terrain.traverse((o) => { if ((o as THREE.Mesh).isMesh) terrainMeshes.push(o); });
    const terrainMasks = terrainMeshes.map((o) => o.layers.mask);
    // main view draws layers 0 and 2, reflection layer 0 only, refraction layer 1 only
    const terrainLayers = (mask: number) => terrainMeshes.forEach((o) => (o.layers.mask = mask));
    const variants: [string, () => void][] = [
      ['terrain hidden', () => { terrain.visible = false; }],
      ['terrain main view only', () => terrainLayers(1 << 2)],
      ['terrain not in refraction', () => terrainLayers(1 << 0)],
      ['terrain not in reflection', () => terrainLayers((1 << 2) | (1 << 1))],
      ['refraction scale 0.6', () => refraction(0.6)],
      ['no sea reflection', () => { g.reflection.enabled = false; }],
      ['no grade/bloom pass', () => { post.enabled = false; }],
      ['props hidden', () => { props.visible = false; }],
      ['render scale 1.0', () => scale(1.0)],
      ['render scale 0.7', () => scale(0.7)],
    ];
    const restore = () => {
      p.quality.minScale = saved.minScale; p.setRenderScale(saved.scale); p.targetFps = saved.targetFps;
      g.reflection.enabled = saved.reflection; terrain.visible = true; props.visible = true; post.enabled = true;
      if (p.quality.refractionScale !== savedRefraction) refraction(savedRefraction);
      terrainMeshes.forEach((o, i) => (o.layers.mask = terrainMasks[i]));
    };
    const rows: AnyObj[] = [];
    // the same view for every run: the camera holds where it is (the simulation keeps running)
    const cam = g.camera as THREE.PerspectiveCamera;
    const savedReview = g.reviewCamera;
    g.reviewCamera = { position: cam.position.clone(), target: cam.position.clone().add(cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(100)) };
    const run = async () => {
      await new Promise((r) => setTimeout(r, 800));
      const r = await pacing(ms);
      return { fps: r.fps, median: r.intervalMs.median, slow: (r.intervalHist['34-50'] ?? 0) + (r.intervalHist['50+'] ?? 0), frames: r.frames, cpu: r.frameCpuMs.median };
    };
    try {
      p.adaptive = false;
      for (const [i, [name, apply]] of variants.entries()) {
        note.textContent = `Performance experiments, camera held: ${i + 1}/${variants.length}`;
        restore();
        const base = await run();
        apply();
        const v = await run();
        rows.push({ variant: name, baseFps: base.fps, fps: v.fps, gain: +(v.fps - base.fps).toFixed(1), baseSlow: `${base.slow}/${base.frames}`, slow: `${v.slow}/${v.frames}`, baseCpu: base.cpu, cpu: v.cpu, canvas: [renderer.domElement.width, renderer.domElement.height] });
      }
    } finally {
      restore();
      p.adaptive = saved.adaptive;
      g.reviewCamera = savedReview;
      capturing = false;
    }
    console.table(rows);
    try {
      const res = await fetch('/__trieres_profile__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'experiments-paired', userAgent: navigator.userAgent, css: [innerWidth, innerHeight], rows }) });
      note.textContent = res.ok ? `Saved ${(await res.json()).file}` : 'Recorded, but the dev server did not save it (see console)';
    } catch (e) {
      note.textContent = 'Experiments recorded, saving failed: ' + (e as Error).message;
    }
    setTimeout(() => note.remove(), 6000);
    return rows;
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F9') return;
    e.preventDefault();
    void (e.shiftKey ? experiments() : capture());
  });

  (window as unknown as AnyObj).trieresProfile = { frame, scene, pacing, capture, experiments };
}
