import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
    useNodeConnections: () => mockConnections,
    useNodesData: (ids: string[]) => mockPeers.filter((peer) => ids.includes(peer.id)),
  };
});

let mockLodTier: "full" | "glyph" | "overview" = "full";
let mockConnections: { source: string; target: string }[] = [];
let mockPeers: { id: string; type: string; data: Record<string, unknown> }[] = [];
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => mockLodTier,
}));

vi.mock("@/lib/tauri/codecanvas", () => ({
  codecanvasReadNoteAsset: vi.fn(async () => ({ asset: { id: "asset_1", mime: "image/png", originalName: "shot.png" }, base64: "QUJD" })),
  codecanvasSaveNoteAsset: vi.fn(),
  codecanvasImportNoteAssetPath: vi.fn(),
}));

import { NoteNode } from "../nodes/NoteNode";
import type { NoteNodeData } from "../nodes/NoteNode";
import { markNoteSpawned, resetNoteSpawnFocus } from "../../services/nodes/note-spawn-focus";

function makeProps(overrides?: Partial<NoteNodeData>, id = "note-1") {
  return {
    id,
    data: {
      content: "",
      onNoteChange: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof NoteNode>[0];
}

const editorOf = () => screen.findByRole("textbox", { name: "Note content" });
const bodyOf = (container: HTMLElement) => container.querySelector(".canvas-note-node-body")!;

describe("NoteNode", () => {
  beforeEach(() => {
    mockLodTier = "full";
    mockConnections = [];
    mockPeers = [];
    resetNoteSpawnFocus();
    document.elementFromPoint = vi.fn(() => document.body);
  });

  it("renders a Rich Markdown Note editor with the initial Markdown content", async () => {
    render(<NoteNode {...makeProps({ content: "# hello world" })} />);
    expect(await editorOf()).toHaveTextContent("hello world");
    // Formatting controls now live in the selection BubbleMenu (no persistent toolbar),
    // so they are not present in the resting DOM.
    expect(screen.queryByRole("button", { name: "Bold" })).not.toBeInTheDocument();
  });

  it("syncs externally-appended Note Asset Markdown into a rendered image", async () => {
    const { rerender } = render(<NoteNode {...makeProps({ content: "plain" })} />);
    expect(await editorOf()).toHaveTextContent("plain");

    rerender(<NoteNode {...makeProps({ content: "![shot](lotus-note-asset://asset_1)" })} />);

    const image = await screen.findByRole("img", { name: "shot" });
    await waitFor(() => expect(image).toHaveAttribute("src", "data:image/png;base64,QUJD"));
  });

  it("commits changed Markdown content with the note id", async () => {
    const onNoteChange = vi.fn();
    render(<NoteNode {...makeProps({ content: "", onNoteChange })} />);
    const editor = await editorOf();

    fireEvent.paste(editor, {
      clipboardData: { files: [], getData: (type: string) => (type === "text/html" ? "<p>new content</p>" : "") },
    });
    fireEvent.blur(editor);

    await waitFor(() => expect(onNoteChange).toHaveBeenCalledWith("note-1", "new content"));
  });

  it("emits note commands through the node command seam", async () => {
    const dispatchCommand = vi.fn();
    render(<NoteNode {...makeProps({ content: "", dispatchCommand, onNoteChange: undefined, onClose: undefined })} />);
    const editor = await editorOf();

    fireEvent.paste(editor, {
      clipboardData: { files: [], getData: (type: string) => (type === "text/html" ? "<p>new content</p>" : "") },
    });
    fireEvent.blur(editor);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(dispatchCommand).toHaveBeenCalledWith({ kind: "note-change", nodeId: "note-1", content: "new content" }));
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "note-1" });
  });

  it("marks the note body as an internal nodrag/nowheel region (drag from the header, like every other node)", () => {
    const { container } = render(<NoteNode {...makeProps()} />);
    const body = bodyOf(container);
    expect(body).toHaveClass("nodrag", "nowheel");
  });

  describe("header", () => {
    it("shows a quiet 'Note' label and keeps the derived title as its tooltip", () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# Design spec\n\nbody", noteNumber: 4 })} />);
      expect(screen.getByText("Note")).toBeInTheDocument();
      expect(container.querySelector(".cnh-id")).toHaveAttribute("title", "Design spec");
      // The filename slug is gone — the name lives in the body as the serif title.
      expect(screen.queryByText("design-spec")).not.toBeInTheDocument();
    });

    it("falls back to the persisted note number in the tooltip while the note is still empty", () => {
      const { container } = render(<NoteNode {...makeProps({ noteNumber: 4 })} />);
      expect(container.querySelector(".cnh-id")).toHaveAttribute("title", "Note 4");
    });

    it("keeps the drag-handle class so ReactFlow can still drag the node by its header", () => {
      // NOTE_DRAG_HANDLE in canvas-node-factory.ts is ".canvas-node-header, .canvas-node-glyph".
      const { container } = render(<NoteNode {...makeProps()} />);
      expect(container.querySelector(".canvas-node-header.canvas-note-header")).toBeInTheDocument();
    });

    it("closes the note from the header", () => {
      const onClose = vi.fn();
      render(<NoteNode {...makeProps({ onClose })} />);
      fireEvent.click(screen.getByRole("button", { name: "Close note" }));
      expect(onClose).toHaveBeenCalledWith("note-1");
    });

    it("closes the ··· menu on Escape without leaving edit mode", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "" })} />);
      await editorOf();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "edit");
    });
  });

  describe("read / edit mode", () => {
    it("opens an existing note in read mode and an empty one in edit mode", async () => {
      const { container, unmount } = render(<NoteNode {...makeProps({ content: "# has content" })} />);
      await editorOf();
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "read");
      expect(screen.getByText("Note")).toBeInTheDocument();
      unmount();

      const fresh = render(<NoteNode {...makeProps({ content: "" })} />);
      await editorOf();
      expect(bodyOf(fresh.container)).toHaveAttribute("data-note-mode", "edit");
      expect(screen.getByText("Editing · Esc to finish")).toBeInTheDocument();
    });

    it("has no read|edit pill any more", async () => {
      render(<NoteNode {...makeProps({ content: "# read me" })} />);
      await editorOf();
      expect(screen.queryByRole("button", { name: "read" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "edit" })).not.toBeInTheDocument();
    });

    it("enters edit mode on a single click on the text", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# read me" })} />);
      const editor = await editorOf();
      fireEvent.click(editor);
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "edit");
    });

    it("stays in read mode when the click ticks a checkbox", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "- [ ] one" })} />);
      await editorOf();
      const box = await waitFor(() => {
        const input = container.querySelector<HTMLInputElement>(".canvas-note-editor input[type=checkbox]");
        expect(input).not.toBeNull();
        return input!;
      });
      fireEvent.click(box);
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "read");
    });

    it("enters edit mode from the ··· menu, the keyboard way in", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# read me" })} />);
      await editorOf();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Edit note/ }));
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "edit");
    });

    it("leaves edit mode on Escape and stops the canvas from also reading that key", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "" })} />);
      await editorOf();
      const body = bodyOf(container);
      expect(body).toHaveAttribute("data-note-mode", "edit");

      const reachedWindow = vi.fn();
      window.addEventListener("keydown", reachedWindow);
      fireEvent.keyDown(body, { key: "Escape" });
      window.removeEventListener("keydown", reachedWindow);

      expect(body).toHaveAttribute("data-note-mode", "read");
      expect(reachedWindow).not.toHaveBeenCalled();
    });

    it("lets Escape through to the canvas while the note is only being read", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# read me" })} />);
      await editorOf();
      const reachedWindow = vi.fn();
      window.addEventListener("keydown", reachedWindow);
      fireEvent.keyDown(bodyOf(container), { key: "Escape" });
      window.removeEventListener("keydown", reachedWindow);
      expect(reachedWindow).toHaveBeenCalled();
    });

    it("finishes editing when focus leaves the note", async () => {
      const { container } = render(
        <>
          <NoteNode {...makeProps({ content: "" })} />
          <button type="button">elsewhere</button>
        </>,
      );
      await editorOf();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      fireEvent.blur(bodyOf(container).querySelector(".canvas-note-editor")!, {
        relatedTarget: screen.getByRole("button", { name: "elsewhere" }),
      });
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "read");
    });

    it("keeps editing when focus moves to the note's own header", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "" })} />);
      await editorOf();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      fireEvent.blur(bodyOf(container).querySelector(".canvas-note-editor")!, {
        relatedTarget: screen.getByRole("button", { name: "More actions" }),
      });
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "edit");
    });

    it("keeps the editor mounted and toggles its editability instead of swapping in a reader", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# read me" })} />);
      const editor = await editorOf();
      expect(editor.getAttribute("contenteditable")).toBe("false");

      fireEvent.click(editor);
      await waitFor(() => expect(editor.getAttribute("contenteditable")).toBe("true"));
      // Same DOM node throughout — no remount, so scroll position and selection survive.
      expect(bodyOf(container).contains(editor)).toBe(true);
    });

    it("flushes pending edits when leaving edit mode", async () => {
      const onNoteChange = vi.fn();
      const { container } = render(<NoteNode {...makeProps({ content: "", onNoteChange })} />);
      const editor = await editorOf();

      fireEvent.paste(editor, {
        clipboardData: { files: [], getData: (type: string) => (type === "text/html" ? "<p>typed</p>" : "") },
      });
      fireEvent.keyDown(bodyOf(container), { key: "Escape" });

      await waitFor(() => expect(onNoteChange).toHaveBeenCalledWith("note-1", "typed"));
    });
  });

  describe("Smart Convert", () => {
    it("lives in the header's ··· menu", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "# note" })} />);
      await editorOf();

      expect(container.querySelector(".canvas-note-convert-btn")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      const action = screen.getByRole("menuitem", { name: /Smart Convert/ });
      expect(container.querySelector(".canvas-note-header")!.contains(action)).toBe(true);
    });

    it("opens the Smart Convert modal from the menu", async () => {
      render(<NoteNode {...makeProps({ content: "# note" })} />);
      await editorOf();

      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Smart Convert/ }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(await screen.findAllByText(/Smart Convert/i)).not.toHaveLength(0);
    });
  });

  describe("footer", () => {
    it("is absent when there is nothing to say", () => {
      const { container } = render(<NoteNode {...makeProps({ content: "just words" })} />);
      expect(container.querySelector(".canvas-note-footer")).not.toBeInTheDocument();
    });

    it("shows checklist progress and the edited time", () => {
      const editedAt = Date.now();
      render(<NoteNode {...makeProps({ content: "# Plan\n\n- [x] one\n- [ ] two", editedAt })} />);
      expect(screen.getByLabelText("1 of 2 tasks done")).toHaveTextContent("1 of 2");
      expect(screen.getByText(/^Edited today at /)).toBeInTheDocument();
    });

    it("names the agent that wrote the last change", () => {
      render(<NoteNode {...makeProps({ content: "hello", editedAt: Date.now(), editedBy: "Ivo" })} />);
      expect(screen.getByText(/^Edited by Ivo · today at /)).toBeInTheDocument();
    });

    it("names the agent wired to the note", () => {
      mockConnections = [{ source: "note-1", target: "agent-7" }];
      mockPeers = [{ id: "agent-7", type: "agent", data: { name: "reviewer" } }];
      render(<NoteNode {...makeProps({ content: "hello" })} />);
      expect(screen.getByText("Linked to reviewer")).toBeInTheDocument();
    });

    it("does not start editing when the footer is clicked", async () => {
      const { container } = render(<NoteNode {...makeProps({ content: "- [ ] one", editedAt: Date.now() })} />);
      await editorOf();
      fireEvent.click(container.querySelector(".canvas-note-footer")!);
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "read");
    });
  });

  describe("cover", () => {
    it("shows the cover image and removes it from the hover control", async () => {
      const onNotePatch = vi.fn();
      const { container } = render(
        <NoteNode {...makeProps({ content: "# note", coverUri: "lotus-note-asset://asset_1", onNotePatch })} />,
      );
      await waitFor(() => expect(container.querySelector(".canvas-note-cover img")).toHaveAttribute("src", "data:image/png;base64,QUJD"));
      fireEvent.click(screen.getByRole("button", { name: "Remove cover" }));
      expect(onNotePatch).toHaveBeenCalledWith("note-1", { coverUri: null });
      expect(bodyOf(container)).toHaveAttribute("data-note-mode", "read");
    });

    it("offers Remove cover in the ··· menu only when there is one", async () => {
      const onNotePatch = vi.fn();
      const { rerender } = render(<NoteNode {...makeProps({ content: "# note", onNotePatch })} />);
      await editorOf();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      expect(screen.queryByRole("menuitem", { name: /Remove cover/ })).not.toBeInTheDocument();

      rerender(<NoteNode {...makeProps({ content: "# note", coverUri: "lotus-note-asset://asset_1", onNotePatch })} />);
      fireEvent.click(screen.getByRole("menuitem", { name: /Remove cover/ }));
      expect(onNotePatch).toHaveBeenCalledWith("note-1", { coverUri: null });
    });
  });

  describe("add agent", () => {
    it("spawns a wired agent from the ··· menu and from the new-note chip", async () => {
      const dispatchCommand = vi.fn();
      const { unmount } = render(<NoteNode {...makeProps({ content: "# plan", dispatchCommand })} />);
      await editorOf();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Add agent/ }));
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "note-spawn-agent", nodeId: "note-1" });
      unmount();

      dispatchCommand.mockClear();
      render(<NoteNode {...makeProps({ content: "", dispatchCommand })} />);
      await editorOf();
      fireEvent.click(screen.getByRole("button", { name: "Agent" }));
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "note-spawn-agent", nodeId: "note-1" });
    });
  });

  describe("caret on spawn", () => {
    it("takes the caret for a note that was just created", async () => {
      markNoteSpawned("note-fresh");
      render(<NoteNode {...makeProps({ content: "" }, "note-fresh")} />);
      const editor = await editorOf();
      await waitFor(() => expect(editor).toHaveFocus());
    });

    it("leaves the caret alone for an empty note restored from a snapshot", async () => {
      render(<NoteNode {...makeProps({ content: "" }, "note-restored")} />);
      const editor = await editorOf();
      expect(editor).not.toHaveFocus();
    });
  });

  it("collapses to a glyph block (no textarea) at the glyph tier", () => {
    mockLodTier = "glyph";
    const { container } = render(<NoteNode {...makeProps({ content: "# Design spec\nmore" })} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // The zoomed-out card names the note with the same derived title as everywhere else.
    expect(screen.getByRole("img", { name: "Design spec — note" })).toBeInTheDocument();
    expect(container.querySelector(".cng-title")).toHaveTextContent("Design spec");
    // It stays draggable: NOTE_DRAG_HANDLE includes .canvas-node-glyph.
    expect(container.querySelector(".canvas-note-glyph")).toHaveClass("canvas-node-glyph");
  });

  it("shows checklist progress on the zoomed-out card", () => {
    mockLodTier = "glyph";
    const { container } = render(<NoteNode {...makeProps({ content: "# Plan\n\n- [x] one\n- [ ] two" })} />);
    expect(container.querySelector(".cng-progress")).toHaveTextContent("1 of 2 done");
  });

  it("renders an overview map glyph at the overview tier", () => {
    mockLodTier = "overview";
    const { container } = render(<NoteNode {...makeProps({ content: "Design spec\nmore" })} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(container.querySelector(".canvas-node")).toHaveAttribute("data-lod", "overview");
    expect(container.querySelector(".canvas-node")).toHaveClass("canvas-node--overview");
    expect(container.querySelector(".canvas-node-glyph")).toBeInTheDocument();
  });
});
