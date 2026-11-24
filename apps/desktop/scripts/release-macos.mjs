#!/usr/bin/env node
// Lotus macOS release (plans/app-updates, Phase 2).
//
//   bun scripts/release-macos.mjs 0.2.0              build + sign + write latest.json
//   bun scripts/release-macos.mjs 0.2.0 --publish    ... then upload to the public feed repo
//   bun scripts/release-macos.mjs 0.2.0 --publish --no-windows   ... without the Windows CI build
//     (~50 billed Actions minutes each: Windows counts 2x). Windows users then see an update
//     error until a release that includes Windows; redo it later via Actions → release windows.
//
// Notes come from apps/web/src/releases/<version>.md (scripts/release-notes.mjs drafts it). The
// same file is the website changelog entry, so --publish wants it committed and on origin/main.
//
// Signing key: ~/.lotus-dev/updater/lotus-updater.key, password in the Keychain item `lotus-updater-key`.
// Losing either means installed copies can never be updated again: keep a backup.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isNewer, notesPath, readNotes } from "./release-notes.mjs";
import { buildHostRelease } from "./build-host-release.mjs";

const REPO = "alwisofwan1/lotus-releases";
const projectDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const confPath = join(projectDir, "src-tauri", "tauri.conf.json");
const keyPath = process.env.LOTUS_UPDATER_KEY ?? join(homedir(), ".lotus-dev", "updater", "lotus-updater.key");

const args = process.argv.slice(2);
const version = args[0];
const publish = args.includes("--publish");
const windows = !args.includes("--no-windows");

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) fail("usage: release-macos.mjs <x.y.z> [--publish] [--no-windows]");
let release;
try {
  release = readNotes(version);
} catch (e) {
  fail(e.message);
}
if (publish) {
  // The site redeploys from this push; a release whose changelog entry never ships is the bug this prevents.
  run("git", ["fetch", "-q", "origin", "main"]);
  const rel = notesPath(version);
  if (capture("git", ["-C", projectDir, "status", "--porcelain", "--", rel]).trim() || !capture("git", ["-C", projectDir, "log", "-1", "--format=%h", "origin/main", "--", rel]).trim())
    fail(`commit and push ${rel} to main before publishing`);
}
// The app splits this at the first blank line: title, then the markdown it shows under "What's new".
const notes = `${release.title}\n\n${release.body}`;
const body = `${release.body}\n\nhttps://lotus-web.pages.dev/changelog/#v${version}`;
const confText = readFileSync(confPath, "utf8");
const conf = JSON.parse(confText);
// Equal is allowed so a failed build can be re-run; publishing an existing tag fails at gh anyway.
if (version !== conf.version && !isNewer(version, conf.version)) fail(`${version} must be newer than the current ${conf.version}, or installed apps never see it`);
if (!existsSync(keyPath)) fail(`signing key not found: ${keyPath}`);

const password = capture("security", ["find-generic-password", "-s", "lotus-updater-key", "-w"]).trim();
if (!password) fail("Keychain item lotus-updater-key not found");

// Text replace, not JSON.stringify: keeps the file's hand formatting.
writeFileSync(confPath, confText.replace(/"version": "[^"]*"/, `"version": "${version}"`));
conf.version = version;
console.log(`[release] tauri.conf.json → ${version}`);

// check-release-env refuses a release without Google OAuth; fill it from the client JSON it names.
const google = join(homedir(), ".lotus-dev", "google-oauth-client.json");
const googleEnv = !process.env.LOTUS_GOOGLE_CLIENT_ID && existsSync(google) ? JSON.parse(readFileSync(google, "utf8")).installed ?? {} : {};

// Before the app: a release without a matching host would offer every SSH machine an update it cannot get.
let hostFiles;
try {
  hostFiles = buildHostRelease(version);
} catch (e) {
  fail(e.message);
}

run("bun", ["run", "tauri:build:mac"], {
  ...process.env,
  ...(googleEnv.client_id ? { LOTUS_GOOGLE_CLIENT_ID: googleEnv.client_id, LOTUS_GOOGLE_CLIENT_SECRET: googleEnv.client_secret } : {}),
  // An ad-hoc release makes every user re-enter their login password for the Keychain after updating.
  LOTUS_REQUIRE_SIGNING: "1",
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
});

const bundle = join(projectDir, "src-tauri", "target", "release", "bundle");
const tarball = join(bundle, "macos", `${conf.productName}.app.tar.gz`);
const dmg = join(bundle, "dmg", `${conf.productName}_${version}_aarch64.dmg`);
for (const f of [tarball, `${tarball}.sig`, dmg]) if (!existsSync(f)) fail(`expected artifact missing: ${f}`);
// Stable name so the website can link releases/latest/download/Lotus-macos-arm64.dmg.
const webDmg = join(bundle, "dmg", "Lotus-macos-arm64.dmg");
copyFileSync(dmg, webDmg);

const tag = `v${version}`;
const feed = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": {
      signature: readFileSync(`${tarball}.sig`, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${conf.productName}.app.tar.gz`,
    },
  },
};
const feedPath = join(bundle, "latest.json");
writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`);
console.log(`[release] wrote ${feedPath}`);

if (!publish) {
  console.log(`[release] built ${tag}, not published. To publish these artifacts:`);
  console.log(`  gh release create ${tag} --repo ${REPO} --title "Lotus ${version}" --notes ${JSON.stringify(body)} ${tarball} ${tarball}.sig ${feedPath} ${webDmg} ${hostFiles.join(" ")}`);
  process.exit(0);
}
run("gh", ["release", "create", tag, "--repo", REPO, "--title", `Lotus ${version}`, "--notes", body, tarball, `${tarball}.sig`, feedPath, webDmg, ...hostFiles]);
console.log(`[release] published ${tag} → https://github.com/${REPO}/releases/tag/${tag}`);
if (!windows) {
  console.log(`[release] Windows skipped. To build it later: gh workflow run release-windows.yml --repo alwisofwan1/lotus --ref main -f version=${version}`);
  process.exit(0);
}
// Windows builds on a GitHub runner from origin/main (.github/workflows/release-windows.yml): push first.
run("gh", ["workflow", "run", "release-windows.yml", "--repo", "alwisofwan1/lotus", "--ref", "main", "-f", `version=${version}`]);
console.log("[release] Windows build dispatched → https://github.com/alwisofwan1/lotus/actions/workflows/release-windows.yml");

function run(command, argv, env = process.env) {
  console.log(`[release] ${command} ${argv.slice(0, 3).join(" ")}…`);
  const r = spawnSync(command, argv, { cwd: projectDir, env, stdio: "inherit" });
  if (r.error || r.status !== 0) fail(`${command} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

function capture(command, argv) {
  const r = spawnSync(command, argv, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : "";
}

function fail(message) {
  console.error(`[release] ERROR: ${message}`);
  process.exit(1);
}
