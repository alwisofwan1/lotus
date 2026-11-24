import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../config.js";

/**
 * A standalone host on a VPS mints its own API key (`server/index.ts`), so the
 * discovery file these tests remove is desktop-only furniture. Demanding it there
 * is not a stricter check — it is a boot crash telling a machine with no desktop
 * to go start the desktop app.
 */
describe("loadConfig api key requirement", () => {
  let home: string;
  let priorHome: string | undefined;
  let priorKey: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lotus-config-"));
    priorHome = process.env["HOME"];
    priorKey = process.env["LOTUS_API_KEY"];
    process.env["HOME"] = home;
    delete process.env["LOTUS_API_KEY"];
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = priorHome;
    if (priorKey === undefined) delete process.env["LOTUS_API_KEY"];
    else process.env["LOTUS_API_KEY"] = priorKey;
    rmSync(home, { recursive: true, force: true });
  });

  it("throws when a client-mode host has no key to talk to the desktop with", () => {
    expect(() => loadConfig()).toThrow(/API key not found/);
  });

  it("returns an empty key instead of throwing when the caller does not need one", () => {
    const config = loadConfig({ requireApiKey: false });
    expect(config.apiKey).toBe("");
    expect(config.mobileBind).toEqual({ host: "127.0.0.1", port: 8787 });
  });
});
