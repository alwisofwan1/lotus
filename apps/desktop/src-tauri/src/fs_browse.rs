use std::path::{Path, PathBuf};

use crate::models::{DirEntry, ProjectMeta};
use crate::paths;
use crate::time;

/// Claude Code stores each project's transcripts under `~/.claude/projects/<slug>`, where the slug
/// is the cwd with path separators (and dots) replaced by '-'. Mirror that to locate a cwd's sessions.
pub fn claude_project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// Every directory a Claude-family CLI might keep its transcripts in.
///
/// **`~/.claude` is not the only one, and assuming it was is what broke session capture for every
/// profile runner.** `ccs <profile>` (and the custom runners built on it) launch Claude with a
/// different `CLAUDE_CONFIG_DIR`, so their transcripts land under `~/.ccs/instances/<profile>/`
/// instead. Measured 2026-09-07: an agent running `ccs initech` in
/// `~/workspace/experiments/codespace-demo` wrote its session to
/// `~/.ccs/instances/initech/projects/…`, while `~/.claude/projects/…` for that same cwd had not
/// been touched since August. Capture looked only at the latter, found nothing new, and the node
/// therefore came back with no session to resume.
///
/// Profiles frequently symlink `projects` to one shared context group, so the same session id can
/// appear under several roots — callers dedupe by id.
fn claude_project_roots() -> Vec<PathBuf> {
    let mut roots = vec![paths::claude_dir()];
    // The old rule (any ccs instance with transcripts, marker or not) united with the accounts, so
    // a transcript is still found when the CLI never wrote `.claude.json`.
    let mut profiles: Vec<PathBuf> = std::fs::read_dir(paths::home_dir().join(".ccs").join("instances"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .collect();
    profiles.extend(crate::accounts::claude_accounts().into_iter().filter(|a| a.id != crate::accounts::DEFAULT).map(|a| a.dir));
    // Stable order so two runs agree on which root a duplicated id is reported from.
    profiles.sort();
    profiles.dedup();
    roots.extend(profiles.into_iter().filter(|path| path.join("projects").is_dir()));
    roots
}

/// List the Claude Code session ids recorded for a working directory, newest first — the stems of
/// the `<uuid>.jsonl` transcripts under every root's `projects/<slug>/`. Used to capture a live
/// agent's real session id for resume-on-reopen (ADR-0027 Phase 5). Empty when nothing is recorded.
pub fn list_claude_sessions(cwd: String) -> Vec<String> {
    let slug = claude_project_slug(&cwd);
    let mut seen: Vec<String> = Vec::new();
    for root in claude_project_roots() {
        for id in list_claude_sessions_in(&root.join("projects").join(&slug)) {
            if !seen.contains(&id) {
                seen.push(id);
            }
        }
    }
    seen
}

/// The transcript file of session `session_id`, started in `cwd`, in whichever profile wrote it.
/// Looked up by name in that one project folder: the id never becomes a path of its own.
pub fn claude_session_file(cwd: &str, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let slug = claude_project_slug(cwd);
    claude_project_roots()
        .into_iter()
        .map(|root| root.join("projects").join(&slug).join(format!("{session_id}.jsonl")))
        .find(|path| path.is_file())
}

/// Makes session `session_id` resumable by the account whose config dir is `config_dir`: when the
/// newest copy of its transcript is in another account's `projects/`, it is copied here. Accounts
/// that share one `projects/` (ccs) find the same file and copy nothing. True when it copied.
///
/// The newest copy, not the first one found: after default → acme → default, the default's own
/// file is the old one and acme's holds the later turns.
// shortcut: copies only `<id>.jsonl`, not a `<id>/` folder of subagent transcripts; resume reads only the main file.
pub fn ensure_claude_session_in(config_dir: &Path, cwd: &str, session_id: &str) -> std::io::Result<bool> {
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Ok(false);
    }
    let slug = claude_project_slug(cwd);
    let file = format!("{session_id}.jsonl");
    let target = config_dir.join("projects").join(&slug).join(&file);
    let modified = |p: &Path| p.metadata().and_then(|m| m.modified()).ok();
    let mut roots = claude_project_roots();
    roots.push(config_dir.to_path_buf());
    let newest = roots
        .into_iter()
        .map(|root| root.join("projects").join(&slug).join(&file))
        .filter_map(|path| Some((modified(&path)?, path)))
        .max_by_key(|(at, _)| *at);
    let Some((at, source)) = newest else { return Ok(false) };
    let same = |a: &Path, b: &Path| matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y);
    if same(&source, &target) || modified(&target).is_some_and(|t| t >= at) {
        return Ok(false);
    }
    std::fs::create_dir_all(target.parent().expect("projects/<slug>"))?;
    std::fs::copy(&source, &target)?;
    Ok(true)
}

fn list_claude_sessions_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut items: Vec<(String, std::time::SystemTime)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let stem = path.file_stem().and_then(|s| s.to_str())?.to_string();
            let mtime = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((stem, mtime))
        })
        .collect();
    items.sort_by(|a, b| b.1.cmp(&a.1));
    items.into_iter().map(|(id, _)| id).collect()
}

pub fn get_homedir() -> String {
    paths::home_dir().to_string_lossy().to_string()
}

pub fn list_dir_entries(browse_path: String) -> Vec<DirEntry> {
    let base = PathBuf::from(&browse_path);
    if !base.exists() {
        return vec![];
    }
    std::fs::read_dir(&base)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let full = format!("{}/{}", browse_path.trim_end_matches('/'), name);
                    DirEntry {
                        is_git_repo: std::path::Path::new(&full).join(".git").exists(),
                        has_package_json: std::path::Path::new(&full).join("package.json").exists(),
                        name,
                        path: full,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// How much of a transcript's tail is read for a dormant node's preview.
///
/// A conversation's `.jsonl` can reach megabytes, and a card needs one sentence. Reading only the
/// tail bounds the cost so reopening a board with eight dormant agents stays cheap — which is the
/// entire reason dormancy exists.
pub(crate) const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// The last thing the assistant said in a Claude session (Session Widget, Slice 04).
///
/// A dormant node shows the conversation it is holding, and this is where that line comes from: the
/// runner's OWN transcript, `~/.claude/projects/<slug>/<session-id>.jsonl`, which is durable and
/// complete. The alternative — the PTY ring buffer — is 64 KB of volatile ANSI that does not
/// survive the app closing, which is precisely when a dormant card is needed.
///
/// Returns `None` when the transcript is missing (a session recorded by another runner, or one the
/// CLI has since removed) so the caller can say "saved" rather than invent a line.
pub fn read_claude_session_tail(cwd: String, session_id: String, max_chars: usize) -> Option<String> {
    let slug = claude_project_slug(&cwd);
    // The session may belong to a profile runner, whose transcripts live outside ~/.claude entirely
    // — see `claude_project_roots`.
    claude_project_roots().into_iter().find_map(|root| {
        let path = root
            .join("projects")
            .join(&slug)
            .join(format!("{session_id}.jsonl"));
        read_claude_session_tail_at(&path, max_chars)
    })
}

fn read_claude_session_tail_at(path: &Path, max_chars: usize) -> Option<String> {
    let text = read_file_tail(path, TRANSCRIPT_TAIL_BYTES)?;
    assistant_text_from_tail(&text, max_chars)
}

/// The newest assistant prose in a chunk of transcript, whatever machine that chunk came from.
///
/// Split out so the remote reader (`fs_browse_ssh`) parses with **this** function rather than a copy
/// of it: the transcript format is Claude's, not ours, and two parsers would drift the first time it
/// changes — on one machine only, which is the worst way to find out.
///
/// Walks backwards: the newest assistant text wins, and stopping at the first hit means a long
/// transcript costs the same as a short one.
pub(crate) fn assistant_text_from_tail(text: &str, max_chars: usize) -> Option<String> {
    for line in text.lines().rev() {
        if let Some(found) = assistant_text_in_line(line) {
            return Some(truncate_chars(&found, max_chars));
        }
    }
    None
}

/// Read at most `limit` bytes from the end of a file, dropping the first (probably partial) line.
fn read_file_tail(path: &Path, limit: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from_start = len.saturating_sub(limit);
    file.seek(SeekFrom::Start(from_start)).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    // A tail cut mid-UTF-8 would fail to decode; lossy keeps the rest of the transcript usable.
    let text = String::from_utf8_lossy(&buffer).into_owned();
    if from_start == 0 {
        return Some(text);
    }
    // The first line was cut in half by the seek — it cannot be parsed, so drop it.
    Some(text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default())
}

/// Pull assistant prose out of one transcript line, ignoring tool calls and user turns.
fn assistant_text_in_line(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let content = value.get("message")?.get("content")?.as_array()?;
    // Blocks are ordered; the last text block is the closing thought, which is what a card wants.
    for block in content.iter().rev() {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
            let flattened = flatten_whitespace(text);
            if !flattened.is_empty() {
                return Some(flattened);
            }
        }
    }
    None
}

fn flatten_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if max_chars == 0 || text.chars().count() <= max_chars {
        return text.to_string();
    }
    // Count CHARS, not bytes: slicing a multi-byte character in half panics.
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub fn get_claude_session_title(cwd: String) -> Option<String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return None;
    }
    PathBuf::from(trimmed)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
}

pub fn list_projects() -> Vec<ProjectMeta> {
    let projects_dir = paths::claude_dir().join("projects");
    if !projects_dir.exists() {
        return vec![];
    }
    let mut items: Vec<ProjectMeta> = std::fs::read_dir(&projects_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| {
                    let dir_name = e.file_name().to_string_lossy().to_string();
                    let decoded = format!("/{}", dir_name.replace('-', "/"));
                    let last_used = time::file_modified_iso(&e);
                    let name = PathBuf::from(&decoded)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| dir_name.clone());
                    ProjectMeta {
                        id: dir_name,
                        path: decoded,
                        name,
                        last_used,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    items.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `paths::home_dir()` reads `$HOME` first, so a test can stand up a whole fake home.
    /// Serialised because the environment is process-wide.
    fn with_home<T>(home: &Path, body: impl FnOnce() -> T) -> T {
        use std::sync::Mutex;
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let previous = std::env::var_os("HOME");
        // SAFETY: guarded by LOCK, and restored before the guard drops.
        unsafe { std::env::set_var("HOME", home) };
        let out = body();
        match previous {
            Some(value) => unsafe { std::env::set_var("HOME", value) },
            None => unsafe { std::env::remove_var("HOME") },
        }
        out
    }

    fn write_transcript(dir: &Path, name: &str, lines: &[&str]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n")).expect("write transcript");
        path
    }

    const ASSISTANT: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Parser sudah pindah ke tui-source.ts"}]}}"#;
    const ASSISTANT_OLDER: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Baris lama"}]}}"#;
    const USER: &str = r#"{"type":"user","message":{"content":"tolong lanjutkan"}}"#;
    const TOOL_ONLY: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"}]}}"#;

    #[test]
    fn reads_the_last_assistant_line() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_transcript(dir.path(), "s.jsonl", &[ASSISTANT_OLDER, USER, ASSISTANT]);
        assert_eq!(
            read_claude_session_tail_at(&path, 240).as_deref(),
            Some("Parser sudah pindah ke tui-source.ts")
        );
    }

    /// A turn that only called tools has nothing a human would recognise as "the last thing said".
    #[test]
    fn skips_tool_only_turns_and_user_turns() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_transcript(dir.path(), "s.jsonl", &[ASSISTANT_OLDER, TOOL_ONLY, USER]);
        assert_eq!(read_claude_session_tail_at(&path, 240).as_deref(), Some("Baris lama"));
    }

    #[test]
    fn returns_none_when_there_is_no_assistant_prose() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_transcript(dir.path(), "s.jsonl", &[USER, TOOL_ONLY]);
        assert_eq!(read_claude_session_tail_at(&path, 240), None);
    }

    #[test]
    fn returns_none_for_a_missing_transcript() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(read_claude_session_tail_at(&dir.path().join("nope.jsonl"), 240), None);
    }

    #[test]
    fn tolerates_a_corrupt_line() {
        let dir = tempfile::tempdir().expect("dir");
        let path = write_transcript(dir.path(), "s.jsonl", &[ASSISTANT, "{not json"]);
        assert_eq!(
            read_claude_session_tail_at(&path, 240).as_deref(),
            Some("Parser sudah pindah ke tui-source.ts")
        );
    }

    #[test]
    fn flattens_newlines_so_a_card_gets_one_line() {
        let dir = tempfile::tempdir().expect("dir");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"satu\n\ndua   tiga"}]}}"#;
        let path = write_transcript(dir.path(), "s.jsonl", &[line]);
        assert_eq!(read_claude_session_tail_at(&path, 240).as_deref(), Some("satu dua tiga"));
    }

    /// Slicing bytes instead of chars would panic here; the ellipsis proves it truncated.
    #[test]
    fn truncates_on_character_boundaries() {
        let dir = tempfile::tempdir().expect("dir");
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"émoji 🌱 panjang sekali"}]}}"#;
        let path = write_transcript(dir.path(), "s.jsonl", &[line]);
        let tail = read_claude_session_tail_at(&path, 8).expect("tail");
        assert!(tail.ends_with('…'), "expected an ellipsis, got {tail:?}");
        assert_eq!(tail.chars().count(), 8);
    }

    /// Only the tail is read, so a huge transcript costs the same as a small one — and the partial
    /// first line the seek produces must not break parsing.
    #[test]
    fn reads_only_the_tail_of_a_large_transcript() {
        let dir = tempfile::tempdir().expect("dir");
        let mut lines: Vec<String> = Vec::new();
        let filler = format!(
            r#"{{"type":"user","message":{{"content":"{}"}}}}"#,
            "x".repeat(4096)
        );
        for _ in 0..200 {
            lines.push(filler.clone());
        }
        lines.push(ASSISTANT.to_string());
        let path = dir.path().join("big.jsonl");
        std::fs::write(&path, lines.join("\n")).expect("write");
        assert!(std::fs::metadata(&path).unwrap().len() > TRANSCRIPT_TAIL_BYTES);
        assert_eq!(
            read_claude_session_tail_at(&path, 240).as_deref(),
            Some("Parser sudah pindah ke tui-source.ts")
        );
    }

    /// The bug this exists to prevent: capture looked only in `~/.claude`, so an agent running
    /// `ccs <profile>` — whose transcripts live under `~/.ccs/instances/<profile>/` — never had a
    /// session to resume. Measured against a real `ccs initech` run on 2026-09-07.
    #[test]
    fn lists_sessions_from_every_profile_root() {
        let home = tempfile::tempdir().expect("home");
        let cwd = "/Users/someone/work/demo";
        let slug = claude_project_slug(cwd);

        let default_root = home.path().join(".claude").join("projects").join(&slug);
        std::fs::create_dir_all(&default_root).expect("default root");
        std::fs::write(default_root.join("aaaaaaaa-0000-0000-0000-000000000000.jsonl"), "{}")
            .expect("write default");

        let profile_root = home
            .path()
            .join(".ccs")
            .join("instances")
            .join("initech")
            .join("projects")
            .join(&slug);
        std::fs::create_dir_all(&profile_root).expect("profile root");
        std::fs::write(profile_root.join("bbbbbbbb-0000-0000-0000-000000000000.jsonl"), "{}")
            .expect("write profile");

        let ids = with_home(home.path(), || list_claude_sessions(cwd.to_string()));
        assert!(
            ids.contains(&"bbbbbbbb-0000-0000-0000-000000000000".to_string()),
            "a profile runner's session must be visible, got {ids:?}"
        );
        assert!(ids.contains(&"aaaaaaaa-0000-0000-0000-000000000000".to_string()));
    }

    /// Profiles symlink `projects` to one shared context group, so the same id shows up under
    /// several roots. Reporting it twice would make the capture diff pick a "new" id that is not.
    #[test]
    fn a_session_shared_by_two_profiles_is_listed_once() {
        let home = tempfile::tempdir().expect("home");
        let cwd = "/Users/someone/work/demo";
        let slug = claude_project_slug(cwd);
        for profile in ["one", "two"] {
            let dir = home
                .path()
                .join(".ccs")
                .join("instances")
                .join(profile)
                .join("projects")
                .join(&slug);
            std::fs::create_dir_all(&dir).expect("dir");
            std::fs::write(dir.join("cccccccc-0000-0000-0000-000000000000.jsonl"), "{}").expect("write");
        }

        let ids = with_home(home.path(), || list_claude_sessions(cwd.to_string()));
        assert_eq!(ids, vec!["cccccccc-0000-0000-0000-000000000000".to_string()]);
    }

    #[test]
    fn a_session_follows_the_chat_to_another_account_and_back() {
        let home = tempfile::tempdir().expect("home");
        let cwd = "/Users/someone/work/demo";
        let id = "eeeeeeee-0000-0000-0000-000000000000";
        let default = home.path().join(".claude");
        let acme = home.path().join(".ccs/instances/acme");
        let in_dir = |dir: &Path| dir.join("projects").join(claude_project_slug(cwd)).join(format!("{id}.jsonl"));
        std::fs::create_dir_all(in_dir(&default).parent().unwrap()).unwrap();
        std::fs::create_dir_all(acme.join("projects")).unwrap();
        std::fs::write(in_dir(&default), "turn 1\n").unwrap();

        with_home(home.path(), || {
            assert!(ensure_claude_session_in(&acme, cwd, id).unwrap(), "default → acme copies");
            assert_eq!(std::fs::read_to_string(in_dir(&acme)).unwrap(), "turn 1\n");
            assert!(!ensure_claude_session_in(&acme, cwd, id).unwrap(), "already there: nothing to do");

            // acme answers more; back on default, the later turns come along.
            std::thread::sleep(std::time::Duration::from_millis(20));
            std::fs::write(in_dir(&acme), "turn 1\nturn 2\n").unwrap();
            assert!(ensure_claude_session_in(&default, cwd, id).unwrap(), "acme → default copies the newer file");
            assert_eq!(std::fs::read_to_string(in_dir(&default)).unwrap(), "turn 1\nturn 2\n");

            assert!(!ensure_claude_session_in(&default, cwd, "../escape").unwrap());
            assert!(!ensure_claude_session_in(&default, cwd, "ffffffff-0000-0000-0000-000000000000").unwrap(), "unknown id");
        });
    }

    #[cfg(unix)]
    #[test]
    fn accounts_sharing_projects_copy_nothing() {
        let home = tempfile::tempdir().expect("home");
        let cwd = "/Users/someone/work/demo";
        let id = "abababab-0000-0000-0000-000000000000";
        let shared = home.path().join("shared-projects");
        std::fs::create_dir_all(shared.join(claude_project_slug(cwd))).unwrap();
        std::fs::write(shared.join(claude_project_slug(cwd)).join(format!("{id}.jsonl")), "x\n").unwrap();
        for name in ["a", "b"] {
            let dir = home.path().join(".ccs/instances").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::os::unix::fs::symlink(&shared, dir.join("projects")).unwrap();
        }
        let b = home.path().join(".ccs/instances/b");
        assert!(!with_home(home.path(), || ensure_claude_session_in(&b, cwd, id)).unwrap());
    }

    #[test]
    fn reads_a_tail_from_a_profile_root() {
        let home = tempfile::tempdir().expect("home");
        let cwd = "/Users/someone/work/demo";
        let dir = home
            .path()
            .join(".ccs")
            .join("instances")
            .join("initech")
            .join("projects")
            .join(claude_project_slug(cwd));
        std::fs::create_dir_all(&dir).expect("dir");
        std::fs::write(dir.join("dddddddd-0000-0000-0000-000000000000.jsonl"), ASSISTANT)
            .expect("write");

        let tail = with_home(home.path(), || {
            read_claude_session_tail(cwd.to_string(), "dddddddd-0000-0000-0000-000000000000".to_string(), 240)
        });
        assert_eq!(tail.as_deref(), Some("Parser sudah pindah ke tui-source.ts"));
    }

    #[test]
    fn slug_replaces_separators_and_dots() {
        assert_eq!(
            claude_project_slug("/Users/a/workspace/codespace-demo"),
            "-Users-a-workspace-codespace-demo"
        );
        // dots in a path segment are sanitised too (e.g. worktree dirs).
        assert_eq!(
            claude_project_slug("/x/.lotus-worktrees/t"),
            "-x--lotus-worktrees-t"
        );
    }

    #[test]
    fn lists_jsonl_stems_and_is_empty_for_missing_dir() {
        let missing = std::env::temp_dir().join("lotus_claude_sessions_absent");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(list_claude_sessions_in(&missing).is_empty());

        let dir = std::env::temp_dir().join("lotus_claude_sessions_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("aaaa.jsonl"), "{}").unwrap();
        std::fs::write(dir.join("bbbb.jsonl"), "{}").unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let ids = list_claude_sessions_in(&dir);
        assert_eq!(ids.len(), 2, "only .jsonl files are session ids");
        assert!(ids.contains(&"aaaa".to_string()));
        assert!(ids.contains(&"bbbb".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
