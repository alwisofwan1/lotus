import { describe, expect, it } from "vitest";
import type { Workspace } from "@/modules/codespace/components/types";
import { promoteFleetTargetIdentity } from "../fleet-identity-sync";
import { resolveFleetTarget } from "../fleet-naming";

function workspace(): Workspace {
  return {
    id: "ws-1",
    label: "Project",
    color: "#4F8CFF",
    cwd: "/repo",
    rows: 1,
    cols: 2,
    agentAddressCounters: { shell: 1, codex: 1 },
    cells: [
      {
        id: "codex-pane",
        cwd: "/repo",
        type: "terminal",
        agentCommand: "codex",
        agentAddress: "codex-1",
      },
      {
        id: "shell-pane",
        cwd: "/repo",
        type: "terminal",
        agentAddress: "shell-1",
      },
    ],
  };
}

describe("promoteFleetTargetIdentity", () => {
  it("allocates a canonical provider address and preserves the previous address as a legacy alias", () => {
    const next = promoteFleetTargetIdentity(workspace(), "shell-pane", "codex");
    const promoted = next.cells.find((cell) => cell.id === "shell-pane");

    expect(promoted).toEqual(
      expect.objectContaining({
        agentAddress: "codex-2",
        legacyAgentAddresses: ["shell-1"],
      }),
    );
    expect(next.agentAddressCounters).toEqual({ shell: 1, codex: 2 });
  });

  it("is idempotent when the current address already belongs to the runtime provider", () => {
    const first = promoteFleetTargetIdentity(workspace(), "shell-pane", "codex");
    const second = promoteFleetTargetIdentity(first, "shell-pane", "codex");

    expect(second).toEqual(first);
  });

  // (04) The scenario the bug report was built on: a pane started as claude, handed off to
  // codex in the same PTY. The old address must stay dispatchable — a caller (or a
  // neighbour's cached address) mid-handoff must not lose the target just because the
  // label changed underneath it.
  it("(04) a claude pane handed off to codex keeps claude-1 dispatchable as a legacy alias", () => {
    const handoff: Workspace = {
      id: "ws-1",
      label: "Project",
      color: "#4F8CFF",
      cwd: "/repo",
      rows: 1,
      cols: 1,
      agentAddressCounters: { claude: 1 },
      cells: [
        {
          id: "handoff-pane",
          cwd: "/repo",
          type: "terminal",
          agentCommand: "claude",
          agentAddress: "claude-1",
        },
      ],
    };

    const next = promoteFleetTargetIdentity(handoff, "handoff-pane", "codex");
    const promoted = next.cells.find((cell) => cell.id === "handoff-pane");
    expect(promoted).toEqual(
      expect.objectContaining({
        agentAddress: "codex-1",
        legacyAgentAddresses: ["claude-1"],
      }),
    );

    const fleet = [
      {
        paneId: "handoff-pane",
        isAlive: true,
        agentAddress: (promoted as { agentAddress?: string }).agentAddress,
        legacyAgentAddresses: (promoted as { legacyAgentAddresses?: string[] }).legacyAgentAddresses,
        displayName: "Codex",
      },
    ];
    expect(resolveFleetTarget(fleet, "claude-1")?.paneId).toBe("handoff-pane");
    expect(resolveFleetTarget(fleet, "codex-1")?.paneId).toBe("handoff-pane");
  });

  // Slice 02 §4: the majority case on this machine — a pane STARTED as shell, then had an
  // agent CLI typed into it. Without this, those panes are exactly the ones that never get a
  // person's name.
  it("(02) gives a shell pane promoted to an agent a person's name", () => {
    const next = promoteFleetTargetIdentity(workspace(), "shell-pane", "codex");
    const promoted = next.cells.find((cell) => cell.id === "shell-pane") as { agentName?: string };
    expect(promoted.agentName).toBeTruthy();
  });

  it("(02) never allocates the same name to two different agents in one workspace", () => {
    const ws: Workspace = {
      id: "ws-1",
      label: "Project",
      color: "#4F8CFF",
      cwd: "/repo",
      rows: 1,
      cols: 2,
      cells: [
        { id: "pane-a", cwd: "/repo", type: "terminal", agentCommand: "claude", agentAddress: "claude-1" },
        { id: "pane-b", cwd: "/repo", type: "terminal", agentCommand: "codex", agentAddress: "codex-1" },
      ],
    };
    const afterA = promoteFleetTargetIdentity(ws, "pane-a", "claude");
    const afterBoth = promoteFleetTargetIdentity(afterA, "pane-b", "codex");

    const nameA = (afterBoth.cells.find((c) => c.id === "pane-a") as { agentName?: string }).agentName;
    const nameB = (afterBoth.cells.find((c) => c.id === "pane-b") as { agentName?: string }).agentName;
    expect(nameA).toBeTruthy();
    expect(nameB).toBeTruthy();
    expect(nameA).not.toBe(nameB);
  });

  // A name may repeat ACROSS workspaces — that's deliberate (real uniqueness is
  // agentAddress + workspace scoping), so two separately-promoted single-agent workspaces
  // legitimately draw the same first pool name.
  it("(02) allows the same name across two different workspaces", () => {
    const wsX: Workspace = { ...workspace(), id: "ws-x", cells: [{ id: "p-x", cwd: "/repo", type: "terminal", agentCommand: "claude" }] };
    const wsY: Workspace = { ...workspace(), id: "ws-y", cells: [{ id: "p-y", cwd: "/repo", type: "terminal", agentCommand: "claude" }] };

    const nextX = promoteFleetTargetIdentity(wsX, "p-x", "claude");
    const nextY = promoteFleetTargetIdentity(wsY, "p-y", "claude");

    const nameX = (nextX.cells.find((c) => c.id === "p-x") as { agentName?: string }).agentName;
    const nameY = (nextY.cells.find((c) => c.id === "p-y") as { agentName?: string }).agentName;
    expect(nameX).toBeTruthy();
    expect(nameX).toBe(nameY);
  });
});
