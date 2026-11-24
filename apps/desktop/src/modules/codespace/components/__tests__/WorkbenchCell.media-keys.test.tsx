import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";

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
// The editor reports the cursor through `onStatusChange`; the test moves it by hand.
const editorStatus = vi.hoisted(() => ({ report: null as null | ((status: unknown) => void) }));
vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ wordWrap, fontSize, onStatusChange }: { wordWrap?: boolean; fontSize?: number; onStatusChange?: (status: unknown) => void }) => {
    editorStatus.report = onStatusChange ?? null;
    return <div data-testid="workbench-editor" data-wrap={String(Boolean(wordWrap))} data-font={String(fontSize)} />;
  },
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchTabBar", () => ({
  WorkbenchTabBar: ({ tabs, onSelectTab }: { tabs: { id: string; filePath?: string }[]; onSelectTab: (id: string) => void }) => (
    <div data-testid="workbench-tabs">
      {tabs.map((tab) => <button key={tab.id} type="button" onClick={() => onSelectTab(tab.id)}>{`tab ${tab.filePath?.split("/").pop()}`}</button>)}
    </div>
  ),
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchMediaPreview", () => ({
  WorkbenchMediaPreview: ({ fileName }: { fileName: string }) => <div data-testid="media-preview">{fileName}</div>,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchBrowserTab", () => ({
  WorkbenchBrowserTab: () => <div data-testid="workbench-browser" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: () => <div data-testid="workbench-diff" />,
}));

const images: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [
    { id: "t1", kind: "file", filePath: "/home/alwi/repo/docs/a.png" },
    { id: "t2", kind: "file", filePath: "/home/alwi/repo/docs/b.png" },
  ],
  activeTabId: "t1",
};

function Harness() {
  const [cell, setCell] = useState(images);
  return <WorkbenchCell cell={cell} onCellChange={(update) => setCell(update)} />;
}

// The breadcrumb and the media preview are siblings keyed by the file. With the same key React
// lost track of them and every tab switch left another breadcrumb row behind (2026-10-15).
describe("WorkbenchCell with an image open", () => {
  const errors: string[] = [];
  beforeEach(() => {
    errors.length = 0;
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    window.localStorage.clear();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: [], truncated: false });
    mocks.readEditorFile.mockImplementation(async (path: string) => ({
      path, content: "", savedContent: "", mtime: 1, sizeBytes: 10, binary: true, dirty: false,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps one breadcrumb and one preview across tab switches", async () => {
    render(<Harness />);
    expect(await screen.findByTestId("media-preview")).toHaveTextContent("a.png");
    for (const name of ["b.png", "a.png", "b.png", "a.png"]) {
      fireEvent.click(screen.getByRole("button", { name: `tab ${name}` }));
      expect(await screen.findByTestId("media-preview")).toHaveTextContent(name);
    }
    expect(screen.getAllByRole("navigation", { name: "File path" })).toHaveLength(1);
    expect(screen.getAllByTestId("media-preview")).toHaveLength(1);
    expect(errors.filter((line) => line.includes("same key"))).toEqual([]);
  });
});
