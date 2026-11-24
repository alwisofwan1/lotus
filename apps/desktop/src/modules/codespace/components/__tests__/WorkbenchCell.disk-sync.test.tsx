import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type { EditorFsChange } from "@/lib/tauri/editor-watch";
import { clearEditorFileBuffer, getEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorListDirectoryFor: vi.fn(),
  codespaceGitStatusFor: vi.fn(),
  watchEditorRoot: vi.fn(),
  stopWatching: vi.fn(),
}));

const renders = vi.hoisted(() => ({ editor: 0 }));

vi.mock("@/lib/tauri/editor-watch", () => ({ watchEditorRoot: io.watchEditorRoot }));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: io.editorListDirectoryFor,
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: vi.fn(),
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
  codespaceGitStatusFor: io.codespaceGitStatusFor,
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
  WorkbenchEditor: ({ content, onChange, tooLarge }: {
    content: string;
    onChange?: (value: string) => void;
    tooLarge?: { sizeBytes: number; onOpenAnyway: (() => void) | null } | null;
  }) => {
    renders.editor += 1;
    return (
      <div data-testid="workbench-editor">
        <span data-testid="editor-content">{content}</span>
        <button type="button" onClick={() => onChange?.(`${content}+`)}>type</button>
        {tooLarge?.onOpenAnyway ? <button type="button" onClick={tooLarge.onOpenAnyway}>Open anyway</button> : null}
      </div>
    );
  },
}));

const A = "/repo/src/a.ts";
const cell: WorkbenchCellData = {
  id: "workbench-watch",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
  activeTabId: `file:${A}`,
};

const disk = (content: string, mtime: number) => ({ content, mtime, sizeBytes: content.length, binary: false });
const batch = (paths: string[], extra: Partial<EditorFsChange> = {}): EditorFsChange => ({ watchId: "w", paths, git: false, overflow: false, ...extra });

/** The handler the pane gave the watcher. */
function emit(change: EditorFsChange) {
  const onChange = io.watchEditorRoot.mock.calls.at(-1)?.[2] as ((change: EditorFsChange) => void) | undefined;
  if (!onChange) throw new Error("the pane is not watching");
  act(() => onChange(change));
}

async function renderPane(props: { enabled?: boolean; location?: CodeSpaceStoredWorkspaceLocation | null } = {}) {
  const user = userEvent.setup();
  const view = render(<WorkbenchCell cell={cell} enabled={props.enabled ?? true} location={props.location} />);
  if (props.enabled !== false) await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
  return { user, ...view };
}

describe("WorkbenchCell follows the disk (Editor Revamp 17)", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    io.editorReadFileFor.mockReset().mockResolvedValue(disk("v1", 10));
    io.editorListDirectoryFor.mockReset().mockResolvedValue([]);
    io.codespaceGitStatusFor.mockReset().mockResolvedValue([]);
    io.stopWatching.mockReset();
    io.watchEditorRoot.mockReset().mockReturnValue(io.stopWatching);
  });

  it("watches its folder while on screen", async () => {
    await renderPane();
    expect(io.watchEditorRoot).toHaveBeenCalledWith(cell.id, "/repo", expect.any(Function));
  });

  it("a clean file takes the new text by itself, with a small notice", async () => {
    await renderPane();
    io.editorReadFileFor.mockResolvedValue(disk("written by an agent", 20));
    emit(batch([A]));
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("written by an agent"));
    expect(screen.getByText("a.ts updated on disk")).toBeInTheDocument();
    expect(getEditorFileBuffer(A)).toMatchObject({ dirty: false, mtime: 20 });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a file with edits shows the conflict banner at once, without waiting for a save", async () => {
    const { user } = await renderPane();
    await user.click(screen.getByRole("button", { name: "type" }));
    io.editorReadFileFor.mockResolvedValue(disk("written by an agent", 20));
    emit(batch([A]));
    expect(await screen.findByRole("alert")).toHaveTextContent("a.ts changed on disk");
    expect(screen.getByTestId("editor-content")).toHaveTextContent("v1+");
  });

  it("its own save coming back changes nothing", async () => {
    await renderPane();
    emit(batch([A]));
    await waitFor(() => expect(io.editorReadFileFor).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/updated on disk/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a change in a listed folder reads that folder again, and git status follows", async () => {
    await renderPane();
    await waitFor(() => expect(io.editorListDirectoryFor).toHaveBeenCalledWith(null, "/repo", expect.anything()));
    io.editorListDirectoryFor.mockClear();
    io.codespaceGitStatusFor.mockClear();
    emit(batch(["/repo/new-file.ts"]));
    await waitFor(() => expect(io.editorListDirectoryFor).toHaveBeenCalledWith(null, "/repo", expect.objectContaining({ force: true })));
    // Once, a second after the last change.
    await waitFor(() => expect(io.codespaceGitStatusFor).toHaveBeenCalled(), { timeout: 2500 });
  });

  it("stops watching when the pane goes off screen, and does not watch while off", async () => {
    const { rerender } = await renderPane();
    rerender(<WorkbenchCell cell={cell} enabled={false} />);
    expect(io.stopWatching).toHaveBeenCalled();

    io.watchEditorRoot.mockClear();
    render(<WorkbenchCell cell={{ ...cell, id: "hidden-pane" }} enabled={false} />);
    expect(io.watchEditorRoot).not.toHaveBeenCalled();
  });

  it("an SSH pane has no watcher: coming back to the window looks at every open file", async () => {
    const ssh: CodeSpaceStoredWorkspaceLocation = { kind: "ssh", host: "box", user: "u", port: 22, remoteCwd: "/repo" };
    const B = "/repo/src/b.ts";
    clearEditorFileBuffer(B);
    const user = userEvent.setup();
    render(<WorkbenchCell cell={{ ...cell, tabs: [...cell.tabs, { id: `file:${B}`, kind: "file", filePath: B }] }} location={ssh} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    await user.click(screen.getByRole("tab", { name: /b\.ts/ }));
    await user.click(screen.getByRole("tab", { name: /a\.ts/ }));
    expect(io.watchEditorRoot).not.toHaveBeenCalled();

    io.editorReadFileFor.mockResolvedValue(disk("changed on the server", 20));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("changed on the server"));
    await waitFor(() => expect(getEditorFileBuffer(B)?.content).toBe("changed on the server"));
    clearEditorFileBuffer(B);
  });
});

describe("WorkbenchCell: deleted files, large files, typing", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    io.editorReadFileFor.mockReset().mockResolvedValue(disk("v1", 10));
    io.editorListDirectoryFor.mockReset().mockResolvedValue([]);
    io.codespaceGitStatusFor.mockReset().mockResolvedValue([]);
    io.watchEditorRoot.mockReset().mockReturnValue(io.stopWatching);
  });

  it("a file deleted on disk keeps its text and is struck through until it comes back", async () => {
    await renderPane();
    io.editorReadFileFor.mockRejectedValue("No such file or directory (os error 2)");
    emit(batch([A]));
    expect(await screen.findByText("a.ts was deleted on disk. Save to put it back.")).toBeInTheDocument();
    expect(screen.getByText("(deleted on disk)").parentElement).toHaveClass("codespace-workbench-tab-deleted");
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1", deleted: true });

    io.editorReadFileFor.mockResolvedValue(disk("v1", 30));
    emit(batch([A]));
    await waitFor(() => expect(screen.queryByText("(deleted on disk)")).toBeNull());
    expect(getEditorFileBuffer(A)).toMatchObject({ deleted: false });
  });

  it("a file over the text cap offers Open anyway, which reads it with the large cap", async () => {
    io.editorReadFileFor.mockReset()
      .mockResolvedValueOnce({ content: "", mtime: 1, sizeBytes: 20_000_000, binary: true, tooLarge: true })
      .mockResolvedValueOnce(disk("a very large log", 1));
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} />);
    await user.click(await screen.findByRole("button", { name: "Open anyway" }));
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("a very large log"));
    expect(io.editorReadFileFor).toHaveBeenLastCalledWith(null, "src/a.ts", expect.objectContaining({ allowLarge: true }));
  });

  it("typing renders the pane only when the tab turns dirty, not on every key", async () => {
    const { user } = await renderPane();
    await user.click(screen.getByRole("button", { name: "type" }));
    const afterFirstKey = renders.editor;
    await user.click(screen.getByRole("button", { name: "type" }));
    await user.click(screen.getByRole("button", { name: "type" }));
    expect(renders.editor).toBe(afterFirstKey);
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1++", dirty: true });
  });
});
