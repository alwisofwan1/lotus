import { describe, it, expect } from "vitest";
import { resolveCanvasTheme, withAlpha } from "../resolve-canvas-theme";
import { resolveTerminalFloor } from "../terminal-floor";
import { BUILTIN_THEMES, defaultCanvasTheme } from "../builtin-themes";
import { STATUS_TONES, type CanvasTheme } from "../../../types/canvas-theme";

const VOID = defaultCanvasTheme();

describe("withAlpha", () => {
  it("expands #rrggbb into rgba()", () => {
    expect(withAlpha("#67e8f9", 0.34)).toBe("rgba(103, 232, 249, 0.34)");
    expect(withAlpha("#f5f2ef", 0.28)).toBe("rgba(245, 242, 239, 0.28)");
  });

  it("expands shorthand #rgb", () => {
    expect(withAlpha("#fff", 0.5)).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("returns non-hex input unchanged (never throws)", () => {
    expect(withAlpha("rgba(1,2,3,0.4)", 0.2)).toBe("rgba(1,2,3,0.4)");
    expect(withAlpha("not-a-color", 0.2)).toBe("not-a-color");
  });
});

describe("resolveCanvasTheme — void reproduces the current dark look", () => {
  const vars = resolveCanvasTheme(VOID);

  it("emits the canvas surface tokens matching the computed dark app theme", () => {
    expect(vars["--canvas-bg"]).toBe("#050506");
    expect(vars["--canvas-surface"]).toBe("rgba(22,20,18,0.86)");
    expect(vars["--canvas-surface-r"]).toBe("rgba(32,28,24,0.82)");
    expect(vars["--canvas-text"]).toBe("#f7f2ea");
    expect(vars["--canvas-text-muted"]).toBe("rgba(247,242,234,0.42)");
    expect(vars["--canvas-border"]).toBe("rgba(245,242,239,0.065)");
    expect(vars["--canvas-border-str"]).toBe("rgba(245,242,239,0.11)");
  });

  it("derives wires + focus ring from the accents (matches prior rgba values)", () => {
    expect(vars["--canvas-accent"]).toBe("#f5f2ef");
    expect(vars["--canvas-focus-ring"]).toBe("rgba(245, 242, 239, 0.22)");
    expect(vars["--canvas-wire"]).toBe("rgba(103, 232, 249, 0.34)");
    expect(vars["--canvas-wire-soft"]).toBe("rgba(103, 232, 249, 0.18)");
    expect(vars["--canvas-wire-active"]).toBe("rgba(103, 232, 249, 0.82)");
    expect(vars["--canvas-wire-node"]).toBe("rgba(103, 232, 249, 0.42)");
  });

  it("emits the glass token set for material=glass, verbatim", () => {
    expect(vars["--node-glass-bg"]).toBe("rgba(10, 9, 18, 0.58)");
    expect(vars["--node-glass-filter"]).toBe("blur(20px) saturate(1.3) brightness(1.06)");
    expect(vars["--panel-glass-bg"]).toBe("rgba(8, 7, 15, 0.72)");
    expect(vars["--node-surface-style"]).toBe("glass");
  });
});

describe("resolveCanvasTheme — invariants", () => {
  it("always emits the full, theme-independent status ramp", () => {
    const vars = resolveCanvasTheme(VOID);
    for (const [state, tone] of Object.entries(STATUS_TONES)) {
      expect(vars[`--canvas-status-${state}`]).toBe(tone);
    }
  });

  it("status ramp does NOT change when palette changes (theme-independent)", () => {
    const recolored: CanvasTheme = {
      ...VOID,
      palette: { accent: "#ff0000", agent: "#ff0000", task: "#ff0000", note: "#ff0000", info: "#ff0000" },
    };
    const vars = resolveCanvasTheme(recolored);
    expect(vars["--canvas-status-error"]).toBe(STATUS_TONES.error);
    expect(vars["--canvas-status-running"]).toBe(STATUS_TONES.running);
  });

  it("maps the 5 palette roles to per-node-type vars", () => {
    const vars = resolveCanvasTheme(VOID);
    expect(vars["--canvas-node-agent"]).toBe(VOID.palette.agent);
    expect(vars["--canvas-node-task"]).toBe(VOID.palette.task);
    expect(vars["--canvas-node-note"]).toBe(VOID.palette.note);
    expect(vars["--canvas-node-info"]).toBe(VOID.palette.info);
  });

  it("emits font stacks with the theme family first", () => {
    const vars = resolveCanvasTheme(VOID);
    expect(vars["--canvas-font-display"]).toContain(`"Caveat"`);
    expect(vars["--canvas-font-body"]).toContain(`"Inter"`);
    expect(vars["--canvas-font-mono"]).toContain(`"JetBrains Mono"`);
  });

  it("omits glass tokens for non-glass materials", () => {
    const solid: CanvasTheme = { ...VOID, material: "solid", glass: undefined };
    const vars = resolveCanvasTheme(solid);
    expect(vars["--node-glass-bg"]).toBeUndefined();
    expect(vars["--node-surface-style"]).toBe("solid");
  });

  it("emits a node text-size var only when the theme sets a default", () => {
    expect(resolveCanvasTheme(VOID)["--canvas-node-text-size"]).toBeUndefined();
    const withSize: CanvasTheme = { ...VOID, defaultTextSize: "lg" };
    expect(resolveCanvasTheme(withSize)["--canvas-node-text-size"]).toBe("0.9375rem");
  });
});

describe("builtin catalog", () => {
  it("has a unique id per theme and a resolvable default", () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(defaultCanvasTheme().id).toBe("void");
  });

  it("every built-in resolves without throwing and yields a non-empty map", () => {
    for (const theme of BUILTIN_THEMES) {
      const vars = resolveCanvasTheme(theme);
      expect(Object.keys(vars).length).toBeGreaterThan(0);
    }
  });

  it("emits glass tokens iff material is glass, and --node-surface-style matches, per built-in", () => {
    for (const theme of BUILTIN_THEMES) {
      const vars = resolveCanvasTheme(theme);
      expect("--node-glass-bg" in vars).toBe(theme.material === "glass");
      expect(vars["--node-surface-style"]).toBe(theme.material);
    }
  });
});

/**
 * The terminal floor (plans/canvas-terminal-opaque-floor). xterm cannot read CSS variables, so
 * the floor colour is resolved in JS and emitted here as a LITERAL. The CSS viewport consumes
 * the same token, which is what keeps xterm's background and the viewport's from drifting apart
 * and showing a seam.
 */
describe("terminal floor tokens", () => {
  it("emits an opaque literal floor for every built-in — never a gradient or color-mix", () => {
    for (const theme of BUILTIN_THEMES) {
      const vars = resolveCanvasTheme(theme);
      const floor = vars["--node-floor-solid"];

      expect(floor, `${theme.id} emitted no floor`).toBeDefined();
      expect(floor).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
      // The trap this guards: paper.fill is a gradient on four of five built-ins, and
      // color-mix() with a gradient is invalid — the declaration would collapse to
      // transparent black. See node-shell.css:198.
      expect(floor).not.toContain("gradient");
      expect(floor).not.toContain("color-mix");
      expect(floor).not.toContain("var(");
    }
  });

  it("emits the floor for every material, not only glass", () => {
    // Unlike --node-glass-*, the floor is unconditional: solid and grain terminals need an
    // opaque background too, they just derive it from --canvas-surface instead of a panel.
    for (const theme of BUILTIN_THEMES) {
      expect("--node-floor-solid" in resolveCanvasTheme(theme)).toBe(true);
    }
  });

  it("agrees with resolveTerminalFloor — one resolver, two consumers", () => {
    for (const theme of BUILTIN_THEMES) {
      expect(resolveCanvasTheme(theme)["--node-floor-solid"]).toBe(
        resolveTerminalFloor(theme).background,
      );
    }
  });

});
