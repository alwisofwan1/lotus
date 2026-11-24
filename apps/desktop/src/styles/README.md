# Styles

Global and route-level CSS lives here instead of directly under `src/app`.

## Structure

```text
src/styles/
  design-system.css     # app-wide design-system tokens and base component styles
  codespace.css         # CodeSpace global terminal/workbench styles
  canvas/
    index.css           # ordered CodeCanvas route stylesheet entrypoint
    legacy.css          # compatibility shim only
    theme.css           # Canvas theme tokens and backgrounds
    layout.css          # Canvas shell, topbar, sidebars
    controls.css        # minimap, zoom, command palette
    node-shell.css      # shared node chrome and LOD surfaces
    terminal-node.css   # Canvas Terminal node
    browser-node.css    # Canvas Browser node
    note-node.css       # Note node and Smart Convert
    skills-node.css     # Skill nodes and skill palette
    workflow-nodes.css  # Task, Context, Critic, HumanGate, Team
    panels.css          # floating panels and picker surfaces
```

## Import ownership

- `src/app/layout.tsx` imports app-wide CSS from `src/styles/design-system.css` and `src/styles/codespace.css`.
- `src/app/globals.css` imports `src/app/terminal-cell-header.css` while it remains the app global entrypoint.
- `src/app/canvas/page.tsx` imports only `src/styles/canvas/index.css` for CodeCanvas route styles.

## Maintenance rules

- Do not add feature CSS files directly under `src/app`.
- Add CodeCanvas visual changes to the closest scoped file under `src/styles/canvas/`.
- Preserve import order in `src/styles/canvas/index.css` unless intentionally changing cascade behavior.
- Keep transparency-heavy effects bounded and covered by reduced-transparency fallbacks.
- A restyle edits each rule where it already lives. An override block appended at the end of a
  file (same selectors, redeclared) leaves every element styled in two places and silently beats
  later `@container`/`@media` rules — `tasks.css` lost its narrow-panel padding that way.
- Use the dither through `--ds-dither-rule` / `--ds-dither-fill` (declared on `:root` in
  `design-system.css`; the shell aliases them as `--ws-`); `dither-tokens.css.test.ts` fails on a
  raw `--ds-dither-mask` anywhere else.
- Menus read `--ds-menu-*` (corner, inset, row, hover, entrance) from `design-system.css` and set
  none of their own; `menus.css.test.ts` guards it.

## Colour-literal budget

App CSS — the `.css` files directly under `src/app/` and `src/styles/` — is held to a per-file count
of hard-coded colours, recorded in `src/styles/color-literal-baseline.json` and checked by
`src/styles/__tests__/color-literal-budget.css.test.ts`. `src/styles/canvas/` is out of scope: Canvas
Style themes own their palette.

**What counts.** Hex colours of 3, 4, 6 or 8 digits, and every `rgb()`, `rgba()`, `hsl()` or `hsla()`
call. Each occurrence counts, including inside gradients, shadows and `var(--x, #fff)` fallbacks.
Literals inside `/* comments */` do not count.

**The rule.** A file's count may not rise. If it falls, lower its number in the baseline in the same
commit — the test fails on a stale baseline too, so a saving cannot be spent later. A new stylesheet
starts at zero. The failure names the file and the delta:

```text
src/styles/tasks.css: 20 colour literals, baseline 19 (+1). Use a token, or exempt the line with a reason.
```

**Exempting a line.** Use a theme token first. A literal that is meant to stay — a brand colour, or a
status colour that is identical in both themes — is exempted by a marker comment on the same line,
with a reason:

```css
.status-dot--error { background: #e5484d; } /* color-literal-ok: status red, same in both themes */
```

The marker exempts every literal on the line its comment opens on and nothing else; a declaration
spanning several lines needs it on each line that holds a literal. The comment must open with
`color-literal-ok:`; it may wrap onto further lines, and the reason is everything after the colon.
A marker with no reason exempts nothing and fails the test.
