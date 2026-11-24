import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRegistry } from "../registry.js";
import type { HostedProject } from "../../../types/index.js";

const SAMPLE: HostedProject[] = [
  { id: "api", name: "API Service", path: "/srv/api" },
  { id: "web", name: "Web Frontend", path: "/srv/web" },
];

describe("ProjectRegistry (constructor)", () => {
  it("list() returns empty array when no projects injected", () => {
    expect(new ProjectRegistry([]).list()).toEqual([]);
  });

  it("list() returns injected projects", () => {
    expect(new ProjectRegistry(SAMPLE).list()).toEqual(SAMPLE);
  });

  it("get() returns project by id", () => {
    expect(new ProjectRegistry(SAMPLE).get("api")).toEqual(SAMPLE[0]);
  });

  it("get() returns undefined for unknown id", () => {
    expect(new ProjectRegistry(SAMPLE).get("missing")).toBeUndefined();
  });
});

describe("ProjectRegistry.fromConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lotus-projects-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty registry when neither option is set", () => {
    expect(ProjectRegistry.fromConfig({}).list()).toEqual([]);
  });

  it("loads projects from a JSON file", () => {
    const jsonPath = join(tmpDir, "projects.json");
    writeFileSync(jsonPath, JSON.stringify(SAMPLE));
    const reg = ProjectRegistry.fromConfig({ projectsJson: jsonPath });
    expect(reg.list()).toEqual(SAMPLE);
  });

  it("PROJECTS_JSON takes precedence over PROJECTS_ROOT when both are set", () => {
    const jsonPath = join(tmpDir, "projects.json");
    writeFileSync(jsonPath, JSON.stringify([SAMPLE[0]]));
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    mkdirSync(join(rootDir, "other-project"));
    const reg = ProjectRegistry.fromConfig({
      projectsJson: jsonPath,
      projectsRoot: rootDir,
    });
    expect(reg.list()).toEqual([SAMPLE[0]]);
  });

  it("scans one level of subdirectories from PROJECTS_ROOT", () => {
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    mkdirSync(join(rootDir, "api-service"));
    mkdirSync(join(rootDir, "web-frontend"));
    const ids = ProjectRegistry.fromConfig({ projectsRoot: rootDir })
      .list()
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(["api-service", "web-frontend"]);
  });

  it("path in scanned projects is the absolute directory path", () => {
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    mkdirSync(join(rootDir, "my-project"));
    const [proj] = ProjectRegistry.fromConfig({ projectsRoot: rootDir }).list();
    expect(proj!.path).toBe(join(rootDir, "my-project"));
  });

  it("skips dotfiles when scanning PROJECTS_ROOT", () => {
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    mkdirSync(join(rootDir, "valid-project"));
    mkdirSync(join(rootDir, ".hidden"));
    const ids = ProjectRegistry.fromConfig({ projectsRoot: rootDir }).list().map((p) => p.id);
    expect(ids).toEqual(["valid-project"]);
  });

  it("skips non-directories when scanning PROJECTS_ROOT", () => {
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    mkdirSync(join(rootDir, "real-project"));
    writeFileSync(join(rootDir, "readme.txt"), "not a project");
    const ids = ProjectRegistry.fromConfig({ projectsRoot: rootDir }).list().map((p) => p.id);
    expect(ids).toEqual(["real-project"]);
  });

  it("throws on malformed JSON in PROJECTS_JSON", () => {
    const jsonPath = join(tmpDir, "bad.json");
    writeFileSync(jsonPath, "{ not valid json");
    expect(() => ProjectRegistry.fromConfig({ projectsJson: jsonPath })).toThrow();
  });

  it("re-scans PROJECTS_ROOT live — a repo cloned after construction appears (Slice 6)", () => {
    const rootDir = join(tmpDir, "root");
    mkdirSync(rootDir);
    const reg = ProjectRegistry.fromConfig({ projectsRoot: rootDir });
    expect(reg.list()).toEqual([]);
    mkdirSync(join(rootDir, "freshly-cloned")); // e.g. `git clone` by an agent
    expect(reg.list().map((p) => p.id)).toEqual(["freshly-cloned"]);
    expect(reg.get("freshly-cloned")?.path).toBe(join(rootDir, "freshly-cloned"));
  });

  it("returns empty (not throw) when PROJECTS_ROOT does not exist yet", () => {
    const reg = ProjectRegistry.fromConfig({ projectsRoot: join(tmpDir, "absent") });
    expect(reg.list()).toEqual([]);
  });

  /// ADR-D: a project outside `PROJECTS_ROOT` lives in a small writable list beside the scan.
  describe("the writable list beside the scan", () => {
    it("lists a project the scan can never see, together with the ones it can", () => {
      const rootDir = join(tmpDir, "root");
      const outside = join(tmpDir, "kerja", "tkt-backend");
      mkdirSync(join(rootDir, "scanned"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      const extraFile = join(tmpDir, "extra.json");
      writeFileSync(extraFile, JSON.stringify({
        version: 1,
        projects: [{ id: "tkt-backend", name: "tkt-backend", path: outside }],
      }));

      const reg = ProjectRegistry.fromConfig({ projectsRoot: rootDir, extraProjects: extraFile });

      expect(reg.list().map((p) => p.id).sort()).toEqual(["scanned", "tkt-backend"]);
      expect(reg.get("tkt-backend")?.path).toBe(outside);
    });

    it("does not list a project twice when the list names one the scan already found", () => {
      // The operator can add a folder, then move it under the workspace root later. The scan
      // wins: it is the live source, and a duplicate id would make `workspaceId` ambiguous.
      const rootDir = join(tmpDir, "root");
      const inside = join(rootDir, "both");
      mkdirSync(inside, { recursive: true });
      const extraFile = join(tmpDir, "extra.json");
      writeFileSync(extraFile, JSON.stringify({
        version: 1,
        projects: [{ id: "both-again", name: "both-again", path: inside }],
      }));

      const reg = ProjectRegistry.fromConfig({ projectsRoot: rootDir, extraProjects: extraFile });

      expect(reg.list().map((p) => p.id)).toEqual(["both"]);
    });

    it("is read live, so a project added after the host started needs no restart", () => {
      const rootDir = join(tmpDir, "root");
      mkdirSync(rootDir);
      const extraFile = join(tmpDir, "extra.json");
      const reg = ProjectRegistry.fromConfig({ projectsRoot: rootDir, extraProjects: extraFile });
      expect(reg.list()).toEqual([]);

      const later = join(tmpDir, "later");
      mkdirSync(later);
      writeFileSync(extraFile, JSON.stringify({
        version: 1,
        projects: [{ id: "later", name: "later", path: later }],
      }));

      expect(reg.list().map((p) => p.id)).toEqual(["later"]);
    });
  });
});
