import { describe, it, expect } from "vitest";
import { deriveFleet } from "../fleet-derivation";
import type { GridCell } from "@/modules/codespace/components/types";
import type { TerminalSessionSnapshot } from "@/modules/codespace/services/terminal-session-registry";

function terminalCell(partial: Partial<Extract<GridCell, { type: "terminal" }>>): GridCell {
  return {
    id: partial.id ?? "pane-1",
    cwd: partial.cwd ?? "/tmp",
    type: "terminal",
    agentCommand: partial.agentCommand,
    terminalCommand: partial.terminalCommand,
    agentAddress: partial.agentAddress,
    legacyAgentAddresses: partial.legacyAgentAddresses,
    agentName: partial.agentName,
    title: partial.title,
    titleStatus: partial.titleStatus,
  } as GridCell;
}

function session(partial: Partial<TerminalSessionSnapshot>): TerminalSessionSnapshot {
  return {
    paneId: partial.paneId ?? "pane-1",
    workspaceId: partial.workspaceId ?? "ws-1",
    cwd: partial.cwd ?? "/tmp",
    status: partial.status ?? "live",
    sessionId: partial.sessionId ?? "s-1",
  };
}

describe("deriveFleet", () => {
  it("detects known provider from agentCommand", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "claude", cwd: "/a" })];
    const sessions = [session({ paneId: "p1", cwd: "/a" })];

    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({
      paneId: "p1",
      provider: "claude",
      displayName: "Claude",
      status: "live",
      isAlive: true,
    });
  });

  it("returns shell for cell without agentCommand", () => {
    const cells: GridCell[] = [terminalCell({ id: "p2", agentCommand: undefined })];
    const sessions = [session({ paneId: "p2" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet[0].provider).toBe("shell");
    expect(fleet[0].displayName).toBe("Shell");
  });

  it("parses first token from multi-arg agentCommand string", () => {
    const cells: GridCell[] = [terminalCell({ id: "p3", agentCommand: "codex --help" })];
    const sessions = [session({ paneId: "p3" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet[0].provider).toBe("codex");
  });

  it("falls back to shell for unknown CLI names", () => {
    const cells: GridCell[] = [terminalCell({ id: "p4", agentCommand: "vim" })];
    const sessions = [session({ paneId: "p4" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet[0].provider).toBe("shell");
  });

  it("treats a cell without a registered session as idle + alive (pre-registration race)", () => {
    const cells: GridCell[] = [terminalCell({ id: "p5", agentCommand: "claude" })];
    const fleet = deriveFleet(cells, [], "ws-1");
    // The cell exists in the workspace but the terminal runtime effect has
    // not yet called createTerminalSession. Bridge must still see it as alive
    // so it does not spawn duplicates on cold-start.
    expect(fleet[0].status).toBe("idle");
    expect(fleet[0].isAlive).toBe(true);
  });

  it("marks cells whose session is explicitly exited as not alive", () => {
    const cells: GridCell[] = [terminalCell({ id: "p5b", agentCommand: "claude" })];
    const sessions = [session({ paneId: "p5b", status: "exited" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet[0].status).toBe("exited");
    expect(fleet[0].isAlive).toBe(false);
  });

  it("marks failed sessions as not alive", () => {
    const cells: GridCell[] = [terminalCell({ id: "p6", agentCommand: "claude" })];
    const sessions = [session({ paneId: "p6", status: "failed" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet[0].isAlive).toBe(false);
    expect(fleet[0].status).toBe("failed");
  });

  it("filters non-terminal cells out", () => {
    const cells: GridCell[] = [
      terminalCell({ id: "p7", agentCommand: "claude" }),
      { id: "browser-1", cwd: "/tmp", type: "browser", url: "https://x" } as GridCell,
      { id: "workbench-1", cwd: "/tmp", type: "workbench", rootDir: "/tmp", tabs: [], activeTabId: null } as GridCell,
    ];
    const sessions = [session({ paneId: "p7" })];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet).toHaveLength(1);
    expect(fleet[0].paneId).toBe("p7");
  });

  it("filters out sessions from other workspaces in the session array", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "claude" })];
    const sessions = [
      session({ paneId: "p1", workspaceId: "ws-1" }),
      session({ paneId: "other", workspaceId: "ws-2" }),
    ];
    const fleet = deriveFleet(cells, sessions, "ws-1");
    expect(fleet).toHaveLength(1);
  });

  it("augments provider via output hints when agentCommand is missing", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: undefined })];
    const sessions = [session({ paneId: "p1" })];
    const fleet = deriveFleet(cells, sessions, "ws-1", {
      getDetectedProvider: (id) => (id === "p1" ? "codex" : null),
      getLastLine: () => "",
      getTail: () => "",
    });
    expect(fleet[0].provider).toBe("codex");
    expect(fleet[0].displayName).toBe("Codex");
  });

  // (04) Was "agentCommand takes precedence over output hint when both present" — that was
  // the bug: a pane launched as claude and later handed off to codex stayed labeled
  // "claude" forever, because birth intent (agentCommand) always beat runtime reality. The
  // launch command is only what the pane STARTED as; a differing runtime-detected provider
  // now wins as the more current signal.
  it("runtime-detected provider wins over agentCommand when they differ", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "claude" })];
    const sessions = [session({ paneId: "p1" })];
    const fleet = deriveFleet(cells, sessions, "ws-1", {
      getDetectedProvider: () => "codex",
      getLastLine: () => "",
      getTail: () => "",
    });
    expect(fleet[0].provider).toBe("codex");
  });

  it("surfaces last output preview from hints", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "claude" })];
    const sessions = [session({ paneId: "p1" })];
    const fleet = deriveFleet(cells, sessions, "ws-1", {
      getDetectedProvider: () => null,
      getLastLine: (id) => (id === "p1" ? "building bundles…" : ""),
      getTail: () => "",
    });
    expect(fleet[0].lastOutputPreview).toBe("building bundles…");
  });

  it("names the runner the way this window prints it, beside the family it routes on", () => {
    // `provider` is what a client routes on; `runnerLabel` is what an operator reads. A
    // remote client with only the first printed a different word than the desktop beside it.
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "claude" })];
    const fleet = deriveFleet(cells, [session({ paneId: "p1" })], "ws-1");

    expect(fleet[0].provider).toBe("claude");
    // The agent registry's own display name — this surface's word, not the canvas's
    // ("Claude Code"). Each surface reports what it draws; unifying them here would make
    // the phone disagree with whichever one it did not copy.
    expect(fleet[0].runnerLabel).toBe("Claude");
  });

  it("names a plain shell cell too, rather than leaving it unlabelled", () => {
    const fleet = deriveFleet([terminalCell({ id: "p1" })], [session({ paneId: "p1" })], "ws-1");

    expect(fleet[0].runnerLabel).toBe("Shell");
  });

  // agentName → provider label (ADR-0068: a rename IS the agentName).
  it("(02) uses the system-allocated agentName as displayName when there is no manual rename", () => {
    const fleet = deriveFleet(
      [terminalCell({ id: "p1", agentCommand: "claude", agentName: "Nara" })],
      [session({ paneId: "p1" })],
      "ws-1",
    );
    expect(fleet[0].displayName).toBe("Nara");
  });

});

// A readable address is the only way one agent can name another without quoting a pane UUID.
// Before this, it arrived solely from the output-sniffing promotion path, so a reattached pane
// never got one — live fleet on 2026-09-12 published five separate `claude` cells with none.
describe("deriveFleet agent addresses", () => {
  it("numbers same-provider cells so each is individually addressable", () => {
    const cells: GridCell[] = [
      terminalCell({ id: "p1", agentCommand: "claude" }),
      terminalCell({ id: "p2", agentCommand: "claude" }),
      terminalCell({ id: "p3", agentCommand: "codex" }),
      terminalCell({ id: "p4", agentCommand: undefined }),
    ];
    const fleet = deriveFleet(cells, [], "ws-1");
    expect(fleet.map((m) => m.agentAddress)).toEqual([
      "claude-1",
      "claude-2",
      "codex-1",
      "shell-1",
    ]);
  });

  it("keeps an explicitly allocated address and never reuses its ordinal", () => {
    const cells: GridCell[] = [
      terminalCell({ id: "p1", agentCommand: "claude" }),
      terminalCell({ id: "p2", agentCommand: "claude", agentAddress: "claude-1" }),
      terminalCell({ id: "p3", agentCommand: "claude" }),
    ];
    const fleet = deriveFleet(cells, [], "ws-1");
    // p2 keeps claude-1, so the derived ones skip it rather than colliding with it.
    expect(fleet.map((m) => m.agentAddress)).toEqual(["claude-2", "claude-1", "claude-3"]);
  });

  it("publishes the address as an alias so a loose spelling still resolves", () => {
    const cells: GridCell[] = [terminalCell({ id: "p1", agentCommand: "codex" })];
    const fleet = deriveFleet(cells, [], "ws-1");
    expect(fleet[0].aliases).toContain("codex-1");
  });

  it("renumbers nothing when a dead cell is still in the workspace", () => {
    const cells: GridCell[] = [
      terminalCell({ id: "p1", agentCommand: "claude" }),
      terminalCell({ id: "p2", agentCommand: "claude" }),
    ];
    // p1 exits; its slot is still counted, so p2 keeps the address peers already know it by.
    const fleet = deriveFleet(cells, [session({ paneId: "p1", status: "exited" })], "ws-1");
    expect(fleet[1].agentAddress).toBe("claude-2");
  });
});
