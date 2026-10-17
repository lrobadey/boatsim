/** Main-view-only ablations: other scene passes keep their original geometry and shadows. */
import * as THREE from 'three';
import type { Game } from './game';

type Count = { calls: number; triangles: number };
type Sample = { variant: string; pair: number; baseline: boolean; gpuMs?: number; wallMs: number; counts: Record<string, Count> };
const summary = (values: number[]) => {
  const a = values.slice().sort((a,b)=>a-b);
  return { count: a.length, mean: a.length ? a.reduce((a,b)=>a+b,0)/a.length : null, median: a[Math.floor(a.length*.5)] ?? null, p95: a[Math.floor(a.length*.95)] ?? null };
};
export function installMainSceneProfile(game: Game) {
  const g = game as any, p = g.pipeline, r = p.renderer as THREE.WebGLRenderer;
  const gl = r.getContext() as WebGL2RenderingContext, ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const controls = document.createElement('div');
  controls.style.cssText = 'position:fixed;top:90px;left:12px;z-index:100001;background:#101820ed;color:#fff;padding:12px;font:12px monospace;max-height:60vh;overflow:auto';
  controls.innerHTML = '<button>Split main scene</button><output> Ready</output><pre></pre>';
  document.body.append(controls);
  const button = controls.querySelector('button')!, status = controls.querySelector('output')!, output = controls.querySelector('pre')!;
  const categories = new Map<THREE.Object3D, string>();
  const groups = new Map<string, THREE.Object3D[]>();
  const add = (name: string, roots: (THREE.Object3D | undefined)[]) => {
    const valid = roots.filter((x): x is THREE.Object3D => !!x);
    groups.set(name, valid); for (const root of valid) categories.set(root, name);
  };
  add('ocean surface', [g.ocean.group]); add('terrain', [g.terrain.group]);
  add('ship and crew', [g.model.group]); add('sky', [g.sky.group]);
  const harbor: THREE.Object3D[] = [], vegetation: THREE.Object3D[] = [], other: THREE.Object3D[] = [];
  for (const o of g.props.group.children as THREE.Object3D[]) {
    if(o.name === 'Ormos starting harbor') harbor.push(o);
    else if((o as THREE.InstancedMesh).isInstancedMesh && o.layers.mask === 4) vegetation.push(o);
    else other.push(o);
  }
  add('Ormos harbor', harbor); add('vegetation', vegetation); add('other world props', other);
  add('rigging and local effects', [g.harbourRig?.group, g.berthMarker?.group, g.oarWater.spray, g.birds.group]);
  const classify = (object: THREE.Object3D) => {
    for(let o: THREE.Object3D | null = object; o; o=o.parent) { const c=categories.get(o); if(c)return c; }
    return 'other scene objects';
  };
  const tick = () => new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  button.onclick = async () => {
    if(!ext) {status.textContent=' GPU timer unavailable';return;}
    button.disabled=true;
    const stageButton = document.getElementById('gpu-capture') as HTMLButtonElement | null;
    if(stageButton?.disabled){status.textContent=' Wait for stage capture';button.disabled=false;return;}
    if(stageButton)stageButton.disabled=true;
    const params = new URLSearchParams(location.search);
    const original = {render:r.render, direct:r.renderBufferDirect, begin:p.beginGpuTimer,end:p.endGpuTimer,
      adaptive:p.adaptive,cap:p.targetFps,scale:p.renderScale,paused:g.paused,env:g.sky.environmentProfiler.enabled};
    const pending: {query:WebGLQuery; sample:Sample}[] = [], samples:Sample[]=[];
    let disjoints=0, busy=false, current:Sample|null=null, number=0, warmup=60;
    const pairCount=Number(params.get('pairs')??24);
    const skyCloudUniform=g.sky.sky.material.uniforms.uCloudOn;
    const distances=[500,1000,2000];
    for(const distance of distances) {
      const distant=vegetation.filter(o=>{
        const mesh=o as THREE.InstancedMesh;
        if(!mesh.boundingSphere)mesh.computeBoundingSphere();
        const center=mesh.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
        return Math.hypot(center.x-g.camera.position.x,center.z-g.camera.position.z)>distance;
      });
      groups.set(`vegetation beyond ${distance}m`,distant);
    }
    const variantNames = params.has('skyCompare') ? ['sky cloud march disabled'] : params.has('focus') ? ['sky cloud march disabled','vegetation','vegetation beyond 500m','vegetation beyond 1000m','vegetation beyond 2000m'] : [...groups.keys(),'sky cloud march disabled'];
    const total = variantNames.length*pairCount*2;
    const pixel8=new Uint8Array(4),pixel16=new Uint16Array(4),pixel32=new Float32Array(4);
    const complete = () => {
      const target=r.getRenderTarget();
      if(target)r.readRenderTargetPixels(target,0,0,1,1,target.texture.type===THREE.HalfFloatType?pixel16:target.texture.type===THREE.FloatType?pixel32:pixel8);
      else gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel8);
    };
    const poll = () => {
      if(gl.getParameter(ext.GPU_DISJOINT_EXT)){disjoints++;for(const item of pending.splice(0))gl.deleteQuery(item.query);return;}
      while(pending.length && gl.getQueryParameter(pending[0].query,gl.QUERY_RESULT_AVAILABLE)){
        const item=pending.shift()!;item.sample.gpuMs=gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(item.query);
      }
    };
    try {
      p.adaptive=false;p.targetFps=Number(params.get('cap')??60);p.setRenderScale(Number(params.get('scale')??1.3));
      // Freeze the physical state. The fixed review camera and noon lighting come from ormosReview.
      g.paused=true;g.sky.environmentProfiler.enabled=false;p.resetGpuSamples();p.beginGpuTimer=()=>{};p.endGpuTimer=()=>{};
      r.renderBufferDirect = function(camera,scene,geometry,material,object,group){
        if(busy && current){
          const name=classify(object), count=current.counts[name]??={calls:0,triangles:0};count.calls++;
          if((object as THREE.Mesh).isMesh){
            const range=geometry.drawRange;
            const available=geometry.index?.count??geometry.attributes.position.count;
            const start=Math.max(range.start,group?.start??0), end=Math.min(available,range.start+range.count,group?group.start+group.count:Infinity);
            count.triangles+=Math.max(0,end-start)/3*((object as THREE.InstancedMesh).isInstancedMesh?(object as THREE.InstancedMesh).count:1);
          }
        }
        return original.direct.call(this,camera,scene,geometry,material,object,group);
      };
      r.render = function(scene,camera){
        if(scene!==g.scene || camera!==g.camera || camera.layers.mask!==5)return original.render.call(this,scene,camera);
        poll();
        if(warmup-->0){status.textContent=` Warming main scene ${Math.max(0,warmup)}`;return original.render.call(this,scene,camera);}
        if(number>=total)return original.render.call(this,scene,camera);
        const sequence=number++, pair=Math.floor(sequence/2), variant=variantNames[pair%variantNames.length];
        // Reverse A/B order every round to reduce systematic ordering bias.
        const baseline=(sequence%2===0)===(Math.floor(pair/variantNames.length)%2===0);
        const sample:Sample={variant,pair,baseline,wallMs:0,counts:{}};
        const hidden=baseline?[]:(groups.get(variant)??[]);
        const skyCloudOn=skyCloudUniform?.value;
        if(variant==='sky cloud march disabled' && skyCloudUniform && (!baseline || params.has('skyCompare')))skyCloudUniform.value=baseline?1:0;
        const vis=hidden.map(o=>o.visible);for(const o of hidden)o.visible=false;
        complete();
        const query=gl.createQuery()!;
        const start=performance.now();
        gl.beginQuery(ext.TIME_ELAPSED_EXT,query);busy=true;current=sample;
        try{return original.render.call(this,scene,camera);}
        finally{
          busy=false;current=null;gl.endQuery(ext.TIME_ELAPSED_EXT);complete();sample.wallMs=performance.now()-start;
          hidden.forEach((o,i)=>o.visible=vis[i]);if(skyCloudUniform)skyCloudUniform.value=skyCloudOn;samples.push(sample);pending.push({query,sample});
          if(number%32===0)status.textContent=` Main-view sample ${number}/${total}`;
        }
      };
      const deadline=performance.now()+180000;
      while(number<total){if(performance.now()>deadline)throw new Error('Capture timed out');await tick();}
      r.render=original.render;r.renderBufferDirect=original.direct;
      while(pending.length){if(performance.now()>deadline)throw new Error('GPU queries timed out');await tick();poll();}
      const rows=variantNames.map(variant=>{
        const selected=samples.filter(s=>s.variant===variant);
        const pairs=[...new Set(selected.map(s=>s.pair))].map(pair=>{
          const a=selected.find(s=>s.pair===pair&&s.baseline)!, b=selected.find(s=>s.pair===pair&&!s.baseline)!;
          return {gpuSavedMs:a.gpuMs!==undefined&&b.gpuMs!==undefined?a.gpuMs-b.gpuMs:NaN,wallSavedMs:a.wallMs-b.wallMs};
        });
        return {variant, baselineGpuMs:summary(selected.filter(s=>s.baseline).map(s=>s.gpuMs!).filter(Number.isFinite)),
          withoutGpuMs:summary(selected.filter(s=>!s.baseline).map(s=>s.gpuMs!).filter(Number.isFinite)),
          pairedGpuSavedMs:summary(pairs.map(p=>p.gpuSavedMs).filter(Number.isFinite)),pairedWallSavedMs:summary(pairs.map(p=>p.wallSavedMs)),pairs};
      }).sort((a,b)=>(b.pairedGpuSavedMs.mean??0)-(a.pairedGpuSavedMs.mean??0));
      const baseline=samples.filter(s=>s.baseline);
      const countNames=[...new Set(baseline.flatMap(s=>Object.keys(s.counts)))];
      const drawCounts=Object.fromEntries(countNames.map(name=>[name,{calls:summary(baseline.map(s=>s.counts[name]?.calls??0)),triangles:summary(baseline.map(s=>s.counts[name]?.triangles??0))}]));
      const info=gl.getExtension('WEBGL_debug_renderer_info');
      const report={kind:'main-scene-paired-ablation',at:new Date().toISOString(),quality:g.quality.name,scale:p.renderScale,
        canvas:[r.domElement.width,r.domElement.height],viewport:[innerWidth,innerHeight],gpu:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):'',
        paused:g.paused,ship:g.design?.kind,view:document.getElementById('ormos-review')?.dataset.view,hour:g.clock.hours,
        baselineGpuMs:summary(baseline.map(s=>s.gpuMs!).filter(Number.isFinite)),baselineWallMs:summary(baseline.map(s=>s.wallMs)),
        invalidTimerSamples:samples.filter(s=>s.gpuMs!==undefined&&s.gpuMs>s.wallMs+0.5).length,disjoints,pairCount,drawCounts,rows,samples,
        note:'Main-view-only hide-one-category ablations; reflection/refraction/shadows retain all objects. Savings overlap through occlusion and are not additive. Each main pass has current-target synchronous pixel readback before/after.'};
      output.textContent=JSON.stringify({...report,samples:undefined,rows:rows.map(({pairs,...row})=>row)},null,2);
      const response=await fetch('/__trieres_profile__',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
      status.textContent=response.ok?' Saved '+(await response.json()).file:' Saving failed';
    }catch(e){status.textContent=' '+String(e);console.error(e);}
    finally{
      r.render=original.render;r.renderBufferDirect=original.direct;p.beginGpuTimer=original.begin;p.endGpuTimer=original.end;
      p.adaptive=original.adaptive;p.targetFps=original.cap;p.setRenderScale(original.scale);g.paused=original.paused;g.sky.environmentProfiler.enabled=original.env;
      for(const item of pending)gl.deleteQuery(item.query);
      button.disabled=false;if(stageButton)stageButton.disabled=false;
    }
  };
}
