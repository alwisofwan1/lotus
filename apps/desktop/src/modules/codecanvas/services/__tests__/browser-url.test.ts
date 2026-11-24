import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "../browser-url";

describe("normalizeBrowserUrl", () => {
  it("keeps explicit URLs and blank pages unchanged", () => {
    expect(normalizeBrowserUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
  });

  it("normalizes local and domain inputs into navigable URLs", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs");
  });

  it("maps common spoken site names and falls back to search", () => {
    expect(normalizeBrowserUrl("YouTube")).toBe("https://www.youtube.com/");
    expect(normalizeBrowserUrl("lotus browser node")).toBe("https://www.google.com/search?q=lotus%20browser%20node");
  });

  it("keeps file:// URLs unchanged so local files are not treated as searches", () => {
    expect(normalizeBrowserUrl("file:///Users/alwi/proj/index.html")).toBe(
      "file:///Users/alwi/proj/index.html",
    );
    expect(normalizeBrowserUrl("  FILE:///tmp/a.html  ")).toBe("file:///tmp/a.html");
  });

  it("promotes an absolute local path to a file:// URL", () => {
    expect(normalizeBrowserUrl("/Users/alwi/proj/index.html")).toBe(
      "file:///Users/alwi/proj/index.html",
    );
  });
});
