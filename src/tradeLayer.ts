import type { Game } from './game';
import type { WorldGenResult } from './world/worldgenTypes';
import type { HarbourLayout, Berth } from './world/harbour';
import { Economy } from './trade/economy';
import { TradeSession } from './trade/session';
import { newVoyage, type VoyageState } from './trade/voyage';
import { buildSave, readSave, writeSave, deleteSave, type SaveData } from './trade/save';
import { formatDr } from './trade/money';
import { createStallInteractions } from './trade/stall';
import { Hold } from './cargo/hold';
import { CargoVisual } from './cargo/cargoVisual';
import { QuayStack } from './cargo/quayStack';
import { MerchantModel } from './ship/merchantModel';
import type { BoxSolid, Solid } from './world/walkable';
import { Ledger, type LedgerMode, type LedgerSource } from './ui/ledger';
import { tradeLedgerSource } from './ui/ledgerSource';
import { WAGE_PER_HAND_DAY } from './trade/economy';


/**
 * Cargo and ports (docs/cargo-trade-spec.md): the merchant's economy, purse, hold and ledger, wired to the
 * game. Built only for a design with `cargo`. Owns the trade session; the game calls `update` once per frame
 * after the simulation steps (setStaticLoad must run between steps), `handleInput` from its input pass, and
 * routes the mooring's docked event and cast off through `onDocked` and `canCastOff`.
 */
export class TradeLayer {
  readonly hold: Hold;
  readonly ledger = new Ledger();
  economy!: Economy;
  session!: TradeSession;
  readonly portNames: Record<number, string> = {};
  private manifestKey = '';
  private hatchOpen = false;
  /** visuals: cargo seen through the hatches, the stack on the quay, and the hatch walk solids */
  private cargoVisual: CargoVisual | null = null;
  private quayStack = new QuayStack();
  private quaySolids: Solid[] = [];
  private quayKey = '';
  private hatchSolids: BoxSolid[] = [];
  private hatchDeck: number[] = [];

  constructor(
    private g: Game,
    private gen: WorldGenResult,
    private layouts: HarbourLayout[],
    private world: { seed: number; heightmapSize: number },
  ) {
    this.hold = new Hold(g.design);
    for (const l of layouts) this.portNames[l.id] = l.name;
    this.ledger.onToast = (t) => g.hud.showToast(t);
    const stalls = layouts.map((l) => ({ port: l.id, x: l.stall.x, y: l.stall.y, z: l.stall.z }));
    g.player.interactions.list.push(
      ...createStallInteractions({
        stalls,
        hasCargo: () => true,
        onFootWorld: () => g.player.mode === 'foot' && g.player.walker.frame === 'world',
        open: (port) => this.openLedger(port),
      }),
    );
    if (g.model instanceof MerchantModel) {
      this.cargoVisual = new CargoVisual(this.hold, g.design);
      g.model.group.add(this.cargoVisual.group);
      for (const h of g.model.hatchRects) {
        const box: BoxSolid = { kind: 'box', cx: 0, cz: (h.z0 + h.z1) / 2, hx: h.halfWidth, hz: (h.z1 - h.z0) / 2, rot: 0, y0: h.deckY - 1, y1: h.deckY, surface: 'wood', walkTop: true };
        this.hatchSolids.push(box);
        this.hatchDeck.push(h.deckY);
        g.shipSolids.add(box);
      }
    }
    g.scene.add(this.quayStack.group);
  }

  /** gratings on: walkable flush with the deck; off: a waist-high block so nobody steps into the hold */
  private setHatches(open: boolean) {
    const g = this.g;
    if (g.model instanceof MerchantModel) g.model.setHatchesOpen(open);
    this.hatchSolids.forEach((b, i) => {
      const deck = this.hatchDeck[i];
      g.shipSolids.remove(b);
      b.walkTop = !open;
      b.y0 = deck - 1;
      b.y1 = open ? deck + 1 : deck;
      g.shipSolids.add(b);
    });
  }

  /** the stack on the quay at the plank follows the job's quay contents */
  private updateQuay() {
    const g = this.g;
    const moor = g.ship.mooring;
    const quay = this.session.voyage.job?.quay ?? {};
    const berth = moor.linePhase === 'docked' ? moor.berth : null;
    const key = `${berth?.id ?? -1}|${JSON.stringify(quay)}`;
    if (key === this.quayKey) return;
    this.quayKey = key;
    for (const s of this.quaySolids) g.walk.remove(s);
    const l = berth ? this.layouts.find((x) => x.id === berth.port) : undefined;
    const avoid = l ? [{ x: l.stall.x, z: l.stall.z }] : [];
    this.quaySolids = this.quayStack.update(berth, moor.plank, quay, avoid);
    for (const s of this.quaySolids) g.walk.add(s);
  }

  get ledgerOpen() {
    return this.ledger.isOpen;
  }

  private get hands() {
    return this.g.design.oars.crew?.hands ?? 0;
  }

  private buildEconomy(startT: number) {
    const sites = this.gen.sites.harbours ?? [];
    const clock = this.g.clock;
    const doy0 = clock.dayOfYear - clock.dayCount;
    return new Economy({
      seed: this.world.seed,
      ports: sites.map((s) => ({ id: s.id, profile: s.profile, x: s.pier.x, z: s.pier.z })),
      doyAt: (T) => (((doy0 + Math.floor(T / 24)) % 365) + 365) % 365,
      hands: this.hands,
      startT,
    });
  }

  /** at boot: continue the saved voyage for this world, or set up a new one docked at the main harbour */
  init(): 'continue' | 'new' {
    const save = readSave(this.world.seed, this.world.heightmapSize);
    if (save && this.applySave(save)) return 'continue';
    this.newVoyage();
    return 'new';
  }

  get hasSave() {
    return readSave(this.world.seed, this.world.heightmapSize) !== null;
  }

  /** a fresh voyage: start purse and 70 jars of wine, docked bow out at berth 0 of the main harbour */
  newVoyage() {
    deleteSave(this.world.seed, this.world.heightmapSize);
    this.economy = this.buildEconomy(this.g.clock.totalHours);
    this.session = new TradeSession({ economy: this.economy, voyage: newVoyage(), holdCapacity: this.hold.capacity });
    const b = this.layouts[0]?.berths[0];
    if (b) this.placeDocked(b, true);
  }

  private applySave(s: SaveData): boolean {
    const berth = this.berthById(s.berth.id);
    if (!berth) return false;
    try {
      const c = this.g.clock;
      c.dayCount = s.clock.dayCount;
      c.hours = s.clock.hours;
      c.dayOfYear = s.clock.dayOfYear;
      c.moonPhase = s.clock.moonPhase;
      c.compute();
      // wind and sea stay on the ship's clock (one clock); weather isn't on the game clock yet, so the
      // saved wind time is kept for later and not restored
      this.economy = this.buildEconomy(s.economy.T);
      this.economy.restore(s.economy);
      this.session = new TradeSession({ economy: this.economy, voyage: s.voyage, holdCapacity: this.hold.capacity });
      this.placeDocked(berth, s.berth.bowOut);
      return true;
    } catch (e) {
      console.warn('Voyage save could not be restored', e);
      return false;
    }
  }

  private berthById(id: number): Berth | null {
    for (const l of this.layouts) for (const b of l.berths) if (b.id === id) return b;
    return null;
  }

  /** setStaticLoad, then the game places her docked at the berth (spec §11 order) */
  private placeDocked(b: Berth, bowOut: boolean) {
    this.applyManifest(true);
    this.g.placeDocked(b, bowOut);
  }

  /** re-stow the hold and fold the cargo into the rigid body when the manifest changed */
  private applyManifest(force = false) {
    const m = this.session.voyage.manifest;
    const key = JSON.stringify(m);
    if (!force && key === this.manifestKey) return;
    this.manifestKey = key;
    this.hold.setManifest(m);
    this.g.ship.setStaticLoad(this.hold.staticLoad(m));
    this.cargoVisual?.update(this.hold.stow(m));
  }

  private dockedPort(): number | null {
    const moor = this.g.ship.mooring;
    return moor.linePhase === 'docked' && moor.berth ? moor.berth.port : null;
  }

  save() {
    const moor = this.g.ship.mooring;
    if (moor.linePhase !== 'docked' || !moor.berth) return;
    const b = moor.berth;
    const dh = this.g.ship.heading - Math.atan2(b.ax, -b.az);
    const bowOut = Math.cos(dh) > 0;
    const c = this.g.clock;
    const data = buildSave({
      seed: this.world.seed,
      heightmapSize: this.world.heightmapSize,
      clock: { dayCount: c.dayCount, hours: c.hours, dayOfYear: c.dayOfYear, moonPhase: c.moonPhase },
      windTime: this.g.wind.time,
      berth: { id: b.id, bowOut },
      voyage: this.session.voyage,
      economy: this.economy.snapshot(),
    });
    writeSave(this.world.seed, this.world.heightmapSize, data);
  }

  /** the mooring reported `docked` */
  onDocked() {
    this.save();
    this.g.hud.showToast('Voyage saved');
  }

  /** R while on the lines: refuse while cargo is moving, else close the hatches and let the mooring cast off */
  canCastOff(): boolean {
    const n = this.session.pendingUnits;
    if (n > 0) {
      this.g.hud.showToast(`Cargo still moving · ${n} left`);
      return false;
    }
    this.session.castOff();
    return true;
  }

  private source(port: number, mode: LedgerMode): LedgerSource {
    const g = this.g;
    const moor = g.ship.mooring;
    const src = tradeLedgerSource({
      session: this.session,
      port,
      portName: this.portNames[port] ?? '',
      berth: moor.berth?.id ?? -1,
      mode,
      clock: () => g.clock,
      T: () => g.clock.totalHours,
      wagesPerDay: this.hands * WAGE_PER_HAND_DAY,
      holdCapacity: this.hold.capacity,
      portNames: this.portNames,
    });
    // every confirmed order is a save point while docked
    const confirm = src.confirm.bind(src);
    src.confirm = (orders) => {
      const lines = confirm(orders);
      this.save();
      return lines;
    };
    return src;
  }

  openLedger(port: number) {
    if (this.ledger.isOpen) return;
    const mode: LedgerMode = this.dockedPort() === port ? 'trade' : 'read';
    this.g.input.freeze(true);
    this.ledger.open(this.source(port, mode));
  }

  openHoldBook() {
    if (this.ledger.isOpen) return;
    const port = this.dockedPort() ?? this.layouts[0]?.id ?? 0;
    this.g.input.freeze(true);
    this.ledger.open(this.source(port, 'hold'));
  }

  /** from Game.handleInput (not called while the ledger is open) */
  handleInput() {
    if (this.g.input.hit('KeyI')) this.openHoldBook();
  }

  update() {
    const g = this.g;
    // the economy never runs backwards; a clock set back (dev tools) just waits for it to catch up
    const T = Math.max(g.clock.totalHours, this.economy.now);
    let wages = 0;
    let done: 'stowed' | 'landed' | null = null;
    for (const e of this.session.tick(T)) {
      if (e.type === 'wages') wages += e.amount;
      else if (e.type === 'job-done') done = e.kind;
    }
    if (wages > 0) g.hud.showToast(`Wages paid · ${formatDr(wages)}`);
    this.applyManifest();
    if (done) {
      g.hud.showToast(done === 'stowed' ? 'Cargo stowed' : 'Cargo landed');
      this.save();
    }
    const open = this.session.hatchesOpen(T);
    if (open !== this.hatchOpen) {
      this.hatchOpen = open;
      this.setHatches(open);
    }
    this.updateQuay();
    if (this.ledger.isOpen) this.ledger.update();
    else if (g.input.frozen) g.input.freeze(false);
  }

  /** the job's quay contents (for the quay stack visual) */
  get quay() {
    return this.session.voyage.job?.quay ?? null;
  }

  get voyage(): VoyageState {
    return this.session.voyage;
  }
}
