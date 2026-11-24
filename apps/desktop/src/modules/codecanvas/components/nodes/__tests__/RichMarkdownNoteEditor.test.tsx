import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RichMarkdownNoteEditor } from "../RichMarkdownNoteEditor";

vi.mock("@/lib/tauri/codecanvas", () => ({
  codecanvasReadNoteAsset: vi.fn(async () => ({ asset: { mime: "image/png" }, base64: "aGk=" })),
  codecanvasSaveNoteAsset: vi.fn(async () => ({ id: "asset_saved" })),
}));

beforeEach(() => { document.elementFromPoint = vi.fn(() => document.body); });

describe("RichMarkdownNoteEditor image controls", () => {
  it("persists pasted HTML as canonical Markdown", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="" onChange={onChange} />);
    fireEvent.paste(await screen.findByRole("textbox", { name: "Note content" }), {
      clipboardData: { files: [], getData: (type: string) => type === "text/html" ? "<h1>Title</h1><p><strong>Bold</strong></p>" : "" },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("# Title\n\n**Bold**"));
  });

  it("renders an empty manual checklist marker as a usable checkbox", async () => {
    render(<RichMarkdownNoteEditor content="- [ ]" onChange={vi.fn()} />);
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).toBeInTheDocument();
    expect(checkbox.closest("ul")).toHaveClass("canvas-note-task-list");
    expect(checkbox.closest("li")).toHaveClass("canvas-note-task-item");
  });

  it("shows a drop affordance while an image is dragged over the note", async () => {
    render(<RichMarkdownNoteEditor content="" onChange={vi.fn()} />);
    fireEvent.dragOver(await screen.findByTestId("rich-markdown-note-editor"), {
      dataTransfer: { files: [new File(["hi"], "shot.png", { type: "image/png" })] },
    });
    expect(screen.getByText("Drop image to embed")).toBeInTheDocument();
  });

  it("drops non-image files as path text instead of Note Assets", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="" onChange={onChange} />);
    fireEvent.drop(await screen.findByTestId("rich-markdown-note-editor"), {
      dataTransfer: { files: [new File(["hi"], "notes.txt", { type: "text/plain" })] },
    });
    // An empty note starts in its title (ADR-0046), so the dropped path lands there.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("# notes.txt"));
  });

  it("lets a user delete an embedded Note Asset image", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="![shot](lotus-note-asset://asset_1)" onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete image" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "Note content" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
  });

  it("lets a user align and resize an embedded Note Asset image", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="![shot](lotus-note-asset://asset_1)" onChange={onChange} />);

    fireEvent.click(await screen.findByRole("button", { name: "Align image right" }));
    fireEvent.click(screen.getByRole("button", { name: "Image size S" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "Note content" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("![shot](lotus-note-asset://asset_1){align=right size=s}"));
  });
});

describe("RichMarkdownNoteEditor S0 — no longer accepts nodes the codec can't save", () => {
  it("degrades a pasted ordered list to bullets instead of merging its items", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="" onChange={onChange} />);
    fireEvent.paste(await screen.findByRole("textbox", { name: "Note content" }), {
      clipboardData: { files: [], getData: (type: string) => type === "text/html" ? "<ol><li>first</li><li>second</li></ol>" : "" },
    });
    // The paste path (htmlToMarkdown) itself emits "- first\n- second" — one list, single newlines
    // — but insertContent() feeds that back through markdownToHtml/Tiptap/tiptapJsonToMarkdown
    // (unmodified by this slice), whose bulletList serializer joins every item with the document's
    // top-level "\n\n" separator. That's a structural degradation (further splitting), not the
    // content loss/merge S0 forbids — "first" and "second" both still land intact.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("- first\n\n- second"));
  });

  it("degrades a pasted code block to plain text and keeps both lines intact", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="" onChange={onChange} />);
    fireEvent.paste(await screen.findByRole("textbox", { name: "Note content" }), {
      clipboardData: { files: [], getData: (type: string) => type === "text/html" ? "<pre><code>const a = 1;\nconst b = 2;</code></pre>" : "" },
    });
    // Same reason as the ordered-list case above: the codec preserves the internal newline, but the
    // two now-separate paragraph nodes each become their own top-level Markdown block once the
    // editor re-serializes — degraded structure, not lost or merged text.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("const a = 1;\n\nconst b = 2;"));
  });

  it("degrades a pasted blockquote but keeps the quoted text", async () => {
    const onChange = vi.fn();
    render(<RichMarkdownNoteEditor content="" onChange={onChange} />);
    fireEvent.paste(await screen.findByRole("textbox", { name: "Note content" }), {
      clipboardData: { files: [], getData: (type: string) => type === "text/html" ? "<blockquote><p>quoted</p></blockquote>" : "" },
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("quoted"));
  });

  it("keeps the v1 surface rendering with no regression: H1/H2, bullet, checklist, bold, italic", async () => {
    const md = "# Title\n\n## Subtitle\n\n**bold** and *italic*\n\n- bullet\n\n- [ ] todo\n\n- [x] done";
    render(<RichMarkdownNoteEditor content={md} onChange={vi.fn()} />);
    const editorEl = await screen.findByRole("textbox", { name: "Note content" });
    expect(editorEl.querySelector("h1")).toHaveTextContent("Title");
    expect(editorEl.querySelector("h2")).toHaveTextContent("Subtitle");
    expect(editorEl.querySelector("strong")).toHaveTextContent("bold");
    expect(editorEl.querySelector("em")).toHaveTextContent("italic");
    expect(editorEl.querySelectorAll("ul:not([data-type='taskList']) > li")).toHaveLength(1);
    expect(editorEl.querySelectorAll("ul[data-type='taskList'] > li")).toHaveLength(2);
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });
});
