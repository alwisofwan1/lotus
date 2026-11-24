import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
const B = "/repo/b.ts";

const cell: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [
    { id: "tab-a", kind: "file", filePath: A },
    { id: "tab-b", kind: "file", filePath: B },
  ],
  activeTabId: "tab-a",
};

async function renderWithEditedA() {
  const user = userEvent.setup();
  render(<WorkbenchCell cell={cell} />);
  await user.click(await screen.findByRole("button", { name: `editor ${A}` }));
  return user;
}

const tabNamed = (name: string) => screen.queryByRole("tab", { name: new RegExp(`^${name}`) });

describe("WorkbenchCell unsaved changes", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    clearEditorFileBuffer(B);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "saved", mtime: 1, sizeBytes: 5, binary: false }));
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("closes a clean tab straight away", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await screen.findByRole("button", { name: `editor ${A}` });

    await user.click(screen.getByRole("button", { name: "Close b.ts" }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(tabNamed("b.ts")).toBeNull();
  });

  it("asks before closing a tab with unsaved edits, and Cancel keeps it", async () => {
    const user = await renderWithEditedA();

    await user.click(screen.getByRole("button", { name: "Close a.ts" }));

    expect(screen.getByRole("alertdialog", { name: "Save changes to a.ts?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(tabNamed("a.ts")).not.toBeNull();
  });

  it("Don't save closes the tab without writing", async () => {
    const user = await renderWithEditedA();

    await user.click(screen.getByRole("button", { name: "Close a.ts" }));
    await user.click(screen.getByRole("button", { name: "Don't save" }));

    expect(tabNamed("a.ts")).toBeNull();
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
  });

  it("Save writes the file, then closes the tab", async () => {
    const user = await renderWithEditedA();

    await user.click(screen.getByRole("button", { name: "Close a.ts" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(tabNamed("a.ts")).toBeNull());
    expect(io.editorWriteFileFor).toHaveBeenCalledWith(null, "a.ts", `edited ${A}`, 1, expect.anything());
  });

  // A conflict is answered by the file's banner instead (WorkbenchCell.conflict.test.tsx).
  it("keeps the tab and the dialog open when saving fails", async () => {
    io.editorWriteFileFor.mockRejectedValueOnce(new Error("Permission denied"));
    const user = await renderWithEditedA();

    await user.click(screen.getByRole("button", { name: "Close a.ts" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(tabNamed("a.ts")).not.toBeNull();
  });

  it("tells the tree which files hold unsaved edits", async () => {
    await renderWithEditedA();
    expect(screen.getByTestId("file-tree")).toHaveAttribute("data-unsaved", A);
  });
});
