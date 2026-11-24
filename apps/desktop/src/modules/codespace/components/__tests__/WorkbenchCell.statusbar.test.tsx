import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  WorkbenchTabBar: () => <div data-testid="workbench-tabs" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchBrowserTab", () => ({
  WorkbenchBrowserTab: () => <div data-testid="workbench-browser" />,
}));
vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: () => <div data-testid="workbench-diff" />,
}));

const withFile: WorkbenchCellData = {
  id: "workbench-1",
  cwd: "/home/alwi/repo",
  type: "workbench",
  rootDir: "/home/alwi/repo",
  tabs: [{ id: "t1", kind: "file", filePath: "/home/alwi/repo/src/app/Main.kt" }],
  activeTabId: "t1",
};

function Harness() {
  const [cell, setCell] = useState(withFile);
  return <WorkbenchCell cell={cell} onCellChange={(update) => setCell(update)} />;
}

const statusBar = () => screen.getByRole("group", { name: "Editor status" });

async function runCommand(label: string) {
  act(() => screen.getByTestId("file-tree").closest<HTMLElement>("[tabindex]")?.focus());
  const mac = /Mac/.test(navigator.platform);
  fireEvent.keyDown(window, { key: "p", metaKey: mac, ctrlKey: !mac });
  const input = await screen.findByRole("combobox", { name: "Go to file" });
  fireEvent.change(input, { target: { value: ">" } });
  fireEvent.click(within(screen.getByRole("listbox", { name: "Commands" })).getByRole("option", { name: label }));
}

describe("WorkbenchCell status bar, breadcrumb, font", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.editorIndexFilesFor.mockResolvedValue({ files: [], truncated: false });
    mocks.readEditorFile.mockImplementation(async (path: string) => ({
      path, content: "x", savedContent: "x", mtime: 1, sizeBytes: 1, binary: false, dirty: false,
    }));
  });

  it("Ln/Col follow the cursor, beside the indent, encoding and language", async () => {
    render(<Harness />);
    await screen.findByTestId("workbench-editor");
    expect(within(statusBar()).getByText("Kotlin")).toBeInTheDocument();

    act(() => editorStatus.report?.({ line: 1, column: 1, insertSpaces: true, tabSize: 4, eol: "LF" }));
    expect(within(statusBar()).getByText("Ln 1, Col 1")).toBeInTheDocument();
    expect(within(statusBar()).getByText("Spaces: 4")).toBeInTheDocument();
    expect(within(statusBar()).getByText("UTF-8")).toBeInTheDocument();

    act(() => editorStatus.report?.({ line: 42, column: 18, insertSpaces: true, tabSize: 4, eol: "LF" }));
    expect(within(statusBar()).getByText("Ln 42, Col 18")).toBeInTheDocument();
  });

  it("no pane text claims problems, and the breadcrumb is the real path", async () => {
    const { container } = render(<Harness />);
    await screen.findByTestId("workbench-editor");
    expect(container.textContent).not.toMatch(/problems/i);
    expect(container.textContent).not.toMatch(/TS Ready/);
    const crumbs = within(screen.getByRole("navigation", { name: "File path" })).getAllByRole("button");
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["src", "app", "Main.kt"]);
  });

  it("> font size commands change the code size, starting at 13px", async () => {
    render(<Harness />);
    await screen.findByTestId("workbench-editor");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-font", "13");

    await runCommand("Increase font size (13px)");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-font", "14");
    await runCommand("Decrease font size (14px)");
    await runCommand("Decrease font size (13px)");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-font", "12");
    await runCommand("Reset font size (13px)");
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-font", "13");
  });

  it("the breadcrumb's wrap button wraps the editor", async () => {
    render(<Harness />);
    await screen.findByTestId("workbench-editor");
    fireEvent.click(screen.getByRole("button", { name: "Word wrap" }));
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-wrap", "true");
  });
});
