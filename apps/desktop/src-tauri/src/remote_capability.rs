//! Per-target SSH capability cache.
//!
//! The first time an SSH workspace is opened, the frontend calls
//! `ssh_probe_workspace`. This fires a single SSH round-trip that detects
//! which tools and `stat` variants are available on the remote. The results
//! are stored here so subsequent commands can tailor their scripts
//! (e.g. omitting the GNU/BSD `stat` fallback, or using `fd` instead of
//! `find`). A profile is reused by `probe_workspace` for [`PROBE_TTL`], then
//! asked again — long enough that reopening ⌘K costs nothing, short enough that
//! a CLI installed on the machine a few minutes ago shows up without a restart.
//!
//! The probe uses the [`RemoteTransport`] master connection, so it costs
//! ~30 ms (mux socket reuse) rather than ~500 ms (fresh handshake).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cli_tools::{login_shell_script, run_ssh_shell_command, SshCommandMode, SshToolTarget};
use crate::error::AppError;
use crate::remote_transport::RemoteTransport;

// ── Capability types ──────────────────────────────────────────────────────────

/// Which `stat` argument style the remote shell supports.
///
/// - `Gnu` — `stat -c '%Y' FILE` (Linux, most VPS targets).
/// - `Bsd` — `stat -f '%m' FILE` (macOS, some BSDs).
///
/// Both output epoch seconds. The probe detects this once so read/write
/// scripts can avoid the `|| fallback` branch on every call.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum StatVariant {
    #[default]
    Gnu,
    Bsd,
}

/// An agent runner found on the machine, with whatever version it reported.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRunner {
    /// The executable as it is spelled on PATH: `claude`, `codex`, `cursor-agent`, `ccs`.
    pub id: String,
    /// First line of `--version`, when it answered. Absent is not a fault; it is just unknown.
    pub version: Option<String>,
}

/// Capabilities detected on the remote at workspace-open time.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilityProfile {
    pub stat_variant: StatVariant,
    /// `fd` (fast alternative to `find`) is available on the remote PATH.
    pub has_fd: bool,
    /// `rg` (ripgrep) is available on the remote PATH.
    pub has_rg: bool,
    /// Which agent runners this machine can actually start.
    ///
    /// Empty means none were found — never "we did not look". A machine that cannot answer the
    /// probe at all returns an error instead, so an empty list is a fact rather than a silence.
    pub runners: Vec<RemoteRunner>,
    /// The machine answers `GET /v1/health` on the Standalone Host's default port.
    pub has_lotus_host: bool,
}

// ── Key ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CapabilityKey {
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

impl From<&SshToolTarget> for CapabilityKey {
    fn from(t: &SshToolTarget) -> Self {
        CapabilityKey {
            host: t.host.trim().to_ascii_lowercase(),
            user: t
                .user
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(str::to_ascii_lowercase),
            port: t.port,
        }
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/// How long a probe's answer is reused before the machine is asked again.
pub(crate) const PROBE_TTL: Duration = Duration::from_secs(5 * 60);

struct CachedProfile {
    profile: RemoteCapabilityProfile,
    probed_at: Instant,
}

pub struct RemoteCapabilityStore {
    profiles: Mutex<HashMap<CapabilityKey, CachedProfile>>,
}

impl RemoteCapabilityStore {
    pub fn new() -> Self {
        RemoteCapabilityStore {
            profiles: Mutex::new(HashMap::new()),
        }
    }

    /// Return the cached profile for `target`, if one exists, however old.
    ///
    /// For facts that do not drift (the `stat` variant); `fresh` is the one that answers "what is
    /// installed there now".
    pub fn get(&self, target: &SshToolTarget) -> Option<RemoteCapabilityProfile> {
        let key = CapabilityKey::from(target);
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .map(|cached| cached.profile.clone())
    }

    /// The cached profile for `target`, only if it was probed within [`PROBE_TTL`].
    pub(crate) fn fresh(&self, target: &SshToolTarget) -> Option<RemoteCapabilityProfile> {
        let key = CapabilityKey::from(target);
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .filter(|cached| cached.probed_at.elapsed() < PROBE_TTL)
            .map(|cached| cached.profile.clone())
    }

    pub(crate) fn insert(&self, target: &SshToolTarget, profile: RemoteCapabilityProfile) {
        self.insert_at(target, profile, Instant::now());
    }

    fn insert_at(
        &self,
        target: &SshToolTarget,
        profile: RemoteCapabilityProfile,
        probed_at: Instant,
    ) {
        let key = CapabilityKey::from(target);
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, CachedProfile { profile, probed_at });
    }

    /// Drop every cached profile.
    ///
    /// Called when the runner registry changes, because a profile answers "which runners does this
    /// machine have" and that question's *vocabulary* just moved: a custom runner added after a
    /// probe is a runner the cached answer was never asked about, and it would stay missing from
    /// ⌘K on every remote project until the app restarted. Evicting the whole map rather than one
    /// target is right here — the registry is global, so every cached answer is equally stale.
    pub fn evict_all(&self) {
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// Drop the cached profile for `target`. The next `probe_workspace` call
    /// will re-detect capabilities from scratch.
    pub fn evict(&self, target: &SshToolTarget) {
        let key = CapabilityKey::from(target);
        self.profiles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key);
    }
}

// ── Probe script + parser ─────────────────────────────────────────────────────

/// How the probe finds a Standalone Host, and why it does not ask a fixed port.
///
/// **This used to curl `127.0.0.1:8787/v1/health` and it was wrong twice over**, measured against
/// devbox-vps on 2026-09-17: that machine's host was listening on **45477**, and `/v1/health`
/// answers **401** without a bearer anyway. So the probe reported "no host" on the one machine the
/// feature was written for — the failure was silent, because "no host" is a perfectly ordinary
/// answer and nothing looks wrong when you get it.
///
/// 8787 is only the *client's* fallback in `packages/host/src/core/config.ts`; the host binds
/// whatever it got and writes the real port and key to its discovery file. So that file is what
/// gets read, and the call that proves the host is alive is an authenticated one.
const LOTUS_HOST_PROBE: &str = concat!(
    "_lh=\"\"; ",
    "for _f in \"$HOME/.lotus/lotus-mcp-ipc.json\" \"$HOME/.lotus-dev/lotus-mcp-ipc.json\"; do ",
    "[ -r \"$_f\" ] && _lh=\"$_f\" && break; done; ",
    "_lp=$(sed -n 's/.*\"port\"[ ]*:[ ]*\\([0-9][0-9]*\\).*/\\1/p' \"$_lh\" 2>/dev/null | head -n 1); ",
    "_ls=$(sed -n 's/.*\"secret\"[ ]*:[ ]*\"\\([^\"]*\\)\".*/\\1/p' \"$_lh\" 2>/dev/null | head -n 1); ",
    "if [ -n \"$_lp\" ] && [ -n \"$_ls\" ] && command -v curl >/dev/null 2>&1 && ",
    "curl -sf -m 2 -o /dev/null -X POST \"http://127.0.0.1:$_lp/v1/list-fleet\" ",
    "-H \"Authorization: Bearer $_ls\" -H 'Content-Type: application/json' -d '{}'; ",
    "then echo HOST=1; else echo HOST=0; fi\n",
);

/// Runners that are not CLIs in their own right, so `cli_detect` does not list them.
///
/// `ccs` and `csp` are profile wrappers around `claude` — separate executables, and a machine may
/// have one without the other.
const RUNNER_WRAPPERS: &[&str] = &["ccs", "csp"];

/// How many runners one probe will ask about.
///
/// Every runner costs a `command -v` **and** a `--version` on the far side, so the list is not
/// free: a registry with fifty custom runners would turn a ~30 ms probe into a visible stall on
/// every project open. Twenty-four is far above any real registry here (ten at the time of writing)
/// and still bounds the worst case.
const MAX_PROBED_RUNNERS: usize = 24;

/// Every runner this desktop could try to launch, spelled as it appears on PATH.
///
/// **This used to be a hardcoded list of five, and that is the bug it was rewritten to end.** It
/// knew `claude`, `codex`, `cursor-agent`, `ccs` and `csp`, while `cli_detect` had grown to know
/// `opencode`, `grok`, `gemini`, `droid` and `copilot`, and the runner registry knows whatever the
/// operator typed. A runner the probe never asks about is simply absent from `runners` — and
/// `clisOnMachine` (`machine-runners.ts`) reads absent as *not installed on that machine*. So
/// `opencode` was unlaunchable from ⌘K on every remote project whether or not it was installed
/// there, and the menu gave no hint that it had never looked.
///
/// Derived rather than duplicated for that reason. Three sources, because they answer three
/// different questions: the CLIs Lotus knows how to drive, the wrappers that are not CLIs, and the
/// commands the operator defined themselves.
pub(crate) fn probed_runners() -> Vec<String> {
    let known = crate::cli_detect::known_cli_binaries()
        .into_iter()
        .map(str::to_string);
    let wrappers = RUNNER_WRAPPERS.iter().map(|wrapper| (*wrapper).to_string());

    let mut out: Vec<String> = Vec::new();
    for name in known.chain(wrappers) {
        let Some(name) = shell_safe_runner(&name) else {
            continue;
        };
        if !out.contains(&name) {
            out.push(name);
        }
        if out.len() >= MAX_PROBED_RUNNERS {
            break;
        }
    }
    out
}

/// A runner name safe to interpolate into the probe script, or `None`.
///
/// The custom-runner half of `probed_runners` comes from a file the operator edits by hand, and the
/// result is pasted straight into a shell script that runs over SSH. Allow-list rather than escape:
/// a real executable name is plain, and a name carrying a quote, a space or a `$` is not worth
/// supporting at the price of getting shell quoting right.
fn shell_safe_runner(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 {
        return None;
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return None;
    }
    Some(name.to_string())
}

pub(crate) fn build_probe_script() -> String {
    build_probe_script_for(&probed_runners())
}

/// The script itself, over an explicit runner list — pure, so a test can read what will run without
/// depending on which CLIs happen to be installed on the machine running the test.
pub(crate) fn build_probe_script_for(runners: &[String]) -> String {
    // One-liner per detection — no `set -eu` so a missing tool never aborts.
    // Each line emits exactly one record to stdout; unknown lines are ignored by the parser, which
    // matters because this runs under an interactive shell that may greet.
    let mut script = String::from(concat!(
        "if stat -c '%Y' /dev/null >/dev/null 2>&1; then echo STAT=gnu; else echo STAT=bsd; fi\n",
        "command -v fd >/dev/null 2>&1 && echo HAS_FD=1 || echo HAS_FD=0\n",
        "command -v rg >/dev/null 2>&1 && echo HAS_RG=1 || echo HAS_RG=0\n",
    ));
    for runner in runners {
        // Version on the same round trip: a second one per runner would cost more than the answer.
        script.push_str(&format!(
            "if command -v {runner} >/dev/null 2>&1; then printf 'RUNNER\\t{runner}\\t%s\\n' \"$({runner} --version 2>/dev/null | sed -n '1p' | tr -d '\\r')\"; fi\n"
        ));
    }
    script.push_str(LOTUS_HOST_PROBE);
    script
}

pub(crate) fn parse_probe_output(stdout: &str) -> RemoteCapabilityProfile {
    let mut profile = RemoteCapabilityProfile::default();
    for line in stdout.lines() {
        if let Some(rest) = line.trim_end().strip_prefix("RUNNER\t") {
            let mut parts = rest.splitn(2, '\t');
            let Some(id) = parts.next().map(str::trim).filter(|id| !id.is_empty()) else {
                continue;
            };
            let version = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            if !profile.runners.iter().any(|runner| runner.id == id) {
                profile.runners.push(RemoteRunner {
                    id: id.to_string(),
                    version,
                });
            }
            continue;
        }
        match line.trim() {
            "STAT=bsd" => profile.stat_variant = StatVariant::Bsd,
            "STAT=gnu" => profile.stat_variant = StatVariant::Gnu,
            "HAS_FD=1" => profile.has_fd = true,
            "HAS_RG=1" => profile.has_rg = true,
            "HOST=1" => profile.has_lotus_host = true,
            _ => {}
        }
    }
    profile
}

// ── Public domain function ────────────────────────────────────────────────────

/// Answer from the cache when it is fresh; otherwise run the probe script on `target`, cache the
/// result, and return it.
///
/// Uses the `RemoteTransport` master socket so the handshake is amortized.
/// On failure, returns an error rather than caching a partial result.
pub fn probe_workspace(
    target: SshToolTarget,
    transport: &RemoteTransport,
    store: &RemoteCapabilityStore,
) -> Result<RemoteCapabilityProfile, AppError> {
    if let Some(profile) = store.fresh(&target) {
        return Ok(profile);
    }
    // Through the operator's login shell, or every runner installed by its own installer reports as
    // missing — see `login_shell_script`.
    let script = login_shell_script(&build_probe_script());
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, Some(transport))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!(
            "SSH workspace probe failed: {}",
            stderr.trim()
        )));
    }
    let profile = parse_probe_output(&String::from_utf8_lossy(&output.stdout));
    store.insert(&target, profile.clone());
    Ok(profile)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason this whole ticket exists: a non-login probe reports present runners as missing.
    #[test]
    fn the_probe_runs_through_the_operators_login_shell() {
        let script = crate::cli_tools::login_shell_script(&build_probe_script());
        assert!(
            script.starts_with("exec ${SHELL:-bash} -lic "),
            "-lc is not enough: zsh reads .zprofile when it is a login shell, and a runner's own \
             installer puts it on a PATH that only .zshrc sets (measured 2026-09-15)"
        );
        assert!(script.contains("command -v"));
    }

    #[test]
    fn the_probe_asks_about_every_runner_in_one_round_trip() {
        let runners = probed_runners();
        let script = build_probe_script_for(&runners);
        for runner in &runners {
            assert!(
                script.contains(&format!("command -v {runner} ")),
                "{runner} is never asked about"
            );
        }
        assert!(
            script.contains("lotus-mcp-ipc.json"),
            "the Lotus Host check rides along, and finds the port rather than guessing it"
        );
    }

    /// The regression this list was rewritten for.
    ///
    /// Every CLI `cli_detect` can find on THIS machine has to be askable on the other one, or
    /// `clisOnMachine` filters it out of ⌘K as "not installed over there" — a sentence the probe
    /// never actually checked. Asserted against `cli_detect` itself rather than a copied list,
    /// because a copied list is what broke.
    #[test]
    fn every_cli_lotus_can_detect_is_also_asked_about_remotely() {
        let probed = probed_runners();
        for binary in crate::cli_detect::known_cli_binaries() {
            assert!(
                probed.iter().any(|runner| runner == binary),
                "{binary} is detected locally but never probed remotely — it can only ever \
                 disappear from the launch menu on a remote project"
            );
        }
        for wrapper in RUNNER_WRAPPERS {
            assert!(probed.iter().any(|runner| runner == wrapper), "{wrapper}");
        }
    }

    /// A runner name is pasted into a shell script that runs over SSH, and half the list comes from
    /// a file the operator edits by hand.
    #[test]
    fn a_runner_name_that_could_break_out_of_the_script_is_dropped() {
        assert_eq!(shell_safe_runner("cursor-agent").as_deref(), Some("cursor-agent"));
        assert_eq!(shell_safe_runner("claude_2.0").as_deref(), Some("claude_2.0"));
        assert_eq!(shell_safe_runner(""), None);
        assert_eq!(shell_safe_runner("rm -rf /"), None);
        assert_eq!(shell_safe_runner("$(whoami)"), None);
        assert_eq!(shell_safe_runner("a; echo pwned"), None);
        assert_eq!(shell_safe_runner(&"x".repeat(65)), None);
    }

    /// The probe is one round trip, and its cost grows with the registry.
    #[test]
    fn the_runner_list_is_bounded() {
        assert!(probed_runners().len() <= MAX_PROBED_RUNNERS);
    }

    /// The bug this probe used to have, pinned by running it.
    ///
    /// It asked `127.0.0.1:8787/v1/health` unauthenticated. On devbox-vps (measured 2026-09-17) the
    /// host was on **45477** and `/v1/health` answers **401** anyway, so the probe said "no host" on
    /// the very machine the feature exists for — and said it in the same voice as the true answer,
    /// which is why nobody noticed.
    #[test]
    fn a_host_on_a_port_nobody_could_guess_is_still_found() {
        let dir = tempfile::tempdir().expect("temp dir");
        let home = dir.path();
        std::fs::create_dir_all(home.join(".lotus")).expect("lotus dir");
        std::fs::write(
            home.join(".lotus/lotus-mcp-ipc.json"),
            "{\n  \"port\": 45477,\n  \"secret\": \"k3y\"\n}",
        )
        .expect("discovery");

        // A `curl` that succeeds only when it was called with the discovered port and bearer.
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).expect("bin");
        std::fs::write(
            bin.join("curl"),
            "#!/bin/sh\ncase \"$*\" in *45477/v1/list-fleet*Bearer\\ k3y*) exit 0 ;; *) exit 22 ;; esac\n",
        )
        .expect("fake curl");
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(bin.join("curl")).expect("meta").permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(bin.join("curl"), perms).expect("chmod");
        }

        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(LOTUS_HOST_PROBE)
            .env("HOME", home)
            .env("PATH", format!("{}:{}", bin.display(), crate::cli_tools::TEST_PATH))
            .output()
            .expect("run probe");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("HOST=1"), "probe said: {stdout}");
        assert!(parse_probe_output(&stdout).has_lotus_host);
    }

    /// And the ordinary case stays ordinary: most machines run no host, and must say so.
    #[test]
    fn a_machine_with_no_discovery_file_reports_no_host() {
        let dir = tempfile::tempdir().expect("temp dir");
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(LOTUS_HOST_PROBE)
            .env("HOME", dir.path())
            .env("PATH", crate::cli_tools::TEST_PATH)
            .output()
            .expect("run probe");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("HOST=0"), "probe said: {stdout}");
        assert!(!parse_probe_output(&stdout).has_lotus_host);
    }

    #[test]
    fn a_runner_is_reported_with_the_version_it_gave() {
        let profile = parse_probe_output("STAT=gnu\nRUNNER\tclaude\t2.1.4\nRUNNER\tcodex\t\n");
        assert_eq!(profile.runners.len(), 2);
        assert_eq!(profile.runners[0].id, "claude");
        assert_eq!(profile.runners[0].version.as_deref(), Some("2.1.4"));
        assert_eq!(profile.runners[1].id, "codex");
        assert_eq!(
            profile.runners[1].version, None,
            "a runner that would not say its version is still a runner"
        );
    }

    /// An interactive shell may greet, print a motd, or emit a prompt escape. None of that is a
    /// runner, and none of it may knock the real records out of the list.
    #[test]
    fn chatter_from_an_interactive_shell_is_ignored() {
        let profile = parse_probe_output(
            "Welcome to Ubuntu 24.04\n\x1b[1mzsh: no job control\nSTAT=gnu\nRUNNER\tclaude\t2.1.4\nHOST=0\n",
        );
        assert_eq!(profile.runners.len(), 1);
        assert_eq!(profile.stat_variant, StatVariant::Gnu);
        assert!(!profile.has_lotus_host);
    }

    #[test]
    fn a_machine_with_no_runners_says_so_rather_than_saying_nothing() {
        let profile = parse_probe_output("STAT=gnu\nHAS_FD=0\nHAS_RG=0\nHOST=0\n");
        assert!(profile.runners.is_empty());
    }

    #[test]
    fn a_runner_named_twice_is_listed_once() {
        let profile = parse_probe_output("RUNNER\tclaude\t2.1.4\nRUNNER\tclaude\t9.9.9\n");
        assert_eq!(profile.runners.len(), 1);
        assert_eq!(profile.runners[0].version.as_deref(), Some("2.1.4"));
    }

    #[test]
    fn a_machine_running_the_standalone_host_is_recognised() {
        assert!(parse_probe_output("HOST=1\n").has_lotus_host);
        assert!(!parse_probe_output("HOST=0\n").has_lotus_host);
        assert!(
            !parse_probe_output("STAT=gnu\n").has_lotus_host,
            "no answer is not a yes"
        );
    }

    #[test]
    fn parse_gnu_stat_and_tools() {
        let out = "STAT=gnu\nHAS_FD=1\nHAS_RG=1\n";
        let p = parse_probe_output(out);
        assert_eq!(p.stat_variant, StatVariant::Gnu);
        assert!(p.has_fd);
        assert!(p.has_rg);
    }

    #[test]
    fn parse_bsd_stat_without_tools() {
        let out = "STAT=bsd\nHAS_FD=0\nHAS_RG=0\n";
        let p = parse_probe_output(out);
        assert_eq!(p.stat_variant, StatVariant::Bsd);
        assert!(!p.has_fd);
        assert!(!p.has_rg);
    }

    #[test]
    fn parse_defaults_to_gnu_when_stat_line_absent() {
        let p = parse_probe_output("HAS_FD=0\nHAS_RG=0\n");
        assert_eq!(p.stat_variant, StatVariant::Gnu);
    }

    #[test]
    fn parse_ignores_unknown_lines() {
        let out = "UNKNOWN=stuff\nSTAT=bsd\nHAS_FD=0\nHAS_RG=0\n";
        let p = parse_probe_output(out);
        assert_eq!(p.stat_variant, StatVariant::Bsd);
    }

    #[test]
    fn parse_empty_output_returns_default_profile() {
        let p = parse_probe_output("");
        assert_eq!(p, RemoteCapabilityProfile::default());
    }

    #[test]
    fn probe_script_detects_stat_variant() {
        let s = build_probe_script();
        assert!(s.contains("stat -c '%Y'"), "GNU stat probe");
        assert!(s.contains("STAT=gnu"));
        assert!(s.contains("STAT=bsd"));
    }

    #[test]
    fn probe_script_detects_fd_and_rg() {
        let s = build_probe_script();
        assert!(s.contains("command -v fd"));
        assert!(s.contains("command -v rg"));
        assert!(s.contains("HAS_FD=1"));
        assert!(s.contains("HAS_RG=1"));
    }

    /// No `ssh` on PATH: any probe that reaches for the machine fails, so success proves it did not.
    #[cfg(unix)]
    struct NoSsh {
        _dir: tempfile::TempDir,
        original_path: Option<std::ffi::OsString>,
    }

    #[cfg(unix)]
    impl NoSsh {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let original_path = std::env::var_os("PATH");
            std::env::set_var("PATH", dir.path());
            Self {
                _dir: dir,
                original_path,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for NoSsh {
        fn drop(&mut self) {
            match &self.original_path {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    /// ⌘K asks on every project open; the answer it got a minute ago is still the answer.
    #[cfg(unix)]
    #[test]
    fn a_recent_answer_is_reused_without_asking_the_machine_again() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _no_ssh = NoSsh::new();
        let store = RemoteCapabilityStore::new();
        let t = SshToolTarget {
            host: "lotus-test-cached".into(),
            user: None,
            port: None,
        };
        let profile = RemoteCapabilityProfile {
            has_rg: true,
            ..Default::default()
        };
        store.insert(&t, profile.clone());
        let answer = probe_workspace(t, &RemoteTransport::new(), &store).unwrap();
        assert_eq!(answer, profile);
    }

    /// A runner installed on the machine after the last probe must not stay hidden until restart.
    #[cfg(unix)]
    #[test]
    fn an_old_answer_sends_the_probe_back_to_the_machine() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _no_ssh = NoSsh::new();
        let store = RemoteCapabilityStore::new();
        let t = SshToolTarget {
            host: "lotus-test-stale".into(),
            user: None,
            port: None,
        };
        let long_ago = Instant::now() - PROBE_TTL - Duration::from_secs(1);
        store.insert_at(&t, RemoteCapabilityProfile::default(), long_ago);
        assert!(probe_workspace(t.clone(), &RemoteTransport::new(), &store).is_err());
        assert_eq!(store.get(&t), Some(RemoteCapabilityProfile::default()));
    }

    #[test]
    fn store_get_returns_none_before_insert() {
        let store = RemoteCapabilityStore::new();
        let t = SshToolTarget {
            host: "host".into(),
            user: None,
            port: None,
        };
        assert!(store.get(&t).is_none());
    }

    #[test]
    fn store_get_returns_inserted_profile() {
        let store = RemoteCapabilityStore::new();
        let t = SshToolTarget {
            host: "host".into(),
            user: None,
            port: None,
        };
        let profile = RemoteCapabilityProfile {
            stat_variant: StatVariant::Bsd,
            has_fd: true,
            has_rg: false,
            ..Default::default()
        };
        store.insert(&t, profile.clone());
        assert_eq!(store.get(&t), Some(profile));
    }

    #[test]
    fn store_evict_clears_cached_profile() {
        let store = RemoteCapabilityStore::new();
        let t = SshToolTarget {
            host: "host".into(),
            user: None,
            port: None,
        };
        store.insert(&t, RemoteCapabilityProfile::default());
        store.evict(&t);
        assert!(store.get(&t).is_none());
    }

    #[test]
    fn store_profiles_are_isolated_per_target() {
        let store = RemoteCapabilityStore::new();
        let t1 = SshToolTarget {
            host: "host-a".into(),
            user: None,
            port: None,
        };
        let t2 = SshToolTarget {
            host: "host-b".into(),
            user: None,
            port: None,
        };
        store.insert(
            &t1,
            RemoteCapabilityProfile {
                stat_variant: StatVariant::Gnu,
                has_fd: true,
                has_rg: false,
                ..Default::default()
            },
        );
        assert!(store.get(&t2).is_none());
    }

    #[test]
    fn key_normalises_host_to_lowercase_and_trims_whitespace() {
        let store = RemoteCapabilityStore::new();
        let t1 = SshToolTarget {
            host: "  MyHost  ".into(),
            user: Some("  Alwi  ".into()),
            port: Some(22),
        };
        let t2 = SshToolTarget {
            host: "myhost".into(),
            user: Some("alwi".into()),
            port: Some(22),
        };
        let profile = RemoteCapabilityProfile {
            stat_variant: StatVariant::Bsd,
            ..Default::default()
        };
        store.insert(&t1, profile.clone());
        assert_eq!(store.get(&t2), Some(profile));
    }
}
