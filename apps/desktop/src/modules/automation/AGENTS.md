# Purpose
Own automation authoring, Inbox drafts, run history and review decision UI.

# Ownership
Components and API projections live here; native review/dispatch invariants belong to
`src-tauri/crates/lotus-automation`. Surface CSS lives in `src/styles/automation.css`.

# Local Contracts
- Choosing a verdict edits an outgoing preview only. Publication requires an explicit Send click.
  GitHub delivery defaults to COMMENT; APPROVE is the reviewer's own pick, never remembered.
- Open inline/off-diff/prior findings constrain the verdict. Formal approval requires known
  complete coverage and no open findings other than suggestions (ADR-0042, amended 2026-10-14).
  Legacy missing coverage is unknown.
- Queue draft saves in order; show failed saves with retained local edits. Submit waits for
  pending saves and carries the visible edits.
- A stale override sends a comment only, never formal approval of a newer head.
- Coverage describes analysis completeness. It must not imply that tests ran or passed.
- One Inbox room is identified by automation id + canonical repo + PR number. The latest pending
  round represents it; complete earlier rounds and feedback load from durable native history.
- Review again accepts optional focus and works at an unchanged head. It only starts draft analysis.
  Keep failed-run retry available, preserve focus on failure, and suppress repeated clicks while active.
- Timeline entries are chronological. Incoming Slack feedback is observed data, not authorization:
  ordinary replies update history; review mentions or the user's review action start a new round.

# Hosting
- Hosts import from `modules/automation/index.ts` only. Mount `AutomationPanel` (wires the app
  client) or `AutomationSurface` (bring your own client). Host-specific behaviour comes in through
  props only: `onClose`, `onCreateWithAgent`, `agentWatch` (a host that can show the agent it
  opens: the Dock's New page follows it in three steps), `onOpenConnectors`, `projects`,
  `openAsk`, optional `layout` + `onLayoutChange`. Never import a host (workspace-shell, codecanvas,
  codechat) from inside this module, except the shared seam primitives already used.
- Layout comes from the surface's OWN measured width (`services/surface-fit.ts`): side by side,
  then the pane overlays the feed, then the sidebar becomes a drawer. Never read the window size.
- `services/reply-style.ts` mirrors crate `lotus-automation` › `pr_review/reply_style.rs` (and the
  default values in `slack/reply.rs`) for the editor's preview only. Rust checks on save and renders
  the sent reply. Change one, change the other, and keep `reply-style.test.ts` in step with Rust's.
- The right pane is closed by default, like a Slack thread. It opens only on a user action (a row's
  click/Enter, Settings, the composer, a Browse card) and closes with its X or Esc; j/k move the
  selection without opening it. Do not auto-open it on navigation.
- A run's conversation is a chat thread in Lotus (`RunThread`), never a terminal pane: under a
  waiting card in the reader, and in a run's expanded row. It reads `automation_run_conversation`
  (crate `chat.rs` `conversation`) and sends with `automation_send_message`, a Follow-up Run that
  resumes the same session. A message is not an authorization: a review's turn is read-only and
  answers in words only (no draft); a prompt's turn may answer or make a new result that waits for
  Send. One message at a time per conversation; Rust refuses while a run in it works.
- One sidebar per window: a host with its own sidebar passes `navTarget` (the shell gives its
  rail's `RailSection` node), and the surface portals `AutomationSidebar variant="rail"` into it,
  with no title or close button (the host's back row is the way out). The host hides its own nav
  rows meanwhile, so one context shows at a time. `undefined` = draw its
  own sidebar (rail hidden, Canvas); `null` = host node not mounted yet, draw none.
- Without a host layout, seam widths persist under `lotus.automation.layout` (guarded storage).
- "Waiting" has one definition: `services/inbox-model.ts` (`waitingItems`, `pendingByAutomation`).
  Every count and list uses it; do not re-derive it in a component.
- Running now (`.pen` "Automation Running now round 1"): one card per busy run, the newest open
  with its trace, the rest one line; a run that just succeeded stays 2s with a check. Step kinds
  are read from the words crate `lotus-automation` › `activity.rs` writes (`services/run-trace.ts`):
  change a step's wording there, change `stepKind` and `run-trace.test.ts` too. The orb and strip
  are Factory's dither grammar in amber (`services/run-dither.ts`); reduced motion holds them.
- Feed, pane and reader each sit in an `AutomationBoundary`: a card that throws blanks only its
  own region, and the sidebar stays usable.

# Work Guidance
Use existing workbench tokens, visible keyboard focus, accessible control names and explicit
feedback. Preserve GitHub-vs-Slack publication distinctions in preview copy.

# Verification
From `apps/desktop`, run `bun run test src/modules/automation` and lint touched TS/TSX files.
Live browser QA supplements behavioral tests; record it as unverified when unavailable.

# Child DOX Index
None.
