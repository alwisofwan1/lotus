import { describe, expect, it, vi } from "vitest";
import { routeCanvasBrowserAnnotationToAgent } from "../canvas-browser-annotation-agent-routing";
import type { AgentReplyHandle } from "../agent-reply-registry";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "selected",
    id: "annotation-1",
    url: "https://example.com",
    title: "Example",
    selector: "button.primary",
    label: "button: Deploy",
    text: "Deploy",
    message: "Make this clearer",
    dimensions: { width: 120, height: 32 },
    reactComponent: "DeployButton",
    classes: ["primary"],
    summary: ["actions: Deploy"],
    outerHTML: "<button>Deploy</button>",
    boundingBox: { x: 10, y: 20, width: 120, height: 32 },
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 120 },
    createdAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  });
}

describe("canvas-browser-annotation-agent-routing", () => {
  it("resumes a ready agent's session with the formatted annotation context", () => {
    const sendReply = vi.fn();
    const handle: AgentReplyHandle = { canReply: () => true, sendReply };

    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: "agent-1",
      payload: payload(),
      getHandle: () => handle,
    });

    expect(result).toMatchObject({ ok: true, delivery: "sent", annotationId: "annotation-1" });
    expect(sendReply).toHaveBeenCalledWith(expect.stringContaining("\n\nMake this clearer"));
  });

  it("buffers into a starting agent's session instead of dropping the annotation", () => {
    const sendReply = vi.fn();
    const handle: AgentReplyHandle = { canReply: () => false, accepts: () => true, sendReply };

    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: "agent-1",
      payload: payload(),
      getHandle: () => handle,
    });

    expect(result).toMatchObject({ ok: true, delivery: "queued", annotationId: "annotation-1" });
    expect(sendReply).toHaveBeenCalledOnce();
  });

  it("fails without writing when the agent has no live session at all", () => {
    const sendReply = vi.fn();
    const handle: AgentReplyHandle = { canReply: () => false, sendReply };

    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: "agent-1",
      payload: payload(),
      getHandle: () => handle,
    });

    expect(result).toMatchObject({ ok: true, delivery: "failed", annotationId: "annotation-1" });
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("fails without writing when the agent node has no registered reply handle at all", () => {
    // Mirrors sendAgentMessage's "skipped" semantics: an unregistered handle is
    // indistinguishable from a registered-but-offline one — both mean "nothing to
    // deliver to right now," not a hard routing error.
    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: "agent-1",
      payload: payload(),
      getHandle: () => undefined,
    });

    expect(result).toMatchObject({ ok: true, delivery: "failed", annotationId: "annotation-1" });
  });

  it("does not route when there is no agent node id at all", () => {
    const getHandle = vi.fn();

    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: null,
      payload: payload(),
      getHandle,
    });

    expect(result).toEqual({ ok: false, reason: "missing-terminal" });
    expect(getHandle).not.toHaveBeenCalled();
  });

  it("propagates a metadata-only attachment rejection without touching the agent", () => {
    const sendReply = vi.fn();
    const handle: AgentReplyHandle = { canReply: () => true, sendReply };

    const result = routeCanvasBrowserAnnotationToAgent({
      agentNodeId: "agent-1",
      payload: payload({ visualAttachments: [{ name: "annotation.png", mimeType: "image/png" }] }),
      getHandle: () => handle,
    });

    expect(result).toEqual({ ok: false, reason: "attachment-metadata-only" });
    expect(sendReply).not.toHaveBeenCalled();
  });
});
