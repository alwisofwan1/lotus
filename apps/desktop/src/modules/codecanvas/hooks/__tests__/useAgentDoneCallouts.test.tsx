import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// TTS registry double — tests flip the output toggles per scenario.
const tts = vi.hoisted(() => ({
  value: { output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: true } } as unknown,
}));
vi.mock("@/lib/hooks/useTtsProviderRegistry", () => ({
  useTtsProviderRegistry: () => ({ registry: tts.value }),
}));
vi.mock("@/lib/hooks/useSttProviderRegistry", () => ({
  useSttProviderRegistry: () => ({
    registry: { activeProvider: "browser", providers: [{ id: "browser", language: "en-US" }] },
  }),
}));

// Capture the idle watcher's props so a test can drive onIdle deterministically (no real polling).
const idle = vi.hoisted(() => ({
  onIdle: undefined as ((paneId: string, sessionId: string) => void) | undefined,
  cells: [] as Array<{ paneId: string; sessionId: string }>,
}));
vi.mock("@/modules/codespace/hooks/useCellIdleWatcher", () => ({
  useCellIdleWatcher: (props: { cells: typeof idle.cells; onIdle: typeof idle.onIdle }) => {
    idle.onIdle = props.onIdle;
    idle.cells = props.cells;
  },
}));

import { useAgentDoneCallouts } from "../useAgentDoneCallouts";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { createPaneTurnRegistry } from "../../services/pane-turn-registry";
import { CALLOUT_COOLDOWN_MS } from "../../services/voice/callout-throttle";

/** A controllable stop-hook subscriber standing in for the `mcp://agent-stopped` Tauri event. */
function makeSubscriber() {
  let cb: ((paneId: string, sessionId?: string | null) => void) | undefined;
  return {
    subscribe: (fn: (paneId: string, sessionId?: string | null) => void) => {
      cb = fn;
      return () => {
        cb = undefined;
      };
    },
    fire: (paneId: string, sessionId?: string | null) => cb?.(paneId, sessionId),
  };
}

function setup(over?: {
  narrationCoversTurnEnd?: boolean;
  tone?: string;
  wakeOnFinish?: boolean;
  agentDoneCallouts?: boolean;
  agentDoneCooldownMs?: number;
  agentDoneAlert?: "voice" | "sound" | "off";
  canSpeak?: boolean;
  activeProjectId?: string | null;
  resolveProjectLabel?: (projectId: string) => string | null;
  identityRegistry?: import("../../services/agent-identity-registry").AgentIdentityRegistry;
  isVisible?: (nodeId: string) => boolean;
  onFinish?: (info: import("../useAgentDoneCallouts").AgentFinishInfo) => void;
}) {
  tts.value = {
    output: {
      speakReplies: true,
      agentDoneCallouts: over?.agentDoneCallouts ?? true,
      wakeOnFinish: over?.wakeOnFinish ?? true,
      ...(over?.tone !== undefined ? { tone: over.tone } : {}),
      // These tests cover the spoken callout; with no choice saved the default is now Sound.
      agentDoneAlert: over?.agentDoneAlert ?? (over?.agentDoneCallouts === false ? "off" : "voice"),
      ...(over?.agentDoneCooldownMs !== undefined
        ? { agentDoneCooldownMs: over.agentDoneCooldownMs }
        : {}),
    },
  };
  const announce = vi.fn();
  const chime = vi.fn();
  const isVisible = vi.fn(over?.isVisible ?? (() => true));
  const hook = makeSubscriber();
  // Injected clock so cooldown tests are deterministic (no real timers). The turn registry keeps its
  // own Date.now clock; its 20-min TTL is never approached here, so that's harmless.
  const clock = { t: 1_000_000 };
  const turns = createPaneTurnRegistry();
  const { unmount } = renderHook(() =>
    useAgentDoneCallouts({
      announce,
      chime,
      canSpeak: () => over?.canSpeak ?? true,
      isVisible,
      activeProjectId: over?.activeProjectId,
      resolveProjectLabel: over?.resolveProjectLabel,
      identityRegistry: over?.identityRegistry,
      getMetrics: async () => null,
      subscribeAgentStopped: hook.subscribe,
      narrationCoversTurnEnd: over?.narrationCoversTurnEnd,
      turnRegistry: turns,
      now: () => clock.t,
      onFinish: over?.onFinish,
    }),
  );
  return { announce, chime, isVisible, hook, turns, clock, unmount };
}

// Every roster id any test publishes — the registry is process-wide, so a leaked snapshot would
// bleed into later tests' `idle.cells` assertions.
const PUBLISHED_IDS = ["a1", "a2", "a3", "agent-1"];
beforeEach(() => {
  for (const id of PUBLISHED_IDS) agentStatusRegistry.remove(id);
});
afterEach(() => {
  for (const id of PUBLISHED_IDS) agentStatusRegistry.remove(id);
});

describe("useAgentDoneCallouts — alert mode (#184)", () => {
  it("plays the chime instead of speaking when the alert is Sound", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, chime, hook } = setup({ agentDoneAlert: "sound" });
    hook.fire("a1", "s1");
    expect(chime).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it("falls back to the chime when Voice has nothing to speak with", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, chime, hook } = setup({ agentDoneAlert: "voice", canSpeak: false });
    hook.fire("a1", "s1");
    expect(chime).toHaveBeenCalledTimes(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it("stays silent when the alert is Off, even with an on-screen wake", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, chime, hook } = setup({ agentDoneAlert: "off", wakeOnFinish: true });
    hook.fire("a1", "s1");
    expect(chime).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps the per-agent quiet time for the chime too", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { chime, hook, clock } = setup({ agentDoneAlert: "sound" });
    hook.fire("a1");
    clock.t += 5_000;
    hook.fire("a1");
    expect(chime).toHaveBeenCalledTimes(1);
    clock.t += CALLOUT_COOLDOWN_MS;
    hook.fire("a1");
    expect(chime).toHaveBeenCalledTimes(2);
  });
});

describe("useAgentDoneCallouts — stop-hook primary signal", () => {
  it("speaks the selected tone's register — the Speak style picker reaches the callout channel", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ tone: "brisk", wakeOnFinish: true });
    hook.fire("a1", "s1");

    expect(announce).toHaveBeenCalledWith("Rowan: done.", { language: "en-US", priority: "callout", name: "Rowan" });
  });

  it("leaves the default tone's callout unchanged", () => {
    // The picker defaults to jarvis. Wiring personas in must not alter a single word for anyone
    // who never opened the setting.
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true });
    hook.fire("a1", "s1");

    expect(announce).toHaveBeenCalledWith("Rowan is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("announces on the mcp://agent-stopped hook signal (authoritative, per-turn)", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true });

    hook.fire("a1");
    expect(announce).toHaveBeenCalledWith("Rowan is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("collapses a burst of finishes for the same agent into one callout (ultra-minimal cooldown)", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true });

    hook.fire("a1"); // first finish → announces
    hook.fire("a1"); // auto-continuation within the window, no new user submit → silent
    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces again once the cooldown window has elapsed", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook, clock } = setup({ wakeOnFinish: true });

    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(1);

    clock.t += CALLOUT_COOLDOWN_MS; // window passes
    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("honors the user's configured cooldown window (Voice-tab setting)", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook, clock } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 10_000 });

    hook.fire("a1");
    clock.t += 5_000; // still inside the custom 10s window
    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(1);

    clock.t += 5_000; // now the 10s window has elapsed
    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("a zero cooldown disables the cap — every finish announces", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 0 });

    hook.fire("a1");
    hook.fire("a1");
    hook.fire("a1");
    expect(announce).toHaveBeenCalledTimes(3);
  });

  it("a fresh user-submitted turn bypasses the cooldown so new work is acknowledged", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook, turns } = setup({ wakeOnFinish: true });

    hook.fire("a1"); // finish 1 → announces (and closes the turn)
    expect(announce).toHaveBeenCalledTimes(1);

    turns.noteInput("a1", "another task\r"); // user kicks off new work within the window
    hook.fire("a1"); // finish 2 → open turn bypasses the cooldown → announces
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("obeys the visible policy — a visible finish stays silent when wakeOnFinish is off", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: false, agentDoneCallouts: true });

    hook.fire("a1"); // isVisible → true, so gated by wakeOnFinish (off)
    expect(announce).not.toHaveBeenCalled();
  });

  it("ignores a hook signal for a pane that is not a known agent", () => {
    const { announce, hook } = setup();
    hook.fire("not-an-agent");
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("useAgentDoneCallouts — idle fallback (turn-gated)", () => {
  it("announces an idle settle for a runner with no stop hook once a turn was submitted", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, turns } = setup({ wakeOnFinish: true });

    turns.noteInput("a2", "do the thing\r");
    idle.onIdle?.("a2", "s2");
    expect(announce).toHaveBeenCalledWith("Sage is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("stays SILENT on an idle settle with no open turn (resize/reattach repaint)", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce } = setup({ wakeOnFinish: true });

    // A window resize repainted the TUI (>200 bytes) then went quiet — no submit ever happened.
    idle.onIdle?.("a2", "s2");
    expect(announce).not.toHaveBeenCalled();
  });

  it("announces once per submitted turn — the announce closes the turn window", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, turns } = setup({ wakeOnFinish: true });

    turns.noteInput("a2", "\r");
    idle.onIdle?.("a2", "s2");
    idle.onIdle?.("a2", "s2"); // later repaint settle, same turn — must stay silent
    expect(announce).toHaveBeenCalledTimes(1);

    turns.noteInput("a2", "\r"); // a NEW submit re-opens the window
    idle.onIdle?.("a2", "s2");
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it("does NOT double-announce a hook-covered pane via the idle fallback", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook, turns } = setup({ wakeOnFinish: true });

    turns.noteInput("a1", "\r");
    hook.fire("a1"); // marks a1 hook-covered + announces once
    idle.onIdle?.("a1", "s1"); // must be suppressed
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("byte-watches a hook-capable runner as a BACKSTOP, and stops once its hook proves alive", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1", hookCapable: true });
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, hook } = setup({ wakeOnFinish: true });

    // Before any hook event BOTH panes are watched: a hook-capable runner whose hook is dead
    // (e.g. the codex `notify` line wiped from ~/.codex/config.toml) must not stay silent forever.
    // The per-turn claim + hook-covered exclusion keep the two signals from ever doubling.
    expect(idle.cells.map((c) => c.paneId)).toEqual(["a1", "a2"]);

    act(() => hook.fire("a1")); // the hook proves alive → a1 leaves the byte-watch set
    expect(idle.cells.map((c) => c.paneId)).toEqual(["a2"]);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("announces a hook-capable runner via the idle fallback when its hook never fires (dead hook)", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Piko", status: "running", sessionId: "s1", hookCapable: true });
    const { announce, turns } = setup({ wakeOnFinish: true });

    turns.noteInput("a1", "fix the bug\r"); // a real submit opened the turn…
    idle.onIdle?.("a1", "s1"); // …and only the byte settle reports it (notify hook uninstalled)
    expect(announce).toHaveBeenCalledTimes(1);
  });
});

// The duplicate-callout bug: a mislabeled runner (e.g. custom-Claude, hookCapable=false) is idle-watched
// AND fires the global stop hook, so BOTH signals land for one turn. The frequency throttle could be
// bypassed (cooldown=0 or freshTurn), letting the second emit through with a rotated phrasing. The
// per-turn claim (claimAnnouncement) must guarantee exactly one callout regardless of order/throttle.
describe("useAgentDoneCallouts — duplicate regression (dual trigger, one turn)", () => {
  it("idle THEN hook for the same turn announces once — even with the cooldown disabled", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, hook, turns } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 0 });

    turns.noteInput("a2", "do the thing\r");
    idle.onIdle?.("a2", "s2"); // fallback wins the turn → announces
    hook.fire("a2"); // stop hook for the SAME turn → per-turn claim denies it
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("hook THEN idle for the same turn announces once — even with the cooldown disabled", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, hook, turns } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 0 });

    turns.noteInput("a2", "do the thing\r");
    hook.fire("a2"); // hook wins the turn → announces (and marks the pane hook-covered)
    idle.onIdle?.("a2", "s2"); // same turn → suppressed by hook-covered AND the claim
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("never rotates to a second phrasing for one turn (the duplicate's tell)", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const { announce, hook, turns } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 0 });

    turns.noteInput("a2", "\r");
    idle.onIdle?.("a2", "s2");
    hook.fire("a2");
    // Both calls (if the bug regressed) would use DIFFERENT pool phrasings; here there is only one.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0][0]).toBe("Sage is done.");
  });
});

// Multi-project: an agent in a project you SWITCHED AWAY from keeps running (its PTY survives), but its
// node unmounted so it is gone from the live roster. The durable identity registry keeps the finish
// announceable, and — because it happened in another project — the callout names that project's repo.
describe("useAgentDoneCallouts — cross-project finish (repo attribution)", () => {
  const makeIdentity = () => {
    const map = new Map<string, { name: string; nodeId?: string; projectId?: string }>();
    return {
      record: (id: string, i: { name: string; nodeId?: string; projectId?: string }) => map.set(id, i),
      get: (id: string) => map.get(id),
      forget: (id: string) => void map.delete(id),
    };
  };

  it("announces an unmounted cross-project agent via the identity registry, naming its repo", () => {
    // Nothing is in the LIVE roster for a3 (its node unmounted on the project switch)…
    const identityRegistry = makeIdentity();
    identityRegistry.record("a3", { name: "Atlas", projectId: "projA" });
    const { announce, hook } = setup({
      agentDoneCallouts: true, // background finish (off-viewport) is gated by this toggle
      wakeOnFinish: false,
      activeProjectId: "projB", // …and I'm looking at project B
      resolveProjectLabel: (id) => (id === "projA" ? "orbit-vault" : null),
      identityRegistry,
      isVisible: () => false, // a switched-away project's node is never on-viewport
    });

    hook.fire("a3");
    expect(announce).toHaveBeenCalledWith("Atlas is done in orbit-vault.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("keeps the bare phrasing when the finish is in the project on screen", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1", projectId: "projB" });
    const { announce, hook } = setup({
      wakeOnFinish: true,
      activeProjectId: "projB",
      resolveProjectLabel: () => "lotus",
    });

    hook.fire("a1");
    expect(announce).toHaveBeenCalledWith("Rowan is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("names the repo when the current surface has no active project context", () => {
    const identityRegistry = makeIdentity();
    identityRegistry.record("a3", { name: "Atlas", projectId: "projA" });
    const { announce, hook } = setup({
      agentDoneCallouts: true,
      wakeOnFinish: false,
      activeProjectId: null,
      resolveProjectLabel: (id) => (id === "projA" ? "orbit-vault" : null),
      identityRegistry,
      isVisible: () => false,
    });

    hook.fire("a3");
    expect(announce).toHaveBeenCalledWith("Atlas is done in orbit-vault.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("does not confuse same node ids across projects when a hidden agent stop hook arrives", () => {
    agentStatusRegistry.publish({
      id: "agent-1",
      hookPaneId: "canvas:projB:agent-1",
      name: "Nara",
      status: "running",
      sessionId: "sB",
      projectId: "projB",
    });
    const identityRegistry = makeIdentity();
    identityRegistry.record("canvas:projA:agent-1", { nodeId: "agent-1", name: "Nara", projectId: "projA" });
    const { announce, hook, isVisible } = setup({
      agentDoneCallouts: true,
      wakeOnFinish: false,
      activeProjectId: "projB",
      resolveProjectLabel: (id) => (id === "projA" ? "orbit-vault" : null),
      identityRegistry,
      isVisible: () => true,
    });

    hook.fire("canvas:projA:agent-1");
    expect(isVisible).not.toHaveBeenCalled(); // fallback identity means switched-away/background
    expect(announce).toHaveBeenCalledWith("Nara is done in orbit-vault.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("can recover an older unscoped stop hook by matching its PTY session id", () => {
    agentStatusRegistry.publish({
      id: "agent-1",
      hookPaneId: "canvas:projB:agent-1",
      name: "Nara",
      status: "running",
      sessionId: "sB",
      projectId: "projB",
    });
    const identityRegistry = makeIdentity();
    identityRegistry.record("session:sA", { nodeId: "agent-1", name: "Nara", projectId: "projA" });
    const { announce, hook, isVisible } = setup({
      agentDoneCallouts: true,
      wakeOnFinish: false,
      activeProjectId: "projB",
      resolveProjectLabel: (id) => (id === "projA" ? "orbit-vault" : null),
      identityRegistry,
      isVisible: () => true,
    });

    hook.fire("agent-1", "sA");
    expect(isVisible).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("Nara is done in orbit-vault.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });
});

describe("useAgentDoneCallouts — headless agents (no PTY session)", () => {
  it("announces a headless agent on the running→completed transition", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Planner", status: "running" });
    const { announce } = setup({ wakeOnFinish: true });

    act(() => agentStatusRegistry.publish({ id: "a1", name: "Planner", status: "completed" }));
    expect(announce).toHaveBeenCalledWith("Planner is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("does not announce an agent that is already completed on first sight", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Planner", status: "completed" });
    const { announce } = setup({ wakeOnFinish: true });
    expect(announce).not.toHaveBeenCalled();
  });

  it("leaves live agents (with a sessionId) to the hook/idle paths, not the completed transition", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce } = setup({ wakeOnFinish: true });

    // A live agent's eventual "completed" is a process exit, not a turn — must NOT announce here.
    act(() => agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "completed", sessionId: "s1" }));
    expect(announce).not.toHaveBeenCalled();
  });
});

// The toast channel taps the SAME per-turn completion pipeline as voice, but is independent of the
// voice toggles: a finish must surface a toast even with callouts fully muted.
describe("useAgentDoneCallouts — onFinish side-effect (toast source)", () => {
  it("reports a finish with the agent's name, node id, and project on a stop hook", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1", projectId: "projB" });
    const onFinish = vi.fn();
    const { hook } = setup({ wakeOnFinish: true, onFinish });

    hook.fire("a1");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0][0]).toMatchObject({ agentId: "a1", agentName: "Rowan", agentProjectId: "projB" });
  });

  it("fires even when BOTH voice toggles are off (toast is independent of voice)", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const onFinish = vi.fn();
    const { announce, hook } = setup({ wakeOnFinish: false, agentDoneCallouts: false, onFinish });

    hook.fire("a1");
    expect(announce).not.toHaveBeenCalled(); // voice muted…
    expect(onFinish).toHaveBeenCalledTimes(1); // …toast still fires
  });

  it("reports once when both signals land for one turn (shares the per-turn claim with voice)", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const onFinish = vi.fn();
    const { hook, turns } = setup({ wakeOnFinish: true, agentDoneCooldownMs: 0, onFinish });

    turns.noteInput("a2", "do the thing\r");
    idle.onIdle?.("a2", "s2"); // fallback claims the turn → one finish
    hook.fire("a2"); // stop hook for the SAME turn → the per-turn claim denies it
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a pane that is not a known agent", () => {
    const onFinish = vi.fn();
    const { hook } = setup({ wakeOnFinish: true, onFinish });
    hook.fire("not-an-agent");
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("keeps the byte-idle fallback alive for the toast channel when voice is off", () => {
    // A cursor/custom runner has NO stop hook — the byte settle is its only finish signal. The toast
    // channel must therefore keep the idle watcher running even with both voice toggles muted,
    // otherwise those runners never toast (the pre-fix behavior: Claude-only notifications).
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    const onFinish = vi.fn();
    const { announce, turns } = setup({ wakeOnFinish: false, agentDoneCallouts: false, onFinish });

    expect(idle.cells.map((c) => c.paneId)).toEqual(["a2"]);
    turns.noteInput("a2", "go\r");
    idle.onIdle?.("a2", "s2");
    expect(onFinish).toHaveBeenCalledTimes(1); // toast fires…
    expect(announce).not.toHaveBeenCalled(); // …voice stays muted
  });

  it("does not poll at all when voice is off AND no toast consumer is wired", () => {
    agentStatusRegistry.publish({ id: "a2", name: "Sage", status: "running", sessionId: "s2" });
    setup({ wakeOnFinish: false, agentDoneCallouts: false });
    expect(idle.cells).toEqual([]);
  });

  it("carries the agent's project via a scoped hookPaneId for an unmounted cross-project finish", () => {
    const map = new Map<string, { name: string; nodeId?: string; projectId?: string }>();
    map.set("canvas:projA:agent-9", { nodeId: "agent-9", name: "Atlas", projectId: "projA" });
    const identityRegistry = {
      record: (id: string, i: { name: string; nodeId?: string; projectId?: string }) => map.set(id, i),
      get: (id: string) => map.get(id),
      forget: (id: string) => void map.delete(id),
    };
    const onFinish = vi.fn();
    const { hook } = setup({
      agentDoneCallouts: true,
      wakeOnFinish: false,
      activeProjectId: "projB",
      identityRegistry,
      isVisible: () => false,
      onFinish,
    });

    hook.fire("canvas:projA:agent-9");
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish.mock.calls[0][0]).toMatchObject({ agentName: "Atlas", agentProjectId: "projA" });
  });
});

describe("useAgentDoneCallouts — deferring to live narration", () => {
  it("stays silent when narration already covers the turn end", () => {
    // Both channels listen to the SAME stop hook, and both speak through announce (latest-wins),
    // so with narration on every turn end produced two utterances that aborted each other.
    // Narration's version is the richer one — a persona summary of what happened, not "X is done."
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true, narrationCoversTurnEnd: true });
    hook.fire("a1", "s1");

    expect(announce).not.toHaveBeenCalled();
  });

  it("still speaks when narration is off", () => {
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const { announce, hook } = setup({ wakeOnFinish: true });
    hook.fire("a1", "s1");

    expect(announce).toHaveBeenCalledWith("Rowan is done.", expect.objectContaining({ language: "en-US", priority: "callout" }));
  });

  it("still reports the finish to non-voice consumers", () => {
    // The completion toast and any other onFinish consumer must survive: only the SPOKEN line is
    // redundant, not the event.
    agentStatusRegistry.publish({ id: "a1", name: "Rowan", status: "running", sessionId: "s1" });
    const onFinish = vi.fn();
    const { hook } = setup({ wakeOnFinish: true, narrationCoversTurnEnd: true, onFinish });
    hook.fire("a1", "s1");

    expect(onFinish).toHaveBeenCalled();
  });
});
