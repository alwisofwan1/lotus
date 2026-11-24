import { fireEvent, render, screen } from "@testing-library/react";
import type { Ref } from "react";
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => <div data-testid="node-resizer" />,
  };
});

let mockLodTier: "full" | "glyph" | "overview" = "full";
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => mockLodTier,
}));

const browserAnnotationHookMock = vi.hoisted(() => vi.fn(() => ({ annotationActive: false, toggleAnnotation: vi.fn() })));
const browserTitleChangedHookMock = vi.hoisted(() => vi.fn());
const routeAnnotationMock = vi.hoisted(() => vi.fn());
const routeAgentAnnotationMock = vi.hoisted(() => vi.fn());
const agentReplyRegistryGetMock = vi.hoisted(() => vi.fn());
const augmentAnnotationPayloadMock = vi.hoisted(() => vi.fn());

vi.mock("@/modules/codecanvas/hooks/useCanvasBrowserAnnotation", () => ({
  useCanvasBrowserAnnotation: browserAnnotationHookMock,
}));

vi.mock("@/modules/codecanvas/hooks/useCanvasBrowserTitleChanged", () => ({
  useCanvasBrowserTitleChanged: browserTitleChangedHookMock,
}));

vi.mock("@/modules/codecanvas/services/canvas-browser-annotation-routing", () => ({
  routeCanvasBrowserAnnotationToTerminal: routeAnnotationMock,
}));

vi.mock("@/modules/codecanvas/services/canvas-browser-annotation-agent-routing", () => ({
  routeCanvasBrowserAnnotationToAgent: routeAgentAnnotationMock,
}));

vi.mock("@/modules/codecanvas/services/agent-reply-registry", () => ({
  agentReplyRegistry: { get: agentReplyRegistryGetMock },
}));

vi.mock("@/lib/tauri/canvas-browser", () => ({
  focusCanvasMainWebview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/modules/codecanvas/services/canvas-browser-annotation-screenshot-merge", () => ({
  augmentAnnotationPayloadWithScreenshot: augmentAnnotationPayloadMock,
}));

vi.mock("@/modules/codecanvas/hooks/useCanvasBrowserNode", () => ({
  useCanvasBrowserNode: vi.fn(() => ({
    containerRef: { current: null },
    browserState: "active",
    currentUrl: "https://example.com",
    openBrowser: vi.fn(),
    closeBrowser: vi.fn(),
    navigateBrowser: vi.fn(),
    reloadBrowser: vi.fn(),
    backBrowser: vi.fn(),
    forwardBrowser: vi.fn(),
    syncBounds: vi.fn(),
    nativeViewSuspended: false,
  })),
}));

vi.mock("../nodes/BrowserNodeCard", () => ({
  BrowserNodeCard: ({
    containerRef,
    nativeViewSuspended,
    onClose,
    onNavigate,
  }: {
    containerRef: Ref<HTMLDivElement>;
    nativeViewSuspended: boolean;
    onClose: () => void;
    onNavigate: (url: string) => void;
  }) => (
    <div ref={containerRef} data-testid="browser-card" data-native-suspended={String(nativeViewSuspended)}>
      <button type="button" onClick={() => onNavigate("https://next.example")}>Navigate</button>
      <button type="button" onClick={onClose}>Close browser</button>
    </div>
  ),
}));

import { useCanvasBrowserNode } from "@/modules/codecanvas/hooks/useCanvasBrowserNode";
import { BrowserNode } from "../nodes/BrowserNode";
import type { CanvasBrowserAnnotationEntry } from "@/modules/codecanvas/services/canvas-browser-annotation";
import type { CanvasBrowserNodeData } from "../../types/canvas";

type CanvasBrowserAnnotationCaptureOptions = {
  nativeBrowserId: string;
  onAnnotationCaptured: (entry: CanvasBrowserAnnotationEntry) => void;
};

type CanvasBrowserTitleChangedOptions = {
  nativeBrowserId: string;
  onTitleChanged: (title: string) => void;
};

function latestAnnotationOptions(): CanvasBrowserAnnotationCaptureOptions {
  const calls = browserAnnotationHookMock.mock.calls as unknown as Array<[CanvasBrowserAnnotationCaptureOptions]>;
  const options = calls.at(-1)?.[0];
  if (!options) throw new Error("Expected useCanvasBrowserAnnotation options");
  return options;
}

function latestTitleChangedOptions(): CanvasBrowserTitleChangedOptions {
  const calls = browserTitleChangedHookMock.mock.calls as unknown as Array<[CanvasBrowserTitleChangedOptions]>;
  const options = calls.at(-1)?.[0];
  if (!options) throw new Error("Expected useCanvasBrowserTitleChanged options");
  return options;
}

function makeProps(overrides?: Partial<CanvasBrowserNodeData>): Parameters<typeof BrowserNode>[0] {
  return {
    id: "browser-1",
    data: {
      browserNumber: 1,
      url: "https://example.com",
      state: "active",
      parentTerminalId: null,
      onClose: vi.fn(),
      onNavigate: vi.fn(),
      onConnect: vi.fn(),
      ...overrides,
    },
    selected: false,
    dragging: false,
  } as unknown as Parameters<typeof BrowserNode>[0];
}

describe("BrowserNode LOD", () => {
  beforeEach(() => {
    mockLodTier = "full";
    vi.clearAllMocks();
    browserAnnotationHookMock.mockReturnValue({ annotationActive: false, toggleAnnotation: vi.fn() });
    routeAnnotationMock.mockReturnValue({ ok: true, delivery: "sent", annotationId: "annotation-1", context: "context", resolvedTargetId: "term-1", cropRect: null });
    agentReplyRegistryGetMock.mockReturnValue(undefined);
    // Identity passthrough by default: unrelated routing tests don't care about the merge step.
    augmentAnnotationPayloadMock.mockReset().mockImplementation(async (payload: string) => payload);
  });

  it("keeps the native browser view active at full detail", () => {
    render(<BrowserNode {...makeProps()} />);

    expect(screen.getByTestId("browser-card")).toBeInTheDocument();
    const calls = vi.mocked(useCanvasBrowserNode).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.at(-1)?.[0]).toMatchObject({ suspendNativeView: false });
  });

  it("emits browser commands through the node command seam", () => {
    const dispatchCommand = vi.fn();
    render(<BrowserNode {...makeProps({ state: "loading", dispatchCommand, onClose: undefined, onNavigate: undefined, onConnect: undefined })} />);

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-browser", nodeId: "browser-1", patch: { state: "active" } });

    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));

    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-browser", nodeId: "browser-1", patch: { url: "https://next.example" } });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "browser-1" });
  });

  it("stores automatic page titles separately from explicit labels", () => {
    const dispatchCommand = vi.fn();
    render(<BrowserNode {...makeProps({
      label: "Agent Name",
      dispatchCommand,
    })} />);

    const options = latestTitleChangedOptions();
    expect(options.nativeBrowserId).toBe("browser-1");
    options.onTitleChanged("Page Title");

    expect(dispatchCommand).toHaveBeenCalledWith({
      kind: "patch-browser",
      nodeId: "browser-1",
      patch: { pageTitle: "Page Title" },
    });
    expect(dispatchCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: { label: "Page Title" },
    }));
  });

  it("does not repeatedly patch active state when the node record is already active", () => {
    const dispatchCommand = vi.fn();
    render(<BrowserNode {...makeProps({ state: "active", dispatchCommand, onClose: undefined, onNavigate: undefined, onConnect: undefined })} />);

    expect(dispatchCommand).not.toHaveBeenCalledWith({ kind: "patch-browser", nodeId: "browser-1", patch: { state: "active" } });
  });

  it("parks the native browser view and renders a map glyph at overview", () => {
    mockLodTier = "overview";
    const { container } = render(<BrowserNode {...makeProps()} />);

    expect(screen.queryByTestId("browser-card")).not.toBeInTheDocument();
    expect(container.querySelector(".canvas-node")).toHaveAttribute("data-lod", "overview");
    expect(container.querySelector(".canvas-node-glyph")).toBeInTheDocument();
    const calls = vi.mocked(useCanvasBrowserNode).mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls.at(-1)?.[0]).toMatchObject({ suspendNativeView: true });
  });

  it("routes a native annotation to the paired terminal", async () => {
    render(<BrowserNode {...makeProps({ parentTerminalId: "term-1", parentRuntimePaneId: "canvas:project:term-1" })} />);

    const options = latestAnnotationOptions();
    expect(options).toMatchObject({ nativeBrowserId: "term-1" });

    await options.onAnnotationCaptured({
      terminalId: "term-1",
      payload: "{\"action\":\"selected\"}",
      capturedAt: 1,
      source: "native",
    });

    expect(routeAnnotationMock).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: "canvas:project:term-1",
      canvasTerminalId: "term-1",
      payload: "{\"action\":\"selected\"}",
    }));
  });

  it("routes to the live agent's reply handle instead of terminal PTY routing when the parent is a registered agent node", async () => {
    agentReplyRegistryGetMock.mockReturnValue({ canReply: () => true, sendReply: vi.fn() });
    routeAgentAnnotationMock.mockReturnValue({ ok: true, delivery: "sent", annotationId: "annotation-1", context: "context", resolvedTargetId: "agent-1", cropRect: null });
    render(<BrowserNode {...makeProps({ parentTerminalId: "agent-1", parentRuntimePaneId: null })} />);

    const options = latestAnnotationOptions();
    await options.onAnnotationCaptured({
      terminalId: "agent-1",
      payload: "{\"action\":\"selected\"}",
      capturedAt: 1,
      source: "native",
    });

    expect(agentReplyRegistryGetMock).toHaveBeenCalledWith("agent-1");
    expect(routeAgentAnnotationMock).toHaveBeenCalledWith(expect.objectContaining({
      agentNodeId: "agent-1",
      payload: "{\"action\":\"selected\"}",
    }));
    expect(routeAnnotationMock).not.toHaveBeenCalled();
  });

  it("merges the native screenshot into the payload BEFORE routing, so text and screenshot arrive as one combined submission", async () => {
    augmentAnnotationPayloadMock.mockResolvedValue("{\"action\":\"selected\",\"visualAttachments\":[{\"path\":\"/tmp/shot.png\"}]}");
    render(<BrowserNode {...makeProps({ id: "browser-1", parentTerminalId: "term-1", parentRuntimePaneId: "canvas:project:term-1" })} />);

    const options = latestAnnotationOptions();
    await options.onAnnotationCaptured({
      terminalId: "term-1",
      payload: "{\"action\":\"selected\"}",
      capturedAt: 1,
      source: "native",
    });

    expect(augmentAnnotationPayloadMock).toHaveBeenCalledWith("{\"action\":\"selected\"}", "term-1");
    expect(routeAnnotationMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: "{\"action\":\"selected\",\"visualAttachments\":[{\"path\":\"/tmp/shot.png\"}]}",
    }));
  });

  it("routes at most once per annotation id, even when the overlay fires a second event for the same submission", async () => {
    // The overlay sends a base event then, if the selection has harvestable images, a second
    // event for the SAME annotation id — each routing call is a full agent turn, so the
    // second event must be ignored rather than giving the agent two turns for one action.
    render(<BrowserNode {...makeProps({ parentTerminalId: "term-1", parentRuntimePaneId: "canvas:project:term-1" })} />);

    const options = latestAnnotationOptions();
    const emit = () => options.onAnnotationCaptured({
      terminalId: "term-1",
      payload: "{\"action\":\"selected\",\"id\":\"annotation-1\"}",
      capturedAt: 1,
      source: "native",
    });
    await emit();
    await emit();

    expect(augmentAnnotationPayloadMock).toHaveBeenCalledOnce();
    expect(routeAnnotationMock).toHaveBeenCalledOnce();
  });

});
