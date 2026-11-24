import { describe, expect, it } from "vitest";
import { absoluteLinkPath, parseFileLink, resolveFileLink } from "@/lib/file-link";

describe("parseFileLink", () => {
  it.each([
    ["src/x.ts#L10-L20", { path: "src/x.ts", startLine: 10, endLine: 20 }],
    ["src/x.ts#L10-20", { path: "src/x.ts", startLine: 10, endLine: 20 }],
    ["src/x.ts#L10", { path: "src/x.ts", startLine: 10, endLine: 10 }],
    ["src/x.ts:10", { path: "src/x.ts", startLine: 10, endLine: 10 }],
    ["src/x.ts:10:5", { path: "src/x.ts", startLine: 10, endLine: 10 }],
    ["src/x.ts:10-12", { path: "src/x.ts", startLine: 10, endLine: 12 }],
    ["src/x.ts", { path: "src/x.ts" }],
    ["./README.md", { path: "./README.md" }],
    ["/abs/repo/a.ts#L3", { path: "/abs/repo/a.ts", startLine: 3, endLine: 3 }],
    ["file:///abs/repo/a.ts#L3", { path: "/abs/repo/a.ts", startLine: 3, endLine: 3 }],
    ["docs/My%20Notes.md", { path: "docs/My Notes.md" }],
    ["README.md:10", { path: "README.md", startLine: 10, endLine: 10 }],
    ["package.json:5:2", { path: "package.json", startLine: 5, endLine: 5 }],
    ["Makefile:3", { path: "Makefile", startLine: 3, endLine: 3 }],
    ["C:\\proj\\a.ts:4", { path: "C:\\proj\\a.ts", startLine: 4, endLine: 4 }],
    ["file:///C:/proj/a.ts#L2", { path: "C:/proj/a.ts", startLine: 2, endLine: 2 }],
  ])("reads %s", (href, expected) => {
    expect(parseFileLink(href)).toEqual(expected);
  });

  it("orders a reversed range", () => {
    expect(parseFileLink("a.ts#L20-L10")).toEqual({ path: "a.ts", startLine: 10, endLine: 20 });
  });

  it.each(["https://example.com/a.ts", "mailto:a@b.c", "#heading", "", "javascript:alert(1)", "tel:123", "sms:5"])(
    "is not a file link: %s",
    (href) => {
      expect(parseFileLink(href)).toBeNull();
    },
  );
});

describe("resolveFileLink", () => {
  it("resolves a relative path against the workspace root", () => {
    expect(resolveFileLink("src/./lib/../x.ts", "/repo")).toEqual({ ok: true, path: "/repo/src/x.ts" });
  });

  it("accepts an absolute path inside the root", () => {
    expect(resolveFileLink("/repo/a.ts", "/repo/")).toEqual({ ok: true, path: "/repo/a.ts" });
  });

  it.each(["../secret.txt", "/etc/passwd", "/repository/a.ts", "src/../../x"])(
    "refuses a path outside the root: %s",
    (path) => {
      const result = resolveFileLink(path, "/repo");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/outside the workspace/);
    },
  );

  it("treats a Windows drive path as absolute", () => {
    expect(resolveFileLink("C:/proj/src/x.ts", "C:/proj")).toEqual({ ok: true, path: "C:/proj/src/x.ts" });
    expect(resolveFileLink("C:\\proj\\src\\x.ts", "C:\\proj")).toEqual({ ok: true, path: "C:/proj/src/x.ts" });
    expect(resolveFileLink("D:/other/x.ts", "C:/proj").ok).toBe(false);
  });
});

describe("absoluteLinkPath", () => {
  it("anchors a relative link at the folder the agent works in", () => {
    expect(absoluteLinkPath("src/a.ts", "/repo/packages/app")).toBe("/repo/packages/app/src/a.ts");
    expect(absoluteLinkPath("../lib/b.ts", "/repo/packages/app")).toBe("/repo/packages/lib/b.ts");
  });

  it("leaves an absolute link alone", () => {
    expect(absoluteLinkPath("/repo/a.ts", "/elsewhere")).toBe("/repo/a.ts");
    expect(absoluteLinkPath("C:/proj/a.ts", "/elsewhere")).toBe("C:/proj/a.ts");
  });
});
