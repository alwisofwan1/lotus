import { describe, expect, it } from "vitest";
import { isShapeTool, resolveToolShortcut, shapeForTool, toolForShortcut } from "../canvas-tool";

describe("isShapeTool", () => {
  it("is true for shape/linear tools and false for modes", () => {
    expect(isShapeTool("rectangle")).toBe(true);
    expect(isShapeTool("diamond")).toBe(true);
    expect(isShapeTool("ellipse")).toBe(true);
    expect(isShapeTool("text")).toBe(true);
    expect(isShapeTool("arrow")).toBe(true);
    expect(isShapeTool("line")).toBe(true);
    expect(isShapeTool("select")).toBe(false);
    expect(isShapeTool("pan")).toBe(false);
  });
});

describe("shapeForTool", () => {
  it("maps a shape tool to its shape kind, null otherwise", () => {
    expect(shapeForTool("rectangle")).toBe("rectangle");
    expect(shapeForTool("ellipse")).toBe("ellipse");
    expect(shapeForTool("text")).toBe("text");
    expect(shapeForTool("select")).toBeNull();
  });
});

describe("toolForShortcut", () => {
  it("maps keyboard shortcuts to tools, case-insensitively", () => {
    expect(toolForShortcut("v")).toBe("select");
    expect(toolForShortcut("V")).toBe("select");
    expect(toolForShortcut("h")).toBe("pan");
    expect(toolForShortcut("r")).toBe("rectangle");
    expect(toolForShortcut("o")).toBe("ellipse");
    expect(toolForShortcut("d")).toBe("diamond");
    expect(toolForShortcut("t")).toBe("text");
  });

  it("returns null for unmapped keys", () => {
    expect(toolForShortcut("z")).toBeNull();
    expect(toolForShortcut("Escape")).toBeNull();
  });
});

/**
 * Behavioural coverage for the tool-rail gate. The first version of this fix was covered only by a
 * regex over CanvasPage.tsx's source, which asserts the code *looks* right rather than that it
 * *behaves* right — too thin for a gate that decides what ten bare letters do.
 */
describe("resolveToolShortcut", () => {
  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) =>
    ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  const armed = { showToolRail: true, editableTarget: false };

  it("activates the tool for a bare letter while the rail is shown", () => {
    expect(resolveToolShortcut(key("r"), armed)).toBe("rectangle");
    expect(resolveToolShortcut(key("R"), armed)).toBe("rectangle"); // the map is case-insensitive
    expect(resolveToolShortcut(key("h"), armed)).toBe("pan");
  });

  it("resets to select on Escape", () => {
    expect(resolveToolShortcut(key("Escape"), armed)).toBe("select");
  });

  /**
   * The gate is about DRAWING tools, and only those.
   *
   * plans/nl-type-to-focus §3 was right that a hidden rail must not let `r` silently arm the
   * rectangle tool — a tool that mutates the board with no affordance on screen to explain itself.
   * The first fix applied that to all ten letters, which swept up `v` and `h` too, and those are not
   * drawing tools: they only decide what a mouse drag MEANS, and the drag itself is the feedback.
   *
   * Sweeping them up locked the canvas. The rail is the only click path to a tool, so with it hidden
   * `activeTool` was pinned to its initial "select" forever — and CanvasPage maps select to
   * `panOnDrag: [1, 2]`, middle/right button only. Left-drag could no longer pan the canvas at all,
   * it drew a selection box. On a trackpad (no middle button, and scroll is bound to zoom) that left
   * no reasonable pan gesture, which is exactly how it was reported.
   */
  const hidden = { showToolRail: false, editableTarget: false };

  it("keeps the drawing tools inert while the rail is hidden — the bug the gate exists for", () => {
    for (const k of ["r", "d", "o", "t", "a", "l", "p", "e"]) {
      expect(resolveToolShortcut(key(k), hidden), `"${k}" draws, so it must be inert`).toBeNull();
    }
  });

  it("STILL yields select and pan while the rail is hidden — the canvas must stay navigable", () => {
    expect(resolveToolShortcut(key("h"), hidden)).toBe("pan");
    expect(resolveToolShortcut(key("v"), hidden)).toBe("select");
    expect(resolveToolShortcut(key("H"), hidden)).toBe("pan"); // case-insensitive here too
  });

  it("still resets to select on Escape with the rail hidden, so pan mode can be left", () => {
    // Without this there is no way back from the pan tool once the rail is gone.
    expect(resolveToolShortcut(key("Escape"), hidden)).toBe("select");
  });

  it("gates on what a tool DOES, derived from the real maps — never a copied letter list", () => {
    // Walked over the whole alphabet through the REAL toolForShortcut/isShapeTool, so a tool added
    // later is classified by its own nature: a new shape tool is gated automatically, a new
    // navigation tool stays reachable. Hand-listing letters is precisely what swept up `v` and `h`.
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const seen: string[] = [];
    for (const k of letters) {
      const tool = toolForShortcut(k);
      if (!tool) continue;
      seen.push(k);
      const draws = isShapeTool(tool) || tool === "eraser" || tool === "frame";
      expect(resolveToolShortcut(key(k), hidden), `"${k}" → ${tool}`).toBe(draws ? null : tool);
    }
    // Guard the guard: if the shortcut map were ever emptied, every assertion above would vacuously
    // pass. Eleven letters are claimed today (plans/nl-type-to-focus §1, plus `n` for the Frame tool).
    expect(seen).toHaveLength(11);
  });

  it("never steals a key from whatever the user is typing into", () => {
    const typing = { showToolRail: true, editableTarget: true };
    expect(resolveToolShortcut(key("r"), typing)).toBeNull();
    expect(resolveToolShortcut(key("Escape"), typing)).toBeNull();
  });

  it("leaves modifier chords to the hotkey layer", () => {
    expect(resolveToolShortcut(key("r", { metaKey: true }), armed)).toBeNull();
    expect(resolveToolShortcut(key("r", { ctrlKey: true }), armed)).toBeNull();
    expect(resolveToolShortcut(key("r", { altKey: true }), armed)).toBeNull();
  });

  it("ignores keys no tool claims", () => {
    for (const k of ["z", "s", "/", " ", "Enter", "ArrowLeft"]) {
      expect(resolveToolShortcut(key(k), armed), `"${k}" claims no tool`).toBeNull();
    }
  });
});

describe("resolveToolShortcut and jump labels", () => {
  const press = (key: string, opts: Parameters<typeof resolveToolShortcut>[1]) =>
    resolveToolShortcut({ key, metaKey: false, ctrlKey: false, altKey: false }, opts);

  it("stands down entirely while the badges are showing", () => {
    // The jump-label alphabet is the home row and this map owns ten bare letters, so they overlap by
    // construction — `a` is the arrow tool and also the first badge. Without this gate, jumping to a
    // cell would arm a drawing tool on the way.
    expect(press("a", { showToolRail: true, editableTarget: false, jumpLabelsOpen: true })).toBeNull();
  });

  it("still yields Escape's return to select when the badges are closed", () => {
    expect(press("Escape", { showToolRail: true, editableTarget: false })).toBe("select");
  });

  it("does not swallow Escape's meaning when the flag is absent", () => {
    // The option is optional, so every existing caller keeps its behaviour untouched.
    expect(press("r", { showToolRail: true, editableTarget: false })).toBe("rectangle");
  });
});

