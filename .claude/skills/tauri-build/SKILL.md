---
name: tauri-build
description: Build, bundle, and package this Tauri app for macOS, Windows, or Linux. Use when producing a production build, a .dmg/.app/.exe/.msi bundle, installing the built app locally, setting up the Windows MSVC toolchain (link.exe not found), or installing Linux/WSL system deps.
---

# Building and packaging Lotus (Tauri 2)

The desktop app lives at `apps/desktop/` in this meta-repository. Every command below works from the
repo root via pass-through scripts, or from inside `apps/desktop/` directly.

## Commands

```bash
# One-time on a fresh clone: install deps for every package (desktop + host)
bun run install:all

# Production Tauri bundle (macOS / Linux — same as tauri:build:exec)
bun run tauri:build

# Windows — use this from PowerShell/cmd (including Cursor). Loads MSVC + Windows SDK via
# apps/desktop/scripts/tauri-build-windows.ps1 (vcvars64.bat), then tauri:build:exec.
# Avoids link.exe not found.
bun run tauri:build:win

# Windows dev — `tauri:dev` with the same MSVC setup, plus tauri.dev.windows.conf.json (opaque
# window, no POSIX `PORT=3001 npm run dev`). Run from a clone on the Windows filesystem, not WSL.
bun run tauri:dev:win

# Inner build step only (rimraf + CI=true tauri build) — usually invoked by tauri:build / tauri:build:win
bun run tauri:build:exec

# macOS convenience: build + rsync Lotus.app to /Applications/
bun run tauri:build:mac

# Linux / WSL — one-time system deps (pkg-config, WebKitGTK, etc.; fixes gio-sys build errors)
bun run setup:linux
```

## Release env: Google OAuth client (required)

Every release path (`tauri:build`, `tauri:build:exec`, `tauri:build:mac`, `tauri:build:win`) first
runs `apps/desktop/scripts/check-release-env.mjs`, which **refuses the build** unless both are set:

```bash
export LOTUS_GOOGLE_CLIENT_ID=$(jq -r .installed.client_id ~/.lotus-dev/google-oauth-client.json)
export LOTUS_GOOGLE_CLIENT_SECRET=$(jq -r .installed.client_secret ~/.lotus-dev/google-oauth-client.json)
```

Why: `src-tauri/src/automation_google.rs` bakes the client in with `option_env!`. Without it the
release app falls back to `~/.lotus/google-oauth-client.json` — a file no user has — so Connectors →
Google says "Not available in this build" for **everyone**. That shipped on 2026-09-29 because
nothing failed. The Desktop client secret is not confidential by Google's own rules (ADR 0044), but
it is still never committed; in CI it comes from a secret.

- Building without Google on purpose (a contributor with no client): `LOTUS_ALLOW_NO_GOOGLE=1`.
  The build then prints a loud warning instead of failing.
- Changing the env recompiles the crate by itself — rustc records `option_env!` reads in dep-info.
- Proof on a built binary (0 = no client baked in; `tauri:verify:mac` runs the same check):
  `grep -c -a apps.googleusercontent.com apps/desktop/src-tauri/target/release/bundle/macos/Lotus.app/Contents/MacOS/lotus`
- Dev (`tauri:dev`) is not guarded: it reads `~/.lotus-dev/google-oauth-client.json` at runtime.

## Toolchain notes

- **Native Windows** — install Visual Studio Build Tools: "Desktop development with C++" +
  Windows 10/11 SDK + WebView2. VS Code is **not** sufficient for `link.exe`.
  <https://v2.tauri.app/start/prerequisites/>
- `tauri:build` → `bun run tauri:build:exec` (`rimraf out .next/cache && CI=true tauri build`). On
  **Windows**, prefer `bun run tauri:build:win`, which runs
  `apps/desktop/scripts/tauri-build-windows.ps1`: finds VS/Build Tools with `vswhere`, runs
  `vcvars64.bat` inside one `cmd.exe` session so `link.exe` and Windows SDK libs (e.g.
  `kernel32.lib`) are visible to Rust/Cargo when `bun` spawns `tauri build`. The VS lookup is
  shared with `tauri-dev-windows.ps1` through `scripts/windows-msvc.ps1`.
- **Windows dev:** plain `bun run tauri:dev` fails or misleads on Windows: no `link.exe`; the dev
  config's `beforeDevCommand` (`PORT=3001 npm run dev`) is POSIX that cmd.exe cannot run; and the
  dev config's macOS window list (`transparent: true`) replaces `tauri.windows.conf.json`, so the
  window opens invisible. `bun run tauri:dev:win` fixes all three by merging
  `src-tauri/tauri.dev.windows.conf.json` last. Use a clone on the Windows filesystem: a WSL
  clone has Linux `node_modules`. A copy without `.git` also breaks dev: Tailwind v4 only honours
  `.gitignore` inside a git repo, so it scans `src-tauri/target/` (GBs) and Turbopack's first
  compile hangs (measured: 91 s per CSS pass without `.git`, 16 s with it). The first page compile
  of a fresh `.next` takes about 3 minutes on Windows.
- Build output: `apps/desktop/src-tauri/target/release/bundle/` (`.app`/`.dmg` on macOS,
  `.exe`/`.msi` on Windows).
- Both `tauri:dev` and `tauri:build:exec` first run `apps/desktop/scripts/build-host-bundle.mjs`,
  which builds `packages/host` into `packages/host/dist/`. Rust embeds those artifacts with
  `include_str!`/`include_bytes!`, so a build fails early and clearly if that step is skipped.

### Target-dir hygiene

`tauri:dev` and `tauri:build:exec` run `clean:rust-temp` first, reaping orphaned rustc staging
directories (`target/<profile>/deps/rmeta*/`) left behind when a compile is killed mid-run. Cargo
never removes those itself; they reached 9.7 GB here in two months. Only directories older than
60 minutes are touched, so a concurrent build is safe.

Stale-but-valid cached artifacts are a separate, opt-in sweep — they are a real cache, so dropping
them costs rebuild time:

```bash
bun run clean:stale                          # untouched for 30+ days
LOTUS_RUST_STALE_DAYS=7 bun run clean:stale  # threshold is an env var, not a flag
```

### If Cargo fails with a path that no longer exists

A `target/` directory produced before the 2026-08-02 meta-repo restructure caches absolute paths, so
Cargo reports `failed to read plugin permissions: … /src-tauri/target/…: No such file or directory`
with the *pre-move* path. Clear it once:

```bash
rm -rf apps/desktop/src-tauri/target/debug/build/{tauri,lotus}-*
```

See the root `CLAUDE.md` "Build Pipeline" section for how the Next.js static export feeds this.
