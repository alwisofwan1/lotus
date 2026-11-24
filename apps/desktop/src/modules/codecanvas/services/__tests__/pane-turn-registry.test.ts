import { describe, it, expect } from "vitest";
import { createPaneTurnRegistry, inputOpensTurn } from "../pane-turn-registry";
import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

describe("pane-turn-registry — turn lifecycle", () => {
  it("opens a turn only when a submit (Enter) is written to the pane", () => {
    const reg = createPaneTurnRegistry();

    expect(reg.isTurnOpen("a1")).toBe(false);
    reg.noteInput("a1", "fix the failing test\r");
    expect(reg.isTurnOpen("a1")).toBe(true);
  });

  it("plain typing without Enter does not open a turn", () => {
    const reg = createPaneTurnRegistry();
    reg.noteInput("a1", "just typing chars");
    expect(reg.isTurnOpen("a1")).toBe(false);
  });

  it("a bracketed paste containing newlines is not a submit", () => {
    const reg = createPaneTurnRegistry();
    // planLiveAgentPaste wraps pasted text in ESC[200~ … ESC[201~ — the TUI holds it in the
    // composer; only the later bare Enter submits.
    reg.noteInput("a1", "\x1b[200~line one\rline two\n\x1b[201~");
    expect(reg.isTurnOpen("a1")).toBe(false);

    reg.noteInput("a1", "\r"); // the delayed Enter after the paste IS the submit
    expect(reg.isTurnOpen("a1")).toBe(true);
  });

  it("closeTurn ends the window so the same settle can't announce twice", () => {
    const reg = createPaneTurnRegistry();
    reg.noteInput("a1", "\r");
    reg.closeTurn("a1");
    expect(reg.isTurnOpen("a1")).toBe(false);
  });

  it("an abandoned turn expires so hours-later repaints can't announce", () => {
    let now = 1_000_000;
    const reg = createPaneTurnRegistry(() => now);
    reg.noteInput("a1", "\r");

    now += 19 * 60_000; // still within the window — a genuinely long turn stays announceable
    expect(reg.isTurnOpen("a1")).toBe(true);

    now += 2 * 60_000; // past the 20-minute TTL
    expect(reg.isTurnOpen("a1")).toBe(false);
  });

  it("refreshes an open turn from real output without opening an idle pane", () => {
    let now = 1_000_000;
    const reg = createPaneTurnRegistry(() => now);

    reg.noteActivity("idle-pane");
    expect(reg.isTurnOpen("idle-pane")).toBe(false);

    reg.noteInput("a1", "run the suite\r");
    now += 19 * 60_000;
    reg.noteActivity("a1");
    now += 19 * 60_000;

    expect(reg.isTurnOpen("a1")).toBe(true);
  });

  it("a fresh submit re-opens an expired window", () => {
    let now = 1_000_000;
    const reg = createPaneTurnRegistry(() => now);
    reg.noteInput("a1", "\r");
    now += 60 * 60_000;
    expect(reg.isTurnOpen("a1")).toBe(false);

    reg.noteInput("a1", "\r");
    expect(reg.isTurnOpen("a1")).toBe(true);
  });
});

// claimAnnouncement is the single source of truth for "has THIS turn already been announced?" — it
// makes at-most-one-callout-per-turn hold no matter which finish signal (stop-hook or idle) wins,
// even when the frequency throttle is bypassed (cooldown=0 or freshTurn). Keyed by the turn's open
// timestamp, and it does NOT clear the window, so a second trigger for the same turn still sees it.
describe("pane-turn-registry — claimAnnouncement (per-turn dedup)", () => {
  it("grants the announcement once per open turn, then denies repeats of the same turn", () => {
    const reg = createPaneTurnRegistry();
    reg.noteInput("a1", "\r");
    expect(reg.claimAnnouncement("a1")).toBe(true); // first finish signal wins
    expect(reg.claimAnnouncement("a1")).toBe(false); // the other signal for the same turn is denied
    expect(reg.claimAnnouncement("a1")).toBe(false);
  });

  it("defers (returns true) when no turn is open — nothing to dedupe; the caller's throttle governs", () => {
    const reg = createPaneTurnRegistry();
    // Headless / autonomous finishes never open a submit turn; they must not be silenced here.
    expect(reg.claimAnnouncement("a1")).toBe(true);
  });

  it("re-arms for the next turn: a fresh submit allows a new announcement", () => {
    const reg = createPaneTurnRegistry();
    reg.noteInput("a1", "\r");
    expect(reg.claimAnnouncement("a1")).toBe(true);
    expect(reg.claimAnnouncement("a1")).toBe(false);

    reg.noteInput("a1", "\r"); // new user turn
    expect(reg.claimAnnouncement("a1")).toBe(true);
  });

  it("does not clear the window — a later repaint settle for an already-announced turn is denied", () => {
    const reg = createPaneTurnRegistry();
    reg.noteInput("a1", "\r");
    expect(reg.claimAnnouncement("a1")).toBe(true);
    // The turn is still 'open' (idle path relies on isTurnOpen), but a second claim is refused.
    expect(reg.isTurnOpen("a1")).toBe(true);
    expect(reg.claimAnnouncement("a1")).toBe(false);
  });

  it("an expired turn defers (true) and stops denying — no stale dedup after the TTL", () => {
    let now = 1_000_000;
    const reg = createPaneTurnRegistry(() => now);
    reg.noteInput("a1", "\r");
    expect(reg.claimAnnouncement("a1")).toBe(true);
    now += 21 * 60_000; // past TTL
    expect(reg.claimAnnouncement("a1")).toBe(true);
  });
});

describe("inputOpensTurn — Shift+Enter is composing, not submitting", () => {
  // Found on 2026-08-26 while wiring headlines to the write choke point, and proven by running the
  // predicate: `META_ENTER_SEQUENCE` is ESC + CR, and this function only stripped bracketed pastes
  // before looking for a CR. Every non-Claude-family runner (codex, cursor, custom) uses that
  // sequence for Shift+Enter — see `live-agent-newline.ts` — so inserting a newline while composing
  // a multi-line prompt was read as a submit.
  //
  // What that cost, live: `LiveAgentNode` calls `agentTurnRegistry.noteAnswered` on every input this
  // predicate accepts, and the Slice 8 resolver treats a human action after the fact as "the ask is
  // answered". So the `needs-you` badge cleared while the operator was still typing their reply to
  // an agent that was genuinely blocked — losing the one signal that agent had no way to re-raise.
  // It also opened a turn window for a turn that had not started.

  it("accepts a real submit", () => {
    expect(inputOpensTurn("fix the failing test\r")).toBe(true);
  });

  it("ignores Shift+Enter on a claude-family pane", () => {
    // Already correct — the kitty CSI-u encoding carries no CR. Pinned so it stays that way.
    expect(inputOpensTurn(KITTY_SHIFT_ENTER_SEQUENCE)).toBe(false);
  });

  it("ignores Shift+Enter on a codex/cursor/custom pane", () => {
    expect(inputOpensTurn(META_ENTER_SEQUENCE)).toBe(false);
  });

  it("ignores it mid-line too, where a composed prompt actually puts it", () => {
    expect(inputOpensTurn(`baris satu${META_ENTER_SEQUENCE}baris dua`)).toBe(false);
  });

  it("still sees the submit that follows a composed newline in one chunk", () => {
    // The sequence must be removed, not used to veto the whole chunk: a submit-queue write can carry
    // the newline and the Enter together, and dropping that would leave the turn never opening.
    expect(inputOpensTurn(`baris satu${META_ENTER_SEQUENCE}baris dua\r`)).toBe(true);
  });

  it("still ignores newlines inside a bracketed paste", () => {
    expect(inputOpensTurn("\u001b[200~satu\ndua\u001b[201~")).toBe(false);
  });
});
