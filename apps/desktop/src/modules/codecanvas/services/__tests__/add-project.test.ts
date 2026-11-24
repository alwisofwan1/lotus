import { describe, expect, it } from "vitest";
import { addProjectChoices, machineFromQuery } from "../add-project";
import { machineKey } from "../machine";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

const project = (over: Partial<CodeCanvasProjectMeta>): CodeCanvasProjectMeta => ({
  id: "cp_1",
  rootDir: "/repo",
  alias: null,
  position: 0,
  updatedAt: 1,
  lastOpenedAt: 1,
  ...over,
});

describe("the Add-project list", () => {
  it("always opens with the local folder, so the common case is never a machine away", () => {
    const rows = addProjectChoices({ hosts: [], projects: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "local" });
  });

  it("lists machines from ~/.ssh/config", () => {
    const rows = addProjectChoices({
      hosts: [{ alias: "devbox-vps", hostname: "103.1.1.1", user: "root", port: 22 }],
      projects: [],
    });
    expect(rows[1]).toMatchObject({ kind: "machine", label: "devbox-vps", detail: "root@devbox-vps:22" });
  });

  it("still lists a git-only alias, disabled, with the reason", () => {
    const rows = addProjectChoices({
      hosts: [{ alias: "github.com", hostname: "github.com", user: "git", port: null }],
      projects: [],
    });
    const row = rows.find((r) => r.kind === "machine");
    expect(row?.disabledReason).toMatch(/does not provide an interactive shell/);
  });

  it("puts usable machines above the ones that cannot be used", () => {
    const rows = addProjectChoices({
      hosts: [
        { alias: "github.com", hostname: "github.com", user: "git", port: null },
        { alias: "devbox-vps", hostname: "103.1.1.1", user: "root", port: null },
      ],
      projects: [],
    });
    const machines = rows.filter((r) => r.kind === "machine");
    expect(machines[0].label).toBe("devbox-vps");
    expect(machines[1].label).toBe("github.com");
  });

  it("remembers a machine that only a project knows about", () => {
    const rows = addProjectChoices({
      hosts: [],
      projects: [
        project({ rootDir: "/srv/api", location: { kind: "ssh", host: "typed-by-hand", user: "deploy" } }),
      ],
    });
    expect(rows.find((r) => r.kind === "machine")).toMatchObject({ label: "typed-by-hand" });
  });

  it("counts the projects already open on each machine, and leads with the busiest", () => {
    const ssh = (host: string) => ({ kind: "ssh" as const, host, user: "root" });
    const rows = addProjectChoices({
      hosts: [],
      projects: [
        project({ id: "a", rootDir: "/a", location: ssh("busy") }),
        project({ id: "b", rootDir: "/b", location: ssh("busy") }),
        project({ id: "c", rootDir: "/c", location: ssh("quiet") }),
        project({ id: "d", rootDir: "/local" }),
      ],
    });
    const machines = rows.filter((r) => r.kind === "machine");
    expect(machines.map((m) => [m.label, m.projectCount])).toEqual([
      ["busy", 2],
      ["quiet", 1],
    ]);
  });

  it("does not list the same machine twice when config and a project both name it", () => {
    const rows = addProjectChoices({
      hosts: [{ alias: "devbox-vps", hostname: "103.1.1.1", user: "root", port: null }],
      projects: [project({ location: { kind: "ssh", host: "devbox-vps", user: "root" } })],
    });
    expect(rows.filter((r) => r.kind === "machine")).toHaveLength(1);
  });

  it("filters on what has been typed, across both the name and the address", () => {
    const input = {
      hosts: [
        { alias: "devbox-vps", hostname: "103.1.1.1", user: "root", port: null },
        { alias: "staging", hostname: "staging.internal", user: "deploy", port: 2222 },
      ],
      projects: [],
    };
    expect(addProjectChoices({ ...input, query: "stag" }).map((r) => r.label)).toEqual(["staging"]);
    expect(addProjectChoices({ ...input, query: "deploy@" }).map((r) => r.label)).toEqual(["staging"]);
  });
});

describe("a machine typed into the field", () => {
  it("reads user, host and port out of one string", () => {
    expect(machineFromQuery("deploy@staging.internal:2222")).toMatchObject({
      kind: "machine",
      target: { host: "staging.internal", user: "deploy", port: 2222 },
    });
  });

  it("accepts a bare host", () => {
    expect(machineFromQuery("devbox-vps")?.target).toEqual({ host: "devbox-vps" });
  });

  it("is silent about things that are plainly not a machine", () => {
    expect(machineFromQuery("")).toBeNull();
    expect(machineFromQuery("/srv/devbox")).toBeNull();
    expect(machineFromQuery("~/workspace")).toBeNull();
    expect(machineFromQuery("two words")).toBeNull();
    expect(machineFromQuery("bad_host!")).toBeNull();
  });

  it("does not offer a machine the list already shows", () => {
    const rows = addProjectChoices({
      hosts: [{ alias: "devbox-vps", hostname: "x", user: "root", port: null }],
      projects: [],
    });
    expect(machineFromQuery("root@devbox-vps", rows)).toBeNull();
    expect(machineFromQuery("other-host", rows)).not.toBeNull();
  });

  it("keys a machine the way the store does, so counts and rows agree", () => {
    expect(machineKey({ host: "DEVBOX-VPS", user: "Root", port: 22 })).toBe("ssh:root@devbox-vps:22");
    expect(machineKey({ host: "h" })).toBe("ssh:h");
  });
});
