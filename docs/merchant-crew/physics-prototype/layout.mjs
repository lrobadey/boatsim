import { MERCHANT, rowingMod } from './harness.mjs';
import { buildLayout, DEFAULTS } from './crewrow.mjs';
const H = MERCHANT.hull, { nominalDip } = rowingMod, p = DEFAULTS;
const R = (x, d = 2) => +x.toFixed(d);
const rows = buildLayout(p).map((sl) => {
  const dW = nominalDip(sl, true), dD = nominalDip(sl, false), deck = sl.deckY;
  const hand = (r, th, d) => ({ x: R(sl.x - sl.side * r * Math.cos(d) * Math.cos(th)), y: R(sl.y + r * Math.sin(d) - deck), z: R(sl.z + r * Math.cos(d) * Math.sin(th)) });
  return { s: sl.s, side: sl.side < 0 ? 'P' : 'S', pin: { x: R(sl.x), yAboveWL: R(sl.y), z: R(sl.z) }, deckY: R(deck), deckHalfW: R(MERCHANT.deck.deckHalfWidth(sl.s)),
    dipWetDeg: R(dW * 57.3, 1), dipDryDeg: R(dD * 57.3, 1),
    handleEnd_catch_wet: hand(1.5, p.catchMax, dW), handleEnd_square_wet: hand(1.5, 0, dW), handleEnd_finish_wet: hand(1.5, p.finishMin, dW),
    outerHand_catch: hand(1.45, p.catchMax, dW), innerHand_finish: hand(1.05, p.finishMin, dW), handleEnd_recovery_dry: hand(1.5, 0, dD),
    bladeTip_reach_m: R((sl.length - sl.inboard) * Math.cos(dW)) };
});
const eye = H.sheer(0.86) - 0.3 + 1.55, head = H.sheer(0.78) - 0.3 + 1.68, dz = H.zOf(0.86) - H.zOf(0.78);
const drop = (eye - head) / dz, groundsAt = eye / drop;
console.log(JSON.stringify({ rows, helm: { z: R(H.zOf(0.86)), deckY: R(H.sheer(0.86) - 0.3), eyeY: R(eye) }, sightOverStroke: { strokeHeadY: R(head), dzM: R(dz), seesWaterBeyondM_fromHelm: R(groundsAt, 1), beyondBowM: R(groundsAt - (H.zOf(0.86) - H.zOf(0.0)), 1) }, mast: { z: R(H.zOf(0.44)) } }, null, 1));
