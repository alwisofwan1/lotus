import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverCcsAccounts } from "../ccs-discovery.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ccs-test-"));
}

const SAMPLE_YAML = `
version: 13
default: "work"

accounts:
  work:
    created: "2026-01-01T00:00:00Z"
  hss:
    created: "2026-01-02T00:00:00Z"
  acme:
    created: "2026-01-03T00:00:00Z"
`.trim();

const MINIMAL_YAML = `
accounts:
  only-account:
    created: "2026-01-01T00:00:00Z"
`.trim();

describe("discoverCcsAccounts", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = tmp();
    configPath = join(dir, "config.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns all account names from a valid config", () => {
    writeFileSync(configPath, SAMPLE_YAML);
    const accounts = discoverCcsAccounts(configPath);
    expect(accounts.sort()).toEqual(["acme", "hss", "work"]);
  });

  it("returns a single account from a minimal config", () => {
    writeFileSync(configPath, MINIMAL_YAML);
    expect(discoverCcsAccounts(configPath)).toEqual(["only-account"]);
  });

  it("returns empty array when the config file does not exist", () => {
    expect(discoverCcsAccounts("/nonexistent/path/config.yaml")).toEqual([]);
  });

  it("returns empty array when the accounts section is absent", () => {
    writeFileSync(configPath, "version: 1\ndefault: work\n");
    expect(discoverCcsAccounts(configPath)).toEqual([]);
  });

  it("skips comment lines and blank lines", () => {
    const yaml = `
# CCS config
accounts:
  # comment line
  real-account:
    created: "2026-01-01T00:00:00Z"
`.trim();
    writeFileSync(configPath, yaml);
    expect(discoverCcsAccounts(configPath)).toEqual(["real-account"]);
  });

  it("stops parsing when a top-level key follows the accounts block", () => {
    const yaml = `
accounts:
  alpha:
    x: 1
other_section:
  beta:
    x: 2
`.trim();
    writeFileSync(configPath, yaml);
    expect(discoverCcsAccounts(configPath)).toEqual(["alpha"]);
  });
});
