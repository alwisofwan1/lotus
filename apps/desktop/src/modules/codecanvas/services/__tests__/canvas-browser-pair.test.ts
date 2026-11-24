import { describe, expect, it } from "vitest";
import { resolveCanvasBrowserPairIdentity } from "../canvas-browser-pair";

describe("resolveCanvasBrowserPairIdentity", () => {
  it("uses parent terminal id as the native WebView id for paired browsers", () => {
    expect(resolveCanvasBrowserPairIdentity("browser-1", "term-1")).toEqual({
      browserNodeId: "browser-1",
      parentTerminalId: "term-1",
      nativeBrowserId: "term-1",
    });
  });

  it("uses browser node id as the native WebView id for standalone browsers", () => {
    expect(resolveCanvasBrowserPairIdentity("browser-1", null)).toEqual({
      browserNodeId: "browser-1",
      parentTerminalId: null,
      nativeBrowserId: "browser-1",
    });
  });
});
