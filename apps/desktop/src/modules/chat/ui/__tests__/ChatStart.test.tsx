import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatStart } from "../ChatStart";

type PickedFile = { path: string; name: string; size: number; isFile: boolean; isDirectory: boolean };
const picked = vi.hoisted(() => ({ files: [] as PickedFile[] }));
const saved = vi.hoisted(() => ({ threadIds: [] as string[] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => picked.files.map((f) => f.path) }));
vi.mock("@/lib/tauri/terminal-file-drop", () => ({ inspectTerminalFileDropPaths: async () => picked.files }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));
vi.mock("../../runtime/chat-runtime-client", () => ({
  attachmentPreview: () => new Promise(() => {}),
  listChatModels: async () => [{ value: "m1", label: "Model", provider: "p1", isDefault: true }],
  listSlashItems: async () => [],
  savePastedAttachment: async (threadId: string, file: File) => {
    saved.threadIds.push(threadId);
    return { kind: "image", path: `/state/${file.name}`, name: file.name, mimeType: "image/png", sizeBytes: file.size };
  },
}));

const file = (name: string, size = 10): PickedFile => ({ path: `/u/${name}`, name, size, isFile: true, isDirectory: false });
const draft = (runner: string) =>
  localStorage.setItem("lotus.chat.new", JSON.stringify({ runner, cwd: "/w/lotus", provider: runner === "api" ? "p1" : null }));

function renderStart() {
  const onStart = vi.fn(async () => {});
  render(<ChatStart recent={[]} stats={null} onStart={onStart} />);
  return onStart;
}

async function pick(files: PickedFile[]) {
  picked.files = files;
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  await screen.findByRole("list", { name: "Attached" });
}

describe("ChatStart attachments", () => {
  beforeEach(() => {
    localStorage.clear();
    saved.threadIds = [];
  });

  it("starts with the picked files, even with no text", async () => {
    draft("claude");
    const onStart = renderStart();
    await pick([file("shot.png"), file("notes.pdf")]);
    fireEvent.submit(screen.getByRole("textbox", { name: "Describe the task" }).closest("form")!);
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/w/lotus" }), "", [
      { kind: "image", path: "/u/shot.png", name: "shot.png", mimeType: "image/png", sizeBytes: 10 },
      { kind: "file", path: "/u/notes.pdf", name: "notes.pdf", mimeType: null, sizeBytes: 10 },
    ], expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it("keeps picked files across leaving the home and coming back, and drops them once started", async () => {
    draft("claude");
    renderStart();
    await pick([file("notes.pdf")]);
    cleanup();

    const onStart = renderStart();
    await screen.findByText("notes.pdf");
    fireEvent.submit(screen.getByRole("textbox", { name: "Describe the task" }).closest("form")!);
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    expect(localStorage.getItem("lotus.chat.draft.start:home")).toBeNull();
  });

  it("does not start while a file cannot go, until it is removed", async () => {
    draft("claude");
    const onStart = renderStart();
    await pick([file("notes.pdf"), file("phone.heic")]);
    const form = screen.getByRole("textbox", { name: "Describe the task" }).closest("form")!;
    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent).toBe("Remove what cannot be sent");
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove phone.heic" }));
    fireEvent.submit(form);
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledOnce());
  });

  it("saves a pasted image under one id before the chat exists", async () => {
    draft("claude");
    renderStart();
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    const image = new File(["x"], "paste.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [image], getData: () => "" } });
    fireEvent.paste(box, { clipboardData: { files: [new File(["y"], "two.png", { type: "image/png" })], getData: () => "" } });
    await vi.waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(saved.threadIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.threadIds[1]).toBe(saved.threadIds[0]);
  });

  it("turns off + for an API model, which takes text only", async () => {
    draft("api");
    renderStart();
    const plus = await screen.findByRole("button", { name: "Attach files" });
    await vi.waitFor(() => expect(plus).toHaveProperty("disabled", true));
    expect(plus.getAttribute("title")).toBe("API chats take text only");
  });
});
