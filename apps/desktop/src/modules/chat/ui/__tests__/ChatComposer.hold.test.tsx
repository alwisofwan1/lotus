import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Attachment } from "../../domain/thread-event";
import { ChatComposer } from "../ChatComposer";

// Send pressed before the message can go holds it, and it leaves by itself (mockups/chat-composer-states.html).

const upload = vi.hoisted(() => ({ finish: null as null | ((a: Attachment) => void), progress: null as null | ((p: number) => void) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => ["/u/notes.pdf"] }));
vi.mock("@/lib/tauri/terminal-file-drop", () => ({
  inspectTerminalFileDropPaths: async () => [{ path: "/u/notes.pdf", name: "notes.pdf", size: 100, isFile: true, isDirectory: false }],
}));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));
vi.mock("../../runtime/chat-runtime-client", () => ({
  attachmentPreview: () => new Promise(() => {}),
  savePastedAttachment: vi.fn(),
  listSlashItems: async () => [],
  uploadAttachment: (_thread: string, attachment: Attachment, onProgress: (p: number) => void) =>
    new Promise<Attachment>((resolve) => {
      upload.progress = onProgress;
      upload.finish = () => resolve({ ...attachment, remote: "/srv/.lotus/notes.pdf" });
    }),
}));

const base = { threadId: "thread-1", details: [], onStop: vi.fn(), waiting: [], cwd: "/srv/app", onDecide: vi.fn(), unread: [] };
const idle = { mode: "send" as const, activity: null };

describe("ChatComposer holds a send until it can go", () => {
  it("holds a message while the machine is away and sends it once it answers", async () => {
    const onSend = vi.fn(async () => {});
    const view = render(<ChatComposer {...base} onSend={onSend} status={idle} offline fill={{ text: "deploy it", n: 1 }} />);
    const send = await screen.findByRole("button", { name: "Send" });
    expect(send).toHaveProperty("disabled", false);
    fireEvent.click(send);
    expect(screen.getByRole("status").textContent).toContain("Sends as a new message when the machine answers again");
    expect(screen.getByRole("button", { name: "Cancel send" })).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    view.rerender(<ChatComposer {...base} onSend={onSend} status={idle} fill={{ text: "deploy it", n: 1 }} />);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("deploy it", []));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("lets go of a held message with Cancel, so nothing goes later", async () => {
    const onSend = vi.fn(async () => {});
    const view = render(<ChatComposer {...base} onSend={onSend} status={idle} offline fill={{ text: "deploy it", n: 1 }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<ChatComposer {...base} onSend={onSend} status={idle} fill={{ text: "deploy it", n: 1 }} />);
    await act(async () => {});
    expect(onSend).not.toHaveBeenCalled();
  });

  it("fills the ring as the copy goes and sends the copy once it is there", async () => {
    const onSend = vi.fn(async () => {});
    render(<ChatComposer {...base} onSend={onSend} status={idle} remote fill={{ text: "read this", n: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(upload.progress).not.toBeNull());
    act(() => upload.progress!(40));
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.getAttribute("data-waiting")).toBe("copy");
    expect(send.style.getPropertyValue("--chat-send-progress")).toBe("40%");
    expect(screen.getByText("Copying 40%")).toBeTruthy();
    fireEvent.click(send);
    expect(screen.getByRole("status").textContent).toContain("Sends as a new message when the attachments are copied");
    expect(onSend).not.toHaveBeenCalled();
    act(() => upload.finish!({} as Attachment));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith("read this", [expect.objectContaining({ name: "notes.pdf", remote: "/srv/.lotus/notes.pdf" })]);
  });

  it("says live how a held message will go, as the turn it waits on changes", async () => {
    const props = { ...base, onSend: vi.fn(async () => {}), offline: true, fill: { text: "use vitest", n: 1 } };
    const view = render(<ChatComposer {...props} status={{ mode: "steer", activity: "Ran tests" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Steer" }));
    expect(screen.getByRole("status").textContent).toContain("Sends as Steer when the machine answers again");
    view.rerender(<ChatComposer {...props} status={idle} />);
    expect(screen.getByRole("status").textContent).toContain("Sends as a new message when the machine answers again");
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("names the action on the button while a turn runs", async () => {
    render(<ChatComposer {...base} onSend={vi.fn()} status={{ mode: "queue", activity: "Writing a reply" }} fill={{ text: "also check CI", n: 1 }} />);
    const queue = await screen.findByRole("button", { name: "Queue" });
    expect(queue.textContent).toContain("Queue");
    expect(queue.getAttribute("title")).toBe("Read when this reply ends, or after its next step");
  });
});
