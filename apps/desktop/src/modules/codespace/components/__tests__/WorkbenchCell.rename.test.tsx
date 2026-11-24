import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

const mocks = vi.hoisted(() => ({
  editorListDirectoryFor: vi.fn(),
  editorRenameEntryFor: vi.fn(),
  editorRevealEntry: vi.fn(),
  moveEditorFileBuffers: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  codespaceGitAiSuggestCommit: vi.fn(),
  codespaceGitDiffFile: vi.fn(),
  codespaceGitDiffFileContent: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: mocks.editorListDirectoryFor,
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  editorRenameEntryFor: mocks.editorRenameEntryFor,
  editorRevealEntry: mocks.editorRevealEntry,
  codespaceGitCommitFor: vi.fn(),
  codespaceGitDiscardAllChangesFor: vi.fn(),
  codespaceGitPushFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitStageAllFor: vi.fn(),
  codespaceGitStageFileFor: vi.fn(),
  codespaceGitStatusFor: vi.fn().mockResolvedValue([]),
  codespaceGitUnstageAllFor: vi.fn(),
  codespaceGitUnstageFileFor: vi.fn(),
}));

vi.mock("@/modules/codespace/services/editor-file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/codespace/services/editor-file-store")>();
  return {
    ...actual,
    readEditorFile: vi.fn(async (path: string) => ({
      path, content: "x", savedContent: "x", mtime: 1, sizeBytes: 1, binary: false, dirty: false,
    })),
    moveEditorFileBuffers: mocks.moveEditorFileBuffers,
  };
});

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: (props: {
    activeFilePath: string | null;
    entries: Array<{ path: string }>;
    onRenameEntry?: (from: string, to: string, kind: "file" | "directory") => Promise<void>;
    onRevealEntry?: (relativePath: string) => void;
  }) => (
    <div
      data-testid="file-tree"
      data-active={props.activeFilePath ?? ""}
      data-entries={props.entries.map((entry) => entry.path).sort().join(",")}
      data-can-reveal={String(Boolean(props.onRevealEntry))}
    >
      <button type="button" onClick={() => void props.onRenameEntry?.("src/a.ts", "src/b.ts", "file")}>rename file</button>
      <button type="button" onClick={() => void props.onRenameEntry?.("src", "lib", "directory")}>rename folder</button>
      <button type="button" onClick={() => props.onRevealEntry?.("src/a.ts")}>reveal</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="source-control" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: () => <div data-testid="workbench-editor" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchTabBar", () => ({
  WorkbenchTabBar: () => <div data-testid="workbench-tabs" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchBrowserTab", () => ({
  WorkbenchBrowserTab: () => <div data-testid="workbench-browser" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: () => <div data-testid="workbench-diff" />,
}));

const initial: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [
    { id: "t1", kind: "file", filePath: "/home/alwi/repo/src/a.ts" },
    { id: "t2", kind: "file", filePath: "/home/alwi/repo/src/deep/x.ts" },
    { id: "t3", kind: "file", filePath: "/home/alwi/repo/srcx.ts" },
  ],
  activeTabId: "t1",
};

function Harness({ location }: { location?: CodeSpaceStoredWorkspaceLocation }) {
  const [cell, setCell] = useState(initial);
  return <WorkbenchCell cell={cell} location={location} onCellChange={(update) => setCell(update)} />;
}

const tree = () => screen.getByTestId("file-tree");

describe("WorkbenchCell rename and reveal", () => {
  beforeEach(() => {
    mocks.editorListDirectoryFor.mockReset();
    mocks.editorListDirectoryFor.mockResolvedValue([]);
    mocks.editorRenameEntryFor.mockReset();
    mocks.editorRenameEntryFor.mockImplementation(async (_l: unknown, _f: string, to: string) => ({ path: `/home/alwi/repo/${to}` }));
    mocks.editorRevealEntry.mockReset();
    mocks.moveEditorFileBuffers.mockReset();
  });

  it("renames through the workspace dispatcher and moves the open tab with its edits", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-active", "/home/alwi/repo/src/a.ts"));

    await user.click(screen.getByRole("button", { name: "rename file" }));

    expect(mocks.editorRenameEntryFor).toHaveBeenCalledWith(null, "src/a.ts", "src/b.ts", {
      localRoot: "/home/alwi/repo",
      remoteRoot: "/home/alwi/repo",
    });
    await waitFor(() => expect(tree()).toHaveAttribute("data-active", "/home/alwi/repo/src/b.ts"));
    expect(mocks.moveEditorFileBuffers).toHaveBeenCalledWith("/home/alwi/repo/src/a.ts", "/home/alwi/repo/src/b.ts");
  });

  it("moves every tab under a renamed folder, and none that only share its prefix", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-active", "/home/alwi/repo/src/a.ts"));

    await user.click(screen.getByRole("button", { name: "rename folder" }));

    await waitFor(() => expect(tree()).toHaveAttribute("data-active", "/home/alwi/repo/lib/a.ts"));
    const entries = tree().getAttribute("data-entries");
    expect(entries).toContain("/home/alwi/repo/lib/deep/x.ts");
    expect(entries).toContain("/home/alwi/repo/srcx.ts");
    expect(entries).not.toContain("/home/alwi/repo/src/");
    expect(mocks.moveEditorFileBuffers).toHaveBeenCalledWith("/home/alwi/repo/src", "/home/alwi/repo/lib");
  });

  it("reveals a local entry in Finder", async () => {
    const user = userEvent.setup();
    render(<Harness location={{ kind: "local", cwd: "/home/alwi/repo" }} />);
    expect(tree()).toHaveAttribute("data-can-reveal", "true");

    await user.click(screen.getByRole("button", { name: "reveal" }));

    expect(mocks.editorRevealEntry).toHaveBeenCalledWith("/home/alwi/repo", "src/a.ts");
  });

  it("offers no Finder for an SSH workspace", () => {
    render(<Harness location={{ kind: "ssh", host: "vps", user: "alwi", remoteCwd: "/home/alwi/repo" }} />);
    expect(tree()).toHaveAttribute("data-can-reveal", "false");
  });
});
