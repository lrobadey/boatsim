/** Bounded inspection walking, independent of the game's physics. Metres, Y-up. */
export const WALK={radius:.28,eye:1.68,height:1.8,step:.42,drop:.50,slope:1.2};
export function terrainSurface(grid,x,z){
 const u=(x-grid.x0)/grid.step,v=(-z-grid.nativeY0)/grid.step;
 if(u<0||v<0||u>=grid.columns-1||v>=grid.rows-1)return null;
 const i=Math.floor(u),j=Math.floor(v),a=u-i,b=v-j,k=j*grid.columns+i;
 const h00=grid.heights[k],h10=grid.heights[k+1],h01=grid.heights[k+grid.columns],h11=grid.heights[k+grid.columns+1];
 const dx=a>=b?h10-h00:h11-h01,dy=a>=b?h11-h10:h01-h00;
 return {height:h00+a*dx+b*dy,slope:Math.hypot(dx,dy)/grid.step,source:'terrain'};
}
export function surfaceAt(manifest,x,z){
 let result=terrainSurface(manifest.terrain,x,z);if(!result)return null;
 for(const f of manifest.floors)if(Math.abs(x-f.x)<=f.w/2&&Math.abs(z-f.z)<=f.d/2&&f.y>=result.height-.025)result={height:Math.max(result.height,f.y),slope:0,source:'floor'};
 return result;
}
export function blockedAt(manifest,x,z,feet){
 return manifest.colliders.some(b=>{
  if(feet+WALK.height<=b.y0+.03||feet>=b.y1-.03)return false;
  const dx=Math.max(0,Math.abs(x-b.x)-b.w/2),dz=Math.max(0,Math.abs(z-b.z)-b.d/2);
  return dx*dx+dz*dz<WALK.radius*WALK.radius;
 });
}
export function moveWalker(manifest,start,dx,dz){
 const out={...start};let floor=surfaceAt(manifest,out.x,out.z)?.height??start.y;
 const steps=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.08));
 function axis(x,z){const next=surfaceAt(manifest,x,z);if(!next||next.height<.26||next.height-floor>WALK.step||floor-next.height>WALK.drop||next.slope>WALK.slope||blockedAt(manifest,x,z,next.height))return;out.x=x;out.z=z;floor=next.height;}
 for(let i=0;i<steps;i++){axis(out.x+dx/steps,out.z);axis(out.x,out.z+dz/steps);}
 out.y=floor;return out;
}
