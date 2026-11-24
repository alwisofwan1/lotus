//! Shared context (PLAN step 8, issues/06): a Lotus-made account sees `~/.claude`'s config and
//! context through links, so a chat, memory or skill is the same on every account. An account made
//! Isolated keeps its own and is never linked.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Linked only once `~/.claude` has them: a dangling link would be replaced on the CLI's first write.
pub(crate) const FILES: [&str; 2] = ["settings.json", "CLAUDE.md"];
pub(crate) const DIRS: [&str; 8] = ["skills", "agents", "commands", "projects", "file-history", "todos", "shell-snapshots", "session-env"];
const ISOLATED_MARK: &str = ".lotus-isolated";

pub fn is_isolated(dir: &Path) -> bool {
    dir.join(ISOLATED_MARK).exists()
}

pub fn mark_isolated(dir: &Path) -> io::Result<()> {
    fs::write(dir.join(ISOLATED_MARK), "")
}

/// Every Shared Lotus account linked again where a write broke a link. A failure costs only that
/// account's shared context, so it is logged and the rest go on.
pub fn keep_all() {
    let shared = crate::paths::home_dir().join(".claude");
    for account in crate::accounts::claude_accounts().into_iter().filter(|a| a.source == crate::accounts::Source::Lotus) {
        if let Err(e) = keep(&shared, &account.dir) {
            eprintln!("[accounts] could not link {} to {}: {e}", account.dir.display(), shared.display());
        }
    }
}

/// Links each entry of `dir` to `shared/<entry>`; what stands in a link's place is merged into
/// `shared` first (newer wins, the other kept as `<entry>.lotus-recovered`), so nothing is lost.
pub fn keep(shared: &Path, dir: &Path) -> io::Result<()> {
    if is_isolated(dir) {
        return Ok(());
    }
    for name in DIRS {
        let target = shared.join(name);
        fs::create_dir_all(&target)?;
        place(&dir.join(name), &target, true)?;
    }
    for name in FILES {
        let (path, target) = (dir.join(name), shared.join(name));
        if !target.exists() && fs::symlink_metadata(&path).is_err() {
            continue;
        }
        place(&path, &target, false)?;
    }
    Ok(())
}

fn place(path: &Path, target: &Path, is_dir: bool) -> io::Result<()> {
    // shortcut: Windows files are copies synced newer-wins each tick (a file symlink needs developer
    // mode there); a real link once Lotus can tell it may make one.
    if cfg!(windows) && !is_dir {
        return sync_copy(path, target);
    }
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
        // Ours, or one the operator made: either way not ours to move.
        Ok(meta) if meta.file_type().is_symlink() => return Ok(()),
        Ok(meta) if meta.is_dir() => {
            merge_dir(path, target)?;
            fs::remove_dir(path)?;
        }
        Ok(_) => merge_file(path, target)?,
    }
    link(target, path, is_dir)
}

fn recovered(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".lotus-recovered");
    target.with_file_name(name)
}

fn newer(a: &Path, b: &Path) -> bool {
    let modified = |p: &Path| fs::symlink_metadata(p).and_then(|m| m.modified()).ok();
    modified(a) > modified(b)
}

/// Moves `path` to `target`; when both exist the newer one ends up at `target`.
pub(crate) fn merge_file(path: &Path, target: &Path) -> io::Result<()> {
    if fs::symlink_metadata(target).is_err() {
        return fs::rename(path, target);
    }
    if newer(path, target) {
        fs::rename(target, recovered(target))?;
        fs::rename(path, target)
    } else {
        fs::rename(path, recovered(target))
    }
}

/// Moves everything under `from` into `to`, file by file; leaves `from` empty.
pub(crate) fn merge_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let real_dir = entry.file_type()?.is_dir();
        match fs::symlink_metadata(&dst) {
            Ok(meta) if real_dir && meta.is_dir() => {
                merge_dir(&src, &dst)?;
                fs::remove_dir(&src)?;
            }
            // A dir against a file, or the other way: keep both, the newcomer under a recovered name.
            Ok(meta) if real_dir || meta.is_dir() => fs::rename(&src, recovered(&dst))?,
            _ => merge_file(&src, &dst)?,
        }
    }
    Ok(())
}

fn sync_copy(path: &Path, target: &Path) -> io::Result<()> {
    match (path.exists(), target.exists()) {
        (false, true) => fs::copy(target, path).map(drop),
        (true, false) => fs::copy(path, target).map(drop),
        (true, true) if newer(path, target) => fs::copy(path, target).map(drop),
        (true, true) if newer(target, path) => fs::copy(target, path).map(drop),
        _ => Ok(()),
    }
}

#[cfg(unix)]
pub(crate) fn link(target: &Path, path: &Path, _is_dir: bool) -> io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

/// A directory junction: unlike a symlink it needs neither admin nor developer mode.
#[cfg(windows)]
pub(crate) fn link(target: &Path, path: &Path, _is_dir: bool) -> io::Result<()> {
    let out = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(path).arg(target).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(String::from_utf8_lossy(&out.stderr).into_owned()))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let shared = home.path().join(".claude");
        let dir = home.path().join("state/accounts/claude/work");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&dir).unwrap();
        (home, shared, dir)
    }

    fn age(path: &Path, secs: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn links_every_entry_to_the_shared_dir() {
        let (_home, shared, dir) = setup();
        fs::write(shared.join("settings.json"), "{}").unwrap();
        keep(&shared, &dir).unwrap();
        for name in DIRS {
            assert_eq!(fs::read_link(dir.join(name)).unwrap(), shared.join(name), "{name}");
        }
        assert_eq!(fs::read_link(dir.join("settings.json")).unwrap(), shared.join("settings.json"));
        // Nothing to share yet: no dangling link for the CLI to replace.
        assert!(fs::symlink_metadata(dir.join("CLAUDE.md")).is_err());
        // A second pass changes nothing.
        keep(&shared, &dir).unwrap();
        assert_eq!(fs::read_link(dir.join("projects")).unwrap(), shared.join("projects"));
    }

    #[test]
    fn an_isolated_account_is_never_linked() {
        let (_home, shared, dir) = setup();
        mark_isolated(&dir).unwrap();
        keep(&shared, &dir).unwrap();
        assert!(fs::symlink_metadata(dir.join("projects")).is_err());
    }

    #[test]
    fn a_file_written_over_its_link_is_merged_newer_wins_and_relinked() {
        let (_home, shared, dir) = setup();
        fs::write(shared.join("settings.json"), "old").unwrap();
        age(&shared.join("settings.json"), 60);
        fs::write(dir.join("settings.json"), "new").unwrap();
        keep(&shared, &dir).unwrap();
        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), "new");
        assert_eq!(fs::read_to_string(shared.join("settings.json.lotus-recovered")).unwrap(), "old");
        assert!(fs::symlink_metadata(dir.join("settings.json")).unwrap().file_type().is_symlink());

        // The other way round: an older stray copy is kept aside, the shared one stays.
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::write(dir.join("settings.json"), "stale").unwrap();
        age(&dir.join("settings.json"), 600);
        keep(&shared, &dir).unwrap();
        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), "new");
        assert_eq!(fs::read_to_string(shared.join("settings.json.lotus-recovered")).unwrap(), "stale");
    }

    #[test]
    fn a_real_dir_is_moved_into_the_shared_one_and_relinked() {
        let (_home, shared, dir) = setup();
        fs::create_dir_all(shared.join("projects/p/memory")).unwrap();
        fs::write(shared.join("projects/p/a.jsonl"), "shared").unwrap();
        fs::create_dir_all(dir.join("projects/p/memory")).unwrap();
        fs::write(dir.join("projects/p/b.jsonl"), "mine").unwrap();
        fs::write(dir.join("projects/p/memory/MEMORY.md"), "notes").unwrap();
        keep(&shared, &dir).unwrap();
        assert_eq!(fs::read_to_string(shared.join("projects/p/a.jsonl")).unwrap(), "shared");
        assert_eq!(fs::read_to_string(shared.join("projects/p/b.jsonl")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(shared.join("projects/p/memory/MEMORY.md")).unwrap(), "notes");
        assert_eq!(fs::read_link(dir.join("projects")).unwrap(), shared.join("projects"));
    }

    #[test]
    fn a_link_pointing_elsewhere_is_left_alone() {
        let (home, shared, dir) = setup();
        let mine = home.path().join("elsewhere");
        fs::create_dir_all(&mine).unwrap();
        std::os::unix::fs::symlink(&mine, dir.join("skills")).unwrap();
        keep(&shared, &dir).unwrap();
        assert_eq!(fs::read_link(dir.join("skills")).unwrap(), mine);
    }
}
