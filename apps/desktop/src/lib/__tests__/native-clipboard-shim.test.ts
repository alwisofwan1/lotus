import { describe, expect, it, vi } from "vitest";
import { installNativeClipboardShim } from "../native-clipboard-shim";

function fakeClipboard() {
  return {
    write: vi.fn().mockRejectedValue(new DOMException("refused", "NotAllowedError")),
    writeText: vi.fn().mockRejectedValue(new DOMException("refused", "NotAllowedError")),
  } as unknown as Clipboard;
}

/** A ClipboardItem whose text arrives later, as Monaco's pre-armed write builds it. */
function pendingItem() {
  let resolve!: (text: string) => void;
  let reject!: (reason: unknown) => void;
  const text = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  const item = { types: ["text/plain"], getType: () => text } as unknown as ClipboardItem;
  return { item, resolve, reject };
}

describe("installNativeClipboardShim", () => {
  it("sends writeText to the native plugin instead of WebKit", async () => {
    const clipboard = fakeClipboard();
    const invoke = vi.fn().mockResolvedValue(undefined);
    installNativeClipboardShim({ clipboard, invoke, inTauri: () => true });
    await clipboard.writeText("hello");
    expect(invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", { text: "hello" });
  });

  it("copies Monaco's pre-armed write once its text arrives", async () => {
    const clipboard = fakeClipboard();
    const invoke = vi.fn().mockResolvedValue(undefined);
    installNativeClipboardShim({ clipboard, invoke, inTauri: () => true });
    const { item, resolve } = pendingItem();
    const done = clipboard.write([item]);
    expect(invoke).not.toHaveBeenCalled();
    resolve("selected text");
    await done;
    expect(invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", { text: "selected text" });
  });

  it("drops a cancelled pre-armed write without rejecting (no NotAllowedError log)", async () => {
    const clipboard = fakeClipboard();
    const invoke = vi.fn();
    installNativeClipboardShim({ clipboard, invoke, inTauri: () => true });
    const { item, reject } = pendingItem();
    const done = clipboard.write([item]);
    reject(new Error("Canceled"));
    await expect(done).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves non-text writes and plain browsers alone", async () => {
    const clipboard = fakeClipboard();
    const original = clipboard.write;
    installNativeClipboardShim({ clipboard, invoke: vi.fn(), inTauri: () => false });
    expect(clipboard.write).toBe(original);

    const tauriClipboard = fakeClipboard();
    const browserWrite = tauriClipboard.write;
    installNativeClipboardShim({ clipboard: tauriClipboard, invoke: vi.fn(), inTauri: () => true });
    const image = { types: ["image/png"], getType: vi.fn() } as unknown as ClipboardItem;
    await expect(tauriClipboard.write([image])).rejects.toThrow("refused");
    expect(browserWrite).toHaveBeenCalledWith([image]);
  });
});
