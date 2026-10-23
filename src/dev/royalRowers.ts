import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROYAL_OAR_PROFILE } from './royalOarProfile';
import { patchMaterial } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { PADDLE_VARIANTS, type PaddleGeometry } from './paddleVariants';
import { createPaddleFrame, paddleFrame } from './paddleKinematics';

/** Rigid oars in fixed rowlocks, worked by two articulated mechanical arms. */
export function buildRoyalRowers() {
  const v=PADDLE_VARIANTS.basileus, g={...v.geometry,inertia:0,machineryMass:0} as PaddleGeometry;
  const group=new THREE.Group(), mats=[v.wood,v.blade,v.accent,0xa8864b].map((color,i)=>patchMaterial(new THREE.MeshStandardMaterial({color,roughness:.68,metalness:i===3?.65:0})));
  let mass=0,movingMass=0;
  function volume(geo:THREE.BufferGeometry,m:number,count=1,moving=false) {
    const p=geo.getAttribute('position'),ix=geo.index,a=new THREE.Vector3(),b=a.clone(),c=a.clone();let vol=0;
    for(let i=0;i<(ix?.count??p.count);i+=3){a.fromBufferAttribute(p,ix?ix.getX(i):i);b.fromBufferAttribute(p,ix?ix.getX(i+1):i+1);c.fromBufferAttribute(p,ix?ix.getX(i+2):i+2);vol+=a.dot(b.cross(c))/6;}
    const kg=Math.abs(vol)*(m===3?8700:650)*count;mass+=kg;if(moving)movingMass+=kg;
  }
  function mesh(geo:THREE.BufferGeometry,m:number,parent:THREE.Object3D,pos:THREE.Vector3,moving=false) {
    volume(geo,m,1,moving);const o=new THREE.Mesh(geo,mats[m]);o.position.copy(pos);o.castShadow=o.receiveShadow=true;o.layers.enable(LAYER_REFRACT);parent.add(o);return o;
  }
  const V=(x:number,y:number,z:number)=>new THREE.Vector3(x,y,z);
  function rod(parent:THREE.Object3D,a:THREE.Vector3,b:THREE.Vector3,r:number,m:number,moving=false){
    const d=b.clone().sub(a),o=mesh(new THREE.CylinderGeometry(r,r,d.length(),10),m,parent,a.clone().add(b).multiplyScalar(.5),moving);
    o.quaternion.setFromUnitVectors(V(0,1,0),d.normalize());return o;
  }
  function dynamicRod(parent:THREE.Object3D,length:number,r:number,m:number){
    const o=mesh(new THREE.CylinderGeometry(r,r,length,10),m,parent,V(0,0,0),true);return o;
  }
  const frame=createPaddleFrame(),matrix=new THREE.Matrix4(),q=new THREE.Quaternion(),one=V(1,1,1);
  const blades:THREE.InstancedMesh[]=[];
  function sleeve(outer:number,inner:number,length:number) {
    const shape=new THREE.Shape();shape.absarc(0,0,outer,0,2*Math.PI,false);
    const hole=new THREE.Path();hole.absarc(0,0,inner,0,2*Math.PI,true);shape.holes.push(hole);
    const geo=new THREE.ExtrudeGeometry(shape,{depth:length,bevelEnabled:false,curveSegments:16});geo.translate(0,0,-length/2);geo.rotateX(Math.PI/2);return geo;
  }
  function hollowSphere(radius:number,thickness:number) {
    const outer=new THREE.SphereGeometry(radius,16,10),inner=new THREE.SphereGeometry(radius-thickness,16,10),idx=inner.index!;
    for(let i=0;i<idx.count;i+=3){const a=idx.getX(i);idx.setX(i,idx.getX(i+2));idx.setX(i+2,a);}
    const normal=inner.getAttribute('normal');for(let i=0;i<normal.count;i++)normal.setXYZ(i,-normal.getX(i),-normal.getY(i),-normal.getZ(i));
    const geo=mergeGeometries([outer,inner]);outer.dispose();inner.dispose();return geo;
  }
  const stations:{side:number;i:number;oar:THREE.Group;arms:THREE.Mesh[];elbows:THREE.Mesh[];body:THREE.Group;crank:THREE.Group}[]=[];
  for(const side of [-1,1]){
    const outline=new THREE.Shape();ROYAL_OAR_PROFILE.forEach(([x,y],i)=>i?outline.lineTo(x*g.width,y*g.bladeHeight):outline.moveTo(x*g.width,y*g.bladeHeight));outline.closePath();
    const bodyGeo=new THREE.ExtrudeGeometry(outline,{depth:.18,bevelEnabled:true,bevelSize:.035,bevelThickness:.025,bevelSegments:1,steps:1});bodyGeo.translate(0,0,-.09);
    const inset=new THREE.ExtrudeGeometry(outline,{depth:.014,bevelEnabled:false});inset.scale(.52,.82,1);inset.translate(0,0,.118);
    const backInset=inset.clone();backInset.translate(0,0,-.25);
    const spine=new THREE.BoxGeometry(.085,g.bladeHeight*.78,.035).toNonIndexed();spine.translate(0,-.08,.13);
    volume(bodyGeo,1,g.blades,true);volume(inset,2,g.blades*2,true);volume(spine,3,g.blades,true);
    const bladeGeo=mergeGeometries([bodyGeo,inset,backInset,spine],true);bodyGeo.dispose();inset.dispose();backInset.dispose();spine.dispose();
    const bank=new THREE.InstancedMesh(bladeGeo,[mats[1],mats[2],mats[2],mats[3]],g.blades);bank.name=`Paddle_${side<0?'port':'starboard'}_blades`;
    bank.castShadow=bank.receiveShadow=true;bank.frustumCulled=false;bank.layers.enable(LAYER_REFRACT);group.add(bank);blades.push(bank);
    rod(group,V(side*8.2,5.8,-31),V(side*8.2,5.8,31),.22,0);
    for(let i=0;i<g.blades;i++){
      const z=(i-(g.blades-1)/2)*8;
      rod(group,V(side*8.1,5.6,z),V(side*11.5,5.6,z),.25,0);
      rod(group,V(side*10,2.5,z),V(side*11.5,5.6,z),.22,0);
      rod(group,V(side*g.rowlockX!,4.2,z),V(side*g.rowlockX!,g.y+.5,z),.25,0);
      mesh(sleeve(.32,.25,.25),3,group,V(side*g.rowlockX!,g.y,z));
      const bearing=mesh(new THREE.TorusGeometry(.46,.065,8,24),3,group,V(side*g.rowlockX!,g.y,z));bearing.rotation.y=Math.PI/2;
      const oar=new THREE.Group();oar.name=`Royal_oar_${side}_${i}`;group.add(oar);
      // Oar-local +Y points outboard, +Z is blade normal. The loom passes through a fixed rowlock.
      const loom=mesh(new THREE.CylinderGeometry(.14,.24,g.inboard!+g.outboard!+.7,12),0,oar,V(0,(g.outboard!+.7-g.inboard!)/2,0),true);
      loom.name=`Royal_oar_${side}_${i}_loom`;
      for(const h of [-.4,0,.4])mesh(sleeve(.27,.235,.12),3,oar,V(0,h,0),true);
      // A bronze shoulder collar and broad cross-grain blade binding.
      mesh(sleeve(.22,.17,.22),3,oar,V(0,g.outboard!-g.bladeHeight/2,0),true);
      const body=new THREE.Group();body.position.set(side*6.7,5.6,z);group.add(body);
      mesh(new THREE.BoxGeometry(.9,1.8,.9),2,body,V(0,1.6,0));
      rod(body,V(0,0,0),V(0,2.5,0),.23,0);
      mesh(hollowSphere(.43,.025),3,body,V(0,2.9,0));
      for(const dz of [-.47,.47])mesh(hollowSphere(.32,.025),3,body,V(0,2.45,dz));
      // Thin bronze chest ribs over the timber frame, rather than a solid cast torso.
      for(const y of [1.15,1.55,1.95])mesh(new THREE.BoxGeometry(.018,.13,.94),3,body,V(side*.47,y,0));
      for(const dz of [-.29,.29])mesh(new THREE.BoxGeometry(.025,.4,.18),3,body,V(side*.36,2.7,dz));
      mesh(new THREE.BoxGeometry(.13,.4,.9),2,body,V(0,3.3,0));
      for(const dz of [-.45,.45])rod(body,V(0,.2,dz),V(side*1.1,.2,dz),.18,0);
      const arms:THREE.Mesh[]=[],elbows:THREE.Mesh[]=[];
      for(let arm=0;arm<2;arm++){
        const upper=dynamicRod(group,2,.19,0),fore=dynamicRod(group,2,.15,0);
        upper.name=`Royal_arm_${side}_${i}_${arm}_upper`;fore.name=`Royal_arm_${side}_${i}_${arm}_fore`;arms.push(upper,fore);
        elbows.push(mesh(hollowSphere(.25,.03),3,group,V(0,0,0),true));
      }
      const crank=new THREE.Group();crank.position.set(side*5.9,6.7,z);group.add(crank);
      const disc=mesh(new THREE.CylinderGeometry(.85,.85,.16,24),2,crank,V(0,0,0),true);disc.rotation.z=Math.PI/2;
      rod(crank,V(0,0,0),V(0,.65,0),.12,3,true);
      stations.push({side,i,oar,arms,elbows,body,crank});
    }
  }
  function orient(a:THREE.Vector3,b:THREE.Vector3,o:THREE.Object3D){o.position.copy(a).add(b).multiplyScalar(.5);o.quaternion.setFromUnitVectors(V(0,1,0),b.clone().sub(a).normalize());}
  function animate(angles:number[]){
    for(const s of stations){
      const si=s.side<0?0:1,phase=angles[si]+s.i*2*Math.PI/g.blades;
      paddleFrame(g,angles[si],s.i,frame);
      const p=frame.point.clone(),Y=frame.heightAxis.clone(),Z=frame.normal.clone();p.x*=s.side;Y.x*=s.side;Z.x*=s.side;
      const X=new THREE.Vector3().crossVectors(Y,Z).normalize();matrix.makeBasis(X,Y,Z);q.setFromRotationMatrix(matrix);
      const pivot=V(s.side*g.rowlockX!,g.y,(s.i-(g.blades-1)/2)*8);
      s.oar.position.copy(pivot);s.oar.quaternion.copy(q);
      matrix.compose(p,q,one);blades[si].setMatrixAt(s.i,matrix);
      s.body.rotation.x=.12*Math.sin(phase);s.crank.rotation.x=phase;
      for(let arm=0;arm<2;arm++){
        const grip=pivot.clone().addScaledVector(Y,-g.inboard!+.4*arm);
        const shoulder=V(0,2.5,arm?.42:-.42).applyQuaternion(s.body.quaternion).add(s.body.position);
        const d=grip.clone().sub(shoulder),length=d.length();
        const perp=V(0,0,arm?1:-1).addScaledVector(d,-d.z*(arm?1:-1)/(length*length)).normalize();
        const elbow=shoulder.clone().add(grip).multiplyScalar(.5).addScaledVector(perp,Math.sqrt(Math.max(0,4-length*length/4)));
        orient(shoulder,elbow,s.arms[arm*2]);orient(elbow,grip,s.arms[arm*2+1]);s.elbows[arm].position.copy(elbow);
      }
    }
    blades.forEach(b=>b.instanceMatrix.needsUpdate=true);
  }
  animate([0,0]);
  return{group,rotors:[] as THREE.Group[],capstans:[[],[]] as THREE.Group[][],animate,
    engineering:{rotorMass:movingMass/2,rotorInertia:// Eight phased oars: mean squared centre-path derivative, reflected moving mass.
      movingMass/2*(g.outboard!**2*(g.radius**2+.26**2)/2)+4500,visibleMass:mass,machineryMass:mass+12000}};
}
