import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import type { EditorFsChange } from "@/lib/tauri/editor-watch";
import { clearEditorFileBuffer, getEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";
import { editorBackupKey, resetEditorBackupsForTest } from "@/modules/codespace/services/editor-backups";

const io = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
  editorBackupRead: vi.fn(),
  watchEditorRoot: vi.fn(),
}));

vi.mock("@/lib/tauri/editor-watch", () => ({ watchEditorRoot: io.watchEditorRoot }));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
  getSettings: vi.fn(async () => io.settings),
  saveSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: vi.fn().mockResolvedValue([]),
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
  editorBackupRead: io.editorBackupRead,
  editorBackupWrite: vi.fn(async () => {}),
  editorBackupDelete: vi.fn(async () => {}),
  codespaceGitDiffFileFor: vi.fn().mockResolvedValue(""),
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitStatusFor: vi.fn().mockResolvedValue([]),
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
  WorkbenchEditor: ({ content, onChange, onBlur }: { content: string; onChange?: (value: string) => void; onBlur?: () => void }) => (
    <div data-testid="workbench-editor">
      <span data-testid="editor-content">{content}</span>
      <button type="button" onClick={() => onChange?.(`${content}+`)}>type</button>
      <button type="button" onClick={() => onBlur?.()}>blur</button>
    </div>
  ),
}));

const A = "/repo/src/a.ts";
const cell: WorkbenchCellData = {
  id: "workbench-autosave",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
  activeTabId: `file:${A}`,
};

const disk = (content: string, mtime: number) => ({ content, mtime, sizeBytes: content.length, binary: false });

async function renderPane(autoSave?: string) {
  io.settings = autoSave ? { codespace: { editorAutoSave: autoSave } } : {};
  const user = userEvent.setup();
  render(<WorkbenchCell cell={cell} enabled />);
  await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent(/v1|mine/));
  // The preference is read once the pane is up.
  await act(async () => {});
  return user;
}

/** Real time passes: auto save waits a second after the last key. */
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe("WorkbenchCell auto save and hot exit", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    resetEditorBackupsForTest();
    io.editorReadFileFor.mockReset().mockResolvedValue(disk("v1", 10));
    io.editorWriteFileFor.mockReset().mockImplementation(async () => ({ mtime: 11 }));
    io.editorBackupRead.mockReset().mockResolvedValue(null);
    io.watchEditorRoot.mockReset().mockReturnValue(vi.fn());
  });

  it("is off by default: typing saves nothing", async () => {
    const user = await renderPane();
    await user.click(screen.getByRole("button", { name: "type" }));
    await user.click(screen.getByRole("button", { name: "blur" }));
    await wait(1300);
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
    expect(getEditorFileBuffer(A)?.dirty).toBe(true);
  });

  it("after a delay: one save a second after the last key", async () => {
    const user = await renderPane("afterDelay");
    await user.click(screen.getByRole("button", { name: "type" }));
    await wait(500);
    await user.click(screen.getByRole("button", { name: "type" }));
    await wait(500);
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
    await waitFor(() => expect(io.editorWriteFileFor).toHaveBeenCalledOnce(), { timeout: 2000 });
    expect(io.editorWriteFileFor.mock.calls[0][2]).toBe("v1++");
    await waitFor(() => expect(getEditorFileBuffer(A)?.dirty).toBe(false));
  });

  it("on focus change: saves when the editor loses focus, not while typing", async () => {
    const user = await renderPane("onFocusChange");
    await user.click(screen.getByRole("button", { name: "type" }));
    await wait(1200);
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "blur" }));
    await waitFor(() => expect(io.editorWriteFileFor).toHaveBeenCalledOnce());
    expect(io.editorWriteFileFor.mock.calls[0][2]).toBe("v1+");
  });

  it("never auto saves over a file in a disk conflict: the banner decides", async () => {
    const user = await renderPane("onFocusChange");
    await user.click(screen.getByRole("button", { name: "type" }));
    io.editorReadFileFor.mockResolvedValue(disk("written by an agent", 20));
    const onChange = io.watchEditorRoot.mock.calls.at(-1)?.[2] as (change: EditorFsChange) => void;
    act(() => onChange({ watchId: "w", paths: [A], git: false, overflow: false }));
    expect(await screen.findByRole("alert")).toHaveTextContent("a.ts changed on disk");
    await user.click(screen.getByRole("button", { name: "blur" }));
    await wait(50);
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
  });

  it("opens a file with the unsaved edits a crash left behind, and says so", async () => {
    io.editorBackupRead.mockImplementation(async (key: string) => (
      key === editorBackupKey(A, { rootDir: "/repo" })
        ? JSON.stringify({ v: 1, path: A, content: "mine", savedContent: "v1", mtime: 3, savedAt: 0 })
        : null
    ));
    await renderPane();
    expect(screen.getByTestId("editor-content")).toHaveTextContent("mine");
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "mine", savedContent: "v1", mtime: 10, dirty: true });
    expect(screen.getByText("Restored unsaved changes to a.ts")).toBeInTheDocument();
  });

  it("brings back the edits of a tab that is open but not shown, without a click", async () => {
    const B = "/repo/src/b.ts";
    clearEditorFileBuffer(B);
    io.editorReadFileFor.mockImplementation(async (_location: unknown, relative: string) => disk(relative === "src/b.ts" ? "b" : "v1", 10));
    io.editorBackupRead.mockImplementation(async (key: string) => (
      key === editorBackupKey(B)
        ? JSON.stringify({ v: 1, path: B, content: "b + mine", savedContent: "b", mtime: 10, savedAt: 0 })
        : null
    ));
    io.settings = {};
    render(<WorkbenchCell cell={{ ...cell, tabs: [...cell.tabs, { id: `file:${B}`, kind: "file", filePath: B }] }} enabled />);
    await waitFor(() => expect(getEditorFileBuffer(B)).toMatchObject({ content: "b + mine", dirty: true }));
    expect(screen.getByTestId("editor-content")).toHaveTextContent("v1");
    expect(await screen.findByText("Restored unsaved changes to b.ts")).toBeInTheDocument();
    // A tab with no backup is not read until it is shown.
    expect(io.editorReadFileFor.mock.calls.filter(([, relative]) => relative === "src/b.ts")).toHaveLength(1);
    clearEditorFileBuffer(B);
  });
});
