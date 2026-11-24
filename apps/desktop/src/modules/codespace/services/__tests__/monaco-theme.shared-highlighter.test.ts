import { describe, expect, it } from "vitest";
import { getDesignTheme } from "@/lib/design-system";
import { applyCodespaceMonacoTheme, highlightCodespaceLines } from "../monaco-theme";

/*
 * The editor and the canvas File Node share one Shiki highlighter. Monaco's tokenizer reads token
 * colours from whichever theme that highlighter last switched to, so a File Node highlighting in the
 * other mode must not leave the editor painting with it. Its own file: Monaco is wired to the
 * highlighter once per module, so this needs a Monaco no other test has integrated yet.
 */

type Tokenizer = {
  getInitialState(): unknown;
  tokenize(line: string, state: unknown): { tokens: Array<{ startIndex: number; scopes: string }> };
};

function fakeMonaco() {
  const languages: Array<{ id: string }> = [];
  const tokenizers = new Map<string, Tokenizer>();
  const monaco = {
    languages: {
      getLanguages: () => languages,
      register: (language: { id: string }) => languages.push(language),
      setTokensProvider: (id: string, provider: Tokenizer) => tokenizers.set(id, provider),
    },
    editor: { defineTheme: () => {}, setTheme: () => {}, create: () => {} },
  };
  return { monaco: monaco as unknown as typeof import("monaco-editor"), tokenizers };
}

/** The scope Monaco paints the first token of `line` with. */
function firstScope(tokenizer: Tokenizer | undefined, line: string): string | undefined {
  return tokenizer?.tokenize(line, tokenizer.getInitialState()).tokens[0]?.scopes;
}

describe("the shared Shiki highlighter", () => {
  it("leaves the editor tokenizing in its own theme after a File Node used the other one", async () => {
    const { monaco, tokenizers } = fakeMonaco();
    // A saved editor theme whose colour table differs from Lotus Light's.
    await applyCodespaceMonacoTheme(monaco, getDesignTheme("dark"), { editorDarkTheme: "dracula" });
    // compile the grammar first, so the 100ms tokenize cap cannot leave a line uncoloured
    firstScope(tokenizers.get("typescript"), "const warm = 0;");
    const before = firstScope(tokenizers.get("typescript"), "const answer = 42;");
    expect(before).toMatch(/\S/);

    await highlightCodespaceLines("const answer = 42;", "typescript", "lotus-light");

    expect(firstScope(tokenizers.get("typescript"), "const answer = 42;")).toBe(before);
  });
});
