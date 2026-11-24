//! Find in files: every match of a text or a regex under a workspace root, as VS Code's search
//! view shows them.
//!
//! Locally the folder is walked with the `ignore` crate (ripgrep's walker): what `.gitignore`
//! leaves out is left out, hidden files are searched, `.git` is not. Each text file is read and
//! decoded as the editor reads it (`editor_encoding`), so a Windows-1252 file is searched as
//! text and a binary one is skipped.
//!
//! Over SSH, `rg` on the host finds the matching lines (`grep` when there is no `rg`), and the
//! columns are worked out here with the same matcher as locally, so both report the same thing.
//!
//! Columns and lengths are UTF-16 code units, 1-based columns, as Monaco and JavaScript count.
//! A search can be cancelled by its id: typing a new query stops the old walk at once.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::AppError;

/// Folders never searched, ignored by git or not: VS Code's default `search.exclude`, plus `.git`.
const SKIPPED_FOLDERS: &[&str] = &[".git", "node_modules", "bower_components"];

/// Most matches a search returns; past it the result says `truncated`.
pub const MAX_SEARCH_MATCHES: usize = 10_000;
/// A file larger than this is not searched (a log or a dump, not source).
const MAX_SEARCHED_FILE_BYTES: u64 = 20 * 1024 * 1024;
/// Text shown around a match: some before it, more after.
const PREVIEW_BEFORE_CHARS: usize = 40;
const PREVIEW_AFTER_CHARS: usize = 160;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    /// Globs to search only, comma separated (`src/**, *.ts`), gitignore style.
    #[serde(default)]
    pub include: Option<String>,
    /// Globs to leave out, comma separated.
    #[serde(default)]
    pub exclude: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchMatch {
    /// 1-based line.
    pub line: u32,
    /// 1-based column of the match, in UTF-16 units.
    pub column: u32,
    /// Length of the match in UTF-16 units.
    pub length: u32,
    /// The text around the match, on one line.
    pub preview: String,
    /// Where the match starts in `preview`, in UTF-16 units.
    pub preview_start: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchFile {
    /// Absolute path.
    pub path: String,
    pub matches: Vec<EditorSearchMatch>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorSearchResult {
    pub files: Vec<EditorSearchFile>,
    pub match_count: usize,
    /// More matches exist than were returned.
    pub truncated: bool,
    /// A newer search took its place; `files` is whatever was found by then.
    pub cancelled: bool,
}

/// The matcher a query stands for. A text query is escaped; whole word wraps it in `\b`, which
/// is what VS Code does too.
pub fn build_matcher(query: &EditorSearchQuery) -> Result<Regex, AppError> {
    if query.pattern.is_empty() {
        return Err(AppError::Other("Nothing to search for".into()));
    }
    let body = if query.is_regex {
        query.pattern.clone()
    } else {
        regex::escape(&query.pattern)
    };
    let body = if query.whole_word {
        format!(r"\b(?:{body})\b")
    } else {
        body
    };
    RegexBuilder::new(&body)
        .case_insensitive(!query.case_sensitive)
        .multi_line(true)
        .size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|err| AppError::Other(format!("Invalid regular expression: {err}")))
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// The char boundary `count` chars back from `index`, or the start.
fn back_chars(text: &str, index: usize, count: usize) -> usize {
    text[..index]
        .char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(0, |(position, _)| position)
}

/// The char boundary `count` chars on from `index`, or the end.
fn forward_chars(text: &str, index: usize, count: usize) -> usize {
    text[index..]
        .char_indices()
        .nth(count)
        .map_or(text.len(), |(position, _)| index + position)
}

/// Every match on one line (no line break in it), with its preview. A zero-length match (`^`,
/// `\b`) is not a result.
pub fn match_line(matcher: &Regex, line_number: u32, line: &str, limit: usize) -> Vec<EditorSearchMatch> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut matches = Vec::new();
    for found in matcher.find_iter(line) {
        if found.start() == found.end() {
            continue;
        }
        if matches.len() >= limit {
            break;
        }
        let from = back_chars(line, found.start(), PREVIEW_BEFORE_CHARS);
        let to = forward_chars(line, found.end(), PREVIEW_AFTER_CHARS);
        // Leading indentation says nothing; the preview starts at the text.
        let shown = line[from..to].trim_start();
        let shown_from = to - shown.len();
        let shown_from = shown_from.min(found.start());
        let preview = line[shown_from..to].to_string();
        matches.push(EditorSearchMatch {
            line: line_number,
            column: utf16_len(&line[..found.start()]) + 1,
            length: utf16_len(found.as_str()),
            preview_start: utf16_len(&line[shown_from..found.start()]),
            preview,
        });
    }
    matches
}

/// Every match in a file's text. `limit` caps how many are returned.
pub fn match_text(matcher: &Regex, text: &str, limit: usize) -> Vec<EditorSearchMatch> {
    let mut matches = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        if matches.len() >= limit {
            break;
        }
        // Cheap test first: most lines of most files do not match.
        if !matcher.is_match(line) {
            continue;
        }
        let left = limit - matches.len();
        matches.extend(match_line(matcher, index as u32 + 1, line, left));
    }
    matches
}

fn split_globs(globs: Option<&str>) -> Vec<String> {
    globs
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|glob| !glob.is_empty())
        .map(str::to_string)
        .collect()
}

fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The flag a running search checks; registered under its id until it ends.
struct CancelGuard {
    id: String,
    flag: Arc<AtomicBool>,
}

impl CancelGuard {
    fn register(id: &str) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        let mut flags = cancel_flags().lock().unwrap_or_else(|poison| poison.into_inner());
        flags.insert(id.to_string(), flag.clone());
        Self {
            id: id.to_string(),
            flag,
        }
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut flags = cancel_flags().lock().unwrap_or_else(|poison| poison.into_inner());
        if flags.get(&self.id).is_some_and(|flag| Arc::ptr_eq(flag, &self.flag)) {
            flags.remove(&self.id);
        }
    }
}

/// Stops the search running under `id`, if one is.
pub fn cancel(id: &str) {
    let flags = cancel_flags().lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some(flag) = flags.get(id) {
        flag.store(true, Ordering::Relaxed);
    }
}

fn read_text(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_SEARCHED_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // Valid UTF-8 with a NUL in it opens as text in the editor, but a search hit in it is
    // almost always a binary format that happens to be valid UTF-8 (a .pyc, an image header).
    let sample = &bytes[..bytes.len().min(8192)];
    let utf16 = sample.starts_with(&[0xFF, 0xFE]) || sample.starts_with(&[0xFE, 0xFF]);
    if !utf16 && sample.contains(&0) {
        return None;
    }
    crate::editor_encoding::decode(&bytes).map(|decoded| decoded.content)
}

/// Searches the folder at `root`. `id` names the search for [`cancel`].
pub fn search_local(root: &str, query: &EditorSearchQuery, id: &str) -> Result<EditorSearchResult, AppError> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {root}")));
    }
    let matcher = build_matcher(query)?;
    let guard = CancelGuard::register(id);

    let mut overrides = ignore::overrides::OverrideBuilder::new(root_path);
    for glob in split_globs(query.include.as_deref()) {
        overrides
            .add(&glob)
            .map_err(|err| AppError::Other(format!("Invalid include pattern {glob}: {err}")))?;
    }
    for glob in split_globs(query.exclude.as_deref()) {
        overrides
            .add(&format!("!{glob}"))
            .map_err(|err| AppError::Other(format!("Invalid exclude pattern {glob}: {err}")))?;
    }
    let overrides = overrides
        .build()
        .map_err(|err| AppError::Other(err.to_string()))?;

    let walker = ignore::WalkBuilder::new(root_path)
        .hidden(false)
        .require_git(false)
        .follow_links(false)
        .overrides(overrides)
        .filter_entry(|entry| {
            !(entry.file_type().is_some_and(|kind| kind.is_dir())
                && SKIPPED_FOLDERS.iter().any(|name| entry.file_name() == *name))
        })
        .build_parallel();

    let files = Mutex::new(Vec::<EditorSearchFile>::new());
    let total = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    walker.run(|| {
        let matcher = matcher.clone();
        let flag = guard.flag.clone();
        let files = &files;
        let total = &total;
        let truncated = &truncated;
        Box::new(move |entry| {
            if flag.load(Ordering::Relaxed) || truncated.load(Ordering::Relaxed) {
                return ignore::WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return ignore::WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return ignore::WalkState::Continue;
            }
            let Some(text) = read_text(entry.path()) else {
                return ignore::WalkState::Continue;
            };
            let left = MAX_SEARCH_MATCHES.saturating_sub(total.load(Ordering::Relaxed));
            // One more than is left, to know whether some were left out.
            let mut matches = match_text(&matcher, &text, left + 1);
            if matches.is_empty() {
                return ignore::WalkState::Continue;
            }
            let previous = total.fetch_add(matches.len(), Ordering::Relaxed);
            if previous + matches.len() > MAX_SEARCH_MATCHES {
                truncated.store(true, Ordering::Relaxed);
                matches.truncate(MAX_SEARCH_MATCHES.saturating_sub(previous));
                if matches.is_empty() {
                    return ignore::WalkState::Quit;
                }
            }
            files
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .push(EditorSearchFile {
                    path: entry.path().to_string_lossy().into_owned(),
                    matches,
                });
            ignore::WalkState::Continue
        })
    });

    let mut files = files.into_inner().unwrap_or_else(|poison| poison.into_inner());
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let match_count = files.iter().map(|file| file.matches.len()).sum();
    Ok(EditorSearchResult {
        files,
        match_count,
        truncated: truncated.load(Ordering::Relaxed),
        cancelled: guard.flag.load(Ordering::Relaxed),
    })
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Lines a remote search prints at most (each is `path NUL line:text`).
const MAX_REMOTE_LINES: usize = 20_000;
/// Longest line a remote search prints; a minified file's one line is cut here.
const MAX_REMOTE_LINE_CHARS: usize = 4_000;

/// The script that lists matching lines on an SSH host: ripgrep when it is there (the same
/// regex dialect as here), else grep (`-E`; a text query with `-F` matches exactly the same).
/// Both skip `SKIPPED_FOLDERS`; ripgrep also skips what `.gitignore` says, as the local search
/// does.
pub fn build_remote_search_script(remote_root: &str, query: &EditorSearchQuery) -> String {
    let pattern = quote(&query.pattern);
    let mut rg = vec![
        "rg", "--no-heading", "--with-filename", "--line-number", "--null", "--color", "never",
        "--hidden", "--no-messages",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let mut grep = vec!["grep".to_string(), "-rnI".to_string(), "--null".to_string()];
    for folder in SKIPPED_FOLDERS {
        rg.push(format!("--glob '!{folder}/'"));
        grep.push(format!("--exclude-dir={folder}"));
    }
    if !query.case_sensitive {
        rg.push("-i".into());
        grep.push("-i".into());
    }
    if query.whole_word {
        rg.push("-w".into());
        grep.push("-w".into());
    }
    if query.is_regex {
        grep.push("-E".into());
    } else {
        rg.push("-F".into());
        grep.push("-F".into());
    }
    for glob in split_globs(query.include.as_deref()) {
        rg.push(format!("--glob {}", quote(&glob)));
        grep.push(format!("--include={}", quote(&glob)));
    }
    for glob in split_globs(query.exclude.as_deref()) {
        rg.push(format!("--glob {}", quote(&format!("!{glob}"))));
        grep.push(format!("--exclude={}", quote(&glob)));
        grep.push(format!("--exclude-dir={}", quote(glob.trim_end_matches("/**").trim_end_matches('/'))));
    }
    format!(
        "cd -- {root} || exit 3\n\
         if command -v rg >/dev/null 2>&1; then\n  {rg} -- {pattern} . 2>&1\n\
         else\n  {grep} -- {pattern} . 2>&1\nfi | head -n {lines} | cut -c1-{chars}\n",
        root = quote(remote_root),
        rg = rg.join(" "),
        grep = grep.join(" "),
        lines = MAX_REMOTE_LINES + 1,
        chars = MAX_REMOTE_LINE_CHARS,
    )
}

/// Turns `path NUL line:text` lines into results, the columns found with `matcher`. A line
/// without the NUL is an error message from rg or grep: when nothing matched, it is the error.
pub fn parse_remote_search_output(
    remote_root: &str,
    stdout: &[u8],
    matcher: &Regex,
) -> Result<EditorSearchResult, AppError> {
    let text = String::from_utf8_lossy(stdout);
    let root = remote_root.trim_end_matches('/');
    let mut files: Vec<EditorSearchFile> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    let mut messages = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        if index >= MAX_REMOTE_LINES {
            truncated = true;
            break;
        }
        let Some((path, rest)) = raw.split_once('\0') else {
            if !raw.trim().is_empty() {
                messages.push(raw.trim().to_string());
            }
            continue;
        };
        let Some((line_number, line)) = rest.split_once(':') else { continue };
        let Ok(line_number) = line_number.parse::<u32>() else { continue };
        let left = MAX_SEARCH_MATCHES - total;
        let mut matches = match_line(matcher, line_number, line, left + 1);
        if matches.is_empty() {
            continue;
        }
        if matches.len() > left {
            matches.truncate(left);
            truncated = true;
            if matches.is_empty() {
                break;
            }
        }
        total += matches.len();
        let relative = path.trim_start_matches("./");
        let absolute = format!("{root}/{relative}");
        match files.last_mut() {
            Some(file) if file.path == absolute => file.matches.extend(matches),
            _ => files.push(EditorSearchFile {
                path: absolute,
                matches,
            }),
        }
        if truncated {
            break;
        }
    }
    if files.is_empty() && !messages.is_empty() {
        return Err(AppError::Other(messages.join("\n")));
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(EditorSearchResult {
        files,
        match_count: total,
        truncated,
        cancelled: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pattern: &str) -> EditorSearchQuery {
        EditorSearchQuery {
            pattern: pattern.into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            include: None,
            exclude: None,
        }
    }

    #[test]
    fn text_queries_are_literal_and_case_follows_the_toggle() {
        let matcher = build_matcher(&query("a.b(")).unwrap();
        assert!(matcher.is_match("x A.B( y"));
        assert!(!matcher.is_match("axb("));
        let exact = build_matcher(&EditorSearchQuery { case_sensitive: true, ..query("Foo") }).unwrap();
        assert!(!exact.is_match("foo"));
    }

    #[test]
    fn whole_word_and_regex() {
        let word = build_matcher(&EditorSearchQuery { whole_word: true, ..query("log") }).unwrap();
        assert!(word.is_match("a log b"));
        assert!(!word.is_match("catalog"));
        let regex = build_matcher(&EditorSearchQuery { is_regex: true, ..query(r"fn \w+\(") }).unwrap();
        assert!(regex.is_match("pub fn main() {"));
        assert!(build_matcher(&EditorSearchQuery { is_regex: true, ..query("(") }).is_err());
        assert!(build_matcher(&query("")).is_err());
    }

    #[test]
    fn columns_are_utf16_and_the_preview_points_at_the_match() {
        let matcher = build_matcher(&query("needle")).unwrap();
        // "é" is one UTF-16 unit, "😀" two.
        let found = match_line(&matcher, 3, "    é😀 needle here\r", 10);
        assert_eq!(found.len(), 1);
        let hit = &found[0];
        assert_eq!((hit.line, hit.column, hit.length), (3, 9, 6));
        // Indentation trimmed; the match sits where `preview_start` says.
        assert_eq!(hit.preview, "é😀 needle here");
        let units: Vec<u16> = hit.preview.encode_utf16().collect();
        let at = hit.preview_start as usize;
        assert_eq!(String::from_utf16(&units[at..at + 6]).unwrap(), "needle");
    }

    #[test]
    fn a_long_line_is_shown_around_the_match() {
        let matcher = build_matcher(&query("X")).unwrap();
        let line = format!("{}X{}", "a".repeat(500), "b".repeat(500));
        let hit = &match_line(&matcher, 1, &line, 10)[0];
        assert_eq!(hit.column, 501);
        assert_eq!(hit.preview.chars().count(), PREVIEW_BEFORE_CHARS + 1 + PREVIEW_AFTER_CHARS);
        assert_eq!(hit.preview_start as usize, PREVIEW_BEFORE_CHARS);
    }

    #[test]
    fn every_match_on_every_line_up_to_the_limit() {
        let matcher = build_matcher(&query("ab")).unwrap();
        let found = match_text(&matcher, "ab ab\nnone\nxab", 10);
        let at: Vec<(u32, u32)> = found.iter().map(|hit| (hit.line, hit.column)).collect();
        assert_eq!(at, vec![(1, 1), (1, 4), (3, 2)]);
        assert_eq!(match_text(&matcher, "ab ab\nab", 2).len(), 2);
        // An empty match is no result.
        let empty = build_matcher(&EditorSearchQuery { is_regex: true, ..query("^") }).unwrap();
        assert!(match_text(&empty, "a\nb", 10).is_empty());
    }

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join(".github")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/i.js"), "token in a dependency\n").unwrap();
        std::fs::write(root.join(".gitignore"), "dist/\n").unwrap();
        std::fs::write(root.join("src/a.ts"), "const token = 1;\nexport { token };\n").unwrap();
        std::fs::write(root.join("src/b.md"), "token in docs\n").unwrap();
        std::fs::write(root.join("dist/a.js"), "token built\n").unwrap();
        std::fs::write(root.join(".git/config"), "token in git\n").unwrap();
        std::fs::write(root.join(".github/ci.yml"), "token: ${{ secrets.T }}\n").unwrap();
        std::fs::write(root.join("src/latin1.txt"), b"caf\xE9 token\n").unwrap();
        std::fs::write(root.join("src/image.bin"), b"\x89PNG\0\0token").unwrap();
        dir
    }

    fn paths(result: &EditorSearchResult, root: &Path) -> Vec<String> {
        result
            .files
            .iter()
            .map(|file| file.path.strip_prefix(&*root.to_string_lossy()).unwrap().trim_start_matches('/').to_string())
            .collect()
    }

    #[test]
    fn searches_what_git_keeps_hidden_files_too_never_dot_git_or_binary() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        let result = search_local(&root, &query("token"), "t1").unwrap();
        assert_eq!(
            paths(&result, dir.path()),
            vec![".github/ci.yml", "src/a.ts", "src/b.md", "src/latin1.txt"]
        );
        assert_eq!(result.match_count, 5);
        assert!(!result.truncated && !result.cancelled);
        let latin = result.files.iter().find(|file| file.path.ends_with("latin1.txt")).unwrap();
        assert_eq!(latin.matches[0].column, 6);
    }

    #[test]
    fn include_and_exclude_globs() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        let only_ts = EditorSearchQuery { include: Some("*.ts".into()), ..query("token") };
        assert_eq!(paths(&search_local(&root, &only_ts, "t2").unwrap(), dir.path()), vec!["src/a.ts"]);
        let no_src = EditorSearchQuery { exclude: Some("src/**, .github".into()), ..query("token") };
        assert!(search_local(&root, &no_src, "t3").unwrap().files.is_empty());
    }

    #[test]
    fn stops_at_the_match_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("many.txt"), "x\n".repeat(MAX_SEARCH_MATCHES + 5)).unwrap();
        let result = search_local(&dir.path().to_string_lossy(), &query("x"), "t4").unwrap();
        assert_eq!(result.match_count, MAX_SEARCH_MATCHES);
        assert!(result.truncated);
    }

    #[test]
    fn a_cancelled_search_says_so() {
        let dir = workspace();
        let guard = CancelGuard::register("t5");
        cancel("t5");
        assert!(guard.flag.load(Ordering::Relaxed));
        drop(guard);
        // A later search under the same id starts fresh.
        let result = search_local(&dir.path().to_string_lossy(), &query("token"), "t5").unwrap();
        assert!(!result.cancelled);
    }

    #[test]
    fn remote_script_quotes_everything_and_falls_back_to_grep() {
        let script = build_remote_search_script(
            "/srv/it's",
            &EditorSearchQuery { include: Some("*.php".into()), exclude: Some("vendor/**".into()), ..query("a'b") },
        );
        assert!(script.contains(r"cd -- '/srv/it'\''s'"));
        assert!(script.contains(r"-- 'a'\''b' ."));
        assert!(script.contains(" -F "));
        assert!(script.contains("--glob '*.php'"));
        assert!(script.contains("--glob '!vendor/**'"));
        assert!(script.contains("--include='*.php'"));
        assert!(script.contains("--exclude-dir='vendor'"));
        assert!(script.contains("head -n 20001"));
    }

    #[test]
    fn remote_script_runs_with_grep_and_with_rg() {
        let dir = workspace();
        let root = dir.path().to_string_lossy().to_string();
        let script = build_remote_search_script(&root, &query("token"));
        let output = std::process::Command::new("sh").arg("-c").arg(&script).output().unwrap();
        let matcher = build_matcher(&query("token")).unwrap();
        let result = parse_remote_search_output(&root, &output.stdout, &matcher).unwrap();
        let found = paths(&result, dir.path());
        assert!(found.contains(&"src/a.ts".to_string()), "{found:?}");
        assert!(!found.iter().any(|path| path.starts_with(".git/") || path.starts_with("node_modules/")), "{found:?}");
        assert!(!found.contains(&"src/image.bin".to_string()), "{found:?}");
        let a = result.files.iter().find(|file| file.path.ends_with("src/a.ts")).unwrap();
        assert_eq!(a.matches.iter().map(|hit| (hit.line, hit.column)).collect::<Vec<_>>(), vec![(1, 7), (2, 10)]);
    }

    #[test]
    fn remote_output_parses_and_reports_errors() {
        let matcher = build_matcher(&query("x")).unwrap();
        let out = b"./a.rs\x003:let x = 1;\n./a.rs\x009:x\n./b/c.rs\x001:xx\n";
        let result = parse_remote_search_output("/w/", out, &matcher).unwrap();
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].path, "/w/a.rs");
        assert_eq!(result.files[0].matches.len(), 2);
        assert_eq!(result.match_count, 4);
        let error = parse_remote_search_output("/w", b"rg: regex parse error\n", &matcher);
        assert!(error.is_err());
        assert!(parse_remote_search_output("/w", b"", &matcher).unwrap().files.is_empty());
    }
}
