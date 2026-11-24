import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isIsolated, keepLinks, markIsolated } from "../context-links.js";

let home: string;
let shared: string;
let dir: string;
const DIRS = ["skills", "agents", "commands", "projects", "file-history", "todos", "shell-snapshots", "session-env"];
const age = (p: string, secs: number): void => {
  const t = new Date(Date.now() - secs * 1000);
  utimesSync(p, t, t);
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-links-"));
  shared = join(home, ".claude");
  dir = join(home, "state/accounts/claude/work");
  mkdirSync(shared, { recursive: true });
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("keepLinks", () => {
  it("links every entry to the shared dir, files only once they exist there", () => {
    writeFileSync(join(shared, "settings.json"), "{}");
    keepLinks(shared, dir);
    keepLinks(shared, dir);
    for (const name of DIRS) expect(readlinkSync(join(dir, name))).toBe(join(shared, name));
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(shared, "settings.json"));
    expect(() => lstatSync(join(dir, "CLAUDE.md"))).toThrow();
  });

  it("never links an isolated account", () => {
    markIsolated(dir);
    keepLinks(shared, dir);
    expect(isIsolated(dir)).toBe(true);
    expect(() => lstatSync(join(dir, "projects"))).toThrow();
  });

  it("merges a file written over its link, newer wins, and links it again", () => {
    writeFileSync(join(shared, "settings.json"), "old");
    age(join(shared, "settings.json"), 60);
    writeFileSync(join(dir, "settings.json"), "new");
    keepLinks(shared, dir);
    expect(readFileSync(join(shared, "settings.json"), "utf8")).toBe("new");
    expect(readFileSync(join(shared, "settings.json.lotus-recovered"), "utf8")).toBe("old");
    expect(lstatSync(join(dir, "settings.json")).isSymbolicLink()).toBe(true);
  });

  it("moves a real dir into the shared one and links it", () => {
    mkdirSync(join(shared, "projects/p"), { recursive: true });
    writeFileSync(join(shared, "projects/p/a.jsonl"), "shared");
    mkdirSync(join(dir, "projects/p/memory"), { recursive: true });
    writeFileSync(join(dir, "projects/p/memory/MEMORY.md"), "notes");
    keepLinks(shared, dir);
    expect(readFileSync(join(shared, "projects/p/a.jsonl"), "utf8")).toBe("shared");
    expect(readFileSync(join(shared, "projects/p/memory/MEMORY.md"), "utf8")).toBe("notes");
    expect(readlinkSync(join(dir, "projects"))).toBe(join(shared, "projects"));
  });

  it("leaves a link that points elsewhere", () => {
    mkdirSync(join(home, "elsewhere"));
    symlinkSync(join(home, "elsewhere"), join(dir, "skills"));
    keepLinks(shared, dir);
    expect(readlinkSync(join(dir, "skills"))).toBe(join(home, "elsewhere"));
  });
});
