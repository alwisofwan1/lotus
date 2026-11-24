# 0023 — CodeCanvas Artisan Theme Engine

- **Status:** Accepted (design)
- **Date:** 2026-06-26
- **Supersedes:** the background-only `CanvasBackgroundTheme` system (`canvas-background-theme.ts`, `useCanvasBackgroundTheme.ts`)
- **Related:** ADR-0017 (global catalog precedent), `plans/lotus-theme-unification` (app-wide token plumbing — a prerequisite enabler, not this), `plans/codecanvas-artisan-themes/plan.md`

## Context

CodeCanvas theming today is **background-only**. `CanvasBackgroundTheme` carries `{ variant, gap, size, color }` — it paints the React Flow surface and nudges a few `--node-glass-*` tokens, but the UI itself states *"Node colors and sidebar are unaffected."* There are 7 presets (void/grid/cosmos/space/mist/aurora/custom), all dark, all glass.

The target is a CNVS-class theme system: named, distinctive themes that carry **paper (background), a colour palette, fonts, surface material, and node text size**, with the headline capability that an **agent can author a brand-new theme from a dropped asset** (e.g. `hanami.mp4` → a "Lakeside" theme). The current type cannot express any of this, and the gap (no node-level theming) is already recorded.

## Decision

Build a **data-driven, scoped, constrained theme engine** for CodeCanvas. A theme is a validated **token bag** — never raw CSS — resolved deterministically into CSS custom properties under `.codecanvas-shell`.

1. **Full restyle, token bag.** A `CanvasTheme` carries paper, a 5-colour palette, node surface, fonts, material, and an optional default text size. A pure resolver `resolveCanvasTheme(spec) → CSSVarMap` is the single place tokens become `--canvas-*` / `--node-*` variables. No theme may inject arbitrary CSS — this keeps layout unbreakable and themes machine-authorable and validatable.

2. **Palette = 5 semantic roles**: `accent` (wires, selection, CTAs), `agent`, `task`, `note`, `info` (terminal/browser). Node-type chrome is driven by these roles, so themes genuinely re-colour the graph rather than just the backdrop.

2b. **Status tones are theme-independent (a separate ramp).** Agent/run state colours — `idle`, `connecting`, `running`, `completed`, `error`, `blocked` — encode *meaning*, not decoration (`.agent-status--*` in `agent-node.css` currently hard-codes amber=running, green=done, red=error). The palette must **never** override these, or a theme could render "error" green or make "running" illegible. Status tones live in a fixed `STATUS_TONES` ramp emitted by the resolver as `--canvas-status-*`; a theme may at most *tint* them within a bounded range (deferred), it cannot remap their hue. This carve-out is what makes the full-restyle safe to layer over the in-flight live-agent persona work.

3. **Material is a first-class axis**, independent of colour: `glass | solid | grain | paper`. Phase 1 ships `glass`, `solid`, `grain` (Cobalt-style noise); `paper` arrives with the light-theme phase. Driven by `data-canvas-material` on the shell.

4. **Node text size is orthogonal.** A separate user control (XS–XL) over node *content* (terminals, markdown reader, chat) — not app chrome. A theme may supply `defaultTextSize`; the user override wins and persists across theme switches.

5. **Scoped & independent.** The engine lives entirely under `.codecanvas-shell`. It does **not** unify with the app-wide `ThemeContext` / `resolve-theme.ts`. Selecting "Cobalt" restyles the canvas, never the rest of the app. (The unification plan remains a separate concern that only makes this cleaner.)

6. **Global catalog under `.lotus`.** Themes resolve from a merged catalog: **built-in themes** (TypeScript objects of the same `CanvasTheme` shape) + **user/agent-authored themes** loaded from `~/.lotus/canvas-themes/<id>/theme.json` (dev: `~/.lotus-dev/`). This follows the ADR-0017 global-catalog precedent — themes are reusable aesthetic assets, not per-project state.

7. **Agent authoring via a validated tool.** New `lotus_save_canvas_theme(spec)` (Tauri command + MCP sidecar tool) validates against the schema, writes `theme.json`, relocates assets, registers the theme, and returns structured errors. Agents do not hand-write theme files; the loader can trust the directory.

8. **Drop the legacy 7.** The old background themes are not preserved as-is. A one-shot migration maps any legacy `canvas-background-theme-v1` id → the new default theme, and converts an existing custom image URL into an auto-created user theme so returning users are not jarred.

9. **Dark-first.** Phase 1 ships an artisan **dark** set. Light/paper themes (Bauhaus/Foolscap/Botanist) require a contrast + xterm-palette rework and are explicitly deferred.

10. **Preview cards auto-derive from tokens** (paper swatch + 5 dots + name in the display font). Agent-authored themes appear in the picker with zero extra assets.

    **Amended 2026-08-28 — a curated theme ships a rendered still.** The auto-derived card was
    wrong for exactly the themes people pick this tab for. `paper.fill` is a *hand-drawn
    stand-in* for a photo/video wallpaper (see `CanvasPaper.sampled`, which exists because the
    two disagree), so the card for Lakeside painted a plum gradient over a golden-hour
    photograph, and no fill swatch says anything at all about `material` — half of what
    switching a theme changes. `CanvasTheme` therefore gains an **optional** `preview`: a 16:9
    still that shows the theme's real paper, material and palette, generated by
    `scripts/gen-theme-previews.ts` and committed under `public/assets/theme-preview/`.
    Optional is the load-bearing word — the token-derived card remains the fallback
    (`preview` → video poster → image src → fill + dots), so clause 10's promise holds
    unchanged: an agent-authored theme still appears in the picker with zero extra assets.

11. **Video paper via Tauri asset protocol + smart pause.** `<video muted loop playsinline poster>` served via `convertFileSrc`; auto-paused when the window is hidden, zoom < 0.4, or `prefers-reduced-motion`/battery-saver is active, with a poster-frame fallback.

## Consequences

**Positive**
- Themes become data: agent-authored themes "just work" (catalog + auto-card + resolver).
- The token-bag constraint makes themes safe, consistent, and unit-testable (`resolver` is a pure function).
- `.lotus` catalog reuses an established storage pattern (`lotus_state_dir().join("canvas-themes")`) and isolation (dev vs release).

**Negative / risks**
- The resolver must subsume every hard-coded `--canvas-*` / `--node-glass-*` value in `theme.css` (and node-shell/agent-node/terminal CSS). Phase 0 is a careful keystone refactor with regression risk.
- Material `grain` needs a performant noise overlay; video paper adds a real perf budget on an already-heavy React Flow surface.
- A new Tauri command + MCP tool + asset-protocol scope widen the security/validation surface — mitigated by the token-bag constraint and schema validation at the write boundary.
- **Sequencing vs in-flight work.** The live-agent persona branch is actively editing `LiveAgentNode.tsx`, `TaskNode.tsx`, `task-node.css`, `agent-node.css`. **Phase 0** (new type + resolver files, plus the eventual `theme.css` token refactor — neither touched by that branch) is conflict-free and may proceed in parallel. **Phase 1** (node-type colouring across `agent-node.css` / `task-node.css` / node components) overlaps directly and must land *after* the persona work, rebased on it — not concurrently.

## Alternatives considered

- **Extend `CanvasBackgroundTheme` in place** — rejected; background-only shape can't carry palette/fonts/material without becoming a different type anyway.
- **Raw-CSS or escape-hatch-CSS themes** — rejected; un-validatable, agent-authoring becomes unsafe, "artisan" consistency impossible to guarantee.
- **Unify with the app `ThemeContext`** — rejected for now; "Bauhaus" would repaint the whole app, a much larger blast radius than the user wants ("fits existing boundaries").
- **Per-project theme folders** — rejected; themes are reusable aesthetics, not project state (per user direction to store under `.lotus`).
