import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Over the canvas `--bg` is a 6% tint and `--bg-elevated` is glass, so neither is a ground: the
 * Dock's New menu read the list through it, and a primary button (`color: var(--bg)`) drew as a
 * blank white bar. The Dock hands the hosted surface the theme's opaque floor instead.
 */
const css = (path: string) => readFileSync(resolve(__dirname, "../../../../styles", path), "utf8");

describe("Canvas Dock grounds", () => {
  it("gives the hosted surface an opaque floor for floats and for ink on --fg", () => {
    const dock = css("canvas/canvas-dock.css");
    expect(dock).toMatch(/--au-float-ground:\s*var\(--node-floor-solid/);
    expect(dock).toMatch(/--rs-on-fg:\s*var\(--node-floor-solid/);
  });

  it("paints ink on a --fg fill with --rs-on-fg, never --bg directly", () => {
    const kit = css("resource-kit.css");
    expect(kit).toMatch(/\.rs-button--primary \{[^}]*color: var\(--rs-on-fg, var\(--bg\)\)/);
    expect(kit).not.toMatch(/background: var\(--fg\); color: var\(--bg\)/);
  });

  it("puts the Dock's menus, overlay pane and sticky form footer on that floor", () => {
    const au = css("automation.css");
    expect(au).toMatch(/background-color: var\(--au-float-ground, var\(--ws-surface-float\)\)/);
    expect(au).toMatch(/\[data-variant="dock"\] \.au-form-foot \{[^}]*background-color: var\(--au-float-ground/);
  });

  it("is opaque: a solid ground, no backdrop blur, no glass token", () => {
    const dock = css("canvas/canvas-dock.css");
    const shell = dock.match(/\.canvas-dock \{[^}]*\}/)?.[0] ?? "";
    expect(shell).toMatch(/background: var\(--dock-ground\);/);
    expect(shell).toMatch(/backdrop-filter: none;/);
    expect(shell).not.toMatch(/--cc-chrome-bg|--cc-chrome-blur/);
    // Every ground starts from the opaque floor, and the surface tint loses its alpha first.
    expect(shell).toMatch(/--dock-tint: rgb\(from var\(--canvas-surface-r[^;]*r g b \/ 1\)/);
    for (const name of ["ground", "sunk"]) {
      expect(shell).toMatch(new RegExp(`--dock-${name}: color-mix\\(in oklab, var\\(--dock-tint\\) \\d+%, var\\(--node-floor-solid`));
    }
    expect(shell).toMatch(/--dock-raised: color-mix\(in oklab, #ffffff \d+%, var\(--dock-ground\)\)/);
  });

  it("turns the hosted app's tints into grounds, beating .ws-shell's own block", () => {
    const body = css("canvas/canvas-dock.css").match(/\.ws-shell\.canvas-dock-body \{[^}]*\}/)?.[0] ?? "";
    expect(body).toMatch(/--bg: var\(--dock-ground\)/);
    expect(body).toMatch(/--ws-surface-raised: var\(--dock-raised\)/);
    expect(body).toMatch(/--ws-surface-float: var\(--dock-raised\)/);
  });

  it("puts a Tasks popup on a raised card over a scrim, and the sidebar on the sunk ground", () => {
    const dock = css("canvas/canvas-dock.css");
    expect(dock).toMatch(/\.canvas-dock \.tk-modal-backdrop \{ background: var\(--dock-scrim\); \}/);
    expect(dock).toMatch(/\.canvas-dock \.tk-modal \{[^}]*background: var\(--dock-raised\)/);
    expect(dock).toMatch(/\.canvas-dock \.tk-nav \{ background: var\(--dock-sunk\); \}/);
    expect(dock).toMatch(/\.canvas-dock-rail \{[^}]*background: var\(--dock-sunk\)/);
  });

  it("puts Factory's New run sheet on a raised card over a scrim", () => {
    const dock = css("canvas/canvas-dock.css");
    expect(dock).toMatch(/\.canvas-dock \.fa-modal-backdrop \{ background: var\(--dock-scrim\); \}/);
    expect(dock).toMatch(/\.canvas-dock \.fa-modal \{[^}]*background: var\(--dock-raised\)/);
  });

  it("keeps every Tasks field that paints --bg a well, not the ground it now equals", () => {
    const tasks = css("tasks.css");
    const dock = css("canvas/canvas-dock.css");
    const wells = dock.match(/\.canvas-dock :is\(([^)]*)\) \{ background: var\(--dock-sunk\); \}/)?.[1] ?? "";
    // Any .tk-input-like rule whose own background is plain var(--bg) must be listed.
    const fields = [...tasks.matchAll(/^(\.tk-(?:input|vault-field|pick-trigger|seg)) \{[^}]*background: var\(--bg\);/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(wells).toContain(field);
  });

  it("gives Code the grounds its workbench tokens are derived from, so ⌘P, the selection bar and the active tab are opaque", () => {
    const dock = css("canvas/canvas-dock.css");
    const code = dock.match(/\.canvas-dock \.canvas-dock-code \{[^}]*\}/)?.[0] ?? "";
    // .codespace-panel-surface, the selection popover and the active tab all read these two.
    expect(code).toMatch(/--bg-card: var\(--dock-raised\);/);
    expect(code).toMatch(/--bg-sidebar: var\(--dock-ground\);/);
    expect(code).toMatch(/--codespace-panel-surface-raised: var\(--dock-raised\);/);
    expect(dock).toMatch(/\.canvas-dock \.canvas-dock-code-side \{ background: var\(--dock-sunk\); \}/);
    // The rules being fixed really do derive from those tokens; if that changes, so must this.
    const globals = readFileSync(resolve(__dirname, "../../../../app/globals.css"), "utf8");
    // The selection bar is a menu (Theme 12): its own opaque popover token, not a panel ground.
    expect(globals).toMatch(/\.codespace-selection-popover \{[^}]*background: var\(--ds-workbench-popover-bg\);/);
    // The active tab is the editor's own ground (Theme 13, mockup T5), so it reads --bg.
    expect(code).toMatch(/--bg: var\(--dock-ground\);/);
    expect(globals).toMatch(/\.codespace-workbench-tab-active \{[^}]*background: var\(--bg\);/);
  });

  it("starts a widened Dock below the macOS window buttons", () => {
    const dock = css("canvas/canvas-dock.css");
    expect(dock).toMatch(/\.canvas-dock\[data-wide\] \{[^}]*top: 50px/);
  });
});
