import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadEnv } from "../load-env.js";

const TEST_KEYS = ["FOO_TEST", "BAR_TEST", "PRESET_TEST", "CUSTOM_TEST"];

describe("loadEnv", () => {
  let dir: string;
  let originalCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-loadenv-test-"));
    originalCwd = process.cwd();
    process.chdir(dir);
    for (const key of TEST_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of TEST_KEYS) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads variables from .env into process.env", () => {
    writeFileSync(join(dir, ".env"), "FOO_TEST=hello\nBAR_TEST=world\n");
    delete process.env["FOO_TEST"];
    delete process.env["BAR_TEST"];

    loadEnv();

    expect(process.env["FOO_TEST"]).toBe("hello");
    expect(process.env["BAR_TEST"]).toBe("world");
  });

  it("is a no-op when .env does not exist", () => {
    expect(() => loadEnv()).not.toThrow();
  });

  it("does not overwrite existing process.env values", () => {
    writeFileSync(join(dir, ".env"), "PRESET_TEST=from-file\n");
    process.env["PRESET_TEST"] = "from-shell";

    loadEnv();

    expect(process.env["PRESET_TEST"]).toBe("from-shell");
  });

  it("supports a custom file path", () => {
    writeFileSync(join(dir, ".env.custom"), "CUSTOM_TEST=ok\n");
    delete process.env["CUSTOM_TEST"];

    loadEnv(".env.custom");

    expect(process.env["CUSTOM_TEST"]).toBe("ok");
  });
});
