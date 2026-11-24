import { describe, it, expect } from "vitest";
import { agentFleetMembers, projectCanvasAgentFleetMembers } from "../canvas-fleet";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const snap = (id: string, name: string, status: AgentStatusSnapshot["status"], sessionId?: string): AgentStatusSnapshot => ({ id, name, status, ...(sessionId ? { sessionId } : {}) });

describe("agentFleetMembers", () => {
  it("maps canvas agents into fleet members under a canvas: workspace namespace", () => {
    const members = agentFleetMembers([snap("n1", "Tech Lead", "running")], { projectId: "p1", cwd: "/repo" });
    expect(members[0]).toMatchObject({
      pane_id: "n1",
      workspace_id: "canvas:p1",
      cwd: "/repo",
      provider: "claude",
      display_name: "Tech Lead",
      status: "live",
      is_alive: true,
    });
  });

  it("stamps the project's human name on every cell, so a remote client need not guess it", () => {
    // Without this, Lotus Pocket had only `canvas:cp_…` and a cwd, and fell back to the
    // cwd basename of whichever cell sorted first — so the project appeared to rename
    // itself whenever the fleet reordered (ADR-14, plans/lotus-pocket).
    const members = agentFleetMembers([snap("n1", "Atlas", "running")], {
      projectId: "p1",
      cwd: "/repo",
      projectName: "codespace-demo",
    });
    expect(members[0].workspace_label).toBe("codespace-demo");
  });

  it("omits the label rather than sending a blank one when there is no project name", () => {
    // Absent means "this host cannot name it", which a client can fall back from.
    // An empty string is a name, and a blank one.
    for (const projectName of [undefined, null, "   "]) {
      const members = agentFleetMembers([snap("n1", "Atlas", "running")], {
        projectId: "p1",
        cwd: "/repo",
        projectName,
      });
      expect(members[0]).not.toHaveProperty("workspace_label");
    }
  });

  it("maps status to fleet vocabulary; idle/connecting/running are alive (addressable), terminal states are not", () => {
    const members = agentFleetMembers(
      [snap("a", "A", "completed"), snap("b", "B", "connecting"), snap("c", "C", "error"), snap("d", "D", "idle")],
      { projectId: null, cwd: "/x" },
    );
    const byId = Object.fromEntries(members.map((m) => [m.pane_id, m]));
    expect(byId.a).toMatchObject({ status: "exited", is_alive: false });
    expect(byId.b).toMatchObject({ status: "starting", is_alive: true });
    expect(byId.c).toMatchObject({ status: "exited", is_alive: false });
    // idle is the normal ready state — a settled peer must stay addressable (ADR-0030).
    expect(byId.d).toMatchObject({ status: "idle", is_alive: true });
    expect(byId.d.workspace_id).toBe("canvas:default");
  });

  it("keeps a stalled agent addressable — its PTY is alive, only quiet (not a terminal state)", () => {
    // Regression: a healthy agent idling at its prompt gets flagged "stalled" after 30s of silence;
    // marking it is_alive=false made it vanish from peers' list_fleet (which filters is_alive=true),
    // so teammates concluded it "doesn't exist". stalled == alive-but-quiet → must stay addressable.
    const members = agentFleetMembers([snap("n1", "Nova", "stalled", "pty-nova")], { projectId: "p1", cwd: "/repo" });
    expect(members[0]).toMatchObject({ status: "stalled", is_alive: true });
  });

  it("carries a live persona's PTY session id so the MCP fleet can read/dispatch to it (Fase 2)", () => {
    const members = agentFleetMembers([snap("n1", "Skye", "running", "pty-abc")], { projectId: "p1", cwd: "/repo" });
    expect(members[0].session_id).toBe("pty-abc");
    // Agents without a session (e.g. headless) report null, not a dangling id.
    expect(agentFleetMembers([snap("n2", "Rex", "idle")], { projectId: "p1", cwd: "/repo" })[0].session_id).toBeNull();
  });

  it("uses project-scoped hook pane ids when available so canvas projects do not collide", () => {
    const members = agentFleetMembers(
      [{ ...snap("agent-1", "Nara", "running", "pty-abc"), hookPaneId: "canvas:projA:agent-1" }],
      { projectId: "projA", cwd: "/repo" },
    );
    expect(members[0].pane_id).toBe("canvas:projA:agent-1");
  });
});

describe("agentFleetMembers — an agent belongs to its own project, not to the board on screen", () => {
  // Measured on a live desktop, 2026-08-10: a Nova belonging to `terax-ai` reached Lotus
  // Pocket carrying terax-ai's pane id next to codespace-demo's workspace id, label and
  // cwd, and the phone listed it under codespace-demo. A dispatch to that row would have
  // landed in the other repo. The board stamped its own identity on an agent that was
  // still in the registry from the project it had just switched away from.
  const foreign: AgentStatusSnapshot = {
    ...snap("n-nova", "Nova", "running", "pty-nova"),
    hookPaneId: "canvas:cp_terax:n-nova",
    projectId: "cp_terax",
  };

  it("places a foreign agent in its own workspace, not the board's", () => {
    const [m] = agentFleetMembers([foreign], {
      projectId: "cp_demo",
      cwd: "/repos/codespace-demo",
      projectName: "codespace-demo",
    });

    expect(m.workspace_id).toBe("canvas:cp_terax");
  });

  it("names a foreign agent's project from the catalog when the window knows it", () => {
    const [m] = agentFleetMembers([foreign], {
      projectId: "cp_demo",
      cwd: "/repos/codespace-demo",
      projectName: "codespace-demo",
      projects: { cp_terax: { cwd: "/repos/terax-ai", name: "terax-ai" } },
    });

    expect(m).toMatchObject({
      workspace_id: "canvas:cp_terax",
      workspace_label: "terax-ai",
      cwd: "/repos/terax-ai",
    });
  });

  it("says nothing about a project it cannot name rather than borrowing the board's", () => {
    // Absent is a state every consumer already handles (the fleet route omits an empty
    // cwd, a client falls back from a missing label). Wrong is one none of them detect.
    const [m] = agentFleetMembers([foreign], {
      projectId: "cp_demo",
      cwd: "/repos/codespace-demo",
      projectName: "codespace-demo",
    });

    expect(m).not.toHaveProperty("workspace_label");
    expect(m.cwd).toBe("");
  });

  it("still takes the board's own identity for the board's own agents", () => {
    // The catalog is a fallback for foreign agents, never a replacement: the board's cwd
    // and name arrive with the project and are current by construction, while the index
    // behind the catalog is refreshed less often.
    const [m] = agentFleetMembers([{ ...snap("n1", "Atlas", "running"), projectId: "cp_demo" }], {
      projectId: "cp_demo",
      cwd: "/repos/codespace-demo",
      projectName: "codespace-demo",
      projects: { cp_demo: { cwd: "/stale/path", name: "stale-name" } },
    });

    expect(m).toMatchObject({ cwd: "/repos/codespace-demo", workspace_label: "codespace-demo" });
  });

  it("falls back to the board for an agent that never said which project it is in", () => {
    // Older snapshots carry no projectId at all; they came from the board that pushed
    // them, so the board is the right answer — this is the pre-existing behaviour.
    const [m] = agentFleetMembers([snap("n1", "Atlas", "running")], {
      projectId: "cp_demo",
      cwd: "/repos/codespace-demo",
      projectName: "codespace-demo",
    });

    expect(m).toMatchObject({ workspace_id: "canvas:cp_demo", cwd: "/repos/codespace-demo" });
  });
});

describe("agentFleetMembers — the runner is named the way the desktop names it", () => {
  it("carries the node's own runner label alongside the routing provider", () => {
    // `provider` reports `claude` for a custom Claude-family runner by design, so a phone
    // reading it alone printed `claude` beside a desktop header printing `acme`.
    const [m] = agentFleetMembers(
      [{ ...snap("n1", "Atlas", "running"), runner: "custom", claudeFamily: true, runnerLabel: "acme" }],
      { projectId: "p1", cwd: "/x" },
    );

    expect(m).toMatchObject({ provider: "claude", runner_label: "acme" });
  });

  it("omits the label rather than sending a blank one", () => {
    for (const runnerLabel of [undefined, "   "]) {
      const [m] = agentFleetMembers([{ ...snap("n1", "Atlas", "running"), runnerLabel }], {
        projectId: "p1",
        cwd: "/x",
      });
      expect(m).not.toHaveProperty("runner_label");
    }
  });

  it("names a built-in runner from a visible node before its snapshot has published", () => {
    const [m] = projectCanvasAgentFleetMembers([{ id: "n1", name: "Atlas", runner: "codex" }], [], {
      projectId: "p1",
      cwd: "/x",
    });

    expect(m.runner_label).toBe("Codex");
  });

  it("stays silent about a custom runner until the node names it", () => {
    // A custom runner's label is its registry entry's name, known only to the node once
    // that entry loads. `CLI` here would be a placeholder the desktop never shows.
    const [m] = projectCanvasAgentFleetMembers(
      [{ id: "n1", name: "Atlas", runner: "custom", runnerCommand: "ccs acme" }],
      [],
      { projectId: "p1", cwd: "/x" },
    );

    expect(m).not.toHaveProperty("runner_label");
  });
});

describe("projectCanvasAgentFleetMembers", () => {
  it("keeps visible live-agent nodes in the MCP fleet even before their runtime registry entry publishes", () => {
    const members = projectCanvasAgentFleetMembers(
      [{ id: "agent-nova", name: "Nova", runner: "codex" }],
      [],
      { projectId: "projA", cwd: "/repo" },
    );

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      pane_id: "canvas:projA:agent-nova",
      workspace_id: "canvas:projA",
      display_name: "Nova",
      status: "starting",
      is_alive: true,
      session_id: null,
    });
  });

  it("reports the visible agent runner as the MCP provider instead of hardcoding Claude", () => {
    const members = projectCanvasAgentFleetMembers(
      [{ id: "agent-nova", name: "Nova", runner: "codex" }],
      [],
      { projectId: "projA", cwd: "/repo" },
    );

    expect(members[0].provider).toBe("codex");
  });

  it("preserves a custom runner's provider label instead of collapsing it to claude (Phase 4)", () => {
    const members = projectCanvasAgentFleetMembers(
      [{ id: "a-widget", name: "Widget", runner: "custom", runnerCommand: "acme" }],
      [],
      { projectId: "projA", cwd: "/repo" },
    );
    expect(members[0].provider).toBe("custom");
  });

  it("reports a custom-but-Claude-family runner as claude (it drives the claude path)", () => {
    const members = agentFleetMembers(
      [{ ...snap("a", "A", "running"), runner: "custom", claudeFamily: true }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(members[0].provider).toBe("claude");
  });
});

describe("agentFleetMembers — provider + capability truth (Phase 4)", () => {
  it("emits can_reply / can_queue derived from status when not set explicitly", () => {
    const [running, connecting, exited] = agentFleetMembers(
      [
        { ...snap("r", "R", "running"), claudeFamily: true },
        { ...snap("c", "C", "connecting"), claudeFamily: false },
        snap("e", "E", "completed"),
      ],
      { projectId: "p1", cwd: "/x" },
    );
    // running (alive + ready): reachable now and queueable, claude-family → has MCP tools.
    expect(running).toMatchObject({ can_reply: true, can_queue: true, mcp_tools_available: true });
    // connecting (alive, not yet ready): queueable but not reachable yet.
    expect(connecting).toMatchObject({ can_reply: false, can_queue: true });
    // completed (terminal): neither.
    expect(exited).toMatchObject({ can_reply: false, can_queue: false });
  });

  it("says nothing about MCP tools when the runner is unknown, instead of guessing no", () => {
    // The contract already reads an absent key as "this host cannot say" (mcp_tools_available is an
    // Option<bool> on the Rust side, emitted only when known) — the same way `gating` is left off
    // for an unreported runner. A confident `false` here made peers skip a reachable agent.
    const [noRunner, customCli] = agentFleetMembers(
      [
        { ...snap("c", "C", "connecting"), claudeFamily: false },
        { ...snap("w", "Wesley", "running"), runner: "custom", runnerCommand: "my-cli --serve" },
      ],
      { projectId: "p1", cwd: "/x" },
    );
    expect(noRunner.mcp_tools_available).toBeUndefined();
    expect(customCli.mcp_tools_available).toBeUndefined();
  });

  /**
   * Chat's transcript is built from per-step hook events. Codex has emitted them since
   * `codex_hooks.rs` registered `~/.codex/hooks.json` (2026-08-13); this answer lagged
   * behind and told the phone `never` for a cell that was recording (2026-08-27).
   */
  it("says a codex cell reports transcript steps — its hooks.json has been registered since 2026-08-13", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("k", "Kai", "running"), runner: "codex" }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.reports_steps).toBe(true);
  });

  it("says a native ccs/csp cell reports steps without needing the claudeFamily flag", () => {
    // `ccs` is `claude --profile …`; the hooks in `~/.claude/settings.json` fire for it just
    // as for `claude`. It used to need the snapshot to say `claudeFamily: true` separately.
    const [ccs] = agentFleetMembers(
      [{ ...snap("w", "Wesley", "running"), runner: "ccs" }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(ccs.reports_steps).toBe(true);
  });

  it("says a cursor cell reports steps — it runs the Claude-format hooks in ~/.claude/settings.json", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("c", "Cur", "running"), runner: "cursor" }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.reports_steps).toBe(true);
  });

  it("says a non-Claude custom runner does not report steps — Lotus installs no hook for it", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("g", "Grok", "running"), runner: "custom", claudeFamily: false }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.reports_steps).toBe(false);
  });

  it("says a custom runner driving the claude path does report steps", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("w", "Wesley", "running"), runner: "custom", claudeFamily: true }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.reports_steps).toBe(true);
  });

  it("says nothing about steps when the runner is unknown, instead of guessing yes", () => {
    // Absent is "cannot say", the same reading `mcp_tools_available` and `gating` get. The
    // old code answered this case as `claude`, which the reader took as a promise.
    const [noRunner] = agentFleetMembers(
      [{ ...snap("c", "C", "connecting"), claudeFamily: false }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(noRunner.reports_steps).toBeUndefined();
  });

  it("reports MCP tools for a custom runner that drives the claude path", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("w", "Wesley", "running"), runner: "custom", claudeFamily: true }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.mcp_tools_available).toBe(true);
  });

  it("reports MCP tools for codex — Lotus installs the Lotus MCP server into ~/.codex/config.toml too", () => {
    // Observed wrong in the field: a Codex agent was published as mcp_tools_available:false and then
    // successfully called lotus_list_fleet and lotus_dispatch_to_cell in the same turn. The old
    // fallback read "is Claude family" as "has MCP tools"; Lotus registers the server for codex and
    // cursor at startup as well (see install_codex_mcp_config_entry / cursor_mcp_config_path).
    const [m] = agentFleetMembers(
      [{ ...snap("a", "Atlas", "running"), runner: "codex" }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.mcp_tools_available).toBe(true);
  });

  it("lets an explicit snapshot canReply/canQueue override the status-derived defaults", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("r", "R", "running"), canReply: false, canQueue: false }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m).toMatchObject({ can_reply: false, can_queue: false });
  });

  it("prefers an explicit snapshot.provider over the runner-derived one", () => {
    const [m] = agentFleetMembers(
      [{ ...snap("r", "R", "running"), runner: "codex", provider: "custom" }],
      { projectId: "p1", cwd: "/x" },
    );
    expect(m.provider).toBe("custom");
  });

  it("preserves already-published runtime snapshots when callers have not supplied canvas nodes yet", () => {
    const members = projectCanvasAgentFleetMembers(
      [],
      [{ ...snap("node-atlas", "Atlas", "running", "pty-atlas"), hookPaneId: "canvas:projA:node-atlas", runner: "claude" }],
      { projectId: "projA", cwd: "/repo" },
    );

    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ pane_id: "canvas:projA:node-atlas", display_name: "Atlas", session_id: "pty-atlas" });
  });

  it("forwards a runtime snapshot's explicit provider + capability flags through projection (Phase 4)", () => {
    const members = projectCanvasAgentFleetMembers(
      [{ id: "node-nova", name: "Nova", runner: "codex" }],
      [{
        ...snap("node-nova", "Nova", "running", "pty-nova"),
        runner: "codex",
        provider: "codex",
        canReply: true,
        canQueue: true,
        mcpToolsAvailable: false,
      }],
      { projectId: "projA", cwd: "/repo" },
    );
    expect(members[0]).toMatchObject({
      provider: "codex",
      can_reply: true,
      can_queue: true,
      mcp_tools_available: false,
    });
  });
});

describe("a needs-you agent in the fleet", () => {
  // Adding `needs-you` to AgentNodeStatus is what makes these three assertions necessary: every
  // predicate below is a status ALLOWLIST, so a new member defaults to "no" and an agent blocked
  // on a permission prompt would silently drop out of the fleet — invisible to Pocket and
  // unreachable by peer agents, at the exact moment a human is being asked for.
  const blocked = (): AgentStatusSnapshot => ({ id: "n1", name: "Atlas", status: "needs-you", sessionId: "s1" });

  it("stays alive — a blocked agent is the most present thing on the board", () => {
    const members = agentFleetMembers([blocked()], { projectId: "p1", cwd: "/repo" });
    expect(members[0].is_alive).toBe(true);
  });

  it("stays reachable, because an answer is exactly what it is waiting for", () => {
    // ADR-0030: an idle/settled teammate must remain addressable. A blocked one more so — the
    // dispatch may be the answer that unblocks it. `turn` is what tells a peer "will answer you"
    // from "is answering you"; `can_reply` must not be overloaded to mean the second.
    const members = agentFleetMembers([blocked()], { projectId: "p1", cwd: "/repo" });
    expect(members[0].can_reply).toBe(true);
    expect(members[0].can_queue).toBe(true);
  });

  it("reports launch phase as live, not as its turn state", () => {
    // `status` is launch phase, `turn` is turn phase (contract/README.md). Leaking `needs-you`
    // into `status` would collapse the distinction the whole plan rests on.
    const members = agentFleetMembers([blocked()], { projectId: "p1", cwd: "/repo" });
    expect(members[0].status).toBe("live");
  });
});

describe("agentFleetMembers carries the headline", () => {
  // `lotus_list_fleet` reported who each teammate is and what state it is in, but never what it was
  // ASKED. The only clue to its actual work was `last_output_preview`, a raw terminal tail — so a
  // lead agent dispatching across the board was choosing targets half-blind.
  //
  // Worth carrying now in a way it was not before: since headlines are read from the write choke
  // point, EVERY runner has one — not just the Claude family.

  it("reports what the agent was asked", () => {
    const members = agentFleetMembers([snap("n1", "Atlas", "running")], {
      projectId: "p1",
      cwd: "/repo",
      headlineFor: (paneId) => (paneId === "n1" ? "perbaiki judul agent" : undefined),
    });

    expect(members[0].headline).toBe("perbaiki judul agent");
  });

  it("omits the field rather than sending an empty one", () => {
    // Same rule `workspace_label` follows: absent means "this host cannot say", which a client can
    // fall back from. An empty string is an answer, and a blank one.
    const members = agentFleetMembers([snap("n1", "Atlas", "running")], {
      projectId: "p1",
      cwd: "/repo",
      headlineFor: () => "   ",
    });

    expect(members[0].headline).toBeUndefined();
  });

  it("says nothing for an agent that has not been asked anything yet", () => {
    const members = agentFleetMembers([snap("n1", "Atlas", "connecting")], {
      projectId: "p1",
      cwd: "/repo",
      headlineFor: () => undefined,
    });

    expect(members[0].headline).toBeUndefined();
  });

  it("looks the headline up by the pane id, which is what the store keys on", () => {
    // `hookPaneId` is the key the hook exported and the headline store uses. Keying by the node id
    // would file the lookup where nothing is stored and report every agent as untitled.
    const seen: string[] = [];
    agentFleetMembers(
      [{ id: "n1", name: "Atlas", status: "running", hookPaneId: "canvas:cp_1:n1" }],
      { projectId: "p1", cwd: "/repo", headlineFor: (paneId) => (seen.push(paneId), undefined) },
    );

    expect(seen).toEqual(["canvas:cp_1:n1"]);
  });
});

