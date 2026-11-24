//! Embed and materialize the `lotus-remote` bot runtime on disk.
//!
//! The release path uses a Bun-compiled executable embedded with
//! `include_bytes!`, so the `.dmg` does not depend on `node` being
//! installed or visible in Finder's PATH. We still embed the `.mjs`
//! bundle for sanity tests and debugging parity with the source build.
//!
//! Idempotent re-write: if a previous Lotus version wrote a different
//! bundle, we overwrite. If the on-disk content matches what we have
//! embedded, we skip the write to avoid touching mtime needlessly.
//!
//! Mirror of the existing `mcp_config::ensure_lotus_mcp_server_script`
//! pattern — operators familiar with one will read the other.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The bundled host runtime `lotus-remote.mjs`. Built by
/// `apps/desktop/scripts/build-host-bundle.mjs` into `packages/host/dist/`.
///
/// Re-running that script updates this transparently because `include_str!`
/// re-reads the file every Cargo build.
///
/// The path is anchored to `CARGO_MANIFEST_DIR` (= `apps/desktop/src-tauri`)
/// rather than written relative to this source file. That matters because this
/// include crosses a package boundary — `apps/desktop` → `packages/host` — so a
/// file-relative path would encode this module's depth inside the crate, and
/// moving this file would silently break the build. Anchoring to the crate root
/// means only the crate's own position in the repo is load-bearing.
const LOTUS_REMOTE_BUNDLE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/host/dist/lotus-remote.mjs"
));
#[cfg(not(windows))]
const LOTUS_REMOTE_EXECUTABLE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/host/dist/lotus-remote-bin"
));
#[cfg(windows)]
const LOTUS_REMOTE_EXECUTABLE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/host/dist/lotus-remote-bin.exe"
));

/// Default path: `~/.lotus/lotus-remote.mjs`. Kept separate from the
/// resolver so tests can pass a tempdir.
pub fn default_bundle_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("lotus-remote.mjs")
}

/// Default executable path materialized from the embedded bytes.
pub fn default_executable_path() -> PathBuf {
    #[cfg(windows)]
    {
        return crate::paths::lotus_state_dir().join("lotus-remote-bin.exe");
    }

    crate::paths::lotus_state_dir().join("lotus-remote-bin")
}

/// Returns the embedded bundle as a string slice. Exposed for tests so
/// they can verify the writer's behavior against real data.
#[cfg(test)]
fn embedded_bundle() -> &'static str {
    LOTUS_REMOTE_BUNDLE
}

#[cfg(test)]
fn embedded_executable() -> &'static [u8] {
    LOTUS_REMOTE_EXECUTABLE
}

/// Write the embedded bundle to `target` if missing or stale.
///
/// Returns:
/// - `Ok(true)`  → wrote (file was missing or differed).
/// - `Ok(false)` → no-op (existing file matches).
pub fn write_if_needed(target: &Path, contents: &str) -> io::Result<bool> {
    match fs::read_to_string(target) {
        Ok(existing) if existing == contents => return Ok(false),
        _ => {}
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("mjs.tmp");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    fs::rename(tmp, target)?;
    Ok(true)
}

/// Write executable bytes to `target` if missing or stale.
///
/// The mode is intentionally owner-only on Unix because the executable
/// inherits bot credentials through environment variables at runtime.
pub fn write_executable_if_needed(target: &Path, contents: &[u8]) -> io::Result<bool> {
    match fs::read(target) {
        Ok(existing) if existing == contents => {
            ensure_executable_permission(target)?;
            return Ok(false);
        }
        _ => {}
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    ensure_executable_permission(&tmp)?;
    fs::rename(tmp, target)?;
    Ok(true)
}

#[cfg(unix)]
fn ensure_executable_permission(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    fs::set_permissions(path, perms)
}

#[cfg(not(unix))]
fn ensure_executable_permission(_path: &Path) -> io::Result<()> {
    Ok(())
}

/// Convenience: ensure the embedded bot executable is materialized at
/// the default path. Returns the executable path on success.
pub fn ensure_default() -> io::Result<PathBuf> {
    let script_path = default_bundle_path();
    write_if_needed(&script_path, LOTUS_REMOTE_BUNDLE)?;

    let path = default_executable_path();
    write_executable_if_needed(&path, LOTUS_REMOTE_EXECUTABLE)?;
    ensure_launchable(&path);
    Ok(path)
}

/// Last line of defence against the kernel killing the host on exec.
///
/// A Mach-O whose signature no longer matches its contents is SIGKILLed before it
/// runs — exit 137, no output — and that is exactly what `bun build --compile`
/// produced until 2026-10-04. `build.rs` refuses to embed such a binary, so this
/// only fires for a build that slipped past it; re-signing ad hoc here keeps
/// Mobile Access working instead of failing silently. In that case the file then
/// differs from the embedded bytes, so the next start rewrites and re-signs it
/// again: a cost paid only by a broken build, never by a good one.
#[cfg(target_os = "macos")]
fn ensure_launchable(path: &Path) {
    use std::process::Command;
    let verified = |path: &Path| {
        Command::new("codesign")
            .args(["--verify", "--strict"])
            .arg(path)
            .output()
            .map(|out| out.status.success())
    };
    match verified(path) {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "[host-runtime] {} has an invalid code signature; re-signing ad hoc",
                path.display()
            );
            let resigned = Command::new("codesign")
                .arg("--remove-signature")
                .arg(path)
                .status()
                .and_then(|_| {
                    Command::new("codesign")
                        .args(["--force", "--sign", "-"])
                        .arg(path)
                        .status()
                });
            if !matches!(verified(path), Ok(true)) {
                eprintln!(
                    "[host-runtime] re-signing {} failed ({resigned:?}); macOS will kill it on launch",
                    path.display()
                );
            }
        }
        // No codesign (stripped-down system): nothing to check with, and nothing to fix.
        Err(error) => eprintln!("[host-runtime] could not run codesign: {error}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_launchable(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn write_if_needed_creates_file_when_absent() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("lotus-remote.mjs");
        assert!(!target.exists());

        let wrote = write_if_needed(&target, "console.log('hi')").unwrap();
        assert!(wrote);
        assert_eq!(fs::read_to_string(&target).unwrap(), "console.log('hi')");
    }

    #[test]
    fn write_if_needed_overwrites_when_contents_differ() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("lotus-remote.mjs");
        fs::write(&target, "OLD").unwrap();

        let wrote = write_if_needed(&target, "NEW").unwrap();
        assert!(wrote);
        assert_eq!(fs::read_to_string(&target).unwrap(), "NEW");
    }

    #[test]
    fn write_if_needed_skips_when_contents_match() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("lotus-remote.mjs");
        fs::write(&target, "SAME").unwrap();

        let wrote = write_if_needed(&target, "SAME").unwrap();
        assert!(!wrote);
    }

    #[test]
    fn write_if_needed_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nested/dir/lotus-remote.mjs");
        let wrote = write_if_needed(&target, "x").unwrap();
        assert!(wrote);
        assert!(target.exists());
    }

    #[test]
    fn embedded_bundle_is_non_empty_javascript() {
        let body = embedded_bundle();
        // Sanity: the bundle should weigh at least 100 KB once grammy +
        // our adapter are bundled. If this assertion fires, the build
        // step probably didn't run before `cargo build`.
        assert!(
            body.len() > 100_000,
            "bundle suspiciously small ({} bytes) — did `bun run build:bundle` run?",
            body.len(),
        );
    }

    #[test]
    fn embedded_executable_is_non_empty() {
        let body = embedded_executable();
        assert!(
            body.len() > 1_000_000,
            "compiled bot executable suspiciously small ({} bytes) — did `bun run bundle:bot` run?",
            body.len(),
        );
    }

    #[cfg(target_os = "macos")]
    fn codesign_verifies(path: &Path) -> bool {
        std::process::Command::new("codesign")
            .args(["--verify", "--strict"])
            .arg(path)
            .status()
            .unwrap()
            .success()
    }

    /// The failure that shipped on 2026-10-04: an embedded host macOS kills on exec.
    #[cfg(target_os = "macos")]
    #[test]
    fn embedded_executable_has_a_valid_code_signature() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("lotus-remote-bin");
        write_executable_if_needed(&target, embedded_executable()).unwrap();
        assert!(
            codesign_verifies(&target),
            "embedded host executable has an invalid signature — rebuild it with \
             `bun apps/desktop/scripts/build-host-bundle.mjs`",
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ensure_launchable_repairs_a_tampered_signature_so_the_kernel_lets_it_run() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("probe");
        let mut bytes = fs::read("/bin/echo").unwrap();
        // One flipped byte in the code pages breaks the page hash, which is the same
        // mismatch `bun build --compile` produced.
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        write_executable_if_needed(&target, &bytes).unwrap();
        assert!(!codesign_verifies(&target), "fixture should start out broken");

        ensure_launchable(&target);

        assert!(codesign_verifies(&target));
        let status = std::process::Command::new(&target).status().unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_ne!(status.signal(), Some(9), "kernel still kills the re-signed binary");
    }

    #[cfg(unix)]
    #[test]
    fn write_executable_if_needed_sets_owner_execute_permission() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let target = dir.path().join("lotus-remote-bin");
        let wrote = write_executable_if_needed(&target, b"#!/bin/sh\n").unwrap();
        assert!(wrote);

        let mode = fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
