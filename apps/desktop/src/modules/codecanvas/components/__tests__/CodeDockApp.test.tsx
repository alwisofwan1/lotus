import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEditorFileBuffer, getEditorFileBuffer } from "@/modules/codespace/services/editor-file-store";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
  editorIndexFilesFor: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  getSettings: vi.fn().mockResolvedValue({}),
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
  editorIndexFilesFor: io.editorIndexFilesFor,
  codespaceGitDiffFileContentFor: vi.fn(),
  codespaceGitRepoSummaryFor: vi.fn().mockResolvedValue(null),
  codespaceGitStatusFor: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ content, filePath, onChange, onSave }: { content: string; filePath: string | null; onChange?: (value: string) => void; onSave?: () => void }) => (
    <div data-testid="workbench-editor" data-file={filePath}>
      <span data-testid="editor-content">{content}</span>
      <button type="button" onClick={() => onChange?.(`${content}+`)}>type</button>
      <button type="button" onClick={() => onSave?.()}>save</button>
    </div>
  ),
}));

vi.mock("@/modules/codespace/components/workbench/WorkbenchDiffPreview", () => ({
  WorkbenchDiffPreview: ({ originalContent, modifiedContent }: { originalContent: string; modifiedContent: string }) => (
    <div data-testid="diff-preview">{`${originalContent} → ${modifiedContent}`}</div>
  ),
}));

const { CodeDockApp } = await import("../CodeDockApp");
const { agentStateRegistry } = await import("../../services/narration/agent-state-registry");
const { createAgentStatusRegistry } = await import("../../services/agent-status-registry");

const A = "/repo/src/a.ts";
const B = "/repo/src/b.ts";
const disk = (content: string, mtime: number) => ({ content, mtime, sizeBytes: content.length, binary: false });

describe("CodeDockApp (LOT2-229)", () => {
  beforeEach(() => {
    for (const path of [A, B]) clearEditorFileBuffer(path);
    io.editorReadFileFor.mockReset().mockImplementation(async (_location: unknown, relative: string) => disk(relative === "src/a.ts" ? "v1" : "bee", 10));
    io.editorWriteFileFor.mockReset().mockResolvedValue({ mtime: 30 });
    io.editorIndexFilesFor.mockReset().mockResolvedValue({ files: [A, B], truncated: false });
  });
  afterEach(() => {
    agentStateRegistry.clear("pane-skye");
    vi.restoreAllMocks();
  });

  it("says there is nothing to edit when the board has no folder", () => {
    render(<CodeDockApp rootDir={null} />);
    expect(screen.getByText(/Open a project/)).toBeInTheDocument();
  });

  it("opens the file an open-in-Code request names, and says where it came from", async () => {
    render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-file", A);
    expect(screen.getByRole("tab", { name: "a.ts" })).toBeInTheDocument();
    expect(screen.getByText(/Opened from a\.ts on the board/)).toBeInTheDocument();
  });

  it("lists what this board's agents changed, with the agent's name, and a click opens the file", async () => {
    const registry = createAgentStatusRegistry();
    registry.publish({ id: "pane-skye", name: "Skye", status: "working" } as never);
    agentStateRegistry.observe({ kind: "tool_post", tag: "tool_post_success", paneId: "pane-skye", ts: 5, filePath: B, toolName: "Edit" } as never);
    const user = userEvent.setup();
    render(<CodeDockApp rootDir="/repo" registry={registry} />);
    const list = screen.getByRole("complementary", { name: "Changed by this board" });
    const row = await within(list).findByRole("button", { name: /b\.ts/ });
    expect(row).toHaveTextContent("Skye · src/b.ts");
    await user.click(row);
    await waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-file", B));
  });

  it("⌘P finds any file under the board's folder", async () => {
    const user = userEvent.setup();
    render(<CodeDockApp rootDir="/repo" />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Go to file/ }), { key: "p", metaKey: true });
    const box = await screen.findByPlaceholderText("Go to file…");
    expect(io.editorIndexFilesFor).toHaveBeenCalledWith(null, "/repo");
    await user.type(box, "b.ts");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("workbench-editor")).toHaveAttribute("data-file", B));
  });

  it("Show on board hands the open file to the board", async () => {
    const onShowOnBoard = vi.fn();
    const user = userEvent.setup();
    render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} onShowOnBoard={onShowOnBoard} />);
    await screen.findByTestId("workbench-editor");
    await user.click(screen.getByRole("button", { name: "Show on board" }));
    expect(onShowOnBoard).toHaveBeenCalledWith(A);
  });

  it("an agent writing a file with unsaved edits raises the banner; Compare shows disk against the edits", async () => {
    const user = userEvent.setup();
    render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    await user.click(screen.getByRole("button", { name: "type" }));
    io.editorReadFileFor.mockResolvedValue(disk("theirs", 20));
    io.editorWriteFileFor.mockRejectedValueOnce("File has changed on disk");
    await user.click(screen.getByRole("button", { name: "save" }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("a.ts changed on disk");
    await user.click(within(banner).getByRole("button", { name: "Compare" }));
    await waitFor(() => expect(screen.getByTestId("diff-preview")).toHaveTextContent("theirs → v1+"));
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1+", dirty: true });
  });

  it("a request made while Code was closed is still there when it opens, and tabs come back after the Dock closes", async () => {
    const first = render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await screen.findByRole("tab", { name: "a.ts" });
    first.unmount();
    render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    expect(await screen.findByRole("tab", { name: "a.ts" })).toBeInTheDocument();
    await act(async () => {});
  });

  it("reopening the Dock shows what is on disk now, not the buffer from before it closed", async () => {
    const first = render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    first.unmount();
    io.editorReadFileFor.mockImplementation(async () => disk("v2", 40));
    render(<CodeDockApp rootDir="/repo" />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v2"));
  });

  it("a reopened tab with unsaved edits gets the conflict banner when the file moved meanwhile", async () => {
    const user = userEvent.setup();
    const first = render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("editor-content")).toHaveTextContent("v1"));
    await user.click(screen.getByRole("button", { name: "type" }));
    first.unmount();
    io.editorReadFileFor.mockImplementation(async () => disk("theirs", 40));
    render(<CodeDockApp rootDir="/repo" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("a.ts changed on disk");
    expect(getEditorFileBuffer(A)).toMatchObject({ content: "v1+", dirty: true });
  });

  it("switching the board's project starts that project's tabs, not the old project's", async () => {
    const view = render(<CodeDockApp rootDir="/repo" request={{ path: A, seq: 1 }} />);
    await screen.findByRole("tab", { name: "a.ts" });
    view.rerender(<CodeDockApp rootDir="/other" />);
    await act(async () => {});
    expect(screen.queryByRole("tab", { name: "a.ts" })).not.toBeInTheDocument();
    view.rerender(<CodeDockApp rootDir="/repo" />);
    expect(await screen.findByRole("tab", { name: "a.ts" })).toBeInTheDocument();
  });
});
