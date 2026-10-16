import fs from 'node:fs';
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const source=fs.readFileSync(root+'/src/gfx/cloudModel.ts','utf8');
const constant=name=>Number(source.match(new RegExp(`const float ${name} = ([0-9.]+);`))[1]);
const earth=constant('C_EARTH'),base=constant('C_BOTTOM');
let state=1729;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
const half=value=>THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(value));
const guard=8;
const eligible=(height,distance)=>distance>0&&height<base&&distance<base-height-guard;
function cloudEntry(height,vertical){
 const radius=earth+height, target=earth+base;
 if(radius>=target)return 0;
 const b=radius*vertical,c=radius*radius-target*target,disc=b*b-c;
 return disc<0?Infinity:-b+Math.sqrt(disc);
}
let checked=0,skippable=0,unsafe=0,tapChecks=0,unsafeAcceptedTaps=0,maxUnderestimate=0;
const heights=[-20,0,7,100,800,1300,1390,1395,1399,1400,1500,1600,3600,4000];
const byHeight=[];
for(const height of heights){
 let local=0;
 for(let i=0;i<12000;i++){
  const gap=base-height;
  const distance=i%3===0?Math.max(0.001,gap+(random()-.5)*30):Math.exp(Math.log(.1)+random()*Math.log(600000));
  const dy=random()*2-1;
  checked++;
  if(!eligible(height,distance))continue;
  skippable++;local++;
  if(cloudEntry(height,dy)<=distance)unsafe++;
  // Exercise the reconstruction gate using actual binary16 packing. Try source ray depths
  // around the cloud entry boundary and around the destination plus its tolerance.
  const toleranceKm=Math.max(.001,distance*.001*.001);
  for(let j=0;j<20;j++){
   const sourceDepth=j%2===0?Math.max(0,base-height+(random()-.5)*20):Math.max(0,distance+(random()-.5)*20);
   const packed=half(sourceDepth*.001),accepted=packed>=0&&packed<=distance*.001+toleranceKm;
   tapChecks++;maxUnderestimate=Math.max(maxUnderestimate,sourceDepth-packed*1000);
   if(accepted && sourceDepth>=base-height)unsafeAcceptedTaps++;
  }
 }
 byHeight.push({height,checked:12000,eligible:local});
}
// Explicit boundary behavior: sky sentinel, a point exactly at the guarded cutoff,
// and cameras within or above the layer must never be approved by this first rule.
const boundaryCases=[{name:'sky/no foreground',value:eligible(7,-1),want:false},{name:'guard boundary',value:eligible(7,base-7-guard),want:false},{name:'inside cloud',value:eligible(1600,1),want:false},{name:'above cloud',value:eligible(4000,1),want:false},{name:'near mast',value:eligible(7,20),want:true},{name:'near water',value:eligible(7,100),want:true}];
for(const c of boundaryCases)if(c.value!==c.want)throw Error(c.name);
if(unsafe||unsafeAcceptedTaps)throw Error('candidate admitted unsafe ray or depth tap');
const report={kind:'offline-geometric-and-depth-packing-probe',source:'src/gfx/cloudModel.ts',earthRadius:earth,cloudBase:base,proposedGuardMetres:guard,checked,eligible:skippable,unsafeEligibleRays:unsafe,packedDepthTapChecks:tapChecks,unsafeAcceptedDepthTaps:unsafeAcceptedTaps,maximumHalfDepthUnderestimateMetres:maxUnderestimate,byHeight,boundaryCases,note:'Synthetic deterministic coverage, not actual screen coverage or GPU performance. Sphere reference uses double precision, not execution of compiled GLSL. The 8m margin is a conservative candidate for current camera heights and depth metadata; visual/GPU verification remains required.'};
fs.writeFileSync(root+'/docs/gpu-breakdown/foreground-investigation/probe.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,byHeight:undefined,boundaryCases:undefined},null,2));
