# ADR-0033: CodeCanvas "Canvas Terminal" visual language for nodes

- **Status:** Proposed
- **Date:** 2026-07-01
- **Builds on:** ADR-0023 (artisan theme engine — `--ct-*` → `--canvas-*`/`--node-*`), ADR-0024/0027 (live-agent personas, runner-first, CNVS-pure header), ADR-0026 (standalone ADE)
- **Reference:** [cnvs.dev](https://cnvs.dev/) — the voice-controlled agentic dev environment this project takes visual cues from.

## Context

CodeCanvas nodes currently render in a **liquid-glass** idiom: `backdrop-filter: blur(20px)`,
`--node-glass-shadow` + inset light, a top-edge light-refraction gradient (`.canvas-node::before`),
and a per-kind accent strip with a `drop-shadow` glow that light-sweeps while running
(`.canvas-node::after`). Headers are 2.25rem with a gradient background + border-image. Status is a
**pill badge with text + border + background-mix**. There are **no mount/unmount (open/close)
animations** — nodes appear and vanish instantly.

The user's brief: nodes should be **ultra-minimalist, intuitive, modern**, with **smooth open/close
transitions**. The chosen north star (from the CNVS reference screenshot) is the **"Canvas Terminal"**
idiom — the same one ADR-0027 already reached for with the CNVS-pure `AgentPersonaHeader`:

- **Monospace chrome**: bold mono name + muted `· Runner` label; identity carried by a small status
  **dot/glyph**, not a text badge.
- **Near-zero chrome**: a **thin clean top-edge accent** (no glow, no gradient sweep), hairline 1px
  border, subtle brighten on selection.
- **Dark translucent surface, minimal blur** — the CNVS reference is *not* opaque-flat; the wallpaper
  shows through a dark scrim. This is the ornament we keep; refraction/inset-light/glow-sweep is what
  we drop.
- **Status via glyph vocabulary** (`✻` starting · `●` running · `⟳` working · `✓` done · `⎿` sub-line
  · `▶` input · `×` error), coloured from the existing theme-independent status ramp.

The system already has the seams to do this cheaply: one shared shell (`CanvasNodeFrame`), the
`--ct-*` → `--node-*` token cascade, and an LOD glyph system. The change is **structural (chrome +
motion), not a palette change** — themes stay compatible.

## Decision

Adopt the **Canvas Terminal visual language** as the CodeCanvas node idiom, rolled out **Live Agent +
Terminal first**, then propagated to the other node families.

1. **De-ornament the shared shell** (`node-shell.css` / `.canvas-node`):
   - Remove the light-refraction `::before` and the glow/gradient-sweep on `::after`; replace the
     accent with a **single flat 1px top-edge line** in `--node-accent` that brightens (opacity/width)
     on `.selected`/`:focus-within` only.
   - Keep a **dark translucent scrim + reduced blur** as the resting surface (retain the
     `prefers-reduced-transparency` and custom-image-theme paths). Selection = hairline goes accent +
     1px ring, **no** heavier blur bloom.
   - Status strip animations (running sweep / starting breathe) collapse into a quiet dot/glyph pulse.

2. **Monospace chrome** for agent + terminal headers: name bold mono, `· Runner` muted, status dot/
   glyph left of the name; actions and close stay as compact icon buttons. Content (transcript / cwd
   / footer) is mono and low-contrast, matching the CNVS status-line + composer pattern.

3. **Smooth open/close via CSS only.** A tiny presence hook (`useNodePresence`, ~30 lines) drives a
   `data-node-anim="enter|leave"` attribute: **enter** = opacity 0→1, scale .96→1, translateY 4→0 over
   ~160ms; **leave** = the reverse over ~140ms, and the node is removed from the ReactFlow `nodes`
   array only after the leave animation completes. All animation is `transform`/`opacity` only
   (GPU-friendly, safe at hundreds of nodes) and gated by `prefers-reduced-motion`.

4. **DRY + theme-first.** Everything routes through `CanvasNodeFrame` + the shared CSS + `--ct-*`
   tokens. No new runtime dependency (**framer-motion is explicitly rejected**).

5. **Scope discipline.** The shell/motion change is global (all node kinds inherit it coherently in one
   step). Mono *content* treatment is per-family and lands incrementally after the Agent+Terminal
   pilot. **Exempt from mono:** whiteboard `ShapeNode` (hand-drawn) and NoteNode **prose** (documents
   stay sans for readability — only the Note *chrome* adopts the idiom).

## Alternatives considered

- **A — "Quiet Flat"** (fully opaque surfaces, no translucency): clean, but loses the wallpaper depth
  the CNVS reference and the custom-image themes rely on. Rejected in favour of translucent scrim.
- **B — "Refined Glass"** (keep glass, tone down): smallest change, but still ornamental — does not
  meet the "ultra-minimalist" brief. Rejected.
- **framer-motion / `motion`** for open/close: richer orchestration but adds a dependency and risks
  jank when many nodes animate over the WebGL canvas. Rejected in favour of the CSS presence hook.

## Consequences

- **Positive:** coherent CNVS-aligned idiom; lower GPU cost (less blur/shadow); first real open/close
  motion; token/shell routing keeps it DRY and theme-safe; aligns with ADR-0027's CNVS-pure direction.
- **Costs / risks:** the shell change touches every node at once — needs a visual pass across kinds
  (mitigated by piloting Agent+Terminal and verifying in the dev app before propagating). The presence
  hook must intercept node removal, so `onClose`/`dispatchCommand({kind:"close-node"})` paths gain a
  brief animated delay before the node leaves the graph.
- **Follow-ups:** propagate mono content to Task/Plan/Critic/Context/HumanGate/Team/Skills; adopt the
  composer + footer status-line pattern in the agent body; revisit the LOD glyph palette so it reads as
  part of the same flat idiom.
