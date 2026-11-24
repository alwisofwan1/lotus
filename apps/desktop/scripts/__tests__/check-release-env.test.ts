import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkGoogleClientEnv } from "../check-release-env.mjs";

const root = process.cwd();
const script = join(root, "scripts", "check-release-env.mjs");
const ID = "123-abc.apps.googleusercontent.com";

// Next's global types make `ProcessEnv.NODE_ENV` required, so a bare object literal does not fit.
function envOf(vars: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

function runScript(vars: Record<string, string>) {
  const clean = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  return spawnSync(process.execPath, [script], { env: envOf({ ...clean, ...vars }), encoding: "utf8" });
}

describe("checkGoogleClientEnv", () => {
  it("accepts a Desktop client id and a secret", () => {
    expect(checkGoogleClientEnv(envOf({ LOTUS_GOOGLE_CLIENT_ID: ID, LOTUS_GOOGLE_CLIENT_SECRET: "s" })).ok).toBe(true);
  });

  it("names every missing variable", () => {
    const { ok, problems } = checkGoogleClientEnv(envOf());
    expect(ok).toBe(false);
    expect(problems.join(" ")).toContain("LOTUS_GOOGLE_CLIENT_ID");
    expect(problems.join(" ")).toContain("LOTUS_GOOGLE_CLIENT_SECRET");
  });

  it("treats whitespace as unset and rejects an id that is not a Google client id", () => {
    expect(checkGoogleClientEnv(envOf({ LOTUS_GOOGLE_CLIENT_ID: " ", LOTUS_GOOGLE_CLIENT_SECRET: "s" })).ok).toBe(false);
    expect(checkGoogleClientEnv(envOf({ LOTUS_GOOGLE_CLIENT_ID: "oops", LOTUS_GOOGLE_CLIENT_SECRET: "s" })).ok).toBe(false);
  });
});

describe("check-release-env.mjs", () => {
  it("fails the build without the client", () => {
    const r = runScript({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("release build refused");
  });

  it("passes with the client, and with the explicit opt-out", () => {
    expect(runScript({ LOTUS_GOOGLE_CLIENT_ID: ID, LOTUS_GOOGLE_CLIENT_SECRET: "s" }).status).toBe(0);
    const optOut = runScript({ LOTUS_ALLOW_NO_GOOGLE: "1" });
    expect(optOut.status).toBe(0);
    expect(optOut.stderr).toContain("WITHOUT the Google client");
  });

  it("runs first in every release build path", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["tauri:build:exec"].startsWith("bun scripts/check-release-env.mjs && ")).toBe(true);
    const mac = readFileSync(join(root, "scripts", "tauri-build-macos.mjs"), "utf8");
    expect(mac.indexOf("check-release-env.mjs")).toBeLessThan(mac.indexOf('"mcp:bundle"'));
  });
});
