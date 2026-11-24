import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ChangedFile, Changes } from "../../domain/changes";
import { ChangesPane, ChatDrawer, moveDraft } from "../ChatChanges";
import { parseDiff } from "../../domain/changes";

const client = vi.hoisted(() => ({
  commitChatChanges: vi.fn(async () => "a1f3c9e"),
  undoChatChanges: vi.fn(async () => {}),
  getChatChangeDiff: vi.fn(async () => "@@ -1,1 +1,1 @@\n-old\n+new"),
  discardChildChat: vi.fn(async () => "lotus/d-x"),
  mergeChildChat: vi.fn(async (): Promise<string> => {
    throw new Error("lotus/d-x conflicts with main in: src/a.ts, src/b.css. Nothing was merged; ask the agent to rebase onto main");
  }),
}));
vi.mock("../../runtime/chat-runtime-client", () => client);

beforeAll(() => {
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  Element.prototype.scrollIntoView = vi.fn();
});

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  added: 2,
  removed: 1,
  agent: true,
  yoursBefore: false,
  yoursAfter: false,
  undoable: true,
  ...over,
});

const changes: Changes = {
  branch: "main",
  prefix: "",
  files: [file("src/LoginForm.tsx", { yoursAfter: true }), file("src/login.css"), file("src/New.test.tsx", { status: "added" }), file("README.md", { agent: false })],
};

const drawer = (over: Partial<React.ComponentProps<typeof ChangesPane>> = {}) =>
  render(<ChangesPane shown threadId="t" changes={changes} agentName="Claude" onChanged={vi.fn()} onCommitted={vi.fn()} {...over} />);

describe("ChangesPane", () => {
  it("ticks a whole group from its header and folds a long tail of the user's files", () => {
    const many: Changes = { ...changes, files: [file("src/a.ts"), ...Array.from({ length: 11 }, (_, i) => file(`docs/${i}.md`, { agent: false }))] };
    drawer({ changes: many });
    const yours = screen.getByRole("checkbox", { name: "Select all: Your changes" }) as HTMLInputElement;
    expect(screen.queryByRole("checkbox", { name: "Commit docs/0.md" })).toBeNull(); // folded
    fireEvent.click(yours);
    expect(yours.checked).toBe(true);
    expect(screen.getByRole("button", { name: /Commit 12 files/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Your changes/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Commit docs/0.md" }));
    expect(yours.indeterminate).toBe(true);
  });

  it("commits the agent's files and leaves the user's own out", async () => {
    const onCommitted = vi.fn();
    drawer({ onCommitted });
    expect(screen.getByText("Edited by Claude")).toBeTruthy();
    expect(screen.getByText("also yours")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Commit README.md" })).toHaveProperty("checked", false);
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Fix the login" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit 3 files/ }));
    await waitFor(() => expect(onCommitted).toHaveBeenCalledWith("a1f3c9e", 3));
    expect(client.commitChatChanges).toHaveBeenCalledWith("t", ["src/LoginForm.tsx", "src/login.css", "src/New.test.tsx"], "Fix the login");
  });

  it("asks before undo, and leaves a file with the user's later edits unticked", async () => {
    drawer();
    fireEvent.click(screen.getByRole("button", { name: "Undo Claude’s edits" }));
    expect(screen.getByText("your later edits will be lost")).toBeTruthy();
    expect(screen.getByText("deleted")).toBeTruthy();
    expect(screen.queryByText("README.md", { selector: ".chat-changes-dialog-list span" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Undo 2 files" }));
    await waitFor(() => expect(client.undoChatChanges).toHaveBeenCalledWith("t", ["src/login.css", "src/New.test.tsx"]));
  });

  it("draws a long diff up to a cap, with the rest one click away", async () => {
    const body = Array.from({ length: 700 }, (_, i) => `+line ${i}`).join("\n");
    client.getChatChangeDiff.mockResolvedValueOnce(`@@ -0,0 +1,700 @@\n${body}`);
    drawer();
    expect(await screen.findByText("101 more lines")).toBeTruthy();
    expect(document.querySelectorAll(".chat-changes-line")).toHaveLength(599);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(document.querySelectorAll(".chat-changes-line")).toHaveLength(700);
  });

  it("offers Retry when the diff cannot be read", async () => {
    client.getChatChangeDiff.mockRejectedValueOnce(new Error("git exited 128"));
    drawer();
    expect(await screen.findByText("git exited 128")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("new")).toBeTruthy());
  });

  it("filters the files by path", () => {
    drawer();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "CSS" } });
    expect(document.querySelectorAll(".chat-changes-file")).toHaveLength(1);
    expect(screen.queryByText("Your changes")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Filter files" }), { target: { value: "zzz" } });
    expect(screen.getByText("No files match “zzz”")).toBeTruthy();
  });

  it("splits the diff side by side and reads it again without whitespace", async () => {
    drawer();
    await screen.findByText("new");
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(document.querySelectorAll(".chat-changes-pair")).toHaveLength(1);
    expect(document.querySelector('.chat-changes-side[data-kind="del"]')?.textContent).toContain("old");
    expect(document.querySelector('.chat-changes-side[data-kind="add"]')?.getAttribute("data-line")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Hide whitespace changes" }));
    await waitFor(() => expect(client.getChatChangeDiff).toHaveBeenLastCalledWith("t", "src/LoginForm.tsx", true));
  });

  it("marks a file viewed until it changes again", () => {
    const { rerender } = drawer({ threadId: "viewed" });
    fireEvent.click(screen.getByRole("button", { name: "Viewed src/login.css" }));
    expect(screen.getByText("1/4 viewed")).toBeTruthy();
    // V on the open file marks it too.
    fireEvent.keyDown(screen.getByRole("button", { name: /^LoginForm/ }), { key: "v" });
    expect(screen.getByText("2/4 viewed")).toBeTruthy();
    const moved: Changes = { ...changes, files: changes.files.map((f) => (f.path === "src/login.css" ? { ...f, added: 9 } : f)) };
    rerender(<ChangesPane shown threadId="viewed" changes={moved} agentName="Claude" onChanged={vi.fn()} onCommitted={vi.fn()} />);
    expect(screen.getByText("changed")).toBeTruthy();
    expect(screen.getByText("1/4 viewed")).toBeTruthy();
  });

  it("opens the file a timeline row asks for", () => {
    drawer({ target: { path: "README.md", n: 1 } });
    expect(document.querySelector('[data-path="README.md"]')?.hasAttribute("data-open")).toBe(true);
    expect(document.querySelector('[data-path="src/LoginForm.tsx"]')?.hasAttribute("data-open")).toBe(false);
  });

  it("says so outside a git repository", () => {
    drawer({ changes: { branch: null, prefix: "", files: [] } });
    expect(screen.getByText("This folder is not in a git repository")).toBeTruthy();
  });
});

describe("ChatDrawer", () => {
  const panel = (over: Partial<React.ComponentProps<typeof ChatDrawer>> = {}) =>
    render(
      <ChatDrawer open pane="changes" onPane={vi.fn()} counts={{}} onClose={vi.fn()} changes={null} files={null} runs={null} preview={<p>the page</p>} {...over} />,
    );

  it("has Preview as a tab beside the others", () => {
    const onPane = vi.fn();
    panel({ onPane });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Changes", "Files", "Runs", "Preview", "Context"]);
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    expect(onPane).toHaveBeenCalledWith("preview");
  });

  it("resizes from its edge with the arrow keys, and resets on double-click", () => {
    const onResize = vi.fn();
    const onResetWidth = vi.fn();
    panel({ onResize, onResetWidth });
    const edge = screen.getByRole("separator", { name: "Resize workbench" });
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenCalledTimes(1);
    const [px, room] = onResize.mock.calls[0];
    expect(px).toBe(24); // jsdom boxes are 0 wide: 0 + 24, the room from the window
    expect(room).toBeGreaterThan(0);
    fireEvent.doubleClick(edge);
    expect(onResetWidth).toHaveBeenCalled();
  });

  it("shields the window while dragging, so the native browser steps aside", () => {
    panel({ onResize: vi.fn() });
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize workbench" }), { button: 0 });
    expect(document.querySelector("[data-covers-browser]")).toBeTruthy();
    fireEvent.pointerUp(window);
    expect(document.querySelector("[data-covers-browser]")).toBeNull();
  });

  it.each([
    ["the window loses focus", () => fireEvent.blur(window)],
    ["the pointer is cancelled", () => fireEvent.pointerCancel(window)],
    ["a move arrives with no button down", () => fireEvent.pointerMove(window, { buttons: 0 })],
  ])("ends a drag once when %s, so nothing stays stuck", (_, lose) => {
    const onResize = vi.fn();
    panel({ onResize });
    fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize workbench" }), { button: 0 });
    lose();
    expect(document.querySelector("[data-covers-browser]")).toBeNull();
    expect(document.querySelector("[data-resizing]")).toBeNull();
    fireEvent.pointerUp(window);
    expect(onResize).toHaveBeenCalledTimes(1);
  });
});

describe("a delegated chat's branch", () => {
  const branch = { branch: "lotus/d-x", into: "main", commits: ["9f2c1e0 fix one", "41ab7d2 fix two", "0c88e31 three", "1111111 four"], uncommitted: 0 };

  it("lists commits, and a conflict offers a rebase prompt instead of merging", async () => {
    const onMention = vi.fn();
    drawer({ changes: { ...changes, delegated: branch }, onMention });
    expect(screen.getByText("4 ahead")).toBeTruthy();
    expect(screen.getByText("1 more")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Merge into main" }));
    await screen.findByText("Not merged");
    expect(client.mergeChildChat).toHaveBeenCalledWith("t");
    expect(screen.getByText("src/b.css")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask to rebase" }));
    expect(onMention).toHaveBeenCalledWith(expect.stringContaining("resolve the conflicts in src/a.ts, src/b.css"));
  });

  it("will not merge with work left uncommitted", () => {
    drawer({ changes: { ...changes, delegated: { ...branch, uncommitted: 2 } } });
    expect(screen.getByText("2 uncommitted")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Merge into main" })).toHaveProperty("disabled", true);
  });

  it("discards on a second press, naming what goes, and never while the agent works", async () => {
    const onDiscarded = vi.fn();
    const { unmount } = drawer({ changes: { ...changes, delegated: { ...branch, uncommitted: 2 } }, onDiscarded, working: true });
    expect(screen.queryByRole("button", { name: "Discard…" })).toBeNull();
    unmount();
    drawer({ changes: { ...changes, delegated: { ...branch, uncommitted: 2 } }, onDiscarded });
    fireEvent.click(screen.getByRole("button", { name: "Discard…" }));
    expect(client.discardChildChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard 4 commits and 2 files?" }));
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledWith("Discarded lotus/d-x · 4 commits and 2 files"));
    expect(client.discardChildChat).toHaveBeenCalledWith("t");
  });

  it("offers no Discard when the branch has nothing to lose", () => {
    drawer({ changes: { ...changes, delegated: { ...branch, commits: [] } }, onDiscarded: vi.fn() });
    expect(screen.queryByRole("button", { name: "Discard…" })).toBeNull();
  });

  it("is not shown in an ordinary chat", () => {
    drawer();
    expect(screen.queryByRole("region", { name: "Branch" })).toBeNull();
  });
});

describe("moveDraft", () => {
  const before = parseDiff("@@ -1,2 +1,2 @@\n a\n-b\n+B\n");
  const after = parseDiff("@@ -1,2 +1,3 @@\n a\n+new\n-b\n+B\n");
  const cite = { path: "x.ts", from: 2, to: 2, removed: false, code: "", note: "" };

  it("follows the lines to their new rows and keeps the text", () => {
    const fresh = before.findIndex((r) => r.kind === "add");
    expect(moveDraft({ from: fresh, to: fresh, text: "keep me" }, cite, before)).toEqual({ from: fresh, to: fresh, text: "keep me" });
    const moved = moveDraft({ from: fresh, to: fresh, text: "keep me" }, { ...cite, from: 3, to: 3 }, after);
    expect(moved?.text).toBe("keep me");
    expect(after[moved!.from]!.kind).toBe("add");
  });

  it("drops a draft whose lines are gone", () => {
    expect(moveDraft({ from: 0, to: 0, text: "x" }, { ...cite, from: 9, to: 9 }, after)).toBeNull();
  });
});
