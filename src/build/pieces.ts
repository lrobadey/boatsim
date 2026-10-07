/**
 * Deck-building catalogue (spec §8). CONTRACT (lead-owned): the data shape and ids are stable
 * because placements persist in localStorage by id.
 */
export type PieceFunction = 'cargo' | 'light' | 'shade' | 'altar' | 'decor';

export interface PieceDef {
  id: string;
  name: string;
  /** ModelKit object name (WS-C dock_props.glb) */
  model: string;
  /** kg */
  mass: number;
  /** footprint half extents (m) in piece-local x/z before rotation */
  hx: number;
  hz: number;
  /** height of the solid (m) */
  height: number;
  /** can be stood on and stacked on (one level) */
  stackable: boolean;
  walkTop: boolean;
  fn: PieceFunction;
  blurb: string;
}

export const PIECES: PieceDef[] = [
  { id: 'crate', name: 'Crate', model: 'crate', mass: 60, hx: 0.4, hz: 0.4, height: 0.7, stackable: true, walkTop: true, fn: 'cargo', blurb: 'Cargo. Stacks two high and can be stood on.' },
  { id: 'amphora_rack', name: 'Amphora rack', model: 'amphora_rack', mass: 260, hx: 0.75, hz: 0.45, height: 1.0, stackable: false, walkTop: false, fn: 'cargo', blurb: 'Cargo. Holds six amphorae.' },
  { id: 'pithos', name: 'Pithos', model: 'pithos', mass: 180, hx: 0.45, hz: 0.45, height: 1.3, stackable: false, walkTop: false, fn: 'cargo', blurb: 'Cargo. Large storage jar.' },
  { id: 'rope_coil', name: 'Rope coil', model: 'rope_coil', mass: 25, hx: 0.35, hz: 0.35, height: 0.2, stackable: false, walkTop: true, fn: 'decor', blurb: 'Spare rope.' },
  { id: 'net_pile', name: 'Nets', model: 'net_pile', mass: 30, hx: 0.5, hz: 0.4, height: 0.35, stackable: false, walkTop: true, fn: 'decor', blurb: 'Fishing nets.' },
  { id: 'lamp_post', name: 'Lamp', model: 'lamp_post', mass: 20, hx: 0.15, hz: 0.15, height: 1.9, stackable: false, walkTop: false, fn: 'light', blurb: 'Lights the deck at night.' },
  { id: 'brazier', name: 'Brazier', model: 'brazier', mass: 90, hx: 0.35, hz: 0.35, height: 0.9, stackable: false, walkTop: false, fn: 'light', blurb: 'Bright light at night. Heavy.' },
  { id: 'awning', name: 'Awning', model: 'awning', mass: 70, hx: 1.5, hz: 1.2, height: 2.3, stackable: false, walkTop: false, fn: 'shade', blurb: 'Shade over a 3 × 2.4 m area.' },
  { id: 'altar', name: 'Altar', model: 'altar', mass: 300, hx: 0.45, hz: 0.35, height: 0.9, stackable: false, walkTop: false, fn: 'altar', blurb: 'Make an offering once a day to restore crew stamina.' },
  { id: 'bench', name: 'Bench', model: 'bench', mass: 35, hx: 0.8, hz: 0.22, height: 0.45, stackable: false, walkTop: true, fn: 'decor', blurb: 'Seating. Can be stood on.' },
  { id: 'shield_rack', name: 'Shield rack', model: 'shield_rack', mass: 110, hx: 0.7, hz: 0.25, height: 1.4, stackable: false, walkTop: false, fn: 'decor', blurb: 'Holds three shields.' },
  { id: 'banner', name: 'Banner', model: 'banner', mass: 15, hx: 0.15, hz: 0.15, height: 3.2, stackable: false, walkTop: false, fn: 'decor', blurb: 'Flag on a 3 m pole.' },
];

export const PIECE_BY_ID = new Map(PIECES.map((p) => [p.id, p]));
/** total deck payload allowance (kg) */
export const PAYLOAD_LIMIT = 2500;

export interface Placement {
  id: string;
  /** ship-local position of the piece base centre */
  x: number;
  z: number;
  /** rad about local y */
  rot: number;
  /** 0 on deck, 1 stacked on a stackable piece */
  level: 0 | 1;
}
