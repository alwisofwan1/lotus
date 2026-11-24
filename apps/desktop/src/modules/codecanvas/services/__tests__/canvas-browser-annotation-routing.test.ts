import { describe, expect, it, vi } from "vitest";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import { routeCanvasBrowserAnnotationToTerminal } from "../canvas-browser-annotation-routing";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "selected",
    id: "annotation-1",
    agentId: "terminal:term-1",
    url: "https://example.com",
    title: "Example",
    selector: "button.primary",
    breadcrumb: ["main", "section.hero"],
    label: "button: Deploy",
    text: "Deploy",
    message: "Make this clearer",
    dimensions: { width: 120, height: 32 },
    computedStyles: { color: "rgb(255, 255, 255)" },
    reactComponent: "DeployButton",
    classes: ["primary", "rounded"],
    summary: ["actions: Deploy"],
    outerHTML: "<button>Deploy</button>",
    boundingBox: { x: 10, y: 20, width: 120, height: 32 },
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 120 },
    createdAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  });
}

describe("canvas-browser-annotation-routing", () => {
  // Verify-first instrumentation (Slice 0): a grep-friendly trace line, keyed by
  // terminal + annotation id, so a live repro can be correlated against the two
  // Rust-side delivery paths (nav-scheme, IPC) which emit the same trace shape.
  it("traces the resolved terminal and immediate-send decision", () => {
    const log = vi.fn();

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal: vi.fn(),
      getStatus: () => "live",
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=sent",
    );
  });

  it("traces a queued decision and the later delivered-from-queue transition", () => {
    const log = vi.fn();
    let statusListener: (status: TerminalRuntimeStatus) => void = () => {};

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal: vi.fn(),
      getStatus: () => "starting",
      subscribeStatus: (_paneId, cb) => {
        statusListener = cb;
        return vi.fn();
      },
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=queued",
    );

    statusListener("live");

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=sent",
    );
  });

  it("traces a terminal-exited failure when the terminal is already closed", () => {
    const log = vi.fn();

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal: vi.fn(),
      getStatus: () => "exited",
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=failed:terminal-exited",
    );
  });

  it("traces a delivery-timeout failure for queued annotations that never become writable", () => {
    const log = vi.fn();
    let timeoutCallback: () => void = () => {};

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal: vi.fn(),
      getStatus: () => "idle",
      subscribeStatus: (_paneId, cb) => {
        cb("idle");
        return vi.fn();
      },
      setTimer: vi.fn((callback) => {
        timeoutCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
      log,
    });

    timeoutCallback();

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=term-1 id=annotation-1 detail=failed:delivery-timeout",
    );
  });

  it("traces a missing-terminal failure for standalone browser nodes, still identifying which annotation was dropped", () => {
    const log = vi.fn();

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: null,
      payload: payload(),
      writeToTerminal: vi.fn(),
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=- id=annotation-1 detail=failed:missing-terminal",
    );
  });

  it("traces a missing-terminal failure with a dash id when the payload has none to extract", () => {
    const log = vi.fn();

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: null,
      payload: "not json",
      writeToTerminal: vi.fn(),
      log,
    });

    expect(log).toHaveBeenCalledWith(
      "[canvas][annotation-trace] path=frontend-route terminal=- id=- detail=failed:missing-terminal",
    );
  });

  it("formats a captured browser annotation and submits it to the wired terminal", () => {
    const writeToTerminal = vi.fn();

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal,
      getStatus: () => "live",
    });

    expect(result).toMatchObject({ ok: true, delivery: "sent", annotationId: "annotation-1" });
    expect(writeToTerminal).toHaveBeenCalledOnce();
    expect(writeToTerminal).toHaveBeenCalledWith(
      "term-1",
      expect.stringContaining(`selector="button.primary"`),
      expect.objectContaining({
        origin: "programmatic",
        intent: "conversation-prompt",
        submitted: true,
        promptText: expect.stringContaining("Make this clearer"),
      }),
    );
    const submitted = String(writeToTerminal.mock.calls[0]?.[1] ?? "");
    expect(submitted).toContain("\u001b[200~");
    expect(submitted).toContain("\u001b[201~\r");
    expect(submitted).toContain('<pick page="https://example.com" selector="button.primary"');
    expect(submitted).toContain("\n\nMake this clearer");
    expect(submitted).toContain('text="Deploy"');
    expect(submitted).toContain('box="10,20 120x32"');
  });

  it("carries the crop rect through so a caller can request a cropped follow-up screenshot", () => {
    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload({
        boundingBox: { x: 653, y: 136, width: 373, height: 210 },
        viewport: { width: 1438, height: 785, scrollX: 0, scrollY: 0 },
      }),
      writeToTerminal: vi.fn(),
      getStatus: () => "live",
    });

    if (!result.ok) throw new Error("expected ok result");
    expect(result.cropRect).not.toBeNull();
    expect(result.cropRect!.width).toBeCloseTo(373, 1);
  });

  it("does not submit standalone browser annotations without a wired terminal", () => {
    const writeToTerminal = vi.fn();

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: null,
      payload: payload(),
      writeToTerminal,
    });

    expect(result).toEqual({ ok: false, reason: "missing-terminal" });
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("ignores metadata-only visual attachment navigation follow-ups so one selection is not submitted twice", () => {
    const writeToTerminal = vi.fn();

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload({ visualAttachments: [{ name: "annotation.png", mimeType: "image/png" }] }),
      writeToTerminal,
    });

    expect(result).toEqual({ ok: false, reason: "attachment-metadata-only" });
    expect(writeToTerminal).not.toHaveBeenCalled();
  });

  it("includes persisted selected image paths in the terminal context", () => {
    const writeToTerminal = vi.fn();

    routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload({ visualAttachments: [{ name: "google.png", mimeType: "image/png", path: "/tmp/google.png" }] }),
      writeToTerminal,
      getStatus: () => "live",
    });

    expect(writeToTerminal).toHaveBeenCalledWith(
      "term-1",
      expect.stringContaining(`picture="/tmp/google.png"`),
      expect.any(Object),
    );
  });

  it("queues delivery until the terminal runtime becomes live", () => {
    const writeToTerminal = vi.fn();
    const onDelivery = vi.fn();
    let statusListener: (status: TerminalRuntimeStatus) => void = () => {};
    const unsubscribe = vi.fn();

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "term-1",
      payload: payload(),
      writeToTerminal,
      onDelivery,
      getStatus: () => "starting",
      subscribeStatus: (_paneId, cb) => {
        statusListener = cb;
        cb("starting");
        return unsubscribe;
      },
      setTimer: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
      clearTimer: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, delivery: "queued", annotationId: "annotation-1" });
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: "queued", terminalId: "term-1" }));
    expect(writeToTerminal).not.toHaveBeenCalled();

    statusListener("live");

    expect(writeToTerminal).toHaveBeenCalledOnce();
    expect(onDelivery).toHaveBeenLastCalledWith(expect.objectContaining({ state: "sent", terminalId: "term-1" }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("recovers the live runtime pane from canvasTerminalId when the preferred target is stale", () => {
    const writeToTerminal = vi.fn();

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "stale-runtime-id",
      canvasTerminalId: "term-1",
      payload: payload(),
      writeToTerminal,
      getStatus: (paneId) => paneId === "canvas:project:term-1" ? "live" : "idle",
      getSessions: () => [{
        paneId: "canvas:project:term-1",
        workspaceId: "canvas:project",
        status: "live",
        canvasTerminalId: "term-1",
      }],
    });

    expect(result).toMatchObject({ ok: true, delivery: "sent" });
    expect(writeToTerminal).toHaveBeenCalledWith(
      "canvas:project:term-1",
      expect.stringContaining("<picked-elements>"),
      expect.any(Object),
    );
  });

  it("marks queued delivery failed when the runtime target never becomes writable", () => {
    const writeToTerminal = vi.fn();
    const onDelivery = vi.fn();
    const unsubscribe = vi.fn();
    let timeoutCallback: () => void = () => {};

    const result = routeCanvasBrowserAnnotationToTerminal({
      terminalId: "stale-node-id",
      payload: payload(),
      writeToTerminal,
      onDelivery,
      getStatus: () => "idle",
      subscribeStatus: (_paneId, cb) => {
        cb("idle");
        return unsubscribe;
      },
      setTimer: vi.fn((callback) => {
        timeoutCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, delivery: "queued" });
    timeoutCallback();

    expect(writeToTerminal).not.toHaveBeenCalled();
    expect(onDelivery).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "failed",
      terminalId: "stale-node-id",
      reason: "delivery-timeout",
    }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
