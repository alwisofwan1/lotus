import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { BrowseRoots, OutsideRootsError } from "../browse.js";
import { ExtraProjects } from "../extra-store.js";
import { ProjectRegistry } from "../registry.js";
import { AlreadyAProjectError, ProjectRegistrar } from "../registrar.js";

/**
 * Taking a folder that is already on the machine (ADR-D). Nothing is copied and nothing is
 * created — what changes is this host's claim on a directory that was already there.
 */
describe("ProjectRegistrar", () => {
  let dir: string;
  let scanRoot: string;
  let kerja: string;
  let file: string;
  let registrar: ProjectRegistrar;
  let registry: ProjectRegistry;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "registrar-")));
    scanRoot = join(dir, "workspaces");
    kerja = join(dir, "kerja");
    file = join(dir, "projects.json");
    mkdirSync(scanRoot, { recursive: true });
    mkdirSync(kerja, { recursive: true });
    const extra = new ExtraProjects(file);
    registry = ProjectRegistry.fromConfig({ projectsRoot: scanRoot, extraProjects: file });
    registrar = new ProjectRegistrar({
      extra,
      registry,
      browse: new BrowseRoots([scanRoot, kerja]),
      // Deliberately the UNRESOLVED path, which is what production hands over: on macOS the
      // temp dir arrives through `/tmp`, and a comparison that did not resolve both sides
      // would pass this test only by accident.
      scanRoot: join(tmpdir(), basename(dir), "workspaces"),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("takes a folder outside the scan, and the registry lists it at once", async () => {
    const target = join(kerja, "tkt-backend");
    mkdirSync(target);

    const project = await registrar.add(target);

    expect(project).toMatchObject({ id: "tkt-backend", name: "tkt-backend", path: target });
    expect(registry.list().map((p) => p.id)).toEqual(["tkt-backend"]);
  });

  it("refuses a folder outside every root — the jail is the same one browsing uses", async () => {
    const outside = join(dir, "secrets");
    mkdirSync(outside);

    await expect(registrar.add(outside)).rejects.toThrow(OutsideRootsError);
  });

  it("refuses a folder the scan already found, rather than listing it twice", async () => {
    const scanned = join(scanRoot, "already");
    mkdirSync(scanned);

    await expect(registrar.add(scanned)).rejects.toThrow(AlreadyAProjectError);
  });

  it("refuses the same folder twice", async () => {
    const target = join(kerja, "once");
    mkdirSync(target);
    await registrar.add(target);

    await expect(registrar.add(target)).rejects.toThrow(AlreadyAProjectError);
  });

  it("gives a second folder of the same name an id of its own", async () => {
    // Two machines can each hold a `pocket`; so can two directories on one machine, and
    // `workspaceId` is what a cell is addressed by.
    mkdirSync(join(kerja, "pocket"));
    mkdirSync(join(kerja, "nested", "pocket"), { recursive: true });

    const first = await registrar.add(join(kerja, "pocket"));
    const second = await registrar.add(join(kerja, "nested", "pocket"));

    expect(first.id).toBe("pocket");
    expect(second.id).toBe("pocket-2");
    expect(registry.get("pocket-2")?.path).toBe(join(kerja, "nested", "pocket"));
  });

  it("refuses the workspace root itself, whose children are already projects", () => {
    // Taking it would list the container beside everything the scan finds inside it — the
    // same directory covered twice, under two ids. The mockup draws this as a dead button;
    // the host refuses it, because a UI is not a boundary.
    return expect(registrar.add(scanRoot)).rejects.toThrow(AlreadyAProjectError);
  });

  it("still takes a browse root that is not the workspace root", async () => {
    // `~/kerja` is just a folder. Nothing scans it, so nothing is covered twice.
    const project = await registrar.add(kerja);

    expect(project.path).toBe(kerja);
  });

  it("forgets a project without touching the directory", async () => {
    const target = join(kerja, "keepme");
    mkdirSync(target);
    await registrar.add(target);

    await registrar.remove("keepme");

    expect(registry.list()).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});
