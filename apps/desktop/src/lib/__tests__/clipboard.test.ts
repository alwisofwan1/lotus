import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../clipboard";

describe("copyTextToClipboard", () => {
  it("uses the native plugin inside Tauri and never touches the browser API", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const browserWrite = vi.fn();
    await copyTextToClipboard("/a/b.txt", { invoke, inTauri: () => true, browserWrite });
    expect(invoke).toHaveBeenCalledWith("plugin:clipboard-manager|write_text", { text: "/a/b.txt" });
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it("falls back to the browser API when the plugin refuses", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("denied"));
    const browserWrite = vi.fn().mockResolvedValue(undefined);
    await copyTextToClipboard("x", { invoke, inTauri: () => true, browserWrite });
    expect(browserWrite).toHaveBeenCalledWith("x");
  });

  it("rejects when both paths refuse (WKWebView NotAllowedError)", async () => {
    const notAllowed = new DOMException("The request is not allowed", "NotAllowedError");
    await expect(copyTextToClipboard("x", {
      invoke: vi.fn().mockRejectedValue(new Error("denied")),
      inTauri: () => true,
      browserWrite: vi.fn().mockRejectedValue(notAllowed),
    })).rejects.toBe(notAllowed);
  });
});
