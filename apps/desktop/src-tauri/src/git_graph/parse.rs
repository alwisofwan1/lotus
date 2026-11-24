//! Pure parsers for the git output the Git graph reads. No process is started here, so the same
//! parsers can serve a remote (SSH) runner later, and every format is pinned by a test.
//!
//! Fields are split on ASCII unit/record separators (or NUL), never on spaces or newlines: a
//! subject, an author or a path may hold either.

use std::collections::HashMap;

use super::{CommitFile, GraphCommit, GraphRef, GraphRefKind};

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

/// `git log --format=` for one graph row: sha, parents, author, email, author time, subject.
pub const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e";

/// `git show -s --format=` for a commit's header and its whole message.
pub const DETAIL_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B";

/// `git for-each-ref --format=`: NUL-separated, one ref per line.
pub const REFS_FORMAT: &str =
    "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(HEAD)%00%(worktreepath)%00%(symref)";

pub fn parse_log(raw: &str) -> Vec<GraphCommit> {
    raw.split(RECORD).filter_map(parse_commit_fields).map(|(commit, _)| commit).collect()
}

/// The header of `DETAIL_FORMAT` plus the full message (trailing newlines trimmed).
pub fn parse_detail(raw: &str) -> Option<(GraphCommit, String)> {
    parse_commit_fields(raw).map(|(mut commit, rest)| {
        let message = rest.trim_end().to_string();
        commit.subject = message.lines().next().unwrap_or_default().to_string();
        (commit, message)
    })
}

/// One record: the commit, and the last field untouched (the subject, or the whole message).
fn parse_commit_fields(record: &str) -> Option<(GraphCommit, &str)> {
    let record = record.trim_start_matches(['\n', '\r']);
    if record.is_empty() {
        return None;
    }
    let mut fields = record.splitn(6, FIELD);
    let sha = fields.next()?.trim();
    if sha.is_empty() {
        return None;
    }
    let parents = fields.next()?.split_whitespace().map(str::to_string).collect();
    let author = fields.next()?.to_string();
    let author_email = fields.next()?.to_string();
    let time = fields.next()?.trim().parse().unwrap_or(0);
    let last = fields.next().unwrap_or_default();
    let commit = GraphCommit {
        sha: sha.to_string(),
        parents,
        author,
        author_email,
        time,
        subject: last.trim_end_matches(['\n', '\r']).to_string(),
    };
    Some((commit, last))
}

pub fn short_ref_name(full: &str) -> &str {
    full.strip_prefix("refs/heads/")
        .or_else(|| full.strip_prefix("refs/remotes/"))
        .or_else(|| full.strip_prefix("refs/tags/"))
        .unwrap_or(full)
}

/// Refs from `REFS_FORMAT`, and the default branch named by a remote's `HEAD` symref (`origin/main`).
pub fn parse_refs(raw: &str) -> (Vec<GraphRef>, Option<String>) {
    let mut refs = Vec::new();
    let mut remote_default = None;
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        let fields: Vec<&str> = line.split('\0').collect();
        let [full, object, peeled, upstream, head, worktree, symref] = fields.as_slice() else {
            continue;
        };
        let kind = if full.starts_with("refs/heads/") {
            GraphRefKind::Local
        } else if full.starts_with("refs/remotes/") {
            GraphRefKind::Remote
        } else if full.starts_with("refs/tags/") {
            GraphRefKind::Tag
        } else {
            continue;
        };
        // `origin/HEAD` is a pointer, not a branch: it only says which branch is the default.
        if kind == GraphRefKind::Remote && full.ends_with("/HEAD") {
            if !symref.is_empty() && remote_default.is_none() {
                remote_default = Some(short_ref_name(symref).to_string());
            }
            continue;
        }
        // An annotated tag's own object is the tag; the commit it names is the peeled one.
        let target = if peeled.is_empty() { object } else { peeled };
        refs.push(GraphRef {
            name: short_ref_name(full).to_string(),
            full_name: full.to_string(),
            kind,
            target: target.to_string(),
            upstream: (!upstream.is_empty()).then(|| short_ref_name(upstream).to_string()),
            is_head: *head == "*",
            worktree: (!worktree.is_empty()).then(|| worktree.to_string()),
        });
    }
    (refs, remote_default)
}

/// `git rev-list --left-right HEAD...@{u}`: `<` commits are only on HEAD (not pushed), `>` only on
/// the upstream (not pulled).
pub fn parse_left_right(raw: &str) -> (Vec<String>, Vec<String>) {
    let mut outgoing = Vec::new();
    let mut incoming = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if let Some(sha) = line.strip_prefix('<') {
            outgoing.push(sha.to_string());
        } else if let Some(sha) = line.strip_prefix('>') {
            incoming.push(sha.to_string());
        }
    }
    (outgoing, incoming)
}

/// `git diff-tree -z --name-status`: a status token, then one path, or two (old, new) for a rename
/// or copy. The similarity score on `R100` / `C75` is dropped.
pub fn parse_name_status_z(raw: &str) -> Vec<CommitFile> {
    let mut tokens = raw.split('\0').filter(|token| !token.is_empty());
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        let letter = status.chars().next().unwrap_or('M');
        let (old_path, path) = if matches!(letter, 'R' | 'C') {
            let old = tokens.next().map(str::to_string);
            (old, tokens.next())
        } else {
            (None, tokens.next())
        };
        let Some(path) = path else { break };
        files.push(CommitFile {
            status: letter.to_string(),
            path: path.to_string(),
            old_path,
            additions: None,
            deletions: None,
            binary: false,
        });
    }
    files
}

/// `git diff-tree -z --numstat`, keyed by the new path. `-` counts mean a binary file.
/// A rename is `adds\tdels\t` then the old and new path as their own NUL-ended tokens.
pub fn parse_numstat_z(raw: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut out = HashMap::new();
    let mut tokens = raw.split('\0');
    while let Some(token) = tokens.next() {
        let mut parts = token.splitn(3, '\t');
        let (Some(adds), Some(dels), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = tokens.next();
            tokens.next().unwrap_or_default()
        } else {
            path
        };
        out.insert(path.to_string(), (adds.parse().ok(), dels.parse().ok()));
    }
    out
}

/// Fills the counts and the binary flag from `parse_numstat_z` into the name-status list.
pub fn merge_numstat(files: &mut [CommitFile], counts: &HashMap<String, (Option<u32>, Option<u32>)>) {
    for file in files {
        if let Some((adds, dels)) = counts.get(&file.path) {
            file.binary = adds.is_none() && dels.is_none();
            file.additions = *adds;
            file.deletions = *dels;
        }
    }
}

/// A full or abbreviated object name: what the search tries as a hash before the text search.
pub fn is_hash_query(query: &str) -> bool {
    (4..=64).contains(&query.len()) && query.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Text that git would read as an option or as two revisions must never reach it as one.
pub fn is_safe_rev(rev: &str) -> bool {
    !rev.is_empty()
        && rev.len() <= 1024
        && !rev.starts_with('-')
        && !rev.chars().any(|c| c.is_control() || c == ' ')
}

/// The GitHub page of a remote URL (`git@github.com:o/r.git` → `https://github.com/o/r`), so
/// `#318` in a message can link to it. Other hosts: `None`.
pub fn github_web_url(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("http://github.com/"))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, repo) = (parts.next()?, parts.next()?);
    let plain = |part: &str| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    (parts.next().is_none() && plain(owner) && plain(repo)).then(|| format!("https://github.com/{owner}/{repo}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_rows_keep_separators_inside_subjects_and_names() {
        let raw = "a1\u{1f}b2 c3\u{1f}Ann Lee\u{1f}ann@x.io\u{1f}1700000000\u{1f}Merge: one\ttwo\u{1e}\n\
                   b2\u{1f}\u{1f}Bo\u{1f}bo@x.io\u{1f}1690000000\u{1f}root\u{1e}\n";
        let rows = parse_log(raw);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].parents, vec!["b2", "c3"]);
        assert_eq!(rows[0].author, "Ann Lee");
        assert_eq!(rows[0].subject, "Merge: one\ttwo");
        assert_eq!(rows[0].time, 1_700_000_000);
        assert!(rows[1].parents.is_empty(), "a root commit has no parents");
    }

    #[test]
    fn log_tolerates_crlf_and_an_empty_output() {
        assert!(parse_log("").is_empty());
        let rows = parse_log("\r\na1\u{1f}\u{1f}A\u{1f}a@x\u{1f}1\u{1f}s\r\n\u{1e}");
        assert_eq!(rows[0].subject, "s");
    }

    #[test]
    fn detail_keeps_the_whole_message_and_takes_its_first_line_as_subject() {
        let raw = "a1\u{1f}b2\u{1f}A\u{1f}a@x\u{1f}5\u{1f}fix: one\n\nBody line\nSee #318\n\n";
        let (commit, message) = parse_detail(raw).unwrap();
        assert_eq!(commit.subject, "fix: one");
        assert_eq!(message, "fix: one\n\nBody line\nSee #318");
    }

    #[test]
    fn refs_peel_tags_skip_remote_head_and_name_the_default_branch() {
        let raw = [
            "refs/heads/main\0aaa\0\0refs/remotes/origin/main\0*\0/w/lotus\0",
            "refs/heads/agent/nia\0bbb\0\0\0 \0/w/wt-nia\0",
            "refs/remotes/origin/HEAD\0aaa\0\0\0 \0\0refs/remotes/origin/main",
            "refs/remotes/origin/main\0ccc\0\0\0 \0\0",
            "refs/tags/v1\0tagobj\0ddd\0\0 \0\0",
        ]
        .join("\n");
        let (refs, default) = parse_refs(&raw);
        assert_eq!(default.as_deref(), Some("origin/main"));
        assert_eq!(refs.len(), 4);
        assert!(refs[0].is_head);
        assert_eq!(refs[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(refs[1].name, "agent/nia");
        assert_eq!(refs[1].worktree.as_deref(), Some("/w/wt-nia"));
        assert_eq!(refs[3].kind, GraphRefKind::Tag);
        assert_eq!(refs[3].target, "ddd", "an annotated tag points at its commit");
    }

    #[test]
    fn left_right_splits_outgoing_and_incoming() {
        let (out, inc) = parse_left_right("<a1\n<a2\n>b1\n");
        assert_eq!(out, vec!["a1", "a2"]);
        assert_eq!(inc, vec!["b1"]);
    }

    #[test]
    fn name_status_reads_renames_and_paths_with_spaces() {
        let raw = "M\0src/a b.ts\0R087\0old/x.ts\0new/x.ts\0A\0img.png\0D\0gone.ts\0";
        let files = parse_name_status_z(raw);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "src/a b.ts");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].old_path.as_deref(), Some("old/x.ts"));
        assert_eq!(files[1].path, "new/x.ts");
        assert_eq!(files[3].status, "D");
    }

    #[test]
    fn numstat_marks_binary_and_keys_renames_by_the_new_path() {
        let raw = "3\t1\tsrc/a b.ts\0-\t-\timg.png\05\t2\t\0old/x.ts\0new/x.ts\0";
        let counts = parse_numstat_z(raw);
        assert_eq!(counts["src/a b.ts"], (Some(3), Some(1)));
        assert_eq!(counts["img.png"], (None, None));
        assert_eq!(counts["new/x.ts"], (Some(5), Some(2)));

        let mut files = parse_name_status_z("M\0src/a b.ts\0A\0img.png\0R100\0old/x.ts\0new/x.ts\0");
        merge_numstat(&mut files, &counts);
        assert_eq!(files[0].additions, Some(3));
        assert!(files[1].binary);
        assert!(!files[2].binary);
    }

    #[test]
    fn github_web_url_reads_ssh_and_https_remotes() {
        let url = Some("https://github.com/o/r".to_string());
        assert_eq!(github_web_url("git@github.com:o/r.git"), url);
        assert_eq!(github_web_url("ssh://git@github.com/o/r.git\n"), url);
        assert_eq!(github_web_url("https://github.com/o/r"), url);
        assert_eq!(github_web_url("https://gitlab.com/o/r.git"), None);
        assert_eq!(github_web_url("https://github.com/o/r/x"), None);
        assert_eq!(github_web_url("git@github.com:o/r?.git"), None);
    }

    #[test]
    fn hash_queries_and_unsafe_revs() {
        assert!(is_hash_query("9cad95d"));
        assert!(!is_hash_query("fix"));
        assert!(!is_hash_query("abc"), "too short to mean a commit");
        assert!(is_safe_rev("refs/heads/agent/nia"));
        assert!(is_safe_rev("HEAD"));
        assert!(!is_safe_rev("--output=/tmp/x"));
        assert!(!is_safe_rev("a b"));
        assert!(!is_safe_rev("a\nb"));
    }
}
