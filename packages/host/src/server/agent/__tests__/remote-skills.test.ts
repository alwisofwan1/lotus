import { describe, it, expect } from "vitest";
import { resolveRemoteSkillMount, remoteSkillArgs } from "../remote-skills.js";

describe("resolveRemoteSkillMount()", () => {
  it("resolves the isolated agent-mount under .lotus-remote in the given home", () => {
    expect(resolveRemoteSkillMount("/home/op")).toBe("/home/op/.lotus-remote/agent-mount");
  });

  it("does not expose the .lotus-remote root itself (secrets stay outside the mount)", () => {
    const mount = resolveRemoteSkillMount("/home/op");
    expect(mount.endsWith("/.lotus-remote/agent-mount")).toBe(true);
    expect(mount).not.toBe("/home/op/.lotus-remote");
  });
});

describe("remoteSkillArgs()", () => {
  it("returns [--add-dir, mount] when the request is remote-scoped", () => {
    expect(remoteSkillArgs("/m", true)).toEqual(["--add-dir", "/m"]);
  });

  it("returns an empty array when not remote-scoped", () => {
    expect(remoteSkillArgs("/m", false)).toEqual([]);
  });

  it("returns an empty array when the flag is undefined (default off)", () => {
    expect(remoteSkillArgs("/m", undefined)).toEqual([]);
  });
});
