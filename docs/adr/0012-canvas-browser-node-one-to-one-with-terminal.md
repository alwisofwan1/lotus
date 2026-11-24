# ADR 0012 — One Canvas Browser Node per Canvas Terminal Node (one-to-one constraint)

**Status**: Accepted

## Context

When an agent or user spawns a browser from a Canvas Terminal Node, the system must decide whether subsequent spawn calls create additional Browser Nodes or reuse the existing one.

Alternatives considered:
- **One-to-many**: each `POST /api/browser/open` spawns a new BrowserNode + new dashed edge. Agents can have N parallel browsers.
- **One-to-one strict**: at most one BrowserNode per TerminalNode. A second spawn call navigates the existing WebView to the new URL.
- **One-to-one per origin**: reuse if same origin, spawn if different origin.

## Decision

One-to-one strict. A TerminalNode has at most one active BrowserNode. Calling `POST /api/browser/open` when a BrowserNode already exists navigates it to the new URL (matching the existing `open_embedded_browser_preview` reuse pattern in `codechat_browser.rs`) rather than spawning a second node.

## Consequences

- Canvas stays uncluttered: no accumulation of stale browser nodes from long-running agent sessions.
- Agents that genuinely need multiple browser contexts must open multiple Terminal Nodes (one browser per terminal).
- The `CanvasBrowserNodeRecord` stores `parentTerminalId` as a foreign key; the canvas enforces uniqueness on this field when inserting new browser nodes.
- The Browser Spawn Edge is also unique per terminal: there is never more than one dashed edge leaving a TerminalNode toward a BrowserNode.
