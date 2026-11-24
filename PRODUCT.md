# Product

## Register

product

## Users

Lotus is for software engineers and technical teams who run local AI coding agents against real repositories. They use it while actively building, reviewing, debugging, and refactoring code, often with multiple Claude or Codex sessions open at once. Their context is work-in-progress: terminals are streaming, files are changing, agents may be idle or busy, and the user needs to understand which workspace, pane, model, tool, and task is currently in control.

## Product Purpose

Lotus is a native desktop workbench for orchestrating AI coding agents. It brings terminal panes, multi-agent team workflows, code chat, workspace context, browser/file side panels, and settings into one local app so users can delegate coding work without losing operational visibility.

Success means the user can start work quickly, launch or steer agents deliberately, inspect agent output, recover from mistakes, and keep several projects or workflows organized without switching between scattered terminals, browser tabs, and config files.

## Brand Personality

Precise, calm, and capable. Lotus should feel like a serious engineering instrument: dense enough for experts, quiet enough for long sessions, and transparent about agent state. The voice should be direct and operational, avoiding hype, filler, or theatrical AI language.

## Anti-references

Lotus should not look like a generic AI chatbot landing page, a marketing-heavy SaaS dashboard, or a decorative developer toy. Avoid neon cyberpunk terminals, card grids that bury the actual workspace, unnecessary hero copy, glass effects used as ornament, and chatty orchestration messages that obscure what agents actually did.

It should also avoid feeling like a fragile prototype: mismatched controls, unclear disabled states, ambiguous agent status, modal-heavy flows, or flashy animation that makes fast repeated work slower.

## Design Principles

1. Put the workspace first. Terminals, files, browser panes, diffs, and agent output are the primary content; chrome should support them without competing.
2. Make agent state legible. Users should always be able to tell what is running, idle, selected, pending, failed, or awaiting input.
3. Prefer earned density. Expert users need many panes and controls, but grouping, hierarchy, and progressive disclosure must keep the surface scannable.
4. Keep orchestration terse. Bridge, CodeChat, and agent-team surfaces should report actions and decisions plainly, with no performative narration.
5. Preserve local trust. Filesystem, PTY, process, and settings actions should make scope and side effects clear before they become surprising.

## Accessibility & Inclusion

Target WCAG 2.1 AA for app UI contrast, keyboard navigation, focus visibility, and readable text hierarchy. The product must remain usable in long coding sessions, with reduced-motion friendly transitions, non-color-only status indicators, comfortable hit targets for dense controls, and terminal/browser panes that do not trap focus unexpectedly.
