import { describe, expect, it } from "vitest";

import { spawnConfigDir, UnknownSpawnAccountError } from "../spawn-account.js";
import type { Account } from "../types.js";

const ACCOUNTS: Account[] = [
  { id: "default", source: "default", dir: "/h/.claude", configFile: "/h/.claude.json" },
  { id: "hss", source: "lotus", dir: "/h/.lotus/accounts/claude/hss", configFile: "/h/.lotus/accounts/claude/hss/.claude.json" },
];

describe("spawnConfigDir", () => {
  it("sets a named account's dir, over the host's choice", () => {
    expect(spawnConfigDir("hss", ACCOUNTS, "default")).toBe("/h/.lotus/accounts/claude/hss");
  });

  it("unsets for default, never points at ~/.claude", () => {
    expect(spawnConfigDir("default", ACCOUNTS, "hss")).toBeNull();
  });

  it("falls back to the host's choice, and leaves the env alone with none", () => {
    expect(spawnConfigDir(undefined, ACCOUNTS, "hss")).toBe("/h/.lotus/accounts/claude/hss");
    expect(spawnConfigDir(undefined, ACCOUNTS, undefined)).toBeUndefined();
  });

  it("refuses an unknown account by name", () => {
    expect(() => spawnConfigDir("work", ACCOUNTS, undefined)).toThrow(UnknownSpawnAccountError);
    expect(() => spawnConfigDir("work", ACCOUNTS, undefined)).toThrow(/default, hss/);
  });
});
