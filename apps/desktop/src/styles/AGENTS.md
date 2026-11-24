# Shared Styles

## Purpose
Own global and route-level CSS that should not live directly in `src/app`. Styles are grouped by product surface so App Router files stay focused on routing and composition.

## Ownership
- `canvas/` owns CodeCanvas route styles and its ordered CSS entrypoint.
- `codespace.css` owns CodeSpace global terminal/workbench styling imported by the root app layout.
- `design-system.css` owns app-wide design-system tokens and base component styles imported by the root app layout.
- `automation.css` owns automation Inbox and verdict controls; behavior is owned by `src/modules/automation/AGENTS.md`.
- `factory.css` owns Factory runtime/agent surfaces; `factory-settings.css` owns task-first setup, check suggestions/editor, explicit trial confirmation/verdict/plain-text output and reversible local configuration management. Behavior is owned by `src/modules/factory/AGENTS.md`. Preserve app theme tokens, readable secondary text, visible keyboard focus and narrow-panel layouts.

## Local Contracts
- Keep `src/app` free of feature CSS files; import global styles from `src/styles` or the owning module route entrypoint.
- CodeCanvas must import only `src/styles/canvas/index.css` from `src/app/canvas/page.tsx`; preserve ordering inside that index file.
- Add new Canvas visual work to the closest scoped file under `src/styles/canvas/`, not to `legacy.css`.

## Work Guidance
- Prefer restrained, performant product UI styling: avoid default backdrop blur and pair any transparency-heavy treatment with reduced-transparency fallbacks.
- Keep CSS files grouped by durable surface responsibility rather than component churn.

## Verification
- Run `src/styles/__tests__/color-literal-budget.css.test.ts` when editing app CSS (top level of `src/app` and `src/styles`); a removed colour literal means lowering `color-literal-baseline.json` in the same commit (rules in `README.md`).
- Run style-focused Vitest tests under `src/modules/codecanvas/components/__tests__/*.css.test.ts` when editing Canvas styles.
- Run `bun run lint -- src/app src/modules/codecanvas` after moving imports or Canvas global CSS entrypoints; CSS files are covered by focused style tests rather than ESLint.

## Child DOX Index
- None.
