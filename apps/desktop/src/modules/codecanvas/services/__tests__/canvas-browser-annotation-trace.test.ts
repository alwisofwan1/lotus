import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractAnnotationTraceId, formatAnnotationTrace, logAnnotationTrace } from "../canvas-browser-annotation-trace";

const tauriMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  logCanvasBrowserAnnotationTrace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: tauriMocks.isTauri,
}));

vi.mock("@/lib/tauri/canvas-browser", () => ({
  logCanvasBrowserAnnotationTrace: tauriMocks.logCanvasBrowserAnnotationTrace,
}));

describe("canvas-browser-annotation-trace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriMocks.isTauri.mockReturnValue(false);
  });

  it("always logs the trace line to the browser console", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    logAnnotationTrace("[canvas][annotation-trace] path=frontend-route terminal=t id=a detail=sent");

    expect(debugSpy).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=t id=a detail=sent",
    );
    expect(tauriMocks.logCanvasBrowserAnnotationTrace).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("also relays the trace line into the Rust dev terminal when running inside Tauri", () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    tauriMocks.isTauri.mockReturnValue(true);

    logAnnotationTrace("[canvas][annotation-trace] path=frontend-hook terminal=t id=a detail=accepted");

    expect(tauriMocks.logCanvasBrowserAnnotationTrace).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-hook terminal=t id=a detail=accepted",
    );
  });
  it("formats a grep-friendly trace line shared across every delivery path", () => {
    expect(formatAnnotationTrace("frontend-route", "term-1", "annotation-1", "sent")).toBe(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=sent",
    );
  });

  it("extracts the annotation's own id from a raw payload string", () => {
    expect(extractAnnotationTraceId('{"action":"selected","id":"annotation-1"}')).toBe("annotation-1");
  });

  it("falls back to a dash for malformed or id-less payloads", () => {
    expect(extractAnnotationTraceId("not json")).toBe("-");
    expect(extractAnnotationTraceId('{"action":"selected"}')).toBe("-");
    expect(extractAnnotationTraceId('{"id":123}')).toBe("-");
  });
});
