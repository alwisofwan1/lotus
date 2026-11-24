import { describe, expect, it } from "vitest";
import type { CodeSpaceWorkspaceSnapshot } from "@/modules/codespace/services/workspace-metadata";
import {
  createCodeSpaceTerminalMetadataRepository,
  toTerminalV2MetadataSnapshot,
} from "../codespace-terminal-metadata-repository";

function snapshot(): CodeSpaceWorkspaceSnapshot {
  return {
    activeWorkspaceId: "workspace-1",
    focusedCellId: "terminal-1",
    workspaces: [
      {
        id: "workspace-1",
        label: "W1",
        color: "#fff",
        cwd: "/repo",
        location: { kind: "local", cwd: "/repo" },
        rows: 1,
        cols: 2,
        cells: [
          {
            id: "terminal-1",
            type: "terminal",
            cwd: "/repo",
            runtimeSessionId: "stale-session-id",
            runtimeStatus: "live",
            agentCommand: "claude",
            title: "Implement auth",
            titleUpdatedAt: 123,
          },
          {
            id: "browser-1",
            type: "browser",
            cwd: "/repo",
            url: "http://localhost:3000",
          },
          {
            id: "terminal-2",
            type: "terminal",
            cwd: "/repo/api",
            terminalCommand: ["bun", "test"],
            runtimeStatus: "failed",
          },
        ],
      },
    ],
  };
}

describe("CodeSpace Terminal V2 metadata repository", () => {
  it("hydrates terminal metadata from the existing CodeSpace snapshot", () => {
    const restored = toTerminalV2MetadataSnapshot(snapshot(), 777);

    expect(restored).toEqual({
      persistenceMode: "metadata-only",
      source: "codespace-sqlite",
      loadedAt: 777,
      activeWorkspaceId: "workspace-1",
      focusedPaneId: "terminal-1",
      workspaces: [
        {
          workspaceId: "workspace-1",
          label: "W1",
          cwd: "/repo",
          location: { kind: "local", cwd: "/repo" },
          terminalPanes: [
            {
              paneId: "terminal-1",
              workspaceId: "workspace-1",
              launch: { kind: "local", cwd: "/repo" },
              agentCommand: "claude",
              title: "Implement auth",
              titleUpdatedAt: 123,
              restoredStatus: "cold",
            },
            {
              paneId: "terminal-2",
              workspaceId: "workspace-1",
              launch: { kind: "local", cwd: "/repo/api", command: ["bun", "test"] },
              restoredStatus: "failed",
            },
          ],
        },
      ],
    });
  });

  it("does not expose stale runtime session ids as resumable state", () => {
    const restored = toTerminalV2MetadataSnapshot(snapshot(), 777);

    expect(JSON.stringify(restored)).not.toContain("stale-session-id");
    expect(restored?.workspaces[0]?.terminalPanes[0]?.restoredStatus).toBe("cold");
  });

  it("normalizes focus to null when the focused cell is not a terminal pane", () => {
    const next = snapshot();
    next.focusedCellId = "browser-1";

    expect(toTerminalV2MetadataSnapshot(next, 777)?.focusedPaneId).toBeNull();
  });

  it("uses the injected loader", async () => {
    const repository = createCodeSpaceTerminalMetadataRepository(async () => snapshot());

    await expect(repository.loadSnapshot()).resolves.toMatchObject({
      source: "codespace-sqlite",
      activeWorkspaceId: "workspace-1",
    });
  });
});
