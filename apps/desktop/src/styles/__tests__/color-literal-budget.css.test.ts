import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import baseline from "../color-literal-baseline.json";
import { compareToBaseline, countColorLiterals } from "./color-literals";

/**
 * Colour-literal budget for app CSS (PLAN app-theme-dark-light-premium §5, Theme 09).
 *
 * Every hard-coded colour in app CSS is a colour that does not follow the theme. The sweep that
 * replaces them with tokens goes file by file, and between sweeps nothing stops a new `#fff` from
 * landing. This holds each file to its count in color-literal-baseline.json: it may not rise, and
 * when it falls the baseline is lowered in the same commit, so a saving cannot quietly be spent.
 *
 * Scope is the top level of src/app and src/styles. src/styles/canvas/ is out: Canvas Style themes
 * own their own palette. Counting and exemption rules: src/styles/README.md.
 */

const ROOT = process.cwd();
const SCANNED_DIRS = ["src/app", "src/styles"];

function appStylesheets(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(resolve(ROOT, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => `${dir}/${entry.name}`),
  ).sort();
}

describe("app CSS colour-literal budget", () => {
  const counts = Object.fromEntries(
    appStylesheets().map((file) => [file, countColorLiterals(readFileSync(resolve(ROOT, file), "utf8"))]),
  );

  it("scans the app stylesheets and none of Canvas's", () => {
    expect(Object.keys(counts)).toContain("src/app/globals.css");
    expect(Object.keys(counts)).toContain("src/styles/design-system.css");
    expect(Object.keys(counts).some((file) => file.startsWith("src/styles/canvas/"))).toBe(false);
  });

  it("holds every file to its baseline", () => {
    const totals = Object.fromEntries(Object.entries(counts).map(([file, c]) => [file, c.count]));
    expect(compareToBaseline(totals, baseline)).toEqual([]);
  });

  it("gives a reason for every exemption", () => {
    const missing = Object.entries(counts).flatMap(([file, c]) =>
      c.markersWithoutReason.map((line) => `${file}:${line}`),
    );
    expect(missing).toEqual([]);
  });
});
