import './register-ts.mjs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const {buildPaddleVariant,disposePaddleVariant}=await import('../src/dev/paddleVariantModel.ts');
const {PADDLE_VARIANTS}=await import('../src/dev/paddleVariants.ts');
const {createPaddleFrame,paddleFrame}=await import('../src/dev/paddleKinematics.ts');
for(const id of Object.keys(PADDLE_VARIANTS)) {
  const a=buildPaddleVariant(id),g={...PADDLE_VARIANTS[id].geometry,inertia:a.engineering.rotorInertia,machineryMass:a.engineering.machineryMass};
  const frame=createPaddleFrame(),matrix=new THREE.Matrix4(),point=new THREE.Vector3(),scale=new THREE.Vector3(),q=new THREE.Quaternion();
  for(let n=0;n<120;n++) {
    const phase=n*2*Math.PI/120;a.animate([phase,phase]);a.group.updateMatrixWorld(true);
    for(const [si,side] of [-1,1].entries()) for(let i=0;i<g.blades;i++) {
      paddleFrame(g,phase,i,frame);
      if(id==='helios') {
        if(i)continue;
        const probe=a.rotors[si].getObjectByName(`Paddle_${side<0?'port':'starboard'}_blade_probe`);
        point.copy(probe.getWorldPosition(new THREE.Vector3()));
      } else {
        const blades=a.group.getObjectByName(`Paddle_${side<0?'port':'starboard'}_blades`);blades.getMatrixAt(i,matrix);point.setFromMatrixPosition(matrix);
      }
      const expected=frame.point.clone();expected.x*=side;
      assert.ok(point.distanceTo(expected)<2e-5,`${id} visible/force mismatch`);
      if(id==='basileus') {
        const oar=a.group.getObjectByName(`Royal_oar_${side}_${i}`),pivot=new THREE.Vector3(side*g.rowlockX,g.y,(i-(g.blades-1)/2)*8);
        assert.ok(oar.position.distanceTo(pivot)<1e-6,'rowlock moved');
        assert.ok(new THREE.Vector3(0,-g.inboard,0).applyMatrix4(oar.matrixWorld).y>5.55,'handle clips deck');
        assert.ok(new THREE.Vector3(0,g.outboard,0).applyMatrix4(oar.matrixWorld).distanceTo(expected)<2e-5,'rigid oar stretched');
        const normal=new THREE.Vector3(0,0,1).applyQuaternion(oar.quaternion),forceNormal=frame.normal.clone();forceNormal.x*=side;
        assert.ok(normal.distanceTo(forceNormal)<1e-5,'feather angle mismatch');
        for(let arm=0;arm<2;arm++) {
          const upper=a.group.getObjectByName(`Royal_arm_${side}_${i}_${arm}_upper`),fore=a.group.getObjectByName(`Royal_arm_${side}_${i}_${arm}_fore`);
          const elbow=new THREE.Vector3(0,1,0).applyMatrix4(upper.matrixWorld),foreElbow=new THREE.Vector3(0,-1,0).applyMatrix4(fore.matrixWorld);
          const hand=new THREE.Vector3(0,1,0).applyMatrix4(fore.matrixWorld),grip=new THREE.Vector3(0,-g.inboard+.4*arm,0).applyMatrix4(oar.matrixWorld);
          assert.ok(elbow.distanceTo(foreElbow)<1e-5,'mechanical elbow disconnected');
          assert.ok(hand.distanceTo(grip)<1e-5,'mechanical hand misses oar');
        }
      }
      if(id==='polypous') {
        const hip=new THREE.Vector3(side*10.6,6.5,(i-(g.blades-1)/2)*8);
        assert.ok(hip.distanceTo(expected)<10, 'unreachable paddle');
        const arms=a.group.getObjectByName(`Paddle_${side<0?'port':'starboard'}_arms`);
        for(const index of [i*2,i*2+1]) {arms.getMatrixAt(index,matrix);matrix.decompose(point,q,scale);assert.ok(Math.abs(scale.y-5)<2e-5,'link stretched');}
      }
    }
  }
  console.log(`PASS ${id}: 120 phases, visible blade/force paths, fixed sweep links`);disposePaddleVariant(a.group);
}
