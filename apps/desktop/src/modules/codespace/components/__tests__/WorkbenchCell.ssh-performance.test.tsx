import { readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData, WorkspaceLocation } from "@/modules/codespace/components/types";

const mocks = vi.hoisted(() => ({
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
  editorListEntriesFor: vi.fn(),
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
  FileTree: () => <div data-testid="file-tree" />,
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

const sshLocation: WorkspaceLocation = {
  kind: "ssh",
  host: "devbox-vps",
  user: "alwi",
  remoteCwd: "/home/alwi/repo",
};

describe("WorkbenchCell SSH performance", () => {
  beforeEach(() => {
    mocks.editorListDirectoryFor.mockReset();
    mocks.editorListDirectoryFor.mockResolvedValue([]);
    mocks.codespaceGitStatusFor.mockReset();
    mocks.codespaceGitStatusFor.mockResolvedValue([]);
    mocks.codespaceGitRepoSummaryFor.mockReset();
    mocks.codespaceGitRepoSummaryFor.mockResolvedValue(null);
    mocks.readEditorFile.mockReset();
    mocks.readEditorFile.mockResolvedValue({
      path: "/home/alwi/repo/README.md",
      content: "hello",
      savedContent: "hello",
      mtime: 1,
      sizeBytes: 5,
      binary: false,
      dirty: false,
    });
    mocks.updateEditorFileBuffer.mockReset();
    mocks.updateEditorFileBuffer.mockImplementation((path: string, content: string) => ({
      path,
      content,
      savedContent: "hello",
      mtime: 1,
      sizeBytes: content.length,
      binary: false,
      dirty: true,
    }));
  });

  it("does not fetch remote git status while opening the SSH Files view", async () => {
    render(<WorkbenchCell cell={cell} location={sshLocation} />);

    await waitFor(() => expect(mocks.editorListDirectoryFor).toHaveBeenCalledTimes(1));
    expect(mocks.codespaceGitStatusFor).not.toHaveBeenCalled();
    expect(mocks.codespaceGitRepoSummaryFor).not.toHaveBeenCalled();
  });

  it("fetches remote git status when the SSH Source view is opened", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} location={sshLocation} />);

    await user.click(screen.getByRole("button", { name: "Source" }));

    await waitFor(() => expect(mocks.codespaceGitStatusFor).toHaveBeenCalledTimes(1));
    expect(mocks.codespaceGitRepoSummaryFor).toHaveBeenCalledTimes(1);
  });

  it("does not list files or refresh git while disabled", async () => {
    render(<WorkbenchCell cell={cell} enabled={false} />);

    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeInTheDocument());
    expect(mocks.editorListDirectoryFor).not.toHaveBeenCalled();
    expect(mocks.codespaceGitStatusFor).not.toHaveBeenCalled();
    expect(mocks.codespaceGitRepoSummaryFor).not.toHaveBeenCalled();
  });

  it("does not call parent onCellChange from inside a setTabs functional updater", () => {
    const source = readFileSync("src/modules/codespace/components/WorkbenchCell.tsx", "utf8");

    expect(source).not.toMatch(/setTabs\(\(previous[\s\S]*?onCellChange\?\./);
  });

  it("does not read the active editor file while disabled", async () => {
    render(
      <WorkbenchCell
        cell={{
          ...cell,
          tabs: [{ id: "tab-readme", kind: "file", filePath: "/home/alwi/repo/README.md" }],
          activeTabId: "tab-readme",
        }}
        enabled={false}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeInTheDocument());
    expect(mocks.readEditorFile).not.toHaveBeenCalled();
  });
});
