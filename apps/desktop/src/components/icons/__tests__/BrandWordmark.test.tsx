import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandWordmark } from "../BrandWordmark";

describe("BrandWordmark", () => {
  // The brand files ship named after the logo's own ink — the white-ink lockup is called
  // "light" — while the app names assets after the theme they render in. The generator crosses
  // them over, and this is the guard that keeps the crossover from being "fixed" back.
  it("tags the dark-ink wordmark for the light theme and the light-ink one for the dark theme", () => {
    const { container } = render(<BrandWordmark />);
    expect(container.querySelector('[data-brand-variant="light"]')?.getAttribute("src")).toBe("/wordmark-light.png");
    expect(container.querySelector('[data-brand-variant="dark"]')?.getAttribute("src")).toBe("/wordmark-dark.png");
  });

  // Rendering is theme-independent, so server and client HTML always match (no hydration error).
  it("renders the same markup whatever the stored theme, and leaves the choice to CSS", () => {
    const css = readFileSync(resolve(__dirname, "../../../app/globals.css"), "utf8");
    expect(css).toContain('[data-theme-type="light"] img[data-brand-variant="dark"]');
    expect(css).toContain('[data-theme-type="light"] img[data-brand-variant="light"] { display: block; }');
  });
});
