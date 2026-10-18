# Pass 3: the playable opening

Done by the lead alone on October 17, 2026 (the user asked for no agent lanes), checked visually in the browser
as it was built, for [expectations-mvp-spec.md](expectations-mvp-spec.md) §1, §5 and §7 Pass 3.

## What landed

- **Fresh opening.** The merchant is the default ship (an explicit `?ship=` or the remembered choice still wins).
  A fresh voyage starts with 300 dr and an empty hold (`openingVoyage`; `newVoyage` keeps its 70 jars for the
  tests and review modes). After the title, Damaris stands on the quay at the foot of the plank, you stand on deck
  facing her, and the conversation opens with her first turn (`Conversation.notice`, a developer note describing
  the scene; no scripted line). E on her reopens it. She stays there until you cast off. Continue never runs the
  opening: the save records the transcript, and a loaded voyage has no pending opening.
- **The world stops** while a conversation or the personal menu is open (`Game.worldStopped`): clock, physics,
  wages, cargo, wind and sea, foam and rowing sounds. The ledger stays live. Closing catches up nothing. The game's
  keys stay with the open screen, and the cargo stack, hold and HUD still follow the books while stopped.
- **Personal menu** (`src/ui/personal.ts`, lines from `src/social/journal.ts`): Belongings (read a letter, show it
  to the person you are talking with), Ship cargo (whose jars, where), Expectations (the terms, what you said and
  how she took it, kept apart from what the terms say), Accounts (purse, each venture's account, recent receipts).
  It opens from the pause menu, the ledger's button and a conversation's Review agreement. Tab moves focus, the
  arrow keys move between tabs, and Esc closes the top layer. No new keys.
- **Conversation panel**: Confirm and Decline buttons on a card, plus Trade, Show letter and Review agreement under
  the line. A document a character shows you appears in the conversation as a quotation. Showing your letter to
  someone tells the model as a scene note, and they answer.
- **Calendar on the HUD**: the time and date under the sky dial. They dim while the world is stopped.
- Screens with buttons release the pointer lock (mouse look), and losing the lock to them doesn't open the pause
  menu.

## Decisions (yours to overrule)

1. Opening progress is not a separate saved flag. A loaded save never replays it, and the transcript is saved.
2. Damaris's opening figure is a second figure at the plank, not a move of the market stall's figure. Talking at
   the stall still works.
3. Agreement figures show to the centidrachma, as on the cards. The purse and receipts use the ledger's format.
4. The menu shows dates and quantities only. Overdue stages, warmth and the trust limit stay private.

## Result

Gates: typecheck, test:trade (golden unchanged), world, calendar, records, consignment, conversation, talk,
journal (new, 3 cases), merchant, lint (now also covering talk, personal and journal), build. Checked in the
browser: the opening (Damaris visible at the plank, her first turn, Esc, E again), the proposal card's buttons,
the agreement in Expectations over the conversation, Ship cargo, Accounts, Belongings (Read by keyboard), the
letter handed over and shown to Philon, the ledger button, the pause menu entry, Continue not replaying, and
cargo resuming after the screens close.

Still open: in her own words Damaris sometimes says you pay the home handling, while the card says she does (a
model wording issue).
