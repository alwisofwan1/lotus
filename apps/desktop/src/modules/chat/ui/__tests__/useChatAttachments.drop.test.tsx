import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatStart } from "../ChatStart";
import { useChatAttachments } from "../useChatAttachments";

type Payload = { type: "enter" | "over" | "drop"; position: { x: number; y: number }; paths?: string[] } | { type: "leave" };
let fire: (payload: Payload) => Promise<void> = async () => {};

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true, tauriInvoke: async () => [] }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ scaleFactor: async () => 1 }) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({}) }));
vi.mock("@/lib/tauri-listener-cleanup", () => ({
  safeTauriUnlisten: () => {},
  listenWebviewDragDrop: async (_: unknown, handler: (event: { payload: Payload }) => Promise<void>) => {
    fire = (payload) => handler({ payload });
    return () => {};
  },
}));
vi.mock("@/lib/tauri/terminal-file-drop", () => ({
  inspectTerminalFileDropPaths: async (paths: string[]) => {
    if (paths.some((p) => p.includes("gone"))) throw new Error("No such file or directory");
    return [{ path: "/shot.png", name: "shot.png", size: 10, isFile: true, isDirectory: false }];
  },
}));
vi.mock("../../runtime/chat-runtime-client", () => ({ savePastedAttachment: vi.fn(), attachmentPreview: () => new Promise(() => {}), listChatModels: async () => [], listSlashItems: async () => [] }));

function setup() {
  const anchor = document.createElement("form");
  document.body.append(anchor);
  anchor.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) });
  const ref = { current: anchor }; // stable, like the callers' useRef
  return renderHook(() => useChatAttachments({ threadId: "t", anchor: ref }));
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

describe("useChatAttachments drop", () => {
  it("focuses the new chat editor after a file is dropped", async () => {
    localStorage.setItem("lotus.chat.new", JSON.stringify({ runner: "claude", cwd: "/w" }));
    render(<ChatStart recent={[]} stats={null} onStart={vi.fn()} />);
    const box = screen.getByRole("textbox", { name: "Describe the task" });
    const form = box.closest("form")!;
    form.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) });
    await settle();
    (document.activeElement as HTMLElement)?.blur();
    await act(() => fire({ type: "drop", position: { x: 10, y: 10 }, paths: ["/shot.png"] }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Attached" })).toBeTruthy());
    expect(document.activeElement).toBe(box);
  });

  it("marks a restored attachment whose file is gone, and blocks sending until it is removed", async () => {
    const anchor = { current: document.createElement("form") };
    const file = (path: string) => ({ kind: "file" as const, path, name: path.slice(1), mimeType: null, sizeBytes: 1 });
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, initial: [file("/here.md"), file("/gone.md")] }));
    await waitFor(() => expect(result.current.blocked).toBe(true));
    expect(result.current.drafts.map((d) => d.problem)).toEqual([null, "File no longer exists · remove it"]);
    act(() => result.current.remove("/gone.md"));
    expect(result.current.blocked).toBe(false);
  });

  it("a late `over` never brings the overlay back after `leave`", async () => {
    const { result } = setup();
    await settle();
    await act(async () => {
      const late = fire({ type: "over", position: { x: 10, y: 10 } });
      await fire({ type: "leave" });
      await late;
    });
    expect(result.current.dropping).toBe(false);
  });

  it("clears the overlay when the pointer moves with no drag going on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = setup();
    await settle();
    await act(() => fire({ type: "over", position: { x: 10, y: 10 } }));
    expect(result.current.dropping).toBe(true);

    act(() => void window.dispatchEvent(new Event("pointermove")));
    expect(result.current.dropping).toBe(true); // still mid-drag

    vi.advanceTimersByTime(300);
    act(() => void window.dispatchEvent(new Event("pointermove")));
    expect(result.current.dropping).toBe(false);
    vi.useRealTimers();
  });
});
