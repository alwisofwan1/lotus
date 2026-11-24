import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtraProjects } from "../extra-store.js";

/**
 * The third registry mode (`plans/pocket-vps-project-checkout` ADR-D): a small writable list
 * beside the scan, so a folder outside `PROJECTS_ROOT` can be a project.
 *
 * `PROJECTS_JSON` is deliberately not reused for this — it is a snapshot the operator owns
 * through env, and writing to it from a phone would overwrite a hand-managed file.
 */
describe("ExtraProjects", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "extra-"));
    file = join(dir, "projects.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("remembers a project across a restart", async () => {
    const target = join(dir, "kerja", "tkt-backend");
    mkdirSync(target, { recursive: true });

    await new ExtraProjects(file).add({ id: "tkt-backend", name: "tkt-backend", path: target });

    // A second instance is what a restarted host is.
    expect(new ExtraProjects(file).list()).toEqual([
      { id: "tkt-backend", name: "tkt-backend", path: target },
    ]);
  });

  it("drops an entry whose directory is gone, without forgetting it", async () => {
    const target = join(dir, "removable");
    mkdirSync(target);
    const store = new ExtraProjects(file);
    await store.add({ id: "removable", name: "removable", path: target });

    rmSync(target, { recursive: true });

    // Not listed — a project that cannot be opened is not a project today…
    expect(store.list()).toEqual([]);
    // …but a mounted disk can come back, so the file still holds it.
    expect(readFileSync(file, "utf8")).toContain("removable");
  });

  it("forgets on request, and leaves the directory alone", async () => {
    const target = join(dir, "keepme");
    mkdirSync(target);
    const store = new ExtraProjects(file);
    await store.add({ id: "keepme", name: "keepme", path: target });

    await store.remove("keepme");

    expect(store.list()).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });

  it("treats a file it cannot read as empty rather than refusing to start", async () => {
    writeFileSync(file, "{ not json at all");
    const store = new ExtraProjects(file);

    expect(store.list()).toEqual([]);

    // And a write repairs it, rather than the host being stuck forever.
    const target = join(dir, "after");
    mkdirSync(target);
    await store.add({ id: "after", name: "after", path: target });
    expect(store.list().map((p) => p.id)).toEqual(["after"]);
  });

  it("refuses a second entry for a path it already holds", async () => {
    const target = join(dir, "twice");
    mkdirSync(target);
    const store = new ExtraProjects(file);
    await store.add({ id: "twice", name: "twice", path: target });
    await store.add({ id: "twice-again", name: "twice-again", path: target });

    expect(store.list().map((p) => p.id)).toEqual(["twice"]);
  });
});
