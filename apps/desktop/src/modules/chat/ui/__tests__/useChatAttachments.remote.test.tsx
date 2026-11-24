import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "../../domain/thread-event";
import { useChatAttachments } from "../useChatAttachments";

const upload = vi.fn<(threadId: string, a: Attachment, onProgress?: (percent: number) => void) => Promise<Attachment>>();
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false, tauriInvoke: async () => [] }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("../../runtime/chat-runtime-client", () => ({ savePastedAttachment: vi.fn(), uploadAttachment: (t: string, a: Attachment, p?: (percent: number) => void) => upload(t, a, p) }));

const file = (path: string, sizeBytes = 3): Attachment => ({ kind: "file", path, name: path.slice(1), mimeType: null, sizeBytes });
const anchor = { current: null };

beforeEach(() => {
  upload.mockReset();
});

describe("useChatAttachments on another machine (ADR-0069)", () => {
  it("copies each file as it is added, and sending waits for the copy", async () => {
    let done: (a: Attachment) => void = () => {};
    upload.mockImplementation(() => new Promise((r) => (done = r)));
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, remote: "now" }));
    act(() => result.current.restore([file("/a.txt")]));
    await waitFor(() => expect(result.current.copying).toBe(true));
    await act(async () => done({ ...file("/a.txt"), remote: "/h/t/ab.txt" }));
    expect(result.current.copying).toBe(false);
    expect(result.current.attachments[0].remote).toBe("/h/t/ab.txt");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("shows how far the copy has got", async () => {
    let progress: (percent: number) => void = () => {};
    upload.mockImplementation((_t, _a, p) => {
      progress = p ?? progress;
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, remote: "now" }));
    act(() => result.current.restore([file("/a.txt")]));
    await waitFor(() => expect(result.current.drafts[0].pending).toBe("Copying…"));
    act(() => progress(42));
    expect(result.current.drafts[0].pending).toBe("Copying 42%");
  });

  it("shows the host's refusal, and keeps waiting while the machine is down", async () => {
    upload.mockImplementation(async (_t, a) => {
      throw new Error(a.path === "/down.txt" ? "waiting for vps · refused" : "a.txt arrived damaged; send it again");
    });
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, remote: "now" }));
    act(() => result.current.restore([file("/a.txt"), file("/down.txt")]));
    await waitFor(() => expect(result.current.drafts[0].problem).toBe("a.txt arrived damaged; send it again"));
    await waitFor(() => expect(result.current.drafts[1].pending).toBe("Waiting for the machine…"));
    expect(result.current.drafts[1].problem).toBeNull();
  });

  it("says nothing when the file picker is cancelled", async () => {
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, remote: "now" }));
    await act(async () => result.current.pick());
    expect(result.current.error).toBeNull();
  });

  it("leaves the copy to the send on a new chat, but still refuses a file too large", () => {
    const { result } = renderHook(() => useChatAttachments({ threadId: "t", anchor, remote: "on-send" }));
    act(() => result.current.restore([file("/big.log", 11 * 1024 * 1024)]));
    expect(result.current.drafts[0].problem).toBe("Too large · max 10 MB on another machine");
    expect(upload).not.toHaveBeenCalled();
  });
});
