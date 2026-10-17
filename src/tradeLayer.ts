import type { Game } from './game';
import type { WorldGenResult } from './world/worldgenTypes';
import type { HarbourLayout, Berth } from './world/harbour';
import { Economy, type EconActor } from './trade/economy';
import { landUseProfile } from './trade/landUse';
import { freshWorld, oldSaveWorld, characterAt, CelebrationActor, type WorldState } from './trade/world';
import { TradeSession } from './trade/session';
import { newVoyage, updateNotebook, type VoyageState } from './trade/voyage';
import { PriceNews, recordOf } from './trade/news';
import { personaById, traderFacts, traderInstructions, replySchema, parseReply, type Persona } from './trade/trader';
import { Talk, type TalkLine } from './ui/talk';
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
import { nextNewYearDay, moonPhaseOn, LUNATION_DAYS } from './world/calendar';
import { planOf } from './world/ormosLayout';


const frac = (x: number) => x - Math.floor(x);

/** what the conversation shows when no reply came back */
const TALK_ERRORS: Record<string, string> = {
  'no-key': 'Talking needs an OpenAI API key (OPENAI_API_KEY in .env.local).',
  timeout: 'The model took too long to answer. Try again.',
  upstream: 'The connection to the model failed. Try again.',
};

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
  /** what each port has heard about the others, and each trader's note on the player (saved) */
  private news = new PriceNews();
  private notes: Record<number, string> = {};
  /** the people and their money: characters, store lots, the celebration (saved) */
  private worldState!: WorldState;
  /** true when an unreadable save could not be moved aside: no save is written until New voyage */
  private savesHeld = false;
  /** the conversation at each stall this session (not saved) */
  private talkLines = new Map<number, TalkLine[]>();
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

  /** the ledger or a conversation has the keyboard (the game's input and Escape wait) */
  get ledgerOpen() {
    return this.ledger.isOpen || this.talk.isOpen;
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

  /** a fresh voyage: start purse and 70 jars of wine, docked bow out at berth 0 of the main harbour */
  private startVoyage() {
    const ports = this.econPorts();
    this.worldState = freshWorld({ ports, celebrationDay: nextNewYearDay(this.g.clock.epoch, this.g.clock.dayCount) });
    this.economy = this.buildEconomy(this.g.clock.totalHours, this.worldState.celebration ? [new CelebrationActor(this.worldState)] : []);
    this.session = new TradeSession({ economy: this.economy, voyage: newVoyage(), holdCapacity: this.hold.capacity });
    this.news = this.pastNews(this.economy.now);
    this.notes = {};
    this.talkLines.clear();
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
      if (this.worldState.celebration && !this.worldState.celebration.done) this.economy.addActor(new CelebrationActor(this.worldState));
      this.session = new TradeSession({ economy: this.economy, voyage: s.voyage, holdCapacity: this.hold.capacity });
      this.news = s.talk ? PriceNews.restore(s.talk.news) : this.pastNews(this.economy.now);
      this.notes = {};
      // notes are saved under each port's trader id ('trader:{port}')
      for (const [k, v] of Object.entries(s.talk?.notes ?? {})) {
        const port = /^trader:(0|[1-9]\d*)$/.exec(k);
        if (port && typeof v === 'string' && this.portNames[Number(port[1])] !== undefined) this.notes[Number(port[1])] = v.slice(0, 300);
      }
      this.talkLines.clear();
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
      talk: { news: this.news.snapshot(), notes: Object.fromEntries(Object.entries(this.notes).map(([port, note]) => [traderId(Number(port)), note])) },
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

  /** E at a stall: talk with its trader; Tab in the conversation opens the ledger */
  openTalk(port: number) {
    if (this.ledger.isOpen || this.talk.isOpen) return;
    const persona = personaById(characterAt(this.worldState, port));
    const lines = this.talkLines.get(port) ?? [];
    this.talkLines.set(port, lines);
    this.g.input.freeze(true);
    this.talk.open({
      name: persona.name,
      port: this.portNames[port] ?? '',
      lines,
      say: (text) => this.say(port, persona, lines, text),
      ledger: () => {
        this.talk.close();
        this.openLedger(port);
      },
    });
  }

  private async say(port: number, persona: Persona, lines: TalkLine[], text: string) {
    lines.push({ who: 'you', text });
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
    const messages = lines
      .filter((l) => l.who !== 'info')
      .slice(-16)
      .map((l) => ({ role: l.who === 'you' ? 'user' : 'assistant', content: l.text }));
    let res: { ok: boolean; reply?: unknown; error?: string };
    try {
      const r = await fetch('/__trieres_talk__', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instructions: traderInstructions(persona, portName, facts),
          messages,
          schema: replySchema(others.map((id) => this.portNames[id])),
        }),
      });
      res = await r.json();
    } catch {
      res = { ok: false, error: 'offline' };
    }
    const reply = res.ok ? parseReply(res.reply, this.portNames) : null;
    if (!reply) {
      lines.push({ who: 'info', text: TALK_ERRORS[res.error ?? ''] ?? TALK_ERRORS.upstream });
      return;
    }
    lines.push({ who: 'them', text: reply.say });
    if (reply.note) this.notes[port] = reply.note;
    // every other-port price the trader passed on goes into the notebook, unless the notebook already knows newer
    const notebook = this.session.voyage.notebook;
    for (const t of reply.told) {
      const h = this.news.heard(port, t.port, now, route);
      if (!h) continue;
      const seen = notebook.find((e) => e.port === t.port && e.good === t.good);
      if (seen && seen.T >= h.T) continue;
      updateNotebook(notebook, { port: t.port, good: t.good, ask: h.ask[t.good], bid: h.bid[t.good], T: h.T, heard: true });
    }
    this.save();
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
