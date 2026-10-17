import '../../scripts/register-ts.mjs';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as THREE from 'three';
const {MERCHANT:d}=await import('../../src/ship/design.ts');
const {Mooring}=await import('../../src/ship/mooring.ts');
const mooring=new Mooring(d);mooring.restoreDocked({id:0,name:'acceptance',cx:0,cz:0,ax:1,az:0,nx:0,nz:1,length:24,top:2.1,face:0,bollards:[-6,0,6].map(x=>new THREE.Vector3(x,2.1,0))},true);
const manifest=JSON.parse(await fs.readFile(new URL('../assets/manifest.json',import.meta.url)));
const plank=manifest.assets.find(a=>a.id==='merchant-gangplank');
assert.equal(plank.footprint[0],mooring.plank.width);assert.equal(plank.footprint[1],mooring.plank.length);
assert.equal(new THREE.Vector3(...plank.anchors[0].position).distanceTo(new THREE.Vector3(...plank.anchors[1].position)),mooring.plank.length);
const contract=JSON.parse(await fs.readFile(new URL('../contracts/game-merchant.json',import.meta.url)));
for(const source of contract.sources){const bytes=await fs.readFile(new URL('../../'+source.file,import.meta.url));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),source.sha256,'stale game contract: '+source.file);}
const bytes=await fs.readFile(new URL('../build/raw/merchant-shell.glb',import.meta.url)),len=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+len)),bin=bytes.subarray(28+len);
function read(index){const a=doc.accessors[index],v=doc.bufferViews[a.bufferView],n={SCALAR:1,VEC3:3}[a.type],size={5123:2,5125:4,5126:4}[a.componentType],method={5123:'getUint16',5125:'getUint32',5126:'getFloat32'}[a.componentType],dv=new DataView(bin.buffer,bin.byteOffset,bin.byteLength);return Array.from({length:a.count},(_,i)=>Array.from({length:n},(_,j)=>dv[method]((v.byteOffset??0)+(a.byteOffset??0)+i*(v.byteStride??n*size)+j*size,true)));}
let maxHullError=0,maxDeckError=0,hullVertices=0,deckTriangles=0;
function walk(index,parent){const node=doc.nodes[index],m=new THREE.Matrix4().compose(new THREE.Vector3(...(node.translation??[0,0,0])),new THREE.Quaternion(...(node.rotation??[0,0,0,1])),new THREE.Vector3(...(node.scale??[1,1,1]))),world=parent.clone().multiply(node.matrix?new THREE.Matrix4().fromArray(node.matrix):m);
 if(node.mesh!==undefined){const mesh=doc.meshes[node.mesh];for(const primitive of mesh.primitives){const p=read(primitive.attributes.POSITION).map(v=>new THREE.Vector3(...v).applyMatrix4(world));
  if(node.name.includes('_hull_wood'))for(const v of p){const s=Math.max(0,Math.min(1,v.z/d.hull.length+.5)),out={x:0,y:0};let lo=0,hi=1;for(let k=0;k<32;k++){const t=(lo+hi)/2;d.hull.section(s,t,out);if(out.y<v.y)lo=t;else hi=t;}d.hull.section(s,(lo+hi)/2,out);maxHullError=Math.max(maxHullError,Math.hypot(Math.abs(v.x)-out.x,v.y-out.y));hullVertices++;}
  if(node.name.includes('_deck_wood')){for(const v of p){const s=v.z/d.hull.length+.5;maxDeckError=Math.max(maxDeckError,Math.abs(v.y-d.deck.deckY(s)));}
   const indices=read(primitive.indices).flat();for(let i=0;i<indices.length;i+=3){const a=p[indices[i]],b=p[indices[i+1]],c=p[indices[i+2]],normal=b.clone().sub(a).cross(c.clone().sub(a));assert(normal.length()>1e-10,'degenerate deck triangle');assert(normal.y>0,'inverted deck');const center=a.clone().add(b).add(c).divideScalar(3),s=center.z/d.hull.length+.5;assert(!d.cargo.hatches.some(h=>s>h.s0+1e-6&&s<h.s1-1e-6&&Math.abs(center.x)<d.cargo.hatchHalfWidth-1e-6),'hatch obstructed by deck');deckTriangles++;}
  }
 }}for(const child of node.children??[])walk(child,world);
}
for(const root of doc.scenes[doc.scene??0].nodes)walk(root,new THREE.Matrix4());
assert(hullVertices>10000);assert(deckTriangles>1000);assert(maxHullError<.0001,'hull differs from game offsets');assert(maxDeckError<.0001,'deck differs from game height');
const report={result:'pass',hullVertices,deckTriangles,maxHullErrorMetres:maxHullError,maxDeckErrorMetres:maxDeckError,checks:['current game source hashes','outer hull matches game offsets within 0.1 mm','deck height within 0.1 mm','upward deck winding','no degenerate deck triangles','open hatch rectangles','boarding plank length and width match the live mooring model'],scope:'geometry compatibility; full in-game navigation acceptance remains separate'};
await fs.writeFile(new URL('../evidence/merchant-compatibility.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
