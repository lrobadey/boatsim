// PoC of the runtime rower solver (plain JS mirror of the proposed src/crew/rowerRig.ts).
// Everything is solved in SHIP-LOCAL space (the frame OarKinematics uses). The figure's bones are written
// as local quaternions computed from desired ship-local frames; own FK for the handful of points needed.
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** critically damped spring on a scalar (stable at any dt) */
export class Spring {
  constructor(v = 0, w = 10) { this.v = v; this.dv = 0; this.w = w; }
  step(target, dt, w = this.w) {
    const x = this.v - target, k = Math.exp(-w * dt);
    const tmp = (this.dv + w * x) * dt;
    this.v = target + (x + tmp) * k;
    this.dv = (this.dv - w * tmp) * k;
    return this.v;
  }
}
class Spring3 {
  constructor(v, w) { this.x = new Spring(v.x, w); this.y = new Spring(v.y, w); this.z = new Spring(v.z, w); }
  step(t, dt, w, out) { return out.set(this.x.step(t.x, dt, w), this.y.step(t.y, dt, w), this.z.step(t.z, dt, w)); }
}

const _m = new THREE.Matrix4();
/** rotation whose basis is (x, y, z) with y exact, x orthogonalised against y */
function frameQuat(y, xRef, out) {
  const yy = V().copy(y).normalize();
  const xx = V().copy(xRef).addScaledVector(yy, -xRef.dot(yy));
  if (xx.lengthSq() < 1e-10) xx.set(1, 0, 0).addScaledVector(yy, -yy.x);
  xx.normalize();
  const zz = V().crossVectors(xx, yy);
  _m.makeBasis(xx, yy, zz);
  return out.setFromRotationMatrix(_m);
}

/**
 * Analytic two-bone IK with soft extension. Returns the joint (elbow/knee) position.
 * a,b: segment lengths; pole: preferred bend direction (any vector not parallel to S->T).
 */
export function twoBone(S, T, a, b, pole, soft, outJoint, outEnd) {
  const d = V().subVectors(T, S);
  let c = d.length();
  const L = a + b, dir = d.clone().divideScalar(Math.max(c, 1e-6));
  // soft IK: approach full extension asymptotically instead of snapping straight
  const s0 = L * soft;
  if (c > s0) c = s0 + (L - s0) * (1 - Math.exp(-(c - s0) / (L - s0)));
  c = clamp(c, Math.abs(a - b) + 1e-4, L * 0.9999);
  const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const p = V().copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (p.lengthSq() < 1e-8) p.set(0, -1, 0).addScaledVector(dir, dir.y); // fallback bend direction
  p.normalize();
  const sinA = Math.sqrt(1 - cosA * cosA);
  outJoint.copy(S).addScaledVector(dir, a * cosA).addScaledVector(p, a * sinA);
  outEnd.copy(S).addScaledVector(dir, c);
  return outJoint;
}

const ARM = ['clavicle', 'upperarm', 'forearm', 'forearmTwist', 'hand'];
const HAS = (B, n) => !!B[n];
const LEG = ['thigh', 'shin', 'foot'];

export class RowerRig {
  /**
   * root: the figure's top node (contains the armature). Its transform is the ship-local placement of the
   * figure's rest frame; the solver moves bones only (root stays put), so culling bounds stay sane.
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.bones = {};
    root.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    root.updateMatrixWorld(true);
    const B = this.bones;
    // rest data in figure space (root-relative)
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    this.rest = {};
    for (const [n, b] of Object.entries(B)) {
      const m = new THREE.Matrix4().multiplyMatrices(inv, b.matrixWorld);
      const p = V(), q = Q(), s = V();
      m.decompose(p, q, s);
      this.rest[n] = { pos: p, quat: q, local: b.quaternion.clone(), localPos: b.position.clone() };
    }
    const rp = (n) => this.rest[n].pos;
    const len = (a, b) => rp(a).distanceTo(rp(b));
    this.len = {
      upper: len('upperarm_R', 'forearm_R'), lower: len('forearm_R', 'hand_R'), hand: 0.094,
      thigh: len('thigh_R', 'shin_R'), shin: len('shin_R', 'foot_R'),
      trunk: rp('pelvis').distanceTo(rp('upperarm_R').clone().add(rp('upperarm_L')).multiplyScalar(0.5)),
    };
    // Rule frames in the rest pose (figure space; rest figure faces -z, its right is +x, up +y).
    // offset O = F0^-1 * R0 so that R = F * O reproduces rest exactly and skinning sees F*F0^-1.
    const fwd0 = new THREE.Vector3(0, 0, -1), right0 = new THREE.Vector3(1, 0, 0), up0 = new THREE.Vector3(0, 1, 0);
    const childDir = (n, c) => V().subVectors(rp(c), rp(n)).normalize();
    const restY = {
      pelvis: childDir('pelvis', 'spine'), spine: childDir('spine', 'chest'), chest: childDir('chest', 'neck'),
      neck: childDir('neck', 'head'), head: up0.clone(),
    };
    const restX = {};
    for (const n of ['pelvis', 'spine', 'chest', 'neck', 'head']) restX[n] = right0;
    for (const s of ['L', 'R']) {
      restY['clavicle_' + s] = childDir('clavicle_' + s, 'upperarm_' + s);
      restX['clavicle_' + s] = fwd0;
      restY['upperarm_' + s] = childDir('upperarm_' + s, 'forearm_' + s);
      restY['forearm_' + s] = childDir('forearm_' + s, 'hand_' + s);
      // elbow hinge: upper segment down, forearm flexing forward -> cross(down, fwd) = +x
      restX['upperarm_' + s] = restX['forearm_' + s] = right0;
      restY['hand_' + s] = V().subVectors(rp('hand_' + s), rp('forearm_' + s)).normalize(); // hand continues forearm
      restX['hand_' + s] = right0;
      restY['thigh_' + s] = childDir('thigh_' + s, 'shin_' + s);
      restY['shin_' + s] = childDir('shin_' + s, 'foot_' + s);
      restX['thigh_' + s] = restX['shin_' + s] = right0.clone().negate(); // knee: cross(down, back) = -x
      restY['foot_' + s] = new THREE.Vector3(0, -0.04, -0.19).normalize();
      restX['foot_' + s] = right0;
    }
    // rule y must be the bone's own +Y (points at its child) for every bone, so take it from the bone
    for (const n of Object.keys(restY)) restY[n] = new THREE.Vector3(0, 1, 0).applyQuaternion(this.rest[n].quat);
    // trunk segments in body components (right, up, fwd) so the reach model matches the FK exactly
    const comp = (a, b) => { const o = V().subVectors(rp(b), rp(a)); return new THREE.Vector3(o.dot(right0), o.dot(up0), o.dot(fwd0)); };
    this.restSeg = { ps: comp('pelvis', 'spine'), sc: comp('spine', 'chest'), cS: { L: comp('chest', 'upperarm_L'), R: comp('chest', 'upperarm_R') } };
    this.offset = {};
    for (const n of Object.keys(restY)) {
      const F0 = frameQuat(restY[n], restX[n], Q());
      this.offset[n] = F0.invert().multiply(this.rest[n].quat);
    }
    // state
    this.world = {};  // ship-local world quats of solved bones this frame
    this.wpos = {};
    for (const n of [...Object.keys(B), 'forearmTwist_L', 'forearmTwist_R']) { this.world[n] = Q(); this.wpos[n] = V(); }
    this.pelvisS = null;
    this.pitch = new Spring(0, 10);
    this.yaw = new Spring(0, 8);
    this.headYaw = new Spring(0, 6); this.headPitch = new Spring(0, 6);
    this.balance = null;
    this.drop = new Spring(0, 9);
    this.seed = opts.seed ?? 1;
    this.minimalTwist = !!opts.minimalTwist;
    this.t = 0;
    this.feet = null;   // planted foot state, set by setStance
    this.debug = {};
  }

  /** figure root ship-local matrix (position on deck, facing) */
  rootMatrix() { return this.root.matrixWorld; }

  /** Place the stance: ankle targets for both feet and the facing (ship-local). */
  setStance(center, facing, deckUp, splitFwd = 0.34, splitBack = 0.30, width = 0.17) {
    const f = facing.clone().normalize(), u = deckUp.clone().normalize();
    const r = V().crossVectors(f, u).normalize();
    const ankleH = 0.08;
    // left foot forward (toward the facing) for a starboard sweep is arbitrary; take a parameter
    const mk = (side, along) => ({
      ankle: center.clone().addScaledVector(r, side * width).addScaledVector(f, along).addScaledVector(u, ankleH),
      planted: null, stepT: -1, from: V(), to: V(), heel: 0,
    });
    this.stance = { center: center.clone(), f, u, r, d0: 0.32,
      pelvisRange: { front: splitFwd * 0.8, back: splitBack * 0.8 } };
    this.feet = { L: mk(-1, splitFwd), R: mk(1, -splitBack) };
    for (const s of ['L', 'R']) this.feet[s].planted = this.feet[s].ankle.clone();
  }

  /**
   * Main solve. inp:
   *  gripL, gripR: ship-local hand targets on the loom (point on the loom axis)
   *  loomAxis: unit, outboard; feather: loom roll (rad)
   *  effort 0..1; driving: bool (blade loaded); gaze: ship-local point
   *  worldUp: ship-local direction of world up (balance); heaveAcc: deck vertical accel (m/s^2)
   *  ikWeight: 0..1 (hands on the loom)
   */
  solve(inp, dt) {
    this.t += dt;
    const B = this.bones, L = this.len, st = this.stance;
    const { f, u, r } = st;
    const H = V().addVectors(inp.gripL, inp.gripR).multiplyScalar(0.5);
    const rel = V().subVectors(H, st.center);
    const d = rel.dot(f), lat = rel.dot(r), hgt = rel.dot(u);

    // ---- balance: the trunk keeps 70% of world vertical against roll/pitch, with a reaction lag
    const upB = V().copy(u).lerp(inp.worldUp, 0.7).normalize();
    if (!this.balance) this.balance = new Spring3(upB, 4);
    const up = this.balance.step(upB, dt, 4, V()).normalize();

    // ---- trunk yaw: square the shoulders to the loom (shoulder line ~ loom direction)
    const fT = V().copy(f).addScaledVector(up, -f.dot(up)).normalize();
    const rT = V().crossVectors(fT, up);
    const gl = V().subVectors(inp.gripR, inp.gripL); gl.addScaledVector(up, -gl.dot(up));
    const yawT = clamp(0.55 * Math.atan2(gl.dot(fT), gl.dot(rT)), -0.6, 0.6) + clamp(0.25 * lat, -0.2, 0.2);
    const yaw = this.yaw.step(yawT, dt);

    // ---- reach demand model: rigid trunk pitched by theta about the body's right axis, real rest
    // shoulder offsets; returns how far the more demanding arm is beyond its desired extension
    const catchness = smooth01((d - 0.1) / 0.9);
    const armLen = L.upper + L.lower;
    const RATIO_MAX = 0.9, RATIO_MIN = 0.5;    // arm extension bounds (shoulder->wrist / arm length)
    const qYaw = Q().setFromAxisAngle(up, yaw);
    const toW = (c) => V().copy(rT).multiplyScalar(c.x).addScaledVector(up, c.y).addScaledVector(fT, c.z);
    const segPS = toW(this.restSeg.ps), segSC = toW(this.restSeg.sc);
    const segCS = { L: toW(this.restSeg.cS.L), R: toW(this.restSeg.cS.R) };
    const PF = [0.3, 0.7, 1.0], YF = [0.25, 0.6, 1.0];   // cumulative pitch / yaw fractions (match the FK below)
    const _q1 = Q(), _q2 = Q(), _q3 = Q(), _t = V();
    const segQ = (out, k, theta) => out.setFromAxisAngle(rT, -theta * PF[k]).premultiply(_t.set(0, 0, 0) && Q().setFromAxisAngle(up, yaw * YF[k]));
    const wristGuess = { L: inp.gripL.clone().addScaledVector(up, L.hand * 0.8), R: inp.gripR.clone().addScaledVector(up, L.hand * 0.8) };
    const _q = Q(), _S = V();
    // demand > 0: the farther arm is beyond RATIO_MAX; fold < 0: the nearer arm is folded past RATIO_MIN
    let foldV = 0;
    const demand = (Pp, theta) => {
      segQ(_q1, 0, theta); segQ(_q2, 1, theta); segQ(_q3, 2, theta);
      const chestP = V().copy(segPS).applyQuaternion(_q1).add(Pp).add(V().copy(segSC).applyQuaternion(_q2));
      let worst = -1e9, near = 1e9;
      for (const s of ['L', 'R']) {
        _S.copy(segCS[s]).applyQuaternion(_q3).add(chestP);
        const dd = _S.distanceTo(wristGuess[s]);
        worst = Math.max(worst, dd - RATIO_MAX * armLen);
        near = Math.min(near, dd - RATIO_MIN * armLen);
      }
      foldV = near;
      return worst;
    };
    const fold = (Pp, theta) => { demand(Pp, theta); return foldV; };
    const TH_MIN = -0.42, TH_MAX = 0.9, TH_COMFORT = 0.62, TH_UPRIGHT = -0.15;

    // ---- pelvis: shifts along the stance with the handle (legs carry the long part of the stroke)
    const sp = st.pelvisRange;              // travel limits toward the front / back foot
    const d0 = st.d0;
    const x = 0.6 * (d - d0);
    let pf = x > 0 ? sp.front * Math.tanh(x / sp.front) : sp.back * Math.tanh(x / sp.back);
    const pl = clamp(0.3 * lat, -0.1, 0.1);
    const tilt = V().subVectors(up, u);
    const base = st.center.clone().addScaledVector(r, pl).addScaledVector(u, 0.94 - 0.03).addScaledVector(tilt, 0.45);
    // hips drop as the stance is loaded and spread; heave acceleration flexes the knees (spring)
    const spread = pf > 0 ? pf / sp.front : -pf / sp.back;
    const drop = this.drop.step(0.035 * inp.effort + 0.10 * spread * spread + 0.01 * clamp(inp.heaveAcc ?? 0, -3, 3), dt);
    const target = base.addScaledVector(fT, pf).addScaledVector(u, -drop);
    // Preferred posture is smoothed (organic lag); reach constraints below are applied AFTER smoothing,
    // un-smoothed, so the hands never lag off the loom. Constraints are continuous in the handle
    // position, so applying them instantly cannot pop.
    if (!this.pelvisS) this.pelvisS = new Spring3(target, 12);
    const P = this.pelvisS.step(target, dt, inp.driving ? 14 : 10, V());
    // legs make up what a comfortable lean can't: push the hips toward the handle (catch) or away from
    // it (finish: hands would run into the belly), up to the stance limits
    const over = demand(P, TH_COMFORT);
    let comp = 0;
    if (over > 0) comp = Math.min(sp.front + 0.12 - pf, over * 1.1);
    else { const under = fold(P, TH_UPRIGHT); if (under < 0) comp = Math.max(-sp.back - 0.1 - pf, under * 0.8); }
    P.addScaledVector(fT, comp);
    pf += comp;
    // keep both legs reachable: cap the pelvis height above each ankle (also un-smoothed)
    for (const s of ['L', 'R']) {
      const hipOff = s === 'R' ? 1 : -1;
      const hip = P.clone().addScaledVector(r, hipOff * 0.1).addScaledVector(u, -0.02);
      const a = this.feet[s].planted;
      const dv = V().subVectors(hip, a);
      const vert = dv.dot(u), horiz2 = dv.lengthSq() - vert * vert;
      const Lmax = (L.thigh + L.shin) * 0.985;
      const maxV = Math.sqrt(Math.max(0, Lmax * Lmax - horiz2));
      if (vert > maxV) P.addScaledVector(u, maxV - vert);
    }

    // ---- trunk pitch: a preferred posture from the handle position (body over at the catch, laid back
    // at the finish, thrown back harder under load), smoothed; then bounded by reach: lean further only
    // if the far arm can't reach, sit back further only if the near arm would fold. Bisection each way.
    const thPref = this.pitch.step(-0.22 + 0.72 * catchness + (inp.driving ? -0.12 * inp.effort : 0.05), dt);
    let th = clamp(thPref, TH_MIN, TH_MAX);
    if (demand(P, th) > 0) {
      if (demand(P, TH_MAX) >= 0) th = TH_MAX;
      else { let lo = th, hi = TH_MAX; for (let i = 0; i < 12; i++) { const m = 0.5 * (lo + hi); if (demand(P, m) > 0) lo = m; else hi = m; } th = hi; }
    } else if (fold(P, th) < 0) {
      if (fold(P, TH_MIN) < 0) th = TH_MIN;
      else { let lo = TH_MIN, hi = th; for (let i = 0; i < 12; i++) { const m = 0.5 * (lo + hi); if (fold(P, m) < 0) hi = m; else lo = m; } th = lo; }
    }
    this.debug.reachDeficit = Math.max(0, demand(P, TH_MAX));

    // secondary: breath (exhale in the drive) and per-rower idle noise
    const n1 = Math.sin(this.t * 1.3 + this.seed * 2.1) * 0.5 + Math.sin(this.t * 0.71 + this.seed) * 0.5;
    const breath = 0.03 * Math.sin(this.t * 2.2 + this.seed) - (inp.driving ? 0.02 * inp.effort : 0);

    // ---- write the spine chain: pitch distributed 30/40/30, yaw 25/35/40
    const W = this.world, X = this.wpos;
    const rootQ = Q(), rootP = V(), rootS = V();
    this.root.matrixWorld.decompose(rootP, rootQ, rootS);
    // rest spine frames are vertical; build each segment's desired up/right
    let accPitch = 0, accYaw = 0;
    const segs = [['pelvis', 0.3, 0.25], ['spine', 0.4, 0.35], ['chest', 0.3, 0.4]];
    X.pelvis.copy(P);
    let parentQ = rootQ.clone();
    // the root bone (non-deforming) keeps the figure root transform; pelvis is positioned directly
    W.root.copy(rootQ.clone().multiply(this.rest.root.quat));
    parentQ = W.root;
    let pos = P.clone();
    for (const [n, pf2, yf] of segs) {
      accPitch += th * pf2 + (n === 'chest' ? breath : 0);
      accYaw += yaw * yf;
      const q = Q().setFromAxisAngle(rT, -accPitch).premultiply(Q().setFromAxisAngle(up, accYaw));
      // rule frame: y = segment up, x = body right
      const y = up.clone().applyQuaternion(q);
      const xr = rT.clone().applyQuaternion(q);   // body right (rest figure +x); rT = f x up
      frameQuat(y, xr, W[n]).multiply(this.offset[n]);
      X[n].copy(pos);
      const childLen = n === 'pelvis' ? this.rest.spine.pos.distanceTo(this.rest.pelvis.pos)
        : n === 'spine' ? this.rest.chest.pos.distanceTo(this.rest.spine.pos) : 0;
      pos = pos.clone().addScaledVector(y, childLen);
    }
    // helper: world position of a child bone from its parent's world frame and rest local offset
    const childPos = (parent, child) => {
      const lp = this.rest[child].localPos.clone().multiply(rootS);
      return lp.applyQuaternion(W[parent]).add(X[parent]);
    };
    X.spine.copy(childPos('pelvis', 'spine'));
    X.chest.copy(childPos('spine', 'chest'));

    // ---- arms
    const sideSign = { R: 1, L: -1 };
    const bodyRight = rT.clone().applyQuaternion(Q().setFromAxisAngle(up, accYaw));
    const bodyFwd = fT.clone().applyQuaternion(Q().setFromAxisAngle(up, accYaw));
    this.debug.err = {};
    for (const s of ['L', 'R']) {
      const grip = s === 'L' ? inp.gripL : inp.gripR;
      const c = 'clavicle_' + s, ua = 'upperarm_' + s, fa = 'forearm_' + s, tw = 'forearmTwist_' + s, h = 'hand_' + s;
      X[c].copy(childPos('chest', c));
      // hand direction: from over the loom, wrapping it (overhand), rolled with the feather
      const ax = inp.loomAxis.clone();
      let hd = V().subVectors(grip, X[c]); hd.addScaledVector(ax, -hd.dot(ax)).normalize();
      hd.lerp(up.clone().negate(), 0.35).addScaledVector(ax, -hd.dot(ax)).normalize();
      hd.applyAxisAngle(ax, (inp.feather ?? 0) * sideSign[s] * 0.0 + (inp.feather ?? 0));
      const wristT = grip.clone().addScaledVector(hd, -L.hand);
      // clavicle: protract / elevate up to ~14 deg toward far targets
      // clavicle's rest orientation carried by the chest (its parent), then its +Y
      const clavRestW = W.chest.clone().multiply(this.rest.chest.quat.clone().invert().multiply(this.rest[c].quat));
      const restClavY = new THREE.Vector3(0, 1, 0).applyQuaternion(clavRestW);
      const clavLen = this.rest[ua].localPos.length() * rootS.x;
      const sh0 = X[c].clone().addScaledVector(restClavY, clavLen);
      const need = sh0.distanceTo(wristT) / (L.upper + L.lower);
      const k = smooth01((need - 0.85) / 0.2) * 0.25;
      const clavY = restClavY.clone().lerp(V().subVectors(wristT, X[c]).normalize(), k).normalize();
      frameQuat(clavY, bodyFwd, W[c]).multiply(this.offset[c]);
      X[ua].copy(X[c]).addScaledVector(clavY, clavLen);
      // elbows: out to the side, down, and a little back
      const pole = bodyRight.clone().multiplyScalar(sideSign[s] * 0.5).addScaledVector(up, -0.2).addScaledVector(bodyFwd, -0.85);
      const el = V(), wr = V();
      twoBone(X[ua], wristT, L.upper, L.lower, pole, 0.97, el, wr);
      const uDir = V().subVectors(el, X[ua]).normalize(), lDir = V().subVectors(wr, el).normalize();
      let hinge = V().crossVectors(uDir, lDir);
      if (hinge.lengthSq() < 1e-6) hinge.crossVectors(uDir, pole.clone().negate()); // straight arm: from pole
      hinge.normalize();
      frameQuat(uDir, hinge, W[ua]).multiply(this.offset[ua]);
      frameQuat(lDir, hinge, W[fa]).multiply(this.offset[fa]);
      X[fa].copy(el);
      X[h].copy(wr);
      // hand: y along hd, x = loom axis signed to the body's right
      const hxLoom = ax.clone().multiplyScalar(Math.sign(ax.dot(bodyRight)) || 1);
      // minimal-twist mode: carry the elbow hinge onto the hand (parallel transport) instead of the loom axis
      const hx = this.minimalTwist ? hinge.clone() : hxLoom;
      frameQuat(hd, hx, W[h]).multiply(this.offset[h]);
      // twist bone: half the hand's twist about the forearm axis
      const qRelHand = W[fa].clone().invert().multiply(W[h]);            // hand relative to forearm (local)
      const restRel = this.rest[fa].quat.clone().invert().multiply(this.rest[h].quat);
      const delta = qRelHand.clone().multiply(restRel.clone().invert());  // change vs rest, forearm-local
      const axisL = new THREE.Vector3(0, 1, 0);                           // bone local +Y = forearm axis
      const pr = V(delta.x, delta.y, delta.z).projectOnVector(axisL);
      const twist = new THREE.Quaternion(pr.x, pr.y, pr.z, delta.w).normalize();
      const halfTwist = Q().slerpQuaternions(Q(), twist, 0.5);
      this.twistAngle = this.twistAngle || {};
      this.twistAngle[s] = 2 * Math.acos(clamp(Math.abs(twist.w), 0, 1));
      if (B[tw]) W[tw].copy(W[fa]).multiply(this.rest[fa].quat.clone().invert().multiply(this.rest[tw].quat)).multiply(halfTwist);
      if (B[tw]) X[tw].copy(childPos(fa, tw));
      // error: wrist reached vs target (soft IK / reach limits)
      this.debug.err[s] = wr.distanceTo(wristT);
      this.debug['ext' + s] = X[ua].distanceTo(wristT) / (L.upper + L.lower);
      { segQ(_q1, 0, th); segQ(_q2, 1, th); segQ(_q3, 2, th);
        const chestP = V().copy(segPS).applyQuaternion(_q1).add(P).add(V().copy(segSC).applyQuaternion(_q2));
        const Sm = V().copy(segCS[s]).applyQuaternion(_q3).add(chestP);
        this.debug['shErr' + s] = Sm.distanceTo(sh0); if (process.env.DBGS && s === 'L') console.log('Sm', Sm.toArray().map(v=>v.toFixed(3)), 'sh0', sh0.toArray().map(v=>v.toFixed(3)), 'Xchest', X.chest.toArray().map(v=>v.toFixed(3)), 'chestP', chestP.toArray().map(v=>v.toFixed(3)), 'P', P.toArray().map(v=>v.toFixed(3))); this.debug['pelErr'] = P.distanceTo(X.pelvis); this.debug['wgErr' + s] = wristGuess[s].distanceTo(wristT); }
    }

    // ---- head: look at the gaze target within neck limits, 35% neck / 65% head
    X.neck.copy(childPos('chest', 'neck'));
    const g = V().subVectors(inp.gaze, X.neck);
    const gf = g.dot(bodyFwd), gr = g.dot(bodyRight), gu = g.dot(up);
    const hyT = clamp(Math.atan2(-gr, gf), -1.2, 1.2);
    const hpT = clamp(Math.atan2(gu, Math.hypot(gf, gr)) - th * 0.6 - (inp.driving ? 0.12 * inp.effort : 0), -0.6, 0.5);
    const hy = this.headYaw.step(hyT, dt), hp = this.headPitch.step(hpT + 0.03 * n1, dt);
    for (const [n, frac] of [['neck', 0.35], ['head', 1.0]]) {
      const q = Q().setFromAxisAngle(rT, -(accPitch + hp * frac)).premultiply(Q().setFromAxisAngle(up, accYaw + hy * frac));
      frameQuat(up.clone().applyQuaternion(q), rT.clone().applyQuaternion(q), W[n]).multiply(this.offset[n]);
      if (n === 'neck') X.head.copy(childPos('neck', 'head'));
    }

    // ---- legs: planted feet, two-bone IK, heel lift when the leg runs out of length
    this.debug.footSlide = 0;
    for (const s of ['L', 'R']) {
      const th_ = 'thigh_' + s, sh = 'shin_' + s, ft = 'foot_' + s;
      X[th_].copy(childPos('pelvis', th_));
      const foot = this.feet[s];
      const ankle = foot.planted.clone();
      const toeFwd = f.clone();
      const toe = ankle.clone().addScaledVector(toeFwd, 0.17).addScaledVector(u, -0.05);
      // heel lift: rotate the ankle about the toe until the leg can reach (closed form, 2 iterations)
      const Lleg = L.thigh + L.shin;
      let heel = 0;
      for (let i = 0; i < 2; i++) {
        const dist = X[th_].distanceTo(ankle);
        if (dist <= Lleg * 0.99) break;
        heel += Math.min(0.6, (dist - Lleg * 0.99) / 0.17);
        const off = V().subVectors(foot.planted, toe);
        ankle.copy(toe).add(off.applyAxisAngle(r, -heel * Math.sign(off.dot(f)) * -1));
      }
      foot.heel = heel;
      const pole = toeFwd.clone().addScaledVector(r, (s === 'R' ? 1 : -1) * 0.15);
      const kn = V(), an = V();
      twoBone(X[th_], ankle, L.thigh, L.shin, pole, 0.985, kn, an);
      const uDir = V().subVectors(kn, X[th_]).normalize(), lDir = V().subVectors(an, kn).normalize();
      let hinge = V().crossVectors(uDir, lDir);
      if (hinge.lengthSq() < 1e-6) hinge.crossVectors(uDir, pole);
      hinge.normalize();
      frameQuat(uDir, hinge, W[th_]).multiply(this.offset[th_]);
      frameQuat(lDir, hinge, W[sh]).multiply(this.offset[sh]);
      X[sh].copy(kn); X[ft].copy(an);
      frameQuat(V().subVectors(toe, an).normalize(), r, W[ft]).multiply(this.offset[ft]);
      this.debug.footSlide = Math.max(this.debug.footSlide, an.distanceTo(ankle));
    }
    this.debug.pitch = th; this.debug.yaw = yaw; this.debug.pelvisFwd = pf; this.debug.d = d;

    // ---- write local quaternions (parent world^-1 * world); pelvis also gets its position
    const order = ['root', 'pelvis', 'spine', 'chest', 'neck', 'head'];
    for (const s of ['L', 'R']) order.push(...ARM.map((a) => a + '_' + s), ...LEG.map((a) => a + '_' + s));
    for (const n of order) {
      const b = B[n];
      if (n === 'root' || !b) continue;
      const par = b.parent.isBone ? W[b.parent.name] : rootQ;
      b.quaternion.copy(par).invert().multiply(W[n]);
    }
    // pelvis position: in root-bone local space
    const rootBoneM = new THREE.Matrix4().compose(V(), W.root, V(1, 1, 1));
    const rootBoneWorldP = this.bones.root.getWorldPosition(V());
    const lp = V().subVectors(P, rootBoneWorldP).applyQuaternion(W.root.clone().invert()).divide(rootS);
    B.pelvis.position.copy(lp);
    void rootBoneM;
  }
}
