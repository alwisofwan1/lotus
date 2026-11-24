import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer, getEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: vi.fn().mockResolvedValue([]),
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  codespaceGitAiSuggestCommitFor: vi.fn(),
  codespaceGitCommitFor: vi.fn(),
  codespaceGitDiffFileFor: vi.fn().mockResolvedValue(""),
  codespaceGitDiffFileContentFor: vi.fn(),
  codespaceGitDiscardAllChangesFor: vi.fn(),
  codespaceGitDiscardFileFor: vi.fn(),
  codespaceGitPushFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitStageAllFor: vi.fn(),
  codespaceGitStageFileFor: vi.fn(),
  codespaceGitStatusFor: vi.fn().mockResolvedValue([]),
  codespaceGitUnstageAllFor: vi.fn(),
  codespaceGitUnstageFileFor: vi.fn(),
}));

vi.mock("@/modules/codespace/hooks/useMultiRepoGit", () => ({
  useMultiRepoGit: () => ({ repos: new Map(), loading: false, totalChanges: 0, refreshAll: vi.fn(), refreshRepo: vi.fn() }),
}));

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: () => <div data-testid="file-tree" />,
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="source-control" />,
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ content, onChange, onSave }: { content: string; onChange?: (value: string) => void; onSave?: () => void }) => (
    <div data-testid="workbench-editor">
      <span data-testid="editor-content">{content}</span>
      <button type="button" onClick={() => onChange?.(`${content}+`)}>type</button>
      <button type="button" onClick={() => onSave?.()}>save</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: ({ originalContent, modifiedContent, loading }: { originalContent: string; modifiedContent: string; loading: boolean }) => (
    <div data-testid="diff-preview">{loading ? "Loading diff..." : `${originalContent} → ${modifiedContent}`}</div>
  ),
}));

const A = "/repo/a.ts";
const cell: WorkbenchCellData = {
  id: "workbench-conflict",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
  activeTabId: `file:${A}`,
};

const disk = (content: string, mtime: number) => ({ content, mtime, sizeBytes: content.length, binary: false });

/** Opens a.ts ("v1"), types once ("v1+"), then saves into a file someone else changed. */
async function conflict() {
  const user = userEvent.setup();
  render(<WorkbenchCell cell={cell} />);
  await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
  await user.click(screen.getByRole("button", { name: "type" }));
  io.editorReadFileFor.mockResolvedValue(disk("theirs", 20));
  io.editorWriteFileFor.mockRejectedValueOnce("File has changed on disk");
  await user.click(screen.getByRole("button", { name: "save" }));
  await screen.findByRole("alert");
  return user;
}

describe("WorkbenchCell disk conflict banner (Editor Revamp 16)", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    io.editorReadFileFor.mockReset().mockResolvedValue(disk("v1", 10));
    io.editorWriteFileFor.mockReset().mockResolvedValue({ mtime: 30 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a save refused because the file changed shows a banner with three actions, not a status-bar line", async () => {
    await conflict();
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("a.ts changed on disk");
    expect(within(banner).getByRole("button", { name: "Compare" })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Reload from disk" })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Overwrite" })).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("Conflict:");
  });

  it("keeps the edits, and the banner, until one of them is picked", async () => {
    const user = await conflict();
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1+", dirty: true });
    await user.click(screen.getByRole("button", { name: "type" }));
    // Monaco shows its own model; a key no longer re-renders the pane, so the buffer is the proof.
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1++", dirty: true });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("Compare opens a diff tab: disk on the left, the edits on the right", async () => {
    const user = await conflict();
    await user.click(screen.getByRole("button", { name: "Compare" }));
    expect(screen.getByRole("tab", { name: "a.ts · disk" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByTestId("diff-preview")).toHaveTextContent("theirs → v1+"));
    expect(screen.getByRole("toolbar", { name: "Diff" })).toHaveTextContent("Disk ↔ your edits");
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1+", dirty: true });
    // The choice can be made from the compare too.
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Overwrite" })).toBeInTheDocument();
  });

  it("closing the file ends its conflict: reopened, it has no banner", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = await conflict();
    await user.click(screen.getByRole("button", { name: "Close a.ts" }));
    await user.click(await screen.findByRole("button", { name: /Don.t save|Discard/ }));
    await user.click(await screen.findByRole("option", { name: /a\.ts/ }));
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("theirs"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a conflict met by Save in the close dialog keeps the tab open with its banner", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    await user.click(screen.getByRole("button", { name: "type" }));
    await user.click(screen.getByRole("button", { name: "Close a.ts" }));
    io.editorWriteFileFor.mockRejectedValueOnce({ code: "MTIME_CONFLICT", current_mtime: 20 });
    await user.click(await screen.findByRole("button", { name: /^Save/ }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("tab", { name: /^a\.ts/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("a.ts changed on disk");
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1+", dirty: true });
  });

  it("Reload asks first while there are edits, then shows the disk copy", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = await conflict();
    await user.click(screen.getByRole("button", { name: "Reload from disk" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("a.ts"));
    expect(screen.getByTestId("editor-content")).toHaveTextContent("v1+");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Reload from disk" }));
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("theirs"));
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "theirs", dirty: false, mtime: 20 });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
  });

  it("Overwrite writes the edits once without the mtime check", async () => {
    const user = await conflict();
    io.editorWriteFileFor.mockClear();
    await user.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
    expect(io.editorWriteFileFor).toHaveBeenCalledWith(null, "a.ts", "v1+", undefined, expect.anything());
    expect(getEditorFileBuffer(A)).toMatchObject({ dirty: false, mtime: 30 });

    // The next save checks again.
    await user.click(screen.getByRole("button", { name: "type" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(io.editorWriteFileFor).toHaveBeenLastCalledWith(null, "a.ts", "v1++", 30, expect.anything());
  });

  it("any other save error stays a status-bar line", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    await user.click(screen.getByRole("button", { name: "type" }));
    io.editorWriteFileFor.mockRejectedValueOnce("Permission denied");
    await user.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Permission denied"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
