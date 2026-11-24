import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DefaultAccountStore, UnknownAccountError } from "../default-account.js";
import type { Account } from "../types.js";

let dir: string;
let file: string;
let live: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lotus-da-"));
  file = join(dir, "accounts.json");
  live = ["default", "work"];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = (): DefaultAccountStore =>
  new DefaultAccountStore(file, () => live.map((id): Account => ({ id, source: "ccs", dir: id, configFile: id })));

describe("DefaultAccountStore", () => {
  it("is unset by default, then set, then cleared", () => {
    const s = store();
    expect(s.get()).toBeUndefined();
    s.set("work");
    expect(s.get()).toBe("work");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ default: { claude: "work" } });
    s.set(null);
    expect(s.get()).toBeUndefined();
  });

  it("refuses an unknown id", () => {
    expect(() => store().set("nope")).toThrow(UnknownAccountError);
  });

  it("resolves a stale id to nothing", () => {
    writeFileSync(file, JSON.stringify({ default: { claude: "gone" } }));
    expect(store().get()).toBeUndefined();
  });
});
