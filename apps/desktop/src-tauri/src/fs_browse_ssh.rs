//! Directory browsing on another machine — the remote twin of [`crate::fs_browse::list_dir_entries`].
//!
//! **Why this is not the editor's file lister.** `editor_fs_ssh` already walks a remote tree, but it
//! deliberately hides dotfile directories (`editor_fs.rs` has a test pinning that `.git` must not be
//! visible), and hiding `.git` is exactly what makes it useless here: the one fact an operator is
//! looking for while picking a project folder is *which of these is a repo*. So this asks a
//! different question in one round trip — the directories, and for each one whether it carries a
//! `.git` and a `package.json` — and returns the same `DirEntry` the local picker already renders.
//!
//! One round trip matters: through [`RemoteTransport`]'s master connection this costs ~30 ms, while
//! a probe per directory would pay that per row.

use crate::cli_tools::{
    run_ssh_shell_command, validate_remote_cwd, SshCommandMode, SshToolTarget, SH_GLOB_PRELUDE,
};
use crate::error::{other, AppError};
use crate::fs_browse::{assistant_text_from_tail, claude_project_slug, TRANSCRIPT_TAIL_BYTES};
use crate::models::DirEntry;
use crate::remote_transport::RemoteTransport;

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A POSIX `sh` listing of the immediate child directories, one per line.
///
/// `for d in */` is the whole reason this stays portable and cheap: the glob never matches a
/// dotfile, so `.git`, `.cache` and friends are skipped without a `case` guard, and when a directory
/// is empty the glob stays literal and `[ -d ]` drops it. Each line is `<git>\t<pkg>\t<name>`, with
/// the flags first so a name containing a tab cannot shift the columns.
pub(crate) fn build_browse_script(remote_path: &str) -> String {
    format!(
        concat!(
            "{prelude}",
            "cd {path} 2>/dev/null || exit 3\n",
            "for d in */ ; do\n",
            "  [ -d \"$d\" ] || continue\n",
            "  n=${{d%/}}\n",
            "  g=0; [ -d \"$n/.git\" ] && g=1\n",
            "  p=0; [ -f \"$n/package.json\" ] && p=1\n",
            "  printf '%s\\t%s\\t%s\\n' \"$g\" \"$p\" \"$n\"\n",
            "done\n",
        ),
        prelude = SH_GLOB_PRELUDE,
        path = quote_shell_arg(remote_path)
    )
}

pub(crate) fn parse_browse_output(stdout: &str, browse_path: &str) -> Vec<DirEntry> {
    let base = browse_path.trim_end_matches('/');
    let mut entries: Vec<DirEntry> = stdout
        .lines()
        .filter_map(|line| {
            // Split twice only: a directory name may legally contain a tab, and it is the last field.
            let mut parts = line.splitn(3, '\t');
            let git = parts.next()?;
            let pkg = parts.next()?;
            let name = parts.next()?;
            if name.is_empty() {
                return None;
            }
            Some(DirEntry {
                is_git_repo: git == "1",
                has_package_json: pkg == "1",
                path: format!("{base}/{name}"),
                name: name.to_string(),
            })
        })
        .collect();
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    entries
}

/// The immediate child directories of `browse_path` on `target`.
///
/// An unreadable or missing directory is an error rather than an empty list: the local twin returns
/// `vec![]` for a path that does not exist, but over SSH "nothing there" and "you cannot see it" are
/// different answers an operator has to act on differently, and the picker says which.
pub fn list_dir_entries_ssh(
    target: SshToolTarget,
    browse_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<DirEntry>, AppError> {
    let path = validate_remote_cwd(&browse_path)?;
    let script = build_browse_script(path);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;

    if !output.status.success() {
        if output.status.code() == Some(3) {
            return Err(other(format!(
                "Cannot open {path} on this machine — it does not exist, or you do not have permission."
            )));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(other(if detail.is_empty() {
            format!("Could not list {path} on this machine.")
        } else {
            detail.to_string()
        }));
    }

    Ok(parse_browse_output(
        &String::from_utf8_lossy(&output.stdout),
        path,
    ))
}


// ── Sessions on another machine (tiket 09) ────────────────────────────────────

/// Every directory a Claude-family CLI might keep transcripts in, as a shell glob list.
///
/// Mirrors [`crate::fs_browse`]'s local roots and for the same reason: `ccs <profile>` launches
/// Claude with a different `CLAUDE_CONFIG_DIR`, so its transcripts land under
/// `~/.ccs/instances/<profile>/` and a search of `~/.claude` alone finds nothing. A remote machine
/// running a profile runner would fail exactly the same way.
/// Lotus-made accounts (`<state>/accounts/claude/*`, the host's state dir is `~/.lotus`) too: an Isolated one
/// keeps transcripts of its own (G2).
const REMOTE_TRANSCRIPT_ROOTS: &str = "\"$HOME/.claude\" \"$HOME\"/.ccs/instances/* \"$HOME\"/.lotus/accounts/claude/*";

/// List the transcript ids recorded for `cwd` on the remote, newest first.
///
/// The slug is computed **here**, by the same pure function the local path uses, so the two can
/// never disagree about which directory a cwd maps to.
pub(crate) fn build_sessions_script(slug: &str) -> String {
    format!(
        concat!(
            "{prelude}",
            "for root in {roots}; do\n",
            "  d=\"$root/projects/\"{slug}\n",
            "  [ -d \"$d\" ] || continue\n",
            "  for f in \"$d\"/*.jsonl; do\n",
            "    [ -f \"$f\" ] || continue\n",
            // GNU first, BSD second: one probe would be a round trip, and the fallback costs nothing.
            "    m=$(stat -c %Y \"$f\" 2>/dev/null || stat -f %m \"$f\" 2>/dev/null || echo 0)\n",
            "    b=${{f##*/}}\n",
            "    printf '%s\\t%s\\n' \"$m\" \"${{b%.jsonl}}\"\n",
            "  done\n",
            "done\n",
        ),
        prelude = SH_GLOB_PRELUDE,
        roots = REMOTE_TRANSCRIPT_ROOTS,
        slug = quote_shell_arg(slug),
    )
}

/// Newest first, deduped by id.
///
/// Profiles frequently symlink `projects` to one shared context group, so the same id legitimately
/// appears under several roots — the local reader dedupes for that reason and so does this.
pub(crate) fn parse_sessions_output(stdout: &str) -> Vec<String> {
    let mut rows: Vec<(u64, String)> = stdout
        .lines()
        .filter_map(|line| {
            let (mtime, id) = line.trim_end().split_once('\t')?;
            let id = id.trim();
            if id.is_empty() {
                return None;
            }
            Some((mtime.trim().parse::<u64>().unwrap_or(0), id.to_string()))
        })
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));

    let mut seen: Vec<String> = Vec::new();
    for (_, id) in rows {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

pub fn list_claude_sessions_ssh(
    target: SshToolTarget,
    cwd: String,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<String>, AppError> {
    let slug = claude_project_slug(&cwd);
    let output = run_ssh_shell_command(
        &target,
        &build_sessions_script(&slug),
        SshCommandMode::NoTty,
        transport,
    )?;
    // A machine with no transcripts is not a failure — it is a machine that has not run one yet.
    Ok(parse_sessions_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Read the tail of one transcript on the remote. Raw bytes — the parsing happens locally.
pub(crate) fn build_tail_script(slug: &str, session_id: &str, bytes: u64) -> String {
    format!(
        concat!(
            "{prelude}",
            "for root in {roots}; do\n",
            "  f=\"$root/projects/\"{slug}\"/\"{id}\".jsonl\"\n",
            "  [ -f \"$f\" ] || continue\n",
            "  tail -c {bytes} \"$f\"\n",
            "  exit 0\n",
            "done\n",
            "exit 4\n",
        ),
        prelude = SH_GLOB_PRELUDE,
        roots = REMOTE_TRANSCRIPT_ROOTS,
        slug = quote_shell_arg(slug),
        id = quote_shell_arg(session_id),
        bytes = bytes,
    )
}

/// The newest assistant line of a remote transcript, for a dormant card's preview.
///
/// The bytes cross the wire; the **parsing is the local one** ([`assistant_text_from_tail`]). One
/// parser for both machines is the whole point: the format is Claude's, and a second copy would
/// drift on one side only.
pub fn read_claude_session_tail_ssh(
    target: SshToolTarget,
    cwd: String,
    session_id: String,
    max_chars: usize,
    transport: Option<&RemoteTransport>,
) -> Result<Option<String>, AppError> {
    let slug = claude_project_slug(&cwd);
    let output = run_ssh_shell_command(
        &target,
        &build_tail_script(&slug, &session_id, TRANSCRIPT_TAIL_BYTES),
        SshCommandMode::NoTty,
        transport,
    )?;
    if !output.status.success() {
        // Exit 4 is our own "no such transcript" — a session recorded by another runner, or one the
        // CLI has since removed. The caller says "saved" rather than inventing a line.
        return Ok(None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // `tail -c` can cut the first line in half; it cannot be parsed, so drop it — exactly what the
    // local reader does after its seek.
    let usable = text.split_once('\n').map(|(_, rest)| rest).unwrap_or(&text);
    Ok(assistant_text_from_tail(usable, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every SSH-backed command must be `async`, and this test exists because one was not.
    ///
    /// A synchronous `#[tauri::command]` runs on the main thread. These commands all talk to another
    /// machine, so a slow or unreachable host freezes the whole window — measured 2026-09-15, when
    /// the folder picker locked the UI for the 8 s `RemoteTransport` spends waiting for a control
    /// socket. The git family was already async; the editor family was not, and nothing said so.
    ///
    /// `list_ssh_hosts` is the one allowed exception: it parses `~/.ssh/config` on local disk and
    /// never opens a socket.
    #[test]
    fn every_ssh_command_stays_off_the_main_thread() {
        let lib = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read lib.rs");
        const LOCAL_ONLY: &[&str] = &["list_ssh_hosts"];

        let mut offenders: Vec<String> = Vec::new();
        for line in lib.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("pub fn ") else {
                continue;
            };
            let name = rest.split('(').next().unwrap_or("").trim();
            let touches_ssh = name.contains("ssh");
            if !touches_ssh || LOCAL_ONLY.contains(&name) {
                continue;
            }
            offenders.push(name.to_string());
        }

        assert!(
            offenders.is_empty(),
            "these SSH commands are synchronous and will freeze the window on a slow host: {offenders:?}"
        );
    }

    // ── Sessions on another machine ──────────────────────────────────────────

    #[test]
    fn the_session_search_covers_profile_runners_too() {
        let script = build_sessions_script("-Users-alwi-app");
        assert!(script.contains("$HOME/.claude"));
        assert!(
            script.contains(".ccs/instances/*"),
            "a ccs profile keeps its transcripts outside ~/.claude, and missing that is what broke \
             capture for every profile runner locally"
        );
        assert!(script.contains(".lotus/accounts/claude/*"), "an Isolated Lotus account keeps its own transcripts (G2)");
    }

    #[test]
    fn a_slug_cannot_escape_its_quotes() {
        let script = build_sessions_script("-srv-it's mine");
        assert!(script.contains("'-srv-it'\\''s mine'"));
    }

    #[test]
    fn sessions_come_back_newest_first() {
        let ids = parse_sessions_output("100\tolder\n300\tnewest\n200\tmiddle\n");
        assert_eq!(ids, vec!["newest", "middle", "older"]);
    }

    /// Profiles frequently symlink `projects` to one shared context group, so one id can legitimately
    /// appear under several roots.
    #[test]
    fn the_same_transcript_seen_under_two_roots_is_listed_once() {
        let ids = parse_sessions_output("300\tsame\n100\tsame\n200\tother\n");
        assert_eq!(ids, vec!["same", "other"]);
    }

    #[test]
    fn a_machine_with_no_transcripts_yields_an_empty_list_not_a_fault() {
        assert!(parse_sessions_output("").is_empty());
        assert!(parse_sessions_output("garbage\n\n").is_empty());
    }

    #[test]
    fn an_unreadable_timestamp_still_lists_the_session() {
        let ids = parse_sessions_output("not-a-number\tstill-here\n");
        assert_eq!(ids, vec!["still-here"]);
    }

    #[test]
    fn the_tail_script_stops_at_the_first_root_that_has_the_transcript() {
        let script = build_tail_script("-srv-api", "abc-123", 4096);
        assert!(script.contains("tail -c 4096"));
        assert!(script.contains("exit 0"), "it must not keep reading other roots");
        assert!(
            script.contains("exit 4"),
            "a missing transcript needs its own status so the caller can say \"saved\" rather than invent a line"
        );
    }

    #[test]
    fn the_session_id_is_quoted_in_the_tail_script() {
        let script = build_tail_script("-srv-api", "abc'; rm -rf /", 10);
        assert!(script.contains("'abc'\\''; rm -rf /'"));
    }

    #[test]
    fn the_script_never_lets_a_path_escape_its_quotes() {
        let script = build_browse_script("/srv/it's mine");
        assert!(script.contains("cd '/srv/it'\\''s mine'"));
    }

    #[test]
    fn a_line_becomes_a_directory_with_its_flags() {
        let entries = parse_browse_output("1\t1\tapi\n0\t0\tbackups\n", "/srv/devbox");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "api");
        assert_eq!(entries[0].path, "/srv/devbox/api");
        assert!(entries[0].is_git_repo);
        assert!(entries[0].has_package_json);
        assert!(!entries[1].is_git_repo);
    }

    #[test]
    fn a_trailing_slash_on_the_parent_does_not_double_up() {
        let entries = parse_browse_output("0\t0\tweb\n", "/srv/devbox/");
        assert_eq!(entries[0].path, "/srv/devbox/web");
    }

    #[test]
    fn names_sort_case_insensitively_so_the_list_reads_naturally() {
        let entries = parse_browse_output("0\t0\tZeta\n0\t0\tapi\n0\t0\tBeta\n", "/srv");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["api", "Beta", "Zeta"]);
    }

    #[test]
    fn a_name_containing_a_tab_keeps_its_whole_name() {
        let entries = parse_browse_output("1\t0\todd\tname\n", "/srv");
        assert_eq!(entries[0].name, "odd\tname");
        assert!(entries[0].is_git_repo);
    }

    #[test]
    fn garbage_lines_are_dropped_rather_than_rendered() {
        let entries = parse_browse_output("not a row\n\n0\t0\tok\n", "/srv");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["ok"]);
    }

    // ── The shell on the far side is not the shell these scripts were written for ──────────
    //
    // `ssh host '<script>'` runs through the operator's LOGIN shell. On devbox-vps that is zsh,
    // where `nomatch` is on by default and a pattern matching nothing is a fatal error rather than
    // a literal. Both scripts below glob, both were written for sh semantics, and both died there
    // (measured 2026-09-17). Text assertions cannot see this — only running them under zsh can.

    fn zsh() -> Option<String> {
        for candidate in ["/bin/zsh", "/usr/bin/zsh"] {
            if std::path::Path::new(candidate).exists() {
                return Some(candidate.to_string());
            }
        }
        None
    }

    fn run_in(shell: &str, script: &str, home: &std::path::Path, cwd: &std::path::Path) -> std::process::Output {
        std::process::Command::new(shell)
            .arg("-c")
            .arg(script)
            .env("HOME", home)
            .env("PATH", crate::cli_tools::TEST_PATH)
            .current_dir(cwd)
            .output()
            .expect("run script")
    }

    /// Picking a folder that happens to be empty must show nothing, not fail.
    ///
    /// Before the prelude this was `zsh:1: no matches found: */`, exit 1 — and `list_dir_entries_ssh`
    /// turns a non-zero exit into an error, so the picker told the operator their own empty
    /// directory could not be opened.
    #[test]
    fn browsing_an_empty_directory_works_under_zsh_too() {
        let Some(zsh) = zsh() else { return };
        let dir = tempfile::tempdir().expect("temp dir");
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).expect("empty dir");

        let script = build_browse_script(empty.to_str().expect("utf8"));
        let out = run_in(&zsh, &script, dir.path(), dir.path());

        assert!(
            out.status.success(),
            "zsh said: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(parse_browse_output(&String::from_utf8_lossy(&out.stdout), "/x").is_empty());
    }

    /// And the ordinary case still works in the same shell, so the prelude did not cost the answer.
    #[test]
    fn browsing_a_populated_directory_still_answers_under_zsh() {
        let Some(zsh) = zsh() else { return };
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("root");
        std::fs::create_dir_all(root.join("alpha/.git")).expect("repo");
        std::fs::write(root.join("alpha/package.json"), "{}").expect("pkg");
        std::fs::create_dir_all(root.join("beta")).expect("plain");
        std::fs::create_dir_all(root.join(".hidden")).expect("dotdir");

        let script = build_browse_script(root.to_str().expect("utf8"));
        let out = run_in(&zsh, &script, dir.path(), dir.path());
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        let entries = parse_browse_output(&String::from_utf8_lossy(&out.stdout), "/root");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"], "a dotfile directory is still skipped");
        assert!(entries[0].is_git_repo && entries[0].has_package_json);
    }

    /// The one that was actually broken on the live machine: `"$HOME"/.ccs/instances/*` matches
    /// nothing on a host that never ran ccs, which is most of them.
    #[test]
    fn listing_sessions_survives_a_machine_with_no_ccs_profiles() {
        let Some(zsh) = zsh() else { return };
        let dir = tempfile::tempdir().expect("temp dir");

        let script = build_sessions_script("-srv-api");
        let out = run_in(&zsh, &script, dir.path(), dir.path());

        assert!(
            out.status.success(),
            "zsh said: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(parse_sessions_output(&String::from_utf8_lossy(&out.stdout)).is_empty());
    }

    /// And a machine that does have transcripts still reports them, in the same shell.
    #[test]
    fn a_transcript_is_still_found_under_zsh() {
        let Some(zsh) = zsh() else { return };
        let dir = tempfile::tempdir().expect("temp dir");
        let projects = dir.path().join(".claude/projects/-srv-api");
        std::fs::create_dir_all(&projects).expect("projects");
        std::fs::write(projects.join("abc-123.jsonl"), "{}\n").expect("transcript");

        let script = build_sessions_script("-srv-api");
        let out = run_in(&zsh, &script, dir.path(), dir.path());
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

        assert_eq!(
            parse_sessions_output(&String::from_utf8_lossy(&out.stdout)),
            vec!["abc-123".to_string()]
        );
    }

    /// The third place the same glob lives, and the one I missed on the first pass.
    ///
    /// `build_sessions_script` and `build_browse_script` were fixed together; the tail script shares
    /// `REMOTE_TRANSCRIPT_ROOTS` with the first and was not. It failed on the live machine in
    /// exactly the same way, on the very next command.
    #[test]
    fn reading_a_transcript_tail_survives_a_machine_with_no_ccs_profiles() {
        let Some(zsh) = zsh() else { return };
        let dir = tempfile::tempdir().expect("temp dir");
        let projects = dir.path().join(".claude/projects/-srv-api");
        std::fs::create_dir_all(&projects).expect("projects");
        std::fs::write(projects.join("abc-123.jsonl"), "{\"role\":\"assistant\"}\n").expect("transcript");

        let out = run_in(&zsh, &build_tail_script("-srv-api", "abc-123", 4096), dir.path(), dir.path());
        assert!(
            out.status.success(),
            "zsh said: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("assistant"));
    }

    /// And a fourth must not appear. Every script that globs needs the prelude, so this asks the
    /// builders rather than trusting whoever adds the next one to remember.
    #[test]
    fn every_script_that_globs_carries_the_prelude() {
        let globbing = [
            ("browse", build_browse_script("/srv/api")),
            ("sessions", build_sessions_script("-srv-api")),
            ("tail", build_tail_script("-srv-api", "abc", 10)),
        ];
        for (name, script) in globbing {
            assert!(
                script.contains('*'),
                "{name} no longer globs — drop it from this list rather than loosening the check"
            );
            assert!(
                script.starts_with(SH_GLOB_PRELUDE),
                "{name} globs but does not ask for sh glob semantics; on a zsh host it will abort"
            );
        }
    }

    /// The prelude must be a no-op where it is not needed, or it would trade one broken shell for
    /// two. `setopt` is not a command in sh or bash.
    #[test]
    fn the_prelude_costs_nothing_in_sh_and_bash() {
        let dir = tempfile::tempdir().expect("temp dir");
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).expect("empty dir");
        let script = build_browse_script(empty.to_str().expect("utf8"));

        for shell in ["/bin/sh", "/bin/bash"] {
            if !std::path::Path::new(shell).exists() {
                continue;
            }
            let out = run_in(shell, &script, dir.path(), dir.path());
            assert!(out.status.success(), "{shell} said: {}", String::from_utf8_lossy(&out.stderr));
            assert!(
                String::from_utf8_lossy(&out.stdout).trim().is_empty(),
                "{shell} printed something for an empty directory"
            );
        }
    }
}
