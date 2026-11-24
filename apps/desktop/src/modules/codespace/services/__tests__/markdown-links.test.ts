import { describe, expect, it } from "vitest";
import { resolveMarkdownPath } from "@/modules/codespace/services/markdown-links";

describe("resolveMarkdownPath", () => {
  const file = "/repo/docs/guide/README.md";

  it("reads a relative path from the file's folder", () => {
    expect(resolveMarkdownPath("img/a.png", file)).toBe("/repo/docs/guide/img/a.png");
    expect(resolveMarkdownPath("./a.png", file)).toBe("/repo/docs/guide/a.png");
    expect(resolveMarkdownPath("../../assets/logo%20big.png?raw=1#x", file)).toBe("/repo/assets/logo big.png");
  });

  it("reads a path starting with / from the workspace root", () => {
    expect(resolveMarkdownPath("/assets/a.png", file, "/repo/")).toBe("/repo/assets/a.png");
  });

  it("is null for links that leave the disk", () => {
    for (const target of ["https://x.dev/a.png", "data:image/png;base64,AA", "mailto:a@b.c", "//cdn/a.png", "#usage", "  "]) {
      expect(resolveMarkdownPath(target, file)).toBeNull();
    }
  });
});
