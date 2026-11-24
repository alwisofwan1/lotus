import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer, releaseEditorFileHolder } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
  codespaceGitAiSuggestCommit: vi.fn(),
  codespaceGitDiffFile: vi.fn(),
  codespaceGitDiffFileContent: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: vi.fn().mockResolvedValue([]),
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
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

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: ({ unsavedPaths }: { unsavedPaths?: readonly string[] }) => (
    <div data-testid="file-tree" data-unsaved={(unsavedPaths ?? []).join(",")} />
  ),
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="source-control" />,
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ filePath, onChange }: { filePath: string | null; onChange?: (value: string) => void }) => (
    <button type="button" data-testid="workbench-editor" onClick={() => onChange?.(`edited ${filePath}`)}>
      editor {filePath}
    </button>
  ),
}));

const SHARED = "/repo/shared.ts";

const pane = (id: string): WorkbenchCellData => ({
  id, cwd: "/repo", type: "workbench", rootDir: "/repo",
  tabs: [{ id: `tab-${id}`, kind: "file", filePath: SHARED }], activeTabId: `tab-${id}`,
});

describe("WorkbenchCell: two panes on one file", () => {
  beforeEach(() => {
    releaseEditorFileHolder("shared-a");
    releaseEditorFileHolder("shared-b");
    clearEditorFileBuffer(SHARED);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "x", mtime: 1, sizeBytes: 1, binary: false }));
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("closing the file in one pane keeps the other pane's unsaved edits, and ⌘S saves them", async () => {
    render(
      <>
        <div data-testid="pane-a"><WorkbenchCell cell={pane("shared-a")} /></div>
        <div data-testid="pane-b"><WorkbenchCell cell={pane("shared-b")} /></div>
      </>,
    );
    const paneA = within(screen.getByTestId("pane-a"));
    const paneB = within(screen.getByTestId("pane-b"));
    await paneA.findByRole("button", { name: `editor ${SHARED}` });
    const editorB = await paneB.findByRole("button", { name: `editor ${SHARED}` });

    fireEvent.click(editorB); // types "edited /repo/shared.ts" in pane B
    fireEvent.click(paneA.getByRole("button", { name: "Close shared.ts" }));
    await waitFor(() => expect(paneA.queryByRole("button", { name: `editor ${SHARED}` })).toBeNull());

    editorB.focus();
    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(() => expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1));
    expect(io.editorWriteFileFor).toHaveBeenCalledWith(null, "shared.ts", `edited ${SHARED}`, 1, expect.anything());
  });
});
