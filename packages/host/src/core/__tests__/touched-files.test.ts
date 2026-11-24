import { describe, expect, it } from "vitest";

import { extractTouchedFiles } from "../touched-files.js";

describe("extractTouchedFiles", () => {
  it("extracts repo-relative files from common summary formats", () => {
    const text = [
      "Files changed:",
      "- src/auth/login.ts",
      "- `src/auth/login.test.ts`",
      "Modified: lotus-remote/src/core/work-store.ts",
      "Ran tests successfully.",
    ].join("\n");

    expect(extractTouchedFiles(text)).toEqual([
      "src/auth/login.ts",
      "src/auth/login.test.ts",
      "lotus-remote/src/core/work-store.ts",
    ]);
  });

  it("ignores URLs, absolute paths, and path traversal", () => {
    const text = [
      "https://example.com/file.ts",
      "/etc/passwd",
      "../secret.txt",
      "src/safe.ts",
    ].join("\n");

    expect(extractTouchedFiles(text)).toEqual(["src/safe.ts"]);
  });

  it("deduplicates and caps output", () => {
    const text = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`).join("\n") + "\nsrc/file-1.ts";

    expect(extractTouchedFiles(text, 3)).toEqual([
      "src/file-0.ts",
      "src/file-1.ts",
      "src/file-2.ts",
    ]);
  });
});
