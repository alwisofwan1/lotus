import { describe, expect, it } from "vitest";
import type { BrowserAnnotation, BrowserAnnotationAgent } from "@/lib/tauri/codespace";
import {
  formatAnnotationsAsContext,
  formatForAgent,
  isBrowserAnnotationForWebview,
  parseBrowserAnnotationPayload,
} from "@/modules/codespace/services/browser-annotation-contract";

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "selected",
    webviewLabel: "pane-a",
    id: "annotation-1",
    agentId: "terminal:pane-1",
    url: "https://example.com",
    title: "Example",
    selector: "button.primary",
    breadcrumb: ["main", "section.hero"],
    label: "button: Deploy",
    text: "Deploy",
    message: "Make this clearer",
    dimensions: { width: 120, height: 32 },
    computedStyles: { color: "rgb(255, 255, 255)", opacity: 1 },
    reactComponent: "DeployButton",
    classes: ["primary", 42, "rounded"],
    summary: ["actions: Deploy"],
    outerHTML: "<button>Deploy</button>",
    boundingBox: { x: 10, y: 20, width: 120, height: 32 },
    viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 120 },
    multiSelection: [
      {
        id: "annotation-2",
        agentId: "terminal:pane-1",
        url: "https://example.com",
        selector: "a.secondary",
        label: "link: Docs",
        dimensions: { width: 80, height: 24 },
      },
      { id: "invalid-extra" },
    ],
    createdAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  });
}

const agent: BrowserAnnotationAgent = {
  id: "terminal:pane-1",
  label: "Claude 1",
  kind: "terminal",
  paneId: "pane-1",
};

describe("browser-annotation-contract", () => {
  it("parses and sanitizes selected annotation payloads", () => {
    const result = parseBrowserAnnotationPayload(payload());

    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;
    expect(result.webviewLabel).toBe("pane-a");
    expect(result.annotation).toEqual(
      expect.objectContaining({
        id: "annotation-1",
        agentId: "terminal:pane-1",
        selector: "button.primary",
        label: "button: Deploy",
        dimensions: { width: 120, height: 32 },
        computedStyles: { color: "rgb(255, 255, 255)" },
        classes: ["primary", "rounded"],
      }),
    );
    expect(result.annotation.multiSelection).toHaveLength(1);
  });

  it("ignores malformed, unsupported, and incomplete payloads", () => {
    expect(parseBrowserAnnotationPayload("{nope")).toEqual({
      kind: "ignored",
      reason: "malformed-json",
    });
    expect(parseBrowserAnnotationPayload(payload({ action: "hover" }))).toEqual({
      kind: "ignored",
      reason: "unsupported-action",
    });
    expect(parseBrowserAnnotationPayload(payload({ id: "" }))).toEqual({
      kind: "ignored",
      reason: "invalid-payload",
    });
  });

  it("filters selected annotations by webview label", () => {
    const result = parseBrowserAnnotationPayload(payload());

    expect(isBrowserAnnotationForWebview(result, "pane-a")).toBe(true);
    expect(isBrowserAnnotationForWebview(result, "pane-b")).toBe(false);
  });

  it("formats single and grouped annotations as agent context", () => {
    const result = parseBrowserAnnotationPayload(payload());
    expect(result.kind).toBe("selected");
    if (result.kind !== "selected") return;

    const annotation: BrowserAnnotation = result.annotation;
    expect(formatForAgent(annotation, agent)).toContain(
      "[Design Mode - Claude 1 - Selected: DeployButton - button.primary]",
    );
    expect(formatForAgent(annotation, agent)).toContain("Make this clearer");
    expect(formatForAgent(annotation, agent)).toContain("Also selected:");
    expect(formatForAgent(annotation, agent)).toContain("```html\n<button>Deploy</button>```");
    expect(formatAnnotationsAsContext([annotation])).toContain(
      "[Design Mode - Claude - Selected: DeployButton - button.primary]",
    );
  });
});
