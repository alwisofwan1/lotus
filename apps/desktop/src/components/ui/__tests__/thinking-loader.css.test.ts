import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(resolve(process.cwd(), p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("thinking pill skin", () => {
  const ds = read("src/styles/design-system.css");
  const globals = read("src/app/globals.css");

  it("keeps its colour defaults at zero specificity, so a surface class wins", () => {
    // design-system.css loads after globals.css (app/layout.tsx). At equal specificity the
    // defaults overrode `.codechat-thinking` and light CodeChat lost its slate ink — seen in a
    // browser. :where() makes the order irrelevant.
    expect(ds).toMatch(/:where\(\.ui-thinking\)\s*\{[^}]*--ui-thinking-dim:/);
    const plain = ds.match(/(?<!:where\()\.ui-thinking\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(plain).not.toMatch(/--ui-thinking-(dim|bright)\s*:|background\s*:|border-color\s*:/);
  });

  it("maps CodeChat onto its own text tokens", () => {
    const rule = globals.match(/\.codechat-thinking\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/--ui-thinking-dim:\s*var\(--codechat-text-tertiary\)/);
    expect(rule).toMatch(/--ui-thinking-bright:\s*var\(--codechat-text-primary\)/);
  });

  it("maps the canvas transcript onto canvas ink", () => {
    const rule = read("src/styles/canvas/agent-node.css").match(/\.agent-thinking\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/--ui-thinking-bright:\s*var\(--canvas-text\)/);
    expect(rule).toMatch(/border-color:\s*var\(--canvas-border\)/);
  });

  it("stops the spinner and the sweep under reduced motion", () => {
    expect(ds).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.ui-thinking__label[^}]*animation:\s*none/);
    expect(ds).not.toMatch(/\.ui-thinking[^{]*\{[^}]*(backdrop-filter|filter:\s*blur)/);
  });
});
