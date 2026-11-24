import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileView } from "../../services/file-node/file-watch-registry";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null, NodeResizer: () => null };
});

let tier: "full" | "glyph" | "overview" = "full";
vi.mock("../../hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => tier }));

let current: { view: FileView; baseline: string | null } = { view: { status: "loading" }, baseline: null };
const useFileNodeView = vi.fn((_path: string, _active: boolean) => current);
vi.mock("../../hooks/useFileNode", () => ({
  useFileNodeView: (path: string, active: boolean) => useFileNodeView(path, active),
  // Plain, uncoloured runs: the highlighter itself is Shiki's concern.
  useFileNodeHighlight: (content: string | null) => (content === null ? null : content.split("\n").map((line) => [{ content: line, color: "#abcdef" }])),
}));
vi.mock("../../services/file-node/file-node-io", () => ({ activeFileSource: () => ({ root: "/repo", location: null, path: "" }) }));
vi.mock("../../services/canvas-active-project", () => ({ getActiveProjectRootDir: () => "/repo" }));

import { FileNode } from "../nodes/FileNode";
import { agentStateRegistry } from "../../services/narration/agent-state-registry";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { subscribeOpenInCode } from "../../services/open-in-code";

const ready = (content: string): FileView => ({ status: "ready", content, sizeBytes: content.length, mtime: 1, rev: 1 });

function props(data: Record<string, unknown> = {}, selected = false) {
  return { id: "file-1", selected, data: { path: "/repo/src/auth/session.ts", ...data } } as unknown as Parameters<typeof FileNode>[0];
}

describe("FileNode", () => {
  const requests: Array<{ path: string; line?: number }> = [];
  let off: () => void;
  beforeEach(() => {
    tier = "full";
    current = { view: ready("const a = 1;\nconst b = 2;\nconst c = 3;"), baseline: null };
    requests.length = 0;
    off = subscribeOpenInCode((r) => requests.push(r));
    useFileNodeView.mockClear();
  });
  afterEach(() => off());

  it("shows the file's name, its folder, its language and the read-only footer", () => {
    render(<FileNode {...props()} />);
    expect(screen.getByText("session.ts")).toBeTruthy();
    expect(screen.getByText("src/auth")).toBeTruthy();
    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText(/Read-only on the board/)).toBeTruthy();
    expect(screen.getByText("const b = 2;")).toBeTruthy();
  });

  it("opens the Code app on this file from the Edit button", () => {
    render(<FileNode {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit session\.ts in Code/ }));
    expect(requests).toEqual([{ path: "/repo/src/auth/session.ts" }]);
  });

  it("leaves ⏎ to the canvas hotkey layer: no window listener of its own", () => {
    render(<FileNode {...props({}, true)} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(requests).toEqual([]);
  });

  it("scrolls its own body without panning or zooming the canvas, and drags by its header", () => {
    const { container } = render(<FileNode {...props()} />);
    const body = container.querySelector(".canvas-file-body");
    expect(body?.className).toContain("nodrag");
    expect(body?.className).toContain("nopan");
    expect(body?.className).toContain("nowheel");
    const header = container.querySelector(".canvas-node-header");
    expect(header).toBeTruthy();
    expect(header?.className).not.toContain("nodrag");
  });

  it("marks added, modified and deleted lines from the git baseline", () => {
    current = { view: ready("one\nTWO\nthree\nfour"), baseline: "one\ntwo\nthree\n" };
    const { container } = render(<FileNode {...props()} />);
    const marks = [...container.querySelectorAll("[data-line]")].map((el) => [el.getAttribute("data-line"), el.getAttribute("data-mark")]);
    expect(marks).toEqual([["1", null], ["2", "modified"], ["3", null], ["4", "added"]]);
  });

  it("says plainly that the file was deleted or moved, and offers no Edit", () => {
    current = { view: { status: "missing" }, baseline: null };
    render(<FileNode {...props()} />);
    expect(screen.getByText(/deleted or moved/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  });

  it("shows loading, binary, too-large and error states", () => {
    current = { view: { status: "loading" }, baseline: null };
    const { rerender } = render(<FileNode {...props()} />);
    expect(screen.getByText(/Reading file/i)).toBeTruthy();
    current = { view: { status: "binary", sizeBytes: 2048 }, baseline: null };
    rerender(<FileNode {...props()} />);
    expect(screen.getByText("Binary file")).toBeTruthy();
    current = { view: { status: "too-large", sizeBytes: 20 * 1024 * 1024 }, baseline: null };
    rerender(<FileNode {...props()} />);
    expect(screen.getByText(/Large file/)).toBeTruthy();
    current = { view: { status: "error", message: "Permission denied" }, baseline: null };
    rerender(<FileNode {...props()} />);
    expect(screen.getByText("Permission denied")).toBeTruthy();
  });

  it("offers Open in Code from the binary state", () => {
    current = { view: { status: "binary", sizeBytes: 5 }, baseline: null };
    render(<FileNode {...props({ path: "/repo/logo.png" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Open in Code" }));
    expect(requests).toEqual([{ path: "/repo/logo.png" }]);
  });

  it("collapses to a glyph with the file name below the glyph tier, and stops watching", () => {
    tier = "glyph";
    const { container } = render(<FileNode {...props()} />);
    expect(container.querySelector(".canvas-node-glyph")).toBeTruthy();
    expect(container.querySelector(".canvas-file-body")).toBeNull();
    expect(useFileNodeView).toHaveBeenLastCalledWith("/repo/src/auth/session.ts", false);
  });

  it("watches while drawn in full", () => {
    render(<FileNode {...props()} />);
    expect(useFileNodeView).toHaveBeenLastCalledWith("/repo/src/auth/session.ts", true);
  });

  it("shows the agent chip only while a live agent that touched this file is on the board", () => {
    const { unmount } = render(<FileNode {...props()} />);
    expect(screen.queryByTestId("file-node-agent-chip")).toBeNull();
    unmount();

    current = { view: ready("a\nB\nc\nd"), baseline: "a\nb\nc" };
    agentStatusRegistry.publish({ id: "term-1", name: "Skye", status: "running" });
    act(() => {
      agentStateRegistry.observe({ kind: "tool_post", tag: "tool_post_edit", neutral: "", paneId: "term-1", filePath: "/repo/src/auth/session.ts", ts: 5 });
    });
    render(<FileNode {...props()} />);
    const chip = screen.getByTestId("file-node-agent-chip");
    expect(chip.textContent).toContain("Skye");
    expect(chip.textContent).toContain("+2");
    expect(chip.textContent).toContain("−1");

    act(() => agentStatusRegistry.remove("term-1"));
    expect(screen.queryByTestId("file-node-agent-chip")).toBeNull();
    agentStateRegistry.clear("term-1");
  });
});
