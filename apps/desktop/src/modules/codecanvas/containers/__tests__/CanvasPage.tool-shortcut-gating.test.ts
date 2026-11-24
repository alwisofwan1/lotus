import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// plans/nl-type-to-focus §3: `showToolRail` (a real Canvas setting) only ever gated *rendering*
// the rail — the keyboard-shortcut effect below had an empty dependency array and never read the
// setting at all, so hiding the rail still let a bare `r` arm the rectangle tool with no visible
// rail to explain why. CanvasPage is a large container component (heavy provider/context tree),
// so — matching the existing chrome-wiring tests in this directory — this asserts against the
// source text rather than mounting the whole page.
describe("tool-shortcut effect respects showToolRail (plans/nl-type-to-focus §3)", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");
  // Isolated by its own leading comment through its closing dependency array, so a coincidental
  // `showToolRail` mention elsewhere in this large file can't make these assertions false-positive.
  const effectMatch = source.match(
    /\/\/ Tool-rail keyboard shortcuts[\s\S]*?window\.addEventListener\("keydown", onKey\);[\s\S]*?return \(\) => window\.removeEventListener\("keydown", onKey\);\s*\n\s*\}, (\[[^\]]*\])\);/,
  );

  it("the effect exists at its known location", () => {
    expect(effectMatch).not.toBeNull();
  });

  it("re-subscribes when showToolRail changes — not an empty, stale dependency array", () => {
    const deps = effectMatch?.[1] ?? "";
    expect(deps).toContain("showToolRail");
  });

  it("delegates the decision to resolveToolShortcut and feeds it the live setting", () => {
    // The gate's LOGIC is covered behaviourally in services/__tests__/canvas-tool.test.ts
    // (resolveToolShortcut). What only source text can prove is the wiring: that this container
    // actually calls it and actually hands it the reactive `showToolRail`, rather than re-deriving
    // the rules inline where they could drift away from the tested function.
    const body = effectMatch?.[0] ?? "";
    expect(body).toMatch(/resolveToolShortcut\(event, \{/);
    expect(body).toMatch(/showToolRail,/);
    expect(body).toMatch(/editableTarget: isEditableCanvasKeyTarget\(event\.target\)/);
  });
});
