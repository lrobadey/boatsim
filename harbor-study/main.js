import './style.css';
import { merchantPreview } from '../harbor-kit/merchant-preview.ts';
import { shared as gameShared } from '../src/gfx/shared.ts';
import { WALK, surfaceAt, moveWalker } from './runtime/walk.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HarborKit, anchorWorld, uprightSpanMatrix } from '../harbor-kit/runtime/kit.ts';
import { Sky } from 'three/addons/objects/Sky.js';
import { Water } from 'three/addons/objects/Water.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#scene');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = motionPreference.matches;
const state = { ready: false, view: 'approach', walk: false, motion: !reduced, water: .35, hour: 16, elapsed: 0, frames: 0, errors: [] };
if(innerWidth<=720)$('#quality').value='1';
const error = (message) => { state.errors.push(String(message)); $('#load-detail').textContent = message; };
window.addEventListener('error', e => error(e.message));
window.addEventListener('unhandledrejection', e => error(String(e.reason)));
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true }); }
catch(e) { $('#loading p').textContent = 'WebGL is unavailable'; error('Enable hardware acceleration, then reload this page.'); throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = .82;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xb5c7c6, .0018);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, .12, 4000);
camera.position.set(64, 31, 77);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 3, -17);
controls.enableDamping = true;
controls.dampingFactor = .075;
controls.minDistance = 2;
controls.maxDistance = 250;
controls.maxPolarAngle = Math.PI * .487;
controls.zoomToCursor = true;
controls.update();
const hemi = new THREE.HemisphereLight(0xd9e4ea, 0x777357, .6); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffedcf, 3.0);
sun.position.set(-50, 70, 60);sun.target.position.set(0,2,-17);scene.add(sun,sun.target);
sun.castShadow=true;sun.shadow.mapSize.set(4096,4096);
Object.assign(sun.shadow.camera,{left:-76,right:76,top:76,bottom:-76,near:1,far:240});
sun.shadow.normalBias=.026;sun.shadow.bias=-.00006;sun.shadow.radius=2;
const sky = new Sky();sky.scale.setScalar(3000);scene.add(sky);
Object.assign(sky.material.uniforms.turbidity,{value:2.6});
sky.material.uniforms.rayleigh.value=1.3;
sky.material.uniforms.mieCoefficient.value=.003;
sky.material.uniforms.mieDirectionalG.value=.78;
if(sky.material.uniforms.cloudCoverage) { sky.material.uniforms.cloudCoverage.value=.18; sky.material.uniforms.cloudDensity.value=.28; }
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene=new THREE.Scene(); const envSky=sky.clone();envSky.material=sky.material;envScene.add(envSky);
let environment;
const sunDir=new THREE.Vector3();
function updateLight(hour, updateEnvironment=true) {
  state.hour=hour;
  const day=(hour-6)/13;
  const elevation=Math.max(.035,Math.sin(day*Math.PI)*.99);
  sunDir.set(-Math.sin((hour-12)*.19),elevation,.55).normalize();
  sun.position.copy(sunDir).multiplyScalar(115).add(sun.target.position);
  const warmth=THREE.MathUtils.smoothstep(hour,16.2,18.7);
  sun.color.set(0xfff1d8).lerp(new THREE.Color(0xffb273),warmth*.75);
  sun.intensity=3.15-warmth*.85;
  gameShared.uSunDir.value.copy(sunDir);gameShared.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
  hemi.intensity=.24+warmth*.20;
  sky.material.uniforms.sunPosition.value.copy(sunDir).multiplyScalar(450000);
  scene.fog.color.set(0xb5c7c6).lerp(new THREE.Color(0xd5b99d),warmth*.55);
  if(water) { water.material.uniforms.sunDirection.value.copy(sunDir);water.material.uniforms.sunColor.value.copy(sun.color); }
  renderer.shadowMap.needsUpdate=true;
  if(updateEnvironment) {
    // The directional light owns the sun. Baking the HDR solar disc into
    // diffuse IBL floods shaded surfaces and counts direct sunlight twice.
    sky.material.uniforms.showSunDisc.value=false;
    const next=pmrem.fromScene(envScene,.03,.1,3500,{size:128});
    sky.material.uniforms.showSunDisc.value=true;
    environment?.dispose();environment=next;scene.environment=next.texture;scene.environmentIntensity=.065+warmth*.075;
  }
  const h=Math.floor(hour),min=Math.round((hour-h)*60);$('#sun-value').value=`${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  document.querySelectorAll('[data-light]').forEach(b=>{const active=Math.abs(Number(b.dataset.light)-hour)<.15;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
}

// A repeatable, small wave-normal field. Water also has broad analytic ripples.
function waterNormal() {
  const n=256, a=new Uint8Array(n*n*4);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const u=x/n*Math.PI*2,v=y/n*Math.PI*2;
    let dx=0,dy=0;
    for(const [kx,ky,p,amp] of [[5,3,.3,.09],[11,-7,2,.06],[-19,13,1,.035],[31,27,4,.015]]){
      const q=Math.cos(kx*u+ky*v+p);dx+=q*amp;dy+=Math.sin(kx*u+ky*v+p)*amp;
    }
    const z=Math.sqrt(Math.max(.1,1-dx*dx-dy*dy));const i=(y*n+x)*4;
    a[i]=(dx*.5+.5)*255;a[i+1]=(dy*.5+.5)*255;a[i+2]=(z*.5+.5)*255;a[i+3]=255;
  }
  const t=new THREE.DataTexture(a,n,n);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.needsUpdate=true;return t;
}
let water=null;
const refractRT=new THREE.WebGLRenderTarget(Math.round(innerWidth*.7),Math.round(innerHeight*.7),{type:THREE.HalfFloatType,depthBuffer:true});
refractRT.depthTexture=new THREE.DepthTexture(refractRT.width,refractRT.height,THREE.UnsignedIntType);
water=new Water(new THREE.PlaneGeometry(4000,4000),{textureWidth:1024,textureHeight:1024,waterNormals:waterNormal(),sunDirection:sunDir,sunColor:0xfff1d8,waterColor:0x185b61,distortionScale:1.7,fog:true});
water.rotation.x=-Math.PI/2;water.position.y=.05;water.name='Harbor water';scene.add(water);
const wu=water.material.uniforms;
wu.size.value=4;
wu.refractionMap={value:refractRT.texture};wu.refractionDepth={value:refractRT.depthTexture};
wu.resolution={value:new THREE.Vector2(innerWidth,innerHeight)};
wu.cameraNearFar={value:new THREE.Vector2(camera.near,camera.far)};
wu.chop={value:.35};
water.material.vertexShader=water.material.vertexShader.replace('varying vec4 worldPosition;', 'varying vec4 worldPosition; varying float waterViewDepth;').replace('gl_Position = projectionMatrix * mvPosition;', 'gl_Position = projectionMatrix * mvPosition; waterViewDepth = -mvPosition.z;');
water.material.fragmentShader=water.material.fragmentShader
 .replace('uniform sampler2D mirrorSampler;',`uniform sampler2D mirrorSampler;
 uniform sampler2D refractionMap; uniform sampler2D refractionDepth; uniform vec2 resolution; uniform vec2 cameraNearFar; uniform float chop; varying float waterViewDepth;`)
 .replace('vec3 surfaceNormal = normalize( noise.xzy * vec3( 1.5, 1.0, 1.5 ) );',`float broad = sin(worldPosition.x*.73+worldPosition.z*.43+time*.62);
 vec3 surfaceNormal = normalize(vec3(noise.x*(.22+chop*.32)+broad*.018,1.0,noise.y*(.22+chop*.32)+cos(worldPosition.z*.61+time*.51)*.018));`)
 .replace('vec3 outgoingLight = albedo;',`vec2 screenUV = gl_FragCoord.xy / resolution;
 float depth = texture2D(refractionDepth,screenUV).x;
 float floorZ = -perspectiveDepthToViewZ(depth,cameraNearFar.x,cameraNearFar.y);
 float thickness = clamp(floorZ-waterViewDepth,0.0,200.0);
 vec2 refractUV = clamp(screenUV+surfaceNormal.xz*.006*min(thickness,3.0),.001,.999);
 vec3 floorColor = texture2D(refractionMap,refractUV).rgb;
 vec3 transmittance = exp(-vec3(.32,.092,.072)*thickness);
 vec3 sea = vec3(.020,.105,.108);
 vec3 transmission = floorColor*transmittance+sea*(1.0-transmittance);
 vec3 outgoingLight = mix(transmission,reflectionSample,clamp(reflectance,.025,.97))+specularLight*.28;
 float foamEdge = (1.0-smoothstep(.0,.2,thickness))*.10;
 outgoingLight+=vec3(foamEdge);`);
water.material.needsUpdate=true;
// The reflection is only needed in the final color pass, not during refraction or override passes.
const reflect=water.onBeforeRender;
water.onBeforeRender=function(r,s,c,...args){if(!s.overrideMaterial)reflect.call(this,r,s,c,...args);};
updateLight(16);

const views={
 approach:{n:'01',title:'The approach',description:'A working waterfront, seen from the sea.',position:[64,31,77],target:[0,4,-17]},
 berth:{n:'02',title:'Alongside',description:'Worn coping, mooring lines, and the waterline.',position:[-15,3.7,11],target:[-5,2.7,-2]},
 quay:{n:'03',title:'On the quay',description:'A clear landing and a path into the village.',position:[12,3.8,-4],target:[-12,3.1,-15]},
 court:{n:'04',title:'The loading court',description:'Deep shade, timber joints, and stored cargo.',position:[-5,3.9,-7],target:[-15,3.8,-15]},
 shore:{n:'05',title:'The limestone shore',description:'Layered rock, shallow water, and olive trees.',position:[-65,30,30],target:[-36,4,-15]},
 overview:{n:'06',title:'Harbor & hinterland',description:'The quay, the court, and the rising settlement.',position:[64,63,55],target:[0,3,-23]},
 boat:{n:'07',title:'The merchant',description:'The game’s Kyrenia hull, dressed in quiet timber and linen.',position:[-18,10,18],target:[-4,3.8,2.5]},
};
let transition=null;
function setView(name,immediate=false) {
  const v=views[name];if(!v)return;
  if(state.walk)endWalk();state.view=name;
  const dest=new THREE.Vector3(...v.position),target=new THREE.Vector3(...v.target);
  transition={start:performance.now(),duration:immediate||reduced?0:1500,from:camera.position.clone(),to:dest,fromTarget:controls.target.clone(),toTarget:target};
  canvas.dataset.transitioning='true';
  document.querySelectorAll('button[data-view]').forEach(b=>{const active=b.dataset.view===name;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('#view-number').textContent=v.n;$('#view-title').textContent=v.title;$('#view-description').textContent=v.description;
  history.replaceState(null,'',`#${name}`);
}
controls.addEventListener('start',()=>{transition=null;});
window.addEventListener('hashchange',()=>setView(location.hash.slice(1)));
const orbitHint=()=>matchMedia('(pointer:coarse)').matches||innerWidth<=720?'Drag to orbit · Pinch to explore':'Drag to orbit · Scroll to explore · Right-drag to pan';
$('#controls-hint').textContent=orbitHint();
let harbor,boat,plank,manifest,kit,merchant;
const dynamicLines=[];
const textureCache=new Map();
function prepare(root){
 root.traverse(o=>{
   if(!o.isMesh)return;
   o.castShadow=true;o.receiveShadow=true;
   const materials=Array.isArray(o.material)?o.material:[o.material];
   for(const m of materials){
     m.side=['cloth','leaf','olive_leaf','tile'].includes(m.name)?THREE.DoubleSide:THREE.FrontSide;
     m.envMapIntensity=.65;
     for(const key of ['map','normalMap','roughnessMap','metalnessMap'])if(m[key]){
       m[key].anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
     }
     // World-space salt/wetness belongs to the harbor, not baked into the reusable stone texture.
     if(['limestone','paving','wood','rock'].includes(m.name)){
       m.onBeforeCompile=sh=>{
         sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vHarborWorld;').replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
          vec4 harborPosition=vec4(transformed,1.0);
          #ifdef USE_INSTANCING
          harborPosition=instanceMatrix*harborPosition;
          #endif
          vHarborWorld=(modelMatrix*harborPosition).xyz;`);
         sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vHarborWorld;')
          .replace('#include <color_fragment>',`#include <color_fragment>
           float wetEdge = .40 + .10*sin(vHarborWorld.x*2.3+vHarborWorld.z*1.9);
           float wet = 1.0-smoothstep(-.05,wetEdge,vHarborWorld.y);
           diffuseColor.rgb *= mix(vec3(1.0),vec3(.52,.60,.48),wet*.68);
           float salt = exp(-pow((vHarborWorld.y-.64)/.18,2.0))*.08;
           diffuseColor.rgb += vec3(salt*.75,salt*.73,salt*.62);`)
          .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,.40,wet*.65);');
       };
       m.customProgramCacheKey=()=> 'ormos-wetstone-instanced-v2';
     }
     m.needsUpdate=true;
   }
 });
}
const urls={manifest:new URL('manifest.json',document.baseURI).href};
async function init(){
 kit=await HarborKit.open(urls.manifest,{anisotropy:Math.min(8,renderer.capabilities.getMaxAnisotropy())});
 manifest=kit.manifest;
 [harbor,merchant,plank]=await Promise.all([kit.create('study-harbor'),merchantPreview(kit),kit.create('merchant-gangplank')]);
 boat=merchant.model.group;
 merchant.dock({id:0,name:'Ormos quay',cx:-4,cz:0,ax:-1,az:0,nx:0,nz:1,length:24,top:2.1,face:0,bollards:[4,-3,-9].map(x=>new THREE.Vector3(x,2.86,-.55))});
 for(let i=0;i<120;i++)merchant.update(1/120);
 prepare(harbor);prepare(plank);
 gameShared.uSunDir.value.copy(sunDir);gameShared.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
 // Spatial batches retain useful culling and distance detail without duplicating geometry.
 const cells=new Map();
 for(const item of manifest.instances){
   const key=[item.id,Math.floor(item.position[0]/40),Math.floor(item.position[2]/40)].join(':');
   if(!cells.has(key))cells.set(key,[]);cells.get(key).push(item);
 }
 let done=0;
 for(const items of cells.values()){
   const center=items.reduce((v,i)=>v.add(new THREE.Vector3(...i.position)),new THREE.Vector3()).divideScalar(items.length);
   const matrices=items.map(i=>new THREE.Matrix4().compose(new THREE.Vector3(...i.position).sub(center),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),i.yaw),new THREE.Vector3(...i.scale)));
   const lod=new THREE.LOD();lod.position.copy(center);
   const scale=Math.max(...items.flatMap(item=>item.scale));
   for(const level of kit.asset(items[0].id).lods){const batch=await kit.batch(items[0].id,matrices,level.level);prepare(batch);lod.addLevel(batch,level.level===0?0:level.distance*scale);}
   scene.add(lod);done++;$('#load-bar').style.width=`${20+done/cells.size*70}%`;$('#load-detail').textContent=`Placing reusable assets · ${done} / ${cells.size}`;
 }
 canvas.dataset.kitInstances=String(manifest.instances.length);canvas.dataset.kitBatches=String(cells.size);
 harbor.name='Ormos waterfront';boat.name='Moored cargo boat';plank.name='Gangplank';
 scene.add(harbor,boat,plank);
 // Continue the seabed beyond the authored near-shore patch. Background sky
 // must never become the transmitted color at the terrain's outer boundary.
 const seabed=new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),new THREE.MeshStandardMaterial({color:0x68634c,roughness:1}));
 seabed.rotation.x=-Math.PI/2;seabed.position.y=-35;seabed.name='Deep seabed';scene.add(seabed);
 updateBoat(0);
 for(const lineData of merchant.physics.mooring.lines){
  const local=lineData.local.toArray(),anchor=lineData.anchor.toArray();
  // Real rope diameter at the eye, with reusable geometry for boat motion.
  const geometry=new THREE.BufferGeometry(), rings=25, sides=8;
  const pos=new Float32Array(rings*sides*3),norm=new Float32Array(pos.length),uv=new Float32Array(rings*sides*2),indices=[];
  for(let i=0;i<rings;i++)for(let j=0;j<sides;j++){
    const n=i*sides+j;uv[n*2]=j/sides;uv[n*2+1]=i/(rings-1)*5;
    if(i<rings-1){const k=i*sides+(j+1)%sides;indices.push(n,k,n+sides,k,k+sides,n+sides);}
  }
  geometry.setAttribute('position',new THREE.BufferAttribute(pos,3));geometry.setAttribute('normal',new THREE.BufferAttribute(norm,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uv,2));geometry.setIndex(indices);
  const line=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x796448,roughness:.92}));scene.add(line);
  dynamicLines.push({local:new THREE.Vector3(...local),anchor:new THREE.Vector3(...anchor),line});
 }
 // Distant terrain silhouettes anchor the horizon without duplicating the authored shore.
 const distantMat=new THREE.MeshStandardMaterial({color:0x838d7d,roughness:1});
 for(const [x,z,sx,sy,sz] of [[-370,-370,210,55,130],[370,-440,260,75,130],[-540,100,180,26,110]]){
   const vertices=[],faces=[],rings=18,sectors=64;
   // Irregular coastal ridges replace conspicuous geometric half-domes.
   for(let r=0;r<=rings;r++)for(let j=0;j<=sectors;j++){
     const u=r/rings,a=j/sectors*Math.PI*2;
     const coast=1+.12*Math.sin(a*3+.7)+.065*Math.cos(a*7);
     const px=Math.cos(a)*u*coast,pz=Math.sin(a)*u*coast;
     const peak=Math.max(0,1-u*u)**1.6*(.62+.20*Math.sin(px*4+pz*2)+.16*Math.cos(pz*7-px));
     vertices.push(px*sx,peak*sy,pz*sz);
     if(r<rings&&j<sectors){const k=r*(sectors+1)+j;faces.push(k,k+1,k+sectors+1,k+1,k+sectors+2,k+sectors+1);}
   }
   const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geo.setIndex(faces);geo.computeVertexNormals();
  const isl=new THREE.Mesh(geo,distantMat);isl.position.set(x,-6,z);scene.add(isl);
 }
 renderer.shadowMap.needsUpdate=true;
 setView(location.hash.slice(1)||'approach',true);
 await renderer.compileAsync(scene,camera);
 state.ready=true;
 $('#load-bar').style.width='100%';$('#loading').classList.add('done');setTimeout(()=>$('#loading').hidden=true,650);
 $('#motion').checked=state.motion;
 setupNotes();
 // Expose read-only inspection data for regression checks and user bug reports.
 window.harborStudy={state,camera,scene,renderer,controls,views,setView,updateLight,assets:urls,manifest,get metrics(){return {...metrics,errors:[...state.errors],camera:camera.position.toArray(),target:controls.target.toArray()};}};
}
function updateBoat(dt){
 if(!boat)return;
 merchant.update(dt);
 const p=merchant.physics.mooring.plank;
 const shipEnd=p.deckLocal.clone().applyMatrix4(boat.matrixWorld);
 // Mooring contacts are fixed-step values. Re-aim from the displayed foot through
 // the quay bearing, retaining the authored length instead of stretching between frames.
 const bearing=p.resting?p.restWorld:p.shoreWorld;
 const landEnd=bearing.clone().sub(shipEnd).normalize().multiplyScalar(p.length).add(shipEnd);
 uprightSpanMatrix(shipEnd,landEnd,p.length).decompose(plank.position,plank.quaternion,plank.scale);
 canvas.dataset.merchant=JSON.stringify({hullLength:merchant.physics.design.hull.length,phase:merchant.physics.mooring.linePhase,plankLength:p.length,plankWidth:p.width,plankResting:p.resting,plankStart:shipEnd.toArray(),plankEnd:landEnd.toArray(),hatches:merchant.model.hatchRects.length});
 for(const l of dynamicLines){
   const start=l.local.clone().applyMatrix4(boat.matrixWorld),end=l.anchor;
   const a=l.line.geometry.attributes.position,n=l.line.geometry.attributes.normal;
   const chord=end.clone().sub(start),side=new THREE.Vector3().crossVectors(chord,new THREE.Vector3(0,1,0)).normalize();
   for(let i=0;i<25;i++){
     const u=i/24,v=start.clone().lerp(end,u);v.y-=Math.sin(u*Math.PI)*.15;
     const tangent=chord.clone();tangent.y-=Math.cos(u*Math.PI)*Math.PI*.15;tangent.normalize();
     const up=new THREE.Vector3().crossVectors(tangent,side).normalize();
     for(let j=0;j<8;j++){
       const theta=j/8*Math.PI*2,normal=side.clone().multiplyScalar(Math.cos(theta)).addScaledVector(up,Math.sin(theta));
       const p=v.clone().addScaledVector(normal,.026),idx=i*8+j;a.setXYZ(idx,p.x,p.y,p.z);n.setXYZ(idx,normal.x,normal.y,normal.z);
     }
   }
   a.needsUpdate=true;n.needsUpdate=true;l.line.geometry.computeBoundingSphere();
 }
}

// Walk mode follows exported terrain triangles, terraces, walls and fixtures.
const keys=new Set();let lookYaw=0,lookPitch=0,drag=null;
function floorAt(x,z){return surfaceAt(manifest,x,z)?.height??-100;}
function startWalk(){
 if(!state.ready)return;
 transition=null;state.walk=true;controls.enabled=false;
 camera.position.set(7,floorAt(7,-5)+WALK.eye,-5);lookYaw=-.2;lookPitch=-.04;
 document.body.classList.add('walking');$('#walk-hint').hidden=false;$('#walk').textContent='Return to orbit';$('#controls-hint').textContent='W A S D · Drag to look · Esc to return';
}
function endWalk(){
 state.walk=false;keys.clear();controls.enabled=true;
 const dir=new THREE.Vector3();camera.getWorldDirection(dir);controls.target.copy(camera.position).addScaledVector(dir,8);controls.update();
 document.body.classList.remove('walking');$('#walk-hint').hidden=true;$('#walk').textContent='Walk ashore';$('#controls-hint').textContent=orbitHint();
}
function walkUpdate(dt){
 const speed=keys.has('shift')?6:2.8;
 const forward=(keys.has('w')||keys.has('arrowup')?1:0)-(keys.has('s')||keys.has('arrowdown')?1:0);
 const right=(keys.has('d')||keys.has('arrowright')?1:0)-(keys.has('a')||keys.has('arrowleft')?1:0);
 const norm=Math.max(1,Math.hypot(forward,right));
 const dx=(Math.sin(lookYaw)*forward+Math.cos(lookYaw)*right)*speed*dt/norm;
 const dz=(-Math.cos(lookYaw)*forward+Math.sin(lookYaw)*right)*speed*dt/norm;
 const next=moveWalker(manifest,{x:camera.position.x,y:floorAt(camera.position.x,camera.position.z),z:camera.position.z},dx,dz);
 camera.position.x=next.x;camera.position.z=next.z;camera.position.y=THREE.MathUtils.lerp(camera.position.y,next.y+WALK.eye,1-Math.exp(-dt*15));
 camera.rotation.order='YXZ';camera.rotation.set(lookPitch,-lookYaw,0);
}
canvas.addEventListener('pointerdown',e=>{if(state.walk){drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);}});
canvas.addEventListener('pointermove',e=>{if(state.walk&&drag){lookYaw+=(e.clientX-drag.x)*.003;lookPitch=THREE.MathUtils.clamp(lookPitch-(e.clientY-drag.y)*.003,-1.3,1.3);drag={x:e.clientX,y:e.clientY};}});
canvas.addEventListener('pointerup',()=>{drag=null;});
canvas.addEventListener('pointercancel',()=>{drag=null;});
window.addEventListener('keydown',e=>{
 if(e.key==='Escape'){if(state.walk)endWalk();$('#settings').hidden=true;$('#settings-toggle').setAttribute('aria-expanded','false');return;}
 if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))return;
 if(e.key.toLowerCase()==='h'){toggleUI();return;}
 if(state.walk&&['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright','shift'].includes(e.key.toLowerCase())){keys.add(e.key.toLowerCase());e.preventDefault();}
});
window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));window.addEventListener('blur',()=>{keys.clear();drag=null;});
$('#walk').addEventListener('click',()=>state.walk?endWalk():startWalk());

const notes=[];
function setupNotes(){
 for(const [title,text,point] of [
  ['Limestone coping','Rounded working edges. Grain and joints share one scale.',[-11,2.2,0]],
  ['Salt & immersion','Wetness and mineral staining follow the waterline.',[19,.7,.6]],
  ['Timber & cloth','Grain, end joints, and a weighted linen canopy.',[-14,5.5,-11]],
  ['Terracotta roof','Individual overlapping tiles and varied firing tones.',[-14,8.4,-20]],
  ['Shore limestone','Broad bedding planes and a broken rubble apron.',[-40,3,-9]],
 ]){const el=document.createElement('div');el.className='note';el.innerHTML=`<strong>${title}</strong><small>${text}</small>`;$('#notes').append(el);notes.push({el,position:new THREE.Vector3(...point)});}
}
const projected=new THREE.Vector3();
function updateNotes(){
 if($('#notes').hidden)return;
 for(const note of notes){projected.copy(note.position).project(camera);const distance=camera.position.distanceTo(note.position);note.el.hidden=projected.z>1||projected.z<0||Math.abs(projected.x)>.9||Math.abs(projected.y)>.8||distance>100;note.el.style.left=`${(projected.x*.5+.5)*innerWidth}px`;note.el.style.top=`${(-projected.y*.5+.5)*innerHeight}px`;}
}
let toastTimer;
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2400);}
function toggleUI(){const hidden=document.body.classList.toggle('ui-hidden');$('#restore-ui').hidden=!hidden;}
$('#hide-ui').onclick=toggleUI;$('#restore-ui').onclick=toggleUI;
$('#settings-toggle').onclick=()=>{const closed=!$('#settings').hidden;$('#settings').hidden=closed;$('#settings-toggle').setAttribute('aria-expanded',String(!closed));};
$('#close-settings').onclick=()=>{$('#settings').hidden=true;$('#settings-toggle').setAttribute('aria-expanded','false');};
document.querySelectorAll('button[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
let lightTimer;
$('#sun').oninput=e=>{const hour=Number(e.target.value);updateLight(hour,false);clearTimeout(lightTimer);lightTimer=setTimeout(()=>updateLight(hour,true),180);document.querySelectorAll('[data-light]').forEach(b=>b.classList.toggle('active',Math.abs(Number(b.dataset.light)-hour)<.15));};
document.querySelectorAll('[data-light]').forEach(b=>b.onclick=()=>{$('#sun').value=b.dataset.light;$('#sun').dispatchEvent(new Event('input'));});
$('#weather').oninput=e=>{state.water=Number(e.target.value);wu.chop.value=state.water;$('#water-value').value=state.water<.25?'Still':state.water<.65?'Sheltered':'Breezy';};
$('#motion').onchange=e=>{state.motion=e.target.checked;};
motionPreference.addEventListener('change',e=>{reduced=e.matches;if(reduced){state.motion=false;$('#motion').checked=false;if(transition)transition.duration=0;}});
$('#annotations').onchange=e=>{$('#notes').hidden=!e.target.checked;};
$('#quality').onchange=()=>{resize();toast('Render quality updated');};
$('#reset').onclick=()=>{clearTimeout(lightTimer);setView('approach');$('#sun').value=16;updateLight(16);};
$('#capture').onclick=()=>{renderer.render(scene,camera);canvas.toBlob(blob=>{if(!blob){toast('Capture unavailable');return;}const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`ormos-${state.view}-${state.hour.toFixed(1)}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('View saved');},'image/png');};
function resize(){
 const quality=Number($('#quality').value),dpr=Math.min(devicePixelRatio,quality);renderer.setPixelRatio(dpr);renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
 const resolution=quality===1?.5:quality===2?1:.7,shadowSize=quality===1?2048:4096;
 if(sun.shadow.mapSize.x!==shadowSize){sun.shadow.map?.dispose();sun.shadow.map=null;sun.shadow.mapSize.setScalar(shadowSize);renderer.shadowMap.needsUpdate=true;}
 refractRT.setSize(Math.max(1,Math.round(innerWidth*resolution)),Math.max(1,Math.round(innerHeight*resolution)));
 const size=new THREE.Vector2();renderer.getDrawingBufferSize(size);wu.resolution.value.copy(size);
 canvas.dataset.quality=String(quality);canvas.dataset.shadowSize=String(shadowSize);
}
resize();
window.addEventListener('resize',resize);
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();toast('Graphics context lost. Reload to restore the scene.');state.ready=false;});
let last=performance.now(), metricStart=last,metricFrames=0;
const metrics={fps:0,frameMs:0,drawCalls:0,triangles:0,textures:0};
function render(now){
 requestAnimationFrame(render);
 if(document.hidden){last=now;return;}
 const dt=Math.min(.05,(now-last)/1000);last=now;
 if(!state.ready)return;
 if(state.motion){state.elapsed+=dt;wu.time.value=state.elapsed*.42;updateBoat(dt);}
 if(transition){
   const u=transition.duration?Math.min(1,(now-transition.start)/transition.duration):1;
   const t=u*u*(3-2*u);camera.position.lerpVectors(transition.from,transition.to,t);controls.target.lerpVectors(transition.fromTarget,transition.toTarget,t);if(u===1)transition=null;
 }
 if(state.walk)walkUpdate(dt);else controls.update();
 // Refraction and reflection use linear offscreen color; the final pass applies ACES once.
 renderer.info.autoReset=false;renderer.info.reset();
 water.visible=false;renderer.setRenderTarget(refractRT);renderer.render(scene,camera);water.visible=true;
 renderer.setRenderTarget(null);renderer.render(scene,camera);
 state.frames++;metricFrames++;if(state.motion&&state.frames%12===0)renderer.shadowMap.needsUpdate=true;
 canvas.dataset.transitioning=String(Boolean(transition));canvas.dataset.ready=String(state.ready);canvas.dataset.view=state.view;canvas.dataset.walk=String(state.walk);canvas.dataset.camera=camera.position.toArray().map(n=>n.toFixed(3)).join(',');
 canvas.dataset.hour=String(state.hour);canvas.dataset.motion=String(state.motion);canvas.dataset.elapsed=state.elapsed.toFixed(3);
 if(now-metricStart>1200){metrics.fps=Math.round(metricFrames*1000/(now-metricStart));metrics.frameMs=(now-metricStart)/metricFrames;metrics.drawCalls=renderer.info.render.calls;metrics.triangles=renderer.info.render.triangles;metrics.textures=renderer.info.memory.textures;$('#stats').textContent=`${metrics.fps} fps · ${metrics.drawCalls} draws · ${(metrics.triangles/1e6).toFixed(2)}m triangles`;canvas.dataset.metrics=JSON.stringify(metrics);canvas.dataset.errors=JSON.stringify(state.errors);metricStart=now;metricFrames=0;}
 updateNotes();
}
requestAnimationFrame(render);
init().catch(e=>{$('#loading p').textContent='The harbor could not load';error(e.message);console.error(e);});
