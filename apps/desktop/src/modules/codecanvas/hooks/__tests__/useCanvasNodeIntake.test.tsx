import type { DragEvent as ReactDragEvent } from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCanvasNodeIntake } from "../useCanvasNodeIntake";
import type { CanvasIntakePayload } from "../../services/canvas-intake";

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));

function effects() {
  return {
    appendNoteText: vi.fn(),
    appendNoteImages: vi.fn(async (_nodeId: string, images: unknown[]) => images.length),
    writePty: vi.fn(),
    applySkill: vi.fn(),
    addAttachment: vi.fn(),
  };
}

function dropEvent(file: File, point = { clientX: 160, clientY: 120 }) {
  return {
    preventDefault: vi.fn(),
    defaultPrevented: false,
    clientX: point.clientX,
    clientY: point.clientY,
    dataTransfer: {
      types: ["Files"],
      files: [file],
      dropEffect: "none",
      getData: () => "",
    },
  } as unknown as ReactDragEvent;
}

function textDropEvent(text: string, point = { clientX: 40, clientY: 40 }) {
  return {
    preventDefault: vi.fn(), defaultPrevented: false, clientX: point.clientX, clientY: point.clientY,
    dataTransfer: { types: ["text/plain"], files: [], dropEffect: "none", getData: (t: string) => (t === "text/plain" ? text : "") },
  } as unknown as ReactDragEvent;
}

describe("useCanvasNodeIntake — an image ALWAYS becomes a placed image shape (CNVS)", () => {
  it("makes a shape when dropping an image on empty canvas", async () => {
    const fx = effects();
    const createImageShape = vi.fn(async () => "shape-1");
    const createCanvasDropTarget = vi.fn(() => ({ id: "note-new", kind: "note" as const }));
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: () => null,
      createCanvasDropTarget,
      createImageShape,
      effects: fx,
    }));

    act(() => { result.current.handleCanvasDrop(dropEvent(new File(["hi"], "shot.png", { type: "image/png" }))); });

    await waitFor(() => expect(createImageShape).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "bytes", name: "shot.png" })],
      { clientX: 160, clientY: 120 },
    ));
    expect(createCanvasDropTarget).not.toHaveBeenCalled();
    expect(fx.appendNoteImages).not.toHaveBeenCalled();
  });

  it("makes a shape when image BYTES are dropped over any node (note/terminal/agent) — bytes can't be a file path", async () => {
    // Browser drops give bytes (no filesystem path); only OS drops give paths (tested purely +
    // via effects). Bytes over any node → shape, never funneled into the node.
    for (const kind of ["note", "terminal", "agent"] as const) {
      const fx = effects();
      const createImageShape = vi.fn(async () => "shape-x");
      const { result } = renderHook(() => useCanvasNodeIntake({
        getSelectedNode: () => null,
        getNodeAtPoint: () => ({ id: `${kind}-1`, kind }),
        createImageShape,
        effects: fx,
      }));

      act(() => { result.current.handleCanvasDrop(dropEvent(new File(["x"], "shot.png", { type: "image/png" }), { clientX: 300, clientY: 200 })); });

      await waitFor(() => expect(createImageShape).toHaveBeenCalled());
      expect(fx.appendNoteImages).not.toHaveBeenCalled();
      expect(fx.writePty).not.toHaveBeenCalled();
      expect(fx.addAttachment).not.toHaveBeenCalled();
    }
  });

  it("still routes TEXT into the node under the pointer (non-image drop unchanged)", async () => {
    const fx = effects();
    const createImageShape = vi.fn(async () => "shape-1");
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: () => ({ id: "note-hover", kind: "note" }),
      createImageShape,
      effects: fx,
    }));

    act(() => { result.current.handleCanvasDrop(textDropEvent("hello", { clientX: 50, clientY: 50 })); });

    await waitFor(() => expect(fx.appendNoteText).toHaveBeenCalledWith("note-hover", "hello"));
    expect(createImageShape).not.toHaveBeenCalled();
  });

  it("still creates a Note when dropping TEXT on empty canvas (fallback unchanged for non-images)", async () => {
    const fx = effects();
    const createCanvasDropTarget = vi.fn(() => ({ id: "note-new", kind: "note" as const }));
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: () => null,
      createCanvasDropTarget,
      createImageShape: vi.fn(async () => "s"),
      effects: fx,
    }));

    act(() => { result.current.handleCanvasDrop(textDropEvent("hello world")); });

    await waitFor(() => expect(createCanvasDropTarget).toHaveBeenCalledWith(expect.objectContaining({ kind: "text" }), { clientX: 40, clientY: 40 }));
    expect(fx.appendNoteText).toHaveBeenCalledWith("note-new", "hello world");
  });

  it("does not route a pointed drop to a stale hovered node when the point misses", async () => {
    const fx = effects();
    const createCanvasDropTarget = vi.fn(() => ({ id: "note-new", kind: "note" as const }));
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getHoveredNode: () => ({ id: "note-stale", kind: "note" }),
      getNodeAtPoint: () => null,
      createCanvasDropTarget,
      effects: fx,
    }));

    act(() => { result.current.handleCanvasDrop(textDropEvent("fresh drop", { clientX: 88, clientY: 99 })); });

    await waitFor(() => expect(createCanvasDropTarget).toHaveBeenCalledWith(expect.objectContaining({ kind: "text" }), { clientX: 88, clientY: 99 }));
    expect(fx.appendNoteText).toHaveBeenCalledWith("note-new", "fresh drop");
    expect(fx.appendNoteText).not.toHaveBeenCalledWith("note-stale", expect.any(String));
  });
});

describe("useCanvasNodeIntake drag-over hover target (drives the drop frame)", () => {
  function dragOverEvt(point = { clientX: 200, clientY: 150 }) {
    return {
      preventDefault: vi.fn(), defaultPrevented: false, clientX: point.clientX, clientY: point.clientY,
      dataTransfer: { types: ["Files"], files: [], dropEffect: "none", getData: () => "" },
    } as unknown as ReactDragEvent;
  }

  it("reports the node under an HTML5 drag so the frame can arm", () => {
    const onHoverTarget = vi.fn();
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: () => ({ id: "agent-1", kind: "agent" }),
      onHoverTarget,
      effects: effects(),
    }));
    act(() => { result.current.handleCanvasDragOver(dragOverEvt()); });
    expect(onHoverTarget).toHaveBeenLastCalledWith({ id: "agent-1", kind: "agent" });
  });

  it("reports null over empty canvas and clears on drop", () => {
    const onHoverTarget = vi.fn();
    const { result } = renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getNodeAtPoint: () => null,
      onHoverTarget,
      createImageShape: vi.fn(async () => "s"),
      effects: effects(),
    }));
    act(() => { result.current.handleCanvasDragOver(dragOverEvt()); });
    expect(onHoverTarget).toHaveBeenLastCalledWith(null);
    act(() => { result.current.handleCanvasDrop(dropEvent(new File(["x"], "s.png", { type: "image/png" }))); });
    expect(onHoverTarget).toHaveBeenLastCalledWith(null);
  });
});

describe("useCanvasNodeIntake clipboard paste", () => {
  it("pastes an image as a standalone shape (never into a selected node)", async () => {
    const fx = effects();
    const createImageShape = vi.fn(async () => "shape-1");
    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => ({ id: "agent-1", kind: "agent" }),
      getHoveredNode: () => null,
      createImageShape,
      effects: fx,
    }));

    const item = new File(["x"], "clip.png", { type: "image/png" });
    const event = new Event("paste") as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["Files"], files: [item], getData: () => "" },
    });
    await act(async () => { document.dispatchEvent(event); });

    await waitFor(() => expect(createImageShape).toHaveBeenCalledWith(
      [expect.objectContaining({ kind: "bytes", name: "clip.png" })],
      null,
    ));
    expect(fx.addAttachment).not.toHaveBeenCalled();
  });

  it("does NOT hijack an image paste while a terminal agent (xterm) is focused — it goes to the agent", async () => {
    const fx = effects();
    const createImageShape = vi.fn(async () => "shape-1");
    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getHoveredNode: () => null,
      createImageShape,
      effects: fx,
    }));

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const ta = document.createElement("textarea");
    ta.className = "xterm-helper-textarea";
    xterm.appendChild(ta);
    document.body.appendChild(xterm);
    ta.focus();

    const item = new File(["x"], "clip.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { types: ["Files"], files: [item], getData: () => "" } });
    await act(async () => { ta.dispatchEvent(event); });

    expect(createImageShape).not.toHaveBeenCalled();
    document.body.removeChild(xterm);
  });

  it("does NOT hijack an image paste while a Note rich editor is focused (TipTap embeds it)", async () => {
    const fx = effects();
    const createImageShape = vi.fn(async () => "shape-1");
    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => null,
      getHoveredNode: () => null,
      createImageShape,
      effects: fx,
    }));

    const noteEditor = document.createElement("div");
    noteEditor.className = "canvas-note-editor";
    noteEditor.setAttribute("contenteditable", "true");
    noteEditor.tabIndex = 0;
    document.body.appendChild(noteEditor);
    noteEditor.focus();

    const item = new File(["x"], "clip.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { types: ["Files"], files: [item], getData: () => "" } });
    await act(async () => { noteEditor.dispatchEvent(event); });

    expect(createImageShape).not.toHaveBeenCalled();
    document.body.removeChild(noteEditor);
  });

  it("still routes a pasted URL into the selected node (non-image paste unchanged)", async () => {
    const fx = effects();
    const payloads: CanvasIntakePayload[] = [];
    void payloads;
    renderHook(() => useCanvasNodeIntake({
      getSelectedNode: () => ({ id: "note-1", kind: "note" }),
      getHoveredNode: () => null,
      createImageShape: vi.fn(async () => "s"),
      effects: fx,
    }));

    const event = new Event("paste") as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", {
      value: { types: ["text/plain"], files: [], getData: (t: string) => (t === "text/plain" ? "https://x.dev" : "") },
    });
    await act(async () => { document.dispatchEvent(event); });

    await waitFor(() => expect(fx.appendNoteText).toHaveBeenCalledWith("note-1", "https://x.dev"));
  });
});
