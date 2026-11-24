import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";

const mocks = vi.hoisted(() => ({
  editorListEntriesFor: vi.fn(),
  editorIndexFilesFor: vi.fn(),
  editorListDirectoryFor: vi.fn(),
  codespaceGitStatusFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn(),
  readEditorFile: vi.fn(),
  updateEditorFileBuffer: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  codespaceGitAiSuggestCommit: vi.fn(),
  codespaceGitDiffFile: vi.fn(),
  codespaceGitDiffFileContent: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: mocks.editorListEntriesFor,
  editorIndexFilesFor: mocks.editorIndexFilesFor,
  editorListDirectoryFor: mocks.editorListDirectoryFor,
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  codespaceGitCommitFor: vi.fn(),
  codespaceGitDiscardAllChangesFor: vi.fn(),
  codespaceGitPushFor: vi.fn(),
  codespaceGitRepoSummaryFor: mocks.codespaceGitRepoSummaryFor,
  codespaceGitStageAllFor: vi.fn(),
  codespaceGitStageFileFor: vi.fn(),
  codespaceGitStatusFor: mocks.codespaceGitStatusFor,
  codespaceGitUnstageAllFor: vi.fn(),
  codespaceGitUnstageFileFor: vi.fn(),
}));

vi.mock("@/modules/codespace/services/editor-file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/codespace/services/editor-file-store")>();
  return {
    ...actual,
    readEditorFile: mocks.readEditorFile,
    updateEditorFileBuffer: mocks.updateEditorFileBuffer,
  };
});

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: (props: {
    entries: Array<{ path: string }>;
    loadedDirectories?: ReadonlySet<string>;
    truncatedDirectories?: ReadonlySet<string>;
    fileCount?: number | null;
    onLoadDirectory?: (path: string) => void;
    onSearchStart?: () => void;
    searchFiles?: readonly string[] | null;
    onRefresh?: () => void;
  }) => (
    <div
      data-testid="file-tree"
      data-entries={props.entries.map((entry) => entry.path).sort().join(",")}
      data-loaded={[...(props.loadedDirectories ?? [])].sort().join(",")}
      data-truncated={[...(props.truncatedDirectories ?? [])].sort().join(",")}
      data-count={String(props.fileCount)}
      data-search-files={props.searchFiles === null || props.searchFiles === undefined ? "none" : props.searchFiles.join(",")}
    >
      <button type="button" onClick={() => props.onLoadDirectory?.("/home/alwi/repo/src")}>open src</button>
      <button type="button" onClick={() => props.onSearchStart?.()}>start search</button>
      <button type="button" onClick={() => props.onRefresh?.()}>refresh</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="source-control" />,
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ onChange }: { onChange?: (value: string) => void }) => (
    <button type="button" data-testid="workbench-editor" onClick={() => onChange?.("changed")}>editor</button>
  ),
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

const cell: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [],
  activeTabId: null,
};



const dirEntries: Record<string, Array<{ path: string; kind: "file" | "directory" }>> = {
  "/home/alwi/repo": [
    { path: "/home/alwi/repo/src", kind: "directory" },
    { path: "/home/alwi/repo/README.md", kind: "file" },
  ],
  "/home/alwi/repo/src": [
    { path: "/home/alwi/repo/src/deep", kind: "directory" },
    { path: "/home/alwi/repo/src/a.ts", kind: "file" },
  ],
};

const tree = () => screen.getByTestId("file-tree");

describe("WorkbenchCell lazy tree", () => {
  beforeEach(() => {
    mocks.editorListEntriesFor.mockReset();
    mocks.editorListEntriesFor.mockResolvedValue([{ path: "/home/alwi/repo/src/deep/x/y/z.ts", kind: "file" }]);
    mocks.editorIndexFilesFor.mockReset();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: ["/home/alwi/repo/src/deep/x/y/z.ts"], truncated: false });
    mocks.editorListDirectoryFor.mockReset();
    mocks.editorListDirectoryFor.mockImplementation(async (_location: unknown, dir: string) => dirEntries[dir] ?? []);
    mocks.codespaceGitStatusFor.mockReset();
    mocks.codespaceGitStatusFor.mockResolvedValue([]);
    mocks.codespaceGitRepoSummaryFor.mockReset();
    mocks.codespaceGitRepoSummaryFor.mockResolvedValue(null);
  });

  it("reads only the root folder when the pane opens, not the whole tree", async () => {
    render(<WorkbenchCell cell={cell} />);

    await waitFor(() => expect(tree()).toHaveAttribute("data-entries", "/home/alwi/repo/README.md,/home/alwi/repo/src"));
    expect(mocks.editorListDirectoryFor).toHaveBeenCalledTimes(1);
    expect(mocks.editorListDirectoryFor).toHaveBeenCalledWith(null, "/home/alwi/repo", expect.anything());
    expect(mocks.editorListEntriesFor).not.toHaveBeenCalled();
    expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo");
    expect(tree()).toHaveAttribute("data-count", "null");
  });

  it("marks a local folder that hit the 10,000-entry listing cap (LOT2-211)", async () => {
    const big = Array.from({ length: 10_000 }, (_, i) => ({ path: `/home/alwi/repo/src/f${i}.ts`, kind: "file" as const }));
    mocks.editorListDirectoryFor.mockImplementation(async (_location: unknown, dir: string) =>
      dir === "/home/alwi/repo/src" ? big : dirEntries[dir] ?? []);
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));
    expect(tree()).toHaveAttribute("data-truncated", "");

    await user.click(screen.getByRole("button", { name: "open src" }));
    await waitFor(() => expect(tree()).toHaveAttribute("data-truncated", "/home/alwi/repo/src"));
  });

  it("adds a folder's children when the tree asks for them", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));

    await user.click(screen.getByRole("button", { name: "open src" }));

    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo,/home/alwi/repo/src"));
    expect(tree().getAttribute("data-entries")).toContain("/home/alwi/repo/src/a.ts");
  });

  it("refresh reads every loaded folder again, forced", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));
    await user.click(screen.getByRole("button", { name: "open src" }));
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo,/home/alwi/repo/src"));
    mocks.editorListDirectoryFor.mockClear();

    await user.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => expect(mocks.editorListDirectoryFor).toHaveBeenCalledTimes(2));
    for (const call of mocks.editorListDirectoryFor.mock.calls) expect(call[2]).toMatchObject({ force: true });
  });

  it("reads the Go to file index when a filter starts, so the filter searches every file", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));
    expect(tree()).toHaveAttribute("data-search-files", "none");

    await user.click(screen.getByRole("button", { name: "start search" }));

    await waitFor(() => expect(tree()).toHaveAttribute("data-search-files", "/home/alwi/repo/src/deep/x/y/z.ts"));
    expect(mocks.editorIndexFilesFor).toHaveBeenCalledTimes(1);
    // The rows stay the folders you opened; the index is only searched.
    expect(tree().getAttribute("data-entries")).not.toContain("z.ts");
    expect(mocks.editorListEntriesFor).not.toHaveBeenCalled();
  });

  it("reads the index again on refresh once a filter has read it", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));
    await user.click(screen.getByRole("button", { name: "refresh" }));
    expect(mocks.editorIndexFilesFor).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "start search" }));
    await waitFor(() => expect(mocks.editorIndexFilesFor).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(mocks.editorIndexFilesFor).toHaveBeenCalledTimes(2));
  });

  it("keeps loaded folders while the pane is inactive", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo"));
    await user.click(screen.getByRole("button", { name: "open src" }));
    await waitFor(() => expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo,/home/alwi/repo/src"));
    mocks.editorListDirectoryFor.mockClear();

    rerender(<WorkbenchCell cell={cell} enabled={false} />);
    rerender(<WorkbenchCell cell={cell} />);

    expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/repo,/home/alwi/repo/src");
    expect(mocks.editorListDirectoryFor).not.toHaveBeenCalled();
  });

  it("drops a folder listing that arrives after the pane moved to another folder", async () => {
    let finishOld: (entries: Array<{ path: string; kind: "file" | "directory" }>) => void = () => {};
    mocks.editorListDirectoryFor.mockImplementation(async (_location: unknown, dir: string) => {
      if (dir === "/home/alwi/repo") return new Promise((resolve) => { finishOld = resolve; });
      return [{ path: `${dir}/new.ts`, kind: "file" }];
    });
    const { rerender } = render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(mocks.editorListDirectoryFor).toHaveBeenCalledWith(null, "/home/alwi/repo", expect.anything()));

    rerender(<WorkbenchCell cell={{ ...cell, rootDir: "/home/alwi/other", cwd: "/home/alwi/other" }} />);
    await waitFor(() => expect(tree()).toHaveAttribute("data-entries", "/home/alwi/other/new.ts"));
    finishOld([{ path: "/home/alwi/repo/stale.ts", kind: "file" }]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tree()).toHaveAttribute("data-entries", "/home/alwi/other/new.ts");
    expect(tree()).toHaveAttribute("data-loaded", "/home/alwi/other");
  });
});
