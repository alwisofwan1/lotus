import { describe, expect, it } from "vitest";
import {
  ALL_RECIPIENTS,
  formatTaskEnvelope,
  resolveCanvasDispatchTarget,
  resolveRecipientIds,
  sendAgentMessage,
  sendAgentMessageTracked,
  insertAgentMessage,
  type AgentMessagingDeps,
} from "../canvas-agent-messaging";
import type { AgentReplyHandle } from "../agent-reply-registry";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const roster: AgentStatusSnapshot[] = [
  { id: "lead", name: "Tech Lead", status: "completed" },
  { id: "fe", name: "Frontend Engineer", status: "completed" },
  { id: "qa", name: "QA Engineer", status: "running" },
];

/** Build a deps whose handles report canReply per the given liveIds set. */
function deps(liveIds: string[] = ["lead", "fe", "qa"]) {
  const sent = new Map<string, string>();
  const handles = new Map<string, AgentReplyHandle>();
  for (const r of roster) {
    handles.set(r.id, {
      canReply: () => liveIds.includes(r.id),
      sendReply: (text) => { sent.set(r.id, text); },
    });
  }
  const d: AgentMessagingDeps = { getHandle: (id) => handles.get(id) };
  return { d, sent };
}

describe("resolveRecipientIds", () => {
  it("expands the sentinel to every roster id", () => {
    expect(resolveRecipientIds(ALL_RECIPIENTS, roster)).toEqual(["lead", "fe", "qa"]);
  });
  it("returns a single id when it exists", () => {
    expect(resolveRecipientIds("fe", roster)).toEqual(["fe"]);
  });
  it("returns nothing for an unknown id", () => {
    expect(resolveRecipientIds("ghost", roster)).toEqual([]);
  });
});

describe("sendAgentMessage", () => {
  it("ignores empty / whitespace-only text", () => {
    const { d, sent } = deps();
    expect(sendAgentMessage("fe", "   ", roster, d)).toEqual({ delivered: [], queued: [], skipped: [] });
    expect(sent.size).toBe(0);
  });

  it("resumes a single replyable agent with the trimmed message", () => {
    const { d, sent } = deps();
    const result = sendAgentMessage("fe", "  ship it  ", roster, d);
    expect(sent.get("fe")).toBe("ship it");
    expect(result).toEqual({ delivered: ["fe"], queued: [], skipped: [] });
  });

  it("fans out to all agents, skipping ones that cannot reply", () => {
    const { d, sent } = deps(["lead", "fe"]); // qa is running → not replyable
    const result = sendAgentMessage(ALL_RECIPIENTS, "standup", roster, d);
    expect(sent.get("lead")).toBe("standup");
    expect(sent.get("fe")).toBe("standup");
    expect(sent.has("qa")).toBe(false);
    expect(result).toEqual({ delivered: ["lead", "fe"], queued: [], skipped: ["qa"] });
  });

  it("skips a targeted agent with no registered handle", () => {
    const d: AgentMessagingDeps = { getHandle: () => undefined };
    const result = sendAgentMessage("lead", "hi", roster, d);
    expect(result).toEqual({ delivered: [], queued: [], skipped: ["lead"] });
  });

  it("queues (not skips) a live agent that is still starting up", () => {
    const sent = new Map<string, string>();
    // Live PTY up but not ready yet: canReply false, accepts true → message is buffered, not dropped.
    const handle: AgentReplyHandle = {
      canReply: () => false,
      accepts: () => true,
      sendReply: (text) => { sent.set("fe", text); },
    };
    const d: AgentMessagingDeps = { getHandle: (id) => (id === "fe" ? handle : undefined) };
    const result = sendAgentMessage("fe", "build it", roster, d);
    expect(sent.get("fe")).toBe("build it"); // sendReply still called → the node buffers it
    expect(result).toEqual({ delivered: [], queued: ["fe"], skipped: [] });
  });

  it("tracks accepted delivery until the ready agent write settles", async () => {
    let finishWrite: () => void = () => {};
    const handle: AgentReplyHandle = {
      canReply: () => true,
      sendReply: () => new Promise<void>((resolve) => { finishWrite = resolve; }),
    };
    const tracked = sendAgentMessageTracked("fe", "build it", roster, {
      getHandle: (id) => (id === "fe" ? handle : undefined),
    });

    expect(tracked.delivered).toEqual(["fe"]);
    expect(tracked.initial).toEqual([{ agentId: "fe", state: "accepted" }]);
    let settled = false;
    void tracked.completion.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishWrite();
    await expect(tracked.completion).resolves.toEqual([
      { agentId: "fe", state: "written" },
    ]);
  });

  it("reports a rejected ready-agent write as failed", async () => {
    const tracked = sendAgentMessageTracked("fe", "build it", roster, {
      getHandle: (id) => id === "fe" ? {
        canReply: () => true,
        sendReply: () => Promise.reject(new Error("PTY closed")),
      } : undefined,
    });

    await expect(tracked.completion).resolves.toEqual([
      {
        agentId: "fe",
        state: "failed",
        error: "Agent session closed before the prompt was written.",
      },
    ]);
  });

  it("keeps starting agents queued instead of claiming their buffered message was written", async () => {
    const tracked = sendAgentMessageTracked("fe", "build it", roster, {
      getHandle: (id) => id === "fe" ? {
        canReply: () => false,
        accepts: () => true,
        sendReply: () => undefined,
      } : undefined,
    });

    expect(tracked.initial).toEqual([{ agentId: "fe", state: "queued" }]);
    await expect(tracked.completion).resolves.toEqual([
      { agentId: "fe", state: "queued" },
    ]);
  });

  it("reports a visible-but-not-yet-registered agent as skipped instead of silently dropping the message", () => {
    const result = sendAgentMessage("node-nova", "hi", [], { getHandle: () => undefined }, [{ id: "node-nova" }]);
    expect(result).toEqual({ delivered: [], queued: [], skipped: ["node-nova"] });
  });
});

describe("insertAgentMessage — type into the agent's prompt without submitting", () => {
  function insertDeps(opts: { hasInsert?: boolean; live?: boolean } = {}) {
    const inserted: string[] = [];
    const handle: AgentReplyHandle = {
      canReply: () => opts.live ?? true,
      accepts: () => opts.live ?? true,
      sendReply: () => {},
      insert: opts.hasInsert === false ? undefined : (text) => inserted.push(text),
    };
    const d: AgentMessagingDeps = { getHandle: (id) => (id === "fe" ? handle : undefined) };
    return { d, inserted };
  }

  it("types the text into a live agent's prompt (no submit) and reports inserted", () => {
    const { d, inserted } = insertDeps({ live: true });
    const result = insertAgentMessage("fe", "  ship it  ", roster, d);
    expect(result).toEqual({ inserted: true });
    expect(inserted).toEqual(["ship it"]);
  });

  it("reports no-session when the agent has no live prompt to type into", () => {
    const { d, inserted } = insertDeps({ live: false });
    expect(insertAgentMessage("fe", "hi", roster, d)).toEqual({ inserted: false, reason: "no-session" });
    expect(inserted).toEqual([]);
  });

  it("does not treat startup queue acceptance as a writable interactive prompt", () => {
    const inserted: string[] = [];
    const handle: AgentReplyHandle = {
      canReply: () => false,
      accepts: () => true,
      sendReply: () => {},
      insert: (text) => inserted.push(text),
    };
    const d: AgentMessagingDeps = { getHandle: () => handle };

    expect(insertAgentMessage("fe", "hi", roster, d)).toEqual({ inserted: false, reason: "no-session" });
    expect(inserted).toEqual([]);
  });

  it("reports no-insert-capability for a headless agent (no insert handle)", () => {
    const { d } = insertDeps({ hasInsert: false });
    expect(insertAgentMessage("fe", "hi", roster, d)).toEqual({ inserted: false, reason: "no-insert-capability" });
  });

  it("reports no-session for an unknown target or empty text", () => {
    const { d } = insertDeps({ live: true });
    expect(insertAgentMessage("ghost", "hi", roster, d)).toEqual({ inserted: false, reason: "no-session" });
    expect(insertAgentMessage("fe", "   ", roster, d)).toEqual({ inserted: false, reason: "no-session" });
  });
});

describe("resolveCanvasDispatchTarget (ADR-0030 agent→agent)", () => {
  const roster: AgentStatusSnapshot[] = [
    { id: "a-sage", name: "Sage", status: "running" },
    { id: "a-rowan", name: "Rowan", status: "idle" },
    { id: "a-rowan2", name: "Rowan", status: "idle" }, // duplicate → ambiguous
  ];

  it("resolves an exact node id (pane_id from list_fleet)", () => {
    expect(resolveCanvasDispatchTarget("a-rowan", roster)).toEqual({ ok: true, id: "a-rowan" });
  });

  it("resolves by agent name, case-insensitively", () => {
    expect(resolveCanvasDispatchTarget("sage", roster)).toEqual({ ok: true, id: "a-sage" });
  });

  it("errors (never guesses) on empty, unknown, or ambiguous targets", () => {
    expect(resolveCanvasDispatchTarget("  ", roster)).toMatchObject({ ok: false });
    expect(resolveCanvasDispatchTarget("ghost", roster)).toMatchObject({ ok: false, error: expect.stringContaining("ghost") });
    expect(resolveCanvasDispatchTarget("Rowan", roster)).toMatchObject({ ok: false, error: expect.stringMatching(/multiple|ambiguous/i) });
  });

  // RC-1: Multi-key matching — Rust dispatches by member.pane_id, but frontend roster keys by React node id.
  // We must also match by hookPaneId (Lotus pane ID) and workspace_id (canvas:projectId).
  describe("RC-1: hookPaneId and workspace_id matching", () => {
    const rosterWithHooks: AgentStatusSnapshot[] = [
      { id: "node-sage", name: "Sage", status: "running", hookPaneId: "p-sage", projectId: "projA" },
      { id: "node-rowan", name: "Rowan", status: "idle", hookPaneId: "p-rowan", projectId: "projA" },
    ];

    it("resolves by hookPaneId (Rust pane_id from dispatch_to_cell)", () => {
      // Rust dispatch_to_cell resolves member.pane_id = "p-sage" and sends it to frontend.
      // Frontend roster has id="node-sage" but hookPaneId="p-sage".
      expect(resolveCanvasDispatchTarget("p-sage", rosterWithHooks)).toEqual({
        ok: true,
        id: "node-sage",
      });
    });

    it("resolves by workspace_id (canvas:projectId format)", () => {
      // Rust fleet member has workspace_id = "canvas:projA".
      // When Atlas reads lotus_list_fleet and tries to dispatch to "canvas:projA", we should resolve to an agent in that workspace.
      const result = resolveCanvasDispatchTarget("canvas:projA", rosterWithHooks);
      // Should resolve to the first agent in that workspace (or ambiguous if multiple).
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.id).toBe("node-sage"); // first match wins
      }
    });

    it("prefers hookPaneId over workspace_id when both could match", () => {
      const rosterMixed: AgentStatusSnapshot[] = [
        { id: "node-a", name: "Agent A", status: "running", hookPaneId: "p-a", projectId: "projX" },
        { id: "node-b", name: "Agent B", status: "idle", hookPaneId: "p-b", projectId: "projY" },
      ];
      // "canvas:projX" could match node-a by workspace, but "p-a" is more specific.
      expect(resolveCanvasDispatchTarget("p-a", rosterMixed)).toEqual({
        ok: true,
        id: "node-a",
      });
    });

    it("still falls back to name resolution when hookPaneId and workspace_id don't match", () => {
      expect(resolveCanvasDispatchTarget("Sage", rosterWithHooks)).toEqual({
        ok: true,
        id: "node-sage",
      });
    });
  });

  describe("Phase 7.2: actionable errors — never a silent dead-end", () => {
    const visible = [
      { id: "node-nova", name: "Nova", projectId: "projA" },
      { id: "node-atlas", name: "Atlas", projectId: "projA" },
    ];

    it("a not-found error lists the visible roster (names) so the caller can retry with a real target", () => {
      const result = resolveCanvasDispatchTarget("Ghost", [], visible);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Ghost");
        expect(result.error).toContain("Nova");
        expect(result.error).toContain("Atlas");
      }
    });

    it("an ambiguous error names the duplicate so the caller can disambiguate by pane_id", () => {
      const dupes: AgentStatusSnapshot[] = [
        { id: "a1", name: "Rowan", status: "idle", hookPaneId: "canvas:p:a1" },
        { id: "a2", name: "Rowan", status: "idle", hookPaneId: "canvas:p:a2" },
      ];
      const result = resolveCanvasDispatchTarget("Rowan", dupes);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/multiple|ambiguous/i);
        // The caller is pointed at the disambiguating pane_ids.
        expect(result.error).toContain("canvas:p:a1");
        expect(result.error).toContain("canvas:p:a2");
      }
    });

    it("still reports the empty case clearly (no roster to list)", () => {
      const result = resolveCanvasDispatchTarget("Ghost", [], []);
      expect(result.ok).toBe(false);
    });
  });

  it("resolves a visible canvas agent even before its runtime registry entry publishes", () => {
    expect(resolveCanvasDispatchTarget("canvas:projA:node-nova", [], [{ id: "node-nova", name: "Nova", projectId: "projA" }])).toEqual({
      ok: true,
      id: "node-nova",
    });
    expect(resolveCanvasDispatchTarget("Nova", [], [{ id: "node-nova", name: "Nova", projectId: "projA" }])).toEqual({
      ok: true,
      id: "node-nova",
    });
  });
});

describe("formatTaskEnvelope", () => {
  it("renders a bare task unchanged (trimmed)", () => {
    expect(formatTaskEnvelope({ task: "  build the hero section  " })).toBe("build the hero section");
  });

  it("appends labelled goal and done-when lines when provided", () => {
    expect(formatTaskEnvelope({ task: "build the hero", goal: "high-converting LP", doneWhen: "renders at /" })).toBe(
      "build the hero\n\nGoal: high-converting LP\nDone when: renders at /",
    );
  });

  it("omits empty optional fields", () => {
    expect(formatTaskEnvelope({ task: "do it", goal: "   ", doneWhen: "" })).toBe("do it");
  });
});
