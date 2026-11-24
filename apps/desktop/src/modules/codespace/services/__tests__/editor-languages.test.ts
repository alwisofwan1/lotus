import { describe, expect, it } from "vitest";
import {
  EDITOR_HIGHLIGHT_LANGUAGES,
  editorLanguageLabel,
  resolveEditorLanguage,
} from "../editor-languages";

describe("editor languages", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["src/App.jsx", "jsx"],
    ["src/index.ts", "typescript"],
    ["Cargo.toml", "toml"],
    ["styles/app.scss", "scss"],
    ["tsconfig.jsonc", "jsonc"],
    ["tsconfig.json", "jsonc"],
    ["package.json", "json"],
    ["docs/page.mdx", "mdx"],
    ["app/Http/UserController.php", "php"],
    ["lib/task.rb", "ruby"],
    ["Gemfile", "ruby"],
    ["src/App.vue", "vue"],
    ["src/App.svelte", "svelte"],
    ["app/Main.kt", "kotlin"],
    ["Sources/App.swift", "swift"],
    ["scripts/setup.zsh", "shell"],
    [".zshrc", "shell"],
    [".env", "dotenv"],
    [".env.local", "dotenv"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "make"],
    ["notes.txt", "plaintext"],
    ["LICENSE", "plaintext"],
  ])("%s → %s", (path, language) => {
    expect(resolveEditorLanguage(path)).toBe(language);
  });

  it("reads Windows paths and upper-case extensions", () => {
    expect(resolveEditorLanguage("C:\\repo\\src\\App.TSX")).toBe("tsx");
    expect(resolveEditorLanguage(null)).toBe("plaintext");
  });

  it("has a highlighter grammar and a name for every language it can pick", () => {
    const picked = new Set(
      ["a.ts", "a.tsx", "a.js", "a.jsx", "a.json", "a.jsonc", "a.css", "a.scss", "a.less", "a.html", "a.md", "a.mdx",
        "a.vue", "a.svelte", "a.rs", "a.py", "a.go", "a.rb", "a.php", "a.kt", "a.swift", "a.java", "a.c", "a.cpp",
        "a.cs", "a.sh", "a.toml", "a.yaml", "a.sql", "a.xml", "a.graphql", "a.lua", "Dockerfile", ".env", "Makefile"]
        .map(resolveEditorLanguage),
    );
    for (const language of picked) {
      expect(EDITOR_HIGHLIGHT_LANGUAGES).toContain(language);
      expect(editorLanguageLabel(language)).not.toBe(language);
    }
    expect(editorLanguageLabel("tsx")).toBe("TypeScript JSX");
    expect(editorLanguageLabel("plaintext")).toBe("Plain Text");
  });
});
