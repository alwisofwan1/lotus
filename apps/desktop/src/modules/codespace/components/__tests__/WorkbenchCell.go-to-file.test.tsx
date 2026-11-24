import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorIndexFilesFor: vi.fn(),
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
  editorIndexFilesFor: io.editorIndexFilesFor,
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
  WorkbenchEditor: ({ filePath, revealRange }: {
    filePath: string | null;
    revealRange?: { startLine: number; endLine: number; nonce: number } | null;
  }) => (
    <div
      data-testid="workbench-editor"
      data-reveal={revealRange ? `${revealRange.startLine}-${revealRange.endLine}` : ""}
      data-nonce={revealRange?.nonce ?? ""}
    >
      editor {filePath}
    </div>
  ),
}));

const A = "/repo/a.ts";
const DEEP = "/repo/a/b/c/d/e/f/deep-target.ts";

const cell: WorkbenchCellData = {
  id: "editor-goto-1",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: "tab-a", kind: "file", filePath: A }],
  activeTabId: "tab-a",
};

describe("WorkbenchCell Go to file", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    clearEditorFileBuffer(DEEP);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "x", mtime: 1, sizeBytes: 1, binary: false }));
    io.editorIndexFilesFor.mockReset();
    io.editorIndexFilesFor.mockResolvedValue({ files: [A, DEEP], truncated: false });
  });

  it("⌘P in the pane opens the palette, and a pick opens the file at its line", async () => {
    render(<WorkbenchCell cell={cell} />);
    const editor = await screen.findByText(`editor ${A}`);
    editor.setAttribute("tabindex", "0");
    editor.focus();

    const notPrevented = fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(notPrevented).toBe(false);
    const input = await screen.findByRole("combobox", { name: "Go to file" });
    await waitFor(() => expect(io.editorIndexFilesFor).toHaveBeenCalledWith(null, "/repo"));

    fireEvent.change(input, { target: { value: "deeptarget:12" } });
    await screen.findByRole("option", { name: /deep-target\.ts/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(`editor ${DEEP}`)).toHaveAttribute("data-reveal", "12-12");
    expect(screen.queryByRole("combobox", { name: "Go to file" })).toBeNull();
  });

  it("opens from the Go to file button too, and Escape closes it", async () => {
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);

    fireEvent.click(screen.getByRole("button", { name: /Go to file/ }));
    const input = await screen.findByRole("combobox", { name: "Go to file" });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("combobox", { name: "Go to file" })).toBeNull();
  });

  it("leaves ⌘P alone when focus is outside the pane", async () => {
    render(
      <>
        <WorkbenchCell cell={cell} />
        <textarea aria-label="terminal" />
      </>,
    );
    await screen.findByText(`editor ${A}`);
    screen.getByRole("textbox", { name: "terminal" }).focus();

    const notPrevented = fireEvent.keyDown(window, { key: "p", metaKey: true });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Go to file" })).toBeNull();
  });

  it("gives focus back to where it was when the palette closes, so ⌘P works again", async () => {
    render(<WorkbenchCell cell={cell} />);
    const editor = await screen.findByText(`editor ${A}`);
    editor.setAttribute("tabindex", "0");
    editor.focus();

    fireEvent.keyDown(window, { key: "p", metaKey: true });
    fireEvent.keyDown(await screen.findByRole("combobox", { name: "Go to file" }), { key: "Escape" });

    await waitFor(() => expect(editor).toHaveFocus());
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    expect(await screen.findByRole("combobox", { name: "Go to file" })).toBeInTheDocument();
  });

  it("leaves Ctrl+P to the editor on a Mac", async () => {
    const platform = vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    render(<WorkbenchCell cell={cell} />);
    const editor = await screen.findByText(`editor ${A}`);
    editor.setAttribute("tabindex", "0");
    editor.focus();

    const notPrevented = fireEvent.keyDown(window, { key: "p", ctrlKey: true });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Go to file" })).toBeNull();
    platform.mockRestore();
  });

  it("shows why the index failed instead of an empty project", async () => {
    io.editorIndexFilesFor.mockRejectedValueOnce(new Error("Not a directory: /repo"));
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);

    fireEvent.click(screen.getByRole("button", { name: /Go to file/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Not a directory: /repo");
  });
});
