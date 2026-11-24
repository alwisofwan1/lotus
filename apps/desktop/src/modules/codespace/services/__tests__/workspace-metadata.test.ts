import { describe, expect, it, vi } from "vitest";
import type { GridCell, TerminalCellData, Workspace } from "@/modules/codespace/components/types";
import {
  fromStoredCodeSpaceSnapshot,
  toStoredCodeSpaceSnapshot,
} from "@/modules/codespace/services/workspace-metadata";

vi.mock("@/lib/tauri-api", () => ({
  loadCodeSpaceSnapshot: vi.fn(),
  saveCodeSpaceSnapshot: vi.fn(),
}));

function terminalCell(cell: GridCell | undefined): TerminalCellData {
  expect(cell?.type).toBe("terminal");
  return cell as TerminalCellData;
}

const workspace: Workspace = {
  id: "workspace-1",
  label: "Project",
  color: "#4F8CFF",
  cwd: "/tmp/project",
  rows: 1,
  cols: 2,
  rowFractions: [1],
  colFractions: [0.4, 0.6],
  cells: [
    {
      id: "pane-1",
      cwd: "/tmp/project",
      type: "terminal",
      runtimeSessionId: "runtime-1",
      runtimeStatus: "live",
      agentCommand: "claude",
    },
    {
      id: "pane-2",
      cwd: "/tmp/project",
      type: "terminal",
      runtimeSessionId: null,
      runtimeStatus: "failed",
      agentCommand: "codex",
    },
  ],
};

describe("a restored Claude pane", () => {
  const stored = (agentCommand: string, paneTitleSessionKey?: string) =>
    fromStoredCodeSpaceSnapshot(toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        cells: [{
          ...workspace.cells[0]!,
          agentCommand,
          title: "Daftar isi folder",
          titleStatus: "ready",
          titleSessionKey: paneTitleSessionKey,
        } as TerminalCellData],
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: null,
    }));
  const command = (snapshot: ReturnType<typeof stored>) => terminalCell(snapshot.workspaces[0]?.cells[0]).agentCommand;

  it("resumes the conversation its title follows", () => {
    expect(command(stored("claude --dangerously-skip-permissions", "/h/.claude/projects/-p/abc-123.jsonl")))
      .toBe("claude --dangerously-skip-permissions --resume abc-123");
  });

  it("never stacks an earlier resume, and drops it when no conversation is known", () => {
    expect(command(stored("claude --resume old --dangerously-skip-permissions", "/h/.claude/projects/-p/new.jsonl")))
      .toBe("claude --dangerously-skip-permissions --resume new");
    expect(command(stored("claude --resume old"))).toBe("claude");
  });

  it("leaves other agents alone", () => {
    expect(command(stored("codex", "/h/.codex/sessions/rollout-1.jsonl"))).toBe("codex");
  });
});

describe("workspace-metadata", () => {
  it("maps workspace state to durable CodeSpace snapshot", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [workspace],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-2",
    });

    expect(stored.workspaces[0]).toEqual(
      expect.objectContaining({
        id: "workspace-1",
        schemaVersion: 3,
        rowFractions: [1],
        colFractions: [0.4, 0.6],
      }),
    );
    expect(stored.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({
        id: "pane-1",
        runtimeSessionId: "runtime-1",
        runtimeStatus: "live",
        agentCommand: "claude",
      }),
    );
  });

  it("leaves a pane's diff tabs out of the saved workspace", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        cells: [{
          id: "editor-1",
          cwd: "/tmp/project",
          type: "workbench",
          rootDir: "/tmp/project",
          tabs: [
            { id: "file:/tmp/project/a.ts", kind: "file", filePath: "/tmp/project/a.ts" },
            { id: "diff:/tmp/project/a.ts", kind: "diff", filePath: "/tmp/project/a.ts", target: "unstaged" },
          ],
          activeTabId: "diff:/tmp/project/a.ts",
        }],
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: null,
    });

    const cell = stored.workspaces[0]?.cells[0];
    expect(cell?.tabs).toEqual([{ id: "file:/tmp/project/a.ts", kind: "file", filePath: "/tmp/project/a.ts" }]);
    expect(cell?.activeTabId).toBe("file:/tmp/project/a.ts");
  });

  it("persists workspace pane layout state", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        paneLayout: { mode: "main-bottom", focusCellId: "pane-2" },
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-2",
    });

    expect(stored.workspaces[0]?.paneLayout).toEqual({
      mode: "main-bottom",
      focusCellId: "pane-2",
    });

    const restored = fromStoredCodeSpaceSnapshot(stored);
    expect(restored.workspaces[0]?.paneLayout).toEqual({
      mode: "main-bottom",
      focusCellId: "pane-2",
    });
  });

  it("keeps Frames, their members and their layouts across a restart", () => {
    const frameLayout = { root: { kind: "leaf" as const, paneId: "pane-2" }, activePaneId: "pane-2" };
    const frames = [
      { id: "f1", name: "API", color: "teal" as const, createdAt: 5, paneIds: ["pane-2"], layout: frameLayout },
      { id: "f2", name: "Empty", color: "rose" as const, createdAt: 6, paneIds: [], layout: null },
    ];
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{ ...workspace, paneLayout: { mode: "grid", frames, framesMigrated: true } }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-2",
    });

    const restored = fromStoredCodeSpaceSnapshot(JSON.parse(JSON.stringify(stored)));
    expect(restored.workspaces[0]?.paneLayout).toMatchObject({ frames, framesMigrated: true });
  });

  // Slice 02: agentName is system-allocated (not user-typed like customDisplayName), but must
  // still survive a restart unchanged — unlike agentAddress, which is re-derived at runtime.
  it("(02) persists a terminal cell's agentName across a serialize/restore round trip", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        cells: [{ ...workspace.cells[0], agentName: "Nara" } as TerminalCellData, workspace.cells[1]],
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-2",
    });

    expect(stored.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({ id: "pane-1", agentName: "Nara" }),
    );

    const restored = fromStoredCodeSpaceSnapshot(stored);
    expect(terminalCell(restored.workspaces[0]?.cells[0]).agentName).toBe("Nara");
  });

  /*
    2026-10-10: a plain shell pane ("Soren") kept "Codespace demo workspace setup", a name the
    old screen-reading titler gave it. Titles now name an agent conversation and carry its key;
    a shell has no conversation, so nothing would ever replace that name.
  */
  describe("old automatic titles", () => {
    const roundTrip = (patch: Partial<TerminalCellData>) => {
      const stored = toStoredCodeSpaceSnapshot({
        workspaces: [{ ...workspace, cells: [{ ...workspace.cells[0], ...patch } as TerminalCellData, workspace.cells[1]] }],
        activeWorkspaceId: "workspace-1",
        focusedCellId: "pane-2",
      });
      return terminalCell(fromStoredCodeSpaceSnapshot(stored).workspaces[0]?.cells[0]);
    };

    it("are dropped from a pane with no agent", () => {
      const cell = roundTrip({ agentCommand: undefined, title: "Codespace demo workspace setup", titleStatus: "ready" });
      expect(cell.title).toBeUndefined();
      expect(cell.titleStatus).toBeUndefined();
    });

    it("stay on an agent pane, which replaces them on its next turn", () => {
      expect(roundTrip({ agentCommand: "claude", title: "Old name", titleStatus: "ready" }).title).toBe("Old name");
    });

    it("stay when they name a known conversation", () => {
      const cell = roundTrip({ agentCommand: undefined, title: "Fix login", titleStatus: "ready", titleSessionKey: "/x.jsonl" });
      expect(cell.title).toBe("Fix login");
      expect(cell.titleSessionKey).toBe("/x.jsonl");
    });

    it("drop a stored title with no letter or digit (\"---\", 2026-11-15)", () => {
      expect(roundTrip({ agentCommand: "claude", title: "---", titleStatus: "ready", titleSessionKey: "/x.jsonl" }).title).toBeUndefined();
    });
  });

  // ADR-0068: a rename IS the handle now. An old `customDisplayName` on disk becomes the agentName once.
  it("moves an old customDisplayName into agentName on restore, and stops writing it", () => {
    const stored = toStoredCodeSpaceSnapshot({ workspaces: [workspace], activeWorkspaceId: "workspace-1", focusedCellId: "pane-2" });
    expect(stored.workspaces[0]?.cells[0]).not.toHaveProperty("customDisplayName");

    const old = { ...stored, workspaces: [{ ...stored.workspaces[0]!, cells: [{ ...stored.workspaces[0]!.cells[0]!, agentName: "Nara", customDisplayName: "Reviewer" }, ...stored.workspaces[0]!.cells.slice(1)] }] };
    const restored = fromStoredCodeSpaceSnapshot(old);
    expect(terminalCell(restored.workspaces[0]?.cells[0]).agentName).toBe("Reviewer");
    expect(restored.workspaces[0]?.cells[0]).not.toHaveProperty("customDisplayName");
  });

  it("persists and sanitizes Terminal V2 dynamic layout tree metadata", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        paneLayout: {
          mode: "grid",
          focusCellId: "pane-2",
          terminalV2Layout: {
            root: {
              kind: "split",
              direction: "horizontal",
              sizes: [50, 50],
              children: [
                { kind: "leaf", paneId: "pane-1" },
                { kind: "leaf", paneId: "missing-pane" },
                { kind: "leaf", paneId: "pane-2" },
              ],
            },
            activePaneId: "missing-pane",
          },
        },
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-2",
    });

    expect(stored.workspaces[0]?.paneLayout?.terminalV2Layout).toEqual({
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { kind: "leaf", paneId: "pane-1" },
          { kind: "leaf", paneId: "pane-2" },
        ],
      },
      activePaneId: "pane-2",
    });

    const restored = fromStoredCodeSpaceSnapshot(stored);
    expect(restored.workspaces[0]?.paneLayout?.terminalV2Layout).toEqual(stored.workspaces[0]?.paneLayout?.terminalV2Layout);
  });

  it("sanitizes stale pane layout focus ids when restoring metadata", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      workspaces: [{
        ...toStoredCodeSpaceSnapshot({
          workspaces: [workspace],
          activeWorkspaceId: "workspace-1",
          focusedCellId: "pane-1",
        }).workspaces[0]!,
        paneLayout: { mode: "focus", focusCellId: "missing-pane" },
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-1",
      updatedAt: 1000,
    });

    expect(restored.workspaces[0]?.paneLayout).toEqual({
      mode: "grid",
      focusCellId: null,
    });
  });

  it("restores metadata without pretending old runtime sessions are live", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      workspaces: [
        {
          id: "workspace-1",
          label: "Project",
          color: "#4F8CFF",
          cwd: "/tmp/project",
          rows: 1,
          cols: 2,
          rowFractions: [1],
          colFractions: [0.4, 0.6],
          cells: [
            {
              id: "pane-1",
              cwd: "/tmp/project",
              runtimeSessionId: "old-runtime",
              runtimeStatus: "live",
              agentCommand: "claude",
            },
            {
              id: "pane-2",
              cwd: "/tmp/project",
              runtimeSessionId: null,
              runtimeStatus: "failed",
              agentCommand: "codex",
            },
          ],
        },
      ],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-1",
      updatedAt: 1000,
    });

    expect(restored.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({
        runtimeSessionId: null,
        runtimeStatus: "idle",
      }),
    );
    expect(restored.workspaces[0]?.cells[1]).toEqual(
      expect.objectContaining({
        runtimeSessionId: null,
        runtimeStatus: "failed",
      }),
    );
  });

  it("falls back to the first available workspace and cell when stored focus ids are stale", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      workspaces: [toStoredCodeSpaceSnapshot({
        workspaces: [workspace],
        activeWorkspaceId: "workspace-1",
        focusedCellId: "pane-1",
      }).workspaces[0]!],
      activeWorkspaceId: "missing-workspace",
      focusedCellId: "missing-pane",
      updatedAt: 1000,
    });

    expect(restored.activeWorkspaceId).toBe("workspace-1");
    expect(restored.focusedCellId).toBe("pane-1");
  });

  it("migrates schema v1 cells to terminal-only cells", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      workspaces: [
        {
          id: "workspace-1",
          label: "Project",
          color: "#4F8CFF",
          cwd: "/tmp/project",
          rows: 1,
          cols: 1,
          rowFractions: [1],
          colFractions: [1],
          cells: [
            {
              id: "pane-1",
              cwd: "/tmp/project",
              type: "browser",
              runtimeStatus: "live",
              url: "https://example.com",
            },
          ],
        },
      ],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-1",
      updatedAt: 1000,
    });

    expect(restored.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({
        type: "terminal",
        runtimeStatus: "idle",
      }),
    );
  });

  it("persists remote workspace metadata without restoring live SSH commands", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [{
        ...workspace,
        cwd: "/home/alwi/workspace/acme-main",
        location: {
          kind: "ssh",
          host: "devbox-vps",
          user: "alwi",
          port: 2222,
          remoteCwd: "/home/alwi/workspace/acme-main",
          label: "Devbox VPS",
        },
        cells: [{
          ...terminalCell(workspace.cells[0]),
          cwd: "/home/alwi/workspace/acme-main",
          terminalCommand: ["ssh", "-t", "devbox-vps"],
        }],
      }],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-1",
    });

    expect(stored.workspaces[0]?.location).toEqual({
      kind: "ssh",
      host: "devbox-vps",
      user: "alwi",
      port: 2222,
      remoteCwd: "/home/alwi/workspace/acme-main",
      label: "Devbox VPS",
    });
    expect(stored.workspaces[0]?.cells[0]?.terminalCommand).toBeNull();

    const restored = fromStoredCodeSpaceSnapshot(stored);

    expect(restored.workspaces[0]?.location).toEqual(stored.workspaces[0]?.location);
    expect(terminalCell(restored.workspaces[0]?.cells[0]).terminalCommand).toBeUndefined();
    expect(terminalCell(restored.workspaces[0]?.cells[0]).runtimeStatus).toBe("idle");
  });

  it("drops legacy mock workbench tabs when restoring saved metadata", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      workspaces: [
        {
          id: "workspace-1",
          label: "Project",
          color: "#4F8CFF",
          cwd: "/tmp/project",
          schemaVersion: 2,
          rows: 1,
          cols: 1,
          rowFractions: [1],
          colFractions: [1],
          cells: [
            {
              id: "pane-1",
              cwd: "/tmp/project",
              type: "workbench",
              rootDir: "/tmp/project",
              tabs: [
                { id: "mock-file-card", kind: "file", filePath: "/tmp/project/src/components/CryptoProjectCard.tsx" },
                { id: "mock-file-route", kind: "file", filePath: "/tmp/project/src/app/page.tsx" },
                { id: "mock-url-preview", kind: "url", url: "http://localhost:3000", title: "Preview" },
                { id: "real-file", kind: "file", filePath: "/tmp/project/src/actual.ts" },
              ],
              activeTabId: "mock-file-card",
            },
          ],
        },
      ],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-1",
      updatedAt: 1000,
    });

    expect(restored.workspaces[0]?.cells[0]).toEqual(
      expect.objectContaining({
        type: "workbench",
        tabs: [{ id: "real-file", kind: "file", filePath: "/tmp/project/src/actual.ts" }],
        activeTabId: "real-file",
      }),
    );
  });
});

describe("chat panes (M1.1)", () => {
  function workspaceWithCells(cells: GridCell[]): Workspace {
    return { ...workspace, cells };
  }

  it("persists a chat pane as a reference to a conversation, not the conversation", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [
        workspaceWithCells([
          { id: "pane-chat", cwd: "/tmp/project", type: "chat", sessionId: "session-7" },
        ]),
      ],
      activeWorkspaceId: "workspace-1",
      focusedCellId: "pane-chat",
    });

    const pane = stored.workspaces[0].cells[0];
    expect(pane.type).toBe("chat");
    expect(pane.sessionId).toBe("session-7");
    // No message, title or model may ride along: the CodeChat store owns all of that.
    expect(JSON.stringify(pane)).not.toMatch(/messages|runtimeConfig/);
  });

  it("round-trips a chat pane", () => {
    const cells: GridCell[] = [
      { id: "pane-chat", cwd: "/tmp/project", type: "chat", sessionId: "session-7" },
    ];
    const restored = fromStoredCodeSpaceSnapshot(
      toStoredCodeSpaceSnapshot({
        workspaces: [workspaceWithCells(cells)],
        activeWorkspaceId: "workspace-1",
        focusedCellId: "pane-chat",
      }),
    );

    expect(restored.workspaces[0].cells[0]).toMatchObject({
      id: "pane-chat",
      type: "chat",
      sessionId: "session-7",
    });
  });

  it("round-trips a new-chat pane, with or without its thread yet (07d)", () => {
    const cells: GridCell[] = [
      { id: "a", cwd: "/tmp/project", type: "chat", sessionId: "", thread: { id: null } },
      { id: "b", cwd: "/tmp/project", type: "chat", sessionId: "", thread: { id: "t1", title: "Fix it" } },
    ];
    const restored = fromStoredCodeSpaceSnapshot(
      toStoredCodeSpaceSnapshot({ workspaces: [workspaceWithCells(cells)], activeWorkspaceId: "workspace-1", focusedCellId: null }),
    );
    expect(restored.workspaces[0].cells).toMatchObject([
      { id: "a", type: "chat", thread: { id: null } },
      { id: "b", type: "chat", thread: { id: "t1", title: "Fix it" } },
    ]);
  });

  it("degrades a chat pane with no conversation to a terminal instead of rendering an empty thread", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      updatedAt: 1,
      activeWorkspaceId: "workspace-1",
      focusedCellId: null,
      workspaces: [
        {
          id: "workspace-1",
          label: "Project",
          color: "#4F8CFF",
          cwd: "/tmp/project",
          schemaVersion: 3,
          rows: 1,
          cols: 1,
          rowFractions: [1],
          colFractions: [1],
          cells: [{ id: "pane-chat", cwd: "/tmp/project", type: "chat" }],
        },
      ],
    });

    expect(restored.workspaces[0].cells[0].type).toBe("terminal");
  });

  it("degrades a pane type this build has never heard of, rather than dropping the pane", () => {
    const restored = fromStoredCodeSpaceSnapshot({
      updatedAt: 1,
      activeWorkspaceId: "workspace-1",
      focusedCellId: null,
      workspaces: [
        {
          id: "workspace-1",
          label: "Project",
          color: "#4F8CFF",
          cwd: "/tmp/project",
          schemaVersion: 3,
          rows: 1,
          cols: 1,
          rowFractions: [1],
          colFractions: [1],
          cells: [
            // What a NEWER build writes and this one must survive.
            { id: "pane-x", cwd: "/tmp/project", type: "simulator" as never },
          ],
        },
      ],
    });

    expect(restored.workspaces[0].cells).toHaveLength(1);
    expect(restored.workspaces[0].cells[0].type).toBe("terminal");
  });
});

describe("a snapshot written before the right panel was retired", () => {
  /*
    The store is SQLite with a `right_panel_json` column, and Rust hands the value back as opaque
    JSON. Every workspace saved before this build carries one. Restoring must simply not care:
    reading a field nobody declares is how a dropped feature becomes a crash on someone else's
    machine, and "it is only TypeScript, it will be ignored" is a claim worth a test rather than a
    comment.
  */
  it("loads, and drops the field it no longer has a use for", () => {
    const stored = toStoredCodeSpaceSnapshot({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      focusedCellId: workspace.cells[0]?.id ?? null,
    });
    const legacyRow = {
      ...stored,
      workspaces: stored.workspaces.map((entry) => ({
        ...entry,
        rightPanel: {
          mode: "editor",
          collapsed: false,
          width: 480,
          browser: { id: "rp-browser", cwd: "/tmp/project", type: "browser", url: "", zoom: 1, loading: false },
          editor: { id: "rp-editor", cwd: "/tmp/project", type: "workbench", rootDir: "/tmp/project", tabs: [], activeTabId: null, sidebarCollapsed: false, sidebarWidth: 206 },
          behavior: { autoOpenOnBridgeCompletion: true, autoSwitchFromFocusedCell: true, respectManualCollapse: true },
        },
      })),
    };

    const restored = fromStoredCodeSpaceSnapshot(legacyRow as never);

    expect(restored.workspaces).toHaveLength(1);
    expect(restored.workspaces[0]?.id).toBe(workspace.id);
    expect(restored.workspaces[0]?.cells).toHaveLength(workspace.cells.length);
    expect(restored.workspaces[0]).not.toHaveProperty("rightPanel");
  });
});
