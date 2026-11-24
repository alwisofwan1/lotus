import React from "react";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashItem } from "../../domain/slash";
import type { ChatThread } from "../../runtime/chat-runtime-client";
import { ChatComposer } from "../ChatComposer";
import { resetSlashCache } from "../ChatSlash";
import { ChatStart } from "../ChatStart";
import { paragraphs } from "../chat-editor";

const item = (kind: SlashItem["kind"], name: string, description: string, argumentHint: string | null = null): SlashItem => ({
  kind,
  name,
  description,
  argumentHint,
  source: kind === "command" ? "built-in" : "project",
  path: null,
});
const list = vi.hoisted(() => ({ calls: 0 }));
const dialog = vi.hoisted(() => ({ picked: null as string | null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => dialog.picked }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));
vi.mock("../../runtime/chat-runtime-client", () => ({
  attachmentPreview: () => new Promise(() => {}),
  listChatModels: async () => [],
  homeFolder: async () => "/Users/me",
  listChatPath: async (dir: string) =>
    ({
      "/w/": [{ path: "/w/bb", kind: "directory" }, { path: "/w/lotus", kind: "directory" }, { path: "/w/notes.md", kind: "file" }],
      "/w/bb/": [{ path: "/w/bb/README.md", kind: "file" }],
      "/Users/me/": [{ path: "/Users/me/Downloads", kind: "directory" }],
    })[dir] ?? [],
  indexChatFolder: async () => ({ files: ["README.md", "src/app.ts", "src/modules/chat/ui/ChatComposer.tsx"], truncated: false }),
  listSlashItems: async () => {
    list.calls++;
    return [
      item("command", "clear", "Start fresh context in this thread"),
      item("skill", "lotus-probe", "Probe skill", "<word>"),
      item("skill", "tdd", "Test first"),
    ];
  },
}));

beforeEach(() => {
  resetSlashCache();
  list.calls = 0;
  localStorage.clear();
  localStorage.setItem("lotus.chat.new", JSON.stringify({ runner: "claude", cwd: "/w/lotus" }));
});

// The home box is the composer's Tiptap editor; Tiptap puts the editor on its element.
const editorOf = (box: HTMLElement) => (box as HTMLElement & { editor: Editor }).editor;
/** Replaces the text and puts the caret at the end, as typing would. */
function type(box: HTMLElement, value: string) {
  act(() => {
    editorOf(box).chain().setContent({ type: "doc", content: paragraphs(value) }, { emitUpdate: true }).focus("end").run();
  });
}
/** What would be sent: chips as their full text. */
const value = (box: HTMLElement) => editorOf(box).getText({ blockSeparator: "\n" });
const placeholderOf = (box: HTMLElement) => box.querySelector("p")?.getAttribute("data-placeholder");

describe("slash picker on the Chat home", () => {
  it("lists skills only, filters, picks with Enter into a chip, and sends /name with the rest", async () => {
    const onStart = vi.fn(async () => {});
    render(<ChatStart recent={[]} stats={null} onStart={onStart} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/");
    const listbox = await screen.findByRole("listbox", { name: "Commands and skills" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("/lotus-probe"), expect.stringContaining("/tdd")]);
    expect(box.getAttribute("aria-controls")).toBe(listbox.id);
    // The editor's attributes land a render after the listbox; on a loaded CI runner this read null.
    await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id));

    type(box, "/lo");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("lotus-probe")).toBeTruthy();
    expect(value(box)).toBe("");
    expect(placeholderOf(box)).toBe("<word>");

    type(box, "banana");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.anything(), "/lotus-probe banana", [], expect.stringMatching(/^[0-9a-f-]{36}$/)));
    expect(list.calls).toBe(1);
  });

  it("keeps a picked skill chip when the home is left and opened again", async () => {
    const first = render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/lo");
    await screen.findByRole("listbox", { name: "Commands and skills" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("lotus-probe")).toBeTruthy();
    first.unmount();

    const onStart = vi.fn(async () => {});
    render(<ChatStart recent={[]} stats={null} onStart={onStart} />);
    expect(screen.getByText("lotus-probe")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Describe the task" }), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.anything(), "/lotus-probe", [], expect.stringMatching(/^[0-9a-f-]{36}$/)));
  });

  it("moves with the arrows (wrapping), closes on Escape, and shows an empty state", async () => {
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "hi");
    type(box, "/zzz");
    expect(screen.getByText("No command or skill matches.")).toBeTruthy();
  });

  it("removes the chip with two Backspaces at the start", async () => {
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/td");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Tab" });
    const chip = screen.getByText("tdd").closest(".chat-skill-chip")!;
    act(() => void editorOf(box).commands.setTextSelection(1));
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(chip.hasAttribute("data-armed")).toBe(true);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(screen.queryByText("tdd")).toBeNull();
  });
});

describe("slash picker in a thread", () => {
  it("runs a picked command at once", async () => {
    const onSend = vi.fn(async () => {});
    render(
      <ChatComposer
        threadId="t1"
        status={{ mode: "send", activity: null }}
        unread={[]}
        details={[]}
        onSend={onSend}
        onStop={vi.fn()}
        waiting={[]}
        cwd="/w/lotus"
        onDecide={vi.fn()}
        fill={{ text: "/cl", n: 1 }}
      />,
    );
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("/clear", []));
  });
});

describe("slash picker freshness", () => {
  it("shows the kept list at once and re-reads it on a later open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
      const box = screen.getByRole("textbox", { name: "Describe the task" });
      type(box, "/");
      await screen.findByRole("listbox");
      expect(list.calls).toBe(1);
      type(box, "");
      vi.advanceTimersByTime(6_000);
      type(box, "/");
      expect(screen.getByRole("listbox")).toBeTruthy();
      await waitFor(() => expect(list.calls).toBe(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recent skills in the picker", () => {
  it("puts a picked skill in a Recent group the next time, before anything is typed", async () => {
    const first = render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    let box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/td");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter" });
    first.unmount();
    // The next time is a new chat: the picked chip was sent, so no draft brings it back.
    localStorage.removeItem("lotus.chat.draft.start:home");

    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/");
    await screen.findByRole("listbox");
    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["/tdd", "/lotus-probe"]);
    expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
    type(box, "/lo");
    expect(screen.queryByText("Recent")).toBeNull();
  });
});

const thread = (id: string, title: string, updatedAt: number) =>
  ({ id, title, updatedAt, archived: false, cwd: "/w/lotus", runner: "claude" }) as unknown as ChatThread;
const chats = [thread("t1", "this chat", 5), thread("m1", "ingat kata mango", 4), thread("d1", "deploy notes", 3)];

const composer = (fill: string, onSend = vi.fn(async () => {}), withChats = chats) => (
  <ChatComposer
    threadId="t1"
    status={{ mode: "send", activity: null }}
    unread={[]}
    details={[]}
    onSend={onSend}
    onStop={vi.fn()}
    waiting={[]}
    cwd="/w/lotus"
    onDecide={vi.fn()}
    fill={{ text: fill, n: 1 }}
    folder={{ files: ["README.md", "src/app.ts"], set: new Set(), truncated: false, error: null }}
    changed={new Set(["src/app.ts"])}
    chats={withChats}
  />
);

describe("/ mid-sentence", () => {
  it("offers skills only, inserts /name where typed, no chip, and sends the text as typed", async () => {
    const onStart = vi.fn(async () => {});
    render(<ChatStart recent={[]} stats={null} onStart={onStart} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "review this with /");
    await screen.findByRole("listbox", { name: "Commands and skills" });
    type(box, "review this with /td");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(value(box)).toBe("review this with /tdd ");
    expect(editorOf(box).state.selection.from).toBe(editorOf(box).state.doc.content.size - 1);
    expect(document.querySelector(".chat-skill-chip")).toBeNull();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.anything(), "review this with /tdd", [], expect.stringMatching(/^[0-9a-f-]{36}$/)));
  });

  it("stays quiet for a path that matches no skill", async () => {
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "/");
    await screen.findByRole("listbox");
    type(box, "look in /usr");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("in a thread, leaves commands out and inserts the skill", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("please /pro", onSend));
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["/lotus-probe"]);
    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(editor.textContent).toBe("please /lotus-probe ");
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("please /lotus-probe", []));
  });
});

describe("@ files", () => {
  it("on the home, reads the folder once @ is typed and inserts the picked path", async () => {
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "fix @chatco");
    await screen.findByRole("listbox", { name: "Chats and files" });
    expect(box.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(value(box)).toBe("fix `src/modules/chat/ui/ChatComposer.tsx` ");
    expect(box.querySelector(".chat-mention")?.textContent).toBe("ChatComposer.tsx");
    expect(box.querySelector(".chat-mention")?.getAttribute("title")).toBe("`src/modules/chat/ui/ChatComposer.tsx`");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores e-mail addresses and closes on Escape", async () => {
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    type(box, "@app");
    await screen.findByRole("listbox", { name: "Chats and files" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    type(box, "mail me@app");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("in a thread, walks with the arrows and sends the path inline", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("see @a", onSend, []));
    await screen.findByRole("listbox", { name: "Chats and files" });
    const editor = screen.getByRole("textbox", { name: "Message" });
    // Name starts first: app.ts, then README.md (contains "a"). Down then Down wraps back.
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("see `src/app.ts`", []));
  });
});

describe("@ extras", () => {
  it("picks a folder as `path/`", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("in @sr", onSend));
    await screen.findByRole("listbox", { name: "Chats and files" });
    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("in `src/`", []));
  });
});

describe("@ chats", () => {
  it("names another chat (never this one) so the agent can read it", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("what did we say in @ingat", onSend));
    await screen.findByRole("listbox", { name: "Chats and files" });
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["ingat kata mango"]);
    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(editor, { key: "Enter" });
    // The editor shows a chip with the title; the agent gets the full mention.
    await waitFor(() => expect(editor.querySelector(".chat-mention")?.textContent).toBe("ingat kata mango"));
    expect(editor.querySelector(".chat-mention")?.getAttribute("data-kind")).toBe("chat");
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('what did we say in chat "ingat kata mango" (chatId m1)', []));
  });

  it("a bare @ shows recent chats above the files, in groups", async () => {
    render(composer("see @"));
    await screen.findByRole("listbox", { name: "Chats and files" });
    expect(screen.getByText("Chats")).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["ingat kata mango", "deploy notes", "app.ts", "src/", "README.md"]);
  });
});

describe("@ outside the chat folder", () => {
  it("lists ../ from the chat folder, opens a folder with Tab, and sends the full path", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("read @../", onSend));
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["bb/", "lotus/", "notes.md"]));
    fireEvent.keyDown(editor, { key: "Tab" });
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.querySelector(".chat-slash-name")?.textContent)).toEqual(["README.md"]));
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(editor.querySelector(".chat-mention")?.textContent).toBe("README.md"));
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("read `/w/bb/README.md`", []));
  });

  it("shows home as ~ on the chip", async () => {
    render(composer("in @~/Dow"));
    const editor = screen.getByRole("textbox", { name: "Message" });
    await screen.findByText("Downloads/");
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(editor.querySelector(".chat-mention")?.textContent).toBe("Downloads/"));
    expect(value(editor)).toBe("in `/Users/me/Downloads/` ");
  });

  it("says when nothing matches, and Enter still sends", async () => {
    const onSend = vi.fn(async () => {});
    render(composer("ping @nobody", onSend));
    const editor = screen.getByRole("textbox", { name: "Message" });
    await screen.findByText("No chat or file in this folder matches.");
    expect(editor.getAttribute("aria-activedescendant")).toBeNull();
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("ping @nobody", []));
  });

  it("Browse… puts any file in place of the typed @", async () => {
    dialog.picked = "/Users/me/Downloads/spec.pdf";
    render(composer("see @spec"));
    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.click(await screen.findByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(value(editor)).toBe("see `/Users/me/Downloads/spec.pdf` "));
    dialog.picked = null;
  });
});
