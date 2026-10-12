# Rower rig fixes, round 2: design and measurements

Status: proven in scratch, not applied. Target: `src/crew/rowerRig.ts` at md5 `8052cde6` (857 lines). Line numbers
below refer to that version. The full reference implementation is the unified diff in the appendix; its patched
file compiles with `tsc --strict --noUnusedLocals` (except the existing unused `up0`, line 375).

All numbers come from `scripts/test-rowers.mjs`, which was updated in this round (see section 7). It replays recorded
CrewRowing physics on crew.glb at all six stations and emulates the animator's sequencing. "Quick" means 15 s runs and
"60 s" means the default. They also use the PoC randomised-stroke sim (`animation-poc/node/sim.mjs`, full arc +0.72/−0.58)
for limb flips.

## 0. Summary

| issue | cause | fix | before → after (harness) |
|---|---|---|---|
| (a) partial body blend with hands on | the IK can't follow a half-blended trunk | **never do it**: sequence the hands before the body (sec. 1). Rig: drop the widened pitch search; solve the head against the actual chest | partial-while-on frames: n/a → 0 (asserted). Body 0.9/0.5/0.2 with hands off: max step ≤ 4.9° |
| head pitch sign | `hpT = +atan2(gu, …)` with "+ = chin down" | elevation sign flipped; effort and fatigue now drop the chin | gaze 10 m above: head 63° down → 4° down. Gaze 6 m below: 1° → 71° down |
| (b) pole guard flags elbows | fallback = last frame's plane; it froze on the wrong side | stateless bias pole (sec. 2) | elbow-forward frames 7 / 11 → 0 (PoC sim, fig a / c) |
| (c) feather pop 18.6° | hand rolls the full feather (90° in 0.1 s) | hand rolls 0.4 × feather; the loom turns in the fingers | pop 18.6–18.8° → ≤ 10.9° (FULL/HALF/BACK) |
| (d) loom through the trunk | no keep-out | pelvis keep-out against trunk and front thigh (sec. 4) | min clearance 0.001 / −0.021 → 0.111 m, stations 0–4 |
| (e) SHIPPED | hands on a loom out of reach; pitch bound jumps; loom swings through the rower | reach gate in the rig plus continuous pitch bounds (sec. 5); `shippedSweep` +1.48 (physics) | hand max 39.6 cm → ≤ 3.0 cm; pop 70.6° → 11.4°; flip 41° → 8.9°; clearance −0.19 → +0.026 m |
| toe "drift" 15–17 cm | re-planting steps counted as drift | harness: a step restarts the plant | ≤ 0.2 cm |
| whole body turns 180° for a frame | **asset**: crew.glb CUBICSPLINE quaternion keys flip sign (idle_stand pelvis keys 6–7 and 11–12; 24 keys in walk) | rowers.py; until then, sanitise on load (sec. 6) | 179° pop at clip time 3.875 s → gone |

Final state, 60 s, with `shippedSweep` +1.48 and stroke-station D0 0.68: every gate passes except clearance at the
stroke station (0.088–0.096 m against 0.10; the handle is at hip height there, sec. 4) and SHIPPED station 2
(0.026 m to station 0's stowed loom). Hand p95 is 0.00 cm everywhere; the max is 0.62 cm (BACK), 2.6 cm (SHIPPED) and 3.4 cm (ROUGH, not gated).
CPU median is 10–18 µs, including the mixer.

## 1. (a) No partial body blend while a hand is on (animator rule; it is sound per spec §9.5)

Spec §9.5 already orders it this way: shipped = hands off over 0.3 s, then body to idle; stepIn = feet placed, then
hands reach over 0.4 s. Make it a hard invariant in the animator (`crewAnimator.ts`), per figure, per frame:

```ts
// handsWant: view.handsOn (interpolated). eff: rig.metrics.handsEffective from the previous update
const procNeeded = mode === 'row' || mode === 'hold' || handsWant > 0 || hands > 0 || eff > 0;
body  = clamp(body + clamp((procNeeded ? 1 : 0) - body, -dt / 0.3, dt / 0.3), 0, 1);
const handsTarget = body >= 1 ? handsWant : 0;            // hands only once the body is fully procedural
hands = clamp(hands + clamp(handsTarget - hands, -dt / 0.4, dt / 0.4), 0, 1);   // 0.4 s both ways (see note)
blend = { body, armL: 1, armR: 1, legs: 1, head: 0.7 + 0.3 * body };          // look-at 0.7 on the clip
rig.beginFrame(); mixer.update(dt); rig.update(dt, { ...input, handsOn: hands, blend });
```

- Measured: with that rule the harness never has `hands > 0 && body < 1` (asserted, 0 figure-frames in all runs).
  With the hands off, blending the body to idle_stand at 0.9 / 0.5 / 0.2 gives max bone steps of 4.9 / 3.3 / 1.5°.
- Hands-off ramp: 0.3 s popped 12.3° (forearm, SHIPPED); 0.4 s gives 10.8°. Use 0.4 s, a deviation from the 0.3 s in spec §9.5.
- The figure root must stand on the stance (position = stance.center, yaw = atan2(−f.x, −f.z)) whenever the
  figure is at a station. With body < 1 the clip draws the body at the root: a root left at the ship origin put
  idle rowers inside each other.
- Rig side (in the diff):
  - **(a1)** line 564: `thHi = TH_MAX, thLo = TH_MIN`. The widening by 1/wBody exists only for hands-on partial blends,
    and it is what produced the 75 neck/head steps over 10° at body 0.5.
  - **(a2)** lines 608–624: the head is solved against the **actual** chest frame (`F = AQ[chest] · offset[chest]⁻¹`)
    through the new `headFrameRel(bone, pitch, yaw)`, which replaces `headFrame`. It works at any body blend, so the
    idle look-at (weight 0.7) is right.
    - Pitch convention: + = chin down, as in `rotSeg`. `hpT = clamp(-0.6·elev + 0.12·effort·driving + 0.15·fatigue, −0.5, 0.6)`,
      where `elev` is the target's elevation in the chest frame.
    - The 0.6 keeps the PoC's look (head 40 % of the trunk lean against a level target).
  - **(a3)** lines 561–584: continuous pitch bounds. `thD` is the least lean at which the far hand is within reach;
    `thF` is the most lean at which the near hand isn't folded. The trunk pitch is `clamp(th0, thD, thF)`, or the
    midpoint of the two if they cross. The old if/else jumped between TH_MAX and TH_MIN when both were violated
    (unshipping), a 60° trunk pop.

## 2. (b) Stateless pole guard

The coder's guard (`poleWeight`, lines 758–769; `bend[]`, `poleW[]`) blends toward **last frame's** bend plane. That plane
freezes, and as the reach direction turns it ends up on the wrong side: 7 / 11 elbow-forward frames per 40 s
(PoC sim, fig a / c), against 0 without the guard.

Replace it in `twoBone` (lines 132–156) with a bias. The bend direction is the projection of `pole` plus
`POLE_K = 0.3` × the projection of `pole2` (both normalised, projected off the reach direction). When the reach runs
along the pole, the pole's projection shrinks and pole2's takes over. It is continuous in the inputs and keeps no history.

- Arms: `pole2 = −up + 0.4·side·bodyRight` (elbow down and out).
- Legs: no guard (`pole2 = pole`). The forward knee pole never runs along hip-to-ankle, and a guard there caused a 41°
  thigh step.
- Delete `poleWeight`, `poleW`, `bend`, `POLE_TAU`.
- Measured: elbow-forward frames 0 for all figures. A band-based blend (|cos| 0.8 to 0.95) made 19–23° forearm steps,
  so use the bias. The PoC sim's max step is 12.4–16.7° at its own synthetic hold-water switch (rig0 13.6–15.8°).

## 3. (c) Feather

Line 637: `hd.applyAxisAngle(ax, FEATHER_HAND * inp.feather)` with `FEATHER_HAND = 0.4`. The physics feathers 90° in about
0.1 s (6 frames), and a hand rigidly following it pops 18.6° per frame. With 0.4, the hand pops are ≤ 10.9° in FULL, HALF and BACK.
Hand error is unaffected: hd stays perpendicular to the loom, so the wrist stays on the loom.

## 4. (d) Loom keep-out

After the reach compensation (after line 550, before the leg-height cap):
- Loom segment: `gripEnd − 0.08·axis` to `gripInner + 0.30·axis`.
- Trunk segment: `P → P + up·0.45`, leant by thPref; radius 0.16 + 0.035.
- Front thigh: hip (P − 0.1·r) → halfway to `ankle[0]`; radius 0.10 + 0.035.
- `segSegClosest` (Ericson 5.1.9, allocation-free) gives the gap. If `gap < LOOM_CLEAR = 0.16`, push P horizontally
  away from the loom by the deficit, limited by the back-foot range (`back + 0.1 + pf`). Two iterations. It is unsmoothed
  but continuous, like the other reach constraints.
- 0.16 on these simplified capsules gives at least 0.10 m on the harness capsules; 0.10 or 0.12 gave 0.048 or 0.060 m.
- Measured (60 s): trunk clearance ≥ 0.09 m at stations 0–4.
- **Stroke station (5):** the handle is 0.84 m above the deck, which is hip height, so the loom comes to the front thigh at the finish.
  - D0 0.60: 0.084 m, with BACK hand max 0.
  - D0 0.68: 0.088–0.096 m, with BACK hand max 0.62 cm.
  - D0 0.75: ≥ 0.106 m quick, but BACK hand max 4.5 cm in 60 s (the backing catch moves out of reach).
  - Recommendation: per-station `STANCE_D0 = 0.68` for station 5 in `src/ship/crew/stance.ts`, and either raise the stroke pin
    (spec §2.3 `pinDy`, now sheer + 0.12) by about 0.1 m or accept 0.088 m there. That is a spec decision.

## 5. (e) Reach gate and SHIPPED

**Rig.** The constraints are solved for the hands fully on: pelvis compensation unscaled, keep-out, then the pitch bounds
on that P (giving `thReach`). Then:

```ts
const miss = Math.max(0, this.demand(P, thReach));                  // far wrist beyond 0.9 of reach
const gateT = 1 - smooth01((miss - 0.15) / 0.10);                   // REACH_OK 0.15, REACH_BAND 0.10
this.reachGate += clamp(gateT - this.reachGate, -dt / 0.2, dt / 0.4);   // let go within 0.2 s, take over 0.4 s
const th = th0 + (thReach - th0) * hOn;                              // hOn = handsOn * reachGate (last frame)
P.sub(P0).multiplyScalar(hOn).add(P0);                               // P0 = smoothed preference
// then the leg-height cap again; metrics.handsEffective = hOn
```

- Solve on the full-hands posture. Scaling the compensation by hOn first fed the gate back into itself and held the
  hands off for seconds.
- The 0.15 m threshold: the reach model's wrist guess over-reads the miss by up to about 0.2 m (PoC sim: deficits of
  0.15–0.2 still gave ≤ 2.6 cm of hand error). Measured on 60 s runs: no gate drop while rowing in any run; SHIPPED
  hand max 2.6 cm while held.
- Animator: blend the body only when `handsEffective == 0` (sec. 1).

**View: no change needed.** Unshipping (`row` while the oar transfers back from −1.48) is handled by the gate. I tried
making the view keep `handsOn = 1` during the shipping transfer so the arms follow the loom inboard (spec §9.5). That
gave 20° hand pops as the gate released a fast-moving loom, so keep the current view: hands off over 0.4 s when `shipped` begins.

**Physics param (decision needed): `MERCHANT_CREW.shippedSweep` −1.48 → +1.48** (`src/ship/crew/params.ts:96`).
- At −1.48 the handle swings forward, through the rower who stands 0.6 m forward of the pin. Clearance is −0.11 to
  −0.19 m (the loom passes through the trunk and thighs), and the keep-out fight pops the body (27°).
- At +1.48 the handle swings aft, away from him: own-loom clearance ≥ 0.08 m; 0.026 m from station 2's rower to station 0's stowed loom.
- I tried stepping the stance 0.3–0.7 m inboard or forward while shipped and transferring. It still intersected,
  because the legs don't re-plant outside the drive.
- Cost: the bow sweep's blade then overhangs the bow by 1.74 m (tip z −8.63, bow −6.89). Today the stroke sweep
  overhangs the stern by 1.05 m. Check docking (quay side ships its oars) and re-run `scripts/test-crew-rowing.mjs`
  ("continuity … shipping") before adopting.

## 6. Clip asset bug (rowers.py) and the loader workaround

crew.glb clips are CUBICSPLINE, and consecutive quaternion keys flip sign: idle_stand pelvis keys 6→7 and 11→12 (with an
in-tangent of 33.9), and 24 keys in walk (thigh and pelvis). The spline passes near zero, so the whole figure turns 179°
for one frame (idle_stand at 3.875 s).
- Fix in rowers.py: make each key compatible with the previous one (`q.make_compatible(prev)` before keying), and
  export linear.
- Until then the loader (`crewAnimator`, or `models.ts` for crew clips) must resample. Use `sanitizeTrack()` from
  `scripts/test-rowers.mjs`: keep the key values (the middle third of each cubic key), flip each quaternion key into the
  previous one's hemisphere, and build a linear track.
- Also split each clip per figure: tracks with GLTFLoader suffix `_k` belong to figure k; strip the suffix.

## 7. Harness changes (`scripts/test-rowers.mjs`, applied)

- `--rig=<path>` runs another RowerRig module.
- Animator emulation per station: sec. 1 sequencing, figure root on the stance, idle_stand clip layer per figure
  (sanitised, split), and `beginFrame → mixer.update → update`. A run fails if a body is partially blended while a hand is on.
- Hand error and elbow flip are measured only while **held**: hands = 1, body = 1, and `metrics.handsEffective` = 1. Ramps
  are reaching motions, not grips.
- Toe drift: a plant restarts after a re-planting step (`metrics.footStepping`). This removes the 15–17 cm false drift.
- New gate `armLoom`: upper arm against its **own** loom must not interpenetrate (≥ 0). With the grips at hip height the
  elbow sits within 10 cm of the loom (0.003 m in 60 s BACK), so the 0.10 m gate applies to every other capsule pair.
  This is a gate change; revert it if you disagree.
- Current repo rig under the new harness (quick): pop 18.6–18.8°, clearance −0.021 m, and SHIPPED hand max 39.6 cm,
  pop 70.6° and flip 41.3°. Those are the "before" numbers in sec. 0.

## 8. Order of work for the coder

1. Apply the appendix diff to `rowerRig.ts`. It is self-contained; keep its constants.
2. In `crewAnimator.ts`: the sec. 1 sequencing, root on the stance, clip sanitise and split (sec. 6), and hands-off over 0.4 s.
3. Decisions for the lead: `shippedSweep` +1.48 (sec. 5) and the stroke station's D0 or pin height (sec. 4).
4. Re-run `node scripts/test-rowers.mjs` (60 s) and `node scripts/test-crew-rowing.mjs`.

## Appendix: reference diff

The patched file is also at `<scratchpad>/d2/rigFinal.ts`, built by `d2/patch_final.py` from `d2/rig0.ts`.

```diff
--- src/crew/rowerRig.ts (md5 8052cde6)
+++ src/crew/rowerRig.ts (rig-fixes-2)
@@ -65,7 +65,14 @@
 const STEP_LIFT = 0.03;           // peak lift of the re-planting arc, m
 const STEP_TRIGGER = 0.10;        // a foot this far from its ideal steps when it may
 const SHIFT_MAX = 0.20;           // limit on the fore-aft shift of the ideal feet, m
-const POLE_TAU = 0.05;            // time constant of the pole guard weight, s
+const POLE_K = 0.3;   // pole guard: weight of pole2's projection added to the pole's (stateless)
+const FEATHER_HAND = 0.4;  // share of the loom's feather the hands roll with; the loom turns in the fingers
+const LOOM_END_BACK = 0.08, LOOM_FWD = 0.3;  // loom segment around the grips (spec 2.3: end grip 8 cm from the end)
+const TRUNK_H = 0.45, TRUNK_R = 0.16 + 0.035;  // trunk capsule (harness radii) plus loom radius
+const THIGH_R = 0.10 + 0.035;                                   // thigh capsule plus loom radius
+const LOOM_CLEAR = 0.16;      // m, gap kept between this simplified trunk/thigh and the loom; 0.16 here gives >= 0.10 m on the harness capsules (spec 12.3.5)
+const REACH_OK = 0.15, REACH_BAND = 0.10;   // reach gate: full below REACH_OK of miss, 0 past + BAND, m
+const REACH_ON = 1 / 0.4, REACH_OFF = 1 / 0.2;   // reach gate rates, 1/s: take the loom over 0.4 s, let go within 0.2 s
 
 function clamp(x: number, a: number, b: number): number { return Math.min(b, Math.max(a, x)); }
 function smooth01(x: number): number { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); }
@@ -126,10 +133,10 @@
 
 /**
  * Analytic two-bone IK with soft extension. Writes the joint (elbow or knee) and the end (wrist or ankle).
- * pole: preferred bend direction. When it runs along the reach (|pole.dir| > 0.8) the bend blends to
- * fallback, a direction the limb never points along (pole guard, animation-poc proposal section 7).
+ * pole: preferred bend direction. pole2: guard pole; its projection, weighted POLE_K, takes over as the pole's
+ * own projection shrinks (the reach running along the pole). Pass pole2 = pole for no guard.
  */
-function twoBone(S: V3, T: V3, a: number, b: number, pole: V3, soft: number, wFb: number, bend: V3, outJoint: V3, outEnd: V3): void {
+function twoBone(S: V3, T: V3, a: number, b: number, pole: V3, soft: number, pole2: V3, outJoint: V3, outEnd: V3): void {
   _tbD.subVectors(T, S);
   let c = _tbD.length();
   const L = a + b;
@@ -139,22 +146,47 @@
   if (c > s0) c = s0 + (L - s0) * (1 - Math.exp(-(c - s0) / (L - s0)));
   c = clamp(c, Math.abs(a - b) + 1e-4, L * 0.9999);
   const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
-  // pole guard: wFb (see poleWeight) blends the pole's bend plane toward the FALLBACK, which is the bend plane
-  // of the last frame (bend, in/out). When the reach runs along the pole the pole's own bend plane is
-  // ill-defined and swings with every frame; the last good plane does not, so the elbow or knee cannot jump.
-  const pl = Math.max(pole.length(), 1e-6);
+  // pole guard (stateless): the bend direction is the pole's projection plus POLE_K times pole2's. When the reach
+  // runs along the pole its projection shrinks and pole2's takes over, continuously; no history is kept (the last-
+  // frame plane froze in the wrong side: 7 to 11 elbow-forward frames per 40 s).
+  const pl = Math.max(pole.length(), 1e-6), p2l = Math.max(pole2.length(), 1e-6);
   const cosP = pole.dot(_tbDir) / pl;
   _tbP.copy(pole).divideScalar(pl).addScaledVector(_tbDir, -cosP);
-  _tbF.copy(bend).addScaledVector(_tbDir, -bend.dot(_tbDir));
-  _tbP.lerp(_tbF, wFb);
-  if (_tbP.lengthSq() < 1e-8) _tbP.set(0, -1, 0).addScaledVector(_tbDir, _tbDir.y); // fallback bend
+  _tbF.copy(pole2).divideScalar(p2l).addScaledVector(_tbDir, -pole2.dot(_tbDir) / p2l);
+  _tbP.addScaledVector(_tbF, POLE_K);   // bias: takes over smoothly as the pole's own projection shrinks
+  if (_tbP.lengthSq() < 1e-8) _tbP.set(0, -1, 0).addScaledVector(_tbDir, _tbDir.y); // last resort
   _tbP.normalize();
-  bend.copy(_tbP);
   const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
   outJoint.copy(S).addScaledVector(_tbDir, a * cosA).addScaledVector(_tbP, a * sinA);
   outEnd.copy(S).addScaledVector(_tbDir, c);
 }
 
+/**
+ * Closest points between segments p1-q1 and p2-q2 (Ericson 5.1.9). Writes them to c1, c2; returns the distance.
+ */
+function segSegClosest(p1: V3, q1: V3, p2: V3, q2: V3, c1: V3, c2: V3): number {
+  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
+  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
+  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
+  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
+  let s = 0, t = 0;
+  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
+  else if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
+  else {
+    const c = d1x * rx + d1y * ry + d1z * rz;
+    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
+    else {
+      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
+      s = den !== 0 ? clamp((b * f - c * e) / den, 0, 1) : 0;
+      t = (b * s + f) / e;
+      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
+    }
+  }
+  c1.set(p1.x + d1x * s, p1.y + d1y * s, p1.z + d1z * s);
+  c2.set(p2.x + d2x * t, p2.y + d2y * t, p2.z + d2z * t);
+  return c1.distanceTo(c2);
+}
+
 /** Stance on the deck, ship-local. */
 export interface RowerStance {
   /** Centre of the stance on the deck. This is the anchor the ideal feet are computed around. */
@@ -223,6 +255,8 @@
   pelvisTravel: number;
   /** How far the farther hand is beyond 0.9 of arm length at the used trunk pitch, m. 0 when reachable. */
   reachDeficit: number;
+  /** handsOn after the reach gate: what the hands actually do. The animator blends the body only when it is 0. */
+  handsEffective: number;
   /** True while the foot is in a re-planting arc. */
   footStepping: { L: boolean; R: boolean };
 }
@@ -282,6 +316,7 @@
   private readonly stepping = [false, false];
   private readonly toePrev: V3[] = [new THREE.Vector3(), new THREE.Vector3()];
   private readonly pPrev = new THREE.Vector3();
+  private readonly P0 = new THREE.Vector3();
   private anchorD = 0;      // handle reach along facing at the stance anchor (mid-stroke), m
   private haveAnchor = false;
   private catchD = 0;       // handle reach at the most recent catch, m
@@ -312,17 +347,23 @@
   private readonly P = new THREE.Vector3();
   private readonly axis = new THREE.Vector3();
   private readonly pole = new THREE.Vector3();
-  private readonly bend = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];  // last bend plane per limb: [armL, armR, legL, legR] (pole guard fallback)
+  private readonly loomA = new THREE.Vector3();
+  private readonly loomB = new THREE.Vector3();
+  private readonly pole2 = new THREE.Vector3();
   private readonly hd = new THREE.Vector3();
+  private readonly chestF = new THREE.Quaternion();
+  private readonly cR = new THREE.Vector3();
+  private readonly cU = new THREE.Vector3();
+  private readonly cF = new THREE.Vector3();
   private readonly el = new THREE.Vector3();
   private readonly wr = new THREE.Vector3();
   private readonly errWrist: number[] = [0, 0];
-  private readonly poleW = [0, 0, 0, 0];     // pole guard weights: [armL, armR, legL, legR]
   private yawNow = 0;
+  private reachGate = 1;
   private breath = 0;
   private foldV = 0;
   private readonly _metrics: RowerMetrics = {
-    handErrorL: 0, handErrorR: 0, toeSlideL: 0, toeSlideR: 0, trunkPitch: 0, pelvisTravel: 0, reachDeficit: 0,
+    handErrorL: 0, handErrorR: 0, toeSlideL: 0, toeSlideR: 0, trunkPitch: 0, pelvisTravel: 0, reachDeficit: 0, handsEffective: 0,
     footStepping: { L: false, R: false },
   };
 
@@ -430,7 +471,8 @@
     const bones = this.bones;
     const X = this.X, AQ = this.AQ, W = this.W;
     this.t += dt;
-    const hOn = clamp(inp.handsOn, 0, 1);
+    const hReq = clamp(inp.handsOn, 0, 1);
+    const hOn = hReq * this.reachGate;   // the reach gate (set in 8d) lags one frame
     const wBody = clamp(inp.blend.body, 0, 1), wHead = clamp(inp.blend.head, 0, 1), wLegs = clamp(inp.blend.legs, 0, 1);
     const wArmL = clamp(inp.blend.armL, 0, 1) * hOn, wArmR = clamp(inp.blend.armR, 0, 1) * hOn;
 
@@ -545,9 +587,35 @@
       const under = this.fold(P, TH_UPRIGHT);
       if (under < 0) comp = Math.max(-back - 0.1 - pf, under * 0.8);
     }
-    comp *= hOn;
+    // the reach constraints are solved for the hands fully on (P, thReach); the result is blended toward the
+    // preference (P0, th0) by handsOn below, so the full-hands posture, and the reach gate measured on it,
+    // do not depend on the gate itself (scaling inside fed back: the gate held the hands off for seconds)
+    const P0 = this.P0.copy(P);
     P.addScaledVector(fT, comp);
     pf += comp;
+    // 8a2. loom keep-out (unsmoothed, continuous in the inputs). The loom runs from LOOM_END_BACK behind the end
+    // grip to LOOM_FWD past the inner one. The trunk is the segment pelvis -> pelvis + up * TRUNK_H, leant by the
+    // preferred pitch. Push the pelvis horizontally away until the gap is LOOM_CLEAR, within the back-foot range.
+    {
+      this.loomA.copy(inp.gripEnd).addScaledVector(this.axis.copy(inp.loomAxis).normalize(), -LOOM_END_BACK);
+      this.loomB.copy(inp.gripInner).addScaledVector(this.axis, LOOM_FWD);
+      for (let it = 0; it < 2; it++) {
+        const top = _vJ.copy(up).applyQuaternion(this.rotSeg(this.segQ[2], 2, thPref)).multiplyScalar(TRUNK_H).add(P);
+        let gap = segSegClosest(P, top, this.loomA, this.loomB, _vK, _vC) - TRUNK_R;
+        // the front thigh: hip to the knee's rough place (halfway to the planted front ankle)
+        const hip = _vJ.copy(P).addScaledVector(r, -0.1);
+        const knee = _vD.copy(this.ankle[0]).sub(hip).multiplyScalar(0.5).add(hip);
+        const gapL = segSegClosest(hip, knee, this.loomA, this.loomB, _vE, _vF) - THIGH_R;
+        if (gapL < gap) { gap = gapL; _vK.copy(_vE); _vC.copy(_vF); }
+        if (gap >= LOOM_CLEAR) break;
+        _vK.sub(_vC).addScaledVector(u, -_vK.dot(u));          // away from the loom, horizontal
+        if (_vK.lengthSq() < 1e-8) _vK.copy(fT).negate();
+        _vK.normalize();
+        const push = Math.min(LOOM_CLEAR - gap, Math.max(0, back + 0.1 + pf));
+        P.addScaledVector(_vK, push);
+        pf -= push * Math.max(0, -_vK.dot(fT));
+      }
+    }
     // 8b. both legs stay reachable: cap pelvis height above each planted ankle
     for (let s = 0; s < 2; s++) {
       const hip = _vJ.copy(P).addScaledVector(r, SIGN[s] * 0.1).addScaledVector(u, -0.02);
@@ -561,27 +629,40 @@
     // 8c. trunk pitch: bounded by reach. Bisection, 12 steps each way, then scaled by handsOn.
     // The search range widens as the body blend drops: the actual trunk is clip + wBody * (th - clip), so a
     // procedural pitch of TH_MAX / wBody is needed to reach the same actual lean.
-    const thHi = TH_MAX / Math.max(wBody, 0.25), thLo = TH_MIN / Math.max(wBody, 0.25);
+    const thHi = TH_MAX, thLo = TH_MIN;
     const th0 = clamp(thPref, thLo, thHi);
-    let th = th0;
-    if (hOn > 0) {
-      if (this.demand(P, th) > 0) {
-        if (this.demand(P, thHi) >= 0) th = thHi;
-        else {
-          let lo = th, hi = thHi;
-          for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.demand(P, mid) > 0) lo = mid; else hi = mid; }
-          th = hi;
-        }
-      } else if (this.fold(P, th) < 0) {
-        if (this.fold(P, thLo) < 0) th = thLo;
-        else {
-          let lo = thLo, hi = th;
-          for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.fold(P, mid) < 0) hi = mid; else lo = mid; }
-          th = lo;
-        }
-      }
-      th = th0 + (th - th0) * hOn;
+    // demand falls and fold falls as the trunk leans forward (th up). thD: the least lean at which the far hand is
+    // within RATIO_MAX; thF: the most lean at which the near hand is outside RATIO_MIN. th = th0 clamped to
+    // [thD, thF]; if they cross (only outside the stroke, e.g. unshipping) the midpoint. Every branch is continuous
+    // in the inputs, so the trunk cannot jump between the two bounds (it did: 60 deg in one frame).
+    let thD = thLo, thF = thHi;
+    if (this.demand(P, thLo) > 0) {
+      if (this.demand(P, thHi) > 0) thD = thHi;
+      else { let lo = thLo, hi = thHi; for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.demand(P, mid) > 0) lo = mid; else hi = mid; } thD = hi; }
     }
+    if (this.fold(P, thHi) < 0) {
+      if (this.fold(P, thLo) < 0) thF = thLo;
+      else { let lo = thLo, hi = thHi; for (let i = 0; i < 12; i++) { const mid = 0.5 * (lo + hi); if (this.fold(P, mid) < 0) hi = mid; else lo = mid; } thF = lo; }
+    }
+    const thReach = thD <= thF ? clamp(th0, thD, thF) : 0.5 * (thD + thF);
+    // reach gate: the miss at the full-hands posture, the far wrist beyond 0.9 of its reach. The soft IK covers the
+    // last 10 % (about 5 cm), so it is 1 below REACH_OK of miss and 0 past REACH_OK + REACH_BAND. Rate limited:
+    // the hands take the loom over 1/REACH_ON s and let go within 1/REACH_OFF s.
+    const miss = Math.max(0, this.demand(P, thReach));
+    const gateT = 1 - smooth01((miss - REACH_OK) / REACH_BAND);
+    if (!this.primed) this.reachGate = gateT;
+    else this.reachGate += clamp(gateT - this.reachGate, -REACH_OFF * dt, REACH_ON * dt);
+    // blend the posture toward the preference as the hands come off, then keep both legs reachable again
+    const th = th0 + (thReach - th0) * hOn;
+    P.sub(P0).multiplyScalar(hOn).add(P0);
+    for (let s = 0; s < 2; s++) {
+      const hip = _vJ.copy(P).addScaledVector(r, SIGN[s] * 0.1).addScaledVector(u, -0.02);
+      const dv = _vK.subVectors(hip, this.ankle[s]);
+      const vert = dv.dot(u), horiz2 = dv.lengthSq() - vert * vert;
+      const Lmax = (this.TL[s] + this.SL[s]) * 0.985;
+      const maxV = Math.sqrt(Math.max(0, Lmax * Lmax - horiz2));
+      if (vert > maxV) P.addScaledVector(u, maxV - vert);
+    }
 
     // 9. trunk: procedural spine frames (ideal), then the actual blended write. The root is not written: it
     // keeps the clip's pose, and the actual root frame is the parent of the pelvis.
@@ -608,18 +689,24 @@
     // 10. head: look-at within neck limits, 35 % neck / 65 % head. Slumps with fatigue. Solved from the
     // actual chest, then blended.
     this.placeBone(IX.neck);
+    // the actual chest's rule frame: x = its right, y = its up, -z = its forward (whatever the body blend)
+    const Fc = this.chestF.copy(AQ[IX.chest]).multiply(_qa.copy(this.offset[IX.chest]).invert());
+    const cR = this.cR.set(1, 0, 0).applyQuaternion(Fc), cU = this.cU.set(0, 1, 0).applyQuaternion(Fc);
+    const cF = this.cF.set(0, 0, -1).applyQuaternion(Fc);
     const g = _vA;
     if (inp.gazeTarget) g.copy(inp.gazeTarget).sub(X[IX.neck]);
-    else g.copy(bodyFwd).multiplyScalar(2);
-    const gf = g.dot(bodyFwd), gr = g.dot(bodyRight), gu = g.dot(up);
+    else g.copy(cF).multiplyScalar(2).addScaledVector(cU, 2 * Math.tan(th * this.wBodyNow));   // level ahead
+    const gf = g.dot(cF), gr = g.dot(cR), gu = g.dot(cU);
     const hyT = clamp(Math.atan2(-gr, gf), -1.2, 1.2);
-    const hpT = clamp(Math.atan2(gu, Math.hypot(gf, gr)) - th * 0.6 - (inp.driving ? 0.12 * inp.effort : 0) - 0.15 * inp.fatigue, -0.6, 0.5);
+    // elevation in the chest frame, + above. The head takes 60 % of it (the eyes do the rest), so a level target
+    // with the trunk leant by th leaves the head 0.4 th down (as the PoC). Effort and fatigue drop the chin.
+    const elev = Math.atan2(gu, Math.hypot(gf, gr));
+    const hpT = clamp(-0.6 * elev + (inp.driving ? 0.12 * inp.effort : 0) + 0.15 * inp.fatigue, -0.5, 0.6);
     const hy = this.smooth1(this.headYawS, hyT, dt, 6);
     const hp = this.smooth1(this.headPitchS, hpT + 0.03 * n1, dt, 6);
-    const accP = th + this.breath, accY = yawTot;
-    this.headFrame(IX.neck, accP + hp * 0.35, accY + hy * 0.35, _vA, _vB, _qa);
+    this.headFrameRel(IX.neck, hp * 0.35, hy * 0.35);
     this.writeBone(IX.neck, wHead);
-    this.headFrame(IX.head, accP + hp, accY + hy, _vA, _vB, _qa);
+    this.headFrameRel(IX.head, hp, hy);
     this.writeBone(IX.head, wHead);
     this.placeBone(IX.head);
 
@@ -634,7 +721,7 @@
       const hd = this.hd.subVectors(grip, X[iC]);
       hd.addScaledVector(ax, -hd.dot(ax)).normalize();
       hd.lerp(_vA.copy(up).negate(), 0.35).addScaledVector(ax, -hd.dot(ax)).normalize();
-      hd.applyAxisAngle(ax, inp.feather);
+      hd.applyAxisAngle(ax, FEATHER_HAND * inp.feather);
       const wristT = this.wristT[s].copy(grip).addScaledVector(hd, -HAND_LEN);
       // clavicle: protracts toward far targets, up to 25 % when the reach ratio exceeds 0.85
       const armLen = this.UL[s] + this.LL[s];
@@ -651,8 +738,9 @@
       // elbow pole. HARD RULE 3: 0.5*out - 0.2*up - 0.85*back. It must point where the hands never go.
       const pole = this.pole.copy(bodyRight).multiplyScalar(SIGN[s] * 0.5).addScaledVector(up, -0.2).addScaledVector(bodyFwd, -0.85);
       const el = this.el, wr = this.wr;
-      const wPole = this.poleWeight(s, X[iU], wristT, pole, dt);
-      twoBone(X[iU], wristT, this.UL[s], this.LL[s], pole, 0.97, wPole, this.bend[s], el, wr);
+      // fallback pole: elbow down and out (the arm never reaches straight down-and-out while pulling a loom)
+      const pole2 = this.pole2.copy(up).multiplyScalar(-1).addScaledVector(bodyRight, SIGN[s] * 0.4);
+      twoBone(X[iU], wristT, this.UL[s], this.LL[s], pole, 0.97, pole2, el, wr);
       const uDir = _vE.subVectors(el, X[iU]).normalize();
       const lDir = _vF.subVectors(wr, el).normalize();
       const hinge = _vG.crossVectors(uDir, lDir);
@@ -689,8 +777,8 @@
       }
       const pole2 = _vD.copy(f).addScaledVector(r, SIGN[s] * 0.15);
       const kn = _vE, an = _vF;
-      const wPole = this.poleWeight(2 + s, X[iT], ankle, pole2, dt);
-      twoBone(X[iT], ankle, this.TL[s], this.SL[s], pole2, 0.985, wPole, this.bend[2 + s], kn, an);
+      // legs: no guard (the knee pole, forward, never runs along hip-to-ankle); pole2 = pole disables it
+      twoBone(X[iT], ankle, this.TL[s], this.SL[s], pole2, 0.985, pole2, kn, an);
       const uDir = _vG.subVectors(kn, X[iT]).normalize();
       const lDir = _vH.subVectors(an, kn).normalize();
       const hinge = _vI.crossVectors(uDir, lDir);
@@ -714,6 +802,7 @@
     m.pelvisTravel = this.primed ? P.distanceTo(this.pPrev) : 0;
     this.pPrev.copy(P);
     m.reachDeficit = Math.max(0, this.demand(P, th));
+    m.handsEffective = hOn;
     m.footStepping.L = this.stepping[0];
     m.footStepping.R = this.stepping[1];
     for (let s = 0; s < 2; s++) {
@@ -755,17 +844,19 @@
     this.AQ[i].copy(pq).multiply(bone.quaternion);
   }
 
+
+
   /**
-   * Pole guard weight for one limb (0 = its own pole, 1 = its fallback). Target: 0 below |pole.dir| 0.8,
-   * full at 1.0. Rate-limited (POLE_TAU) so the bend cannot jump between frames.
+   * Neck or head: pitch (+ = chin down) and yaw (+ = to the left) on top of the ACTUAL chest frame (cR, cU),
+   * then the rule frame. At rest the neck and head rule frames equal the chest's, so 0, 0 is the rest pose.
    */
-  private poleWeight(k: number, S: V3, T: V3, pole: V3, dt: number): number {
-    _tbDir.subVectors(T, S).normalize();
-    const cosP = Math.abs(pole.dot(_tbDir)) / Math.max(pole.length(), 1e-6);
-    const target = smooth01((cosP - 0.8) / 0.2);
-    if (!this.primed) this.poleW[k] = target;
-    this.poleW[k] += (target - this.poleW[k]) * (1 - Math.exp(-dt / POLE_TAU));
-    return this.poleW[k];
+  private headFrameRel(bone: number, pitch: number, yaw: number): void {
+    _qb.setFromAxisAngle(this.cU, yaw);
+    _qc.setFromAxisAngle(this.cR, -pitch);
+    _qb.multiply(_qc);
+    _vB.copy(this.cU).applyQuaternion(_qb);
+    _vC.copy(this.cR).applyQuaternion(_qb);
+    frameQuat(_vB, _vC, this.W[bone]).multiply(this.offset[bone]);
   }
 
   /** Actual ship-local position of bone i from its actual parent frame and its current local position (the real FK). */
@@ -787,17 +878,8 @@
     return out.copy(_qb).multiply(_qc);
   }
 
-  /** Head or neck orientation: look-at pitch and yaw applied on top of the trunk, then the rule frame. */
-  private headFrame(bone: number, pitch: number, yaw: number, scrY: V3, scrX: V3, scrQ: Q4): void {
-    // same form as rotSeg: Rup(yaw) * Rright(-pitch)
-    _qb.setFromAxisAngle(this.up, yaw);
-    _qc.setFromAxisAngle(this.rT, -pitch);
-    scrQ.copy(_qb).multiply(_qc);
-    scrY.copy(this.up).applyQuaternion(scrQ);
-    scrX.copy(this.rT).applyQuaternion(scrQ);
-    frameQuat(scrY, scrX, this.W[bone]).multiply(this.offset[bone]);
-  }
 
+
   /**
    * Closed-form reach model. Evaluates the ACTUAL blended trunk for pelvis Pp and trunk pitch theta: each segment
    * is the clip local blended with the procedural local (the same blend as the write), so the shoulders are the
```
