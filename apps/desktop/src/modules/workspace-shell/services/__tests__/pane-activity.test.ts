import { describe, expect, it } from "vitest";
import {
  capabilityForCommand,
  formatPaneActivityAge,
  needsYouPaneIds,
  paneActivityAnimates,
  paneActivityShowsAge,
  paneActivityTone,
  resolveChatPaneActivity,
  resolvePaneActivity,
  resolveTerminalPaneActivity,
  stampPaneActivities,
  workingPaneCount,
  type PaneActivityState,
  type TerminalPaneSignals,
} from "@/modules/workspace-shell/services/pane-activity";
import type { GridCell } from "@/modules/codespace/components/types";
import type { PaneActivity } from "@/modules/workspace-shell/types";

const NOW = 1_700_000_000_000;

function terminal(overrides: Partial<TerminalPaneSignals> = {}): TerminalPaneSignals {
  return {
    runtimeStatus: "live",
    activity: "idle",
    fact: undefined,
    answeredAtMs: undefined,
    // Claude reports both ends by hook — the permissive case, so a test that wants the
    // conservative one has to say so.
    capability: { reportsTurnEnd: true, reportsSteps: true },
    now: NOW,
    ...overrides,
  };
}

describe("a terminal pane's lifecycle outranks everything", () => {
  it("reports a failed PTY as failed, whatever the last hook said", () => {
    const state = resolveTerminalPaneActivity(
      terminal({ runtimeStatus: "failed", fact: { paneId: "p", turn: "needs-input", atMs: NOW } }),
    );
    // A pane that crashed while blocked must not sit on the rail asking for input forever.
    expect(state).toBe("failed");
  });

  it("an alive agent that printed its start error is failed, not ready", () => {
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "live", activity: "idle", startError: true }))).toBe("failed");
    // A pane that ended is described by that, whatever it printed before.
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "exited", startError: true }))).toBe("done");
  });

  it("separates a pane that ended from one that never started", () => {
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "exited" }))).toBe("done");
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "idle" }))).toBe("offline");
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: undefined }))).toBe("offline");
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "starting" }))).toBe("starting");
  });

  it("treats a detached pane as alive — it is running, just not on screen", () => {
    expect(resolveTerminalPaneActivity(terminal({ runtimeStatus: "detached", activity: "running" }))).toBe(
      "working",
    );
  });
});

describe("a live terminal pane, with no hook fact", () => {
  it("follows the PTY activity registry", () => {
    expect(resolveTerminalPaneActivity(terminal({ activity: "running" }))).toBe("working");
    expect(resolveTerminalPaneActivity(terminal({ activity: "idle" }))).toBe("idle");
  });

  it("a plain shell never reads as working — only an agent does", () => {
    expect(resolveTerminalPaneActivity(terminal({ agent: false, activity: "running" }))).toBe("idle");
    // Lifecycle still shows for a shell.
    expect(resolveTerminalPaneActivity(terminal({ agent: false, runtimeStatus: "failed" }))).toBe("failed");
  });

  it("never invents an ask", () => {
    // The invariant: `needs-you` comes from a hook or not at all. Nothing in the PTY signal may
    // produce it.
    const states = (["idle", "running"] as const).map((activity) =>
      resolveTerminalPaneActivity(terminal({ activity })),
    );
    expect(states).not.toContain("needs-you");
  });
});

describe("a hook fact, once the runner may be believed", () => {
  it("lets a PTY that settled after a stale running fact read as ready", () => {
    const state = resolveTerminalPaneActivity(
      terminal({
        activity: "idle",
        activitySinceMs: NOW - 60_000,
        fact: { paneId: "p", turn: "running", atMs: NOW - 2 * 60 * 60_000 },
      }),
    );
    expect(state).toBe("idle");
  });

  it("raises an ask over a quiet PTY", () => {
    const state = resolveTerminalPaneActivity(
      terminal({ activity: "idle", fact: { paneId: "p", turn: "needs-input", atMs: NOW - 5_000 } }),
    );
    expect(state).toBe("needs-you");
  });

  it("is declined for a runner that cannot report steps", () => {
    // `gemini`, `opencode`, a bare shell: nothing has been established about what they report, so
    // a fact claiming a mid-turn state is not evidence and the PTY guess stands.
    const state = resolveTerminalPaneActivity(
      terminal({
        activity: "idle",
        capability: { reportsTurnEnd: false, reportsSteps: false },
        fact: { paneId: "p", turn: "needs-input", atMs: NOW - 5_000 },
      }),
    );
    expect(state).toBe("idle");
  });

  it("is retracted by a human answering, even though no further hook will fire", () => {
    // The rejection path: refusing a permission prompt fires no hook at all, so without this the
    // ask would never be withdrawn.
    const state = resolveTerminalPaneActivity(
      terminal({
        activity: "idle",
        fact: { paneId: "p", turn: "needs-input", atMs: NOW - 10_000 },
        answeredAtMs: NOW - 1_000,
      }),
    );
    expect(state).toBe("idle");
  });

  it("expires once it is older than the freshness bound", () => {
    // A fact from a working session five hours ago describes a pane nobody is looking at any more.
    const state = resolveTerminalPaneActivity(
      terminal({ activity: "idle", fact: { paneId: "p", turn: "needs-input", atMs: NOW - 5 * 3_600_000 } }),
    );
    expect(state).toBe("idle");
  });

  it("maps a reported end onto a finished pane, and an error onto a failed one", () => {
    expect(
      resolveTerminalPaneActivity(terminal({ fact: { paneId: "p", turn: "ended", atMs: NOW } })),
    ).toBe("done");
    expect(
      resolveTerminalPaneActivity(terminal({ fact: { paneId: "p", turn: "error", atMs: NOW } })),
    ).toBe("failed");
  });

  it("declines a turn word this build has never heard of", () => {
    // The vocabulary lives in a hook script that can grow without a desktop rebuild.
    const state = resolveTerminalPaneActivity(
      terminal({ activity: "running", fact: { paneId: "p", turn: "compacting", atMs: NOW } }),
    );
    expect(state).toBe("working");
  });
});

describe("which runner a command implies", () => {
  it("believes the families whose hooks Lotus installs", () => {
    expect(capabilityForCommand("claude")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    expect(capabilityForCommand("codex")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    // Cursor runs the tool hooks but reports no turn end — the mirror image of Codex's old shape.
    // The command is what the machine's catalog really launches, `cursor-agent`, which the
    // provider registry does not recognise (it holds `cursor`); the binary table covers it.
    expect(capabilityForCommand("cursor-agent --yolo")).toEqual({
      reportsTurnEnd: false,
      reportsSteps: true,
    });
    expect(capabilityForCommand("/opt/homebrew/bin/cursor-agent")).toEqual({
      reportsTurnEnd: false,
      reportsSteps: true,
    });
    // `ccs` wraps a second Claude account and drives the same hooks.
    expect(capabilityForCommand("ccs --profile work")).toEqual({
      reportsTurnEnd: true,
      reportsSteps: true,
    });
  });

  it("believes the agents that report OSC 7501 program status from their own PTY", () => {
    const all = { reportsTurnEnd: true, reportsSteps: true };
    expect(capabilityForCommand("pi")).toEqual(all);
    expect(capabilityForCommand("agy --dangerously-skip-permissions")).toEqual(all);
    expect(capabilityForCommand("", "grok")).toEqual(all);
    // Kimi has no such report: still nothing.
    expect(capabilityForCommand("kimi")).toEqual({ reportsTurnEnd: false, reportsSteps: false });
  });

  it("believes nothing about a plain shell or an unknown CLI", () => {
    expect(capabilityForCommand(undefined)).toEqual({ reportsTurnEnd: false, reportsSteps: false });
    expect(capabilityForCommand("bash")).toEqual({ reportsTurnEnd: false, reportsSteps: false });
  });

  /**
   * Observed live 2026-09-22 on pane `3e4a0cde`: opened as a plain shell (`agent_command` is ""
   * in `codespace.sqlite3`), then the operator typed `claude` into it. The fleet named it
   * `claude-2` from the detected runner while this function still answered "shell", so every
   * hook fact the pane produced was refused and its badge read "ready" for the whole session.
   */
  it("believes the runner a pane is REALLY running, not the command it was opened with", () => {
    expect(capabilityForCommand("", "claude")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    expect(capabilityForCommand(undefined, "codex")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    // A handoff: launched as claude, now running codex. Both report everything, but the point is
    // that the LATER reading is the one consulted.
    expect(capabilityForCommand("claude", "cursor")).toEqual({ reportsTurnEnd: false, reportsSteps: true });
    // Nothing detected yet, or detected as a plain shell: the launch command still decides.
    expect(capabilityForCommand("claude", null)).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    expect(capabilityForCommand("claude", "shell")).toEqual({ reportsTurnEnd: true, reportsSteps: true });
    expect(capabilityForCommand("", "shell")).toEqual({ reportsTurnEnd: false, reportsSteps: false });
  });
});

describe("a thread pane", () => {
  it("is working while the reply is arriving, and at rest after", () => {
    expect(resolveChatPaneActivity({ streaming: true })).toBe("working");
    expect(resolveChatPaneActivity({ streaming: false })).toBe("idle");
  });

  it("needs you while a new-chat turn waits on an approval (07d)", () => {
    expect(resolveChatPaneActivity({ streaming: true, waiting: true })).toBe("needs-you");
  });
});

describe("panes that run nothing", () => {
  it("draws a browser and an editor at rest rather than inventing a state", () => {
    const browser = { id: "b", cwd: "/x", type: "browser", url: "https://x" } as unknown as GridCell;
    expect(resolvePaneActivity(browser, {})).toBe("idle");
  });

  it("reports a terminal with no signals as offline rather than idle", () => {
    const cell = { id: "t", cwd: "/x", type: "terminal" } as unknown as GridCell;
    expect(resolvePaneActivity(cell, {})).toBe("offline");
  });
});

describe("how a state is presented", () => {
  it("animates work in progress and NOTHING else", () => {
    const activities: PaneActivity[] = [
      "offline",
      "starting",
      "idle",
      "working",
      "needs-you",
      "failed",
      "done",
    ];
    expect(activities.filter(paneActivityAnimates)).toEqual(["working"]);
    // Stated twice on purpose: a pulsing "answer me" reads as progress, which is the lie this
    // whole signal exists to avoid.
    expect(paneActivityAnimates("needs-you")).toBe(false);
  });

  it("gives the ask its own hue rather than borrowing the working one", () => {
    expect(paneActivityTone("needs-you")).toBe("ask");
    expect(paneActivityTone("working")).toBe("live");
    expect(paneActivityTone("idle")).toBe("muted");
  });

  it("prints an age only where it changes what you would do next", () => {
    expect(paneActivityShowsAge("working")).toBe(true);
    expect(paneActivityShowsAge("needs-you")).toBe(true);
    expect(paneActivityShowsAge("idle")).toBe(false);
  });

  it("says nothing under a minute, then counts in whole units", () => {
    expect(formatPaneActivityAge(0)).toBeNull();
    expect(formatPaneActivityAge(59_000)).toBeNull();
    expect(formatPaneActivityAge(60_000)).toBe("1m");
    expect(formatPaneActivityAge(59 * 60_000)).toBe("59m");
    expect(formatPaneActivityAge(60 * 60_000)).toBe("1h");
    expect(formatPaneActivityAge(25 * 3_600_000)).toBe("1d");
    // A clock that went backwards must not print "-3m".
    expect(formatPaneActivityAge(Number.NaN)).toBeNull();
  });
});

describe("keeping the moment a state was entered", () => {
  const previous = new Map<string, PaneActivityState>([
    ["a", { activity: "working", since: 1_000 }],
    ["b", { activity: "idle", since: 1_000 }],
  ]);

  it("keeps the stamp while the state holds, so an age keeps counting", () => {
    const next = stampPaneActivities(previous, new Map([["a", "working"]]), 9_000);
    expect(next.get("a")).toEqual({ activity: "working", since: 1_000 });
    // The same object, so a memoised row does not re-render for nothing.
    expect(next.get("a")).toBe(previous.get("a"));
  });

  it("re-stamps on a change", () => {
    const next = stampPaneActivities(previous, new Map([["a", "needs-you"]]), 9_000);
    expect(next.get("a")).toEqual({ activity: "needs-you", since: 9_000 });
  });

  it("forgets panes that are gone, and is idempotent when re-run", () => {
    const once = stampPaneActivities(previous, new Map([["a", "working"]]), 9_000);
    const twice = stampPaneActivities(once, new Map([["a", "working"]]), 12_000);
    expect(once.has("b")).toBe(false);
    expect(twice.get("a")).toEqual({ activity: "working", since: 1_000 });
  });
});

describe("what the chrome counts", () => {
  const states = new Map<string, PaneActivityState>([
    ["old-ask", { activity: "needs-you", since: 1_000 }],
    ["new-ask", { activity: "needs-you", since: 5_000 }],
    ["busy", { activity: "working", since: 2_000 }],
    ["quiet", { activity: "idle", since: 2_000 }],
  ]);

  it("answers the longest wait first", () => {
    expect(needsYouPaneIds(states)).toEqual(["old-ask", "new-ask"]);
  });

  it("counts only panes that are actually doing something", () => {
    expect(workingPaneCount(states)).toBe(1);
  });
});
