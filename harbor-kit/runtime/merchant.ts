/** Compatible vessel assembly: authored static shell, original game simulation and moving visual parts. */
import * as THREE from 'three';
import {MerchantModel} from '../../src/ship/merchantModel';
import {MERCHANT} from '../../src/ship/design';
import {patchMaterial} from '../../src/gfx/shared';
import type {ModelKit} from '../../src/gfx/models';
import type {HarborKit} from './kit';

export async function createMerchant(kit:HarborKit){
 const shell=await kit.create('merchant-shell');
 let wood:THREE.MeshStandardMaterial|undefined;
 shell.traverse(o=>{if(o instanceof THREE.Mesh){const materials=(Array.isArray(o.material)?o.material:[o.material]).map(m=>{
  const clone=m.clone() as THREE.MeshStandardMaterial;
  if(clone.name==='wood')wood=clone;
  return patchMaterial(clone,undefined,'ormos_'+clone.name);
 });o.material=Array.isArray(o.material)?materials:materials[0];}});
 if(!wood?.map||!wood.normalMap||!wood.roughnessMap)throw Error('Merchant shell requires complete wood PBR maps');
 // The merchant uses runtime crew, so this constructor never requests static figures.
 const unused=()=>{throw Error('Merchant requested an unexpected static model');};
 const models:ModelKit={objects:new Map(),get:unused,geometry:unused,parts:unused,material:unused,clips:unused};
 const model=new MerchantModel({color:wood.map,normal:wood.normalMap,roughness:wood.roughnessMap},MERCHANT.oars.slots(),models,MERCHANT);
 model.setAuthoredShell(shell);
 const fabricAsset=await kit.create('linen-canopy');
 let linen:THREE.MeshStandardMaterial|undefined;
 fabricAsset.traverse(o=>{if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.name==='cloth')linen=m as THREE.MeshStandardMaterial;});
 if(!linen?.map||!linen.normalMap||!linen.roughnessMap)throw Error('Merchant requires complete linen PBR maps');
 const repeat=(texture:THREE.Texture)=>{const copy=texture.clone();copy.repeat.set(MERCHANT.rig.width/2,MERCHANT.rig.height/2);copy.needsUpdate=true;return copy;};
 model.setSailSurface({color:repeat(linen.map),normal:repeat(linen.normalMap),roughness:repeat(linen.roughnessMap)});
 return {model,shell};
}
