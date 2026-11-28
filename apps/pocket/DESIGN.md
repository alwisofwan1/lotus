# Design: Lotus Pocket

The visual system of the Pocket app. Read [`PRODUCT.md`](PRODUCT.md) first: it says who this is for and why.

- **Token values and their invariants:** [`docs/theme.md`](docs/theme.md) is the source of truth. This file
  names the rules; it does not repeat hexes that the code already owns.
- **Code:** everything a widget reads comes from `lib/app/theme/theme.dart`. Features never write
  `Color(0x…)`, `Colors.*` or a literal radius above 3 px (enforced by `test/architecture/`).
- **Visual spec:** the HTML mockup (`mockups/pocket-design.html`, kept out of git) shows every screen and state
  below. When the mockup and this file disagree, this file wins and the mockup is fixed.

## 1. Theme

**Graphite** is the default: warm opaque neutrals, one real light and one real dark variant, mode follows the
system. Scene: *a phone read at arm's length, on a train or outdoors, often in daylight.* Light must work in sun;
dark must work in a dim room. Neither is decoration.

- No glass. No `BackdropFilter`. A floating surface is fill + hairline + shadow.
- No gradients on content. No pure black or pure white: every neutral is tinted warm (chroma ≤ 0.03).
- The terminal ground stays dark in both themes, so entering a terminal reads as entering a pane.

## 2. Colour

Strategy: **restrained.** Tinted neutrals carry the screen. One hue has meaning.

Roles are named by job, never by hue (`ColorRole`):

| Group | Roles | Job |
|---|---|---|
| Surfaces | `ground`, `raised`, `track`, `key`, `keyActive`, `termGround` | page, sheet/card, control well, key cap, pressed key, terminal |
| Ink | `text`, `text2`, `text3`, `ornament` | primary, secondary, quiet (floor for any text), non-text marks only |
| Lines | `hairline`, `hairlineStrong` | dividers, borders of floating surfaces |
| Status | `waiting`, `onWaiting`, `live`, `error`, `onError` | needs you, working, failed |
| Other | `scrim`, `shadow`, `camera*` | behind sheets, under floating surfaces, scanner |

Rules:

1. **Amber (`waiting`) means one thing: an agent needs you.** Never use it for brand, focus, links, selection or
   "new". Material's `secondary`/`tertiary` stay default so no stock widget can borrow it.
2. **`waiting` is you, `live` is it.** Live is a small dot or a short shimmer line, never a fill.
3. **Colour never carries state alone.** Amber always comes with words ("Needs your OK"); live with "working";
   error with what failed.
4. **Primary button is an inversion** (`text` fill, `ground` ink), not an accent colour.
5. **Pairing is tested,** not eyeballed: see the matrix in `docs/theme.md` (text ≥ 4.5 on every surface, ornament
   ≥ 3.0 and never a sentence, status hues ≥ 60° apart).

### Status colours (proposed, 2026-11-28)

The earlier mockup's warmer amber, with lightness re-solved for AA. Amber is split into two jobs: `waiting` is
text and icons (≥ 4.5), the new `waitingRule` is borders and dots (non-text, ≥ 3.0). "Worst" is the lowest
contrast over `ground`, `raised`, `track`, `keyActive` and the amber-tinted card.

| Role | Light | Dark | Worst contrast |
|---|---|---|---|
| `waiting` | `#9B4F04` oklch(0.511 0.125 55) | `#F5B451` oklch(0.813 0.137 75) | 4.52 / 7.69 |
| `waitingRule` (new) | `#C26904` oklch(0.611 0.145 58) | `#F59E0B` oklch(0.769 0.165 70) | 3.01 / 6.52 |
| `waitingTint` (new) | `#D97706` at 8% | `#F59E0B` at 10% | fill only |
| `error` | `#BD3379` oklch(0.551 0.185 354) | `#E7768A` oklch(0.700 0.141 10) | 4.52 / 5.52 |

- The earlier mockup's light amber `#B45309` measured 3.81 on the pressed key and its rule `#D97706` 2.42: both
  fail. Dark already passed and is kept as it was.
- Red moved pinker in both themes to stay 60° of hue away from amber. The earlier orange-red `#C2410C` sat 11°
  from it and read as a second amber.
- `onWaiting` still passes: white on light `waiting` 5.66, `#1A1300` on dark `waiting` 10.1.
- Not in code yet. Shipping it means updating `palettes/graphite.dart`, adding the two roles to `ColorRole`,
  and running `flutter test test/app/theme` (the invariant suite checks every number above).

## 3. Typography

Geist (400 / 500 / 600) for UI and prose; Geist Mono (400) for commands, paths, models and numbers. The terminal
keeps its own font stack. `TypeRole` carries family only; size comes from the scale below.

| Step | Size / line | Weight | Use |
|---|---|---|---|
| display | 28 / 34 | 600 | screen title on Home and Settings only |
| title | 17 / 24 | 600 | page header, sheet title, card headline |
| body | 16 / 24 | 400 | chat prose, input text, sheet rows |
| label | 15 / 20 | 500 | buttons, row names, segmented controls |
| meta | 13 / 18 | 400 | timestamps, project · folder lines, section labels |
| mono | 13.5 / 20 | 400 | inline and block code, commands, model names |

- Six steps, no others. A new size is a design change, not a local tweak.
- Section labels are meta in sentence case, `text3`. No all-caps tracking labels.
- Prose is capped at the screen; inside a sheet on a tablet, cap at 65ch.
- Must reflow at 200% system text size: no fixed-height rows that clip text.

> Status: the scale is proposed (`plans/pocket-ui-research/theme-architecture.md`) and not yet a token in code.
> Adding it as `AppTextScale` is part of the implementation round.

## 4. Space and layout

Spacing steps: **4 · 8 · 12 · 16 · 20 · 24 · 32 · 40.** Screen side margin 20.

- Vary space for rhythm: 8 inside a row, 16 between rows of a group, 32 between groups.
- Lists are rows on the ground with hairline dividers. A card is used only for a thing the user must act on (a
  "needs you" item, an approval). No nested cards.
- Primary actions sit in the bottom half: composer, sheet footers, approval buttons.
- Touch targets ≥ 48 dp (Material text buttons keep the 44 px floor already in code).

## 5. Shape and elevation

`ShapeRole` by job. Graphite folds them onto four radii:

| Radius | Roles |
|---|---|
| 6 | tail, tag |
| 10 | key, thumb, chip |
| 16 | option, block, row, field, card, button, bubble, banner |
| 24 | composer, sheet |
| pill | avatars, dots, counters |

Elevation (`ElevationRole`): `floating` 4 (composer, snackbars), `menu` 8 (menus). Sheets use the scrim, not a
bigger shadow. Nothing else casts a shadow.

## 6. Motion

`AppMotion`: `swap` 180 ms, `settle` 220 ms, curve `Curves.easeOutQuart`. Every duration goes through
`AppMotion.of(context, d)` so "remove animations" gives zero.

- Ease out only. **No overshoot, no bounce, no elastic,** including toggles and badges.
- Animate opacity and transform. Never animate layout size or position of a list under a finger.
- The Home list freezes while a finger is down; new items arrive after release.
- Shimmer on a working line is the only looping motion, and it stops under reduced motion.

## 7. Sound and haptics

Both confirm what the user did. Neither announces what an agent did while the app is open (that is the push
notification's job).

**Haptics** (`Tactile`, three verbs, never call `HapticFeedback` directly):

| Verb | Platform call | When |
|---|---|---|
| `chose` | selectionClick | moved a selection: picker, segment, tab, swipe to next agent |
| `sent` | mediumImpact | words left the phone: send, queued send |
| `answered` | heavyImpact | a permission was answered (the one act that can change a remote machine) |

**Sound** (new; off switch in Settings → Sound and haptics; silent mode mutes by default). Soft mechanical clicks,
like a mouse or a game menu, never a message alert. Short (35–140 ms), dry, peak about −9 dBFS.

| Event | Sound | Pairs with |
|---|---|---|
| tap | light click | none |
| select | key press, soft thock | `chose` |
| toggle | press + release | `chose` |
| open sheet | low thock, pitch up | none |
| close sheet | low thock, pitch down | none |
| send | click-click up | `sent` |
| done / answered | heavy thock + tick | `answered` |
| undo | done reversed | none |

## 8. Components

Each component lists the states it must draw. A state not drawn is a bug.

| Component | States |
|---|---|
| Agent row (Home) | idle · working (live dot + shimmer) · needs you (card, below) · done · error · offline host · pressed |
| Needs-you card | command / edit / question variants · answering (buttons disabled, spinner in pressed button) · answered (collapses to a log line) · expired |
| Approval card (Chat) | same three variants · Deny with optional reason · "Always for this command" · locked composer while it waits |
| Setup bar + sheet | agent, model, thinking, permission, where · models loading · models stale ("from X · 3 min ago") · agent missing / sign-in needed |
| Composer | empty · typing · quoting · queued offline ("Waiting to send") · locked (with reason) · sending |
| Message actions | Copy → "Copied" 1.4 s · Add to chat (quote strip) |
| Connection bar | online (hidden) · weak · reconnecting (counter) · offline · host asleep · pairing expired |
| Buttons | default · pressed (`keyActive`) · disabled (`ornament` ink) · loading · focus ring (2 px `text`, keyboard and switch access) |
| Switch / segment | off · on · disabled; thumb slides with `swap`, no overshoot |
| Settings row | navigation (chevron) · toggle · value · destructive (error ink, confirm sheet) |

**Needs-you card: the compact "permission slip"** (chosen 2026-11-28; *Creative* in the mockup, about 140 px tall).

1. Head in `waitingTint`, one line: tile 24 · name · project · time, then on the right an amber dot and
   amber words ("Wants to run", "Wants to edit", "Needs an answer").
2. One line of the ask: `$` + the command in mono 15 (flags in `text3`), a pencil + file names for an edit,
   or the question in 15/600, clamped to two lines.
3. A 1 px dashed tear line with two 12 px notches.
4. Stub: a 48 px **slide to answer** track. The thumb starts in the centre, left is Deny and right is Allow.
   That is equal weight and equal distance, and a tap by mistake cannot answer. Past 70% of the way the thumb
   turns into × or ✓ and the far label fades. Tapping a label only nudges the thumb. Screen readers get two
   plain actions (Deny, Allow) instead of the drag. Questions keep two 44 px pill buttons, View and Answer.

The card is `raised`, with a 1 px ring of `waitingRule` at about 20% and a soft shadow. No amber button, and
never a thick coloured left or right border: amber marks *which* card, the words say *why*. The earlier
bordered card (*Calm* in the mockup) is kept only as a fallback.

## 9. Icons and logos

- **UI icons:** one outline set, 1.5 px stroke, 20 px in rows and 24 px in the app bar. No emoji or Unicode glyphs
  as icons.
- **Agent logos:** one source for both apps, `apps/desktop/public/assets/ai-logo/*.svg`. Pocket builds
  `lib/features/shared/runner_marks.g.dart` from it with `node scripts/generate-runner-marks.mjs`. Never draw or
  copy a vendor mark by hand.
- **Where colour is allowed:** full vendor colour only where a brand is being chosen (agent picker, setup tiles).
  In dense places (Home rows, chat header, settings list) the mark is a flat silhouette in the row's ink, or
  `waiting` when that row needs you. The agent name always sits beside the mark.
- **Unknown runner:** a generic mark. Never another vendor's logo. Codex uses the ChatGPT mark, as on desktop.
- Brand marks must clear 3.0 on `ground` and `raised` in both themes (`tokens/brand_marks.dart`).

## 10. Copy

- Sentence case everywhere, including buttons and section labels.
- No em dashes. Use commas, colons or full stops.
- Short and literal: "needs you", "Nobody needs you", "Waiting to send", "Pair again to continue".
- Report ground truth, not the agent's claim: "3 files changed · tests passed", not "Done! Everything works."
- Name the agent by its display name ("Kai"), the runner by its product name ("Claude Code").
- Examples and fixtures use placeholders only (Acme, acme-web, Orbit, TKT-123).

## 11. Accessibility checklist

- Contrast matrix passes in both themes (`flutter test test/app/theme`).
- Every tappable thing ≥ 48 dp, with a semantics label that says the action ("Allow npm test for Kai").
- 200% text size: nothing clips, rows grow.
- Reduced motion: zero durations, no shimmer.
- State is never colour-only.
- Sound is optional and never the only feedback.
