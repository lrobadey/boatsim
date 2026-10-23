import * as THREE from 'three';
import { ShipPhysics } from '../../src/ship/physics';
import { Crew } from '../../src/ship/crew';
import { CrewRowing } from '../../src/ship/crew/crewRowing';
import { SailingSystem } from '../../src/ship/sailing';
import { Wind } from '../../src/world/wind';
import { WaveField } from '../../src/world/waves';
import type { Terrain } from '../../src/world/terrain';
import { AFT_RIG, HYDRO, makeDesign } from './design';

export type Wrench={force:THREE.Vector3;torque:THREE.Vector3;ms:number;calls:number};
export const STAGES=['water','rowing','rudders','main sail','aft sail','windage','test drive','mooring','ground','boundary'] as const;
export class Trial {
  readonly design=makeDesign();
  readonly crew=new Crew();
  readonly wind=new Wind(3);
  readonly waves:WaveField;
  readonly ship:ShipPhysics;
  readonly aft=new SailingSystem(AFT_RIG,this.design.aero);
  readonly ledger:Record<string,Wrench>={};
  private readonly recordLedger:Record<string,Wrench>={};
  rowingEnabled=true;
  handsPerOar=3;
  auxiliaryKN=0;
  sail=1;
  headingHold=true;
  targetHeading=0;
  helm=0;
  paused=false;
  timeScale=1;
  readonly history:Record<string,number>[]=[];
  forceClosure=0;
  physicsMs=0;
  stepCount=0;
  maxHeel=0;
  private sinceSample=0;
  private desiredOrder=3;
  private recordClock=0;
  private f=new THREE.Vector3();
  private t=new THREE.Vector3();
  private beforeV=new THREE.Vector3();
  private dv=new THREE.Vector3();
  private afterF=new THREE.Vector3();
  private accountedForce=new THREE.Vector3();
  private tmpQ=new THREE.Quaternion();

  constructor() {
    this.wind.baseSpeed=8;this.wind.update(0);
    this.waves=new WaveField(this.wind,11);
    // Deliberately calm sea: the game's CPU wave field has no components. Wind remains live.
    this.waves.waves.length=0;
    const terrain={heightAt:()=>-100,normalAt:(_x:number,_z:number,o:THREE.Vector3)=>o.set(0,1,0)} as unknown as Terrain;
    this.ship=new ShipPhysics(this.waves,this.wind,terrain,this.crew,this.design);
    for(const name of STAGES) {
      this.ledger[name]={force:new THREE.Vector3(),torque:new THREE.Vector3(),ms:0,calls:0};
      this.recordLedger[name]={force:new THREE.Vector3(),torque:new THREE.Vector3(),ms:0,calls:0};
    }
    // Dev-only hooks measure the real solver's wrenches. Shared game source stays unchanged.
    type Internals={torque:THREE.Vector3;hydrostatics:(...args:any[])=>void;rudders:(...args:any[])=>void;
      windage:(...args:any[])=>void;ground:(...args:any[])=>void;boundary:(...args:any[])=>void};
    const body=this.ship as unknown as Internals;
    const wrap=(name:string,fn:(...args:any[])=>void)=>(...args:any[])=>{
      const beforeF=this.ship.pendingForce.clone(),beforeT=body.torque.clone(),start=performance.now();
      fn(...args);
      const df=beforeF.negate().add(this.ship.pendingForce),dt=beforeT.negate().add(body.torque);
      const l=this.ledger[name];l.force.add(df);l.torque.add(dt);
      this.accountedForce.add(df);this.recordLedger[name].force.add(df);this.recordLedger[name].torque.add(dt);
      l.ms+=performance.now()-start;l.calls++;
    };
    for(const [key,name] of [['hydrostatics','water'],['rudders','rudders'],['ground','ground'],['boundary','boundary']] as const)
      body[key]=wrap(name,body[key].bind(this.ship));
    const windage=wrap('windage',body.windage.bind(this.ship));
    const aftStep=wrap('aft sail',()=>{
      this.f.set(0,0,0);this.t.set(0,0,0);
      this.aft.step(1/120,this.ship.time,this.ship,this.wind,this.f,this.t);
      this.ship.addForceAtPublic(this.f,this.ship.pos);this.ship.addTorquePublic(this.t);
    });
    const testDrive=wrap('test drive',()=>{
      if(!this.auxiliaryKN)return;
      this.f.set(0,0,-this.auxiliaryKN*500).applyQuaternion(this.ship.quat);
      for(const side of [-1,1])this.ship.addForceAtPublic(this.f,this.ship.toWorld(this.t.set(side*8.5,0,28),this.t));
    });
    body.windage=(...args:any[])=>{windage(...args);aftStep();testDrive();};
    const rowStep=this.ship.rowing.step.bind(this.ship.rowing);
    this.ship.rowing.step=wrap('rowing',(...args:any[])=>{
      if(this.rowingEnabled)rowStep(...args as Parameters<typeof rowStep>);
      else { const tel=this.ship.rowing.telemetry;for(const key of Object.keys(tel)) (tel as unknown as Record<string,number>)[key]=0; }
    });
    this.ship.sailing.step=wrap('main sail',this.ship.sailing.step.bind(this.ship.sailing));
    this.ship.mooring.step=wrap('mooring',this.ship.mooring.step.bind(this.ship.mooring));
    this.handsPerOar=1;this.setHandsPerOar(3);this.reset();
  }
  setHandsPerOar(n:number) {
    n=Math.max(1,Math.min(5,Math.round(n)));
    const p=this.design.oars.crew!,ratio=n/this.handsPerOar;
    // An explicit grouped motor approximation. The blade, joint balance, water interaction,
    // coordination and physiology remain the real CrewRowing implementation, one agent per loom.
    p.F0*=ratio;p.CP*=ratio;p.Wp*=ratio;p.servoF*=ratio;
    p.orders.forEach(o=>o.P*=ratio);
    if(this.ship.rowing instanceof CrewRowing)for(const h of this.ship.rowing.hands)h.Wbal*=ratio;
    this.handsPerOar=n;
  }
  reset() {
    (this.wind as unknown as {t:number}).t=0;
    this.wind.update(0);
    this.targetHeading=this.wind.from+Math.PI*.6;
    this.ship.time=0;this.ship.place(0,0,this.targetHeading);this.ship.heading=this.targetHeading;
    this.aft.reset();this.ship.pos.y=this.ship.cg.y;
    this.ship.sailSet=this.sail;this.ship.sailTarget=this.sail;
    this.aft.current.deployment=this.sail;this.aft.deploymentTarget=this.sail;
    this.crew.setOrder(this.desiredOrder);this.helm=0;this.ship.helm=0;
    this.maxHeel=0;this.forceClosure=0;this.history.length=0;this.recordClock=0;this.sinceSample=0;
    for(const l of Object.values(this.recordLedger)){l.force.set(0,0,0);l.torque.set(0,0,0);}
    this.clearLedger();
  }
  setOrder(i:number) {this.desiredOrder=i;this.crew.setOrder(i);}
  clearLedger() {for(const l of Object.values(this.ledger)){l.force.set(0,0,0);l.torque.set(0,0,0);l.ms=0;l.calls=0;}this.physicsMs=0;this.stepCount=0;}
  step() {
    const dt=1/120,s=this.ship,start=performance.now();
    // sampleAt uses absolute ship time, keeping the game's wind and the ship on one clock after resets.
    this.wind.update(dt);
    this.ship.sailTarget=this.sail;this.aft.deploymentTarget=this.sail;
    const err=Math.atan2(Math.sin(this.targetHeading-s.heading),Math.cos(this.targetHeading-s.heading));
    const yawRate=-s.angVel.y;
    // Optional heading hold only commands the existing helm and differential crew allocation.
    s.helm=this.headingHold?THREE.MathUtils.clamp(1.6*err-8*yawRate,-1,1):this.helm;
    this.accountedForce.set(0,-s.mass*9.81,0);
    this.beforeV.copy(s.vel);s.step(dt);
    this.dv.copy(s.vel).sub(this.beforeV).multiplyScalar((s.mass+s.payloadMass)/dt);
    this.afterF.copy(s.pendingForce);this.forceClosure=Math.max(this.forceClosure,
      this.dv.sub(this.accountedForce).length(),this.afterF.sub(this.accountedForce).length());
    this.physicsMs+=performance.now()-start;this.stepCount++;
    this.maxHeel=Math.max(this.maxHeel,Math.abs(s.heel));
    this.sinceSample+=dt;
    if(this.sinceSample>=.25-1e-8) {
      const row:Record<string,number>=this.sample(),steps=Math.round(this.sinceSample/dt);
      row.forceWindowSeconds=this.sinceSample;
      for(const [name,l] of Object.entries(this.recordLedger)) {
        const key=name.replaceAll(' ','_');row[`${key}_FxN`]=l.force.x/steps;row[`${key}_FyN`]=l.force.y/steps;
        row[`${key}_FzN`]=l.force.z/steps;row[`${key}_yawNm`]=-l.torque.y/steps;l.force.set(0,0,0);l.torque.set(0,0,0);
      }
      this.sinceSample=0;this.history.push(row);if(this.history.length>14400)this.history.shift();
    }
    if(!Number.isFinite(s.pos.lengthSq()+s.vel.lengthSq()+s.angVel.lengthSq()))throw new Error('Non-finite physical state');
  }
  sample() {
    const s=this.ship, inv=this.tmpQ.copy(s.quat).invert(),v=s.vel.clone().applyQuaternion(inv);
    const w=s.angVel.clone().applyQuaternion(inv),row=this.ship.rowing.telemetry;
    const inertia=s.inertia;
    const forces:Record<string,number>={},steps=Math.max(1,this.stepCount);
    for(const [name,l] of Object.entries(this.ledger)) {
      const key=name.replaceAll(' ','_');
      forces[`${key}_FxN`]=l.force.x/steps;forces[`${key}_FyN`]=l.force.y/steps;forces[`${key}_FzN`]=l.force.z/steps;
      forces[`${key}_yawNm`]=-l.torque.y/steps;
    }
    return {t:s.time,x:s.pos.x,y:s.pos.y,z:s.pos.z,speed:s.speed,sog:Math.hypot(s.vel.x,s.vel.z),sway:v.x,
      heading:s.heading,heel:s.heel,pitch:s.pitch,helm:s.helm,heaveVelocity:s.vel.y,yawRate:-s.angVel.y,
      sailN:s.sailForce+this.aft.telemetry.forwardForce,oarN:s.oarThrust,
      rowerW:row.positivePower,hullW:('hullPower' in row?Number(row.hullPower):0),
      kineticJ:.5*s.mass*s.vel.lengthSq()+.5*(inertia.x*w.x*w.x+inertia.y*w.y*w.y+inertia.z*w.z*w.z),
      windMps:this.wind.speed,windFrom:this.wind.from,auxiliaryThrustN:this.auxiliaryKN*1000,auxiliaryHullW:this.auxiliaryKN*1000*s.speed,forceClosureN:this.forceClosure,forceWindowSeconds:this.stepCount/120,...forces};
  }
  snapshot() {
    const n=Math.max(1,this.stepCount);
    return {schema:'thalassa-trial-v1',generatedAt:new Date().toISOString(),sample:this.sample(),
      settings:{windBase:this.wind.baseSpeed,windBaseFrom:this.wind.baseFrom,sail:this.sail,order:this.crew.orderIndex,
        rowingEnabled:this.rowingEnabled,handsPerOar:this.handsPerOar,auxiliaryKN:this.auxiliaryKN,rudderAreaEach:this.design.rudder.area,headingHold:this.headingHold,targetHeading:this.targetHeading,helm:this.helm},
      geometry:{length:82,hullBeam:6.6,hullCentres:[-8.5,8.5],columns:this.ship.columns.length,oars:this.ship.rowing.slots.length,
        mainSailArea:this.design.rig.area,aftSailArea:AFT_RIG.area},
      body:{massKg:this.ship.mass,cg:this.ship.cg.toArray(),inertia:this.ship.inertia.toArray(),hydrostaticReference:HYDRO},
      ledger:Object.fromEntries(Object.entries(this.ledger).map(([name,l])=>[name,{forceN:l.force.toArray().map(x=>x/n),torqueNm:l.torque.toArray().map(x=>x/n),msPerStep:l.ms/n}])),
      performance:{physicsMsPerStep:this.physicsMs/n,steps:this.stepCount},
      assumptions:['Rigid twin hulls, calm flat water, open wind, deep seabed.','Displacement-derived mass; assumed CG 2.5m above waterline and column-derived inertia.',
        `Existing CrewRowing, ${this.handsPerOar} hands per oar as a grouped motor approximation; long-oar inertia and inboard handles are estimates.`,
        'Two independent existing SailingSystems; no rig shadowing or catamaran wave interference.','Windage area and rudder area are estimates. No structure, damage, interiors or navigation world.',
        'Optional test drive applies a specified forward force at both hulls near the stern; no paddle or animal mechanism is simulated.']};
  }
}
