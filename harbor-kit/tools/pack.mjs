/** Lossless geometry compression + shared external textures for the kit bundle.
 * Raw Blender GLBs remain in build/raw; runtime assets are relocatable together.
 * Every encoded buffer is decoded and compared before a file is published.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { MeshoptDecoder } from 'meshoptimizer/decoder';

const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rawDir=path.join(root,'build/raw'),outDir=path.join(root,'assets/models'),texDir=path.join(root,'assets/textures');
await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready,fs.mkdir(outDir,{recursive:true}),fs.mkdir(texDir,{recursive:true})]);
const manifest=JSON.parse(await fs.readFile(path.join(root,'assets/manifest.json'),'utf8'));
const files=[...new Set(manifest.assets.flatMap(a=>[...a.lods.map(l=>path.basename(l.file)),...a.collision.filter(c=>c.type==='mesh').map(c=>path.basename(c.file))]))];
const sizes={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT4:16},bytes={5120:1,5121:1,5122:2,5123:2,5125:4,5126:4};
const report={encoder:'meshoptimizer',losslessGeometry:true,files:[],textures:{}};
const materialLibrary={};
for(const file of files){
 const raw=await fs.readFile(path.join(rawDir,file));
 if(raw.readUInt32LE(0)!==0x46546c67)throw Error('Invalid GLB '+file);
 const jsonLength=raw.readUInt32LE(12),doc=JSON.parse(raw.subarray(20,20+jsonLength).toString());
 const bin=raw.subarray(28+jsonLength);
 for(const node of doc.nodes??[])if(node.extras?.anchorName)node.name='anchor_'+node.extras.anchorName;
 const imageViews=new Set();
 for(const img of doc.images??[]){
  if(img.bufferView===undefined)continue;
  const v=doc.bufferViews[img.bufferView];let data=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
  let ext=img.mimeType==='image/png'?'png':'jpg';
  // Preserve original lossless normal maps instead of their JPEG export copy.
  const stem=path.parse(img.name??'').name;
  if(stem.endsWith('_normal')){
   try{data=await fs.readFile(path.join(root,'blender/textures',stem+'.png'));ext='png';img.mimeType='image/png';}catch{}
  }
  const hash=crypto.createHash('sha256').update(data).digest('hex');
  const name=`${stem.replace(/[^a-zA-Z0-9_-]/g,'_')||'texture'}-${hash.slice(0,12)}.${ext}`;
  await fs.writeFile(path.join(texDir,name),data);report.textures[name]={bytes:data.length,sha256:hash};
  imageViews.add(img.bufferView);delete img.bufferView;img.uri='../textures/'+name;
 }
 for(const m of doc.materials??[]){
  const texture=slot=>slot?{uri:doc.images[doc.textures[slot.index].source].uri.replace('../',''),texCoord:slot.texCoord??0,scale:slot.scale??1,strength:slot.strength??1}:null;
  const p=m.pbrMetallicRoughness??{};
  const entry={name:m.name??'unnamed',baseColor:p.baseColorFactor??[1,1,1,1],metalness:p.metallicFactor??1,roughness:p.roughnessFactor??1,doubleSided:m.doubleSided??false,alphaMode:m.alphaMode??'OPAQUE',maps:{color:texture(p.baseColorTexture),metallicRoughness:texture(p.metallicRoughnessTexture),normal:texture(m.normalTexture),occlusion:texture(m.occlusionTexture)}};
  if(materialLibrary[entry.name]&&JSON.stringify(materialLibrary[entry.name])!==JSON.stringify(entry))throw Error('Material name collision: '+entry.name);
  materialLibrary[entry.name]=entry;
 }
 const chunks=[];let offset=0,virtual=0;
 const append=data=>{const at=offset;chunks.push(data);offset+=data.length;const padding=(4-offset%4)%4;if(padding){chunks.push(Buffer.alloc(padding));offset+=padding;}return at;};
 let buffersVerified=0;
 for(let i=0;i<doc.bufferViews.length;i++){
  const v=doc.bufferViews[i];const source=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
  const accessors=doc.accessors.filter(a=>a.bufferView===i);
  if(imageViews.has(i)&&!accessors.length){v.buffer=1;v.byteOffset=virtual;virtual+=v.byteLength;virtual+=((4-virtual%4)%4);continue;}
  if(!accessors.length){v.buffer=0;v.byteOffset=append(source);continue;}
  const first=accessors[0];
  const stride=v.byteStride??sizes[first.type]*bytes[first.componentType];
  if(!stride||source.length%stride)throw Error('Unsupported buffer layout '+file+':'+i);
  const count=source.length/stride,mode=v.target===34963?'TRIANGLES':'ATTRIBUTES';
  const encoded=MeshoptEncoder.encodeGltfBuffer(source,count,stride,mode,0);
  const decoded=new Uint8Array(source.length);MeshoptDecoder.decodeGltfBuffer(decoded,count,stride,encoded,mode,'NONE');
  if(mode==='ATTRIBUTES'){
   if(!Buffer.from(decoded).equals(source))throw Error('Attribute round-trip mismatch '+file+':'+i);
  }else{
   // The codec may rotate each triangle while preserving its oriented winding.
   const read=(data,k)=>stride===2?new DataView(data.buffer,data.byteOffset,data.byteLength).getUint16(k*2,true):new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(k*4,true);
   for(let t=0;t<count;t+=3){
    const a=[0,1,2].map(k=>read(source,t+k)),b=[0,1,2].map(k=>read(decoded,t+k));
    if(![0,1,2].some(s=>a.every((x,k)=>x===b[(k+s)%3])))throw Error('Index round-trip mismatch '+file+':'+i);
   }
  }
  const at=append(Buffer.from(encoded));v.buffer=1;v.byteOffset=virtual;virtual+=v.byteLength;virtual+=((4-virtual%4)%4);
  v.extensions={...v.extensions,EXT_meshopt_compression:{buffer:0,byteOffset:at,byteLength:encoded.length,byteStride:stride,count,mode,filter:'NONE'}};
  buffersVerified++;
 }
 doc.buffers=[{byteLength:offset},{byteLength:virtual,extensions:{EXT_meshopt_compression:{fallback:true}}}];
 doc.extensionsUsed=[...new Set([...(doc.extensionsUsed??[]),'EXT_meshopt_compression'])];
 doc.extensionsRequired=[...new Set([...(doc.extensionsRequired??[]),'EXT_meshopt_compression'])];
 const json=Buffer.from(JSON.stringify(doc)),jp=Buffer.alloc((4-json.length%4)%4,32),binary=Buffer.concat(chunks);
 const head=Buffer.alloc(20);head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(28+json.length+jp.length+binary.length,8);head.writeUInt32LE(json.length+jp.length,12);head.writeUInt32LE(0x4e4f534a,16);
 const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length,0);bh.writeUInt32LE(0x004e4942,4);
 const result=Buffer.concat([head,json,jp,bh,binary]);await fs.writeFile(path.join(outDir,file),result);
 report.files.push({file,rawBytes:raw.length,packedBytes:result.length,buffersVerified,sha256:crypto.createHash('sha256').update(result).digest('hex')});
}
for(const a of manifest.assets)for(const lod of a.lods){const r=report.files.find(r=>r.file===path.basename(lod.file));lod.bytes=r.packedBytes;lod.sha256=r.sha256;}
manifest.runtime={compression:'EXT_meshopt_compression',textures:'shared-external',copyTogether:['manifest.json','models/','textures/']};
await fs.writeFile(path.join(root,'assets/materials.json'),JSON.stringify({schemaVersion:1,materials:materialLibrary},null,2)+'\n');
await fs.writeFile(path.join(root,'assets/manifest.json'),JSON.stringify(manifest,null,2)+'\n');
// Keep the served bundle limited to referenced generated textures; preserve superseded files.
const retired=path.join(root,'build/retired-textures');
for(const name of await fs.readdir(texDir))if(/-[a-f0-9]{12}\.(png|jpg)$/.test(name)&&!report.textures[name]){
 await fs.mkdir(retired,{recursive:true});await fs.rename(path.join(texDir,name),path.join(retired,name));
}
report.totals={rawModelBytes:report.files.reduce((n,f)=>n+f.rawBytes,0),packedModelBytes:report.files.reduce((n,f)=>n+f.packedBytes,0),sharedTextureBytes:Object.values(report.textures).reduce((n,t)=>n+t.bytes,0)};
await fs.writeFile(path.join(root,'evidence/packing.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({assets:manifest.assets.length,files:files.length,...report.totals},null,2));
