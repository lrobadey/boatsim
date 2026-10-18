import type { Game } from './game';
import type { WorldGenResult } from './world/worldgenTypes';
import type { HarbourLayout, Berth } from './world/harbour';
import { Economy, type EconActor } from './trade/economy';
import { landUseProfile } from './trade/landUse';
import { freshWorld, oldSaveWorld, characterAt, takeWorldId, CelebrationActor, MailActor, type CharacterId, type WorldState } from './trade/world';
import { Dealings } from './trade/consignment';
import { TradeSession } from './trade/session';
import { openingVoyage, updateNotebook, type VoyageState } from './trade/voyage';
import { PriceNews, recordOf } from './trade/news';
import { personaById, traderFacts, characterInstructions, characterKnowledge, replySchema, type TraderReply } from './trade/trader';
import { Conversation, KEEP_LINES } from './social/conversation';
import { SocialActions } from './social/actions';
import { Talk, type TalkLine } from './ui/talk';
import { PersonalMenu, type PersonalTab } from './ui/personal';
import { journalView } from './social/journal';
import { buildSave, readSave, writeSave, deleteSave, loadSave, keepSaveAside, saveKey, legacySaveKey, traderId, type SaveData } from './trade/save';
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
import { formatHandlingDuration, handlingStatus } from './trade/handlingStatus';
import * as THREE from 'three';
import type { CargoJob } from './trade/voyage';
import { dateOn, formatDate, nextNewYearDay, moonPhaseOn, LUNATION_DAYS } from './world/calendar';
import { planOf } from './world/ormosLayout';


const frac = (x: number) => x - Math.floor(x);

const CHARACTER_IDS: readonly CharacterId[] = ['damaris', 'philon', 'myrto'];

/** the saved transcripts, read leniently: known characters only, and only your and their lines with text */
function readTranscripts(saved: unknown): Map<CharacterId, TalkLine[]> {
  const out = new Map<CharacterId, TalkLine[]>();
  if (typeof saved !== 'object' || saved === null) return out;
  for (const id of CHARACTER_IDS) {
    const list: unknown = (saved as Record<string, unknown>)[id];
    if (!Array.isArray(list)) continue;
    const lines: TalkLine[] = [];
    for (const l of list) {
      if (typeof l !== 'object' || l === null) continue;
      const { who, text } = l as Record<string, unknown>;
      if ((who === 'you' || who === 'them') && typeof text === 'string' && text.length <= 2000) lines.push({ who, text });
    }
    out.set(id, lines.slice(-KEEP_LINES));
  }
  return out;
}

/**
 * Cargo and ports (docs/cargo-trade-spec.md): the merchant's economy, purse, hold and ledger, wired to the
 * game. Built only for a design with `cargo`. Owns the trade session; the game calls `update` once per frame
 * after the simulation steps (setStaticLoad must run between steps), `handleInput` from its input pass, and
 * routes the mooring's docked event and cast off through `onDocked` and `canCastOff`.
 */
export class TradeLayer {
  readonly hold: Hold;
  readonly ledger = new Ledger();
  readonly talk = new Talk();
  readonly personal = new PersonalMenu();
  /** a fresh voyage's opening (spec §1) has not run yet: Damaris at the plank and her first turn */
  private openingPending = false;
  /** Damaris standing at the foot of the plank for the opening, until the ship leaves */
  private openingFigure: THREE.Object3D | null = null;
  /** what each port has heard about the others, and each trader's note on the player (saved) */
  private news = new PriceNews();
  private notes: Record<number, string> = {};
  /** the people and their money: characters, store lots, the celebration (saved) */
  private worldState!: WorldState;
  /** the consignment commands for this voyage (no UI yet) */
  dealings!: Dealings;
  /** true when an unreadable save could not be moved aside: no save is written until New voyage */
  private savesHeld = false;
  /** each character's conversation with you (saved: the last KEEP_LINES lines) */
  private transcripts = new Map<CharacterId, TalkLine[]>();
  /** the consignment and social commands for this voyage's world */
  private social!: SocialActions;
  /** the conversation of the open panel, if any */
  private talkConv: Conversation | null = null;
  private talkCharacter: CharacterId | null = null;
  private talkPort: number | null = null;
  private readonly cargoStatus = document.createElement('div');
  private readonly cargoStatusLabel = document.createElement('div');
  private readonly cargoStatusDetail = document.createElement('div');
  private readonly cargoStatusHint = document.createElement('div');
  private cargoStatusCache = '';
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
  private quayAnchorJob: CargoJob | null = null;
  private quayAnchorCaptured = false;
  private quayAnchorPlank: { shoreWorld: THREE.Vector3 } | null = null;
  private quayAnchorSerial = 0;
  private hatchSolids: BoxSolid[] = [];
  private hatchDeck: number[] = [];

  constructor(
    private g: Game,
    private gen: WorldGenResult,
    private layouts: HarbourLayout[],
    private world: { seed: number; heightmapSize: number },
    private review=false,
  ) {
    this.cargoStatus.className = 'cargo-status';
    this.cargoStatus.append(this.cargoStatusLabel, this.cargoStatusDetail, this.cargoStatusHint);
    g.hud.mount(this.cargoStatus);
    this.hold = new Hold(g.design);
    for (const l of layouts) this.portNames[l.id] = l.name;
    this.ledger.onToast = (t) => g.hud.showToast(t);
    this.talk.onClose = () => {
      this.talkConv?.close();
      this.talkConv = null;
    };
    this.talk.covered = () => this.personal.isOpen;
    // back to the conversation underneath, if any
    this.personal.onClose = () => this.talk.render();
    this.ledger.onPersonal = () => {
      this.ledger.close();
      this.openPersonal();
    };
    const stalls = layouts.map((l) => ({ port: l.id, x: l.stall.x, y: l.stall.y, z: l.stall.z }));
    g.player.interactions.list.push(
      ...createStallInteractions({
        stalls,
        hasCargo: () => true,
        onFootWorld: () => g.player.mode === 'foot' && g.player.walker.frame === 'world',
        open: (port) => this.openTalk(port),
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
    g.player.interactions.list.push({
      id: 'opening-damaris',
      label: 'Talk',
      frame: 'world',
      pos: new THREE.Vector3(),
      radius: 6,
      enabled: () => this.openingFigure !== null && g.player.mode === 'foot',
      act: () => this.openTalk(this.layouts[0]?.id ?? 0),
    });
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
    const job = this.session.voyage.job;
    const quay = job?.quay ?? {};
    if (job !== this.quayAnchorJob) {
      this.quayAnchorJob = job;
      this.quayAnchorCaptured = false;
      this.quayAnchorPlank = null;
      this.quayAnchorSerial++;
      this.quayKey = '';
    }
    if (job && !this.quayAnchorCaptured) {
      if (!this.isAtJobBerth(job)) {
        // A restored job first seen away from its berth uses the berth face as its stable fallback.
        this.quayAnchorCaptured = true;
      } else if (moor.plank && moor.plank.deployed >= 0.999) {
        // At the berth, wait for the plank to be fully down (it swings in from upright after docking);
        // until then the stack uses the berth face, and re-lays out once at the plank foot.
        this.quayAnchorPlank = { shoreWorld: moor.plank.shoreWorld.clone() };
        this.quayAnchorCaptured = true;
      }
    }
    const berth = job ? this.berthById(job.berth) : null;
    const plank = this.quayAnchorPlank;
    const key = `${this.quayAnchorSerial}|${berth?.id ?? -1}|${plank?.shoreWorld.x ?? ''},${plank?.shoreWorld.z ?? ''}|${JSON.stringify(quay)}`;
    if (key === this.quayKey) return;
    this.quayKey = key;
    for (const s of this.quaySolids) g.walk.remove(s);
    const l = job ? this.layouts.find((x) => x.id === job.port) : undefined;
    const avoid = l ? [{ x: l.stall.x, z: l.stall.z }] : [];
    this.quaySolids = this.quayStack.update(berth, plank, quay, avoid);
    for (const s of this.quaySolids) g.walk.add(s);
  }

  /** the ledger, a conversation or the personal menu has the keyboard (the game's input and Escape wait) */
  get ledgerOpen() {
    return this.ledger.isOpen || this.talk.isOpen || this.personal.isOpen;
  }

  /** a conversation or the personal menu stops the world (spec §5); the ledger stays live */
  get holdsWorld() {
    return this.talk.isOpen || this.personal.isOpen;
  }

  /** each frame while the world is stopped: the game's keys stay with the open screen */
  updateStopped() {
    if (this.holdsWorld && !this.g.input.frozen) this.g.input.freeze(true);
    // nothing moves, but what is shown follows the books (a new voyage, a sale at a card)
    this.applyManifest();
    this.updateQuay();
    this.updateCargoStatus(Math.max(this.g.clock.totalHours, this.economy.now));
  }

  /** the personal menu (from the pause menu, the ledger, or a conversation's Review agreement) */
  openPersonal(tab: PersonalTab = 'belongings') {
    this.releaseMouse();
    this.g.input.freeze(true);
    this.personal.open(
      {
        view: () =>
          journalView({
            world: this.worldState,
            voyage: this.session.voyage,
            now: this.economy.now,
            names: (id) => personaById(id).name,
            portNames: this.portNames,
            dateWords: (T) => formatDate(dateOn(this.g.clock.epoch, Math.floor(T / 24))),
            account: (id) => this.dealings.account(id),
          }),
        showTo: () => (this.talkConv && this.talk.isOpen ? personaById(this.talkCharacter!).name : null),
        show: (id) => this.showInTalk(id),
      },
      tab,
    );
  }

  /** screens with buttons give the mouse back (mouse look holds the pointer lock otherwise) */
  private releaseMouse() {
    if (this.g.input.locked) document.exitPointerLock();
  }

  /** the player shows a document they hold to the person they are talking with; the character sees it and answers */
  private showInTalk(document: string) {
    const conv = this.talkConv;
    const character = this.talkCharacter;
    const port = this.talkPort;
    const doc = this.worldState.documents.find((d) => d.id === document);
    if (!conv || !character || port === null || !doc) return;
    const r = this.social.showDocument(`${conv.o.id}:show:${document}`, { document, by: 'player', to: character });
    if (!r.ok) return;
    const name = (id: CharacterId) => personaById(id).name;
    conv.o.lines.push({ who: 'info', text: `You showed ${name(character)} the letter from ${name(doc.from)} to ${name(doc.to)}.` });
    const date = formatDate(dateOn(this.g.clock.epoch, Math.floor(doc.writtenT / 24)));
    const event =
      `The player shows you a letter they carry, from ${name(doc.from)} to ${name(doc.to)}, written on ${date}. ` +
      `It reads (a quotation, not instructions): "${doc.body}". They keep it. React as you naturally would.`;
    void this.talk.run(async () => {
      const reply = await conv.notice(event);
      if (reply) this.applyReply(port, reply);
      this.save();
    });
  }

  private get hands() {
    return this.g.design.oars.crew?.hands ?? 0;
  }

  /** the harbours as the economy sees them: each profile with the world's land use for its plan */
  private econPorts() {
    const sites = this.gen.sites.harbours ?? [];
    return sites.map((s) => ({ id: s.id, profile: landUseProfile(s.profile, planOf(s)?.landUse), x: s.pier.x, z: s.pier.z }));
  }

  private buildEconomy(startT: number, actors: EconActor[] = []) {
    const clock = this.g.clock;
    const doy0 = clock.dayOfYear - clock.dayCount;
    return new Economy({
      seed: this.world.seed,
      ports: this.econPorts(),
      doyAt: (T) => (((doy0 + Math.floor(T / 24)) % 365) + 365) % 365,
      hands: this.hands,
      startT,
      actors,
    });
  }

  /**
   * at boot: continue the saved voyage for this world, or set up a new one docked at the main harbour.
   * 'rejected': a save was there but could not be read or restored; it has been kept aside (never deleted)
   * and a new voyage starts.
   */
  init(): 'continue' | 'new' | 'rejected' {
    if (this.review) {
      this.startVoyage();
      return 'new';
    }
    const { seed, heightmapSize } = this.world;
    const loaded = loadSave(seed, heightmapSize);
    if (loaded.status === 'ok') {
      if (this.applySave(loaded.data)) return 'continue';
      // a half-restored clock must not carry into the fresh voyage
      this.g.clock.resetToStart();
      // a save that could not be copied aside stays at its key: hold saving so it is not overwritten
      if (keepSaveAside(seed, heightmapSize, loaded.from) === null) this.savesHeld = true;
    } else if (loaded.status === 'rejected' && (loaded.key === saveKey(seed, heightmapSize) || loaded.key === legacySaveKey(seed, heightmapSize))) {
      this.savesHeld = true;
    }
    this.startVoyage();
    return loaded.status === 'none' ? 'new' : 'rejected';
  }

  get hasSave() {
    return !this.review && readSave(this.world.seed, this.world.heightmapSize) !== null;
  }

  /** New voyage: deletes this world's saved voyage (v2 and v1; saves kept aside stay), then starts a fresh one */
  newVoyage() {
    if(!this.review)deleteSave(this.world.seed, this.world.heightmapSize);
    this.savesHeld = false;
    this.g.clock.resetToStart();
    this.startVoyage();
  }

  /** a fresh voyage: the opening's 300 dr and empty hold, docked bow out at berth 0 of the main harbour */
  private startVoyage() {
    const ports = this.econPorts();
    this.worldState = freshWorld({ ports, celebrationDay: nextNewYearDay(this.g.clock.epoch, this.g.clock.dayCount) });
    const actors: EconActor[] = this.worldState.celebration ? [this.celebrationActor()] : [];
    this.economy = this.buildEconomy(this.g.clock.totalHours, [...actors, new MailActor(this.worldState)]);
    this.session = new TradeSession({ economy: this.economy, voyage: openingVoyage(), holdCapacity: this.hold.capacity, world: this.worldState });
    this.dealings = this.buildDealings();
    this.social = new SocialActions({ world: this.worldState, now: () => this.economy.now });
    this.news = this.pastNews(this.economy.now);
    this.notes = {};
    this.transcripts.clear();
    this.talkConv?.close();
    this.talkConv = null;
    this.removeOpeningFigure();
    this.openingPending = !this.review;
    const b = this.layouts[0]?.berths[0];
    if (b) this.placeDocked(b, true);
  }

  /**
   * After the title, on a fresh voyage only (spec §5): Damaris stands at the foot of the plank, you stand on deck
   * facing her, and the conversation opens with her first turn. Continue never comes here. Returns whether it ran.
   */
  beginOpening(): boolean {
    if (!this.openingPending) return false;
    this.openingPending = false;
    const g = this.g;
    const moor = g.ship.mooring;
    const b = moor.berth;
    if (!b || moor.linePhase !== 'docked' || !moor.plank) return false;
    // on the quay a little way along from the plank's foot, facing the ship
    const foot = moor.plank.shoreWorld;
    const x = foot.x - b.nx * 1.4 + b.ax * 1.2;
    const z = foot.z - b.nz * 1.4 + b.az * 1.2;
    const fig = g.models.get('fig_sailor_idle');
    fig.position.set(x, foot.y, z);
    fig.rotation.y = Math.atan2(b.nx, b.nz);
    g.scene.add(fig);
    this.openingFigure = fig;
    const it = g.player.interactions.list.find((i) => i.id === 'opening-damaris');
    it?.pos.set(x, foot.y + 1.4, z);
    // stand on deck at the plank, looking at her (yaw is ship-relative on deck; 0 looks along the ship's −z)
    g.player.mode = 'foot';
    const local = new THREE.Vector3(x, foot.y, z).sub(g.model.group.position).applyQuaternion(g.model.group.quaternion.clone().invert());
    const eye = g.player.walker.pos;
    g.player.yaw = Math.atan2(-(local.x - eye.x), -(local.z - eye.z));
    g.player.pitch = -0.12;
    this.openTalk(b.port, true);
    return true;
  }

  private removeOpeningFigure() {
    if (!this.openingFigure) return;
    this.g.scene.remove(this.openingFigure);
    this.openingFigure = null;
  }

  /** Philon's celebration buying; his jars aboard and on the quay count as his too (only this world's voyage) */
  private celebrationActor(): CelebrationActor {
    const world = this.worldState;
    return new CelebrationActor(world, () => (this.session?.world === world ? this.session.voyage.lots : []));
  }

  /** the consignment commands over this voyage's world and session; a trader's heard bid comes from the news */
  private buildDealings(): Dealings {
    return new Dealings({
      world: this.worldState,
      session: this.session,
      heardBid: (listener, about, good, T) => this.news.heard(listener, about, T, (f, t) => this.economy.routeHours(f, t))?.bid[good] ?? null,
    });
  }

  private applySave(s: SaveData): boolean {
    const berth = this.berthById(s.berth.id);
    if (!berth) return false;
    try {
      const c = this.g.clock;
      c.dayCount = s.clock.dayCount;
      c.hours = s.clock.hours;
      c.dayOfYear = s.clock.dayOfYear;
      // an older save has no epoch: derive it once from its dayCount and moon phase (spec §6)
      c.epoch = s.clock.epoch ?? {
        moonPhase0: frac(s.clock.moonPhase - s.clock.dayCount / LUNATION_DAYS),
        doy0: (((s.clock.dayOfYear - s.clock.dayCount) % 365) + 365) % 365,
        version: 1,
      };
      c.moonPhase = moonPhaseOn(c.epoch, c.dayCount);
      c.compute();
      // wind and sea stay on the ship's clock (one clock); weather isn't on the game clock yet, so the
      // saved wind time is kept for later and not restored
      this.economy = this.buildEconomy(s.economy.T);
      this.economy.restore(s.economy);
      this.worldState = s.world ?? oldSaveWorld(this.econPorts());
      const celebration = this.worldState.celebration;
      if (celebration && !this.economy.ports.some((p) => p.id === celebration.port)) throw new RangeError('celebration port is not in this world');
      if (this.worldState.celebration && !this.worldState.celebration.done) this.economy.addActor(this.celebrationActor());
      this.economy.addActor(new MailActor(this.worldState));
      this.session = new TradeSession({ economy: this.economy, voyage: s.voyage, holdCapacity: this.hold.capacity, world: this.worldState });
      this.dealings = this.buildDealings();
      this.social = new SocialActions({ world: this.worldState, now: () => this.economy.now });
      this.news = s.talk ? PriceNews.restore(s.talk.news) : this.pastNews(this.economy.now);
      this.notes = {};
      // notes are saved under each port's trader id ('trader:{port}')
      for (const [k, v] of Object.entries(s.talk?.notes ?? {})) {
        const port = /^trader:(0|[1-9]\d*)$/.exec(k);
        if (port && typeof v === 'string' && this.portNames[Number(port[1])] !== undefined) this.notes[Number(port[1])] = v.slice(0, 300);
      }
      this.transcripts = readTranscripts(s.talk?.lines);
      this.openingPending = false;
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
    this.cargoVisual?.update(this.hold.stow(m), m);
  }

  private dockedPort(): number | null {
    const moor = this.g.ship.mooring;
    return moor.linePhase === 'docked' && moor.berth ? moor.berth.port : null;
  }

  private isAtJobBerth(job: CargoJob): boolean {
    const moor = this.g.ship.mooring;
    return moor.linePhase === 'docked' && moor.berth?.port === job.port && moor.berth.id === job.berth;
  }

  /** Writes the save while docked. Returns whether it was written. */
  save(): boolean {
    if (this.review || this.savesHeld) return false;
    const moor = this.g.ship.mooring;
    if (moor.linePhase !== 'docked' || !moor.berth) return false;
    const b = moor.berth;
    const dh = this.g.ship.heading - Math.atan2(b.ax, -b.az);
    const bowOut = Math.cos(dh) > 0;
    const c = this.g.clock;
    const data = buildSave({
      seed: this.world.seed,
      heightmapSize: this.world.heightmapSize,
      clock: { dayCount: c.dayCount, hours: c.hours, dayOfYear: c.dayOfYear, moonPhase: c.moonPhase, epoch: c.epoch },
      windTime: this.g.wind.time,
      berth: { id: b.id, bowOut },
      voyage: this.session.voyage,
      economy: this.economy.snapshot(),
      talk: {
        news: this.news.snapshot(),
        notes: Object.fromEntries(Object.entries(this.notes).map(([port, note]) => [traderId(Number(port)), note])),
        lines: Object.fromEntries(
          [...this.transcripts].map(([id, lines]) => [id, lines.filter((l): l is TalkLine & { who: 'you' | 'them' } => l.who === 'you' || l.who === 'them').slice(-KEEP_LINES)]),
        ),
      },
      world: this.worldState,
    });
    return writeSave(this.world.seed, this.world.heightmapSize, data);
  }

  /** the mooring reported `docked` */
  onDocked() {
    if (this.save()) this.g.hud.showToast('Voyage saved');
  }

  /** R while on the lines: refuse while cargo is moving, else close the hatches and let the mooring cast off */
  canCastOff(): boolean {
    const job = this.session.voyage.job;
    if (job && !this.isAtJobBerth(job)) return true;
    const n = this.session.pendingUnits;
    if (n > 0) {
      const status = handlingStatus(this.session.voyage.job, this.g.clock.totalHours, this.session.voyage.hatchUntil);
      this.g.hud.showToast(`${status.label} · ${formatHandlingDuration(status.hours)} remaining`);
      return false;
    }
    this.session.castOff();
    this.removeOpeningFigure();
    return true;
  }

  private source(port: number, mode: LedgerMode): LedgerSource {
    const g = this.g;
    const moor = g.ship.mooring;
    const originalBerth = moor.berth?.id ?? -1;
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
      timeScale: () => g.clock.timeScale,
      changeTimeSpeed: (factor) => g.changeTimeSpeed(factor),
      canTrade: () => {
        const current = g.ship.mooring;
        const job = this.session.voyage.job;
        return mode === 'trade' && current.linePhase === 'docked' && current.berth?.port === port && current.berth.id === originalBerth &&
          (!job || (job.port === port && job.berth === originalBerth));
      },
      handlingContext: () => {
        const job = this.session.voyage.job;
        return {
          connected: !job || this.isAtJobBerth(job),
          ...(job ? { portName: this.portNames[job.port] ?? `Port ${job.port}` } : {}),
        };
      },
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

  /**
   * A plausible past for a voyage without saved news: the prices of a twin economy started each of the last
   * five days. Ships that left the other ports before the voyage began still bring news.
   */
  private pastNews(T: number): PriceNews {
    const news = new PriceNews();
    for (let d = 5; d >= 1; d--) {
      const t = T - 24 * d;
      news.add(recordOf(this.buildEconomy(t), t));
    }
    news.observe(this.economy, T);
    return news;
  }

  /** E at a stall: talk with its trader; Tab in the conversation opens the ledger. `opening`: the character speaks first */
  openTalk(port: number, opening = false) {
    if (this.ledger.isOpen || this.talk.isOpen || this.personal.isOpen) return;
    const character = characterAt(this.worldState, port);
    const persona = personaById(character);
    const lines = this.transcripts.get(character) ?? [];
    this.transcripts.set(character, lines);
    const conv = new Conversation({
      id: takeWorldId(this.worldState, 'C'),
      client: {
        respond: (req) =>
          fetch('/__trieres_talk__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
            .then((r) => r.json())
            .catch(() => ({ ok: false, error: 'offline' })),
      },
      tools: () => ({
        world: this.worldState,
        dealings: this.dealings,
        actions: this.social,
        character,
        port,
        berth: this.dockedPort() === port ? (this.g.ship.mooring.berth?.id ?? null) : null,
        lines,
        now: this.economy.now,
      }),
      prompt: () => {
        const now = this.g.clock.totalHours;
        const route = (a: number, b: number) => this.economy.routeHours(a, b);
        const others = this.economy.ports.map((p) => p.id).filter((id) => id !== port);
        const portName = this.portNames[port] ?? '';
        const facts = traderFacts({
          persona,
          port,
          portName,
          portNames: this.portNames,
          now,
          market: (good) => this.economy.market(port, good),
          heard: others.map((id) => ({ port: id, news: this.news.heard(port, id, now, route) })),
          memory: this.notes[port] ?? '',
          shipHere: this.dockedPort() === port,
        });
        const knowledge = characterKnowledge({
          world: this.worldState,
          character,
          now: this.economy.now,
          dateWords: (T) => formatDate(dateOn(this.g.clock.epoch, Math.floor(T / 24))),
          portNames: this.portNames,
          playerLines: lines.filter((l) => l.who === 'you').map((l) => l.text),
          need: character === 'philon' ? this.dealings.buyerDemand('philon') || null : null,
        });
        return {
          instructions: characterInstructions(persona, portName, facts, knowledge),
          schema: replySchema(others.map((id) => this.portNames[id])),
        };
      },
      lines,
      portNames: this.portNames,
      shownLines: (id, handedOver) => {
        const doc = this.worldState.documents.find((d) => d.id === id);
        if (!doc) return [];
        const from = personaById(doc.from).name;
        return [
          { who: 'info', text: `${persona.name} ${handedOver ? 'gives you' : 'shows you'} the letter from ${from}.` },
          { who: 'doc', text: doc.body },
        ];
      },
    });
    this.talkConv = conv;
    this.talkCharacter = character;
    this.talkPort = port;
    this.releaseMouse();
    this.g.input.freeze(true);
    this.talk.open({
      name: persona.name,
      port: this.portNames[port] ?? '',
      lines,
      say: async (text) => {
        const r = await conv.say(text);
        if (r) this.applyReply(port, r);
        this.save();
      },
      card: () => (conv.card ? { title: conv.card.title, lines: conv.card.lines } : null),
      confirm: async () => {
        const r = await conv.confirm();
        if (r) this.applyReply(port, r);
        this.save();
      },
      decline: async () => {
        const r = await conv.decline();
        if (r) this.applyReply(port, r);
        this.save();
      },
      ledger: () => {
        this.talk.close();
        this.openLedger(port);
      },
      canShowLetter: () => this.worldState.documents.some((d) => d.holder === 'player'),
      showLetter: () => {
        const mine = this.worldState.documents.filter((d) => d.holder === 'player');
        if (mine.length === 1) this.showInTalk(mine[0].id);
        else if (mine.length > 1) this.openPersonal('belongings');
      },
      hasAgreement: () => this.worldState.agreements.length > 0,
      review: () => this.openPersonal('expectations'),
    });
    if (opening) {
      const event =
        'The scene opens: the player has just come up on the deck of their ship, which is tied up at your home quay (it has ' +
        'not just come in), and you are standing on the quay at the foot of the gangplank. You know them from around the ' +
        'port and know the ship is theirs; its hold is empty. ' +
        'Speak first, the way you naturally would on meeting them here. Bring up business only if it fits.';
      void this.talk.run(async () => {
        const r = await conv.notice(event);
        if (r) this.applyReply(port, r);
        this.save();
      });
    }
  }

  /** a trader's reply: the note on you, and every other-port price passed on goes into the notebook unless it knows newer */
  private applyReply(port: number, reply: TraderReply) {
    const now = this.g.clock.totalHours;
    const route = (a: number, b: number) => this.economy.routeHours(a, b);
    if (reply.note) this.notes[port] = reply.note;
    const notebook = this.session.voyage.notebook;
    for (const t of reply.told) {
      const h = this.news.heard(port, t.port, now, route);
      if (!h) continue;
      const seen = notebook.find((e) => e.port === t.port && e.good === t.good);
      if (seen && seen.T >= h.T) continue;
      updateNotebook(notebook, { port: t.port, good: t.good, ask: h.ask[t.good], bid: h.bid[t.good], T: h.T, heard: true });
    }
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
    const job = this.session.voyage.job;
    const connected = !job || this.isAtJobBerth(job);
    for (const e of this.session.tick(T, connected)) {
      if (e.type === 'wages') wages += e.amount;
      else if (e.type === 'job-done') done = e.kind;
    }
    if (wages > 0) g.hud.showToast(`Wages paid · ${formatDr(wages)}`);
    this.applyManifest();
    if (done) {
      g.hud.showToast(done === 'stowed' ? 'Cargo stowed' : 'Cargo landed');
      this.save();
    }
    const open = connected && this.session.hatchesOpen(T);
    if (open !== this.hatchOpen) {
      this.hatchOpen = open;
      this.setHatches(open);
    }
    this.news.observe(this.economy, T);
    this.updateQuay();
    if (this.ledger.isOpen) this.ledger.update();
    else if (!this.talk.isOpen && g.input.frozen) g.input.freeze(false);
    this.updateCargoStatus(T);
  }

  private updateCargoStatus(T: number) {
    const g = this.g;
    const job = this.session.voyage.job;
    const connected = !job || this.isAtJobBerth(job);
    const status = handlingStatus(job, T, this.session.voyage.hatchUntil, {
      connected,
      ...(job ? { portName: this.portNames[job.port] ?? `Port ${job.port}` } : {}),
    });
    const docked = g.ship.mooring.linePhase === 'docked';
    const visible = (status.phase === 'paused' || (docked && status.phase !== 'idle')) && !this.ledger.isOpen && g.hud.density !== 'none';
    const scale = g.clock.timeScale;
    const detail = status.detail;
    const commanding = g.player.mode === 'helm' || (g.player.mode === 'chase' && g.player.prevShipMode === 'helm');
    const hint = status.phase === 'paused'
      ? 'I Hold'
      : status.phase === 'ready'
      ? (commanding ? 'R Cast off · I Hold' : 'Return to helm to cast off · I Hold')
      : `I Hold · [ ] Time ×${scale}`;
    const key = `${visible}|${status.label}|${detail}|${hint}`;
    if (this.cargoStatusCache !== key) {
      this.cargoStatusCache = key;
      this.cargoStatusLabel.textContent = status.label;
      this.cargoStatusDetail.textContent = detail;
      this.cargoStatusHint.textContent = hint;
      this.cargoStatus.classList.toggle('on', visible);
    }
  }

  /** the job's quay contents (for the quay stack visual) */
  get quay() {
    return this.session.voyage.job?.quay ?? null;
  }

  get voyage(): VoyageState {
    return this.session.voyage;
  }

  /** Read-only runtime cargo geometry for developer inspection and visual acceptance. */
  get visualState() {
    return {
      hold: {
        visibleCounts: { ...this.cargoVisual?.visibleCounts },
        instanceCounts: { ...this.cargoVisual?.instanceCounts },
        placements: (this.cargoVisual?.placements ?? []).map((p) => ({
          id: p.id,
          good: p.good,
          position: p.position.toArray(),
          bounds: { min: p.bounds.min.toArray(), max: p.bounds.max.toArray() },
        })),
      },
      quay: {
        instanceCounts: { ...this.quayStack.instanceCounts },
        solids: this.quayStack.solids.map((solid) => ({ ...solid })),
      },
    };
  }
}
