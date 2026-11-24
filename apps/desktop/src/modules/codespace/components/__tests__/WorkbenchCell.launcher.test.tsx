import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { listRecentFiles, recordRecentFile } from "@/modules/codespace/services/recent-files";

const mocks = vi.hoisted(() => ({
  editorIndexFilesFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  readEditorFile: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  codespaceGitAiSuggestCommit: vi.fn(),
  codespaceGitDiffFile: vi.fn(),
  codespaceGitDiffFileContent: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: vi.fn().mockResolvedValue([]),
  editorIndexFilesFor: mocks.editorIndexFilesFor,
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: mocks.editorDeleteEntryFor,
  editorRenameEntryFor: vi.fn(),
  editorRevealEntry: vi.fn(),
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

vi.mock("@/modules/codespace/services/editor-file-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/codespace/services/editor-file-store")>();
  return { ...actual, readEditorFile: mocks.readEditorFile };
});

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: (props: {
    activeFilePath: string | null;
    createRequest?: { kind: string; nonce: number } | null;
    revealActiveRequest?: number;
    onOpenFile: (path: string) => void;
    onDeleteEntry?: (relativePath: string, kind: "file" | "directory") => Promise<void>;
  }) => (
    <div
      data-testid="file-tree"
      data-active={props.activeFilePath ?? ""}
      data-create={props.createRequest ? `${props.createRequest.kind}:${props.createRequest.nonce}` : ""}
      data-reveal={String(props.revealActiveRequest ?? 0)}
    >
      <button type="button" onClick={() => props.onOpenFile("/home/alwi/repo/src/a.ts")}>open a</button>
      <button type="button" onClick={() => void props.onDeleteEntry?.("src/a.ts", "file")}>delete a</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: () => <div data-testid="source-control" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ wordWrap }: { wordWrap?: boolean }) => (
    <div data-testid="workbench-editor" data-wrap={String(Boolean(wordWrap))} />
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

const KEY = "local|/home/alwi/repo";
const empty: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [],
  activeTabId: null,
};

function Harness({ initial = empty }: { initial?: WorkbenchCellData }) {
  const [cell, setCell] = useState(initial);
  return <WorkbenchCell cell={cell} onCellChange={(update) => setCell(update)} />;
}

const tree = () => screen.getByTestId("file-tree");
const launcherRows = () => within(screen.getByRole("listbox", { name: "Recent files" })).getAllByRole("option");

describe("WorkbenchCell launcher and recent files", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.editorIndexFilesFor.mockReset();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: ["/home/alwi/repo/src/a.ts", "/home/alwi/repo/README.md"], truncated: false });
    mocks.editorDeleteEntryFor.mockReset();
    mocks.editorDeleteEntryFor.mockResolvedValue({ path: "/home/alwi/repo/src/a.ts" });
    mocks.readEditorFile.mockReset();
    mocks.readEditorFile.mockImplementation(async (path: string) => ({
      path, content: "x", savedContent: "x", mtime: 1, sizeBytes: 1, binary: false, dirty: false,
    }));
  });

  it("an empty pane is the launcher, with this workspace's recent files", () => {
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    recordRecentFile("local|/elsewhere", "/elsewhere/x.ts", 2);
    render(<Harness />);

    expect(screen.getByRole("combobox", { name: "Go to file" })).toBeInTheDocument();
    expect(launcherRows().map((row) => row.getAttribute("aria-label"))).toEqual(["README.md"]);
    // The launcher does not walk the whole repo to check them.
    expect(mocks.editorIndexFilesFor).not.toHaveBeenCalled();
  });

  it("an empty pane has no status line saying nothing is open", () => {
    render(<Harness />);
    expect(screen.queryByText("No file selected")).not.toBeInTheDocument();
  });

  it("opening a file records it first in Recent", async () => {
    const user = userEvent.setup();
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "open a" }));

    await waitFor(() => expect(listRecentFiles(KEY).map((entry) => entry.path)).toEqual([
      "/home/alwi/repo/src/a.ts",
      "/home/alwi/repo/README.md",
    ]));
    expect(screen.queryByRole("listbox", { name: "Recent files" })).not.toBeInTheDocument();
  });

  it("a recent file opens from the launcher", async () => {
    const user = userEvent.setup();
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    render(<Harness />);
    await user.click(launcherRows()[0]);
    await waitFor(() => expect(tree()).toHaveAttribute("data-active", "/home/alwi/repo/README.md"));
  });

  it("a file deleted here leaves Recent", async () => {
    const user = userEvent.setup();
    recordRecentFile(KEY, "/home/alwi/repo/src/a.ts", 2);
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "delete a" }));

    await waitFor(() => expect(launcherRows().map((row) => row.getAttribute("aria-label"))).toEqual(["README.md"]));
  });

  it("a recent file that is gone when opened leaves Recent", async () => {
    const user = userEvent.setup();
    mocks.readEditorFile.mockRejectedValue(new Error("No such file or directory (os error 2)"));
    recordRecentFile(KEY, "/home/alwi/repo/gone.ts", 1);
    render(<Harness />);

    await user.click(launcherRows()[0]);

    await waitFor(() => expect(listRecentFiles(KEY)).toEqual([]));
  });

  it("files the ⌘P index no longer has are skipped", async () => {
    const user = userEvent.setup();
    recordRecentFile(KEY, "/home/alwi/repo/deleted-elsewhere.ts", 2);
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    render(<Harness />);
    expect(launcherRows()).toHaveLength(2);

    // Typing in the launcher opens ⌘P with that text; the index it reads prunes the list.
    await user.type(screen.getByRole("combobox", { name: "Go to file" }), "r");
    // The palette opens over the launcher, whose field has the same name.
    await waitFor(() => expect(screen.getAllByRole("combobox", { name: "Go to file" })).toHaveLength(2));
    const palette = screen.getAllByRole("combobox", { name: "Go to file" }).at(-1)!;
    expect(palette).toHaveValue("r");
    fireEvent.keyDown(palette, { key: "Escape" });

    await waitFor(() => expect(launcherRows().map((row) => row.getAttribute("aria-label"))).toEqual(["README.md"]));
  });

  it("⌘P with an empty query lists recent files", async () => {
    recordRecentFile(KEY, "/home/alwi/repo/README.md", 1);
    render(<Harness />);
    const field = screen.getByRole("combobox", { name: "Go to file" });
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(screen.getAllByRole("listbox", { name: "Recent files" })).toHaveLength(2));
    const palette = screen.getAllByRole("listbox", { name: "Recent files" }).at(-1)!;
    expect(within(palette).getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["README.md"]);
  });

  it("New file asks the tree for a name field; ⌥⌘N does too", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /New file/ }));
    expect(tree()).toHaveAttribute("data-create", "file:1");

    act(() => screen.getByRole("combobox", { name: "Go to file" }).focus());
    const mac = /Mac/.test(navigator.platform);
    // With ⌥ held a Mac types "˜" for N, so the key is matched by its code.
    fireEvent.keyDown(window, { code: "KeyN", key: "˜", altKey: true, metaKey: mac, ctrlKey: !mac });
    expect(tree()).toHaveAttribute("data-create", "file:2");
  });

  it("Source and ⌃⇧G open the Source view", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: /Source/ }));
    expect(screen.getByTestId("source-control")).toBeInTheDocument();
    view.unmount();

    render(<Harness />);
    act(() => screen.getByRole("combobox", { name: "Go to file" }).focus());
    fireEvent.keyDown(window, { code: "KeyG", key: "G", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("source-control")).toBeInTheDocument();
  });
});

describe("WorkbenchCell palette commands", () => {
  const withFile: WorkbenchCellData = {
    ...empty,
    tabs: [{ id: "t1", kind: "file", filePath: "/home/alwi/repo/src/a.ts" }],
    activeTabId: "t1",
  };

  beforeEach(() => {
    window.localStorage.clear();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: ["/home/alwi/repo/src/a.ts"], truncated: false });
    mocks.readEditorFile.mockImplementation(async (path: string) => ({
      path, content: "x", savedContent: "x", mtime: 1, sizeBytes: 1, binary: false, dirty: false,
    }));
  });

  const runCommand = async (label: string) => {
    act(() => screen.getByTestId("file-tree").closest<HTMLElement>("[tabindex]")?.focus());
    const mac = /Mac/.test(navigator.platform);
    fireEvent.keyDown(window, { key: "p", metaKey: mac, ctrlKey: !mac });
    const input = await screen.findByRole("combobox", { name: "Go to file" });
    fireEvent.change(input, { target: { value: ">" } });
    fireEvent.click(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: label }));
  };

  it("> Turn word wrap on wraps the editor, and the next one turns it off", async () => {
    render(<Harness initial={withFile} />);
    await screen.findByTestId("workbench-editor");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-wrap", "false");

    await runCommand("Turn word wrap on");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-wrap", "true");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();

    await runCommand("Turn word wrap off");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-wrap", "false");
  });

  it("> Reveal in tree asks the tree to reveal the open file", async () => {
    render(<Harness initial={withFile} />);
    await runCommand("Reveal in tree");
    expect(tree()).toHaveAttribute("data-reveal", "1");
  });

  it("with no file open, only commands that make sense are offered", async () => {
    render(<Harness />);
    const field = screen.getByRole("combobox", { name: "Go to file" });
    fireEvent.change(field, { target: { value: ">" } });
    const list = await screen.findByRole("listbox", { name: "Commands" });
    expect(within(list).getAllByRole("option").map((row) => row.getAttribute("aria-label"))).toEqual(["Save all", "Find in files", "Turn language servers off"]);
  });
});
