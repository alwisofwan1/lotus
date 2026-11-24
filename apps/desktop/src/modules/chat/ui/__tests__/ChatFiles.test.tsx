import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { EditorReadFileResult } from "@/lib/tauri/codespace";

import { ChatDrawer } from "../ChatChanges";
import { FileLink, FileLinksContext, FilesPane, ReplyFiles } from "../ChatFiles";

const client = vi.hoisted(() => ({
  readChatFile: vi.fn(async (_path?: string): Promise<EditorReadFileResult> => ({ content: "a\nb\nc", mtime: 1, sizeBytes: 5, binary: false, encoding: "utf8" })),
  writeChatFile: vi.fn(async () => ({ mtime: 2 })),
  readChatFileTail: vi.fn(async () => ({ content: "late 1\nlate 2\n", mtime: 1, sizeBytes: 15_000_000, binary: false })),
  readChatFileBytes: vi.fn(async () => new ArrayBuffer(4)),
  openChatFileExternally: vi.fn(async () => {}),
  statChatFile: vi.fn(async (_path?: string): Promise<{ mtime: number; created: number | null; sizeBytes: number }> => ({ mtime: 1, created: 1, sizeBytes: 5 })),
  revealChatFile: vi.fn(async () => {}),
  createChatEntry: vi.fn(async () => ({})),
  renameChatEntry: vi.fn(async () => ({})),
  trashChatEntry: vi.fn(async () => ({})),
}));
vi.mock("../../runtime/chat-runtime-client", () => client);
// The Code mode viewer itself is tested in codespace; here only which bytes it is given.
vi.mock("@/modules/codespace/components/workbench/WorkbenchMediaPreview", () => ({
  WorkbenchMediaPreview: ({ media, source, page, onPage }: { media: { kind: string }; source: { version: number }; page?: number | null; onPage?: (n: number) => void }) => (
    <div>
      <span data-testid="media">{`${media.kind} v${source.version}${page ? ` p${page}` : ""}`}</span>
      <button type="button" onClick={() => onPage?.(7)}>
        read on to 7
      </button>
    </div>
  ),
}));

// Monaco does not run in JSDOM; the editor is tested in codespace. Here only what it is given.
vi.mock("@/modules/codespace/components/workbench/WorkbenchEditor", () => ({
  WorkbenchEditor: ({ filePath, content, onChange }: { filePath: string; content: string; onChange: (value: string) => void }) => (
    <textarea aria-label={`Edit ${filePath}`} value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  // JSDOM has no layout: give every box a size (what the virtualizer reads), so the file's rows mount.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 20 });
});

const folder = { files: ["src/a.ts", "README.md"], set: new Set(["src/a.ts", "README.md"]), truncated: false, error: null };
const pane = (over: Partial<React.ComponentProps<typeof FilesPane>> = {}) => (
  <FilesPane shown cwd="/repo" folder={folder} changed={new Set(["src/a.ts"])} target={null} find={0} version="1" agentName="Claude" {...over} />
);

describe("FilesPane", () => {
  it("opens a link's file at its line, then edits and saves it", async () => {
    render(pane({ target: { path: "src/a.ts", line: 2, n: 1 } }));
    await waitFor(() => expect(screen.getByText("b").closest("[data-hit]")).toBeTruthy());
    expect(client.readChatFile).toHaveBeenCalledWith("/repo/src/a.ts");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("textbox", { name: "Edit lotus-chat:/repo/src/a.ts" });
    fireEvent.change(editor, { target: { value: "a\nB\nc" } });
    fireEvent.keyDown(editor, { key: "s", metaKey: true });
    await waitFor(() => expect(client.writeChatFile).toHaveBeenCalledWith("/repo/src/a.ts", "a\nB\nc", 1, "utf8"));
    await waitFor(() => expect(screen.getByText("B")).toBeTruthy());
  });

  it("takes E as soon as a file opens, without a click", async () => {
    render(pane({ target: { path: "src/a.ts", line: null, n: 1 } }));
    await screen.findByText("b");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "e" });
    expect(screen.getByRole("textbox", { name: "Edit lotus-chat:/repo/src/a.ts" })).toBeTruthy();
  });

  it("renders Markdown, with its source one click away", async () => {
    client.readChatFile.mockResolvedValue({ content: "# Title\n\nbody", mtime: 1, sizeBytes: 14, binary: false, encoding: "utf8" });
    render(pane({ target: { path: "README.md", line: null, n: 1 } }));
    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(screen.getByText("# Title")).toBeTruthy();
    client.readChatFile.mockReset();
    client.readChatFile.mockImplementation(async () => ({ content: "a\nb\nc", mtime: 1, sizeBytes: 5, binary: false, encoding: "utf8" }));
  });

  it("shows a PDF in the viewer and follows the disk", async () => {
    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 1, sizeBytes: 6_300_000, binary: true, encoding: "utf8" });
    const { rerender } = render(pane({ target: { path: "docs/m.pdf", line: null, n: 1 } }));
    expect((await screen.findByTestId("media")).textContent).toBe("pdf v1");
    expect(screen.getByText(/PDF Document · 6.3 MB/)).toBeTruthy();

    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 2, sizeBytes: 6_400_000, binary: true, encoding: "utf8" });
    rerender(pane({ target: { path: "docs/m.pdf", line: null, n: 1 }, version: "2" }));
    await waitFor(() => expect(screen.getByTestId("media").textContent).toBe("pdf v2"));
  });

  it("keeps a playing video's version until the reader reloads", async () => {
    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 1, sizeBytes: 9, binary: true, encoding: "utf8" });
    const { rerender } = render(pane({ target: { path: "docs/demo.mp4", line: null, n: 1 } }));
    expect((await screen.findByTestId("media")).textContent).toBe("video v1");

    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 2, sizeBytes: 9, binary: true, encoding: "utf8" });
    rerender(pane({ target: { path: "docs/demo.mp4", line: null, n: 1 }, version: "2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(screen.getByTestId("media").textContent).toBe("video v2");
  });

  it("opens a PDF link at its page and mentions the page being read", async () => {
    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 1, sizeBytes: 9, binary: true, encoding: "utf8" });
    const onMention = vi.fn();
    render(pane({ target: { path: "docs/m.pdf", line: 4, n: 1 }, onMention }));
    expect((await screen.findByTestId("media")).textContent).toContain("pdf v1 p4");
    expect(screen.getByText("· page 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "read on to 7" }));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Mention in chat/ }));
    expect(onMention).toHaveBeenCalledWith("`docs/m.pdf` (page 7) ");
  });

  it("mentions a text file at its line", async () => {
    const onMention = vi.fn();
    render(pane({ target: { path: "src/a.ts", line: 2, n: 1 }, onMention }));
    await screen.findByText("b");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Mention in chat/ }));
    expect(onMention).toHaveBeenCalledWith("`src/a.ts:2` ");
  });

  it("offers the end of a file too large to read whole", async () => {
    client.readChatFile.mockResolvedValueOnce({ content: "", mtime: 1, sizeBytes: 15_000_000, binary: true, tooLarge: true, encoding: "utf8" });
    render(pane({ target: { path: "storage/app.log", line: null, n: 1 } }));
    fireEvent.click(await screen.findByRole("button", { name: "Show last 2,000 lines" }));
    expect(await screen.findByText("late 2")).toBeTruthy();
    expect(client.readChatFileTail).toHaveBeenCalledWith("/repo/storage/app.log", 2000);
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("keeps focus in the file when a link opens the drawer", async () => {
    const drawer = (open: boolean, n: number) => (
      <ChatDrawer open={open} pane="files" onPane={vi.fn()} counts={{}} onClose={vi.fn()} changes={null} runs={null} files={pane({ target: n ? { path: "src/a.ts", line: 2, n } : null })} />
    );
    const { rerender } = render(drawer(false, 0));
    rerender(drawer(true, 1));
    await screen.findByText("b");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "e" });
    expect(screen.getByRole("textbox", { name: "Edit lotus-chat:/repo/src/a.ts" })).toBeTruthy();
  });

  it("offers both versions when the file changed on disk during the edit", async () => {
    render(pane({ target: { path: "src/a.ts", line: null, n: 1 } }));
    await screen.findByText("b");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    client.writeChatFile.mockRejectedValueOnce(new Error("File has changed on disk"));
    client.readChatFile.mockResolvedValueOnce({ content: "theirs", mtime: 9, sizeBytes: 6, binary: false, encoding: "utf8" });
    fireEvent.change(screen.getByRole("textbox", { name: "Edit lotus-chat:/repo/src/a.ts" }), { target: { value: "mine" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(client.writeChatFile).toHaveBeenLastCalledWith("/repo/src/a.ts", "mine", 9, "utf8"));
  });
});

describe("FilesPane, the tree", () => {
  const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

  it("walks the tree with the arrow keys", () => {
    render(pane());
    row("src").focus();
    fireEvent.keyDown(row("src"), { key: "ArrowRight" });
    expect(row("src").getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(row("src"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(row("a.ts"));
    fireEvent.keyDown(row("a.ts"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row("src"));
    fireEvent.keyDown(row("src"), { key: "ArrowLeft" });
    expect(row("src").getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(row("src"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("README.md"));
  });

  it("makes a file from the menu and opens it in the editor", async () => {
    const onFilesChanged = vi.fn();
    render(pane({ onFilesChanged }));
    fireEvent.contextMenu(row("src"));
    fireEvent.click(screen.getByRole("menuitem", { name: /New file/ }));
    const field = screen.getByRole("textbox", { name: "New file name" });
    fireEvent.change(field, { target: { value: "b.ts" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(client.createChatEntry).toHaveBeenCalledWith("/repo", "src/b.ts", false));
    expect(onFilesChanged).toHaveBeenCalled();
    expect(await screen.findByRole("textbox", { name: "Edit lotus-chat:/repo/src/b.ts" })).toBeTruthy();
  });

  it("refuses a rename onto a name that exists, and renames otherwise", async () => {
    render(pane());
    fireEvent.keyDown(row("README.md"), { key: "r" });
    const field = screen.getByRole("textbox", { name: "New name for README.md" });
    fireEvent.change(field, { target: { value: "src" } });
    expect(screen.getByRole("alert").textContent).toContain("src already exists");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(client.renameChatEntry).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "NOTES.md" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(client.renameChatEntry).toHaveBeenCalledWith("/repo", "README.md", "NOTES.md"));
  });

  it("moves to the Trash only after the confirm", async () => {
    render(pane());
    fireEvent.keyDown(row("src"), { key: "Backspace", metaKey: true });
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("“src” and its 1 file");
    expect(client.trashChatEntry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    await waitFor(() => expect(client.trashChatEntry).toHaveBeenCalledWith("/repo", "src"));
  });
});

describe("FilesPane, a large file", () => {
  it("mounts only the lines near the viewport", async () => {
    const content = Array.from({ length: 5000 }, (_, i) => `row ${i + 1}`).join("\n");
    client.readChatFile.mockResolvedValueOnce({ content, mtime: 1, sizeBytes: content.length, binary: false, encoding: "utf8" });
    render(pane({ target: { path: "logs/app.log", line: null, n: 1 } }));
    expect(await screen.findByText("row 1")).toBeTruthy();
    const mounted = document.querySelectorAll(".chat-files-line").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);
    expect(screen.getByRole("table", { name: "logs/app.log" }).getAttribute("aria-rowcount")).toBe("5000");
  });
});

describe("FileLink", () => {
  it("links a path only when it names one file in the folder", () => {
    const open = vi.fn();
    const resolve = (path: string) => (path === "a.ts" ? "src/a.ts" : null);
    render(
      <FileLinksContext.Provider value={{ cwd: "/repo", resolve, open }}>
        <FileLink text="a.ts:7">a.ts:7</FileLink>
        <FileLink text="nope.ts">nope.ts</FileLink>
      </FileLinksContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "a.ts:7" }));
    expect(open).toHaveBeenCalledWith({ path: "src/a.ts", line: 7 });
    expect(screen.queryByRole("button", { name: "nope.ts" })).toBeNull();
  });

  it("opens an HTML file in Preview, with a way out to the browser", () => {
    const open = vi.fn();
    const browse = vi.fn();
    render(
      <FileLinksContext.Provider value={{ cwd: "/repo", resolve: (p) => p, open, browse }}>
        <FileLink text="mockups/page.html">page</FileLink>
      </FileLinksContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "page" }));
    expect(browse).toHaveBeenCalledWith("file:///repo/mockups/page.html");
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open in your browser" }));
    expect(client.openChatFileExternally).toHaveBeenCalledWith("/repo", "mockups/page.html");
  });
});

describe("ReplyFiles", () => {
  const original = client.statChatFile.getMockImplementation()!;
  afterEach(() => client.statChatFile.mockImplementation(original));
  const file = (mtime: number, created: number | null = 1) => ({ mtime, created, sizeBytes: 2048 });

  it("draws a card only for a named file the turn changed, and opens it", async () => {
    client.statChatFile.mockImplementation(async (path?: string) => {
      if (path === "/vault/notes/retro.md") return file(5_000);
      if (path === "/repo/PLAN.md") return file(1);
      throw new Error("No such file");
    });
    const open = vi.fn();
    const resolve = (p: string) => (["/vault/notes/retro.md", "PLAN.md", "gone.md"].includes(p) ? p : null);
    render(
      <FileLinksContext.Provider value={{ cwd: "/repo", resolve, open }}>
        <ReplyFiles since={4_000} text={"Wrote `/vault/notes/retro.md` from [plan](PLAN.md) and `gone.md`.\n```sh\ncat other.md\n```"} />
      </FileLinksContext.Provider>,
    );
    const card = await screen.findByTitle("Open /vault/notes/retro.md in Lotus");
    expect(card.textContent).toContain("MD");
    expect(card.textContent).toContain("2.0 KB");
    // Changed by the turn but made before it: no "new" mark.
    expect(screen.queryByLabelText("new")).toBeNull();
    // The full path is stat'd, never read.
    expect(client.readChatFile).not.toHaveBeenCalledWith("/vault/notes/retro.md");
    // Only mentioned (PLAN.md), unreadable (gone.md) or in a code block (other.md): no card.
    expect(screen.queryByTitle(/PLAN\.md|gone\.md|other\.md/)).toBeNull();
    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith({ path: "/vault/notes/retro.md", line: null });
    fireEvent.click(screen.getByRole("button", { name: "Open retro.md in its default app" }));
    expect(client.openChatFileExternally).toHaveBeenCalledWith("/repo", "/vault/notes/retro.md");
  });

  it("marks a file the turn made as new, and folds past four", async () => {
    client.statChatFile.mockImplementation(async (path?: string) => file(9_000, path === "/work/Lotus/a.md" ? 8_000 : 1));
    render(
      <FileLinksContext.Provider value={{ cwd: "/work/Lotus", resolve: (p) => p, open: vi.fn() }}>
        <ReplyFiles since={5_000} text={"`a.md` `b.md` `c.md` `d.md` `e.md`"} />
      </FileLinksContext.Provider>,
    );
    await screen.findByTitle("Open /work/Lotus/a.md in Lotus");
    expect(screen.getAllByLabelText("new")).toHaveLength(1);
    expect(screen.queryByTitle("Open /work/Lotus/e.md in Lotus")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }));
    expect(screen.getByTitle("Open /work/Lotus/e.md in Lotus")).toBeTruthy();
  });
});
