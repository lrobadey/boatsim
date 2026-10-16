/** Development-only exclusive GPU queries. Never imported by the game entry. */
import type { Game } from './game';
import { installMainSceneProfile } from './mainSceneProfile';
import { installSkyPerformanceCompare } from './skyPerformanceCompare';
import { installForegroundPerformanceReview } from './foregroundPerformanceReview';
const params = new URLSearchParams(location.search);
if (!params.has('dev')) throw new Error('GPU review requires ?dev');
void import('./main').then(() => {
  const wait = () => {
    const g = (window as unknown as { game?: Game }).game;
    if (!g?.running) { requestAnimationFrame(wait); return; }
    install(g);
    installMainSceneProfile(g);
    installSkyPerformanceCompare(g);
    if(params.has('foregroundReview')) installForegroundPerformanceReview(g);
  };
  wait();
});
function install(game: Game) {
  const g = game as any, p = g.pipeline, r = p.renderer;
  const gl = r.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:auto 8px 8px;z-index:99999;background:#101820ed;color:white;padding:12px;font:13px monospace;max-height:70vh;overflow:auto';
  box.innerHTML = '<button id="gpu-capture">Capture GPU stages</button> <output>Ready</output><pre id="gpu-result"></pre>';
  document.body.append(box);
  const status = box.querySelector('output')!, output = box.querySelector('pre')!;
  const button = box.querySelector('button')!;
  let active = false, id = 0, disjoints = 0, skipped = 0;
  let current: { q: WebGLQuery; stage: string; frame: number } | null = null;
  const pending: { q: WebGLQuery; stage: string; frame: number }[] = [];
  const samples: { frame: number; stage: string; ms: number }[] = [];
  const stack: string[] = [];
  const stageOrder = ['FFT waves','directional shadows','reflection scene','refraction scene','main scene','volumetric clouds','bloom and grade','SMAA','sky environment','cloud shadows','foam','oar water'];
  const wallSamples: {frame:number;stage:string;ms:number}[] = [];
  const serialized = params.has('sync');
  const pixel = new Uint8Array(4);
  function completeGpu() {
    const target = r.getRenderTarget();
    if (target && !target.depthBufferOnly) {
      const type = target.texture.type;
      const buffer = type === 1016 ? new Uint16Array(4) : type === 1015 ? new Float32Array(4) : pixel;
      r.readRenderTargetPixels(target, 0, 0, 1, 1, buffer);
    } else {
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    }
  }
  function stop() {
    if (!current || !ext) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(current); current = null;
  }
  function start(stage: string) {
    if (!active || !ext) return;
    if (pending.length >= 512) { skipped++; return; }
    const q = gl.createQuery(); if (!q) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q); current = { q, stage, frame: id };
  }
  function poll() {
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      disjoints++;
      for (const x of pending.splice(0)) gl.deleteQuery(x.q);
      return;
    }
    while (pending.length && gl.getQueryParameter(pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const x = pending.shift()!;
      samples.push({ frame: x.frame, stage: x.stage, ms: gl.getQueryParameter(x.q, gl.QUERY_RESULT) / 1e6 });
      gl.deleteQuery(x.q);
    }
  }
  const restores: (() => void)[] = [];
  function wrap(obj: any, key: string, label: string | ((...args: any[]) => string | null)) {
    if (!obj?.[key]) return;
    const original = obj[key], own = Object.hasOwn(obj, key);
    obj[key] = function(this: any, ...args: any[]) {
      const name = typeof label === 'function' ? label(...args) : label;
      if (!active || !name || stack.length || name !== stageOrder[(id - 1) % stageOrder.length]) return original.apply(this, args);
      if (serialized) completeGpu();
      const wallStart = performance.now();
      stop(); stack.push(name); start(name);
      try { return original.apply(this, args); }
      finally { stop(); if(serialized)completeGpu(); wallSamples.push({frame:id,stage:name,ms:performance.now()-wallStart}); stack.pop(); }
    };
    restores.push(() => { if (own) obj[key] = original; else delete obj[key]; });
  }
  const frames = (n: number) => new Promise<void>(resolve => {
    let left = n; const f = () => { if (--left <= 0) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
  const stats = (a: number[]) => {
    const sorted = a.slice().sort((a,b)=>a-b);
    return { mean: a.reduce((a,b)=>a+b,0)/a.length, median: sorted[Math.floor(a.length*.5)], p95: sorted[Math.floor(a.length*.95)] };
  };
  button.onclick = async () => {
    if (!ext) { status.textContent = 'GPU timer extension unavailable'; return; }
    button.disabled = true;
    const saved = { adaptive: p.adaptive, cap: p.targetFps, scale: p.renderScale, envProfile: g.sky.environmentProfiler.enabled };
    const begin = p.beginGpuTimer, end = p.endGpuTimer, originalFrame = g.frame;
    const scale = Number(params.get('scale') ?? 1.3), cap = Number(params.get('cap') ?? 15);
    const intervals: number[] = []; let last = 0;
    try {
      p.adaptive = false; p.targetFps = cap; p.setRenderScale(scale);
      p.resetGpuSamples(); g.sky.environmentProfiler.enabled = false;
      p.beginGpuTimer = () => {}; p.endGpuTimer = () => {};
      status.textContent = 'Warming 60 frames'; await frames(cap * 4);
      samples.length = 0; wallSamples.length = 0; id = 0; disjoints = 0; skipped = 0;
      wrap(g.sky, 'updateEnvironment', 'sky environment');
      wrap(g.sunBake, 'update', 'terrain sun bake');
      wrap(g.seaState, 'compose', 'sea state');
      wrap(g.fft, 'update', 'FFT waves');
      wrap(g.foam, 'update', 'foam'); wrap(g.oarWater, 'update', 'oar water');
      wrap(g.clouds, 'renderShadow', 'cloud shadows');
      wrap(r, 'render', (scene: any, camera: any) => scene !== g.scene ? null : camera === g.reflection.camera ? 'reflection scene' : camera.layers.mask === 2 ? 'refraction scene' : 'main scene');
      wrap(r.shadowMap, 'render', (lights: any[]) => lights.length ? 'directional shadows' : null);
      p.composer.passes.forEach((pass: any, i: number) => { if(i) wrap(pass, 'render', i === 1 ? 'volumetric clouds' : i === 2 ? 'bloom and grade' : 'SMAA'); });
      g.frame = function(this: any, ...args: any[]) {
        const now = performance.now(); if(last) intervals.push(now-last); last=now;
        id++; active = id <= 180;
        try { return originalFrame.apply(this,args); }
        finally { stop(); active=false; poll(); if(id%30===0)status.textContent=`GPU sample ${Math.min(id,180)}/180`; }
      };
      status.textContent = 'Measuring'; while (id < 180) await frames(15);
      active = false; g.frame = originalFrame;
      while(pending.length) { await frames(1); poll(); }
      const totals = new Map<number,number>();
      const stages = [...new Set(samples.map(s=>s.stage))];
      const rows = stages.map(stage => {
        const byFrame = new Map<number,number>();
        for(const s of samples.filter(s=>s.stage===stage)) byFrame.set(s.frame,(byFrame.get(s.frame)??0)+s.ms);
        return { stage, ...stats([...byFrame.values()]), wallMs: stats(wallSamples.filter(s=>s.stage===stage).map(s=>s.ms)), activeFrames: byFrame.size };
      }).sort((a,b)=>b.mean-a.mean);
      for(const s of samples) totals.set(s.frame,(totals.get(s.frame)??0)+s.ms);
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const report = { kind:'rotating-gpu-stages', serialized, at:new Date().toISOString(), quality:g.quality.name, scale, cap,
        gpu:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):'', viewport:[innerWidth,innerHeight], canvas:[r.domElement.width,r.domElement.height],
        mode:g.player.mode, paused:g.paused, intervalMs:stats(intervals.slice(0,179)), sumStageMeansMs:rows.filter(row=>row.stage!=='directional shadows').reduce((n,row)=>n+row.mean,0), note:'Reflection includes directional shadows; stages rotate across different frames. Readback wall timings include CPU and synchronization. GPU query credibility must be checked against wall timings.', disjoints, skipped, frames:totals.size, rows, samples };
      output.textContent=JSON.stringify({...report,samples:undefined},null,2);
      const response=await fetch('/__trieres_profile__',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
      status.textContent=response.ok?'Saved '+(await response.json()).file:'Save failed';
    } catch(e) { status.textContent=String(e); console.error(e); }
    finally {
      active=false; stop(); restores.splice(0).reverse().forEach(f=>f()); g.frame=originalFrame;
      p.beginGpuTimer=begin; p.endGpuTimer=end; p.adaptive=saved.adaptive; p.targetFps=saved.cap; p.setRenderScale(saved.scale); g.sky.environmentProfiler.enabled=saved.envProfile; button.disabled=false;
    }
  };
}
