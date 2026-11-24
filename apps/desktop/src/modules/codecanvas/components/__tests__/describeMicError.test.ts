import { describe, it, expect } from "vitest";
import { describeMicError } from "../CanvasNlCommandBar";

// getUserMedia rejects with a DOMException (not always `instanceof Error` in WKWebView); the bar must
// surface the real cause instead of a generic "Microphone unavailable.".
describe("describeMicError", () => {
  it("maps a denied-permission DOMException to the macOS permission path", () => {
    expect(describeMicError({ name: "NotAllowedError", message: "Permission denied" })).toMatch(/System Settings/);
  });

  it("maps no-device and busy cases distinctly", () => {
    expect(describeMicError({ name: "NotFoundError" })).toMatch(/No microphone/);
    expect(describeMicError({ name: "NotReadableError" })).toMatch(/busy/);
  });

  it("surfaces a raw string error (Tauri invoke rejections) verbatim", () => {
    expect(describeMicError("Deepgram connect rejected (400): bad model")).toBe("Deepgram connect rejected (400): bad model");
  });

  it("falls back to the object message, then a generic line", () => {
    expect(describeMicError({ name: "WeirdError", message: "boom" })).toBe("boom");
    expect(describeMicError({})).toBe("Microphone unavailable.");
    expect(describeMicError(undefined)).toBe("Microphone unavailable.");
  });
});
