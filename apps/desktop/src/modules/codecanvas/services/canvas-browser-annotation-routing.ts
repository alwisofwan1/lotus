"use client";

import {
  getAllTerminalSessions,
  getTerminalSessionStatus,
  subscribeTerminalSessionStatus,
  writeTerminalSession,
  type TerminalRuntimeStatus,
  type TerminalSessionSnapshot,
} from "@/modules/codespace/services/terminal-session-registry";
import { encodeTerminalTextSubmission } from "@/modules/codespace/services/terminal-submit";
import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import { extractAnnotationTraceId, formatAnnotationTrace, logAnnotationTrace } from "./canvas-browser-annotation-trace";
import { parseCanvasBrowserAnnotationContext } from "./canvas-browser-annotation-context";
import type { AnnotationScreenshotCropRect } from "./canvas-browser-annotation-crop";

const TRACE_PATH = "frontend-route";

export type CanvasBrowserAnnotationDeliveryState = "sent" | "queued" | "failed";

export type CanvasBrowserAnnotationDeliveryEvent = {
  state: CanvasBrowserAnnotationDeliveryState;
  annotationId: string;
  terminalId: string;
  context: string;
  reason?: "terminal-exited" | "delivery-timeout";
};

export type CanvasBrowserAnnotationRouteResult =
  | {
      ok: true;
      delivery: CanvasBrowserAnnotationDeliveryState;
      annotationId: string;
      context: string;
      /** Margin-expanded, viewport-relative crop rect for the selected element —
       *  see `parseCanvasBrowserAnnotationContext`. Null when there's nothing
       *  sensible to crop; callers fall back to an uncropped screenshot. */
      cropRect: AnnotationScreenshotCropRect | null;
    }
  | {
      ok: false;
      reason: "missing-terminal" | "attachment-metadata-only" | "malformed-json" | "invalid-payload" | "unsupported-action";
    };

export interface RouteCanvasBrowserAnnotationInput {
  terminalId: string | null | undefined;
  /** Stable Canvas Terminal node id, used to recover the actual runtime pane when node data is stale. */
  canvasTerminalId?: string | null;
  payload: string;
  writeToTerminal?: (paneId: string, text: string, metadata?: Partial<TerminalInputMetadata>) => void;
  getStatus?: (paneId: string) => TerminalRuntimeStatus;
  getSessions?: () => TerminalSessionSnapshot[];
  subscribeStatus?: (paneId: string, cb: (status: TerminalRuntimeStatus) => void) => () => void;
  onDelivery?: (event: CanvasBrowserAnnotationDeliveryEvent) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  deliveryTimeoutMs?: number;
  /** Verify-first instrumentation (Slice 0): grep-friendly trace, one line per
   *  delivery decision, correlated by terminal/annotation id with the matching
   *  Rust-side nav-scheme and IPC trace lines. Defaults to `logAnnotationTrace`
   *  (console + best-effort Rust dev terminal relay). */
  log?: (line: string) => void;
}

const DEFAULT_DELIVERY_TIMEOUT_MS = 12_000;

function isTerminalWritable(status: TerminalRuntimeStatus): boolean {
  return status === "live" || status === "detached";
}

function isTerminalClosed(status: TerminalRuntimeStatus): boolean {
  return status === "failed" || status === "exited";
}

function isTerminalKnown(status: TerminalRuntimeStatus): boolean {
  return status !== "idle";
}

function resolveCanvasTerminalRuntimePaneId(input: {
  preferredTerminalId: string;
  canvasTerminalId?: string | null;
  getStatus: (paneId: string) => TerminalRuntimeStatus;
  getSessions: () => TerminalSessionSnapshot[];
}): string {
  const preferredStatus = input.getStatus(input.preferredTerminalId);
  if (isTerminalKnown(preferredStatus)) return input.preferredTerminalId;

  const candidates = input.getSessions().filter((session) =>
    session.canvasTerminalId === input.canvasTerminalId || session.paneId === input.canvasTerminalId,
  );
  const writable = candidates.find((session) => isTerminalWritable(session.status));
  if (writable) return writable.paneId;
  const pending = candidates.find((session) => session.status === "starting" || session.status === "detached");
  if (pending) return pending.paneId;

  if (input.canvasTerminalId && isTerminalKnown(input.getStatus(input.canvasTerminalId))) {
    return input.canvasTerminalId;
  }

  return input.preferredTerminalId;
}

export function routeCanvasBrowserAnnotationToTerminal({
  terminalId,
  canvasTerminalId,
  payload,
  writeToTerminal = writeTerminalSession,
  getStatus = getTerminalSessionStatus,
  getSessions = getAllTerminalSessions,
  subscribeStatus = subscribeTerminalSessionStatus,
  onDelivery,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
  log = logAnnotationTrace,
}: RouteCanvasBrowserAnnotationInput): CanvasBrowserAnnotationRouteResult {
  if (!terminalId) {
    log(formatAnnotationTrace(TRACE_PATH, "-", extractAnnotationTraceId(payload), "failed:missing-terminal"));
    return { ok: false, reason: "missing-terminal" };
  }
  const resolvedTerminalId = resolveCanvasTerminalRuntimePaneId({
    preferredTerminalId: terminalId,
    canvasTerminalId,
    getStatus,
    getSessions,
  });
  const parsed = parseCanvasBrowserAnnotationContext(payload);
  if (!parsed.ok) return parsed;

  const { annotationId, context, cropRect } = parsed;
  const encodedContext = encodeTerminalTextSubmission(context);
  const metadata: Partial<TerminalInputMetadata> = {
    origin: "programmatic",
    intent: "conversation-prompt",
    submitted: true,
    promptText: context,
  };
  let completedDelivery: CanvasBrowserAnnotationDeliveryState | null = null;

  const send = () => {
    completedDelivery = "sent";
    log(formatAnnotationTrace(TRACE_PATH, resolvedTerminalId, annotationId, "sent"));
    writeToTerminal(resolvedTerminalId, encodedContext, metadata);
    onDelivery?.({ state: "sent", annotationId, terminalId: resolvedTerminalId, context });
  };

  const initialStatus = getStatus(resolvedTerminalId);
  if (isTerminalWritable(initialStatus)) {
    send();
    return { ok: true, delivery: "sent", annotationId, context, cropRect };
  }

  if (isTerminalClosed(initialStatus)) {
    log(formatAnnotationTrace(TRACE_PATH, resolvedTerminalId, annotationId, "failed:terminal-exited"));
    onDelivery?.({ state: "failed", annotationId, terminalId: resolvedTerminalId, context, reason: "terminal-exited" });
    return { ok: true, delivery: "failed", annotationId, context, cropRect };
  }

  let done = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeAfterAssignment = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timeout) clearTimer(timeout);
    timeout = null;
    if (unsubscribe) unsubscribe();
    else unsubscribeAfterAssignment = true;
  };

  const fail = (reason: "terminal-exited" | "delivery-timeout") => {
    if (done) return;
    done = true;
    completedDelivery = "failed";
    cleanup();
    log(formatAnnotationTrace(TRACE_PATH, resolvedTerminalId, annotationId, `failed:${reason}`));
    onDelivery?.({ state: "failed", annotationId, terminalId: resolvedTerminalId, context, reason });
  };

  const deliver = () => {
    if (done) return;
    done = true;
    cleanup();
    send();
  };

  unsubscribe = subscribeStatus(resolvedTerminalId, (status) => {
    if (isTerminalWritable(status)) deliver();
    else if (isTerminalClosed(status)) fail("terminal-exited");
  });
  if (unsubscribeAfterAssignment) {
    unsubscribe();
    unsubscribe = null;
  }
  if (done) return { ok: true, delivery: completedDelivery ?? "queued", annotationId, context, cropRect };

  timeout = setTimer(() => fail("delivery-timeout"), deliveryTimeoutMs);
  log(formatAnnotationTrace(TRACE_PATH, resolvedTerminalId, annotationId, "queued"));
  onDelivery?.({ state: "queued", annotationId, terminalId: resolvedTerminalId, context });

  return { ok: true, delivery: "queued", annotationId, context, cropRect };
}
