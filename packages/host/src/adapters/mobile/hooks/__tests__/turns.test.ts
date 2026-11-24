import { describe, expect, it } from "vitest";

import { awaitingPermission, HookTurns, TURN_TTL_MS } from "../turns.js";
import type { DropPayload } from "../payload.js";

const NOW = 1_800_000_000_000;

const payload = (over: Partial<DropPayload> = {}): DropPayload => ({
  version: 1, sessionId: "s", agentType: "claude", event: "needs-input", status: "needs-input",
  title: "Needs input", body: "", userPrompt: "", toolTarget: "", bodyTruncated: false,
  transcriptPath: "", cwd: "/srv/api", pid: 1, agentPid: 2, paneId: "pane-7", timestamp: NOW,
  ...over,
});

const PROMPT = [
  "Do you want to create approved.txt?",
  "\u276f 1. Yes",
  "  2. Yes, allow all edits during this session (shift+tab)",
  "  3. No",
  "",
].join("\n");

describe("HookTurns", () => {
  /**
   * Correlation is by pane id alone. The schema calls `cwd` the key and on a desktop that holds;
   * here several cells share one project routinely, so cwd would hand one cell's approval to
   * another — the exact mistake ADR-8 calls unrecoverable once a digit is sent.
   */
  it("records a turn against the pane the agent was started in", () => {
    const turns = new HookTurns(() => NOW);

    expect(turns.record(payload())).toBe(true);
    expect(turns.statusOf("pane-7")).toMatchObject({ status: "needs-input", agentType: "claude" });
  });

  it("drops a hook that cannot name its pane, rather than guessing from cwd", () => {
    const turns = new HookTurns(() => NOW);

    expect(turns.record(payload({ paneId: null }))).toBe(false);
    expect(turns.size()).toBe(0);
  });

  it("keeps only the latest word from a pane", () => {
    const turns = new HookTurns(() => NOW);

    turns.record(payload({ status: "needs-input" }));
    turns.record(payload({ status: "idle", event: "stop", timestamp: NOW + 10 }));

    expect(turns.statusOf("pane-7")?.status).toBe("idle");
  });

  /** A `needs-input` from this morning is not a question anybody is still holding. */
  it("forgets a turn that has aged out", () => {
    let now = NOW;
    const turns = new HookTurns(() => now);
    turns.record(payload());

    now = NOW + TURN_TTL_MS + 1;

    expect(turns.statusOf("pane-7")).toBeUndefined();
    expect(turns.size()).toBe(0);
  });

  it("says nothing about a pane it has never heard of", () => {
    expect(new HookTurns(() => NOW).statusOf("pane-none")).toBeUndefined();
  });

  it("forgets a pane on request, so a closed cell asks nothing", () => {
    const turns = new HookTurns(() => NOW);
    turns.record(payload());

    turns.forget("pane-7");

    expect(turns.statusOf("pane-7")).toBeUndefined();
  });

  /**
   * Two producers, one map. The shell hook carries only what a `curl` can — pane, status, time —
   * and the drop file brings the rest; a reader must not be able to tell which one wrote, beyond
   * what each could know.
   */
  it("takes what the shell hook can say, and what the drop file can say, into one place", () => {
    const turns = new HookTurns(() => NOW);

    turns.recordTurn("pane-7", "needs-input", NOW);
    expect(turns.statusOf("pane-7")).toMatchObject({ status: "needs-input" });

    turns.record(payload({ status: "idle", timestamp: NOW + 5 }));
    expect(turns.statusOf("pane-7")).toMatchObject({ status: "idle", agentType: "claude" });
  });

  it("falls back to its own clock when the producer sent no timestamp", () => {
    const turns = new HookTurns(() => NOW);
    turns.record(payload({ timestamp: 0 }));

    expect(turns.statusOf("pane-7")?.at).toBe(NOW);
  });
});

/**
 * ADR-8's rule, as a truth table. Every disagreement fails closed: a missing chip costs one trip
 * to the raw terminal, a chip over running work sends a digit into it.
 */
describe("awaitingPermission", () => {
  const turn = (status: string) => ({ status, at: NOW, agentType: "claude" });

  it("draws a prompt only when the hook AND the terminal agree", () => {
    const answer = awaitingPermission(turn("needs-input"), PROMPT);

    expect(answer.awaiting).toBe(true);
    expect(answer.prompt?.question).toBe("Do you want to create approved.txt?");
    // The digits come from the terminal, never from the hook: a hook knows a prompt happened,
    // not what it offered.
    expect(answer.prompt?.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
  });

  /**
   * The prompt scrolled away, or has not been drawn yet. The cell IS waiting — saying otherwise
   * hides a stuck agent — but no digit is offered, because a wrong one approves what the operator
   * meant to refuse. A client renders this as a pointer to the terminal.
   */
  it("still says waiting when the terminal shows no prompt, but offers no digit", () => {
    expect(awaitingPermission(turn("needs-input"), "just output\nnothing to answer\n"))
      .toEqual({ awaiting: true, prompt: null });
  });

  /**
   * A tail holds old prompts and `parsePermissionPrompt` reads the LAST one — which may have been
   * answered ten minutes ago. Without a hook saying so, it is history.
   */
  it("refuses a prompt in the tail that no hook is asking about", () => {
    expect(awaitingPermission(undefined, PROMPT)).toEqual({ awaiting: false, prompt: null });
    expect(awaitingPermission(turn("idle"), PROMPT)).toEqual({ awaiting: false, prompt: null });
    expect(awaitingPermission(turn("running"), PROMPT)).toEqual({ awaiting: false, prompt: null });
  });

  it("refuses when neither signal is there", () => {
    expect(awaitingPermission(undefined, "")).toEqual({ awaiting: false, prompt: null });
  });
});
