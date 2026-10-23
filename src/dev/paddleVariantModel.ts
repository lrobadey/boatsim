import * as THREE from 'three';
import { buildRoyalRowers } from './royalRowers';
import { buildLongPaddles } from './longPaddleModel';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../gfx/shared';
import { LAYER_REFRACT } from '../core/pipeline';
import { PADDLE_VARIANTS, type PaddleVariantId } from './paddleVariants';

/** Metre-scale carpenter-built assemblies, batched by material per moving part. Game axes. */
export function buildPaddleVariant(id: PaddleVariantId) {
  return id === 'basileus' ? buildRoyalRowers() : id === 'helios' ? buildWheelVariant(id) : buildLongPaddles(id);
}
function buildWheelVariant(id: PaddleVariantId) {
  const v = PADDLE_VARIANTS[id], g = v.geometry, group = new THREE.Group();
  group.name = `Paddles_${id}`;
  const materials = [v.wood, v.blade, v.accent, 0x9a7742, 0xd6c69d].map((color, i) =>
    patchMaterial(new THREE.MeshStandardMaterial({ color, roughness: i === 3 ? .48 : .76, metalness: i === 3 ? .65 : 0 })));
  let totalMass = 0, rotorMass = 0, rotorInertia = 0;
  // Integrate each closed component as signed tetrahedra. Densities: timber 650,
  // bronze 8700 kg/m³; ivory/green/red are painted timber, not solid metal.
  function budget(geometry: THREE.BufferGeometry, material: number, rotating: boolean) {
    const p = geometry.getAttribute('position'), idx = geometry.index!;
    let volume = 0, polar = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(p, idx.getX(i)); b.fromBufferAttribute(p, idx.getX(i + 1)); c.fromBufferAttribute(p, idx.getX(i + 2));
      const dv = a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
      volume += dv;
      for (const k of ['y', 'z'] as const) polar += dv / 10 *
        (a[k] ** 2 + b[k] ** 2 + c[k] ** 2 + a[k] * b[k] + a[k] * c[k] + b[k] * c[k]);
    }
    const density = material === 3 ? 8700 : 650, mass = Math.abs(volume) * density;
    totalMass += mass;
    if (rotating) { rotorMass += mass / 2; rotorInertia += Math.abs(polar) * density / 2; }
  }
  function batch(parent: THREE.Group, rotating = false) {
    const buckets: THREE.BufferGeometry[][] = materials.map(() => []);
    function add(geometry: THREE.BufferGeometry, m: number, pos: THREE.Vector3, q = new THREE.Quaternion()) {
      geometry.applyMatrix4(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
      budget(geometry, m, rotating); buckets[m].push(geometry);
    }
    return {
      box(x: number, y: number, z: number, w: number, h: number, d: number, m: number, angle = 0) {
        add(new THREE.BoxGeometry(w, h, d), m, new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle));
      },
      rod(a: number[], b: number[], radius: number, m: number) {
        const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from);
        add(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), m, from.add(to).multiplyScalar(.5),
          new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
      },
      ring(x: number, r: number, thick: number, m: number) {
        add(new THREE.TorusGeometry(r, thick, 6, 64), m, new THREE.Vector3(x, 0, 0),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      },
      finish() {
        buckets.forEach((items, m) => {
          if (!items.length) return;
          const geometry = mergeGeometries(items); items.forEach(item => item.dispose());
          const mesh = new THREE.Mesh(geometry, materials[m]); mesh.castShadow = mesh.receiveShadow = true;
          mesh.layers.enable(LAYER_REFRACT); parent.add(mesh);
        });
      },
    };
  }
  const fixed = batch(group), rotors: THREE.Group[] = [], capstans: THREE.Group[][] = [[], []];
  for (const side of [-1, 1]) {
    const rotor = new THREE.Group(); rotor.name = side < 0 ? 'Paddle_port_rotor' : 'Paddle_starboard_rotor';
    rotor.position.set(side * g.x, g.y, g.z); group.add(rotor); rotors.push(rotor);
    const b = batch(rotor, true), half = g.width / 2, face = side * (half + .16);
    b.rod([side * (10.6 - g.x), 0, 0], [side * (half + .45), 0, 0], g.axleDiameter! / 2, 0);
    const gearX = side * (10.9 - g.x);
    b.rod([gearX - .16, 0, 0], [gearX + .16, 0, 0], 1.0, 0);
    for (let tooth = 0; tooth < 24; tooth++) {
      const t = tooth * Math.PI / 12;
      b.box(gearX, 1.08 * Math.cos(t), 1.08 * Math.sin(t), .32, .22, .13, 1, t);
    }
    for (const dx of [-half + .14, half - .14]) {
      b.ring(dx, g.radius - .33, id === 'polypous' ? .22 : .13, 0);
      b.ring(dx, g.radius - .49, .045, 3);
      for (let i = 0; i < g.blades; i++) {
        const t = i * Math.PI * 2 / g.blades, c = Math.cos(t), s = Math.sin(t);
        b.rod([dx, .4 * c, .4 * s], [dx, g.radius * c, g.radius * s], id === 'polypous' ? .17 : .095, id === 'scarab' ? 4 : 0);
        b.rod([dx - .15, (g.radius - .33) * c, (g.radius - .33) * s],
          [dx + .15, (g.radius - .33) * c, (g.radius - .33) * s], .07, 3);
        if (id === 'helios') {
          b.rod([dx, 1.1 * c, 1.1 * s], [dx, 3.6 * Math.cos(t + .23), 3.6 * Math.sin(t + .23)], .055, 3);
        }
      }
    }
    for (let i = 0; i < g.blades; i++) {
      const t = i * Math.PI * 2 / g.blades, c = Math.cos(t), s = Math.sin(t);
      // These flat radial boards exactly match force sample centres, width and radial height.
      for (let plank = 0; plank < 3; plank++) {
        b.box((plank - 1) * g.width / 3, g.radius * c, g.radius * s,
          g.width / 3, g.bladeHeight, .12, 1, t);
      }
      for (const x of [-half + .15, half - .15]) b.box(x, g.radius * c, g.radius * s, .035, g.bladeHeight + .02, .14, 3, t);
      if (id === 'polypous') b.rod([-half, (g.radius - .8) * c, (g.radius - .8) * s],
        [half, (g.radius - .8) * Math.cos(t + Math.PI / 4), (g.radius - .8) * Math.sin(t + Math.PI / 4)], .11, 0);
    }
    // Oversized outward medallions give each machine a readable identity at ship scale.
    const bossRadius = id === 'polypous' ? 1.2 : .85;
    b.rod([face - .08, 0, 0], [face + .08, 0, 0], bossRadius, 2);
    b.ring(face + side * .1, bossRadius, .065, 3);
    if (id === 'helios') {
      b.rod([face, 0, 0], [face + side * .16, 0, 0], .42, 3);
      for (let i = 0; i < 16; i++) {
        const t = i * Math.PI / 8;
        b.rod([face, 1.05 * Math.cos(t), 1.05 * Math.sin(t)], [face, 2.25 * Math.cos(t + .09), 2.25 * Math.sin(t + .09)], .075, 3);
      }
    } else if (id === 'polypous') {
      for (const z of [-.5, 0, .5]) {
        b.rod([face + side * .12, -.7, z], [face + side * .12, .65, z], .07, 3);
        b.rod([face + side * .12, .65, z], [face + side * .12, .85, z + .15], .065, 3);
      }
      b.rod([face + side * .12, -.4, -.5], [face + side * .12, -.4, .5], .07, 3);
    } else {
      for (const direction of [-1, 1]) for (let i = 0; i < 7; i++) {
        const t = -.9 + i * .28;
        b.box(face + side * .12, .62 * Math.sin(t), direction * .52 * Math.cos(t), .06, .24, .11, 4, direction * (t + .7));
      }
    }
    const probe = new THREE.Object3D(); probe.name = side < 0 ? 'Paddle_port_blade_probe' : 'Paddle_starboard_blade_probe';
    probe.position.set(0, g.radius, 0); rotor.add(probe); b.finish();
    // Outer bearing carried by open timber trestles beyond the swept blade width.
    const outer = side * (g.x + half + .45), span = g.radius + .7;

    for (const dz of [-span, span]) {
      fixed.box((side * 10.6 + outer) / 2, 5.8, g.z + dz, Math.abs(outer - side * 10.6), .35, .38, 0);
      fixed.rod([outer, g.y, g.z], [outer, 5.8, g.z + dz], .28, 0);
      fixed.rod([side * 10.6, 1.4, g.z + dz], [outer, 5.8, g.z + dz], .16, 0);
      fixed.box((side * 10.6 + outer) / 2, 6.08, g.z + dz, Math.abs(outer - side * 10.6), .32, .14, 2);
      fixed.rod([outer, 5.8, g.z + dz], [outer, 7.05, g.z + dz], .075, 0);
    }
    fixed.rod([outer, 7.05, g.z - span], [outer, 7.05, g.z + span], .075, 0);
    fixed.box(side * 10.9, 4.55, g.z, .95, .35, 2.5, 2);
    for (const dz of [-1, 1]) fixed.box(side * 10.9, 4.55, g.z + dz, 1, .4, .012, 3);
    // Small temple-like pediment over the transmission chest.
    fixed.rod([side * 10.9, 5.65, g.z - 1.45], [side * 10.9, 6.3, g.z], .12, 0);
    fixed.rod([side * 10.9, 6.3, g.z], [side * 10.9, 5.65, g.z + 1.45], .12, 0);
    // Four linked walking capstans per side. 20 people/capstan at design watch.
    // Bars sweep 4 m diameter; the bank is clear of the centreline masts.
    for (const z of [-9, -2, 5, 12]) {
      const cx = side * 6;
      const capstan = new THREE.Group(); capstan.position.set(cx, 5.55, z); group.add(capstan);
      const cb = batch(capstan);
      cb.rod([0, 0, 0], [0, 1.05, 0], .24, 0);
      cb.rod([-2, .95, 0], [2, .95, 0], .075, 0);
      cb.rod([0, .95, -2], [0, .95, 2], .075, 0);
      cb.rod([0, .15, 0], [0, .3, 0], .65, 0); cb.finish();
      capstans[side < 0 ? 0 : 1].push(capstan);
      if (z < 12) fixed.rod([cx, 5.8, z], [cx, 5.8, z + 7], .14, 0);
    }
    fixed.rod([side * 6, 5.8, g.z], [side * 10.9, 5.8, g.z], .18, 0);
    fixed.rod([side * 10.9, g.y, g.z], [side * 10.9, 5.8, g.z], .22, 0);
  }
  fixed.finish();
  return { group, rotors, capstans, animate(angles: number[]) {
    rotors.forEach((r,i) => r.rotation.x = angles[i]);
    capstans.forEach((bank,i) => bank.forEach(c => c.rotation.y = -angles[i]/1.5));
  }, engineering: {
    rotorMass, rotorInertia, visibleMass: totalMass,
    // Explicit allowance for hidden gears, deck reinforcement and bearings (not workers).
    machineryMass: totalMass + 8000,
  } };
}

export function disposePaddleVariant(group: THREE.Group) {
  const materials = new Set<THREE.Material>();
  group.traverse(o => { if (o instanceof THREE.Mesh) {
    o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
  } });
  materials.forEach(m => m.dispose());
}
