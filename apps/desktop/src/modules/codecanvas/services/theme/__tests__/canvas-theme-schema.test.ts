import { describe, it, expect } from "vitest";
import { validateCanvasThemeSpec } from "../canvas-theme-schema";
import { mergeCanvasThemeCatalog } from "../canvas-theme-catalog";
import { BUILTIN_THEMES } from "../builtin-themes";

// A minimal valid user theme spec (solid material → no glass needed).
function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-sample",
    name: "Lakeside",
    descriptor: "mediterranean lake · sun on stone",
    mode: "dark",
    material: "solid",
    paper: { fill: "#0a1428", pattern: "none" },
    palette: { accent: "#7cc7ff", agent: "#8b9cff", task: "#5eead4", note: "#fcd34d", info: "#a5b4fc" },
    surface: { base: "#121a2b", raised: "#18233a", border: "rgba(1,1,1,0.1)", borderStrong: "rgba(1,1,1,0.2)", text: "#fff", textMuted: "rgba(255,255,255,0.5)", chromeAccent: "#cdd9f5" },
    fonts: { display: "Caveat", body: "Inter", mono: "JetBrains Mono" },
    schemaVersion: 1,
    ...overrides,
  };
}

describe("validateCanvasThemeSpec", () => {
  it("accepts a well-formed spec and stamps origin=user", () => {
    const r = validateCanvasThemeSpec(validSpec());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.theme.origin).toBe("user");
  });

  it("ignores an authored origin and forces user", () => {
    const r = validateCanvasThemeSpec(validSpec({ origin: "builtin" }));
    expect(r.ok && r.theme.origin).toBe("user");
  });

  it("rejects a bad id, missing palette role, and wrong schemaVersion", () => {
    const r = validateCanvasThemeSpec(validSpec({
      id: "Not Kebab", palette: { accent: "#fff", agent: "#fff", task: "#fff", note: "#fff" }, schemaVersion: 2,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((m) => m.includes("id"))).toBe(true);
      expect(r.errors.some((m) => m.includes("palette.info"))).toBe(true);
      expect(r.errors.some((m) => m.includes("schemaVersion"))).toBe(true);
    }
  });

  it("requires glass config when material is glass", () => {
    const r = validateCanvasThemeSpec(validSpec({ material: "glass" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((m) => m.includes("glass config is required"))).toBe(true);
  });

  it("rejects a non-whitelisted font", () => {
    const r = validateCanvasThemeSpec(validSpec({ fonts: { display: "Comic Sans", body: "Inter", mono: "JetBrains Mono" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((m) => m.includes("whitelist"))).toBe(true);
  });

  it("requires a poster for video media", () => {
    const r = validateCanvasThemeSpec(validSpec({ paper: { fill: "#000", media: { kind: "video", src: "x.mp4", fit: "cover" } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((m) => m.includes("poster"))).toBe(true);
  });
});

describe("mergeCanvasThemeCatalog", () => {
  it("appends valid user themes after the built-ins", () => {
    const { themes, skipped } = mergeCanvasThemeCatalog([validSpec()]);
    expect(skipped).toHaveLength(0);
    expect(themes.map((t) => t.id)).toEqual([...BUILTIN_THEMES.map((t) => t.id), "user-sample"]);
  });

  it("skips invalid specs without throwing and reports them", () => {
    const { themes, skipped } = mergeCanvasThemeCatalog([{ id: "broken" }, validSpec()]);
    expect(themes.map((t) => t.id)).toContain("user-sample");
    expect(themes.map((t) => t.id)).not.toContain("broken");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe("broken");
  });

  it("won't let a user theme shadow a built-in id", () => {
    const { themes, skipped } = mergeCanvasThemeCatalog([validSpec({ id: "void" })]);
    expect(themes.filter((t) => t.id === "void")).toHaveLength(1);
    expect(themes.find((t) => t.id === "void")?.origin).toBe("builtin");
    expect(skipped[0].errors[0]).toMatch(/collides/);
  });
});
