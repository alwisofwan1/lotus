# ADR 0005: CodeCanvas Settings Live in an In-Canvas Modal, Not the Global Settings Route

## Status

Accepted (2026-05-30)

## Context

CodeCanvas preferences (so far: the Canvas Background Theme and its custom image URL)
have lived as one section of the unified `/settings` route, reached from the canvas
topbar gear via a `<Link href="/settings?section=codecanvas">`.

Two forces make this placement increasingly wrong:

1. **Navigating to `/settings` unmounts the canvas.** `/canvas` and `/settings` are
   separate Next.js routes; opening settings tears down `CanvasPage` and every live
   PTY-backed Canvas Terminal Node, then rebuilds them on return. This is the same
   mount/unmount seam that produced the custom-background bug fixed earlier the same
   day — settings state and canvas state could not observe each other because they
   never coexisted. Adjusting a canvas preference while looking at the canvas was
   impossible.
2. **Canvas settings are growing per-domain.** The intent is a scalable set of
   domain tabs (Background, Hotkeys, and later Behavior, Skills, Terminal, Notes).
   A single section inside a 12-entry global `SECTIONS` switch does not scale cleanly
   and couples a canvas-owned concern to the settings module.

The global settings route remains the right home for app-wide concerns (General,
Appearance, Permissions, Models, etc.). The question is only where the
*canvas-specific* preferences belong.

## Decision

We will move all CodeCanvas preferences out of the global `/settings` route into a
**Canvas Settings Modal** — an in-canvas overlay that keeps the canvas mounted
behind it. The modal hosts a left rail of data-driven **Canvas Settings Tabs**;
each tab is a self-contained panel owning one preference domain and registered in a
single tab registry. The topbar gear and a keyboard shortcut open the modal; the
CodeCanvas entry is removed from the global settings `SECTIONS` config and from
`settingsNavItems`. Canvas preferences stay device-level (`localStorage`), not in a
Canvas Snapshot.

## Consequences

- Adjusting a canvas preference no longer unmounts the canvas or its terminals;
  changes can take effect against the live canvas, eliminating the class of
  cross-route state-sync bug we just fixed.
- Adding a new canvas preference domain is one registry entry plus one panel
  component — no edits to the global settings module.
- There is now one entry point for canvas settings and one for everything else;
  users must learn that canvas preferences are reached from the canvas, not the
  global Settings page. We accept this divergence as the cost of in-context access.
- A second modal implementation exists alongside the global settings page. We reuse
  the existing SettingsPrimitives and the KeyboardShortcutsModal backdrop/escape
  conventions to keep them visually and behaviorally consistent.

## Alternatives considered

**Keep CodeCanvas as a section of the global `/settings` route.** Maximally
consistent with every other settings domain, but inherits the unmount-on-navigate
problem and the very bug it caused, and gives no in-context access — the opposite of
the goal.

**Render canvas settings in both the global route and the modal, sharing tab
components.** Avoids logic duplication but leaves two entry points for the same
preferences, doubling the discoverability and maintenance surface for no real gain
once the route version still unmounts the canvas.

**Persist canvas preferences per Canvas Project inside the Canvas Snapshot.** Would
let projects differ, but requires a snapshot schema change (Rust + TS) plus
migration and contradicts the established treatment of these preferences as
device-level. Out of scope for this change.
