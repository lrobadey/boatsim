import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { PADDLE_VARIANTS, type PaddleVariantId, type PaddleGeometry } from './paddleVariants';
import { createPaddleFrame, paddleFrame } from './paddleKinematics';

/** Whole-hull mechanisms. Geometry and virtual-work path are shared with the fluid solver. */
export function buildLongPaddles(id: PaddleVariantId) {
  const v = PADDLE_VARIANTS[id], spec = v.geometry;
  const g = { ...spec, inertia: 0, machineryMass: 0 } as PaddleGeometry;
  const group = new THREE.Group(), mats = [v.wood, v.blade, v.accent, 0xa78951].map((color,i) =>
    patchMaterial(new THREE.MeshStandardMaterial({color, roughness: .7, metalness: i === 3 ? .6 : 0})));
  const buckets: THREE.BufferGeometry[][] = mats.map(()=>[]);
  let mass = 0, movingMass = 0;
  function shape(geo: THREE.BufferGeometry, m: number, count = 1) {
    // Exact signed volume of exported triangles, including cylinder polygon discretisation.
    const p = geo.getAttribute('position'), ix = geo.index!, a = new THREE.Vector3(), b = a.clone(), c = a.clone();
    let volume = 0;
    for(let i=0;i<ix.count;i+=3) {
      a.fromBufferAttribute(p,ix.getX(i)); b.fromBufferAttribute(p,ix.getX(i+1)); c.fromBufferAttribute(p,ix.getX(i+2));
      volume += a.dot(b.cross(c))/6;
    }
    const kg = Math.abs(volume) * (m===3 ? 8700 : 650) * count; mass += kg; return kg;
  }
  function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, m: number) {
    const delta = b.clone().sub(a), geo = new THREE.CylinderGeometry(radius,radius,delta.length(),8);
    shape(geo,m); geo.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize()),new THREE.Vector3(1,1,1)));
    buckets[m].push(geo);
  }
  const vec = (x:number,y:number,z:number) => new THREE.Vector3(x,y,z);
  function instances(geometry:THREE.BufferGeometry, m:number, count:number, moving=true) {
    const kg = shape(geometry,m,count); if(moving) movingMass += kg;
    const mesh = new THREE.InstancedMesh(geometry,mats[m],count); mesh.castShadow=mesh.receiveShadow=true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled=false; mesh.layers.enable(LAYER_REFRACT);group.add(mesh);return mesh;
  }
  const blades: THREE.InstancedMesh[] = [], arms: THREE.InstancedMesh[] = [], joints: THREE.InstancedMesh[] = [], links:THREE.InstancedMesh[]=[];
  const capstans:THREE.Group[][]=[[],[]], drums:THREE.Group[][]=[[],[]];
  const frame = createPaddleFrame(), next = createPaddleFrame();
  const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion(), one=vec(1,1,1), up=vec(0,1,0);
  function segment(mesh:THREE.InstancedMesh,i:number,a:THREE.Vector3,b:THREE.Vector3,r:number) {
    const d=b.clone().sub(a); matrix.compose(a.clone().add(b).multiplyScalar(.5),quat.setFromUnitVectors(up,d.clone().normalize()),vec(r,d.length(),r)); mesh.setMatrixAt(i,matrix);
  }
  for(const side of [-1,1]) {
    const si=side<0?0:1;
    const bladeMesh=instances(new THREE.BoxGeometry(g.width,g.bladeHeight,.14),1,g.blades);
    bladeMesh.name=`Paddle_${side<0?'port':'starboard'}_blades`;blades.push(bladeMesh);
    const span = g.mechanism==='sweeps' ? 31 : (g.trackHalfLength!+g.radius+.5);
    for(const x of [side*11.0,side*(g.x+g.width/2+.35)]) {
      rod(vec(x,5.9,-span),vec(x,5.9,span),.17,0);
      rod(vec(x,7,-span),vec(x,7,span),.065,0);
    }
    for(let z=-28;z<=28;z+=8) {
      const outer=side*(g.x+g.width/2+.35);
      rod(vec(side*10.5,5.9,z),vec(outer,5.9,z),.2,0);
      rod(vec(side*10.5,1.5,z),vec(outer,5.9,z),.2,0);
      rod(vec(outer,5.9,z),vec(outer,7,z),.075,0);
    }
    if(g.mechanism==='sweeps') {
      // Two fixed-length links (5 m + 5 m), with bronze elbow pins and vertical paddles.
      // Unit cylinders are scaled to the actual constrained link lengths by the animator.
      const armGeo = new THREE.CylinderGeometry(.16,.16,5,8);
      movingMass += shape(armGeo,0,2*g.blades); armGeo.dispose();
      // Unit geometry has its actual length restored by instance transforms; do not count it again.
      const arm = new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),mats[0],g.blades*2);
      arm.name=`Paddle_${side<0?'port':'starboard'}_arms`;arm.castShadow=arm.receiveShadow=true;arm.frustumCulled=false;arm.layers.enable(LAYER_REFRACT);group.add(arm);arms.push(arm);
      joints.push(instances(new THREE.SphereGeometry(.25,8,6),3,g.blades));
      rod(vec(side*10.6,6.5,-30),vec(side*10.6,6.5,30),.22,0);
      for(let i=0;i<g.blades;i++) {
        const z=(i-(g.blades-1)/2)*8;
        rod(vec(side*10.6,5.55,z),vec(side*10.6,7.0,z),.23,2);
      }
    } else {
      // A paired articulated ladder, one pinned rail at either edge of each board.
      const rail = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),mats[0],g.blades*2);
      rail.castShadow=rail.receiveShadow=true;rail.frustumCulled=false;rail.layers.enable(LAYER_REFRACT);group.add(rail);links.push(rail);
      // Prismatic rail estimate matches the swept rectangular links (0.16 m square).
      const length=4*g.trackHalfLength!+2*Math.PI*g.radius;
      const railGeo=new THREE.BoxGeometry(.16,.16,length*2);movingMass+=shape(railGeo,0);railGeo.dispose();
      for(const z of [-g.trackHalfLength!,g.trackHalfLength!]) {
        const drum=new THREE.Group();drum.position.set(side*g.x,g.y,g.z+z);group.add(drum);drums[si].push(drum);
        const geo=new THREE.CylinderGeometry(g.radius-.12,g.radius-.12,.4,32);movingMass+=shape(geo,0,2);
        for(const dx of [-g.width/2,g.width/2]) {
          const disc=new THREE.Mesh(geo,mats[2]);disc.rotation.z=Math.PI/2;disc.position.x=dx;disc.castShadow=true;drum.add(disc);
          for(let i=0;i<12;i++) {
            const t=i*Math.PI/6, peg=new THREE.Mesh(new THREE.BoxGeometry(.42,.28,.24),mats[1]);
            shape(peg.geometry,1);peg.position.set(dx,g.radius*Math.cos(t),g.radius*Math.sin(t));peg.rotation.x=t;drum.add(peg);
          }
        }
        rod(vec(side*11,g.y,g.z+z),vec(side*(g.x+g.width/2+.5),g.y,g.z+z),.32,0);
        rod(vec(side*(g.x+g.width/2+.5),g.y,g.z+z),vec(side*(g.x+g.width/2+.5),5.9,g.z+z),.3,0);
      }
    }
    // Distributed walking capstans feed each long drive via a line shaft.
    for(const z of [-21,-7,7,21]) {
      const cx=side*6, cap=new THREE.Group();cap.position.set(cx,5.55,z);group.add(cap);capstans[si].push(cap);
      const spindle=new THREE.Mesh(new THREE.CylinderGeometry(.25,.25,1.1,8),mats[0]);shape(spindle.geometry,0);spindle.position.y=.55;cap.add(spindle);
      for(const angle of [0,Math.PI/2]) {
        const bar=new THREE.Mesh(new THREE.BoxGeometry(4,.14,.14),mats[0]);shape(bar.geometry,0);bar.position.y=.95;bar.rotation.y=angle;cap.add(bar);
      }
      rod(vec(cx,5.8,z),vec(side*10.6,5.8,z),.16,0);
    }
    rod(vec(side*6,5.8,-23),vec(side*6,5.8,23),.2,0);
  }
  buckets.forEach((items,m)=>{if(!items.length)return;const mesh=new THREE.Mesh(mergeGeometries(items),mats[m]);
    items.forEach(g=>g.dispose());mesh.castShadow=mesh.receiveShadow=true;mesh.layers.enable(LAYER_REFRACT);group.add(mesh);});
  function animate(angles:number[]) {
    for(let si=0;si<2;si++) {
      const side=si?1:-1;
      for(let i=0;i<g.blades;i++) {
        paddleFrame(g,angles[si],i,frame);const p=frame.point.clone();p.x*=side;
        const angle=Math.atan2(frame.heightAxis.z,frame.heightAxis.y);
        matrix.compose(p,quat.setFromAxisAngle(vec(1,0,0),angle),one);blades[si].setMatrixAt(i,matrix);
        if(g.mechanism==='sweeps') {
          const hip=vec(side*10.6,6.5,(i-(g.blades-1)/2)*8), delta=p.clone().sub(hip), dist=delta.length();
          // Equal 5 m links: knee on perpendicular bisector, biased toward the stern.
          const perpendicular=vec(0,0,1).addScaledVector(delta,-delta.z/(dist*dist)).normalize();
          const knee=hip.clone().add(p).multiplyScalar(.5).addScaledVector(perpendicular,Math.sqrt(Math.max(0,25-dist*dist/4)));
          segment(arms[si],i*2,hip,knee,.16);segment(arms[si],i*2+1,knee,p,.16);
          matrix.compose(knee,new THREE.Quaternion(),one);joints[si].setMatrixAt(i,matrix);
        } else {
          paddleFrame(g,angles[si],(i+1)%g.blades,next);
          for(let edge=0;edge<2;edge++) {
            const a=p.clone(), b=next.point.clone();b.x*=side;a.x+=(edge?1:-1)*g.width/2;b.x+=(edge?1:-1)*g.width/2;
            const d=b.clone().sub(a);matrix.compose(a.add(b).multiplyScalar(.5),quat.setFromUnitVectors(up,d.clone().normalize()),vec(.16,d.length(),.16));links[si].setMatrixAt(i*2+edge,matrix);
          }
        }
      }
      blades[si].instanceMatrix.needsUpdate=true;
      if(g.mechanism==='sweeps') {arms[si].instanceMatrix.needsUpdate=true;joints[si].instanceMatrix.needsUpdate=true;}
      else { links[si].instanceMatrix.needsUpdate=true;
        const k=(4*g.trackHalfLength!+2*Math.PI*g.radius)/(2*Math.PI);for(const d of drums[si]) d.rotation.x=angles[si]*k/g.radius;
      }
      for(const c of capstans[si]) c.rotation.y=-angles[si]/(g.mechanism==='sweeps'?1.5:.3);
    }
  }
  animate([0,0]);
  const k=(4*(g.trackHalfLength??0)+2*Math.PI*g.radius)/(2*Math.PI);
  // Equivalent drive inertia from moving timber, plus a 2 t, 1.5 m rim flywheel per side.
  // Six/eight evenly phased linkages smooth changing effective mass; elasticity is omitted.
  const rotorInertia = g.mechanism==='sweeps' ? movingMass/2*(2.6**2+g.radius**2)/2+2000*1.5**2 : movingMass/2*k*k+2000*1.5**2;
  return {group,rotors:[] as THREE.Group[],capstans,animate,
    engineering:{rotorMass:movingMass/2,rotorInertia,visibleMass:mass,machineryMass:mass+12000}};
}
