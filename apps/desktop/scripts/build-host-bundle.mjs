#!/usr/bin/env bun
/**
 * Build the `packages/host` runtime bundle that ships embedded inside the
 * Tauri release binary.
 *
 * Why this script (vs inlining `cd packages/host && bun run build:bundle`
 * in package.json):
 *   - Cross-platform — POSIX shells and Windows cmd handle `cd && ...`
 *     differently. A bun-runnable .mjs is reliable everywhere.
 *   - Self-installs the host package's node_modules on a fresh clone, so a
 *     CI runner that just `git clone`'d does not fail with "grammy
 *     not found".
 *   - Single chokepoint that the Rust `include_str!` depends on; if
 *     the build fails here, the message is clear instead of a cryptic
 *     "file not found" 5 minutes later in cargo.
 *
 * Invoked from `package.json::tauri:build:exec` so every release build
 * (mac / linux / win, all of which funnel through `tauri:build:exec`)
 * picks up the latest host source automatically.
 *
 * This script lives in `apps/desktop/` but writes into `packages/host/dist/` —
 * it is the one build step that crosses a package boundary, and the direction
 * is deliberate: desktop depends on host, never the reverse.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import hostPackage from "../../../packages/host/package.json" with { type: "json" };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// SCRIPT_DIR = apps/desktop/scripts → up three levels to reach the repo root.
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const HOST_DIR = join(REPO_ROOT, "packages", "host");
const BUNDLE_OUT = join(HOST_DIR, "dist", "lotus-remote.mjs");
const EXECUTABLE_NAME = process.platform === "win32"
  ? "lotus-remote-bin.exe"
  : "lotus-remote-bin";
const EXECUTABLE_OUT = join(HOST_DIR, "dist", EXECUTABLE_NAME);

function run(cmd, args, opts = {}) {
  const cmdline = `${cmd} ${args.join(" ")}`;
  console.log(`[bundle-bot] ${cmdline}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (result.status !== 0) {
    console.error(`[bundle-bot] FAILED: ${cmdline} (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
}

function ensureDeps() {
  const nodeModules = join(HOST_DIR, "node_modules");
  const missingPackages = Object.keys(hostPackage.dependencies ?? {})
    .filter((packageName) => {
      const packagePath = join(nodeModules, ...packageName.split("/"));
      return !existsSync(packagePath);
    });

  if (missingPackages.length === 0) return;

  console.log(
    `[bundle-bot] host dependencies missing (${missingPackages.join(", ")}) — running bun install`,
  );
  run("bun", ["install", "--frozen-lockfile"], { cwd: HOST_DIR });
}

function buildBundle() {
  // Direct `bun build` invocation (instead of `bun run build:bundle`) so
  // the script is self-contained — no dependency on a specific named
  // npm script existing in packages/host/package.json.
  run(
    "bun",
    [
      "build",
      "src/index.ts",
      "--target=node",
      "--outfile=dist/lotus-remote.mjs",
      "--format=esm",
      "--minify",
      "--external=node-pty",
    ],
    { cwd: HOST_DIR },
  );
  run(
    "bun",
    [
      "build",
      "src/index.ts",
      "--target=node",
      "--compile",
      `--outfile=dist/${EXECUTABLE_NAME}`,
      "--external=node-pty",
    ],
    { cwd: HOST_DIR },
  );
}

/**
 * Re-sign the compiled executable ad hoc, then prove the signature holds.
 *
 * `bun build --compile` (1.3.13) emits a Mach-O whose linker-applied ad-hoc
 * signature no longer matches its contents: `codesign --verify` reports
 * "code or signature have been modified". macOS 27 enforces that at exec — the
 * kernel SIGKILLs the process before its first instruction, so the host exits
 * 137 with no output at all, and Mobile Access sits at "Not running" with
 * nothing in any log to say why. Found 2026-10-04.
 *
 * The signature is stripped first because re-signing over the broken one is
 * what we would otherwise be trusting. `src-tauri/build.rs` re-checks the same
 * file, so a binary built some other way (`packages/host`'s `build:bundle`)
 * cannot be embedded either.
 */
function signExecutable() {
  if (process.platform !== "darwin") return;
  run("codesign", ["--remove-signature", EXECUTABLE_OUT]);
  run("codesign", ["--force", "--sign", "-", EXECUTABLE_OUT]);
  run("codesign", ["--verify", "--strict", EXECUTABLE_OUT]);
}

function verifyOutput() {
  if (!existsSync(BUNDLE_OUT)) {
    console.error(`[bundle-bot] expected output not found: ${BUNDLE_OUT}`);
    process.exit(1);
  }
  if (!existsSync(EXECUTABLE_OUT)) {
    console.error(`[bundle-bot] expected output not found: ${EXECUTABLE_OUT}`);
    process.exit(1);
  }
}

ensureDeps();
buildBundle();
verifyOutput();
signExecutable();
console.log(`[bundle-bot] OK → ${BUNDLE_OUT}`);
