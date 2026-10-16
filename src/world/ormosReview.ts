import * as THREE from 'three';
import type {Game} from '../game';
import type {WorldGenResult} from './worldgenTypes';
import type {OrmosHarbour} from './ormosHarbour';
import {harborWorld,harborYaw} from './ormosLayout';

/** URL-gated inspection of the real production scene, without reading/writing saved voyages. */
export function installOrmosReview(game:Game,gen:WorldGenResult,art:OrmosHarbour,initial:string){
 const p=gen.sites.pier,top=p.top,mid=(p.berthStart+p.length)/2;
 const world=(x:number,y:number,z:number)=>{const v=harborWorld(p,x,z);return new THREE.Vector3(v.x,y,v.z);};
 const views:Record<string,[number[],number[]]>={
  overview:[[100,48,-mid-20],[0,3,-mid/2+5]],
  approach:[[25,9,-mid-28],[-2,3,-mid+8]],
  berth:[[-15,5,-mid+9],[-3,2,-mid]],
  quay:[[4,3.5,-18],[-8,3,12]],
  court:[[-28,4,4],[-13,3,19]],
  workshop:[[6,3,6],[15,3,18]],
  village:[[4,4,24],[-5,4,38]],
  warehouse:[[-14,3,12],[-14,3,22]],
  boat:[[-19,7,-mid-9],[-6,2,-mid]],
 };
 const panel=document.createElement('div');panel.id='ormos-review';panel.style.cssText='pointer-events:auto;position:fixed;left:12px;top:12px;z-index:99;display:flex;gap:5px;flex-wrap:wrap;max-width:650px;background:#eee6d8e6;padding:8px;color:#302b24;font:12px sans-serif;border-radius:3px;';
 let requestedGeneration=-1;
 const select=(id:string)=>{const v=views[id]??views.overview;game.reviewCamera={position:world(...v[0] as [number,number,number]),target:world(...v[1] as [number,number,number])};panel.dataset.view=id;panel.dataset.ready='false';};
 for(const id of Object.keys(views)){const b=document.createElement('button');b.textContent=id;b.onclick=()=>select(id);panel.append(b);}
 for(const [name,hour] of [['dawn',6.8],['day',12.5],['late',18.2],['night',22]] as const){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{game.clock.timeScale=0;game.clock.hours=hour;game.clock.compute();requestedGeneration=game.sky.environmentTelemetry.generation;panel.dataset.lightingReady='false';game.sky.forceEnvironment();};panel.append(b);}
 for(const [name,x,z] of [['Walk quay',0,4],['Walk market',14,5.3],['Walk warehouse',-14,12]] as const){const b=document.createElement('button');b.textContent=name;b.onclick=()=>{game.reviewCamera=null;game.player.mode='foot';const w=game.player.walker,v=world(x,top,z);w.frame='world';w.pos.copy(v);w.world.copy(v);w.vel.set(0,0,0);w.grounded=true;w.swimming=false;game.player.yaw=harborYaw(p)+Math.PI;game.player.pitch=0;game.hud.setVisible(true);};panel.append(b);}
 const deckButton=document.createElement('button');deckButton.textContent='Walk plank';deckButton.onclick=()=>{const pl=game.ship.mooring.plank;if(!pl)return;game.reviewCamera=null;game.player.mode='foot';game.player.walker.placeOnDeck(pl.deckLocal.clone().add(new THREE.Vector3(-pl.side*.25,0,0)));game.player.yaw=-pl.side*Math.PI/2;game.player.pitch=0;game.hud.setVisible(true);};panel.append(deckButton);
 const helmButton=document.createElement('button');helmButton.textContent='Helm';helmButton.onclick=()=>{game.reviewCamera=null;game.player.mode='helm';game.player.prevShipMode='helm';game.hud.setVisible(true);};panel.append(helmButton);
 const state=document.createElement('script');state.type='application/json';state.id='ormos-review-state';
 document.getElementById('ui')!.append(panel,state);select(initial);game.clock.timeScale=0;game.clock.hours=12.5;game.clock.compute();
 let frames=0;const observe=()=>{frames++;if(game.sky.environmentTelemetry.generation>requestedGeneration)panel.dataset.lightingReady='true';panel.dataset.phase=game.ship.mooring.linePhase;panel.dataset.sailDeployed=String(game.ship.sailing.current.deployment>.99);if(game.reviewCamera && game.camera.position.distanceTo(game.reviewCamera.position)<.001)panel.dataset.ready='true';state.textContent=JSON.stringify({frames,view:panel.dataset.view,hour:game.clock.hours,port:game.harbourLayout.name,pier:{length:p.length,width:p.width,mid},assets:art.kit.stats,gpuMs:game.pipeline.gpuMs,environment:game.sky.environmentTelemetry.generation,merchantShell:game.model.group.getObjectByName('merchant-shell')!==undefined,sail:game.ship.sailing.current,phase:game.ship.mooring.linePhase,lines:game.ship.mooring.lines.length,plank:game.ship.mooring.plank?{length:game.ship.mooring.plank.length,width:game.ship.mooring.plank.width,resting:game.ship.mooring.plank.resting}:null,walker:{frame:game.player.walker.frame,position:game.player.walker.pos.toArray(),grounded:game.player.walker.grounded,swimming:game.player.walker.swimming},market:game.harbourLayout.stall,camera:game.camera.position.toArray(),finite:game.ship.pos.toArray().every(Number.isFinite)});requestAnimationFrame(observe);};
 requestAnimationFrame(observe);
}
