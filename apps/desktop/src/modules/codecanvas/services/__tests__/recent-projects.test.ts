import { describe, expect, it } from "vitest";

import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { buildRecentProjects, projectDisplayName } from "../recent-projects";

function meta(over: Partial<CodeCanvasProjectMeta>): CodeCanvasProjectMeta {
  return { id: "id", rootDir: "/root", alias: null, position: 0, updatedAt: 0, lastOpenedAt: 0, ...over };
}

describe("projectDisplayName", () => {
  it("prefers the alias", () => {
    expect(projectDisplayName(meta({ alias: "My App", rootDir: "/Users/a/work/my-app" }))).toBe("My App");
  });
  it("falls back to the trailing path segment", () => {
    expect(projectDisplayName(meta({ alias: null, rootDir: "/Users/a/work/my-app" }))).toBe("my-app");
  });
  it("ignores a trailing slash", () => {
    expect(projectDisplayName(meta({ alias: null, rootDir: "/Users/a/work/my-app/" }))).toBe("my-app");
  });
});

describe("buildRecentProjects", () => {
  const projects = [
    meta({ id: "a", rootDir: "/Users/a/workspace/experiments/lotus", lastOpenedAt: 30 }),
    meta({ id: "b", rootDir: "/Users/a/workspace/vault", lastOpenedAt: 10 }),
    meta({ id: "c", rootDir: "/Users/a/workspace/clients/web", lastOpenedAt: 20 }),
    meta({ id: "d", rootDir: "/Users/a/tmp/scratch", lastOpenedAt: 5 }),
  ];

  it("sorts by lastOpenedAt descending and caps at the limit", () => {
    const recents = buildRecentProjects(projects, { limit: 3 });
    expect(recents.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("tildifies the parent directory under $HOME", () => {
    const recents = buildRecentProjects(projects, { home: "/Users/a", limit: 1 });
    expect(recents[0]).toMatchObject({ id: "a", name: "lotus", path: "~/workspace/experiments" });
  });

  it("leaves the path raw when no home is provided", () => {
    const recents = buildRecentProjects(projects, { home: null, limit: 1 });
    expect(recents[0].path).toBe("/Users/a/workspace/experiments");
  });

  it("excludes the active project", () => {
    const recents = buildRecentProjects(projects, { excludeId: "a", limit: 3 });
    expect(recents.map((r) => r.id)).toEqual(["c", "b", "d"]);
  });

  it("tolerates a trailing home slash", () => {
    const recents = buildRecentProjects(projects, { home: "/Users/a/", limit: 1 });
    expect(recents[0].path).toBe("~/workspace/experiments");
  });
});
