import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';
import { createKinematics } from '../../src/ship/rowing';
import { Trial, STAGES } from './simulation';
import { MAIN_RIG, AFT_RIG, HYDRO } from './design';
import type { SailRig } from '../../src/ship/design';
import type { SailingSystem } from '../../src/ship/sailing';
import shellUrl from './assets/thalassa-shell.glb?url';

const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const trial=new Trial(),ship=trial.ship;
const canvas=$<HTMLCanvasElement>('scene');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.78;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x98c1c8,.00011);
scene.environmentIntensity=.13;
const camera=new THREE.PerspectiveCamera(43,innerWidth/innerHeight,.2,18000);
const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.dampingFactor=.08;
controls.minDistance=5;controls.maxDistance=320;controls.maxPolarAngle=Math.PI*.49;controls.enablePan=true;
const sky=new Sky();sky.scale.setScalar(14000);scene.add(sky);
const sun=new THREE.Vector3(-.60,.80,.60).normalize();
sky.material.uniforms.turbidity.value=2.5;sky.material.uniforms.rayleigh.value=1.7;
sky.material.uniforms.mieCoefficient.value=.004;sky.material.uniforms.mieDirectionalG.value=.8;sky.material.uniforms.sunPosition.value.copy(sun);
const environmentScene=new THREE.Scene();environmentScene.add(sky.clone());
const pmrem=new THREE.PMREMGenerator(renderer),env=pmrem.fromScene(environmentScene,.04,.1,20000);scene.environment=env.texture;pmrem.dispose();
scene.add(new THREE.HemisphereLight(0xd5eafa,0x6f6a4e,.9));
const light=new THREE.DirectionalLight(0xffedc7,2.5);scene.add(light,light.target);light.castShadow=true;
light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-66,right:66,top:66,bottom:-66,near:1,far:400});
light.shadow.bias=-.00012;light.shadow.normalBias=.06;

const normals=new Uint8Array(128*128*4);
let normalSeed=7919;
const random=()=>{normalSeed=(Math.imul(normalSeed,1664525)+1013904223)>>>0;return normalSeed/4294967296;};
const harmonics=Array.from({length:32},()=>({x:Math.floor(random()*25)-12,z:Math.floor(random()*25)-12,p:random()*Math.PI*2}));
for(let z=0;z<128;z++)for(let x=0;x<128;x++) {
  const k=(z*128+x)*4,a=x/128*Math.PI*2,b=z/128*Math.PI*2;
  let nx=0,ny=0;
  for(const h of harmonics){const len=Math.max(1,Math.hypot(h.x,h.z)),v=.017*Math.cos(a*h.x+b*h.z+h.p)/len;nx+=h.x*v;ny+=h.z*v;}
  normals[k]=128+nx*127;normals[k+1]=128+ny*127;normals[k+2]=255;normals[k+3]=255;
}
const normalMap=new THREE.DataTexture(normals,128,128);normalMap.wrapS=normalMap.wrapT=THREE.RepeatWrapping;
normalMap.magFilter=THREE.LinearFilter;normalMap.minFilter=THREE.LinearMipmapLinearFilter;normalMap.generateMipmaps=true;normalMap.anisotropy=4;normalMap.needsUpdate=true;
const water=new Water(new THREE.PlaneGeometry(24000,24000),{textureWidth:768,textureHeight:768,waterNormals:normalMap,
  sunDirection:sun,sunColor:0xadb4ab,waterColor:0x083940,distortionScale:.20,fog:true});
water.rotation.x=-Math.PI/2;water.position.y=-.015;scene.add(water);
water.material.uniforms.size.value=3;
const root=new THREE.Group();scene.add(root);
const model=new THREE.Group();model.rotation.y=Math.PI/2;root.add(model);
const wood=new THREE.MeshStandardMaterial({color:0x60412c,roughness:.65});
const bladeMat=new THREE.MeshStandardMaterial({color:0x8a6641,roughness:.7});
const oarMeshes:{bank:number;shafts:THREE.InstancedMesh;blades:THREE.InstancedMesh;ids:number[]}[]=[];
for(let bank=0;bank<3;bank++) {
  const slots=ship.rowing.slots.filter(s=>s.bank===bank),slot=slots[0];
  const shaft=new THREE.CylinderGeometry(.07,.105,slot.length,8);shaft.rotateZ(-Math.PI/2);shaft.translate(slot.length/2-slot.inboard,0,0);
  const blade=new THREE.BoxGeometry(slot.bladeLength,slot.bladeWidth,.045);blade.translate(slot.bladeRadius,0,0);
  const shafts=new THREE.InstancedMesh(shaft,wood,slots.length),blades=new THREE.InstancedMesh(blade,bladeMat,slots.length);
  shafts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);blades.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shafts.castShadow=blades.castShadow=true;shafts.frustumCulled=blades.frustumCulled=false;
  root.add(shafts,blades);oarMeshes.push({bank,shafts,blades,ids:slots.map(s=>s.id)});
}
const kin=createKinematics();
// Two effective quarter-rudders at the solver's exact blade centres. The scenic four sweeps
// were removed from this export so a fixed drawing cannot imply a different steering mechanism.
const rudderMeshes:{group:THREE.Group;blade:THREE.Mesh}[]=[];
for(const side of [-1,1]) {
  const r=ship.design.rudder,g=new THREE.Group();g.position.set(side*(ship.design.hull.halfBeam(r.s)+r.xOut),r.y,ship.design.hull.zOf(r.s)+r.dz);
  const a=new THREE.Vector3(0,6.5,-4.8),b=new THREE.Vector3(0,0,0),d=b.clone().sub(a);
  const shaft=new THREE.Mesh(new THREE.CylinderGeometry(.13,.19,d.length(),10),wood);shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),d.normalize());shaft.position.copy(a).add(b).multiplyScalar(.5);g.add(shaft);
  const blade=new THREE.Mesh(new THREE.BoxGeometry(.1,2,1),bladeMat);g.add(blade);shaft.castShadow=blade.castShadow=true;
  root.add(g);rudderMeshes.push({group:g,blade});
}
const sailMat=new THREE.MeshStandardMaterial({color:0xe1d2aa,roughness:.92,side:THREE.DoubleSide});
const ropeMat=new THREE.LineBasicMaterial({color:0x6a5940});
function makeSail(rig:SailRig,system:SailingSystem) {
  const group=new THREE.Group();group.position.set(0,rig.yardY,rig.yardZ);root.add(group);
  const nu=40,nv=20,positions=new Float32Array((nu+1)*(nv+1)*3),indices:number[]=[];
  for(let j=0;j<nv;j++)for(let i=0;i<nu;i++){const a=j*(nu+1)+i,b=a+1,c=a+nu+1,d=c+1;indices.push(a,c,b,b,c,d);}
  const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.BufferAttribute(positions,3));geom.setIndex(indices);
  const cloth=new THREE.Mesh(geom,sailMat);cloth.castShadow=true;cloth.receiveShadow=false;cloth.frustumCulled=false;group.add(cloth);
  const yard=new THREE.Mesh(new THREE.CylinderGeometry(.10,.17,rig.width,12),wood);yard.rotation.z=Math.PI/2;yard.castShadow=true;group.add(yard);
  const edgeData=new Float32Array(16*12*2*3),edgeGeom=new THREE.BufferGeometry();edgeGeom.setAttribute('position',new THREE.BufferAttribute(edgeData,3));
  const edges=new THREE.LineSegments(edgeGeom,ropeMat);group.add(edges);
  function point(u:number,v:number,dep:number,time:number) {
    const h=rig.height*dep;
    const fill=system.current.fill;
    return [(u-.5)*rig.width*(1-.12*v*dep),-h*v+.85*Math.abs(2*u-1)**3*v*dep,
      -rig.height*.25*Math.sin(Math.PI*u)*Math.sin(Math.PI*v)*dep*Math.max(.2,Math.abs(fill))+
      .025*Math.sin(time*2.5+u*25)*v*v*dep];
  }
  return {update(time:number){
    const dep=Math.max(.018,system.current.deployment);group.rotation.y=system.current.yardAngle;
    for(let j=0;j<=nv;j++)for(let i=0;i<=nu;i++)positions.set(point(i/nu,j/nv,dep,time),(j*(nu+1)+i)*3);
    geom.attributes.position.needsUpdate=true;geom.computeVertexNormals();
    let k=0;for(let i=0;i<16;i++)for(let j=0;j<12;j++){edgeData.set(point(i/15,j/12,dep,time),k);k+=3;edgeData.set(point(i/15,(j+1)/12,dep,time),k);k+=3;}
    edgeGeom.attributes.position.needsUpdate=true;edges.frustumCulled=false;
  }};
}
const sails=[makeSail(MAIN_RIG,ship.sailing),makeSail(AFT_RIG,trial.aft)];
const columnPositions:number[]=[],columnColors:number[]=[];
for(const c of ship.columns){columnPositions.push(c.x,c.bottom,c.z,c.x,Math.min(c.top,0),c.z);for(let i=0;i<2;i++)columnColors.push(...(c.x<0?[.35,.86,1]:[1,.74,.3]));}
const columnGeom=new THREE.BufferGeometry();columnGeom.setAttribute('position',new THREE.Float32BufferAttribute(columnPositions,3));columnGeom.setAttribute('color',new THREE.Float32BufferAttribute(columnColors,3));
const columns=new THREE.LineSegments(columnGeom,new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.55,depthTest:false}));root.add(columns);columns.visible=false;
const arrows=Object.fromEntries(['water','rowing','main sail','aft sail','windage','rudders','test drive'].map((name,i)=>{
  const arrow=new THREE.ArrowHelper(new THREE.Vector3(0,1,0),new THREE.Vector3(),1,[0x83dce4,0xe6bc77,0xeee2bc,0xd4c193,0xadc9ef,0xe39169,0xa6e495][i],1,.5);scene.add(arrow);arrow.visible=false;return [name,arrow];
}));
const trackGeom=new THREE.BufferGeometry();const trackData=new Float32Array(14400*3);trackGeom.setAttribute('position',new THREE.BufferAttribute(trackData,3));trackGeom.setDrawRange(0,0);
const track=new THREE.Line(trackGeom,new THREE.LineBasicMaterial({color:0xe6d1a0,transparent:true,opacity:.5}));track.frustumCulled=false;scene.add(track);
const splashCount=240,splashData=new Float32Array(splashCount*3),splashLife=new Float32Array(splashCount).fill(-1);
const splashGeom=new THREE.BufferGeometry();splashGeom.setAttribute('position',new THREE.BufferAttribute(splashData,3));
const splashes=new THREE.Points(splashGeom,new THREE.PointsMaterial({color:0xe2eeea,size:.16,transparent:true,opacity:.55,depthWrite:false}));splashes.frustumCulled=false;scene.add(splashes);
const eventCursor=ship.rowing.events.createCursor();let splashIndex=0;
function splashesUpdate() {
  ship.rowing.events.read(eventCursor,ship.time,e=>{if(e.kind!=='enterWater')return;const k=splashIndex++%splashCount;splashData.set([e.x,.055,e.z],k*3);splashLife[k]=ship.time;});
  for(let i=0;i<splashCount;i++)if(splashLife[i]<0||ship.time-splashLife[i]>1.2)splashData[i*3+1]=-100;
  splashGeom.attributes.position.needsUpdate=true;
}

let activeView='orbit';
function setView(name:string) {
  activeView=name;
  const views:Record<string,number[][]>={orbit:[[104,65,-112],[0,7,0]],stern:[[76,34,88],[0,6,0]],deck:[[5.8,10.3,19],[1,7.9,-12]],water:[[78,8,-98],[0,7,0]]};
  const [eye,target]=views[name]??views.orbit;
  const origin=ship.pos.clone().sub(ship.cg.clone().applyQuaternion(ship.quat));
  camera.position.fromArray(eye).applyQuaternion(ship.quat).add(origin);controls.target.fromArray(target).applyQuaternion(ship.quat).add(origin);
  controls.update();document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',(b as HTMLElement).dataset.view===name));
}
setView('orbit');
function frameWorkspace(){
  const panel=document.querySelector('footer')!.getBoundingClientRect().height;
  // Keep the camera's subject centred in the visible sea above the diagnostics drawer.
  camera.setViewOffset(innerWidth,innerHeight,0,panel/2,innerWidth,innerHeight);camera.updateProjectionMatrix();
}
frameWorkspace();
const lastShipPos=ship.pos.clone();
const worldCg=new THREE.Vector3(),delta=new THREE.Vector3(),inv=new THREE.Quaternion();
let latestSnapshot=trial.snapshot(),renderMs=0,fps=0,frameCount=0,frameTime=0,droppedTime=0;
let ready=false;
function updateModel(alpha:number) {
  root.quaternion.slerpQuaternions(ship.prevQuat,ship.quat,alpha);
  root.position.lerpVectors(ship.prevPos,ship.pos,alpha).sub(worldCg.copy(ship.cg).applyQuaternion(root.quaternion));
  for(const bank of oarMeshes){bank.ids.forEach((id,i)=>{ship.rowing.renderPose(id,alpha,kin);bank.shafts.setMatrixAt(i,kin.matrix);bank.blades.setMatrixAt(i,kin.matrix);});bank.shafts.instanceMatrix.needsUpdate=true;bank.blades.instanceMatrix.needsUpdate=true;}
  sails.forEach(s=>s.update(ship.time));
  rudderMeshes.forEach(r=>{r.group.rotation.y=-ship.rudderAngle;r.blade.scale.z=ship.design.rudder.area/2;});
  delta.copy(ship.pos).sub(lastShipPos);camera.position.add(delta);controls.target.add(delta);lastShipPos.copy(ship.pos);
  light.target.position.copy(ship.pos);light.position.copy(ship.pos).addScaledVector(sun,160);
  water.position.x=camera.position.x;water.position.z=camera.position.z;water.material.uniforms.time.value=ship.time*.3;
  splashesUpdate();
}
const fmt=(x:number,n=1)=>Number.isFinite(x)?x.toFixed(n):'—';
const deg=(x:number)=>(x*180/Math.PI%360+360)%360;
function dl(id:string,rows:[string,string][]) {$(id).innerHTML=rows.map(([k,v])=>`<dt>${k}</dt><dd>${v}</dd>`).join('');}
function updateDiagnostics() {
  if(trial.stepCount) {latestSnapshot=trial.snapshot();trial.clearLedger();}
  const v=trial.sample(),n=latestSnapshot;
  $('speed').textContent=fmt(v.speed/ .514444,2);$('heading').textContent=`${fmt(deg(v.heading),0).padStart(3,'0')}°`;
  $('wind').textContent=`${fmt(v.windMps/.514444,1)} kn`;$('heel').textContent=`${fmt(v.heel*180/Math.PI,2)}°`;
  $('wind-arrow').setAttribute('transform',`rotate(${deg(v.windFrom-v.heading)} 50 50)`);
  $('status').textContent=trial.paused?'SIMULATION PAUSED':`LIVE · ${trial.timeScale}× · CALM SEA`;
  $('sim-time').textContent=`${fmt(v.t,3)} s`;
  let portVolume=0,starboardVolume=0,maxDraft=0;
  const bp=new THREE.Vector3(),tp=new THREE.Vector3();
  for(const c of ship.columns) {
    ship.toWorld(bp.set(c.x,c.bottom,c.z),bp);ship.toWorld(tp.set(c.x,c.top,c.z),tp);
    const fraction=THREE.MathUtils.clamp(-bp.y/Math.max(.001,tp.y-bp.y),0,1),volume=c.area*(c.top-c.bottom)*fraction;
    if(c.x<0)portVolume+=volume;else starboardVolume+=volume;maxDraft=Math.max(maxDraft,-bp.y);
  }
  dl('state',[[`Mass / CG above water`,`${fmt(ship.mass/1000,0)} t / ${fmt(ship.cg.y)} m`],['Speed over ground',`${fmt(v.sog/.514444,2)} kn`],
    ['Lateral drift',`${fmt(v.sway,3)} m/s`],['Yaw / pitch',`${fmt(v.yawRate*180/Math.PI,3)}°/s / ${fmt(v.pitch*180/Math.PI,2)}°`],
    ['Hull origin / heave speed',`${fmt(ship.pos.y-ship.cg.y,3)} m / ${fmt(v.heaveVelocity,3)} m/s`],
    ['Buoyant support port / starboard',`${fmt(portVolume*1.025,0)} / ${fmt(starboardVolume*1.025,0)} t`],
    ['Max draft / initial GM estimate',`${fmt(maxDraft,2)} / ${fmt(HYDRO.metacentricHeightAboveWater-ship.cg.y,1)} m`]]);
  inv.copy(ship.quat).invert();
  $('forces').innerHTML=['water','rowing','main sail','aft sail','windage','rudders','test drive'].map(name=>{
    const f=new THREE.Vector3().fromArray(n.ledger[name].forceN);
    if(name==='water')f.y-=ship.mass*9.81;
    const world=f.clone();f.applyQuaternion(inv);
    const torque=new THREE.Vector3().fromArray(n.ledger[name].torqueNm).applyQuaternion(inv);
    const arrow=arrows[name];arrow.visible=$<HTMLInputElement>('vectors').checked;
    arrow.position.copy(ship.pos).add(new THREE.Vector3(0,8,0));
    if(world.length()>.01){arrow.setDirection(world.normalize());arrow.setLength(Math.min(45,Math.max(.2,f.length()/1500)),.8,.4);}
    return `<div class="force-row"><span>${name==='water'?'Water + weight':name}</span><span>${fmt(-f.z/1000,2)}</span><span>${fmt(f.x/1000,2)}</span><span>${fmt(-torque.y/1000,1)}</span></div>`;
  }).join('');
  $('closure').textContent=`Force / Δmomentum residual ${ship.time?trial.forceClosure.toExponential(1):'0'} N · 120 Hz`;
  const tail=trial.history.slice(-8),mean=(key:string)=>tail.reduce((a,r)=>a+r[key],0)/Math.max(1,tail.length);
  dl('power',[[`${ship.rowing.slots.length*trial.handsPerOar} hands / ${ship.rowing.slots.length} oars`,`${fmt(mean('rowerW')/1000,1)} kW`],['Oars → hull (signed)',`${fmt(mean('hullW')/1000,1)} kW`],
    ['Kinetic energy',`${fmt(v.kineticJ/1000,1)} kJ`],['Physics / rowing per step',`${fmt(n.performance.physicsMsPerStep,2)} / ${fmt(n.ledger.rowing.msPerStep,2)} ms`],
    ['Frame cadence / render submit',`${fmt(fps,0)} fps / ${fmt(renderMs,1)} ms`],['Time budget dropped',`${fmt(droppedTime,2)} s`]]);
  const count=trial.history.length;
  trial.history.forEach((r,i)=>trackData.set([r.x,.04,r.z],i*3));trackGeom.attributes.position.needsUpdate=true;trackGeom.setDrawRange(0,count);
  const ctx=$<HTMLCanvasElement>('graph').getContext('2d')!;ctx.clearRect(0,0,480,78);
  const rows=trial.history.slice(-240),max=Math.max(.5,...rows.map(r=>r.speed/.514444));
  ctx.strokeStyle='#ffffff16';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,70);ctx.lineTo(480,70);ctx.stroke();
  ctx.strokeStyle='#e5c892';ctx.lineWidth=1.5;ctx.beginPath();rows.forEach((r,i)=>{const x=i/239*480,y=70-Math.max(0,r.speed/.514444)/max*62;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
  $('renderer-info').textContent=`${renderer.info.render.calls} draws · ${fmt(renderer.info.render.triangles/1000,0)}k triangles · ${ship.columns.length} columns`;
}

function download(name:string,text:string,type:string) {const a=document.createElement('a'),url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('csv').onclick=()=>{const keys=Object.keys(trial.sample());download('thalassa-trial.csv',[keys.join(','),...trial.history.map(r=>keys.map(k=>r[k]).join(','))].join('\n'),'text/csv');};
$('snapshot').onclick=()=>download('thalassa-snapshot.json',JSON.stringify({...trial.snapshot(),lastMeasurementWindow:latestSnapshot,render:{fps,renderSubmitMs:renderMs,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,droppedTime}},null,2),'application/json');
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view!));
$<HTMLSelectElement>('order').onchange=e=>{const el=e.target as HTMLSelectElement;trial.setOrder(+el.value);$('row-label').textContent=el.selectedOptions[0].text;};
$<HTMLSelectElement>('hands').onchange=e=>{trial.setHandsPerOar(+(e.target as HTMLSelectElement).value);};
type TowRow={knots:number;speedMps:number;rudderDragN:number;steadyThrustN:number;effectivePowerW:number;shaftPowerWAt60Percent:number;extraThrustFor180sRampN:number;humansAt140WAnd60Percent:number;humansAt140WAnd40Percent:number};
let towing:TowRow[]=[];
function updateTow(){const row=towing.find(r=>r.knots===+$<HTMLSelectElement>('tow-speed').value);if(row){
  const force=row.steadyThrustN+row.rudderDragN*(ship.design.rudder.area/2-1),power=force*row.speedMps;
  $('tow-result').innerHTML=`${fmt(force/1000,1)} kN · ${fmt(power/1000,1)} kW at hull<br>${fmt(power/.6/1000,1)} kW paddle input at 60%<br>${Math.ceil(power/84)}–${Math.ceil(power/56)} hands at 140 W<br>+${fmt(row.extraThrustFor180sRampN/1000,1)} kN for a 180 s ramp`;
}}
fetch(new URL('./results/tow.json',import.meta.url)).then(r=>{if(!r.ok)throw Error(String(r.status));return r.json();}).then(r=>{towing=r.rows;updateTow();}).catch(()=>$('tow-result').textContent='Run tow.mjs to generate sizing data.');
$<HTMLSelectElement>('tow-speed').onchange=updateTow;
$<HTMLSelectElement>('rudder-area').onchange=e=>{ship.design.rudder.area=+(e.target as HTMLSelectElement).value;updateTow();};
$<HTMLInputElement>('auxiliary').oninput=e=>{trial.auxiliaryKN=+(e.target as HTMLInputElement).value;$('auxiliary-label').textContent=`${fmt(trial.auxiliaryKN,1)} kN · no device`;};
$<HTMLInputElement>('sail').oninput=e=>{trial.sail=+(e.target as HTMLInputElement).value;$('sail-label').textContent=`${Math.round(trial.sail*100)}%`;};
$<HTMLInputElement>('breeze').oninput=e=>{trial.wind.baseSpeed=+(e.target as HTMLInputElement).value;trial.wind.update(0);$('breeze-label').textContent=`${trial.wind.baseSpeed} m/s`;};
$<HTMLInputElement>('direction').oninput=e=>{trial.wind.baseFrom=+(e.target as HTMLInputElement).value*Math.PI/180;trial.wind.update(0);$('direction-label').textContent=`${fmt(deg(trial.wind.baseFrom),0).padStart(3,'0')}°`;};
$<HTMLInputElement>('hold').onchange=e=>{trial.headingHold=(e.target as HTMLInputElement).checked;trial.targetHeading=ship.heading;updateHelmLabel();};
function updateHelmLabel() {$('helm-label').textContent=trial.headingHold?'Heading hold':`${trial.helm<0?'Port':trial.helm>0?'Starboard':'Midships'} ${Math.round(Math.abs(trial.helm)*100)}${trial.helm?'%':''}`;}
function setHelm(x:number){trial.headingHold=false;$<HTMLInputElement>('hold').checked=false;trial.helm=x;$<HTMLInputElement>('helm').value=String(x);updateHelmLabel();}
$<HTMLInputElement>('helm').oninput=e=>setHelm(+(e.target as HTMLInputElement).value);
function pause() {trial.paused=!trial.paused;$('pause').textContent=trial.paused?'Resume':'Pause';$('pause').setAttribute('aria-label',trial.paused?'Resume simulation':'Pause simulation');updateDiagnostics();}
$('pause').onclick=pause;$('step').onclick=()=>{if(!trial.paused)pause();trial.step();updateModel(1);updateDiagnostics();};
$<HTMLSelectElement>('rate').onchange=e=>trial.timeScale=+(e.target as HTMLSelectElement).value;
$('reset').onclick=()=>location.reload(); // fresh agents, clocks, fatigue and instrumentation for a repeatable trial
$('tools-toggle').onclick=()=>{const hidden=!$('tools').hidden;$('tools').hidden=hidden;(document.querySelector('.tool-tabs') as HTMLElement).hidden=hidden;$('tools-toggle').setAttribute('aria-expanded',String(!hidden));frameWorkspace();};
const toolPanels=Array.from(document.querySelectorAll<HTMLElement>('.tool-column'));
toolPanels[0].classList.add('selected');
document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b=>b.onclick=()=>{
  const index=+b.dataset.tool!;toolPanels.forEach((p,i)=>p.classList.toggle('selected',i===index));
  document.querySelectorAll('[data-tool]').forEach(x=>x.classList.toggle('active',x===b));$('tools').scrollTop=0;frameWorkspace();
});
$<HTMLInputElement>('columns').onchange=e=>columns.visible=(e.target as HTMLInputElement).checked;
$<HTMLInputElement>('trail').onchange=e=>track.visible=(e.target as HTMLInputElement).checked;
$<HTMLInputElement>('vectors').onchange=()=>{$('vector-legend').hidden=!$<HTMLInputElement>('vectors').checked;frameWorkspace();updateDiagnostics();};
$<HTMLInputElement>('row-physics').onchange=e=>trial.rowingEnabled=(e.target as HTMLInputElement).checked;
const pressed=new Set<string>();
window.addEventListener('keydown',e=>{if((e.target as HTMLElement).matches('input,select,button,textarea'))return;
  if(e.code==='Space'){e.preventDefault();if(!e.repeat)pause();}if(e.code==='KeyA'||e.code==='KeyD'){pressed.add(e.code);setHelm(pressed.has('KeyD')?1:-1);}});
window.addEventListener('keyup',e=>{if(pressed.has(e.code)){pressed.delete(e.code);setHelm(pressed.has('KeyD')?1:pressed.has('KeyA')?-1:0);}});
addEventListener('blur',()=>{if(pressed.size){pressed.clear();setHelm(0);}});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;renderer.setSize(innerWidth,innerHeight);frameWorkspace();});

let last=performance.now(),acc=0,lastUi=0,frameNumber=0;
document.addEventListener('visibilitychange',()=>{last=performance.now();acc=0;});
function frame(now:number) {
  requestAnimationFrame(frame);
  const elapsed=Math.max(0,(now-last)/1000);last=now;
  if(!ready)return;
  frameCount++;frameTime+=elapsed;if(frameTime>.75){fps=frameCount/frameTime;frameCount=0;frameTime=0;}
  if(!trial.paused&&!document.hidden) {
    acc+=Math.min(.1,elapsed)*trial.timeScale;
    let steps=0;while(acc>=1/120&&steps<32){trial.step();acc-=1/120;steps++;}
    if(acc>=1/120){droppedTime+=acc;acc=0;}if(elapsed>.1)droppedTime+=(elapsed-.1)*trial.timeScale;
  } else acc=0;
  updateModel(trial.paused?1:acc*120);controls.update();
  const start=performance.now();renderer.render(scene,camera);renderMs=renderMs*.9+(performance.now()-start)*.1;
  if(now-lastUi>400){lastUi=now;updateDiagnostics();}
  frameNumber++;
}
requestAnimationFrame(frame);
// A small explicit inspection API supports deterministic dev tools and headless diagnostics.
declare global {interface Window {thalassa:{trial:Trial;renderer:THREE.WebGLRenderer;ready:()=>boolean;snapshot:()=>unknown;view:(name:string)=>void}}}
window.thalassa={trial,renderer,ready:()=>ready&&frameNumber>1,snapshot:()=>({...trial.snapshot(),frameNumber,fps}),view:setView};
new GLTFLoader().load(shellUrl,gltf=>{
  gltf.scene.traverse(ob=>{if(ob instanceof THREE.Mesh){ob.castShadow=true;ob.receiveShadow=true;if(ob.material instanceof THREE.MeshStandardMaterial){ob.material.envMapIntensity=.55;}}});
  model.add(gltf.scene);ready=true;last=performance.now();$('loading').hidden=true;$('loading').style.display='none';updateModel(1);updateDiagnostics();
},progress=>{if(progress.total){$<HTMLProgressElement>('load-progress').max=progress.total;$<HTMLProgressElement>('load-progress').value=progress.loaded;}},error=>{
  $('load-message').textContent='The exterior could not be loaded. Reload to try again.';console.error('Thalassa model load',error);
});
