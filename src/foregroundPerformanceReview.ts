/** Dev-only replay of the archived, rejected foreground candidate versus production. */
import * as THREE from 'three';
import type { Game } from './game';
import candidateFragment from '../docs/gpu-breakdown/foreground-investigation/candidate-fragment.glsl?raw';
const stats=(a:number[])=>{const s=a.slice().sort((a,b)=>a-b);return {count:a.length,mean:a.reduce((x,y)=>x+y,0)/a.length,median:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)]};};
export function installForegroundPerformanceReview(game:Game){
 const g=game as any,p=g.pipeline,r=p.renderer as THREE.WebGLRenderer,pass=p.cloudPass;
 const gl=r.getContext() as WebGL2RenderingContext,ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
 const production=pass.material as THREE.ShaderMaterial;
 const current=production.clone();current.uniforms=production.uniforms;current.fragmentShader=candidateFragment;
 const branch=/if \(foregroundBeforeClouds\(distanceKm, uCloudOrigin.y\)\)\s*\{[\s\S]*?return;\s*\}/;
 if(!branch.test(current.fragmentShader))throw Error('Foreground shader branch not found');
 const old=production.clone();old.uniforms=production.uniforms;
 const uniformCone=new URLSearchParams(location.search).has('uniformCone');
 const explicitLod=new URLSearchParams(location.search).has('explicitLod');
 const weatherLodOnly=new URLSearchParams(location.search).has('weatherLodOnly');
 const repairCone=(source:string)=>{
  const declaration='vec4 vcMarch(vec3 rd, float steps, float jitter, float maxDistance, out float representativeDistance) {';
  if(!source.includes(declaration))throw Error('Cloud march anchor missing');
  source=source.replace(declaration,'vec4 vcMarchWithCone(vec3 rd, float steps, float jitter, float maxDistance, float rayCone, out float representativeDistance) {');
  source=source.replace('float rayCone = max(length(dFdx(rd)), length(dFdy(rd)));','');
  const overload='vec4 vcMarch(vec3 rd, float steps, float jitter) {';
  source=source.replace(overload,`vec4 vcMarch(vec3 rd, float steps, float jitter, float maxDistance, out float representativeDistance) {
    float rayCone = max(length(dFdx(rd)), length(dFdy(rd)));
    return vcMarchWithCone(rd, steps, jitter, maxDistance, rayCone, representativeDistance);
  }
  `+overload);
  source=source.replace('void main() {',`void main() {
    vec4 fallbackPoint = uInvViewProj * vec4(vUv * 2.0 - 1.0, 0.5, 1.0);
    vec3 fallbackRay = normalize(fallbackPoint.xyz / fallbackPoint.w);
    float fallbackRayCone = max(length(dFdx(fallbackRay)),length(dFdy(fallbackRay)));
  `);
  source=source.replace('vec4 exactCloud = vcMarch(ray, 24.0, 0.5,','vec4 exactCloud = vcMarchWithCone(fallbackRay, 24.0, 0.5,');
  source=source.replace('distanceKm > 0.0 ? distanceKm * 1000.0 : 1.0e30, cloudDistance);','distanceKm > 0.0 ? distanceKm * 1000.0 : 1.0e30, fallbackRayCone, cloudDistance);');
  return source;
 };
 if(uniformCone){current.fragmentShader=repairCone(current.fragmentShader);old.fragmentShader=repairCone(old.fragmentShader);}
 if(explicitLod){
  const patch=(source:string)=>{
   source=source.replaceAll('texture(uCloudCover, q.xz / 42000.0)','textureLod(uCloudCover, q.xz / 42000.0, 0.0)');
   return weatherLodOnly?source:source.replaceAll('texture(uCloudDetail, q / 1500.0)','textureLod(uCloudDetail, q / 1500.0, 0.0)');
  };
  current.fragmentShader=patch(current.fragmentShader);old.fragmentShader=patch(old.fragmentShader);
 }


 const mask=current.clone();mask.uniforms=current.uniforms;
 mask.fragmentShader=current.fragmentShader.slice(0,current.fragmentShader.lastIndexOf('void main()'))+`void main(){float d=sceneDistance(vUv);fragColor=vec4(foregroundBeforeClouds(d,uCloudOrigin.y)?1.0:0.0,0.0,0.0,1.0);}`;
 const rtDiagnostic=production.clone();rtDiagnostic.uniforms=production.uniforms;
 rtDiagnostic.fragmentShader=old.fragmentShader.replace('scene.rgb = scene.rgb * transmittance + radiance;', 'scene = vec4(radiance * 1024.0, (1.0 - transmittance) * 1024.0);');
 const depthDiagnostic=production.clone();depthDiagnostic.uniforms=production.uniforms;
 depthDiagnostic.fragmentShader=current.fragmentShader.replace(branch,'').replace('float total = 0.0;', 'float total = 0.0; float usedFallback = 0.0;').replace('vec4 exactCloud =', 'usedFallback = 1.0; vec4 exactCloud =').replace('scene.rgb = scene.rgb * transmittance + radiance;', 'scene = vec4(distanceKm, uCloudOrigin.y, foregroundBeforeClouds(distanceKm,uCloudOrigin.y)?1.0:0.0, usedFallback);');

 const panel=document.createElement('div');panel.style.cssText='position:fixed;inset:90px 12px auto 12px;z-index:200000;background:#101820ed;color:white;padding:12px;font:12px monospace;max-height:65vh;overflow:auto';
 panel.innerHTML='<button>Measure foreground fix</button><output> Ready</output><pre></pre>';document.body.append(panel);
 const button=panel.querySelector('button')!,status=panel.querySelector('output')!,output=panel.querySelector('pre')!;
 const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
 const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
 button.onclick=async()=>{
 if(!ext){status.textContent=' GPU timers unavailable';return;}
 button.disabled=true;
 const original={render:r.render,frame:g.frame,begin:p.beginGpuTimer,end:p.endGpuTimer,adaptive:p.adaptive,cap:p.targetFps,scale:p.renderScale,paused:g.paused,weather:g.advanceCloudWeather,profile:g.sky.environmentProfiler.enabled};
 const results:any={kind:'foreground-fix-ab',uniformCone,explicitLod,weatherLodOnly,at:new Date().toISOString(),viewport:[innerWidth,innerHeight],quality:g.quality.name,view:document.getElementById('ormos-review')?.dataset.view,gpu:null,images:[],gpuRuns:[],pacing:[]};
 const info=gl.getExtension('WEBGL_debug_renderer_info');results.gpu=info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null;
 const pixel16=new Uint16Array(4);
 const complete=()=>{const target=r.getRenderTarget();if(!target)throw Error('Expected HDR output');r.readRenderTargetPixels(target,0,0,1,1,pixel16);};
 let recording=false,frames:{t:number;cpuMs:number}[]=[];
 const pending:{q:WebGLQuery;sample:any}[]=[];
 let disjoints=0;
 const poll=()=>{if(gl.getParameter(ext.GPU_DISJOINT_EXT)){disjoints++;for(const x of pending.splice(0))gl.deleteQuery(x.q);return;}while(pending.length&&gl.getQueryParameter(pending[0].q,gl.QUERY_RESULT_AVAILABLE)){const x=pending.shift()!;x.sample.gpuMs=gl.getQueryParameter(x.q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(x.q);}};
 try{
 p.adaptive=false;p.targetFps=60;p.resetGpuSamples();p.beginGpuTimer=()=>{};p.endGpuTimer=()=>{};g.sky.environmentProfiler.enabled=false;
 // Both variants share live uniforms; only the new branch is absent in the control.
 for(const material of [old,current,mask,rtDiagnostic,depthDiagnostic]){pass.fullscreenMaterial=material;await r.compileAsync(pass.scene,pass.camera);}
 p.setRenderScale(2);pass.fullscreenMaterial=old;status.textContent=' Warming old shader';await sleep(5000);pass.fullscreenMaterial=current;status.textContent=' Warming current shader';await sleep(5000);
 g.paused=true;g.advanceCloudWeather=function(){return original.weather.call(this,0);};
 for(const scale of new URLSearchParams(location.search).has('imageOnly')?[1.3]:[1.3,2]){
 p.setRenderScale(scale);status.textContent=` Settling image, scale ${scale}`;await sleep(1000);
 // Re-render the exact same composite input into the same output, then restore new output.
 let imageDone=false;
 r.render=function(scene,camera){
 if(scene!==pass.scene||imageDone)return original.render.call(this,scene,camera);
 const target=r.getRenderTarget()!;const a=new Uint16Array(target.width*target.height*4),b=new Uint16Array(a.length),c=new Uint16Array(a.length),m=new Uint16Array(a.length),rt=new Uint16Array(a.length),depth=new Uint16Array(a.length);
 pass.fullscreenMaterial=old;original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,a);
 pass.fullscreenMaterial=current;const value=original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,b);
 pass.fullscreenMaterial=current;original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,c);
 pass.fullscreenMaterial=mask;original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,m);
 pass.fullscreenMaterial=rtDiagnostic;original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,rt);
 pass.fullscreenMaterial=depthDiagnostic;original.render.call(this,scene,camera);r.readRenderTargetPixels(target,0,0,target.width,target.height,depth);
 pass.fullscreenMaterial=current;original.render.call(this,scene,camera);
 let differentPixels=0,maxAbs=0,differentAlpha=0,eligiblePixels=0,outsideEligible=0,selfDifferences=0,maxHalfSteps=0,maxRelative=0,maxDisplayByte=0,displayPixelsOverOne=0,displayPixelsOverTwo=0,eligibleNonIdentity=0,eligibleFallback=0;const worst:any[]=[];
 for(let i=0;i<a.length;i+=4){let differs=false,displayDelta=0;const eligible=m[i]!==0;if(eligible){eligiblePixels++;if(rt[i]!==0||rt[i+1]!==0||rt[i+2]!==0||rt[i+3]!==0)eligibleNonIdentity++;if(depth[i+3]!==0)eligibleFallback++;}if(b[i]!==c[i]||b[i+1]!==c[i+1]||b[i+2]!==c[i+2])selfDifferences++;for(let j=0;j<4;j++){if(a[i+j]!==b[i+j]){differs=true;const av=THREE.DataUtils.fromHalfFloat(a[i+j]),bv=THREE.DataUtils.fromHalfFloat(b[i+j]);maxHalfSteps=Math.max(maxHalfSteps,Math.abs(a[i+j]-b[i+j]));maxRelative=Math.max(maxRelative,Math.abs(av-bv)/Math.max(.01,Math.abs(av),Math.abs(bv)));const display=(v:number)=>Math.round(255*Math.pow(Math.max(0,v)/(1+Math.max(0,v)),1/2.2));displayDelta=Math.max(displayDelta,Math.abs(display(av)-display(bv)));maxAbs=Math.max(maxAbs,Math.abs(THREE.DataUtils.fromHalfFloat(a[i+j])-THREE.DataUtils.fromHalfFloat(b[i+j])));if(j===3)differentAlpha++;}}maxDisplayByte=Math.max(maxDisplayByte,displayDelta);if(displayDelta>1)displayPixelsOverOne++;if(displayDelta>2)displayPixelsOverTwo++;if(differs){differentPixels++;if(!eligible)outsideEligible++;const magnitude=Math.max(...[0,1,2].map(j=>Math.abs(THREE.DataUtils.fromHalfFloat(a[i+j])-THREE.DataUtils.fromHalfFloat(b[i+j]))));if(worst.length<12||magnitude>worst.at(-1).magnitude){worst.push({pixel:[(i/4)%target.width,Math.floor(i/4/target.width)],magnitude,eligible,old:[...a.subarray(i,i+4)].map(THREE.DataUtils.fromHalfFloat),candidate:[...b.subarray(i,i+4)].map(THREE.DataUtils.fromHalfFloat),radianceAndOneMinusTransmittance:[...rt.subarray(i,i+4)].map(x=>THREE.DataUtils.fromHalfFloat(x)/1024),distanceKm:THREE.DataUtils.fromHalfFloat(depth[i]),cameraHeight:THREE.DataUtils.fromHalfFloat(depth[i+1]),fallback:depth[i+3]!==0});worst.sort((a,b)=>b.magnitude-a.magnitude);worst.splice(12);}}}
 const thumbnail=(data:Uint16Array)=>{
 const width=256,height=Math.round(target.height*width/target.width),rgb=[];
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const k=(Math.floor(y*target.height/height)*target.width+Math.floor(x*target.width/width))*4;for(let j=0;j<3;j++){const v=Math.max(0,THREE.DataUtils.fromHalfFloat(data[k+j]));rgb.push(Math.round(255*Math.pow(v/(1+v),1/2.2)));}}
 return {width,height,rgb};};
 results.images.push({scale,canvas:[target.width,target.height],pixels:a.length/4,differentPixels,maxAbs,differentAlpha,eligiblePixels,eligibleNonIdentity,eligibleFallback,worst,outsideEligible,selfDifferences,maxHalfSteps,maxRelative,maxDisplayByte,displayPixelsOverOne,displayPixelsOverTwo,oldThumbnail:thumbnail(a),newThumbnail:thumbnail(b)});imageDone=true;return value;
 };
 while(!imageDone)await tick();r.render=original.render;if(new URLSearchParams(location.search).has('imageOnly'))continue;
 const samples:any[]=[];let count=0;
 r.render=function(scene,camera){
 if(scene!==pass.scene||count>=320)return original.render.call(this,scene,camera);
 const index=count++,pair=Math.floor(index/2),isOld=(index%2===0)===(pair%2===0);
 pass.fullscreenMaterial=isOld?old:current;original.render.call(this,scene,camera);complete();const q=gl.createQuery()!,t=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);
 try{return original.render.call(this,scene,camera);}finally{gl.endQuery(ext.TIME_ELAPSED_EXT);complete();const sample={pair,old:isOld,wallMs:performance.now()-t};samples.push(sample);pending.push({q,sample});poll();if(count%64===0)status.textContent=` GPU composite ${scale}: ${count}/320`;}
 };
 const deadline=performance.now()+60000;while(count<320){if(performance.now()>deadline)throw Error('GPU run timeout');await tick();}r.render=original.render;
 while(pending.length){if(performance.now()>deadline)throw Error('GPU drain timeout');await tick();poll();}
 const before=samples.filter(s=>s.old),after=samples.filter(s=>!s.old),deltas=[];
 for(let pair=0;pair<160;pair++){const a=before.find(s=>s.pair===pair),b=after.find(s=>s.pair===pair);if(a.gpuMs!==undefined&&b.gpuMs!==undefined)deltas.push(a.gpuMs-b.gpuMs);}
 results.gpuRuns.push({scale,canvas:[r.domElement.width,r.domElement.height],old:stats(before.map(s=>s.gpuMs).filter(Number.isFinite)),fixed:stats(after.map(s=>s.gpuMs).filter(Number.isFinite)),pairedSavings:stats(deltas),invalid:samples.filter(s=>s.gpuMs>s.wallMs+.5).length,disjoints,samples});
 }
 pass.fullscreenMaterial=current;g.paused=original.paused;g.advanceCloudWeather=original.weather;p.setRenderScale(2);
 g.frame=function(this:any,...args:any[]){const t=performance.now();try{return original.frame.apply(this,args);}finally{if(recording)frames.push({t,cpuMs:performance.now()-t});}};
 for(const [block,isOld] of ((new URLSearchParams(location.search).has('imageOnly')||new URLSearchParams(location.search).has('gpuOnly'))?[]:[true,false,false,true,true,false,false,true]).entries()){
 pass.fullscreenMaterial=isOld?old:current;status.textContent=` Normal FPS ${block+1}/8: ${isOld?'old':'fixed'} warmup`;await sleep(1500);
 status.textContent=` Normal FPS ${block+1}/8: ${isOld?'old':'fixed'} recording`;frames=[];recording=true;await sleep(5000);recording=false;
 const gaps=frames.slice(1).map((s,i)=>s.t-frames[i].t);
 results.pacing.push({block,old:isOld,scale:2,canvas:[r.domElement.width,r.domElement.height],fps:1000*gaps.length/gaps.reduce((a,b)=>a+b,0),intervalMs:stats(gaps),cpuMs:stats(frames.map(s=>s.cpuMs)),samples:frames});
 }
 results.disjoints=disjoints;results.note='Old shader is an exact clone with only the early-return branch removed. Current/old share uniforms. Image pairs use identical composite inputs. GPU timings isolate final composite with synchronous HDR readback. Normal pacing uses no timing queries/readbacks; eight five-second ABBA blocks at scale 2, adaptive resolution off.';
 output.textContent=JSON.stringify({...results,gpuRuns:results.gpuRuns.map(({samples,...x}:any)=>x),pacing:results.pacing.map(({samples,...x}:any)=>x)},null,2);
 const response=await fetch('/__trieres_profile__',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(results)});status.textContent=response.ok?' Saved '+(await response.json()).file:' Save failed';
 }catch(e){status.textContent=String(e);console.error(e);}
 finally{recording=false;r.render=original.render;g.frame=original.frame;p.beginGpuTimer=original.begin;p.endGpuTimer=original.end;p.adaptive=original.adaptive;p.targetFps=original.cap;p.setRenderScale(original.scale);g.paused=original.paused;g.advanceCloudWeather=original.weather;g.sky.environmentProfiler.enabled=original.profile;pass.fullscreenMaterial=production;for(const x of pending)gl.deleteQuery(x.q);button.disabled=false;}
 };
}
