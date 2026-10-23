import { makeDesign, AFT_RIG } from '../../ship-study/browser/design';
import type { ShipDesign, SailRig } from '../ship/design';

/** Same tapered cloth and raised corners as the exterior; keep its projected area coupled. */
function enlargeRig(rig: SailRig, width: number, height: number): SailRig {
  return { ...rig, width, height, yardLength: width, area: width * (0.94 * height - 0.85 * 0.28) };
}

/** Dev vessel only: the same grouped motors as the existing three-hands-per-oar trial. */
export function makeThalassaDesign(): ShipDesign {
  const design = makeDesign(), crew = design.oars.crew!;
  for (const key of ['F0', 'CP', 'Wp', 'servoF'] as const) crew[key] *= 3;
  crew.orders.forEach(order => order.P *= 3);
  return { ...design, name: 'Thalassa', subtitle: 'Thalassa · Open-water dev build',
    rig: enlargeRig(design.rig, 28, 13),
    additionalRigs: [enlargeRig(AFT_RIG, 24, 10)],
    deck: { ...design.deck, s0: 0.15, s1: 0.85,
      deckHalfWidth: s => Math.min(10.25, 10.25 - Math.max(0, Math.abs(design.hull.zOf(s)) - 26)), },
    camera: { helmS: 0.70, chaseDist: 125, chasePivotUp: 8, dockingDist: 100, titleDist: 150, titleLift: 8 },
  };
}
