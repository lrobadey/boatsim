import * as THREE from 'three';
import {merchantPreview} from './merchant-preview';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {HarborKit,uprightSpanMatrix,anchorWorld,snapAnchor,type Asset} from './runtime/kit';

const $=<T extends HTMLElement>(s:string)=>document.querySelector<T>(s)!;
const canvas=$<HTMLCanvasElement>('#scene'),select=$<HTMLSelectElement>('#asset'),lod=$<HTMLSelectElement>('#lod');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.95;
const scene=new THREE.Scene();scene.background=new THREE.Color(0xb7beb4);scene.fog=new THREE.Fog(0xb7beb4,85,180);
const camera=new THREE.PerspectiveCamera(42,innerWidth/innerHeight,.025,300);const controls=new OrbitControls(camera,canvas);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.48;
const pmrem=new THREE.PMREMGenerator(renderer);const room=new RoomEnvironment();scene.environment=pmrem.fromScene(room,.03).texture;scene.environmentIntensity=.28;room.dispose();pmrem.dispose();
const sun=new THREE.DirectionalLight(0xfff1d9,3.2);sun.position.set(-18,28,-20);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-28,right:28,top:28,bottom:-28,near:1,far:90});sun.shadow.normalBias=.012;scene.add(sun,sun.target,new THREE.HemisphereLight(0xe3edee,0x5a5843,.65));
const floor=new THREE.Mesh(new THREE.PlaneGeometry(400,400),new THREE.MeshStandardMaterial({color:0x909d8c,roughness:1}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
const content=new THREE.Group(),overlay=new THREE.Group();scene.add(content,overlay);
let kit:HarborKit,serial=0,asset:Asset|undefined;
let merchant:Awaited<ReturnType<typeof merchantPreview>>|undefined;
let merchantCache:ReturnType<typeof merchantPreview>|undefined;
let overlayVersion=0;
let placed:{object:THREE.Object3D;asset:Asset}[]=[];
let fitBox=new THREE.Box3();const errors:string[]=[];
function error(e:unknown){errors.push(String(e));$('#status').textContent=String(e);canvas.dataset.errors=JSON.stringify(errors);select.disabled=false;}
window.addEventListener('error',e=>error(e.message));window.addEventListener('unhandledrejection',e=>error(e.reason));
async function add(id:string,position:THREE.Vector3=new THREE.Vector3(),level=0){const object=await kit.create(id,level);object.position.copy(position);content.add(object);placed.push({object,asset:kit.asset(id)});return object;}
function clearOverlay(){overlayVersion++;overlay.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments){o.geometry.dispose();for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();}});overlay.clear();}
async function overlays(){
 clearOverlay();const generation=overlayVersion;
 for(const item of placed){
  if($<HTMLInputElement>('#anchors').checked)for(const a of item.asset.anchors){const marker=new THREE.Mesh(new THREE.SphereGeometry(.065,10,8),new THREE.MeshBasicMaterial({color:0xd57228,depthTest:false}));marker.position.copy(anchorWorld(item.object,item.asset,a.name));marker.renderOrder=10;overlay.add(marker);}
  if($<HTMLInputElement>('#collisions').checked)for(const c of item.asset.collision){
   if(c.type==='mesh'){
    const proxy=await kit.collisionMesh(item.asset.id);if(generation!==overlayVersion)return;if(!proxy)continue;proxy.updateMatrixWorld(true);
    proxy.traverse(o=>{if(o instanceof THREE.Mesh){const mesh=new THREE.Mesh(o.geometry.clone().applyMatrix4(o.matrixWorld),new THREE.MeshBasicMaterial({color:0x208b77,wireframe:true,depthTest:false}));mesh.applyMatrix4(item.object.matrixWorld);mesh.renderOrder=9;overlay.add(mesh);}});continue;
   }
   const geo=c.type==='box'?new THREE.BoxGeometry(...c.size):new THREE.CylinderGeometry(c.radius,c.radius,c.height,16);
   const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({color:0x208b77,wireframe:true,depthTest:false}));mesh.position.set(...c.center);mesh.updateMatrix();mesh.applyMatrix4(item.object.matrixWorld);mesh.renderOrder=9;overlay.add(mesh);
  }
 }
}
function frame(){
 const center=fitBox.getCenter(new THREE.Vector3()),size=fitBox.getSize(new THREE.Vector3());const radius=Math.max(size.x,size.y,size.z)*.5;
 const distance=Math.max(1.8,radius/Math.tan(THREE.MathUtils.degToRad(camera.fov/2)))*1.60/Math.min(1,camera.aspect);
 // A metre-scale prop needs a metre-scale shadow map, not the whole berth's atlas.
 const shadowExtent=Math.max(1.5,radius*2.2),lightDistance=Math.max(20,radius*6);
 sun.target.position.copy(center);sun.position.copy(center).add(new THREE.Vector3(-18,28,-20).normalize().multiplyScalar(lightDistance));
 Object.assign(sun.shadow.camera,{left:-shadowExtent,right:shadowExtent,top:shadowExtent,bottom:-shadowExtent,near:.1,far:lightDistance*2});sun.shadow.camera.updateProjectionMatrix();
 sun.shadow.normalBias=merchant?0:Math.min(.012,shadowExtent/2048);sun.shadow.bias=-.00015;sun.shadow.needsUpdate=true;
 controls.target.copy(center);camera.position.copy(center).add(new THREE.Vector3(.85,.58,-1.25).normalize().multiplyScalar(distance));
 // Leave a calm margin for the developer inspector while retaining object scale.
 camera.setViewOffset(innerWidth,innerHeight,innerWidth>760?-innerWidth*.11:0,0,innerWidth,innerHeight);
 controls.minDistance=Math.max(.15,radius*.25);controls.maxDistance=distance*4;controls.update();
}
async function show(){
 const token=++serial;select.disabled=true;canvas.dataset.ready='false';$('#status').textContent='Loading…';content.clear();clearOverlay();placed=[];asset=undefined;merchant=undefined;$('#merchant-controls').hidden=true;
 const id=select.value;
 if(id==='game-merchant'){
  merchant=await (merchantCache??=merchantPreview(kit));merchant.model.setAuthoredShell(merchant.shell);merchant.model.setHatchesOpen(false);merchant.physics.sailing.deploymentTarget=0;$<HTMLInputElement>('#deploy').value='0';$<HTMLInputElement>('#hatches').checked=false;$<HTMLInputElement>('#original-shell').checked=false;content.add(merchant.model.group);lod.disabled=true;
  $('#family').textContent='GAME VESSEL';$('#title').textContent='Kyrenia merchant';
  $('#description').textContent='The original game hull proportions, rig and moving controls, with an authored timber shell.';
  $('#details').innerHTML='<dt>Hull · length / beam</dt><dd>13.78 / 4.22 m</dd><dt>Rig · mast / yard</dt><dd>9.5 / 11 m</dd><dt>Working layout</dt><dd>2 opening hatches · 6 sweeps</dd><dt>Physics</dt><dd>Original merchant design unchanged</dd>';
  $('#merchant-controls').hidden=false;floor.position.y=-1.31;
 }else if(id==='assembly'){
  lod.disabled=true;$('#family').textContent='ASSEMBLY';$('#title').textContent='Working berth';$('#description').textContent='Three snapped quay modules, separate fixtures, building, canopy and cargo boat.';
  const first=await add('quay-straight-a',new THREE.Vector3(-6,2,0));
  const middle=await add('quay-straight-b');snapAnchor(middle,kit.asset('quay-straight-b'),'join-left',first,kit.asset('quay-straight-a'),'join-right');
  const last=await add('quay-straight-c');snapAnchor(last,kit.asset('quay-straight-c'),'join-left',middle,kit.asset('quay-straight-b'),'join-right');
  await add('warehouse',new THREE.Vector3(0,2,9.5));
  for(const x of [-6,0,6])await add('linen-canopy',new THREE.Vector3(x,2,2.1));
  for(const x of [-6,6])await add('mooring-stone',new THREE.Vector3(x,2,.55));
  for(const x of [-7,-3,1,5])await add('rope-fender',new THREE.Vector3(x,2,-.22));
  await add('packing-rack',new THREE.Vector3(-6,2,2.1));
  const cargoMatrices=[-6.7,-6,-5.3].map(x=>new THREE.Matrix4().makeTranslation(x,3.07,2.1));
  content.add(await kit.batch('amphora-small',cargoMatrices));
  const boatZ=.15-1.8-Math.sqrt(3.6**2-.18**2);const boat=await add('cargo-boat',new THREE.Vector3(0,.15,boatZ));
  const start=anchorWorld(boat,kit.asset('cargo-boat'),'gangplank'),end=new THREE.Vector3(4.7,2.13,.15);
  const plank=await add('gangplank',start.clone().add(end).multiplyScalar(.5));uprightSpanMatrix(start,end,3.6).decompose(plank.position,plank.quaternion,plank.scale);
  $('#details').innerHTML='<dt>Placement</dt><dd>6 m modules · opposing snap normals</dd><dt>Gangplank</dt><dd>3.6 m rigid span · contact anchors</dd><dt>Materials</dt><dd>Shared PBR textures and materials</dd>';
  floor.position.y=-2.25;
 }else{
  asset=kit.asset(id);lod.disabled=asset.lods.length<2;if(lod.disabled)lod.value='0';
  await add(id,new THREE.Vector3(),Number(lod.value));
  $('#family').textContent=asset.family.toUpperCase();$('#title').textContent=id.replaceAll('-',' ');$('#description').textContent=asset.description;
  const size=asset.bounds.max.map((v,i)=>v-asset!.bounds.min[i]);
  $('#details').innerHTML=`<dt>Dimensions · X / Y / Z</dt><dd>${size.map(v=>v.toFixed(2)).join(' / ')} m</dd><dt>Origin</dt><dd>${asset.origin}</dd><dt>Geometry · near</dt><dd>${asset.triangles.toLocaleString()} triangles</dd><dt>Contract</dt><dd>${asset.anchors.length} anchors · ${asset.collision.length} collision proxies</dd>`;
  floor.position.y=asset.bounds.min[1]-.015;
 }
 if(token!==serial)return;
 content.updateMatrixWorld(true);fitBox.setFromObject(content);frame();await overlays();
 await renderer.compileAsync(scene,camera);
 // Present two frames before exposing readiness to inspection or interaction.
 await new Promise<void>(resolve=>requestAnimationFrame(()=>{renderer.render(scene,camera);requestAnimationFrame(()=>resolve());}));
 if(token!==serial)return;
 $('#stats').textContent=`${renderer.info.render.calls} draws · ${(renderer.info.render.triangles/1000).toFixed(0)}k triangles`;
 canvas.dataset.ready='true';canvas.dataset.asset=id;canvas.dataset.lod=lod.value;canvas.dataset.errors=JSON.stringify(errors);select.disabled=false;$('#status').textContent='Ready';history.replaceState(null,'','#'+id);
}
select.onchange=()=>{lod.value='0';show().catch(error);};lod.onchange=()=>show().catch(error);
$<HTMLInputElement>('#anchors').onchange=()=>overlays().catch(error);$<HTMLInputElement>('#collisions').onchange=()=>overlays().catch(error);$('#reset').onclick=frame;
window.addEventListener('resize',()=>{renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();frame();});
let count=0,last=performance.now(),previousFrame=performance.now();function render(now:number){requestAnimationFrame(render);const dt=Math.min(.05,(now-previousFrame)/1000);previousFrame=now;if(merchant){merchant.update(dt);canvas.dataset.merchant=JSON.stringify(merchant.readback());}controls.update();renderer.render(scene,camera);count++;if(now-last>1000){const stats={fps:Math.round(count*1000/(now-last)),draws:renderer.info.render.calls,triangles:renderer.info.render.triangles,...kit?.stats};canvas.dataset.metrics=JSON.stringify(stats);$('#stats').textContent=`${stats.draws} draws · ${(stats.triangles/1000).toFixed(0)}k triangles`;count=0;last=now;}}requestAnimationFrame(render);
HarborKit.open(new URL('manifest.json',document.baseURI),{anisotropy:Math.min(8,renderer.capabilities.getMaxAnisotropy())}).then(async loaded=>{kit=loaded;for(const asset of kit.assets.values()){const option=document.createElement('option');option.value=asset.id;option.textContent=asset.id;select.append(option);}select.value=kit.assets.has(location.hash.slice(1))||location.hash.slice(1)==='game-merchant'?location.hash.slice(1):'assembly';await show();}).catch(error);

$<HTMLInputElement>('#deploy').oninput=e=>{if(merchant)merchant.physics.sailing.deploymentTarget=Number((e.target as HTMLInputElement).value);};
$<HTMLInputElement>('#hatches').onchange=e=>merchant?.model.setHatchesOpen((e.target as HTMLInputElement).checked);
$<HTMLInputElement>('#original-shell').onchange=e=>{if(merchant)merchant.model.setAuthoredShell((e.target as HTMLInputElement).checked?null:merchant.shell);};
