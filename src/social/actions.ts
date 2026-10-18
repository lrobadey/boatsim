// Social commands (expectations-mvp-spec §3.1, §3.6; docs/pass-2-plan.md lane A): showing documents and recording
// spoken promises. Like Dealings, every command takes a request id first, keeps its result in world.results, and
// changes nothing on a refusal. Pure: no DOM.

import type { Result } from '../trade/consignment';
import type { CharacterId, Holder, WorldDocument, WorldState } from '../trade/world';

const todo = (): never => {
  throw new Error('not implemented: Pass 2 A');
};

/** The documents a holder has now, oldest first. */
export function documentsHeldBy(_world: WorldState, _who: Holder): WorldDocument[] {
  return todo();
}

export class SocialActions {
  constructor(readonly o: { world: WorldState; now: () => number }) {}

  /**
   * `by` shows a document it holds to `to` (who must be present: the caller vouches for that). Refused 'unknown'
   * for a missing document, 'state' if `by` doesn't hold it or by === to. Effects: a 'document-shown' record for
   * `to` (source 'shown', id `${to}:shown:${document}:${by}`, written once). When `by` is the player and `to` is
   * the letter's author, the author also mails its recipient a 'letter-shown' note (by NPC ship). With handOver,
   * the holder becomes `to`.
   */
  showDocument(_req: string, _o: { document: string; by: Holder; to: Holder; handOver?: boolean }): Result<{ handedOver: boolean }> {
    return todo();
  }

  /**
   * Records something the player said to `holder` as a 'promise' record (source 'witnessed', id
   * `${holder}:promise:${req}`). expectDay is a calendar day number (day N is [24·(N−1), 24·N)); expectT is the
   * end of it, 24·N. Refused 'state' if the claim or citation is empty or expectDay isn't a whole day ≥ today.
   */
  recordPromise(
    _req: string,
    _o: { holder: CharacterId; claim: string; interpretation: 'firm' | 'tentative' | 'conditional'; citation: string; agreement?: string; expectDay: number },
  ): Result<{ record: string }> {
    return todo();
  }
}
