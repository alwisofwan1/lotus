import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CcsMigration } from "../ccs-migration.js";

let home: string;
let claude: string;
let chosen: string | undefined;
const migration = (): CcsMigration =>
  new CcsMigration({ home, stateDir: join(home, "state"), today: () => "2026-11-13", hasDefault: () => chosen !== undefined, setDefault: (id) => { chosen = id; } });

/** ccs's layout in miniature: instance → shared → context group, and shared → `~/.claude`. */
beforeEach(() => {
  chosen = undefined;
  home = mkdtempSync(join(tmpdir(), "lotus-ccs-"));
  claude = join(home, ".claude");
  const ccs = join(home, ".ccs");
  const group = join(ccs, "shared/context-groups/default");
  const inst = join(ccs, "instances/work");
  for (const d of [join(claude, "projects/p/memory"), join(claude, "plugins"), join(group, "projects/p/memory"), join(group, "continuity/todos"), join(inst, "jobs")]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(claude, "settings.json"), "{}");
  writeFileSync(join(claude, "projects/p/memory/MEMORY.md"), "- [A](a.md)\n- [C](c.md)");
  writeFileSync(join(group, "projects/p/memory/MEMORY.md"), "- [A](a.md)\n- [B](b.md)\n");
  writeFileSync(join(group, "projects/p/a.jsonl"), "theirs");
  writeFileSync(join(group, "continuity/todos/t.json"), "[]");
  writeFileSync(join(inst, "jobs/big.log"), "not ours");
  symlinkSync(join(claude, "settings.json"), join(ccs, "shared/settings.json"));
  symlinkSync(join(claude, "plugins"), join(ccs, "shared/plugins"));
  symlinkSync(join(ccs, "shared/settings.json"), join(inst, "settings.json"));
  symlinkSync(join(ccs, "shared/plugins"), join(inst, "plugins"));
  symlinkSync(join(group, "projects"), join(inst, "projects"));
  symlinkSync(join(group, "continuity/todos"), join(inst, "todos"));
  symlinkSync(join(ccs, "shared/nowhere"), join(inst, "odd"));
  writeFileSync(join(inst, ".claude.json"), JSON.stringify({ mcpServers: { "ccs-websearch": {}, mine: {} }, userID: "u" }));
  writeFileSync(join(ccs, "config.yaml"), 'version: 8\ndefault: "work"\n');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("CcsMigration", () => {
  it("answers null on a host without ccs", () => {
    rmSync(join(home, ".ccs"), { recursive: true });
    expect(migration().plan()).toBeNull();
  });

  it("plans merges, re-points and the default without writing anything", () => {
    const plan = migration().plan()!;
    expect(plan.merges.find((m) => m.to === join(claude, "projects"))?.collisions).toBe(1);
    const to = (n: string) => plan.relinks.find((r) => r.link === join(home, ".ccs/instances/work", n))?.to;
    expect(to("projects")).toBe(join(claude, "projects"));
    expect(to("plugins")).toBe(realpathSync(join(claude, "plugins")));
    expect(to("odd")).toBeNull();
    expect(plan.defaultAccount).toBe("work");
    expect(plan.mcpEntries).toEqual([{ file: join(home, ".ccs/instances/work/.claude.json"), name: "ccs-websearch" }]);
    expect(existsSync(join(home, "state"))).toBe(false);
  });

  it("backs up, merges, unions memory indexes, re-points and adopts the default; a rerun is a no-op", () => {
    migration().run();
    const inst = join(home, ".ccs/instances/work");
    const listed = execFileSync("tar", ["-tzf", join(home, "state/backups/ccs-2026-11-13.tar.gz")], { encoding: "utf8" }).split("\n");
    expect(listed).toContain(".ccs/config.yaml");
    expect(listed).toContain(".ccs/instances/work/projects");
    expect(listed.some((l) => l.includes("jobs"))).toBe(false);

    expect(readFileSync(join(claude, "projects/p/a.jsonl"), "utf8")).toBe("theirs");
    const index = readFileSync(join(claude, "projects/p/memory/MEMORY.md"), "utf8").split("\n");
    for (const entry of ["- [A](a.md)", "- [B](b.md)", "- [C](c.md)"]) expect(index.filter((l) => l === entry)).toHaveLength(1);
    expect(existsSync(join(claude, "projects/p/memory/MEMORY.md.lotus-recovered"))).toBe(false);
    expect(readFileSync(join(claude, "todos/t.json"), "utf8")).toBe("[]");
    expect(readlinkSync(join(inst, "projects"))).toBe(join(claude, "projects"));
    expect(readlinkSync(join(inst, "settings.json"))).toBe(join(claude, "settings.json"));
    expect(readlinkSync(join(inst, "plugins"))).toBe(realpathSync(join(claude, "plugins")));
    expect(readlinkSync(join(inst, "odd"))).toBe(join(home, ".ccs/shared/nowhere"));
    expect(chosen).toBe("work");

    const again = migration().run();
    expect(again.relinks.every((r) => r.to === null)).toBe(true);
    expect(again.defaultAccount).toBeNull();
    expect(existsSync(join(home, "state/backups/ccs-2026-11-13-2.tar.gz"))).toBe(true);
  });

  it("removes only ccs MCP servers, on request", () => {
    const file = join(home, ".ccs/instances/work/.claude.json");
    expect(migration().removeMcp()).toEqual([{ file, name: "ccs-websearch" }]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcpServers: { mine: {} }, userID: "u" });
    expect(readFileSync(`${file}.before-ccs-mcp-removal`, "utf8")).toContain("ccs-websearch");
  });

  it("keeps a chosen host default, and ignores a ccs default that is no instance", () => {
    chosen = "other";
    expect(migration().plan()!.defaultAccount).toBeNull();
    chosen = undefined;
    writeFileSync(join(home, ".ccs/config.yaml"), "default: gone\n");
    expect(migration().plan()!.defaultAccount).toBeNull();
  });
});
