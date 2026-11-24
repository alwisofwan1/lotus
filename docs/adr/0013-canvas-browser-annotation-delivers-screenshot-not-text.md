# ADR 0013 — Canvas Browser Annotation delivers screenshot via three-channel pattern

**Status**: Accepted

## Context

When a human or agent triggers an annotation on a Canvas Browser Node, the result must reach the agent running in the connected Canvas Terminal Node. Two output models were considered: text (DOM selector + element description, matching CodeSpace's Browser Annotation Contract) and screenshot (image of the annotated region, better for vision-capable models doing E2E/visual testing).

## Decision

Canvas Browser Annotation uses a three-channel delivery model:

1. **PTY stdin notification** — a single line is written to the PTY session of the connected terminal: `[canvas-browser-annotation: /tmp/canvas-annotation-{id}.png]`. This is the "ping" — the agent knows a new annotation exists without polling.

2. **API pull** — the agent calls `GET $AGENT_CANVAS_API/api/browser/annotation/latest` to receive the screenshot as a base64-encoded PNG. The endpoint also returns the annotated region bounding box and the browser URL at the time of capture.

3. **Canvas attachment strip** — the screenshot is stored in `canvasAttachmentStore` keyed to the BrowserNode ID and rendered in the node's attachment strip. Human-visible audit trail.

The annotation output is always a **screenshot** (not DOM text/selector description), making it directly usable by vision-capable models (Claude Sonnet/Opus) for visual assertion in E2E testing workflows.

## Consequences

- Annotation logic in CodeCanvas is fully isolated from the CodeSpace `BrowserAnnotationContract` — no shared types or runtime code. The canvas service lives in `src/modules/codecanvas/services/canvas-browser-annotation.ts`.
- The PTY write is fire-and-forget; if the session is not running, the notification is silently dropped (not buffered).
- `canvasAttachmentStore` on the BrowserNode acts as a bounded ring buffer — only the last N annotations are kept to avoid unbounded memory growth.
- Agents must handle the annotation path being a temp file that may be cleaned up after the session ends.
