import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveClaudeConfigDir, trustProjectFolder } from "../claude-trust.js";

let home: string;
let configDir: string;
let project: string;
/**
 * The key the CLI would use — the project path **through symlinks**.
 *
 * A fixture keyed by the unresolved path is a fixture the CLI never wrote: `mkdtempSync`
 * hands back `/var/folders/…` on macOS and the CLI records `/private/var/folders/…`. Getting
 * this wrong in the first draft of this file is exactly the bug the resolution exists to stop.
 */
let key: string;

function writeConfig(body: unknown): void {
  writeFileSync(join(configDir, ".claude.json"), JSON.stringify(body, null, 2));
}

function readConfig(): { projects?: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(configDir, ".claude.json"), "utf8")) as {
    projects?: Record<string, Record<string, unknown>>;
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-trust-"));
  configDir = join(home, ".claude");
  project = join(home, "work", "repo");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  key = realpathSync(project);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("trustProjectFolder", () => {
  it("grants trust for a folder the CLI has recorded but not trusted", () => {
    // The exact state a fresh project lands in: `--print` creates the entry and runs anyway
    // (the CLI skips the dialog when not interactive), leaving a TUI cell to hit the gate.
    writeConfig({ projects: { [key]: { hasTrustDialogAccepted: false, allowedTools: [] } } });

    expect(trustProjectFolder({ configDir, cwd: project })).toBe("granted");
    expect(readConfig().projects?.[key]?.["hasTrustDialogAccepted"]).toBe(true);
    // Everything else in the entry is the CLI's own bookkeeping and must survive.
    expect(readConfig().projects?.[key]?.["allowedTools"]).toEqual([]);
  });

  it("creates the entry when the CLI has never seen this folder", () => {
    writeConfig({ projects: {}, hasCompletedOnboarding: true });

    expect(trustProjectFolder({ configDir, cwd: project })).toBe("granted");
    expect(readConfig().projects?.[key]?.["hasTrustDialogAccepted"]).toBe(true);
    // Untouched top-level state: this file is the CLI's whole config, not ours.
    expect(readConfig()["hasCompletedOnboarding" as keyof ReturnType<typeof readConfig>]).toBe(true);
  });

  it("writes nothing at all when trust is already granted", () => {
    writeConfig({ projects: { [key]: { hasTrustDialogAccepted: true } } });
    const before = readFileSync(join(configDir, ".claude.json"), "utf8");

    expect(trustProjectFolder({ configDir, cwd: project })).toBe("already-trusted");
    // Byte-identical: the CLI rewrites this file constantly, and a read-modify-write we did
    // not need is a race we did not need either.
    expect(readFileSync(join(configDir, ".claude.json"), "utf8")).toBe(before);
  });

  it("does nothing when the profile has no config yet", () => {
    // Building the CLI's whole config from scratch is not ours to do — it will create one and
    // ask once. Answering "no-config" lets the caller say so instead of pretending.
    expect(trustProjectFolder({ configDir: join(home, "never-used"), cwd: project })).toBe("no-config");
  });

  it("reports a failure rather than throwing, so a cell still starts", () => {
    writeFileSync(join(configDir, ".claude.json"), "{ this is not json");
    expect(trustProjectFolder({ configDir, cwd: project })).toBe("failed");
  });

  it("keys the folder the way the CLI does, through symlinks", () => {
    // macOS: `/tmp` is a symlink to `/private/tmp`, and the CLI records the resolved path —
    // seen in a real capture. Keying on the unresolved one would write an entry the CLI
    // never reads, and the dialog would still appear.
    writeConfig({ projects: {} });
    trustProjectFolder({ configDir, cwd: project });
    // The entry lands under the resolved path, which is the one the CLI reads.
    expect(Object.keys(readConfig().projects ?? {})).toEqual([key]);
  });
});

describe("resolveClaudeConfigDir", () => {
  it("prefers an explicit CLAUDE_CONFIG_DIR, which is what a ccs profile sets", () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/a/profile" }, "/home/op")).toBe("/a/profile");
  });

  it("falls back to the CLI's own directory", () => {
    expect(resolveClaudeConfigDir({}, "/home/op")).toBe("/home/op/.claude");
  });

  it("treats an empty value as unset, because a blank config dir is not a profile", () => {
    // The same guard `shell_env.rs` needs: a shell that exports the variable empty would
    // otherwise hand every spawn a blank directory.
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: "   " }, "/home/op")).toBe("/home/op/.claude");
  });
});
