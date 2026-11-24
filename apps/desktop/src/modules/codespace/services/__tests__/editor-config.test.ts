import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEditorConfigCache,
  editorConfigFolders,
  editorConfigGlobMatches,
  loadEditorConfig,
  resolveEditorConfig,
} from "../editor-config";

describe("editorConfigGlobMatches", () => {
  it.each([
    ["*", "a.ts", true],
    ["*", "src/deep/a.ts", true],
    ["*.ts", "src/a.ts", true],
    ["*.ts", "src/a.tsx", false],
    ["*.{js,ts}", "x/b.js", true],
    ["*.{js,ts}", "x/b.py", false],
    ["{package.json,.travis.yml}", "package.json", true],
    ["lib/**.js", "lib/a/b.js", true],
    ["lib/**.js", "src/lib/a.js", false],
    ["/Makefile", "Makefile", true],
    ["src/**/x.ts", "src/x.ts", true],
    ["file[0-9].txt", "file3.txt", true],
    ["file[!0-9].txt", "file3.txt", false],
    ["v{1..3}.md", "v2.md", true],
    ["v{1..3}.md", "v4.md", false],
    ["a?.md", "ab.md", true],
  ])("%s on %s is %s", (glob, path, expected) => {
    expect(editorConfigGlobMatches(glob, path)).toBe(expected);
  });
});

describe("resolveEditorConfig", () => {
  const root = `root = true
[*]
indent_style = space
indent_size = 2
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
`;

  it("applies matching sections, later ones winning", () => {
    expect(resolveEditorConfig("/r/src/a.ts", [{ dir: "/r", text: root }])).toEqual({
      indentStyle: "space", indentSize: 2, tabWidth: 2, endOfLine: "LF", insertFinalNewline: true, trimTrailingWhitespace: true,
    });
    expect(resolveEditorConfig("/r/doc/a.md", [{ dir: "/r", text: root }])?.trimTrailingWhitespace).toBe(false);
    expect(resolveEditorConfig("/r/Makefile", [{ dir: "/r", text: root }])?.indentStyle).toBe("tab");
  });

  it("lets a closer file win and stops at root = true", () => {
    const sub = "[*.ts]\nindent_size = 4\n";
    const above = "[*]\nend_of_line = crlf\n";
    const config = resolveEditorConfig("/r/pkg/a.ts", [{ dir: "/r/pkg", text: sub }, { dir: "/r", text: root }, { dir: "", text: above }]);
    expect(config?.indentSize).toBe(4);
    expect(config?.endOfLine).toBe("LF");
  });

  it("reads indent_size = tab from tab_width", () => {
    expect(resolveEditorConfig("/r/a.go", [{ dir: "/r", text: "[*]\nindent_style=tab\nindent_size=tab\ntab_width=8\n" }]))
      .toEqual({ indentStyle: "tab", indentSize: 8, tabWidth: 8 });
  });

  it("is null when nothing matches", () => {
    expect(resolveEditorConfig("/r/a.py", [{ dir: "/r", text: "[*.ts]\nindent_size=2\n" }])).toBeNull();
  });
});

describe("loadEditorConfig", () => {
  beforeEach(() => clearEditorConfigCache());

  it("lists folders closest first", () => {
    expect(editorConfigFolders("/a/b/c.ts")).toEqual(["/a/b", "/a", "/"]);
  });

  it("reads every folder upwards, applies up to root = true, and caches reads", async () => {
    const files: Record<string, string> = {
      "/a/b/.editorconfig": "[*]\nindent_size = 4\n",
      "/a/.editorconfig": "root = true\n[*]\nindent_style = space\n",
      "/.editorconfig": "[*]\nend_of_line = crlf\n",
    };
    const read = vi.fn(async (path: string) => files[path] ?? null);
    const config = await loadEditorConfig("/a/b/c.ts", read, () => 0);
    expect(config).toEqual({ indentStyle: "space", indentSize: 4, tabWidth: 4 });
    expect(read.mock.calls.map(([path]) => path)).toEqual(["/a/b/.editorconfig", "/a/.editorconfig", "/.editorconfig"]);
    await loadEditorConfig("/a/b/c.ts", read, () => 1000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("treats a failed read as no file", async () => {
    const config = await loadEditorConfig("/a/b.ts", async (path) => {
      if (path === "/a/.editorconfig") throw new Error("not found");
      return path === "/.editorconfig" ? "[*]\nindent_size = 3\n" : null;
    });
    expect(config?.indentSize).toBe(3);
  });
});
