/** Offline acceptance: decode the shipped bytes with the runtime's decoder. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import ts from 'typescript';
const toolkitRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=process.argv[2]?path.resolve(process.argv[2]):toolkitRoot;
const manifest=JSON.parse(await fs.readFile(path.join(root,'assets/manifest.json'),'utf8'));
const report={assets:[],checks:['runtime decoder','finite attributes','index bounds','geometry bounds','texture paths','source paths','anchor coordinates','LOD reduction','snap transforms','upright rigid spans']};
await MeshoptDecoder.ready;
assert.equal(manifest.units,'metres');assert.deepEqual(manifest.up,[0,1,0]);
assert.equal(new Set(manifest.assets.map(a=>a.id)).size,manifest.assets.length);
const cache=new Map();
async function inspect(file){
 if(cache.has(file))return cache.get(file);
 const bytes=await fs.readFile(path.join(root,'assets',file));assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(8),bytes.length);
 const len=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+len)),bin=bytes.subarray(28+len),views=[];
 for(const v of doc.bufferViews){const e=v.extensions?.EXT_meshopt_compression;if(e){const output=new Uint8Array(e.count*e.byteStride);MeshoptDecoder.decodeGltfBuffer(output,e.count,e.byteStride,bin.subarray(e.byteOffset,e.byteOffset+e.byteLength),e.mode,e.filter);views.push(output);}else views.push(v.buffer===0?bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength):null);}
 const n={SCALAR:1,VEC2:2,VEC3:3,VEC4:4},size={5123:2,5125:4,5126:4},read={5123:'getUint16',5125:'getUint32',5126:'getFloat32'};
 const access=doc.accessors.map(a=>{assert(n[a.type]&&size[a.componentType]);const source=views[a.bufferView];assert(source);const view=new DataView(source.buffer,source.byteOffset,source.byteLength),stride=doc.bufferViews[a.bufferView].byteStride??n[a.type]*size[a.componentType];return Array.from({length:a.count},(_,i)=>Array.from({length:n[a.type]},(_,j)=>{const x=view[read[a.componentType]]((a.byteOffset??0)+i*stride+j*size[a.componentType],true);assert(Number.isFinite(x));return x;}));});
 for(const img of doc.images??[])await fs.access(path.resolve(root,'assets',path.dirname(file),img.uri));
 let triangles=0;const bounds=new THREE.Box3(),anchors={};
 function walk(i,parent){const node=doc.nodes[i],local=node.matrix?new THREE.Matrix4().fromArray(node.matrix):new THREE.Matrix4().compose(new THREE.Vector3(...(node.translation??[0,0,0])),new THREE.Quaternion(...(node.rotation??[0,0,0,1])),new THREE.Vector3(...(node.scale??[1,1,1]))),world=parent.clone().multiply(local);
  if(node.name?.startsWith('anchor_'))anchors[node.name.slice(7)]=new THREE.Vector3().setFromMatrixPosition(world).toArray();
  if(node.mesh!==undefined)for(const p of doc.meshes[node.mesh].primitives){assert.equal(p.mode??4,4);const pos=access[p.attributes.POSITION];for(const v of pos)bounds.expandByPoint(new THREE.Vector3(...v).applyMatrix4(world));const indices=p.indices!==undefined?access[p.indices].flat():pos.map((_,i)=>i);assert.equal(indices.length%3,0);assert(indices.every(i=>i>=0&&i<pos.length));triangles+=indices.length/3;}
  for(const child of node.children??[])walk(child,world);
 }
 for(const i of doc.scenes[doc.scene??0].nodes)walk(i,new THREE.Matrix4());
 const result={triangles,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},anchors,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};cache.set(file,result);return result;
}
for(const a of manifest.assets){
 await fs.access(path.join(root,a.source.blend));await fs.access(path.join(root,a.source.recipe));
 const near=await inspect(a.lods[0].file);assert.equal(near.triangles,a.triangles,a.id+' triangles');
 for(const edge of ['min','max'])near.bounds[edge].forEach((v,i)=>assert(Math.abs(v-a.bounds[edge][i])<1e-4,a.id+' bounds'));
 for(const anchor of a.anchors){assert(near.anchors[anchor.name],a.id+' missing anchor '+anchor.name);anchor.position.forEach((v,i)=>assert(Math.abs(v-near.anchors[anchor.name][i])<1e-4,a.id+' anchor '+anchor.name));}
 for(const lod of a.lods){const r=await inspect(lod.file);assert.equal(r.bytes,lod.bytes);assert.equal(r.sha256,lod.sha256);if(lod.level>0)assert(r.triangles<near.triangles,a.id+' LOD reduction');}
 for(const c of a.collision){if(c.type==='mesh'){const r=await inspect(c.file);assert(r.triangles<=200||r.triangles<near.triangles*.1,a.id+' collision budget');}else if(c.type==='box')assert(c.size.every(v=>v>0));else assert(c.radius>0&&c.height>0);}
 report.assets.push({id:a.id,triangles:near.triangles,lods:a.lods.length,anchors:a.anchors.length});
}
// Compile the actual adapter, then verify snap alignment through separate parent frames.
const temp=path.join(toolkitRoot,'runtime/.validation.mjs');
await fs.writeFile(temp,ts.transpileModule(await fs.readFile(path.join(toolkitRoot,'runtime/kit.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
try{const {snapAnchor,anchorWorld,uprightSpanMatrix}=await import(temp);
 for(const angle of [0,.7,Math.PI,-2]){const start=new THREE.Vector3(1,1.95,3),delta=new THREE.Vector3(Math.sin(angle)*Math.sqrt(3.6**2-.35**2),.35,Math.cos(angle)*Math.sqrt(3.6**2-.35**2)),end=start.clone().add(delta),matrix=uprightSpanMatrix(start,end,3.6);assert(new THREE.Vector3(0,0,-1.8).applyMatrix4(matrix).distanceTo(start)<1e-8);assert(new THREE.Vector3(0,0,1.8).applyMatrix4(matrix).distanceTo(end)<1e-8);assert(new THREE.Vector3(0,1,0).transformDirection(matrix).y>.99);assert(Math.abs(matrix.determinant()-1)<1e-8);}
 assert.throws(()=>uprightSpanMatrix(new THREE.Vector3(),new THREE.Vector3(0,0,4),3.6),/length mismatch/);const a=manifest.assets.find(a=>a.id==='quay-straight-a');
 for(const angle of [0,.7,-2,Math.PI]){const p=new THREE.Group(),q=new THREE.Group(),moving=new THREE.Group(),target=new THREE.Group();p.position.set(4,3,-8);p.rotation.y=angle;p.scale.setScalar(1.3);q.position.set(-4,1,5);q.rotation.y=-.3;q.add(target);p.add(moving);target.rotation.y=angle*.3;target.position.set(2,0,3);snapAnchor(moving,a,'join-left',target,a,'join-right');assert(anchorWorld(moving,a,'join-left').distanceTo(anchorWorld(target,a,'join-right'))<1e-8);const normal=(object,name)=>new THREE.Vector3(...a.anchors.find(x=>x.name===name).normal).transformDirection(object.matrixWorld);assert(normal(moving,'join-left').dot(normal(target,'join-right'))<-.999999);}
}finally{await fs.unlink(temp);}
report.files=cache.size;report.result='pass';await fs.writeFile(path.join(root,'evidence/validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({result:'pass',assets:report.assets.length,files:cache.size,checks:report.checks}));
