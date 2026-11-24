#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tauriConfigPath = join(projectDir, "src-tauri", "tauri.conf.json");
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
const productName = tauriConfig.productName ?? "Lotus";
const version = tauriConfig.version ?? "0.1.0";
const arch = archForDmg();
const appPath = join(projectDir, "src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
const dmgDir = join(projectDir, "src-tauri", "target", "release", "bundle", "dmg");
const dmgPath = join(dmgDir, `${productName}_${version}_${arch}.dmg`);

if (process.platform !== "darwin") {
  fail("tauri-build-macos.mjs must be run on macOS.");
}

run("bun", ["scripts/check-release-env.mjs"]);
cleanupStaleNextLock();
// An ad-hoc signature is a fresh cdhash every build, and macOS Keychain + TCC trust that hash, so
// every update re-asked for the login password and for folder access. A stable identity keeps
// "Always Allow" across updates. See plans/production-grade-audit/SIGNING.md.
const signingIdentity = resolveSigningIdentity();

run("bun", ["run", "mcp:bundle"]);
run("bun", ["run", "chat-bridge:bundle"]);
run("bun", ["scripts/build-host-bundle.mjs"]);
run("bun", ["scripts/build-sessiond.mjs", "--release"]);
// sessiond is copied in via bundle.macOS.files and is its own process to Keychain and TCC: sign it first.
if (signingIdentity) {
  run("codesign", ["--force", "--sign", signingIdentity, "--identifier", "com.lotus.desktop.sessiond", join(projectDir, "src-tauri", "target", "release", "lotus-sessiond")]);
}
run("rimraf", ["out", ".next/cache"]);
// Updater artifacts (Lotus.app.tar.gz + .sig) need the signing key; plain local builds skip them.
const updaterArgs = process.env.TAURI_SIGNING_PRIVATE_KEY ? ["--config", JSON.stringify({ bundle: { createUpdaterArtifacts: true } })] : [];
run("bun", ["run", "tauri", "build", "--bundles", "app", ...updaterArgs], {
  env: { ...process.env, CI: "true", ...(signingIdentity ? { APPLE_SIGNING_IDENTITY: signingIdentity } : {}) },
});
if (signingIdentity) verifyStableSignature();

createDmg();
installApp();

console.log(`[mac-build] OK → ${appPath}`);
console.log(`[mac-build] OK → ${dmgPath}`);

function run(command, args, options = {}) {
  console.log(`[mac-build] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectDir,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: projectDir, encoding: "utf8" });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
}

function cleanupStaleNextLock() {
  const lockPath = join(projectDir, ".next", "lock");
  if (!existsSync(lockPath)) return;

  const ps = output("ps", ["-axo", "pid=,command="]);
  const activeNextBuild = ps
    .split("\n")
    .some((line) => line.includes(projectDir) && /\bnext\s+build\b/.test(line));

  if (activeNextBuild) {
    fail("A Next.js production build is already running for this repository. Wait for it to finish, then rerun bun run tauri:build:mac.");
  }

  console.log("[mac-build] removing stale .next/lock from an interrupted build");
  rmSync(lockPath, { force: true });
}

function createDmg() {
  if (!existsSync(appPath)) fail(`Expected app bundle not found: ${appPath}`);
  mkdirSync(dmgDir, { recursive: true });
  cleanupDmgArtifacts();

  const stageDir = mkdtempSync(join(tmpdir(), "lotus-dmg-stage-"));
  try {
    run("ditto", [appPath, join(stageDir, `${productName}.app`)]);
    symlinkSync("/Applications", join(stageDir, "Applications"));
    run("hdiutil", [
      "create",
      "-volname",
      productName,
      "-srcfolder",
      stageDir,
      "-ov",
      "-format",
      "UDZO",
      "-size",
      estimateDmgSize(stageDir),
      dmgPath,
    ]);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

function estimateDmgSize(stageDir) {
  const blocks = Number(output("du", ["-sk", stageDir]).trim().split(/\s+/, 1)[0]);
  const megabytes = Number.isFinite(blocks) ? Math.ceil(blocks / 1024) : 128;
  return `${Math.max(256, Math.ceil(megabytes * 1.7) + 64)}m`;
}

function cleanupDmgArtifacts() {
  rmSync(dmgPath, { force: true });
  if (!existsSync(dmgDir)) return;
  for (const name of readdirSync(dmgDir)) {
    if (name.startsWith("rw.") && name.endsWith(".dmg")) rmSync(join(dmgDir, name), { force: true });
  }
}

function installApp() {
  run("rsync", ["-a", "--delete", `${appPath}/`, `/Applications/${productName}.app/`]);
}

// LOTUS_MAC_SIGNING_IDENTITY overrides the name (e.g. a "Developer ID Application: …" later).
// LOTUS_REQUIRE_SIGNING=1 (set by release-macos.mjs) refuses to ship an ad-hoc build.
function resolveSigningIdentity() {
  const name = process.env.LOTUS_MAC_SIGNING_IDENTITY || "Lotus Self-Signed";
  if (output("security", ["find-identity", "-p", "codesigning"]).includes(`"${name}"`)) {
    console.log(`[mac-build] signing with "${name}"`);
    return name;
  }
  const hint = `code-signing identity "${name}" not in the keychain; see plans/production-grade-audit/SIGNING.md`;
  if (process.env.LOTUS_REQUIRE_SIGNING === "1") fail(hint);
  console.warn(`[mac-build] WARN: ${hint}. Building ad-hoc: Keychain and folder prompts return after every update.`);
  return null;
}

function verifyStableSignature() {
  for (const bin of ["lotus", "lotus-sessiond"]) {
    const info = spawnSync("codesign", ["-dv", join(appPath, "Contents", "MacOS", bin)], { encoding: "utf8" }).stderr;
    if (/Signature=adhoc/.test(info)) fail(`${bin} is still ad-hoc signed after the build`);
  }
}

function archForDmg() {
  const machine = output("uname", ["-m"]).trim();
  if (machine === "arm64") return "aarch64";
  if (machine === "x86_64") return "x64";
  return machine || process.arch;
}

function fail(message) {
  console.error(`[mac-build] ERROR: ${message}`);
  process.exit(1);
}
