import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";

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
  FileTree: ({ onRefresh }: { onRefresh?: () => void }) => (
    <button type="button" data-testid="file-tree" onClick={() => onRefresh?.()}>refresh files</button>
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


const fileCell: WorkbenchCellData = {
  ...cell,
  tabs: [{ id: "tab-index", kind: "file", filePath: "/home/alwi/repo/src/index.ts" }],
  activeTabId: "tab-index",
};

const markdownCell: WorkbenchCellData = {
  ...cell,
  tabs: [{ id: "tab-readme", kind: "file", filePath: "/home/alwi/repo/README.md" }],
  activeTabId: "tab-readme",
};

describe("WorkbenchCell chrome", () => {
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
  });

  it.each([
    ["no tab open", cell],
    ["a file open", fileCell],
  ])("has no disabled controls with %s", async (_label, data) => {
    const { container } = render(<WorkbenchCell cell={data} />);
    await waitFor(() => expect(mocks.editorListDirectoryFor).toHaveBeenCalled());
    expect(container.querySelectorAll("button:disabled")).toHaveLength(0);
  });

  it("has no Browser / Bridge mode strip", async () => {
    render(<WorkbenchCell cell={fileCell} />);
    await screen.findByTestId("workbench-editor");
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /bridge/i })).toBeNull();
  });

  it("drops the fake search pill, the git refresh and the fixed problems count", async () => {
    const { container } = render(<WorkbenchCell cell={fileCell} />);
    await screen.findByTestId("workbench-editor");
    expect(container.querySelector(".codespace-workbench-pathbar")).toBeNull();
    expect(screen.queryByRole("button", { name: /refresh git status/i })).toBeNull();
    expect(screen.queryByText(/problems/i)).toBeNull();
  });

  it("renders the tab strip only when a tab is open", async () => {
    const { unmount } = render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(mocks.editorListDirectoryFor).toHaveBeenCalled());
    expect(screen.queryByTestId("workbench-tabs")).toBeNull();
    unmount();

    render(<WorkbenchCell cell={fileCell} />);
    expect(await screen.findByTestId("workbench-tabs")).toBeTruthy();
  });

  it("renders no bar above the tabs when there is nothing to put in it", async () => {
    const { container } = render(<WorkbenchCell cell={fileCell} />);
    await screen.findByTestId("workbench-editor");
    expect(container.querySelector(".codespace-workbench-editorbar")).toBeNull();
  });

  it("keeps a bar for the markdown preview toggle", async () => {
    render(<WorkbenchCell cell={markdownCell} />);
    expect(await screen.findByRole("button", { name: /show editor|preview markdown/i })).toBeTruthy();
  });

  it("refreshes git status too when the tree's refresh is used", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(mocks.codespaceGitStatusFor).toHaveBeenCalled());
    const before = mocks.codespaceGitStatusFor.mock.calls.length;
    const listBefore = mocks.editorListDirectoryFor.mock.calls.length;

    await user.click(screen.getByTestId("file-tree"));

    await waitFor(() => expect(mocks.codespaceGitStatusFor.mock.calls.length).toBeGreaterThan(before));
    expect(mocks.editorListDirectoryFor.mock.calls.length).toBeGreaterThan(listBefore);
  });
});
