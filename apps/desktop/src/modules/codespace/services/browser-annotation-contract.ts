"use client";

import type { BrowserAnnotation, BrowserAnnotationAgent } from "@/lib/tauri/codespace";

export type BrowserAnnotationPayloadResult =
  | {
      kind: "selected";
      webviewLabel?: string;
      annotation: BrowserAnnotation;
    }
  | {
      kind: "ignored";
      reason: "malformed-json" | "invalid-payload" | "unsupported-action";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function annotationDimensions(value: unknown): BrowserAnnotation["dimensions"] {
  if (!isRecord(value)) return { width: 0, height: 0 };
  return {
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
  };
}

function annotationBoundingBox(value: unknown): BrowserAnnotation["boundingBox"] {
  if (!isRecord(value)) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
  };
}

function annotationViewport(value: unknown): BrowserAnnotation["viewport"] {
  if (!isRecord(value)) return { width: 0, height: 0, scrollX: 0, scrollY: 0 };
  return {
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
    scrollX: finiteNumber(value.scrollX),
    scrollY: finiteNumber(value.scrollY),
  };
}

function sanitizeBrowserAnnotation(raw: unknown): BrowserAnnotation | null {
  if (!isRecord(raw)) return null;

  const id = stringValue(raw.id);
  const url = stringValue(raw.url);
  const selector = stringValue(raw.selector);
  const label = stringValue(raw.label);
  if (!id || !url || !selector || !label) return null;

  return {
    id,
    agentId: stringValue(raw.agentId, "claude"),
    url,
    title: stringValue(raw.title),
    selector,
    breadcrumb: stringArray(raw.breadcrumb),
    label,
    text: stringValue(raw.text),
    message: stringValue(raw.message),
    dimensions: annotationDimensions(raw.dimensions),
    computedStyles: stringRecord(raw.computedStyles),
    reactComponent: optionalString(raw.reactComponent),
    classes: stringArray(raw.classes),
    summary: stringArray(raw.summary),
    outerHTML: optionalString(raw.outerHTML),
    boundingBox: annotationBoundingBox(raw.boundingBox),
    viewport: annotationViewport(raw.viewport),
    multiSelection: Array.isArray(raw.multiSelection)
      ? raw.multiSelection.map(sanitizeBrowserAnnotation).filter((item): item is BrowserAnnotation => Boolean(item))
      : undefined,
    createdAt: stringValue(raw.createdAt),
  };
}

export function parseBrowserAnnotationPayload(payload: string): BrowserAnnotationPayloadResult {
  let data: unknown;
  try {
    data = JSON.parse(payload);
  } catch {
    return { kind: "ignored", reason: "malformed-json" };
  }

  if (!isRecord(data)) {
    return { kind: "ignored", reason: "invalid-payload" };
  }

  if (data.action !== "selected") {
    return { kind: "ignored", reason: "unsupported-action" };
  }

  const annotation = sanitizeBrowserAnnotation(data);
  if (!annotation) {
    return { kind: "ignored", reason: "invalid-payload" };
  }

  return {
    kind: "selected",
    webviewLabel: optionalString(data.webviewLabel),
    annotation,
  };
}

export function isBrowserAnnotationForWebview(
  result: BrowserAnnotationPayloadResult,
  webviewLabel: string,
): result is Extract<BrowserAnnotationPayloadResult, { kind: "selected" }> {
  return result.kind === "selected" && (!result.webviewLabel || result.webviewLabel === webviewLabel);
}

function buildDesignModeHeader(annotation: BrowserAnnotation, agentLabel: string): string {
  const component = annotation.reactComponent ? `${annotation.reactComponent} - ` : "";
  return `[Design Mode - ${agentLabel} - Selected: ${component}${annotation.selector}]`;
}

function buildHtmlBlock(annotation: BrowserAnnotation): string {
  if (!annotation.outerHTML) return "";
  return "```html\n" + annotation.outerHTML + "```";
}

function formatSingleAnnotation(annotation: BrowserAnnotation, agentLabel: string): string {
  const parts: string[] = [buildDesignModeHeader(annotation, agentLabel)];

  if (annotation.message) {
    parts.push(annotation.message);
  }

  if (annotation.multiSelection && annotation.multiSelection.length > 0) {
    const extra = annotation.multiSelection
      .map((selection) => {
        const component = selection.reactComponent ? ` (${selection.reactComponent})` : "";
        return `- ${selection.selector}${component} ${selection.dimensions.width}×${selection.dimensions.height}px`;
      })
      .join("\n");
    parts.push(`Also selected:\n${extra}`);
  }

  const htmlBlock = buildHtmlBlock(annotation);
  if (htmlBlock) parts.push(htmlBlock);

  return parts.join("\n");
}

export function formatForAgent(
  annotation: BrowserAnnotation,
  agent: BrowserAnnotationAgent,
): string {
  return formatSingleAnnotation(annotation, agent.label);
}

export function formatAnnotationsAsContext(annotations: BrowserAnnotation[]): string {
  if (annotations.length === 0) return "";
  return annotations
    .map((annotation) => formatSingleAnnotation(annotation, "Claude"))
    .join("\n\n---\n\n");
}
