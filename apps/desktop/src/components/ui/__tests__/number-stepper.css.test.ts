import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ds = readFileSync(resolve(process.cwd(), "src/styles/design-system.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("number stepper skin", () => {
  it("keeps its colour defaults at zero specificity, so a surface class wins", () => {
    expect(ds).toMatch(/:where\(\.ui-stepper\)\s*\{[^}]*background:\s*var\(--bg-elevated\)/);
    const plain = ds.match(/(?<!:where\()\.ui-stepper\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(plain).not.toMatch(/background\s*:|border-color\s*:|(?<!-)color\s*:/);
  });

  it("hides the input's own text only while the rolling digits stand in for it", () => {
    // Keyed on the overlay being present, not on :focus: an arrow key rolls a focused field, and
    // hiding by focus drew the typed text and the digits on top of each other — seen in a browser.
    expect(ds).toMatch(/\.ui-stepper__value\[data-rolling\] \.ui-stepper__input\s*\{[^}]*color:\s*transparent/);
    expect(ds).not.toMatch(/\.ui-stepper__input:focus/);
  });

  it("lets an empty value's meaning size the box, with the input still over it", () => {
    // "20 · default" is wider than the 5ch the digits use; measured in a browser at 87px vs 36px.
    expect(ds).toMatch(/\.ui-stepper__value\[data-empty\]\s*\{[^}]*width:\s*auto/);
    expect(ds).toMatch(/\.ui-stepper__value\[data-empty\] \.ui-stepper__input\s*\{[^}]*position:\s*absolute/);
    expect(ds).toMatch(/\.ui-stepper__empty\s*\{[^}]*pointer-events:\s*none/);
  });

  it("uses no blur", () => {
    expect(ds).not.toMatch(/\.ui-stepper[^{]*\{[^}]*(backdrop-filter|filter:\s*blur)/);
  });
});
