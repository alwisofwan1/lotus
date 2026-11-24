import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeConfigDir, claudeProfiles, DEFAULT_PROFILE_ID } from "../profiles.js";

let home: string;

/** A config dir the CLI has initialised, which is what `.claude.json` means. */
function initialised(...segments: string[]): string {
  const dir = join(home, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), "{}");
  return dir;
}

/** A directory that exists but was never used — created by a tool, never logged into. */
function untouched(...segments: string[]): string {
  const dir = join(home, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-profiles-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("claudeProfiles", () => {
  it("offers the standard login even before the user has signed in", () => {
    expect(claudeProfiles({ home })).toEqual([
      { id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_ID, configDir: join(home, ".claude") },
    ]);
  });

  it("names the CLI's own directory `default`", () => {
    const dir = initialised(".claude");
    expect(claudeProfiles({ home })).toEqual([
      { id: DEFAULT_PROFILE_ID, label: DEFAULT_PROFILE_ID, configDir: dir },
    ]);
  });

  it("lists ccs accounts after the default, by name", () => {
    initialised(".claude");
    initialised(".ccs", "instances", "work");
    initialised(".ccs", "instances", "initech");
    // Sorted rather than most-recently-used: a picker whose order moves between two openings
    // is one the operator re-reads every time.
    expect(claudeProfiles({ home }).map((p) => p.id)).toEqual(["default", "initech", "work"]);
  });

  it("skips a directory the CLI has never initialised", () => {
    initialised(".claude");
    untouched(".ccs", "instances", "never-used");
    // Offering it would send a cell to a config dir with no credentials, which does not fail
    // — it reads as an expired session.
    expect(claudeProfiles({ home }).map((p) => p.id)).toEqual(["default"]);
  });

  it("keeps a ccs account called `default` apart from the CLI's own, as `ccs-default`", () => {
    const own = initialised(".claude");
    const ccs = initialised(".ccs", "instances", "default");
    const found = claudeProfiles({ home });
    expect(found.map((p) => [p.id, p.configDir])).toEqual([["default", own], ["ccs-default", ccs]]);
  });

  it("lists Lotus-made accounts, even before they sign in, and env dirs", () => {
    untouched("state", "accounts", "claude", "fresh");
    const envDir = untouched("cfg", "alt");
    expect(claudeProfiles({ home, stateDir: join(home, "state"), envDirs: [envDir] }).map((p) => p.id))
      .toEqual(["default", "alt", "fresh"]);
  });

  it("answers with only the default when there is no ccs at all", () => {
    initialised(".claude");
    expect(claudeProfiles({ home }).map((p) => p.id)).toEqual([
      "default",
    ]);
  });
});

describe("claudeConfigDir", () => {
  it("resolves a name this machine has", () => {
    const dir = initialised(".ccs", "instances", "initech");
    expect(claudeConfigDir("initech", { home })).toBe(dir);
  });

  it("answers undefined for a name it does not, so a caller must decide", () => {
    initialised(".claude");
    expect(claudeConfigDir("acme", { home })).toBeUndefined();
  });
});
