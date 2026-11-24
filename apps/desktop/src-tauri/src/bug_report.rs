//! What the in-app bug report attaches (mockups/bug-report.html): the app version and OS, the
//! last crash this machine had, and a tail of the session daemon's log — all redacted, because the
//! report becomes a public GitHub issue on lotus-releases.
//!
//! A crash is a Rust panic: [`install_panic_hook`] writes it to `<state dir>/crash/<ms>.log`
//! before the default hook runs. The newest file is "unseen" until the user opens the report
//! dialog once ([`mark_crash_seen`]); that is what puts the dot on the rail's bug icon.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// The log lines a report carries. A prefilled GitHub URL tops out around 8 KB.
const LOG_LINES: usize = 60;
const SEEN_FILE: &str = "seen";

static APP_VERSION: OnceLock<String> = OnceLock::new();

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Crash {
    /// Milliseconds since the epoch, from the file name.
    pub at_ms: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReportContext {
    pub version: String,
    pub os: String,
    pub arch: &'static str,
    pub release: bool,
    /// The newest crash the user has not opened the report dialog for yet.
    pub crash: Option<Crash>,
    pub log: String,
}

fn crash_dir() -> PathBuf {
    crate::paths::lotus_state_dir().join("crash")
}

/// Writes every panic to the crash folder, then lets the previous hook print it as before.
pub fn install_panic_hook(version: String) {
    let _ = APP_VERSION.set(version);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let text = format!(
            "Lotus {} · thread '{thread}'\n{info}\n\n{}",
            APP_VERSION.get().map(String::as_str).unwrap_or("?"),
            std::backtrace::Backtrace::force_capture(),
        );
        // Best effort: a hook that fails must not panic again.
        let dir = crash_dir();
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join(format!("{}.log", now_ms())), text);
        previous(info);
    }));
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The newest `<ms>.log` in `dir`, unless `seen` already names it.
fn unseen_crash(dir: &Path) -> Option<Crash> {
    let newest = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".log")?.parse::<u64>().ok())
        .max()?;
    let seen = fs::read_to_string(dir.join(SEEN_FILE)).unwrap_or_default();
    if seen.trim() == newest.to_string() {
        return None;
    }
    let text = fs::read_to_string(dir.join(format!("{newest}.log"))).ok()?;
    Some(Crash { at_ms: newest, text })
}

fn mark_seen(dir: &Path) -> Result<(), String> {
    let Some(newest) = unseen_crash(dir) else { return Ok(()) };
    fs::write(dir.join(SEEN_FILE), newest.at_ms.to_string()).map_err(|e| e.to_string())
}

pub fn mark_crash_seen() -> Result<(), String> {
    mark_seen(&crash_dir())
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// The session daemon's log, beside its socket. Only Unix runs the daemon.
fn daemon_log() -> String {
    #[cfg(unix)]
    {
        let socket = lotus_sessiond::client::socket_path(&crate::paths::lotus_state_dir(), unsafe { libc::getuid() });
        if let Some(dir) = socket.parent() {
            return fs::read_to_string(dir.join("sessiond.log")).unwrap_or_default();
        }
    }
    String::new()
}

/// Strips what must never reach a public issue: the home folder (it carries the user's name)
/// and anything shaped like a credential.
pub fn redact(text: &str, home: &str) -> String {
    static TOKENS: OnceLock<regex::Regex> = OnceLock::new();
    let tokens = TOKENS.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(xox[abpr]-[\w-]+|xapp-[\w-]+|sk-[\w-]{8,}|gh[opsu]_\w{8,}|github_pat_\w+|secret_\w{8,}|ntn_\w{8,}|ya29\.[\w.-]+|bearer\s+[\w.~+/-]+=*)",
        )
        .expect("token pattern")
    });
    let text = if home.len() > 1 { text.replace(home, "~") } else { text.to_string() };
    tokens.replace_all(&text, "[redacted]").into_owned()
}

pub fn context(version: String) -> BugReportContext {
    let home = crate::paths::home_dir().to_string_lossy().into_owned();
    let crash = unseen_crash(&crash_dir()).map(|c| Crash { at_ms: c.at_ms, text: redact(&c.text, &home) });
    BugReportContext {
        version,
        os: os_label(),
        arch: std::env::consts::ARCH,
        release: !cfg!(debug_assertions),
        crash,
        log: redact(&tail(&daemon_log(), LOG_LINES), &home),
    }
}

fn os_label() -> String {
    #[cfg(target_os = "macos")]
    {
        let version = std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        return format!("macOS {version}").trim().to_string();
    }
    #[allow(unreachable_code)]
    std::env::consts::OS.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_hides_the_home_folder_and_credentials() {
        let text = "spawn in /Users/alice/work\nslack xoxb-123-abc gh ghp_abcdefgh1234 Authorization: Bearer abc.def=\nsk-ant-api03-xyzxyzxyz";
        let out = redact(text, "/Users/alice");
        assert_eq!(out, "spawn in ~/work\nslack [redacted] gh [redacted] Authorization: [redacted]\n[redacted]");
    }

    #[test]
    fn the_newest_crash_is_unseen_until_marked() {
        let dir = std::env::temp_dir().join(format!("lotus-crash-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(unseen_crash(&dir), None);
        fs::write(dir.join("100.log"), "old").unwrap();
        fs::write(dir.join("200.log"), "new").unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        assert_eq!(unseen_crash(&dir), Some(Crash { at_ms: 200, text: "new".into() }));
        mark_seen(&dir).unwrap();
        assert_eq!(unseen_crash(&dir), None);
        fs::write(dir.join("300.log"), "newer").unwrap();
        assert_eq!(unseen_crash(&dir).map(|c| c.at_ms), Some(300));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tail_keeps_the_last_lines() {
        assert_eq!(tail("a\nb\nc", 2), "b\nc");
        assert_eq!(tail("a", 5), "a");
    }
}
