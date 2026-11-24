#!/usr/bin/env node
// Builds `lotus-sessiond` into target/<profile>/, beside the app binary, where the app starts it
// from (ADR-0067). The bundle picks the release one up through `bundle.macOS.files`.
// macOS only: elsewhere the in-process PTY path is still the default (phase 4).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const release = process.argv.includes("--release");
const result = spawnSync("cargo", ["build", "-p", "lotus-sessiond", "--bin", "lotus-sessiond", ...(release ? ["--release"] : [])], {
  cwd: fileURLToPath(new URL("../src-tauri", import.meta.url)),
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("[build-sessiond] cargo build -p lotus-sessiond failed");
  process.exit(result.status ?? 1);
}
