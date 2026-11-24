# CodeCanvas Scalable Architecture

## Architecture Goal
CodeCanvas should scale as a production graph workspace by keeping orchestration, runtime side effects, persistence, view rendering, and pure policies in separate seams. The page container should remain a thin composition shell, while durable behavior lives in small, testable modules.

## Size Budget
- New or refactored CodeCanvas source files should target 300-400 LOC where practical.
- Hard cap for normal implementation files: about 500-600 LOC.
- If a file approaches the cap, split by responsibility before adding more behavior.
- Exceptions require a clear reason in the PR/task notes and should be temporary.

## Target Folder Structure

```text
src/modules/codecanvas/
  containers/
    CanvasPage.tsx                 # Shell composition only: chrome + ReactFlow wiring

  runtime/
    commands/                      # User/runtime commands, narrow interfaces
      task-commands.ts
      browser-commands.ts
      node-commands.ts
      workflow-commands.ts
    adapters/                      # Tauri/listener/terminal/browser adapters
      browser-api-bridge.ts
      terminal-dispatch-adapter.ts
      worktree-adapter.ts
    maintenance/                   # Long-lived project maintenance effects
      task-status-rollup.ts
      worktree-cleanup.ts
    viewport/                      # Runtime viewport commands and policy adapters
      focus-commands.ts
      viewport-runtime.ts

  services/
    graph/                         # Pure graph/run scheduling and checkpoint policy
    snapshot/                      # Snapshot codec, migration, repair, serialization
    nodes/                         # Node factories, node view models, command mapping
    viewport/                      # Pure zoom, LOD, grid, visible-render policies
    browser/                       # Browser pairing, annotation routing, API contracts
    tasks/                         # Task prompt, dispatch planning, status rollup
    agents/                        # Agent prompts, governance, run records, status
    templates/                     # Template capture, validation, autolayout
    context-bus/                   # Context artifacts, registry, store contracts

  components/
    shell/                         # Topbar, sidebars, canvas-level controls
    nodes/                         # Node views only, no persistence/listener logic
    panels/                        # Floating panels and inspectors
    controls/                      # Zoom, run, command-center controls
    settings/                      # Canvas settings surfaces

  hooks/
    legacy-adapters/               # Transitional hooks kept for compatibility
    ui/                            # Small UI-only hooks close to components

  styles/
    tokens.css                     # Canvas product tokens
    shell.css                      # Layout, topbar, sidebars
    nodes.css                      # Shared node frame/chrome
    terminal.css                   # Terminal-node-specific styling
    browser.css                    # Browser-node-specific styling
    overview.css                   # LOD/overview/map styling
    panels.css                     # Panels, inspectors, popovers
```

The current tree does not need to move all files at once. Move only when a behavior changes or a seam is being deepened.

Current route-level CSS split:

```text
src/styles/canvas/
  index.css             # ordered route-level entrypoint imported by src/app/canvas/page.tsx
  legacy.css            # compatibility shim only; surface CSS lives in scoped files below
  theme.css             # CodeCanvas theme tokens, shell background, canvas themes
  edges.css             # ReactFlow edges, connection lines, wire toolbar, handles
  controls.css          # ReactFlow minimap and the custom zoom control
  node-shell.css        # shared node shell, accents, overview LOD, attachments, notices
  terminal-node.css     # TerminalNode surface, header chrome, and xterm viewport styling
  node-resize.css       # shared ReactFlow NodeResizer affordances
  note-node.css         # NoteNode editor, Smart Convert, slash menu, attachments
  skills-node.css       # skill palette rows, SkillNode/SkillsNode surfaces, drag apply
  workflow-nodes.css    # Task/Context/Critic/HumanGate/Team node surfaces
  panels.css            # floating panels, Worktree panel, project picker
  browser-node.css      # BrowserNode chrome and native WebView fallback overlays
```

Keep `legacy.css` as a compatibility shim; continue adding visual work to the closest scoped CSS file under `src/styles/canvas/`.

## Module Rules

### Containers
- `CanvasPage` should compose modules and pass typed adapters.
- Do not add new Tauri listeners, graph policies, dispatch algorithms, or persistence logic directly to `CanvasPage`.
- If behavior needs state plus side effects, create a runtime module first.

### Runtime
- Runtime modules own side effects and commands.
- Runtime interfaces should be narrow: command in, result/event out.
- Runtime hooks may use refs for latest graph state when subscribing to long-lived listeners.
- Runtime modules should not own presentational markup.
- Canvas-level create/focus/close/dispatch actions should route through `useCanvasCommandCenter` rather than accumulating page-local callback glue.
- Keyboard-first command UI stays in focused components: `CanvasCommandSheet` renders the ⌘K rows, `services/commands/command-sheet-items.ts` is the catalog, `hooks/useCanvasCommandSheet.ts` is the behaviour, and `canvas-command-sheet.css` is the surface. Hotkey state belongs beside the input it drives — for ⌘K that is the command bar — never in the page container.

### Services
- Services should be pure or framework-light.
- The interface is the test surface. Prefer testing services over component internals.
- Snapshot compatibility, migrations, graph scheduling, viewport policy, and node command mapping belong here.

### Components
- Components render view models and emit commands.
- Components should not know snapshot schemas, Tauri listener lifecycle, repository storage, or graph scheduling internals.
- Node views should receive minimal data and a command adapter, not a wide callback list.

### Styles
- Split large CSS by product responsibility.
- Default visual treatment should be restrained and performant.
- Heavy blur/glass/animation must be earned by a specific product state, not used as default chrome.

## Refactor Sequence

1. Keep extracting `CanvasPage` orchestration into `runtime/` seams.
2. Introduce node command adapters and node view-model builders.
3. Move pure policy files into `services/{domain}/` folders as they change.
4. Keep Canvas styles under `src/styles/canvas/`; split or add scoped files there when visual responsibilities diverge.
5. Build the Canvas command center on top of runtime commands, not by adding more page-level callbacks.

## Verification Strategy

- Pure services: focused Vitest unit tests.
- Runtime hooks: targeted hook/component tests with fake adapters.
- Page shell: smoke tests for callback wiring and critical integration paths.
- Visual/style refactors: CSS regression tests already present in `components/__tests__`, plus manual desktop QA for native Browser/Terminal nodes.
