import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { readEditorPreferences } from "@/modules/codespace/services/editor-preferences";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";

const mocks = vi.hoisted(() => ({
  editorIndexFilesFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  readEditorFile: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock("@/modules/codespace/hooks/useEditorPreferences", () => ({
  useEditorPreferences: () => [readEditorPreferences(null), mocks.updatePreferences],
}));

vi.mock("@/modules/codespace/hooks/useLspStatus", () => ({
  useLspStatus: (path: string | null) => ({
    status: path ? { kind: "untrusted", label: "TypeScript" } : null,
    problems: null,
  }),
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

const empty: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [],
  activeTabId: null,
};

function Harness() {
  const [cell, setCell] = useState(empty);
  return <WorkbenchCell cell={cell} onCellChange={(update) => setCell(update)} />;
}

describe("WorkbenchCell folder trust", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.updatePreferences.mockReset();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: [], truncated: false });
    mocks.readEditorFile.mockImplementation(async (path: string) => ({
      path, content: "x", savedContent: "x", mtime: 1, sizeBytes: 1, binary: false, dirty: false,
    }));
  });

  it("asks before a language server may run the folder's code, and remembers the answer", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("region", { name: "Folder trust" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "open a" }));
    const banner = await screen.findByRole("region", { name: "Folder trust" });
    expect(banner).toHaveTextContent("Trust repo?");

    await user.click(screen.getByRole("button", { name: "Trust folder" }));
    expect(mocks.updatePreferences).toHaveBeenCalledWith({ trustedFolders: ["local:/home/alwi/repo"] });
  });

  it("Not now hides the question; the status bar brings it back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "open a" }));
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("region", { name: "Folder trust" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /TypeScript off/ }));
    expect(screen.getByRole("region", { name: "Folder trust" })).toBeInTheDocument();
    expect(mocks.updatePreferences).not.toHaveBeenCalled();
  });
});
