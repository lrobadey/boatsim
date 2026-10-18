// Social commands (expectations-mvp-spec §3.1, §3.6; docs/pass-2-plan.md lane A): showing documents and recording
// spoken promises. Like Dealings, every command takes a request id first, keeps its result in world.results, and
// changes nothing on a refusal. Pure: no DOM.

import type { Refusal, Reason, Result } from '../trade/consignment';
import { takeWorldId, type CharacterId, type Holder, type WorldDocument, type WorldState } from '../trade/world';
import { addRecord } from './records';

const refuse = (reason: Reason): Refusal => ({ ok: false, reason });

const portOf = (world: WorldState, who: CharacterId): number => world.characters.find((c) => c.id === who)?.port ?? -1;

/** The documents a holder has now, oldest first. */
export function documentsHeldBy(world: WorldState, who: Holder): WorldDocument[] {
  return world.documents.filter((d) => d.holder === who);
}

export class SocialActions {
  constructor(readonly o: { world: WorldState; now: () => number }) {}

  private run<R>(req: string, fn: () => R): R {
    const { results } = this.o.world;
    if (Object.prototype.hasOwnProperty.call(results, req)) return results[req] as R;
    const r = fn();
    results[req] = r;
    return r;
  }

  /**
   * `by` shows a document it holds to `to` (who must be present: the caller vouches for that). Refused 'unknown'
   * for a missing document, 'state' if `by` doesn't hold it or by === to. Effects: a 'document-shown' record for
   * `to` (source 'shown', id `${to}:shown:${document}:${by}`, written once). When `by` is the player and `to` is
   * the letter's author, the author also mails its recipient a 'letter-shown' note (by NPC ship). With handOver,
   * the holder becomes `to`.
   */
  showDocument(req: string, o: { document: string; by: Holder; to: Holder; handOver?: boolean }): Result<{ handedOver: boolean }> {
    return this.run<Result<{ handedOver: boolean }>>(req, () => {
      const { world } = this.o;
      const doc = world.documents.find((d) => d.id === o.document);
      if (!doc) return refuse('unknown');
      if (doc.holder !== o.by || o.by === o.to) return refuse('state');
      const T = this.o.now();
      addRecord(world, {
        id: `${o.to}:shown:${o.document}:${o.by}`,
        holder: o.to,
        T,
        source: 'shown',
        kind: 'document-shown',
        facts: { document: o.document, by: o.by },
      });
      if (o.by === 'player' && o.to === doc.from && !world.mail.some((m) => m.kind === 'letter-shown' && m.facts.document === doc.id)) {
        world.mail.push({
          id: takeWorldId(world, 'M'),
          kind: 'letter-shown',
          from: doc.from,
          to: doc.to,
          fromPort: portOf(world, doc.from),
          toPort: portOf(world, doc.to),
          writtenT: T,
          facts: { document: doc.id, by: 'player' },
          deliverT: null,
          delivered: false,
        });
      }
      if (o.handOver) doc.holder = o.to;
      return { ok: true, handedOver: !!o.handOver };
    });
  }

  /**
   * Records something the player said to `holder` as a 'promise' record (source 'witnessed', id
   * `${holder}:promise:${req}`). expectDay is a calendar day number (day N is [24·(N−1), 24·N)); expectT is the
   * end of it, 24·N. Refused 'state' if the claim or citation is empty or expectDay isn't a whole day ≥ today; 'unknown' if agreement isn't one the holder owns.
   */
  recordPromise(
    req: string,
    o: { holder: CharacterId; claim: string; interpretation: 'firm' | 'tentative' | 'conditional'; citation: string; agreement?: string; expectDay: number },
  ): Result<{ record: string }> {
    return this.run<Result<{ record: string }>>(req, () => {
      const T = this.o.now();
      const today = Math.floor(T / 24) + 1;
      if (!Number.isSafeInteger(o.expectDay) || o.expectDay < today) return refuse('state');
      if (o.claim.trim() === '' || o.citation.trim() === '') return refuse('state');
      // a promise can only concern one of the holder's own agreements (only those can be kept)
      if (o.agreement !== undefined && !this.o.world.agreements.some((a) => a.id === o.agreement && a.owner === o.holder)) return refuse('unknown');
      const id = `${o.holder}:promise:${req}`;
      addRecord(this.o.world, {
        id,
        holder: o.holder,
        T,
        source: 'witnessed',
        kind: 'promise',
        facts: {
          claim: o.claim,
          interpretation: o.interpretation,
          citation: o.citation,
          ...(o.agreement !== undefined ? { agreement: o.agreement } : {}),
          expectT: 24 * o.expectDay,
        },
      });
      return { ok: true, record: id };
    });
  }
}
