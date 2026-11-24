import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Node } from "@xyflow/react";

const mocks = vi.hoisted(() => ({ panel: vi.fn() }));
vi.mock("@/lib/tauri/codespace", () => ({ codespaceGitPanelRefresh: mocks.panel }));

import { buildAgentProfile, gatherDispatchWorkspaceContext } from "../canvas-dispatch-context";

function node(id: string, type: string, selected: boolean, data: Record<string, unknown> = {}): Node {
  return { id, type, selected, position: { x: 0, y: 0 }, data } as Node;
}

const panel = (files: string[], summary: Partial<{ branch: string; ahead: number; behind: number; upstream: string | null }> = {}) => ({
  summary: { branch: "main", head: "abc1234", upstream: "origin/main", ahead: 0, behind: 0, ...summary },
  files: files.map((relativePath) => ({ path: `/repo/${relativePath}`, relativePath, staged: null, unstaged: "modified" })),
});

describe("gatherDispatchWorkspaceContext", () => {
  beforeEach(() => mocks.panel.mockReset());

  it("summarizes git state and caps the changed-file sample", async () => {
    mocks.panel.mockResolvedValue(panel(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"], { ahead: 2 }));

    const ctx = await gatherDispatchWorkspaceContext({ rootDir: "/repo", nodes: [] });

    expect(ctx.git).toMatchObject({ branch: "main", ahead: 2, changedCount: 7 });
    expect(ctx.git?.changedFiles).toHaveLength(6); // capped
  });

  it("includes labels of selected nodes only", async () => {
    mocks.panel.mockResolvedValue(panel([]));
    const nodes = [
      node("a", "agent", true, { name: "Skye" }),
      node("t", "task", true, { title: "Fix auth" }),
      node("n", "note", false, { label: "ignored" }),
    ];

    const ctx = await gatherDispatchWorkspaceContext({ rootDir: "/repo", nodes });

    expect(ctx.selection).toEqual(["agent Skye", "task Fix auth"]);
  });

  it("omits git when unavailable (null) and still returns selection", async () => {
    mocks.panel.mockResolvedValue(null); // browser / not a git repo

    const ctx = await gatherDispatchWorkspaceContext({ rootDir: "/repo", nodes: [node("a", "agent", true, { name: "Skye" })] });

    expect(ctx.git).toBeUndefined();
    expect(ctx.selection).toEqual(["agent Skye"]);
  });
});

describe("buildAgentProfile", () => {
  it("reads runner / model / skills from the agent node", () => {
    const nodes = [node("ag1", "agent", false, { name: "Rowan", runner: "codex", model: "gpt-5.5", appliedSkills: ["security-review"] })];
    expect(buildAgentProfile("ag1", nodes, [])).toEqual({
      name: "Rowan",
      role: undefined,
      runner: "codex",
      model: "gpt-5.5",
      skills: ["security-review"],
    });
  });

  it("falls back to the roster name when the node is absent", () => {
    expect(buildAgentProfile("ag1", [], [{ id: "ag1", name: "Skye" }])).toMatchObject({ name: "Skye" });
  });

  it("returns undefined when nothing is known", () => {
    expect(buildAgentProfile("ghost", [], [])).toBeUndefined();
  });
});
