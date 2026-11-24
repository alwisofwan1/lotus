import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeAccountsIn, codexAccountsIn, identityOf } from "../discovery.js";

let home: string;
let state: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-acc-"));
  state = join(home, "state");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function marked(...parts: string[]): string {
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), "{}");
  return dir;
}
const ids = (list: { id: string }[]): string[] => list.map((a) => a.id);

describe("claudeAccountsIn", () => {
  it("lists only `default` on a home with no ccs", () => {
    const list = claudeAccountsIn(home, state, []);
    expect(ids(list)).toEqual(["default"]);
    expect(list[0]).toMatchObject({ source: "default", dir: join(home, ".claude"), configFile: join(home, ".claude.json") });
    expect(ids(codexAccountsIn(home, []))).toEqual(["default"]);
  });

  it("skips unmarked ccs folders and prefixes clashes", () => {
    for (const n of ["b", "a", "default"]) marked(".ccs", "instances", n);
    mkdirSync(join(home, ".ccs/instances/unmarked"), { recursive: true });
    marked("state", "accounts", "claude", "work");
    marked("state", "accounts", "claude", "a");
    const list = claudeAccountsIn(home, state, []);
    expect(ids(list)).toEqual(["default", "a", "b", "ccs-default", "lotus-a", "work"]);
    expect(list.find((a) => a.id === "ccs-default")?.source).toBe("ccs");
    expect(list.find((a) => a.id === "lotus-a")?.source).toBe("lotus");
  });

  it("lists a lotus folder without the marker", () => {
    mkdirSync(join(state, "accounts/claude/fresh"), { recursive: true });
    expect(ids(claudeAccountsIn(home, state, []))).toEqual(["default", "fresh"]);
  });

  it("shows an env dir inside ccs once, and one elsewhere as env", () => {
    const acme = marked(".ccs", "instances", "acme");
    const withEnv = claudeAccountsIn(home, state, [acme]);
    expect(withEnv.map((a) => [a.id, a.source])).toEqual([["default", "default"], ["acme", "ccs"]]);

    const elsewhere = join(home, "cfg/work");
    mkdirSync(elsewhere, { recursive: true });
    expect(claudeAccountsIn(home, state, [elsewhere]).at(-1)).toMatchObject({ id: "work", source: "env" });

    expect(claudeAccountsIn(home, state, [join(home, "nope")])).toHaveLength(2);
    const clash = join(home, "cfg/acme");
    mkdirSync(clash, { recursive: true });
    expect(ids(claudeAccountsIn(home, state, [clash]))).toEqual(["default", "acme", "env-acme"]);
  });

  it("adds nothing for an env dir that is the default dir", () => {
    mkdirSync(join(home, ".claude"));
    expect(ids(claudeAccountsIn(home, state, [join(home, ".claude")]))).toEqual(["default"]);
  });
});

describe("codexAccountsIn", () => {
  it("lists a CODEX_HOME elsewhere with config.toml", () => {
    const alt = join(home, "codex-alt");
    mkdirSync(alt);
    const list = codexAccountsIn(home, [alt]);
    expect(ids(list)).toEqual(["default", "codex-alt"]);
    expect(list[1]?.configFile).toBe(join(alt, "config.toml"));
  });
});

describe("identityOf", () => {
  it("reads oauthAccount, and is null when not signed in", () => {
    const file = join(home, ".claude.json");
    const account = { id: "a", source: "ccs" as const, dir: home, configFile: file };
    expect(identityOf(account)).toBeNull();
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationName: "Acme" } }));
    expect(identityOf(account)).toEqual({ email: "me@example.com", org: "Acme" });
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
    expect(identityOf(account)).toEqual({ email: "me@example.com", org: null });
    writeFileSync(file, `{"projects":{}}`);
    expect(identityOf(account)).toBeNull();
  });
});
