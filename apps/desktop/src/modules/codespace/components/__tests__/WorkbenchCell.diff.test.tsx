import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import { clearEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
  codespaceGitDiffFile: vi.fn(),
  codespaceGitDiffFileContent: vi.fn(),
  codespaceGitStatusFor: vi.fn(),
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
  // The location is dropped: these tests are about the tab, not where git runs.
  codespaceGitDiffFileFor: (_location: unknown, path: string, target: string, options: { repoRoot: string }) =>
    io.codespaceGitDiffFile(options.repoRoot, path, target),
  codespaceGitDiffFileContentFor: (_location: unknown, path: string, target: string, options: { repoRoot: string }) =>
    io.codespaceGitDiffFileContent(options.repoRoot, path, target),
  codespaceGitDiscardFileFor: vi.fn(),
  codespaceGitDiscardAllChangesFor: vi.fn(),
  codespaceGitPushFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitStageAllFor: vi.fn(),
  codespaceGitStageFileFor: vi.fn(),
  codespaceGitStatusFor: io.codespaceGitStatusFor,
  codespaceGitUnstageAllFor: vi.fn(),
  codespaceGitUnstageFileFor: vi.fn(),
}));

vi.mock("@/modules/codespace/hooks/useMultiRepoGit", () => ({
  useMultiRepoGit: () => ({
    repos: new Map(),
    loading: false,
    totalChanges: 0,
    refreshAll: vi.fn(),
    refreshRepo: vi.fn(),
  }),
}));

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: () => <div data-testid="file-tree" />,
}));

vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: ({ onViewDiff }: { onViewDiff: (rootDir: string, path: string, target: "staged" | "unstaged") => void }) => (
    <div data-testid="source-control">
      <button type="button" onClick={() => onViewDiff("/repo", "/repo/src/a.ts", "unstaged")}>source a.ts</button>
      <button type="button" onClick={() => onViewDiff("/repo", "/repo/src/a.ts", "staged")}>source a.ts staged</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ filePath, onChange }: { filePath: string | null; onChange?: (value: string) => void }) => (
    <button type="button" data-testid="workbench-editor" onClick={() => onChange?.(`edited ${filePath}`)}>editor {filePath}</button>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: ({ renderSideBySide, modifiedContent, loading }: { renderSideBySide: boolean; modifiedContent: string; loading: boolean }) => (
    <div data-testid="diff-preview" data-layout={renderSideBySide ? "split" : "inline"}>{loading ? "Loading diff..." : modifiedContent}</div>
  ),
}));

/** The pane's width, as a ResizeObserver would report it. */
const observers = new Set<ResizeObserverCallback>();
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    observers.add(this.callback);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.callback);
  }
}
function resizePane(width: number) {
  act(() => {
    for (const callback of observers) {
      callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

const A = "/repo/src/a.ts";

const cell: WorkbenchCellData = {
  id: "workbench-diff",
  cwd: "/repo",
  type: "workbench",
  rootDir: "/repo",
  tabs: [{ id: "file:/repo/b.ts", kind: "file", filePath: "/repo/b.ts" }],
  activeTabId: "file:/repo/b.ts",
};

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
const selectedTab = () => screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent;

async function openDiff(button = "source a.ts", data: WorkbenchCellData = cell, beforeDiff?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>) {
  const user = userEvent.setup();
  render(<WorkbenchCell cell={data} />);
  await screen.findByTestId("workbench-editor");
  await beforeDiff?.(user);
  await user.click(screen.getByRole("button", { name: /^Source/ }));
  await user.click(screen.getByRole("button", { name: button }));
  await screen.findByTestId("diff-preview");
  return user;
}

describe("WorkbenchCell diff tab (E28, E32)", () => {
  const originalResizeObserver = global.ResizeObserver;
  beforeEach(() => {
    global.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
    observers.clear();
    for (const path of [A, "/repo/b.ts"]) clearEditorFileBuffer(path);
    io.editorReadFileFor.mockReset().mockResolvedValue({ content: "saved", mtime: 1, sizeBytes: 5, binary: false });
    io.editorWriteFileFor.mockReset().mockResolvedValue({ mtime: 2 });
    io.codespaceGitStatusFor.mockReset().mockResolvedValue([
      { path: A, relativePath: "src/a.ts", staged: "modified", unstaged: "modified" },
    ]);
    io.codespaceGitDiffFile.mockReset().mockImplementation(async (_root: string, _path: string, target: string) =>
      target === "staged" ? "--- a\n+++ b\n+s" : "--- a\n+++ b\n+one\n+two\n-three");
    io.codespaceGitDiffFileContent.mockReset().mockImplementation(async (_root: string, _path: string, target: string) => ({
      original: "old",
      modified: target === "staged" ? "staged text" : "working text",
      originalPath: "original://a",
      modifiedPath: "modified://a",
    }));
  });
  afterEach(() => {
    global.ResizeObserver = originalResizeObserver;
  });

  it("clicking a file in Source opens a closable `file · diff` tab", async () => {
    const user = await openDiff();
    expect(tabNames()).toEqual(["b.ts", "a.ts · diff"]);
    expect(selectedTab()).toBe("a.ts · diff");

    await user.click(screen.getByRole("button", { name: "Close a.ts · diff" }));
    expect(tabNames()).toEqual(["b.ts"]);
    expect(screen.queryByTestId("diff-preview")).toBeNull();
    expect(screen.getByTestId("workbench-editor")).toHaveTextContent("editor /repo/b.ts");
  });

  it("clicking the same file again reuses its diff tab", async () => {
    const user = await openDiff();
    await user.click(screen.getByRole("tab", { name: "b.ts" }));
    await user.click(screen.getByRole("button", { name: "source a.ts" }));
    expect(tabNames()).toEqual(["b.ts", "a.ts · diff"]);
    expect(selectedTab()).toBe("a.ts · diff");
  });

  it("the header shows the path, +N −M and which side is shown", async () => {
    await openDiff();
    const header = screen.getByRole("toolbar", { name: "Diff" });
    expect(within(header).getByText("src/a.ts")).toBeInTheDocument();
    await waitFor(() => expect(within(header).getByLabelText("2 added, 1 removed")).toHaveTextContent("+2−1"));
    expect(within(header).getByRole("radio", { name: "Working tree" })).toBeChecked();
    expect(screen.getByTestId("diff-preview")).toHaveTextContent("working text");
  });

  it("switches to the staged side from the header", async () => {
    const user = await openDiff();
    await user.click(screen.getByRole("radio", { name: "Staged" }));
    await waitFor(() => expect(screen.getByTestId("diff-preview")).toHaveTextContent("staged text"));
    expect(io.codespaceGitDiffFile).toHaveBeenLastCalledWith("/repo", A, "staged");
  });

  it("names the one side there is when the file has changes on one side only", async () => {
    io.codespaceGitStatusFor.mockResolvedValue([{ path: A, relativePath: "src/a.ts", staged: "modified", unstaged: null }]);
    await openDiff("source a.ts staged");
    const header = screen.getByRole("toolbar", { name: "Diff" });
    await waitFor(() => expect(within(header).queryByRole("radio", { name: "Working tree" })).toBeNull());
    expect(within(header).getByText("Staged")).toBeInTheDocument();
  });

  it("saving an edited file before its diff does not leave the tab marked unsaved", async () => {
    await openDiff("source a.ts", {
      ...cell,
      tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
      activeTabId: `file:${A}`,
    }, async (user) => {
      await user.click(screen.getByTestId("workbench-editor"));
      expect(screen.getByLabelText("Unsaved changes")).toBeInTheDocument();
    });
    expect(io.editorWriteFileFor).toHaveBeenCalled();
    expect(tabNames()).toEqual(["a.ts", "a.ts · diff"]);
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
  });

  it("keeps the diff on screen while a git refresh reads it again", async () => {
    await openDiff();
    await waitFor(() => expect(screen.getByTestId("diff-preview")).toHaveTextContent("working text"));
    let finish: (value: string) => void = () => {};
    io.codespaceGitDiffFile.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    await userEvent.setup().click(screen.getByRole("button", { name: "source a.ts" }));
    expect(screen.getByTestId("diff-preview")).toHaveTextContent("working text");
    await act(async () => finish("--- a\n+++ b\n+one"));
  });

  it("Open file activates the file's editor tab", async () => {
    const user = await openDiff();
    await user.click(screen.getByRole("button", { name: "Open file" }));
    expect(tabNames()).toEqual(["b.ts", "a.ts · diff", "a.ts"]);
    expect(selectedTab()).toBe("a.ts");
    expect(await screen.findByTestId("workbench-editor")).toHaveTextContent(`editor ${A}`);
  });

  it("splits at 760px and wider, goes inline below", async () => {
    await openDiff();
    resizePane(900);
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "split");
    resizePane(759);
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "inline");
    resizePane(760);
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "split");
  });

  it("a manual choice wins over the width", async () => {
    const user = await openDiff();
    resizePane(500);
    await user.click(screen.getByRole("radio", { name: "Split" }));
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "split");
    resizePane(400);
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "split");

    await user.click(screen.getByRole("radio", { name: "Inline" }));
    resizePane(1200);
    expect(screen.getByTestId("diff-preview")).toHaveAttribute("data-layout", "inline");
  });
});
