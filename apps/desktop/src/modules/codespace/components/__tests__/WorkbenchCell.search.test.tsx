import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";
import { resetEditorBackupsForTest } from "@/modules/codespace/services/editor-backups";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorSearchFor: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("@/lib/tauri/editor-watch", () => ({ watchEditorRoot: vi.fn(() => vi.fn()) }));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  saveSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorListEntriesFor: vi.fn().mockResolvedValue([]),
  editorListDirectoryFor: vi.fn().mockResolvedValue([]),
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: vi.fn(),
  editorBackupRead: vi.fn(async () => null),
  editorBackupWrite: vi.fn(async () => {}),
  editorBackupDelete: vi.fn(async () => {}),
  editorSearchFor: io.editorSearchFor,
  editorSearchCancel: vi.fn(async () => {}),
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
  WorkbenchEditor: ({ content, revealRange }: { content: string; revealRange?: unknown }) => {
    if (revealRange) io.reveal(revealRange);
    return <div data-testid="editor-content">{content}</div>;
  },
}));

const A = "/repo/a.ts";
const B = "/repo/src/b.ts";
const cell: WorkbenchCellData = {
  id: "workbench-search",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
  activeTabId: `file:${A}`,
};

describe("WorkbenchCell find in files", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    clearEditorFileBuffer(B);
    resetEditorBackupsForTest();
    io.reveal.mockReset();
    io.editorReadFileFor.mockReset().mockImplementation(async (_location: unknown, relative: string) => {
      const content = relative === "src/b.ts" ? "one\ntwo needle\n" : "a";
      return { content, mtime: 1, sizeBytes: content.length, binary: false };
    });
    io.editorSearchFor.mockReset().mockResolvedValue({
      files: [{ path: B, matches: [{ line: 2, column: 5, length: 6, preview: "two needle", previewStart: 4 }] }],
      matchCount: 1,
      truncated: false,
      cancelled: false,
    });
  });

  it("⇧⌘F opens the search view, and a match opens its file with the match selected", async () => {
    const user = userEvent.setup();
    render(<WorkbenchCell cell={cell} enabled />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("a"));

    screen.getByRole("button", { name: "Hide sidebar" }).focus();
    const mac = /Mac/.test(navigator.platform);
    fireEvent.keyDown(window, { code: "KeyF", key: "F", shiftKey: true, metaKey: mac, ctrlKey: !mac });
    const input = screen.getByRole("textbox", { name: "Search" });
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Search" })).toHaveAttribute("aria-pressed", "true");

    await user.type(input, "needle{Enter}");
    await user.click(await screen.findByTitle("src/b.ts:2:5"));
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("two needle"));
    await waitFor(() => expect(io.reveal).toHaveBeenCalledWith(expect.objectContaining({
      path: B,
      startLine: 2,
      endLine: 2,
      startColumn: 5,
      endColumn: 11,
    })));
  });
});
