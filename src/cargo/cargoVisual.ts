// Whole-package visible subset of the hold manifest (cargo-trade spec §7.4). Models are packed into
// the actual hatch projections; inventory beyond the visible single layer remains hidden below deck.
// Ship-local; the lead adds `group` to the model. Rebuilt only by update().
import * as THREE from 'three';
import type { ShipDesign } from '../ship/design';
import { GOODS, goodById, type GoodId } from '../trade/goods';
import { patchMaterial } from '../gfx/shared';
import type { Hold, Manifest, StowedCell } from './hold';
import { createCargoMeshes, LOOKS, type CargoLook } from './cargoModels';
import { getDunnagePlatforms, packVisibleCargo, type CargoPlacement, type DunnagePlatform } from './cargoPacking';

const MAX_PER_LOOK = 400;

export class CargoVisual {
  readonly group = new THREE.Group();
  private readonly meshes = createCargoMeshes(MAX_PER_LOOK);
  readonly dunnagePlatforms: readonly DunnagePlatform[];
  /** ship-local hatch rectangles inset by 0.075 m, matching the allowed opening */
  readonly areas: { x0: number; x1: number; z0: number; z1: number }[];
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  private readonly counts: Record<CargoLook, number> = { amphora: 0, jar: 0, sack: 0, bundle: 0 };
  private currentPlacements: CargoPlacement[] = [];
  private currentVisibleCounts: Partial<Record<GoodId, number>> = {};

  constructor(private readonly hold: Hold, design: ShipDesign) {
    const cargo = design.cargo;
    if (!cargo) throw new Error(`${design.name} has no cargo hold`);
    this.dunnagePlatforms = getDunnagePlatforms(design);
    const wood = patchMaterial(
      new THREE.MeshStandardMaterial({ color: 0x70503a, roughness: 0.95 }),
      undefined,
      'cargo_dunnage',
    );
    for (const platform of this.dunnagePlatforms) {
      const width = platform.x1 - platform.x0;
      const depth = platform.z1 - platform.z0;
      const seam = 0.003;
      const plankWidth = (width - 4 * seam) / 5;
      for (let i = 0; i < 5; i++) {
        const x0 = platform.x0 + i * (plankWidth + seam);
        const plank = new THREE.Mesh(new THREE.BoxGeometry(plankWidth, platform.thickness, depth), wood);
        plank.name = `cargo-dunnage-${platform.hatchIndex}-plank-${i}`;
        plank.position.set(x0 + plankWidth / 2, platform.top - platform.thickness / 2, (platform.z0 + platform.z1) / 2);
        plank.castShadow = true;
        plank.receiveShadow = true;
        this.group.add(plank);
      }
      for (let i = 0; i < platform.bearers.length; i++) {
        const bearer = platform.bearers[i];
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(bearer.x1 - bearer.x0, bearer.y1 - bearer.y0, bearer.z1 - bearer.z0),
          wood,
        );
        mesh.name = `cargo-dunnage-${platform.hatchIndex}-bearer-${i}`;
        mesh.position.set((bearer.x0 + bearer.x1) / 2, (bearer.y0 + bearer.y1) / 2, (bearer.z0 + bearer.z1) / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
    const hw = cargo.hatchHalfWidth - 0.075;
    this.areas = cargo.hatches.map((h) => {
      const za = design.hull.zOf(h.s0), zb = design.hull.zOf(h.s1);
      return { x0: -hw, x1: hw, z0: Math.min(za, zb) + 0.075, z1: Math.max(za, zb) - 0.075 };
    });
    for (const look of LOOKS) this.group.add(this.meshes[look]);
  }

  /** instances drawn per look at the last update */
  get instanceCounts(): Readonly<Record<CargoLook, number>> {
    return this.counts;
  }

  get visibleCounts(): Readonly<Partial<Record<GoodId, number>>> {
    return this.currentVisibleCounts;
  }

  get placements(): readonly CargoPlacement[] {
    return this.currentPlacements;
  }

  /** Rebuild whole-package visible cargo. Production passes the manifest; older callers may omit it. */
  update(stowed: StowedCell[], manifest?: Manifest) {
    const exact = manifest ?? this.manifestFromStowage(stowed);
    this.currentPlacements = packVisibleCargo(exact, this.hold.design);
    const visible: Partial<Record<GoodId, number>> = {};
    const byLook: Record<CargoLook, CargoPlacement[]> = { amphora: [], jar: [], sack: [], bundle: [] };
    for (const placement of this.currentPlacements) {
      visible[placement.good] = (visible[placement.good] ?? 0) + 1;
      byLook[placement.look].push(placement);
    }
    this.currentVisibleCounts = visible;
    for (const look of LOOKS) {
      const mesh = this.meshes[look];
      let k = 0;
      for (const placement of byLook[look]) {
        this.m.makeRotationY(placement.yaw).setPosition(placement.position);
        mesh.setMatrixAt(k, this.m);
        mesh.setColorAt(k, this.c.setHex(goodById(placement.good).tint));
        k++;
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.counts[look] = k;
    }
  }

  private manifestFromStowage(stowed: StowedCell[]): Manifest {
    const volume: Partial<Record<GoodId, number>> = {};
    for (const cell of stowed) for (const part of cell.parts) {
      volume[part.good] = (volume[part.good] ?? 0) + part.volume;
    }
    const result: Manifest = {};
    for (const good of GOODS) {
      const units = (volume[good.id] ?? 0) / good.stow;
      const rounded = Math.round(units);
      if (Math.abs(units - rounded) <= 1e-6) result[good.id] = rounded;
    }
    return result;
  }
}
