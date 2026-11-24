import { describe, expect, it, vi } from "vitest";
import { getDesignTheme } from "@/lib/design-system";
import {
  applyCodespaceMonacoTheme,
  getCodespaceMonacoThemeName,
  highlightCodespaceLines,
} from "../monaco-theme";

type DefinedTheme = { base: string; colors: Record<string, string>; rules: Array<{ token: string; foreground?: string }> };

/** The slice of Monaco that `shikiToMonaco` and the theme service touch. */
function fakeMonaco() {
  const defined = new Map<string, DefinedTheme>();
  const shown: string[] = [];
  const monaco = {
    languages: {
      getLanguages: () => [] as Array<{ id: string }>,
      register: vi.fn(),
      setTokensProvider: vi.fn(),
    },
    editor: {
      defineTheme: (name: string, theme: DefinedTheme) => defined.set(name, theme),
      setTheme: (name: string) => shown.push(name),
      create: vi.fn(),
    },
  };
  return { monaco: monaco as unknown as typeof import("monaco-editor"), defined, shown };
}

describe("CodeSpace editor theme choice", () => {
  it("defaults to Lotus Dark and Lotus Light when no editor theme is saved", () => {
    expect(getCodespaceMonacoThemeName(getDesignTheme("dark"))).toBe("lotus-dark");
    expect(getCodespaceMonacoThemeName(getDesignTheme("light"))).toBe("lotus-light");
    expect(getCodespaceMonacoThemeName(getDesignTheme("dark"), {})).toBe("lotus-dark");
  });

  it("keeps an explicitly saved editor theme", () => {
    const saved = { editorDarkTheme: "gruvbox-dark-hard", editorLightTheme: "gruvbox-light-soft" };
    expect(getCodespaceMonacoThemeName(getDesignTheme("dark"), saved)).toBe("gruvbox-dark-hard");
    expect(getCodespaceMonacoThemeName(getDesignTheme("light"), saved)).toBe("gruvbox-light-soft");
  });
});

describe("applyCodespaceMonacoTheme", () => {
  it("shows Lotus Dark and Lotus Light drawn from the app palettes", async () => {
    const { monaco, defined, shown } = fakeMonaco();

    await applyCodespaceMonacoTheme(monaco, getDesignTheme("dark"));
    expect(shown.at(-1)).toBe("lotus-dark");
    expect(defined.get("lotus-dark")?.colors["editor.background"]).toBe("#161513");
    expect(defined.get("lotus-dark")?.rules.find((rule) => rule.token === "keyword")?.foreground).toBe("d7abd9");

    await applyCodespaceMonacoTheme(monaco, getDesignTheme("light"));
    expect(shown.at(-1)).toBe("lotus-light");
    expect(defined.get("lotus-light")?.colors["editor.background"]).toBe("#faf7f5");
  });

  it("still shows a saved Gruvbox theme", async () => {
    const { monaco, defined, shown } = fakeMonaco();
    await applyCodespaceMonacoTheme(monaco, getDesignTheme("light"), { editorLightTheme: "gruvbox-light-soft" });
    expect(shown.at(-1)).toBe("gruvbox-light-soft");
    expect(defined.has("gruvbox-light-soft")).toBe(true);
  });
});

describe("highlightCodespaceLines", () => {
  it("colours a read-only view with the Lotus palette of the named theme's own mode", async () => {
    // The first line through a fresh grammar can outrun the 100ms tokenize cap on a loaded machine
    // and come back uncoloured by design; compile the grammar first.
    await highlightCodespaceLines("const warm = 0;", "typescript", "lotus-dark");
    const keyword = async (themeName: string) => {
      const [line] = await highlightCodespaceLines("const answer = 42;", "typescript", themeName);
      return line.find((token) => token.content.trim() === "const")?.color?.toLowerCase();
    };
    expect(await keyword("lotus-dark")).toBe("#d7abd9");
    expect(await keyword("lotus-light")).toBe("#82568d");
  });
});
