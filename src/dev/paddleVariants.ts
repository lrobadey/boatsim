import { ROYAL_OAR_AREA } from './royalOarProfile';
/** Speculative ancient machinery; geometry is shared by rendering and the water solver. */
export interface PaddleGeometry {
  mechanism?: 'wheel' | 'sweeps' | 'chain' | 'oars';
  x: number; y: number; z: number; radius: number; width: number; bladeHeight: number;
  areaFactor?: number; outboard?: number; inboard?: number; rowlockX?: number;
  trackHalfLength?: number;
  axleDiameter?: number; rotorMass?: number;
  blades: number; inertia: number; cd: number; maxTorque: number; maxOmega: number;
  gearEfficiency: number; machineryMass: number;
}
export const PADDLE_VARIANTS = {
  helios: {
    name: 'Helios', subtitle: 'The sun wheel',
    description: 'Cedar spokes, bronze sunburst and oxblood galleries. A tall, deliberate royal machine.',
    feel: 'Large radius · slow cadence · deep bite',
    geometry: { x: 14.1, y: 3.0, z: 3, radius: 4.7, width: 2.8, bladeHeight: .85,
      axleDiameter: .8, blades: 12, cd: 1.65, maxTorque: 15600, maxOmega: .6, gearEfficiency: .78 },
    wood: 0x65412a, blade: 0xb48a50, accent: 0x782c25,
  },
  polypous: {
    name: 'Polypous', subtitle: 'The walking oars',
    description: 'Eight jointed sweeps per side along 56 metres of hull. Timber crankshafts make a travelling wave of submerged pushes and lifted returns.',
    feel: 'Articulated legs · pulsed thrust · long rowing galleries',
    geometry: { mechanism: 'sweeps', x: 15.8, y: 1, z: 0, radius: 2.8, width: 1.6, bladeHeight: 1.5,
      axleDiameter: .65, blades: 8, cd: 1.65, maxTorque: 14400, maxOmega: .72, gearEfficiency: .72 },
    wood: 0x775031, blade: 0xc6a16b, accent: 0x782c25,
  },
  basileus: {
    name: 'Polypous Basileus', subtitle: 'The royal rowing engine',
    description: 'Eight giant mechanical rowers per side. Rigid cedar oars pivot in bronze rowlocks; broad trident-crowned blades lift and feather on the staggered return.',
    feel: 'Monumental oars · feathered return · staggered mechanical crew',
    geometry: { mechanism: 'oars', x: 19, rowlockX: 10.8, y: 5.8, z: 0, outboard: 10.2, inboard: 3,
      radius: .42, width: 2.2, bladeHeight: 4.0, areaFactor: ROYAL_OAR_AREA, axleDiameter: .75,
      blades: 8, cd: 1.65, maxTorque: 21600, maxOmega: .60, gearEfficiency: .72 },
    wood: 0x69442b, blade: 0xbb9860, accent: 0x752d27,
  },
  scarab: {
    name: 'Scarab', subtitle: 'The endless river',
    description: 'Twin endless ladders of oak paddles, carried on timber drums and bronze-pinned links. Low submerged runs pull aft; high runs return dry.',
    feel: 'Continuous track · many immersed blades · massive exposed transmission',
    geometry: { mechanism: 'chain', trackHalfLength: 27, x: 14.6, y: 1.1, z: 2, radius: 2.4, width: 3.0, bladeHeight: .85,
      axleDiameter: .85, blades: 36, cd: 1.65, maxTorque: 66000, maxOmega: .12, gearEfficiency: .66 },
    wood: 0x51402c, blade: 0xa5804d, accent: 0x35655c,
  },
} satisfies Record<string, { name: string; subtitle: string; description: string; feel: string;
  geometry: Omit<PaddleGeometry, 'inertia' | 'machineryMass'>; wood: number; blade: number; accent: number }>;
export type PaddleVariantId = keyof typeof PADDLE_VARIANTS;
export function isPaddleVariant(value: string | null): value is PaddleVariantId {
  return value !== null && Object.hasOwn(PADDLE_VARIANTS, value);
}
