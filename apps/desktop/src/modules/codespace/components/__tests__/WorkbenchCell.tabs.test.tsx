import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";
import { onEditorSplit } from "@/modules/codespace/services/workbench-open";

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
  FileTree: ({ onOpenFile }: { onOpenFile: (path: string, options: { preview: boolean }) => void }) => (
    <div data-testid="file-tree">
      <button type="button" onClick={() => onOpenFile("/repo/a.ts", { preview: false })}>tree a.ts</button>
      <button type="button" onClick={() => onOpenFile("/repo/d.ts", { preview: false })}>tree d.ts</button>
      <button type="button" onClick={() => onOpenFile("/repo/e.ts", { preview: true })}>preview e.ts</button>
      <button type="button" onClick={() => onOpenFile("/repo/f.ts", { preview: true })}>preview f.ts</button>
    </div>
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
const C = "/repo/c.ts";

const cell: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [
    { id: "tab-a", kind: "file", filePath: A },
    { id: "tab-b", kind: "file", filePath: B },
    { id: "tab-c", kind: "file", filePath: C },
  ],
  activeTabId: "tab-a",
};

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

function pressReopen() {
  const event = new KeyboardEvent("keydown", { key: "T", code: "KeyT", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

async function renderCell(data: WorkbenchCellData = cell) {
  const user = userEvent.setup();
  render(<WorkbenchCell cell={data} />);
  await screen.findByRole("button", { name: /^editor / });
  return user;
}

describe("WorkbenchCell tabs (E25–E26)", () => {
  beforeEach(() => {
    for (const path of [A, B, C, "/repo/d.ts", "/repo/e.ts", "/repo/f.ts"]) clearEditorFileBuffer(path);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "saved", mtime: 1, sizeBytes: 5, binary: false }));
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("opening a file that is already open activates its tab instead of adding one", async () => {
    const user = await renderCell({ ...cell, activeTabId: "tab-b" });
    await user.click(screen.getByRole("button", { name: "tree a.ts" }));
    expect(tabNames()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(selectedTab()).toBe("a.ts");
  });

  it("opening a new file appends one tab, and opening it again adds nothing", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "tree d.ts" }));
    await user.click(screen.getByRole("button", { name: "tree d.ts" }));
    expect(tabNames()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
    expect(selectedTab()).toBe("d.ts");
  });

  it("⌘⇧T reopens the most recently closed tab and makes it active", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "Close b.ts" }));
    await user.click(screen.getByRole("button", { name: "Close c.ts" }));
    screen.getAllByRole("tab")[0].focus();

    expect(pressReopen().defaultPrevented).toBe(true);
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "c.ts"]));
    expect(selectedTab()).toBe("c.ts");

    pressReopen();
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "c.ts", "b.ts"]));
  });

  it("⌘⇧T skips a closed file that no longer exists", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "Close b.ts" }));
    await user.click(screen.getByRole("button", { name: "Close c.ts" }));
    io.editorReadFileFor.mockImplementation(async (_location: unknown, relative: string) => {
      if (relative === "c.ts") throw new Error("No such file or directory");
      return { content: "saved", mtime: 1, sizeBytes: 5, binary: false };
    });
    screen.getAllByRole("tab")[0].focus();

    pressReopen();
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "b.ts"]));
  });

  it("⌘⇧T with nothing to reopen is left to the workspace (new Thread)", async () => {
    await renderCell();
    screen.getAllByRole("tab")[0].focus();
    expect(pressReopen().defaultPrevented).toBe(false);
  });

  it("⌘⇧T is left to the workspace when every closed file is open again", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "tree d.ts" }));
    await user.click(screen.getByRole("button", { name: "Close d.ts" }));
    await user.click(screen.getByRole("button", { name: "tree d.ts" }));
    screen.getAllByRole("tab")[0].focus();
    expect(pressReopen().defaultPrevented).toBe(false);
  });

  it("Close others keeps the clicked tab, makes it active, and asks first about unsaved edits", async () => {
    const user = await renderCell();
    await user.click(await screen.findByRole("button", { name: `editor ${A}` }));

    fireEvent.contextMenu(screen.getByRole("tab", { name: /^b\.ts/ }));
    await user.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Close others" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("a.ts");
    await user.click(within(dialog).getByRole("button", { name: "Don't save" }));

    expect(tabNames()).toEqual(["b.ts"]);
    expect(selectedTab()).toBe("b.ts");
  });

  it("Close to the right closes the tabs after the clicked one", async () => {
    const user = await renderCell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /^a\.ts/ }));
    await user.click(screen.getByRole("menuitem", { name: "Close to the right" }));
    expect(tabNames()).toEqual(["a.ts"]);
  });

  it("tabs closed together come back one by one with ⌘⇧T", async () => {
    const user = await renderCell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: /^a\.ts/ }));
    await user.click(screen.getByRole("menuitem", { name: "Close to the right" }));
    screen.getAllByRole("tab")[0].focus();

    pressReopen();
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "c.ts"]));
    pressReopen();
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "c.ts", "b.ts"]));
  });
});

describe("WorkbenchCell tabs batch (LOT2-210)", () => {
  beforeEach(() => {
    for (const path of [A, B, C, "/repo/d.ts", "/repo/e.ts", "/repo/f.ts"]) clearEditorFileBuffer(path);
    io.editorReadFileFor.mockReset();
    io.editorReadFileFor.mockImplementation(async () => ({ content: "saved", mtime: 1, sizeBytes: 5, binary: false }));
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("a preview click replaces the previous preview tab", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "preview e.ts" }));
    await user.click(screen.getByRole("button", { name: "preview f.ts" }));
    expect(tabNames()).toEqual(["a.ts", "b.ts", "c.ts", "f.ts"]);
    expect(selectedTab()).toBe("f.ts");
  });

  it("editing a preview tab keeps it, so the next preview opens beside it", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "preview e.ts" }));
    await user.click(await screen.findByRole("button", { name: "editor /repo/e.ts" }));
    await user.click(screen.getByRole("button", { name: "preview f.ts" }));
    expect(tabNames()).toEqual(["a.ts", "b.ts", "c.ts", "e.ts", "f.ts"]);
  });

  it("⌃2 jumps to the second tab and ⌃9 to the last, on a Mac", async () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      await renderCell();
      const press = (code: string) => {
        const event = new KeyboardEvent("keydown", { key: code.slice(-1), code, ctrlKey: true, bubbles: true, cancelable: true });
        screen.getByRole("button", { name: /^editor / }).dispatchEvent(event);
        return event;
      };
      screen.getByRole("button", { name: /^editor / }).focus();
      expect(press("Digit2").defaultPrevented).toBe(true);
      await waitFor(() => expect(selectedTab()).toBe("b.ts"));
      press("Digit9");
      await waitFor(() => expect(selectedTab()).toBe("c.ts"));
    } finally {
      Reflect.deleteProperty(navigator, "platform");
      if (platform) Object.defineProperty(Navigator.prototype, "platform", platform);
    }
  });

  it("Split right hands the file to the shell", async () => {
    const split = vi.fn();
    const stop = onEditorSplit({ holds: (cellId) => cellId === "workbench-1", split });
    try {
      await renderCell();
      fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Split right" }));
      expect(split).toHaveBeenCalledWith("workbench-1", B);
    } finally {
      stop();
    }
  });

  it("Split right is not offered where the shell cannot split", async () => {
    await renderCell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "b.ts" }));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Split right" })).toBeNull();
  });

  it("a replaced preview tab comes back with ⌘⇧T", async () => {
    const user = await renderCell();
    await user.click(screen.getByRole("button", { name: "preview e.ts" }));
    await user.click(screen.getByRole("button", { name: "preview f.ts" }));
    screen.getByRole("button", { name: /^editor / }).focus();
    pressReopen();
    await waitFor(() => expect(tabNames()).toEqual(["a.ts", "b.ts", "c.ts", "f.ts", "e.ts"]));
  });

  it("pinning moves the tab to the front", async () => {
    await renderCell();
    fireEvent.contextMenu(screen.getByRole("tab", { name: "c.ts" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Pin" }));
    expect(tabNames()).toEqual(["c.ts", "a.ts", "b.ts"]);
    expect(screen.getByRole("button", { name: "Unpin c.ts" })).toBeInTheDocument();
  });
});
