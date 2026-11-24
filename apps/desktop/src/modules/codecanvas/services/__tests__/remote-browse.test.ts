import { describe, expect, it } from "vitest";
import {
  browseCrumbs,
  initialBrowsePath,
  joinBrowsePath,
  normalizeBrowsePath,
  parentBrowsePath,
} from "../remote-browse";

describe("walking a remote directory", () => {
  it("normalises away trailing slashes but keeps the root", () => {
    expect(normalizeBrowsePath("/srv/devbox/")).toBe("/srv/devbox");
    expect(normalizeBrowsePath("/srv//")).toBe("/srv");
    expect(normalizeBrowsePath("/")).toBe("/");
    expect(normalizeBrowsePath("  ")).toBe("/");
  });

  it("goes up one level, and says so honestly at the root", () => {
    expect(parentBrowsePath("/srv/devbox/api")).toBe("/srv/devbox");
    expect(parentBrowsePath("/srv")).toBe("/");
    expect(parentBrowsePath("/")).toBeNull();
  });

  it("builds a breadcrumb every segment of which is navigable", () => {
    expect(browseCrumbs("/srv/devbox")).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "devbox", path: "/srv/devbox" },
    ]);
    expect(browseCrumbs("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("joins without doubling or dropping the separator", () => {
    expect(joinBrowsePath("/srv/devbox", "api")).toBe("/srv/devbox/api");
    expect(joinBrowsePath("/srv/devbox/", "api")).toBe("/srv/devbox/api");
    expect(joinBrowsePath("/", "srv")).toBe("/srv");
  });

  it("starts somewhere a person would recognise, not at the system root", () => {
    expect(initialBrowsePath({ user: "root" })).toBe("/root");
    expect(initialBrowsePath({ user: "deploy" })).toBe("/home/deploy");
    expect(initialBrowsePath({})).toBe("/");
  });
});
