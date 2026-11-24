import { describe, expect, it } from "vitest";

import { crumbsOf, needsLogin, shortPath } from "../ChatMachines";

const roots = [{ name: "workspace", path: "/home/alwi/workspace" }, { name: "srv", path: "/srv" }];

describe("the remote folder browser's breadcrumb", () => {
  it("starts at the root holding the folder, one step per folder below it", () => {
    expect(crumbsOf(roots, "/home/alwi/workspace/acme-main/apps")).toEqual([
      { name: "workspace", path: "/home/alwi/workspace" },
      { name: "acme-main", path: "/home/alwi/workspace/acme-main" },
      { name: "apps", path: "/home/alwi/workspace/acme-main/apps" },
    ]);
  });

  it("is the root alone at the root, and empty outside every root", () => {
    expect(crumbsOf(roots, "/srv")).toEqual([{ name: "srv", path: "/srv" }]);
    expect(crumbsOf(roots, "/home/alwi/workspace-old")).toEqual([]);
  });

  it("shortens a home folder to ~", () => {
    expect(shortPath("/home/alwi/workspace")).toBe("~/workspace");
    expect(shortPath("/srv/app")).toBe("/srv/app");
  });
});

describe("when the folder browser asks for a Cloudflare sign-in before ssh", () => {
  const access = (state: "signed-in" | "needs-login" | "unavailable") => ({ state, hostname: "ssh.example.com" });
  it("asks only for an expired token on a machine with no open SSH", () => {
    expect(needsLogin({ connected: false, access: access("needs-login") })).toBe("ssh.example.com");
    expect(needsLogin({ connected: true, access: access("needs-login") })).toBeNull();
    expect(needsLogin({ connected: false, access: access("signed-in") })).toBeNull();
    expect(needsLogin({ connected: false, access: access("unavailable") })).toBeNull();
    expect(needsLogin({ connected: false })).toBeNull();
    expect(needsLogin(null)).toBeNull();
  });
});
