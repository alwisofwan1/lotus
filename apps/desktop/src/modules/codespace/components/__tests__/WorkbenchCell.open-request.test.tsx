import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { act } from "@testing-library/react";
import { requestWorkbenchOpen } from "@/modules/codespace/services/workbench-open";
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
const B = "/repo/src/b.ts";

const cell: WorkbenchCellData = {
  id: "editor-open-1",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: "tab-a", kind: "file", filePath: A }],
  activeTabId: "tab-a",
};

describe("WorkbenchCell open requests", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    clearEditorFileBuffer(B);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "x", mtime: 1, sizeBytes: 1, binary: false }));
  });

  it("opens a file asked for before the pane mounted, at its lines", async () => {
    requestWorkbenchOpen("editor-open-new", { path: B, startLine: 10, endLine: 12 });
    render(<WorkbenchCell cell={{ ...cell, id: "editor-open-new", tabs: [], activeTabId: null }} />);

    const editor = await screen.findByText(`editor ${B}`);
    expect(editor).toHaveAttribute("data-reveal", "10-12");
    expect(screen.getByRole("tab", { name: /^b\.ts/ })).toHaveAttribute("aria-selected", "true");
  });

  it("opens a new tab in a pane that is already open", async () => {
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);

    act(() => requestWorkbenchOpen("editor-open-1", { path: B, startLine: 5, endLine: 5 }));

    expect(await screen.findByText(`editor ${B}`)).toHaveAttribute("data-reveal", "5-5");
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("reuses the tab when the file is already open, and moves to the new lines", async () => {
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);

    act(() => requestWorkbenchOpen("editor-open-1", { path: A, startLine: 40, endLine: 41 }));

    await vi.waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-reveal", "40-41"));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("opens without a highlight when the link has no lines", async () => {
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);

    act(() => requestWorkbenchOpen("editor-open-1", { path: B }));

    expect(await screen.findByText(`editor ${B}`)).toHaveAttribute("data-reveal", "");
  });

  it("asks for the reveal only once the linked file has loaded", async () => {
    let finishRead: (value: { content: string; mtime: number; sizeBytes: number; binary: boolean }) => void = () => {};
    render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);
    io.editorReadFileFor.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));

    act(() => requestWorkbenchOpen("editor-open-1", { path: B, startLine: 40, endLine: 41 }));
    expect(await screen.findByText(`editor ${B}`)).toHaveAttribute("data-reveal", "");

    await act(async () => finishRead({ content: "b", mtime: 1, sizeBytes: 1, binary: false }));
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-reveal", "40-41");
  });

  it("never reuses a reveal number after the pane is switched off and on", async () => {
    const { rerender } = render(<WorkbenchCell cell={cell} />);
    await screen.findByText(`editor ${A}`);
    act(() => requestWorkbenchOpen("editor-open-1", { path: A, startLine: 5, endLine: 5 }));
    await vi.waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-reveal", "5-5"));
    const first = Number(screen.getByTestId("workbench-editor").getAttribute("data-nonce"));

    rerender(<WorkbenchCell cell={cell} enabled={false} />);
    rerender(<WorkbenchCell cell={cell} />);
    act(() => requestWorkbenchOpen("editor-open-1", { path: A, startLine: 7, endLine: 7 }));

    await vi.waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-reveal", "7-7"));
    expect(Number(screen.getByTestId("workbench-editor").getAttribute("data-nonce"))).toBeGreaterThan(first);
  });
});
