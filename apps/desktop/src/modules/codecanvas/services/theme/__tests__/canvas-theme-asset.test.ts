import { describe, it, expect } from "vitest";
import { isLocalAssetRef, toDataUri } from "../canvas-theme-asset";

describe("isLocalAssetRef", () => {
  it("treats relative paths as local (need resolution)", () => {
    expect(isLocalAssetRef("hanami.mp4")).toBe(true);
    expect(isLocalAssetRef("assets/poster.jpg")).toBe(true);
  });
  it("treats remote/data/blob refs as ready", () => {
    expect(isLocalAssetRef("https://x/img.jpg")).toBe(false);
    expect(isLocalAssetRef("http://x/v.mp4")).toBe(false);
    expect(isLocalAssetRef("data:image/png;base64,AAAA")).toBe(false);
    expect(isLocalAssetRef("blob:abc")).toBe(false);
  });
  it("treats web-absolute paths (bundled built-in assets) as ready", () => {
    expect(isLocalAssetRef("/assets/background/nature-dark.jpg")).toBe(false);
  });
  it("empty is not local", () => {
    expect(isLocalAssetRef("")).toBe(false);
  });
});

describe("toDataUri", () => {
  it("builds a data URI", () => {
    expect(toDataUri("video/mp4", "QUJD")).toBe("data:video/mp4;base64,QUJD");
  });
});
