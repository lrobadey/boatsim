/** Read-only extraction: the game's design remains authoritative for dimensions and mechanics. */
import '../../scripts/register-ts.mjs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const {MERCHANT,TRIREME}=await import('../../src/ship/design.ts');
const {MERCHANT_OFFSETS}=await import('../../src/ship/merchantOffsets.ts');
const root=new URL('../../',import.meta.url);
const files=['src/ship/design.ts','src/ship/merchantOffsets.ts','src/ship/tableHull.ts','src/ship/merchantModel.ts','src/ship/crew/params.ts','src/ship/shipVisual.ts'];
const sources=[];
for(const file of files){const bytes=await fs.readFile(new URL(file,root));sources.push({file,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
const d=MERCHANT,h=d.hull;
const stations=Array.from({length:257},(_,i)=>{const s=i/256;return {s,z:h.zOf(s),sheer:h.sheer(s),keel:-h.keelDepth(s),halfBeam:h.halfBeam(s),waterlineHalfBeam:h.halfWidthAt(s,0),deckY:d.deck.deckY(s),deckHalfWidth:d.deck.deckHalfWidth(s)};});
const contract={schemaVersion:1,id:'game-merchant',units:'metres',axes:{up:'+Y',forward:'-Z',starboard:'+X',origin:'game design waterline at hull longitudinal centre',blenderMapping:'[game.x, -game.z, game.y]'},sources,
 hull:{length:h.length,bowOverhang:h.bowOverhang,sternOverhang:h.sternOverhang,keelHalf:h.keelHalf,waterlineAboveKeel:h.waterlineAboveKeel,offsets:MERCHANT_OFFSETS,stations},
 deck:{s0:d.deck.s0,s1:d.deck.s1,sheerOffset:-.3,inset:.12},rig:d.rig,cargo:d.cargo,docking:d.docking,rudder:d.rudder,oars:d.oars.slots(),crewSpots:d.crewSpots,mass:d.mass,anchor:d.anchor,
 policy:{physics:'Keep game design, buoyancy columns, mass, rowing and sail physics unchanged.',visual:'Author static shell to the game offsets; keep hatches, yard, cloth, sweeps and steering oars separately addressable.',cargo:'Cargo remains runtime-controlled. Do not bake amphorae into walkable deck or hold.'}};
const out=new URL('../contracts/game-merchant.json',import.meta.url);await fs.writeFile(out,JSON.stringify(contract,null,2)+'\n');
const summary={merchant:{length:h.length,beam:Math.max(...stations.map(s=>s.halfBeam))*2,draft:Math.max(...stations.map(s=>-s.keel)),mastBase:d.rig.mastBaseY,mastHeight:d.rig.mastHeight,yardLength:d.rig.yardLength,sail:[d.rig.width,d.rig.height],hatches:d.cargo.hatches,oars:d.oars.slots().length,plankLength:d.docking.plankLength},trireme:{length:TRIREME.hull.length}};
console.log(JSON.stringify(summary,null,2));
