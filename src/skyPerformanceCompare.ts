/** Dev-only normal-pacing A/B control. No GPU queries/readbacks run in these samples. */
import type { Game } from './game';
export function installSkyPerformanceCompare(game: Game) {
  const g=game as any,p=g.pipeline,r=p.renderer;
  const box=document.createElement('div');
  box.style.cssText='position:fixed;right:12px;top:90px;z-index:100002;background:#101820ed;color:white;padding:12px;font:12px monospace;max-height:70vh;overflow:auto';
  box.innerHTML='<button>Compare sky FPS</button><output> Ready</output><pre></pre>';
  document.body.append(box);
  const button=box.querySelector('button')!,status=box.querySelector('output')!,out=box.querySelector('pre')!;
  const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
  const stats=(a:number[])=>{const sorted=a.slice().sort((a,b)=>a-b);return {count:a.length,mean:a.reduce((a,b)=>a+b,0)/a.length,median:sorted[Math.floor(a.length*.5)],p95:sorted[Math.floor(a.length*.95)],p99:sorted[Math.floor(a.length*.99)]};};
  button.onclick=async()=>{
    const other=[...document.querySelectorAll('button')].filter(b=>b!==button);
    if(other.some(b=>b.disabled)){status.textContent=' Another capture is running';return;}
    button.disabled=true;other.forEach(b=>b.disabled=true);
    const original={frame:g.frame,begin:p.beginGpuTimer,end:p.endGpuTimer,adaptive:p.adaptive,cap:p.targetFps,scale:p.renderScale,cloud:g.sky.sky.material.uniforms.uCloudOn.value,profile:g.sky.environmentProfiler.enabled};
    const results:any[]=[];
    let recording=false,record:{t:number;cpuMs:number}[]=[];
    try{
      p.adaptive=false;p.targetFps=60;p.resetGpuSamples();g.sky.environmentProfiler.enabled=false;p.beginGpuTimer=()=>{};p.endGpuTimer=()=>{};
      g.frame=function(this:any,...args:any[]){const t=performance.now();try{return original.frame.apply(this,args);}finally{if(recording)record.push({t,cpuMs:performance.now()-t});}};
      for(const scale of [1.3,2]){
        p.setRenderScale(scale);
        for(const [block,old] of [true,false,false,true].entries()){
          const mode=old?'old: duplicate clouds':'fixed: single clouds';
          g.sky.sky.material.uniforms.uCloudOn.value=old?1:0;
          status.textContent=` ${mode}, scale ${scale}, block ${block+1}/4 warming`;
          await sleep(1500);
          status.textContent=` ${mode}, scale ${scale}, block ${block+1}/4 recording`;
          record=[];recording=true;await sleep(5000);recording=false;
          const gaps=record.slice(1).map((x,i)=>x.t-record[i].t);
          results.push({scale,mode,block,canvas:[r.domElement.width,r.domElement.height],fps:1000/(gaps.reduce((a,b)=>a+b,0)/gaps.length),intervalMs:stats(gaps),cpuMs:stats(record.map(x=>x.cpuMs)),slowFramesOver25Ms:gaps.filter(x=>x>25).length,samples:record});
        }
      }
      const report={kind:'sky-fix-normal-pacing-abba',at:new Date().toISOString(),viewport:[innerWidth,innerHeight],quality:g.quality.name,cap:60,adaptive:false,paused:g.paused,view:document.getElementById('ormos-review')?.dataset.view,results,
        note:'Live simulation and fixed review camera, no GPU queries or synchronous readbacks. Four five-second samples per resolution, old/new/new/old order; 1.5 seconds warmup per block. Only the live sky cloud switch changes.'};
      out.textContent=JSON.stringify({...report,results:results.map(({samples,...row})=>row)},null,2);
      const response=await fetch('/__trieres_profile__',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
      status.textContent=response.ok?' Saved '+(await response.json()).file:' Save failed';
    }catch(e){status.textContent=String(e);console.error(e);}
    finally{recording=false;g.frame=original.frame;p.beginGpuTimer=original.begin;p.endGpuTimer=original.end;p.adaptive=original.adaptive;p.targetFps=original.cap;p.setRenderScale(original.scale);g.sky.sky.material.uniforms.uCloudOn.value=original.cloud;g.sky.environmentProfiler.enabled=original.profile;button.disabled=false;other.forEach(b=>b.disabled=false);}
  };
}
