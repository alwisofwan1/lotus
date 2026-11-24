import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  editorReadFileFor: vi.fn(),
  editorWriteFileFor: vi.fn(),
}));

vi.mock("@/lib/tauri/codespace", () => ({
  editorReadFileFor: io.editorReadFileFor,
  editorWriteFileFor: io.editorWriteFileFor,
}));

vi.mock("@/lib/tauri-api", () => ({
  editorReadFile: vi.fn(),
  editorWriteFile: vi.fn(),
}));

import { usePaneCloseGuard } from "@/modules/workspace-shell/hooks/usePaneCloseGuard";
import {
  clearEditorFileBuffer,
  readEditorFile,
  updateEditorFileBuffer,
} from "@/modules/codespace/services/editor-file-store";
import type { Workspace } from "@/modules/codespace/components/types";

const A = "/repo/a.ts";

const workspaces = [{
  id: "ws-1",
  cells: [
    { id: "editor-1", type: "workbench", cwd: "/repo", rootDir: "/repo", tabs: [{ id: "t", kind: "file", filePath: A }], activeTabId: "t" },
    { id: "term-1", type: "terminal", cwd: "/repo" },
  ],
}] as unknown as Workspace[];

async function editA() {
  io.editorReadFileFor.mockResolvedValueOnce({ content: "saved", mtime: 1, sizeBytes: 5, binary: false });
  await readEditorFile(A, { location: null, rootDir: "/repo" });
  updateEditorFileBuffer(A, "edited");
}

function Harness({ removePane }: { removePane: (ws: string, cell: string) => void }) {
  const guard = usePaneCloseGuard({ workspaces, removePane });
  return (
    <>
      <button type="button" onClick={() => guard.requestClosePane("ws-1", "editor-1")}>close editor</button>
      {guard.dialog}
    </>
  );
}

describe("usePaneCloseGuard", () => {
  beforeEach(() => {
    clearEditorFileBuffer(A);
    io.editorReadFileFor.mockReset();
    io.editorWriteFileFor.mockReset();
    io.editorWriteFileFor.mockResolvedValue({ mtime: 2 });
  });

  it("closes a pane with nothing unsaved at once", () => {
    const removePane = vi.fn();
    const onClosed = vi.fn();
    const { result } = renderHook(() => usePaneCloseGuard({ workspaces, removePane }));

    act(() => result.current.requestClosePane("ws-1", "editor-1", onClosed));
    act(() => result.current.requestClosePane("ws-1", "term-1"));

    expect(removePane).toHaveBeenNthCalledWith(1, "ws-1", "editor-1");
    expect(removePane).toHaveBeenNthCalledWith(2, "ws-1", "term-1");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(result.current.dialog).toBeNull();
  });

  it("asks first when an Editor pane holds unsaved edits; Cancel keeps it", async () => {
    await editA();
    const removePane = vi.fn();
    const user = userEvent.setup();
    render(<Harness removePane={removePane} />);

    await user.click(screen.getByRole("button", { name: "close editor" }));

    expect(screen.getByRole("alertdialog", { name: "Save changes to a.ts?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removePane).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("Don't save closes without writing", async () => {
    await editA();
    const removePane = vi.fn();
    const user = userEvent.setup();
    render(<Harness removePane={removePane} />);

    await user.click(screen.getByRole("button", { name: "close editor" }));
    await user.click(screen.getByRole("button", { name: "Don't save" }));

    expect(removePane).toHaveBeenCalledWith("ws-1", "editor-1");
    expect(io.editorWriteFileFor).not.toHaveBeenCalled();
  });

  it("Save writes, then closes; a failed save keeps the pane", async () => {
    await editA();
    const removePane = vi.fn();
    const user = userEvent.setup();
    render(<Harness removePane={removePane} />);

    io.editorWriteFileFor.mockRejectedValueOnce(new Error("File has changed on disk"));
    await user.click(screen.getByRole("button", { name: "close editor" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("File has changed on disk");
    expect(removePane).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(removePane).toHaveBeenCalledWith("ws-1", "editor-1"));
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(2);
  });

  it("refuses an agent's close while edits are unsaved, and says why", async () => {
    await editA();
    const removePane = vi.fn();
    const { result } = renderHook(() => usePaneCloseGuard({ workspaces, removePane }));

    expect(() => result.current.closeForAgent("ws-1", "editor-1")).toThrow(/unsaved edits in a\.ts/);
    expect(removePane).not.toHaveBeenCalled();

    result.current.closeForAgent("ws-1", "term-1");
    expect(removePane).toHaveBeenCalledWith("ws-1", "term-1");
  });

  it("a second close request while saving does not restart the dialog", async () => {
    await editA();
    let finishWrite: (value: { mtime: number }) => void = () => {};
    io.editorWriteFileFor.mockReturnValueOnce(new Promise((resolve) => { finishWrite = resolve; }));
    const removePane = vi.fn();
    const user = userEvent.setup();
    render(<Harness removePane={removePane} />);

    await user.click(screen.getByRole("button", { name: "close editor" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("button", { name: /Saving/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "close editor" }));
    expect(screen.getByRole("button", { name: /Saving/ })).toBeInTheDocument();

    finishWrite({ mtime: 2 });
    await vi.waitFor(() => expect(removePane).toHaveBeenCalledTimes(1));
    expect(io.editorWriteFileFor).toHaveBeenCalledTimes(1);
  });
});
