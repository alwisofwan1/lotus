import { describe, expect, it } from "vitest";

import { resolveStateDir } from "../state-dir.js";

const HOME = "/Users/x";

describe("resolveStateDir", () => {
  // Rust resolves `~/.lotus` for release and `~/.lotus-dev` for dev. This process
  // cannot tell which build spawned it, so the parent's answer has to win or dev
  // and release quietly share one set of device credentials.
  it("prefers the state dir Rust passed", () => {
    expect(resolveStateDir({ LOTUS_STATE_DIR: "/Users/x/.lotus-dev" }, HOME)).toBe(
      "/Users/x/.lotus-dev",
    );
  });

  it("falls back to ~/.lotus when the parent said nothing", () => {
    expect(resolveStateDir({}, HOME)).toBe("/Users/x/.lotus");
  });

  // An empty or whitespace value is a misconfigured parent, not a request to use
  // the filesystem root. Treat it as absent.
  it.each(["", "   ", "\t"])("treats %j as absent", (value) => {
    expect(resolveStateDir({ LOTUS_STATE_DIR: value }, HOME)).toBe("/Users/x/.lotus");
  });

  // A relative path resolves against cwd, and a spawned child's cwd is whatever
  // the parent happened to have. Credentials must not land somewhere that moves.
  it.each([".lotus", "./state", "../shared"])("refuses the relative path %j", (value) => {
    expect(resolveStateDir({ LOTUS_STATE_DIR: value }, HOME)).toBe("/Users/x/.lotus");
  });

  it("trims surrounding whitespace rather than failing on it", () => {
    expect(resolveStateDir({ LOTUS_STATE_DIR: "  /var/lotus  " }, HOME)).toBe("/var/lotus");
  });
});
