//! One-shot migrations for filesystem layout changes between Lotus versions.
//!
//! Currently: relocate Lotus-owned state from `~/.claude/` (where it shipped
//! historically, sharing space with the Claude CLI) to `~/.lotus/` (Lotus's
//! own home). Files owned by the Claude CLI itself — `settings.json`,
//! `projects/`, `skills/`, `~/.claude.json` — are never touched.
//!
//! Properties:
//!   * **Release-only.** The dev profile always starts from a clean
//!     `~/.lotus-dev/` sandbox, so no migration is needed there.
//!   * **Idempotent.** If the destination already exists, the source is left
//!     in place and skipped — running this every startup is safe.
//!   * **Best-effort.** A failure on any single item is logged via `eprintln!`
//!     and migration continues with the remaining items so a single perms
//!     issue cannot block app startup.

use std::fs;
use std::path::Path;

use crate::paths;

/// Items relocated from `~/.claude/<name>` to `~/.lotus/<name>`. Names match
/// the on-disk layout produced by `paths::*` and `mcp_config::*` before this
/// migration shipped.
const MIGRATION_ITEMS: &[&str] = &[
    "teams",
    "tasks",
    "lotus-tasks",
    "agent-teams-logs",
    "agent-teams-procs.json",
    "lotus-mcp-ipc.json",
];

/// Move legacy Lotus state from `~/.claude/` to `~/.lotus/`. No-op for dev
/// builds and for fresh installs. Returns the count of items moved.
pub fn migrate_claude_to_lotus_release() -> usize {
    if paths::is_dev_profile() {
        return 0;
    }
    let claude = paths::claude_dir();
    let lotus = paths::lotus_state_dir();
    if !claude.exists() {
        return 0;
    }
    migrate_in(&claude, &lotus, MIGRATION_ITEMS)
}

fn migrate_in(src_root: &Path, dst_root: &Path, items: &[&str]) -> usize {
    if let Err(err) = fs::create_dir_all(dst_root) {
        eprintln!(
            "[lotus-migrate] could not create {}: {err}",
            dst_root.display()
        );
        return 0;
    }
    let mut moved = 0;
    for item in items {
        let src = src_root.join(item);
        let dst = dst_root.join(item);
        if !src.exists() || dst.exists() {
            continue;
        }
        match fs::rename(&src, &dst) {
            Ok(_) => {
                eprintln!("[lotus-migrate] {} -> {}", src.display(), dst.display());
                moved += 1;
            }
            Err(rename_err) => {
                // `rename` fails across filesystems (e.g. ~/.claude on a
                // different mount). Fall back to copy + remove.
                match copy_then_remove(&src, &dst) {
                    Ok(_) => {
                        eprintln!(
                            "[lotus-migrate] {} -> {} (cross-device copy)",
                            src.display(),
                            dst.display()
                        );
                        moved += 1;
                    }
                    Err(copy_err) => {
                        eprintln!(
                            "[lotus-migrate] {} -> {} failed: rename={rename_err}, copy={copy_err}",
                            src.display(),
                            dst.display()
                        );
                    }
                }
            }
        }
    }
    moved
}

fn copy_then_remove(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        copy_dir_recursive(src, dst)?;
        fs::remove_dir_all(src)
    } else {
        fs::copy(src, dst)?;
        fs::remove_file(src)
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_in_moves_files_and_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("legacy");
        let dst = tmp.path().join("new");
        fs::create_dir_all(src.join("teams")).unwrap();
        fs::write(src.join("teams").join("a.json"), b"{}").unwrap();
        fs::write(src.join("agent-teams-procs.json"), b"[]").unwrap();

        let moved = migrate_in(&src, &dst, &["teams", "agent-teams-procs.json"]);

        assert_eq!(moved, 2);
        assert!(!src.join("teams").exists());
        assert!(!src.join("agent-teams-procs.json").exists());
        assert!(dst.join("teams").join("a.json").exists());
        assert!(dst.join("agent-teams-procs.json").exists());
    }

    #[test]
    fn migrate_in_is_idempotent_when_dst_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("legacy");
        let dst = tmp.path().join("new");
        fs::create_dir_all(src.join("teams")).unwrap();
        fs::write(src.join("teams").join("legacy.json"), b"{}").unwrap();
        fs::create_dir_all(dst.join("teams")).unwrap();
        fs::write(dst.join("teams").join("existing.json"), b"{}").unwrap();

        let moved = migrate_in(&src, &dst, &["teams"]);

        // Destination exists → source stays put, nothing moved.
        assert_eq!(moved, 0);
        assert!(src.join("teams").join("legacy.json").exists());
        assert!(dst.join("teams").join("existing.json").exists());
    }

    #[test]
    fn migrate_in_skips_missing_source_items() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("legacy");
        let dst = tmp.path().join("new");
        fs::create_dir_all(&src).unwrap();
        let moved = migrate_in(&src, &dst, &["never-existed"]);
        assert_eq!(moved, 0);
        assert!(!dst.join("never-existed").exists());
    }
}
