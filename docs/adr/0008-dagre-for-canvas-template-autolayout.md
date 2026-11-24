# Dagre is used for autolayout when a Canvas Team Template is applied

## Status

accepted

## Context

When a **Canvas Team Template** is applied to a canvas (Replace or Append), the
spawned nodes must be positioned without overlap and in a visually coherent
arrangement. Three approaches were evaluated:

**Manual grid placement** — arrange nodes in rows/columns by type (Terminals left,
Agents centre, Notes right). Predictable but ignores the wire topology between
nodes; a 3-Agent plan with Notes wired as context looks identical to an unconnected
batch, producing misleading spatial grouping.

**Extend existing placement** (`canvas-node-placement.ts`) — use `findNearestFreePosition`
with smarter initial seeds per node type. Low cost, no new dependency, but still
procedural: it places nodes one-by-one without global awareness of the full graph
structure.

**Dagre** (`@dagrejs/dagre`) — directed graph layout engine that respects edge
topology. Already the canonical recommendation in the React Flow docs for autolayout;
produces hierarchical top-down or left-right trees with configurable node separation.
~60 KB, pure JS, zero Rust changes, no Tauri backend involvement.

**ELK** was also considered but ruled out: ~400 KB WASM bundle, async layout API
(requires extra wiring), and its power (force-directed, layered, box) is not needed
for the relatively small graphs a canvas template produces.

## Decision

Use `@dagrejs/dagre` to compute node positions when a **Canvas Team Template** is
applied. Layout runs client-side immediately before the nodes are committed to
React Flow state, so the result is synchronous and requires no loading state.
The existing `canvas-node-placement.ts` continues to handle placement for
individually spawned nodes (drag-create, intake) — Dagre is scoped to template
application only.

## Consequences

- New dependency: `@dagrejs/dagre` + `@types/dagre`.
- Template apply produces a clean hierarchical layout that respects wire topology
  (Agent nodes downstream of their context Notes, Terminal nodes at the roots).
- Existing single-node placement logic (`cascadePosition`, `findNearestFreePosition`)
  is unchanged — no regression risk for non-template flows.
- If a global "Auto-arrange canvas" command is added later, it can reuse the same
  Dagre invocation path.
