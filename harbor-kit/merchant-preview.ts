import * as THREE from 'three';
import {ShipPhysics} from '../src/ship/physics';
import {Crew} from '../src/ship/crew';
import {Wind} from '../src/world/wind';
import {WaveField} from '../src/world/waves';
import type {Terrain} from '../src/world/terrain';
import type {Berth} from '../src/world/harbour';
import {MERCHANT} from '../src/ship/design';
import {shared} from '../src/gfx/shared';
import {createMerchant} from './runtime/merchant';
import type {HarborKit} from './runtime/kit';

export async function merchantPreview(kit:HarborKit){
 const result=await createMerchant(kit),wind=new Wind(0),waves=new WaveField(wind),crew=new Crew();
 waves.waves.length=0;wind.baseSpeed=5;wind.update(0);
 const terrain={heightAt:()=>-30,normalAt:(_x:number,_z:number,o:THREE.Vector3)=>o.set(0,1,0)} as unknown as Terrain;
 const physics=new ShipPhysics(waves,wind,terrain,crew,MERCHANT);physics.place(0,0,0);
 shared.uFogDensity.value=0;
 const white=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);white.needsUpdate=true;
 shared.uAOTex.value=white;
 let t=0,accumulator=0,docked=false;
 return {...result,physics,crew,dock(berth:Berth){
  wind.baseSpeed=0;wind.update(0);const pose=physics.mooring.berthPose(berth,{x:0,z:0});
  physics.place(pose.x,pose.z,Math.atan2(berth.ax,-berth.az));physics.mooring.restoreDocked(berth,true);physics.rowing.setShipped(-1,true);physics.rowing.setShipped(1,true);docked=true;
 },update(dt:number){
  // Fixed inspection stand: render actual joints while keeping the model at its authored origin.
  accumulator+=dt;const steps=Math.min(8,Math.floor(accumulator*120));accumulator-=steps/120;
  for(let i=0;i<steps;i++){wind.update(1/120);physics.step(1/120);t+=1/120;}
  shared.uTime.value=t;
  if(docked){result.model.group.quaternion.copy(physics.quat);result.model.group.position.copy(physics.pos).sub(physics.cg.clone().applyQuaternion(physics.quat));}
  result.model.group.updateMatrixWorld(true);result.model.update(physics,crew,0,t);
 },readback(){return {...result.model.sailingVisualState(),hatches:result.model.hatchRects,oars:result.model.bladeWorld.map(v=>v.toArray()),length:MERCHANT.hull.length};}};
}
