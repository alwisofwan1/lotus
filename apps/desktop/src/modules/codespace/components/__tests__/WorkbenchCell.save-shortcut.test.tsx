import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

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

const A = "/repo/a.ts";
const B = "/other/b.ts";

const paneA: WorkbenchCellData = {
  id: "save-a", cwd: "/repo", type: "workbench", rootDir: "/repo",
  tabs: [{ id: "tab-a", kind: "file", filePath: A }], activeTabId: "tab-a",
};
const paneB: WorkbenchCellData = {
  id: "save-b", cwd: "/other", type: "workbench", rootDir: "/other",
  tabs: [{ id: "tab-b", kind: "file", filePath: B }], activeTabId: "tab-b",
};

function renderTwoPanes() {
  render(
    <>
      <div data-testid="pane-a"><WorkbenchCell cell={paneA} /></div>
      <div data-testid="pane-b"><WorkbenchCell cell={paneB} /></div>
      <textarea aria-label="terminal" />
    </>,
  );
}

const pressSave = () => fireEvent.keyDown(window, { key: "s", metaKey: true });

describe("WorkbenchCell ⌘S", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    clearEditorFileBuffer(B);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "x", mtime: 1, sizeBytes: 1, binary: false }));
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("saves only the pane that has focus", async () => {
    renderTwoPanes();
    await screen.findByRole("button", { name: `editor ${A}` });
    await screen.findByRole("button", { name: `editor ${B}` });

    screen.getByRole("button", { name: `editor ${B}` }).focus();
    const notPrevented = pressSave();

    expect(notPrevented).toBe(false);
    await waitFor(() => expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1));
    expect(io.editorWriteFileFor).toHaveBeenCalledWith(null, "b.ts", "x", 1, expect.anything());
  });

  it("does nothing, and leaves the key alone, when focus is outside every Editor pane", async () => {
    renderTwoPanes();
    await screen.findByRole("button", { name: `editor ${A}` });

    screen.getByRole("textbox", { name: "terminal" }).focus();
    const notPrevented = pressSave();

    expect(notPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
  });
});
