import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkbenchCell } from "@/modules/codespace/components/WorkbenchCell";
import type { WorkbenchCellData } from "@/modules/codespace/components/types";
import type { SourceControlPanel } from "@/modules/codespace/components/workbench/SourceControlPanel";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { clearEditorFileBuffer, getEditorFileBuffer, readEditorFile, updateEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  codespaceGitStatusFor: vi.fn(),
  codespaceGitAiSuggestCommitFor: vi.fn(),
  codespaceGitDiffFileFor: vi.fn(),
  codespaceGitDiffFileContentFor: vi.fn(),
  codespaceGitDiscardFileFor: vi.fn(),
  codespaceGitPushFor: vi.fn(),
  codespaceGitCommitFor: vi.fn(),
  codespaceGitDiscardAllChangesFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn(),
  refreshRepo: vi.fn(),
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
  editorWriteFileFor: vi.fn(),
  editorCreateDirectoryFor: vi.fn(),
  editorCreateFileFor: vi.fn(),
  editorDeleteEntryFor: vi.fn(),
  codespaceGitAiSuggestCommitFor: io.codespaceGitAiSuggestCommitFor,
  codespaceGitCommitFor: io.codespaceGitCommitFor,
  codespaceGitDiffFileFor: io.codespaceGitDiffFileFor,
  codespaceGitDiffFileContentFor: io.codespaceGitDiffFileContentFor,
  codespaceGitDiscardAllChangesFor: io.codespaceGitDiscardAllChangesFor,
  codespaceGitDiscardFileFor: io.codespaceGitDiscardFileFor,
  codespaceGitPushFor: io.codespaceGitPushFor,
  codespaceGitRepoSummaryFor: io.codespaceGitRepoSummaryFor,
  codespaceGitStageAllFor: vi.fn(),
  codespaceGitStageFileFor: vi.fn(),
  codespaceGitStatusFor: io.codespaceGitStatusFor,
  codespaceGitUnstageAllFor: vi.fn(),
  codespaceGitUnstageFileFor: vi.fn(),
}));

vi.mock("@/modules/codespace/hooks/useMultiRepoGit", () => ({
  useMultiRepoGit: () => ({ repos: new Map(), loading: false, totalChanges: 0, refreshAll: vi.fn(), refreshRepo: io.refreshRepo }),
}));

vi.mock("@/modules/codespace/components/workbench/FileTree", () => ({
  FileTree: () => <div data-testid="file-tree" />,
}));

type PanelProps = Extract<ComponentProps<typeof SourceControlPanel>, { repos: unknown }>;
const panel = vi.hoisted(() => ({ props: null as unknown as PanelProps }));
vi.mock("@/modules/codespace/components/workbench/SourceControlPanel", () => ({
  SourceControlPanel: (props: PanelProps) => {
    panel.props = props;
    return <div data-testid="source-control" />;
  },
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ filePath, content, onChange }: { filePath: string | null; content: string; onChange?: (value: string) => void }) => (
    <button type="button" data-testid="workbench-editor" onClick={() => onChange?.("typed")}>{filePath}: {content}</button>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: ({ modifiedContent }: { modifiedContent: string }) => <div data-testid="diff-preview">{modifiedContent}</div>,
}));

const SSH: CodeSpaceStoredWorkspaceLocation = { kind: "ssh", host: "box", user: "alwi", port: 22, remoteCwd: "/srv/repo" };
const A = "/srv/repo/a.ts";

const cell: WorkbenchCellData = {
  id: "workbench-source",
  cwd: "/srv/repo",
  type: "workbench",
  rootDir: "/srv/repo",
  tabs: [{ id: `file:${A}`, kind: "file", filePath: A }],
  activeTabId: `file:${A}`,
};

async function renderSource(location: CodeSpaceStoredWorkspaceLocation | null = SSH) {
  const user = userEvent.setup();
  render(<WorkbenchCell cell={cell} location={location} />);
  await screen.findByTestId("workbench-editor");
  await user.click(screen.getByRole("button", { name: /^Source/ }));
  await screen.findByTestId("source-control");
  return user;
}

describe("WorkbenchCell Source (Editor Revamp 15)", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    io.editorReadFileFor.mockReset().mockResolvedValue({ content: "on disk", mtime: 1, sizeBytes: 7, binary: false });
    io.codespaceGitStatusFor.mockReset().mockResolvedValue([{ path: A, relativePath: "a.ts", staged: "modified", unstaged: "modified" }]);
    io.codespaceGitAiSuggestCommitFor.mockReset().mockResolvedValue("feat: from claude");
    io.codespaceGitDiffFileFor.mockReset().mockResolvedValue("--- a\n+++ b\n+x");
    io.codespaceGitDiffFileContentFor.mockReset().mockResolvedValue({ original: "", modified: "remote text", originalPath: "o", modifiedPath: "m" });
    io.codespaceGitDiscardFileFor.mockReset().mockResolvedValue(undefined);
    io.codespaceGitPushFor.mockReset().mockResolvedValue(undefined);
    io.codespaceGitCommitFor.mockReset().mockResolvedValue(undefined);
    io.codespaceGitDiscardAllChangesFor.mockReset().mockResolvedValue(undefined);
    io.codespaceGitRepoSummaryFor.mockReset().mockResolvedValue(null);
    io.refreshRepo.mockReset().mockResolvedValue(undefined);
  });

  it("keeps Source mounted while Files shows, so a running action still lands", async () => {
    const user = await renderSource();
    await user.click(screen.getByRole("button", { name: /^Files/ }));
    expect(screen.getByTestId("source-control")).toBeInTheDocument();
    expect(screen.getByTestId("file-tree")).toBeInTheDocument();
  });

  it("a diff opened from another repo is read in that repo", async () => {
    await renderSource();
    act(() => panel.props.onViewDiff("/srv/repo/packages/lib", "/srv/repo/packages/lib/x.ts", "unstaged"));
    await screen.findByTestId("diff-preview");
    // The diff is read after the preview mounts: on a busy machine the check ran first (LOT2-113).
    await waitFor(() =>
      expect(io.codespaceGitDiffFileFor).toHaveBeenCalledWith(SSH, "/srv/repo/packages/lib/x.ts", "unstaged", { repoRoot: "/srv/repo/packages/lib" }),
    );
  });

  it("a commit that landed stays landed when the refresh after it fails", async () => {
    await renderSource();
    io.refreshRepo.mockRejectedValue(new Error("ssh dropped"));
    let result: unknown;
    await act(async () => { result = await panel.props.onCommit("/srv/repo", "fix: x"); });
    expect(result).toBe(true);
  });

  it("Discard all in one repo leaves unsaved edits in a repo whose path starts the same", async () => {
    await renderSource();
    const sibling = "/srv/repo2/b.ts";
    await readEditorFile(sibling, { location: SSH, rootDir: "/srv/repo2" });
    updateEditorFileBuffer(sibling, "unsaved in repo2");
    expect(getEditorFileBuffer(sibling)?.dirty).toBe(true);
    await act(async () => { await panel.props.onDiscardAllChanges("/srv/repo"); });
    expect(getEditorFileBuffer(sibling)?.dirty).toBe(true);
    clearEditorFileBuffer(sibling);
  });

  it("AI suggest runs against the SSH workspace and hands the message back", async () => {
    await renderSource();
    let message: unknown;
    await act(async () => { message = await panel.props.onAiSuggestCommit("/srv/repo"); });
    expect(message).toBe("feat: from claude");
    expect(io.codespaceGitAiSuggestCommitFor).toHaveBeenCalledWith(SSH, { repoRoot: "/srv/repo" });
  });

  it("an AI suggest error is shown, and no message comes back", async () => {
    io.codespaceGitAiSuggestCommitFor.mockRejectedValue(new Error("No staged changes"));
    await renderSource();
    let message: unknown = "unset";
    await act(async () => { message = await panel.props.onAiSuggestCommit("/srv/repo"); });
    expect(message).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("No staged changes");
  });

  it("a diff in an SSH workspace is read over SSH", async () => {
    await renderSource();
    act(() => panel.props.onViewDiff("/srv/repo", A, "staged"));
    expect(await screen.findByTestId("diff-preview")).toHaveTextContent("remote text");
    expect(io.codespaceGitDiffFileFor).toHaveBeenCalledWith(SSH, A, "staged", { repoRoot: "/srv/repo" });
    expect(io.codespaceGitDiffFileContentFor).toHaveBeenCalledWith(SSH, A, "staged", { repoRoot: "/srv/repo" });
  });

  it("discarding one file drops its unsaved edits and shows the file from disk", async () => {
    const user = await renderSource();
    await user.click(screen.getByRole("button", { name: /^Files/ }));
    await user.click(screen.getByTestId("workbench-editor"));
    expect(getEditorFileBuffer(A)?.dirty).toBe(true);
    await user.click(screen.getByRole("button", { name: /^Source/ }));

    io.editorReadFileFor.mockResolvedValue({ content: "restored", mtime: 2, sizeBytes: 8, binary: false });
    await act(async () => { await panel.props.onDiscardFile("/srv/repo", A); });
    expect(io.codespaceGitDiscardFileFor).toHaveBeenCalledWith(SSH, A, { repoRoot: "/srv/repo" });
    expect(getEditorFileBuffer(A)?.dirty ?? false).toBe(false);
    expect(screen.queryByLabelText("Unsaved changes")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveTextContent("restored"));
  });

  it("the status bar shows the running git action", async () => {
    await renderSource();
    act(() => panel.props.onActivityChange?.("Pushing…"));
    expect(screen.getByRole("status")).toHaveTextContent("Pushing…");
    act(() => panel.props.onActivityChange?.(null));
    expect(screen.getByRole("status")).not.toHaveTextContent("Pushing…");
  });
});
