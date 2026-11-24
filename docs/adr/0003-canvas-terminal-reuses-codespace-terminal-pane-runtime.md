# Canvas Terminal Node reuses the CodeSpace Terminal Pane Runtime

## Status

accepted

## Context

The v1 Canvas Terminal Node was a bespoke ~100-line xterm wrapper owning its PTY
through a canvas-local `CanvasNodeRegistry`. It was output-only — no input, no
resize-to-PTY, no addons — so it did not actually function as a terminal.
CodeSpace already ships a mature terminal engine (`useTerminalRuntime` +
`terminal-pane-runtime` + `terminal-session-registry`) providing input, resize,
WebGL, search, provider detection, cwd-probe, and a PTY that survives React
unmount/remount.

## Decision

Canvas Terminal Nodes are backed by the CodeSpace **Terminal Pane Runtime**
(`useTerminalRuntime`), keyed by `paneId = nodeId` and a canvas-scoped
`workspaceId`. `CanvasNodeRegistry` is retired; PTY ownership moves to the shared
`terminal-session-registry`. Canvas terminals are deliberately **not Fleet
Targets** in v1: they are scoped out of fleet snapshots and receive no Agent
Address; provider detection is used only to label the node header.

## Considered Options

- **Bespoke, patch the gaps** — wire input/resize/addons onto the existing thin
  node. Rejected: duplicates a solved problem and ships lower quality than
  CodeSpace.
- **Hybrid, extract a shared core** — refactor a surface-agnostic terminal core
  used by both. Rejected for v1: largest scope, touches stable CodeSpace code.
- **Reuse (chosen)** — adopt `useTerminalRuntime` as-is behind a thin canvas
  adapter.

## Consequences

- `codecanvas` now depends on `codespace` terminal internals — a cross-module
  coupling. Accepted as the price of not re-implementing the engine.
- The runtime's `active` flag conflates visible / live-render / WebGL-eligible.
  Because every canvas node is always on screen, all canvas terminals run with
  `active = true`; WebGL context pressure is left to the existing
  `terminal-webgl-policy` (auto-off on macOS/Linux WebKit, loss-based backoff on
  Windows/Chromium).
- No cross-reload PTY resume exists; the Canvas Snapshot persists each node's
  last working directory and re-spawns a fresh shell there on reload.
