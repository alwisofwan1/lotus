import { describe, expect, it } from "vitest";
import { contrastRatio, getDesignTheme } from "@/lib/design-system";
import type { AppTheme } from "@/lib/design-system";
import { buildLotusEditorTheme } from "../lotus-editor-theme";

function withTerminal(theme: AppTheme, terminal: Partial<AppTheme["terminal"]>): AppTheme {
  return { ...theme, terminal: { ...theme.terminal, ...terminal } };
}

function withUiBackground(theme: AppTheme, background: string): AppTheme {
  return { ...theme, ui: { ...theme.ui, background } };
}

describe("buildLotusEditorTheme", () => {
  it("names the theme after the app theme's mode", () => {
    expect(buildLotusEditorTheme(getDesignTheme("dark"))).toMatchObject({ name: "lotus-dark", type: "dark" });
    expect(buildLotusEditorTheme(getDesignTheme("light"))).toMatchObject({ name: "lotus-light", type: "light" });
  });

  it("paints the editor chrome with the terminal's palette, in hex Monaco can parse", () => {
    const colors = buildLotusEditorTheme(getDesignTheme("dark")).colors;
    expect(colors["editor.foreground"]).toBe("#f7f2ea");
    expect(colors["editorCursor.foreground"]).toBe("#f5f2ef");
    // rgba(245,242,239,0.18)
    expect(colors["editor.selectionBackground"]).toBe("#f5f2ef2e");
  });

  // Mockup T5: only the terminal is the deeper well; the editor sits on the app's own ground.
  it("sits the editor and its gutter on the app background, not the terminal's well", () => {
    for (const [mode, ground] of [["dark", "#161513"], ["light", "#faf7f5"]] as const) {
      const colors = buildLotusEditorTheme(getDesignTheme(mode)).colors;
      expect(colors["editor.background"], mode).toBe(ground);
      expect(colors["editorGutter.background"], mode).toBe(ground);
    }
    const moved = buildLotusEditorTheme(withUiBackground(getDesignTheme("dark"), "#202428")).colors;
    expect(moved["editor.background"]).toBe("#202428");
    expect(moved["editorGutter.background"]).toBe("#202428");
  });

  it("follows a palette change", () => {
    const changed = withTerminal(getDesignTheme("dark"), {
      background: "#101418",
      foreground: "#e0e4e8",
      cursor: "#aabbcc",
      selectionBackground: "rgba(16,32,48,0.5)",
      magenta: "#ff99ff",
      // Line numbers read brightBlack; it already clears its floor on both backgrounds, so only a new
      // brightBlack — not a new background — changes them.
      brightBlack: "#8899aa",
    });
    const before = buildLotusEditorTheme(getDesignTheme("dark"));
    const after = buildLotusEditorTheme(changed);

    // The terminal's well no longer moves the editor's ground.
    expect(after.colors["editor.background"]).toBe(before.colors["editor.background"]);
    expect(after.colors["editor.foreground"]).toBe("#e0e4e8");
    expect(after.colors["editorCursor.foreground"]).toBe("#aabbcc");
    expect(after.colors["editor.selectionBackground"]).toBe("#10203080");
    expect(after.colors["editorLineNumber.foreground"]).not.toBe(before.colors["editorLineNumber.foreground"]);
    expect(keywordColor(after)).toBe("#ff99ff");
    expect(keywordColor(before)).not.toBe("#ff99ff");
  });
});

describe("Lotus editor syntax contrast", () => {
  const palettes: Array<[string, AppTheme]> = [
    ["dark", getDesignTheme("dark")],
    ["light", getDesignTheme("light")],
    // Light's ANSI white (#d7d0c8 on #fff, 1.5:1) and a washed-out green must not reach the editor as is.
    ["light, faint palette", withTerminal(getDesignTheme("light"), { green: "#e8f5e8", magenta: "#ffeeff" })],
  ];

  it.each(palettes)("every token colour reads at 4.5:1 or better on the %s editor background", (_name, theme) => {
    const editor = buildLotusEditorTheme(theme);
    const background = editor.colors["editor.background"];
    expect(background).toBe(theme.ui.background);
    expect(contrastRatio(editor.colors["editor.foreground"], background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(editor.colors["editorLineNumber.foreground"], background)).toBeGreaterThanOrEqual(3);
    for (const rule of editor.tokenColors) {
      if (!rule.settings.foreground) continue;
      expect(contrastRatio(rule.settings.foreground, background), String(rule.scope)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps a palette colour untouched when it already reads", () => {
    // Dark magenta #d7abd9 on #161513 is ~9:1.
    expect(keywordColor(buildLotusEditorTheme(getDesignTheme("dark")))).toBe("#d7abd9");
  });
});

function keywordColor(theme: ReturnType<typeof buildLotusEditorTheme>): string | undefined {
  return theme.tokenColors.find((rule) => [rule.scope].flat().includes("keyword"))?.settings.foreground;
}
