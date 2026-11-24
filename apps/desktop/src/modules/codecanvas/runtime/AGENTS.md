# CodeCanvas Runtime

## Purpose
Own page-level runtime seams that keep `CanvasPage` focused on layout and ReactFlow composition.

## Ownership
- Runtime hooks and adapters adapt project state into commands, lifecycle listeners, maintenance effects, viewport/focus commands, and native IPC seams.
- Runtime modules may depend on `hooks/` and `services/`, but node components should not reach into runtime directly unless they are acting through a typed command surface.

## Local Contracts
- Do not persist runtime callbacks or runtime-only view data.
- Keep adapters small and reversible; each module should own one command or lifecycle concern.
- Prefer refs for long-lived listeners that need latest graph/project state instead of suppressing hook dependency rules in containers.
- Browser API listeners and lifecycle IPC adapters must remain Tauri-only and best-effort; failures should not break the canvas shell.
- `useCanvasProjectFleetView.ts` owns project-scoped focus/Fleet capture and restore, hero and Fleet rail-scroll persistence, canonical save projection registration, stale-hero fallback, and resize refresh. Keep project-switch persistence orchestration out of `CanvasPage` and never persist focus/Fleet-projected node geometry.

## Work Guidance
- Extract orchestration from `CanvasPage` into runtime hooks before adding new page-level behavior.
- Keep command interfaces stable and narrow so command-center and node-command adapter work can reuse them.
- `useCanvasCommandCenter.ts` owns page-level create/focus/close/dispatch, node-data patching, Browser toggle/recovery, Terminal runtime recovery, skill preview routing, Note-to-Task conversion, and drop-target creation; keep it as a thin adapter over existing board/runtime operations.
- `useCanvasWorkflowCommands.ts` owns workflow save/save-copy persistence state and route changes; keep workflow side effects out of `CanvasPage`.
- `Cmd/Ctrl+K` is owned by `hooks/useCanvasCommandSheet.ts`, not by a runtime hook. The centred palette merged into `CanvasNlCommandBar` (2026-08-28): the sheet reads the bar's text as its query, so the open state has to live where that text lives. Its rows still call command-center actions for canvas mutations.

## Verification
- Run `bun run lint -- src/modules/codecanvas/runtime src/modules/codecanvas/containers/CanvasPage.tsx` after runtime refactors.

## Child DOX Index
- None.
