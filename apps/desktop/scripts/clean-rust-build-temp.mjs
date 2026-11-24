#!/usr/bin/env node
// Reap orphaned rustc metadata staging directories from the Cargo target dir.
//
// When rustc emits crate metadata it writes `full.rmeta` into a randomly named
// staging directory (`target/<profile>/deps/rmetaXXXXXX/`) and then renames the
// result into place. If the compile is killed before that rename — Ctrl-C on
// `tauri dev`, an HMR restart, a crashed build — the staging directory is
// orphaned. Nothing references it and nothing ever removes it: `cargo build`
// does not, and Cargo has no garbage collector.
//
// This is not a theoretical leak. On 2026-08-02 this repo had 41 such
// directories holding 9.7 GB — roughly 255 MB each, because `lotus_lib` is a
// large crate — accumulated over about two months of ordinary development.
// `cargo clean` would have removed them, but only by also discarding 11 GB of
// cache that is genuinely useful.
//
// Runs as a pre-step of `tauri:dev` and `tauri:build:exec`, i.e. exactly at the
// moments that create the orphans in the first place.
//
// Safety: only directories older than MAX_AGE_MINUTES are removed, so a staging
// directory belonging to a build running *right now* (in another terminal, or a
// concurrent cargo invocation) is never touched. Best-effort by design — it
// never fails the run, and it is a silent no-op when there is nothing to reap.
//
// Stale-but-valid artifacts (Cargo keeps every past hash variant forever — this
// repo had 94 copies of `tauri_plugin_shell`) ARE swept here too, bounded by age.
// That used to be opt-in only, and the opt-in default of 30 days did not catch the
// real growth: measured 2026-08-27, `target/` reached 70 GB, ~40 GB of it codegen
// objects of `lotus_lib` across 13 hash variants younger than 30 days, plus 18 GB
// of `incremental/` sessions. `tauri dev`, `cargo test` and rust-analyzer each hash
// the crate differently, so the churn is weekly, not monthly. The pre-`tauri:dev`
// run now sweeps `deps/` files and `incremental/` sessions untouched for
// LOTUS_RUST_AUTO_SWEEP_DAYS (default 14; 0 disables). `bun run clean:stale`
// still runs the same sweep at LOTUS_RUST_STALE_DAYS (default 14) on demand, and
// `cargo clean` remains the nuke option. Cargo rebuilds whatever it still needs.

import { readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// SCRIPT_DIR = apps/desktop/scripts → the Cargo target dir lives in src-tauri.
const TARGET_DIR =
  process.env.CARGO_TARGET_DIR ?? join(SCRIPT_DIR, "..", "src-tauri", "target");

const MAX_AGE_MINUTES = Number(process.env.LOTUS_RUST_TEMP_MAX_AGE_MIN) || 60;
const PROFILES = ["debug", "release"];

function humanBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

// Bytes actually held on disk, not the nominal file size: rustc's object files are
// sparse enough that `size` over-reported a 51 GB sweep as 109 GB.
const onDisk = (st) => (st.blocks ? st.blocks * 512 : st.size);

async function dirSize(path) {
  let total = 0;
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      total += entry.isDirectory() ? await dirSize(child) : onDisk(await stat(child));
    }
  } catch {
    // Unreadable entry — ignore; the size figure is cosmetic.
  }
  return total;
}

async function reapProfile(profile) {
  const depsDir = join(TARGET_DIR, profile, "deps");
  let entries;
  try {
    entries = await readdir(depsDir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0, skipped: 0 }; // profile never built
  }

  const cutoff = Date.now() - MAX_AGE_MINUTES * 60_000;
  let removed = 0;
  let bytes = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("rmeta")) continue;
    const path = join(depsDir, entry.name);
    try {
      const { mtimeMs } = await stat(path);
      if (mtimeMs > cutoff) {
        skipped++; // young enough that a live build may own it
        continue;
      }
      bytes += await dirSize(path);
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Vanished or locked — leave it for next time.
    }
  }

  return { removed, bytes, skipped };
}

// Old-but-valid cached artifacts: `deps/` files, and whole `incremental/` sessions.
async function sweepStale(profile, days) {
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  let bytes = 0;

  const depsDir = join(TARGET_DIR, profile, "deps");
  for (const entry of await listOrEmpty(depsDir)) {
    if (!entry.isFile()) continue; // staging dirs are handled by reapProfile
    const path = join(depsDir, entry.name);
    try {
      const st = await stat(path);
      if (st.mtimeMs > cutoff) continue;
      await rm(path, { force: true });
      removed++;
      bytes += onDisk(st);
    } catch {
      // Locked or vanished — skip.
    }
  }

  // One directory per crate×profile×hash; a session's mtime is its last compile. Any
  // session that has not been compiled into for `days` belongs to a hash Cargo no
  // longer produces — 21 of 37 here — and Cargo starts a fresh one if it ever does.
  const incDir = join(TARGET_DIR, profile, "incremental");
  for (const entry of await listOrEmpty(incDir)) {
    if (!entry.isDirectory()) continue;
    const path = join(incDir, entry.name);
    try {
      const st = await stat(path);
      if (st.mtimeMs > cutoff) continue;
      const size = await dirSize(path);
      await rm(path, { recursive: true, force: true });
      removed++;
      bytes += size;
    } catch {
      // Locked or vanished — skip.
    }
  }

  return { removed, bytes };
}

async function listOrEmpty(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// `--stale` only ENABLES the sweep; the threshold comes from
// LOTUS_RUST_STALE_DAYS. The threshold is deliberately not a flag: this script is
// reached through two layers of pass-through npm scripts (root → apps/desktop →
// node), and `bun run clean:stale -- --stale=7` arrives as
// `--stale --stale=7`, where naive flag parsing picks the bare `--stale` and
// silently falls back to the default. That bug swept 3.56 GB during testing.
// An env var survives any nesting depth unchanged.
const staleEnabled = process.argv.some((a) => a === "--stale" || a.startsWith("--stale="));
const STALE_DAYS =
  Number(process.env.LOTUS_RUST_STALE_DAYS) ||
  Number(process.argv.find((a) => a.startsWith("--stale="))?.split("=")[1]) ||
  14;
// The bounded sweep every `tauri:dev` runs. `0` opts out for a session that must keep
// every artifact (bisecting a build, say); the default keeps two weeks of variants.
const AUTO_SWEEP_DAYS =
  process.env.LOTUS_RUST_AUTO_SWEEP_DAYS === undefined
    ? 14
    : Number(process.env.LOTUS_RUST_AUTO_SWEEP_DAYS) || 0;

const results = await Promise.all(PROFILES.map(reapProfile));
const removed = results.reduce((n, r) => n + r.removed, 0);
const bytes = results.reduce((n, r) => n + r.bytes, 0);
const skipped = results.reduce((n, r) => n + r.skipped, 0);

if (removed > 0) {
  console.log(
    `[rust-temp] reaped ${removed} orphaned rustc staging dir(s), freed ${humanBytes(bytes)}`,
  );
}
if (skipped > 0) {
  console.log(
    `[rust-temp] left ${skipped} staging dir(s) younger than ${MAX_AGE_MINUTES}m alone (possible live build)`,
  );
}

const sweepDays = staleEnabled ? STALE_DAYS : AUTO_SWEEP_DAYS;
if (sweepDays > 0) {
  const swept = await Promise.all(PROFILES.map((p) => sweepStale(p, sweepDays)));
  const n = swept.reduce((a, r) => a + r.removed, 0);
  const freed = humanBytes(swept.reduce((a, r) => a + r.bytes, 0));
  // Silent when there is nothing to do on the automatic path, like the reaper above;
  // the explicit `clean:stale` always answers.
  if (n > 0) {
    console.log(
      `[rust-temp] swept ${n} artifact(s) untouched for ${sweepDays}+ days, freed ${freed} (Cargo will rebuild what it still needs)`,
    );
  } else if (staleEnabled) {
    console.log(`[rust-temp] no cached artifact older than ${sweepDays} days`);
  }
}
