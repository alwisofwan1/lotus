import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Interaction } from "../../domain/thread-event";
import type { InteractionState } from "../../domain/thread-state";
import { ChatComposer } from "../ChatComposer";

const base = { threadId: "thread-1", details: ["Opus 5.5", "Ask before edits"], onSend: vi.fn(), onStop: vi.fn(), waiting: [], cwd: "/w/lotus", onDecide: vi.fn() };
const running = { mode: "steer" as const, activity: "Ran git status" };
const waiting = (interaction: Interaction): InteractionState[] => [
  { interaction, turnId: "t", requestedAt: 0, resolution: null },
];

describe("ChatComposer", () => {
  it("shows no strip, no tray and the mic in Send's place when idle and empty", () => {
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Sent, not read yet" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
  });

  it("takes the cursor on mount and back after a send, but never from a field the user picked", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const other = document.body.appendChild(document.createElement("input"));
    const view = render(<ChatComposer {...base} onSend={onSend} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "hi", n: 1 }} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));

    // The send button leaves the cursor nowhere (WebKit does not focus a clicked button).
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));

    view.unmount();
    other.focus();
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} />);
    await screen.findByRole("textbox", { name: "Message" });
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("takes a fill into the editor without sending it", async () => {
    const onSend = vi.fn();
    render(<ChatComposer {...base} onSend={onSend} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "`bun test` failed\n\nFix it", n: 1 }} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" }).textContent).toContain("`bun test` failed"));
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("adds an appending fill after the user's draft instead of replacing it", async () => {
    const view = render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "my half-typed note", n: 1 }} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.textContent).toContain("my half-typed note"));
    view.rerender(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "Fix it", n: 2, append: true }} />);
    await waitFor(() => expect(editor.textContent).toContain("Fix it"));
    expect(editor.textContent).toContain("my half-typed note");
  });

  it("tells its owner a fill was used, so a remount does not bring it back", async () => {
    // The owner drops the fill on onFilled; before that, opening another chat and back refilled it.
    let fill: { text: string; n: number } | null = { text: "“lint” fails\n\nFix it", n: 1 };
    const onFilled = vi.fn(() => {
      fill = null;
    });
    const first = render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={fill} onFilled={onFilled} />);
    await waitFor(() => expect(onFilled).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={fill} onFilled={onFilled} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy());
    // Back once, as the unsent draft — not a second copy from the fill.
    expect(screen.getByRole("textbox", { name: "Message" }).textContent?.split("Fix it").length).toBe(2);
    expect(onFilled).toHaveBeenCalledTimes(1);
  });

  it("keeps unsent text and attachments across a remount, and drops them once sent", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const attachment = { kind: "file" as const, path: "/w/lotus/notes.md", name: "notes.md", mimeType: null, sizeBytes: 12 };
    const first = render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "half a thought", n: 1, attachments: [attachment] }} />);
    await screen.findByText("notes.md");
    first.unmount();

    // Opening another chat and coming back mounts a new composer for this thread.
    render(<ChatComposer {...base} onSend={onSend} status={{ mode: "send", activity: null }} unread={[]} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" }).textContent).toContain("half a thought"));
    expect(screen.getByText("notes.md")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("half a thought", [attachment]));
    await waitFor(() => expect(localStorage.getItem("lotus.chat.draft.thread-1")).toBeNull());
  });

  it("shows a pick from Preview, sends with it alone, and removes it with ×", () => {
    const onRemovePick = vi.fn();
    const pick = { id: "p1", url: "http://localhost:3000/login", selector: "form > button", tag: "button", text: "Sign in", images: [], box: null, attachments: [] };
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} picks={[pick]} onRemovePick={onRemovePick} />);
    expect(screen.getByText("localhost:3000/login · form > button")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Remove button Sign in" }));
    expect(onRemovePick).toHaveBeenCalledWith("p1");
  });

  it("marks the last quote on Backspace in an empty input, and removes it on the second", async () => {
    const onRemoveQuote = vi.fn();
    const quotes = [{ id: "q1", text: "first", at: 0 }, { id: "q2", text: "second", at: 0 }];
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} quotes={quotes} onRemoveQuote={onRemoveQuote} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(editor, { key: "Backspace" });
    await waitFor(() => expect(screen.getAllByRole("listitem").at(-1)?.hasAttribute("data-armed")).toBe(true));
    expect(onRemoveQuote).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Backspace" });
    expect(onRemoveQuote).toHaveBeenCalledWith("q2");
  });

  it("turns Send into Stop while a turn runs, and lists messages Claude has not read", () => {
    const onStop = vi.fn();
    render(
      <ChatComposer
        {...base}
        status={{ mode: "steer", activity: "Ran sleep 3 && echo step2" }}
        unread={[{ clientRequestId: "r", text: "Stop after this one", mode: "steer" }]}
        onStop={onStop}
      />,
    );
    // What the turn is doing shows in the timeline, not above the composer.
    expect(screen.queryByText("Ran sleep 3 && echo step2")).toBeNull();
    expect(screen.getByText("Stop after this one")).toBeTruthy();
    expect(screen.getByText("after this step")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("puts a waiting permission on top, one of N, and decides it with buttons", () => {
    const onDecide = vi.fn(async () => {});
    const bash: Interaction = {
      id: "i1",
      kind: "toolPermission",
      itemId: null,
      toolName: "Bash",
      input: { command: "git status --short" },
      blockedPath: null,
    };
    const second = { ...waiting(bash)[0], interaction: { ...bash, id: "i2" } };
    render(<ChatComposer {...base} status={running} unread={[]} waiting={[...waiting(bash), second]} onDecide={onDecide} />);
    expect(screen.getByText("Waiting for you")).toBeTruthy();
    expect(screen.getByText("Bash · 2 waiting")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Run a command?" })).toBeTruthy();
    expect(screen.getByText("1 of 2")).toBeTruthy();
    expect(screen.getByText("git status --short")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Steer" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("i1", { behavior: "deny", message: "The user denied this." });
    expect(screen.queryByRole("button", { name: "Allow for this session" })).toBeNull();
  });

  it("offers Allow for this session only where the request can keep it", () => {
    const onDecide = vi.fn(async () => {});
    const mcp: Interaction = { id: "m1", kind: "toolPermission", itemId: null, toolName: "mcp__lotus__lotus_chat_read", input: { chatId: "c1" }, blockedPath: null, remember: true };
    render(<ChatComposer {...base} status={running} unread={[]} waiting={waiting(mcp)} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(onDecide).toHaveBeenCalledWith("m1", { behavior: "allow", remember: true });
  });

  it("answers a multi-select question with the picked labels", () => {
    const onDecide = vi.fn(async () => {});
    const question: Interaction = {
      id: "q1",
      kind: "question",
      itemId: null,
      questions: [
        {
          question: "Which colours?",
          header: "Colour",
          options: [
            { label: "Red", description: null },
            { label: "Blue", description: "Calm" },
          ],
          multiSelect: true,
        },
      ],
    };
    render(<ChatComposer {...base} status={running} unread={[]} waiting={waiting(question)} onDecide={onDecide} />);
    const answer = screen.getByRole("button", { name: "Submit answer" });
    expect(answer).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Red" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Blue/ }));
    fireEvent.click(answer);
    expect(onDecide).toHaveBeenCalledWith("q1", { behavior: "allow", answers: { "Which colours?": "Red, Blue" } });
  });

  it("answers with the user's own words from Other…, and picks an option by its number key", () => {
    const onDecide = vi.fn(async () => {});
    const question: Interaction = {
      id: "q2",
      kind: "question",
      itemId: null,
      questions: [{ question: "Red or Blue?", header: "Colour", options: [{ label: "Red", description: null }, { label: "Blue", description: null }], multiSelect: false }],
    };
    render(<ChatComposer {...base} status={running} unread={[]} waiting={waiting(question)} onDecide={onDecide} />);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    fireEvent.keyDown(window, { key: "2" });
    expect(screen.getByRole("radio", { name: "Blue" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: /Other/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), { target: { value: "Green" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onDecide).toHaveBeenCalledWith("q2", { behavior: "allow", answers: { "Red or Blue?": "Green" } });
  });
});

const picked = vi.hoisted(() => ({ files: [] as Array<{ path: string; name: string; size: number; isFile: boolean; isDirectory: boolean }> }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => picked.files.map((f) => f.path) }));
vi.mock("@/lib/tauri/terminal-file-drop", () => ({ inspectTerminalFileDropPaths: async () => picked.files }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));
vi.mock("../../runtime/chat-runtime-client", () => ({ attachmentPreview: () => new Promise(() => {}), savePastedAttachment: vi.fn(), listSlashItems: async () => [] }));

describe("ChatComposer attachments", () => {
  const pick = async (files: typeof picked.files) => {
    picked.files = files;
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByRole("list", { name: "Attached" });
  };
  const file = (name: string, size = 10) => ({ path: `/u/${name}`, name, size, isFile: true, isDirectory: false });

  it("sends attachments without text", async () => {
    const onSend = vi.fn(async () => {});
    render(<ChatComposer {...base} onSend={onSend} status={{ mode: "send", activity: null }} unread={[]} />);
    await pick([file("shot.png"), file("notes.pdf")]);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", false);
    fireEvent.click(send);
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith("", [
      { kind: "image", path: "/u/shot.png", name: "shot.png", mimeType: "image/png", sizeBytes: 10 },
      { kind: "file", path: "/u/notes.pdf", name: "notes.pdf", mimeType: null, sizeBytes: 10 },
    ]);
  });

  it("puts back the files of a first message that could not be sent", async () => {
    const attachments = [{ kind: "file" as const, path: "/u/notes.pdf", name: "notes.pdf", mimeType: null, sizeBytes: 10 }];
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} fill={{ text: "Read this", n: 1, attachments }} />);
    await screen.findByRole("list", { name: "Attached" });
    expect(screen.getByText("notes.pdf")).toBeTruthy();
  });

  it("keeps Send off while an attachment cannot go, until it is removed", async () => {
    render(<ChatComposer {...base} status={{ mode: "send", activity: null }} unread={[]} />);
    await pick([file("notes.pdf"), file("phone.heic")]);
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Remove phone.heic" }));
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
  });
});
