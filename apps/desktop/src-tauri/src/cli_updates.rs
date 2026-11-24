//! Agent CLI updates — Settings › Updates and the title-bar update pill.
//!
//! Per CLI: read the installed version (`<bin> --version`), the published one (`npm view`), and
//! pick how to update it. The CLI's own updater wins (`claude update`, `codex update`,
//! `cursor-agent update`); otherwise `npm i -g` only when the binary really lives under the npm
//! global prefix. Anything else (Homebrew, unknown) is reported with a command to copy, never
//! guessed. A run is verified by re-reading the version, not trusted on its exit code.
//!
//! Pattern taken from bb (`provider-maintenance-kit.ts`). Plan: `plans/app-updates/PLAN.md`.

use crate::no_window::NoWindow;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

struct Spec {
    id: &'static str,
    name: &'static str,
    bin: &'static str,
    npm_package: Option<&'static str>,
    self_update: Option<Vec<&'static str>>,
}

/// One per agent in `src/agents.json` (`agent_catalog`). An agent without an npm package or an
/// updater Lotus can verify shows its version only.
static SPECS: std::sync::LazyLock<Vec<Spec>> = std::sync::LazyLock::new(|| {
    crate::agent_catalog::AGENTS
        .iter()
        .map(|a| Spec {
            id: a.id.as_str(),
            name: a.product_name.as_str(),
            bin: a.binary(),
            npm_package: a.npm_package.as_deref(),
            self_update: a.self_update.as_ref().map(|args| args.iter().map(String::as_str).collect()),
        })
        .collect()
});

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
const RUN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateState {
    UpToDate,
    UpdateAvailable,
    LatestUnknown,
    UpdateManually,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateStatus {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current: Option<String>,
    pub latest: Option<String>,
    pub state: UpdateState,
    /// "Built-in updater", "npm" or "Homebrew" — what the row says next to the version.
    pub updater: Option<String>,
    /// The exact command Lotus runs, or the one to copy when `state` is `update-manually`.
    pub command: Option<String>,
    /// Whether Lotus can run `command` itself (false for Homebrew / unknown installs).
    pub can_run: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CliUpdateEvent {
    Output { line: String },
    Done { ok: bool, version: Option<String>, message: Option<String> },
}

/// First `x.y.z`-shaped token, with an optional `v` and suffix (`2026.10.01-e373342` included).
pub fn version_from(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|t| t.trim_start_matches('v'))
        .find(|t| {
            let mut parts = t.split(['.', '-', '+']);
            let nums = parts.by_ref().take(3).filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())).count();
            nums == 3
        })
        .map(str::to_string)
}

/// Numeric compare of the dotted core; a pre-release suffix sorts below its release.
pub fn newer(latest: &str, current: &str) -> bool {
    fn key(v: &str) -> (Vec<u64>, bool) {
        let (core, pre) = match v.split_once('-') {
            Some((c, _)) => (c, true),
            None => (v.split('+').next().unwrap_or(v), false),
        };
        (core.split('.').map(|p| p.parse().unwrap_or(0)).collect(), !pre)
    }
    key(latest) > key(current)
}

enum Action {
    SelfUpdate,
    Npm,
    Manual(String, &'static str),
}

/// `path` should be symlink-resolved (see `real_path`): a Homebrew binary is only recognisable by
/// the Cellar it points into, and its own updater refuses to touch it ("update through the package
/// manager"), so Homebrew is checked before the built-in updater.
fn pick_action(spec: &Spec, path: &str, npm_bin: Option<&str>) -> Option<Action> {
    if path.contains("/homebrew/") || path.contains("/Cellar/") {
        return Some(Action::Manual(format!("brew upgrade {}", spec.bin), "Homebrew"));
    }
    if spec.self_update.is_some() {
        return Some(Action::SelfUpdate);
    }
    let pkg = spec.npm_package?;
    if npm_bin.is_some_and(|dir| Path::new(path).starts_with(dir)) {
        return Some(Action::Npm);
    }
    Some(Action::Manual(format!("npm install -g {pkg}@latest"), "npm"))
}

fn real_path(path: &str) -> String {
    std::fs::canonicalize(path).map(|p| p.display().to_string()).unwrap_or_else(|_| path.to_string())
}

fn decide(spec: &Spec, path: String, current: Option<String>, latest: Option<String>, npm_bin: Option<&str>) -> CliUpdateStatus {
    let action = pick_action(spec, &real_path(&path), npm_bin);
    let behind = matches!((&current, &latest), (Some(c), Some(l)) if newer(l, c));
    let (updater, command) = match &action {
        Some(Action::SelfUpdate) => (Some("Built-in updater".to_string()), Some(format!("{} {}", spec.bin, spec.self_update.as_deref().unwrap_or(&[]).join(" ")))),
        Some(Action::Npm) => (Some("npm".to_string()), spec.npm_package.map(|p| format!("npm install -g {p}@latest"))),
        Some(Action::Manual(cmd, via)) => (Some((*via).to_string()), Some(cmd.clone())),
        None => (None, None),
    };
    let can_run = matches!(action, Some(Action::SelfUpdate | Action::Npm));
    let state = match (latest.is_some(), behind) {
        (true, false) => UpdateState::UpToDate,
        (true, true) if can_run => UpdateState::UpdateAvailable,
        (true, true) => UpdateState::UpdateManually,
        (false, _) => UpdateState::LatestUnknown,
    };
    CliUpdateStatus { id: spec.id.into(), name: spec.name.into(), path, current, latest, state, updater, command, can_run }
}

// ── process plumbing ────────────────────────────────────────────────────────────────────────

fn command(program: &str) -> Command {
    let mut cmd = Command::new(program).no_window();
    // Login env first: a dock launch has a minimal PATH, and `npm`/`node` live in the user's shell
    // PATH. The helper also unsets an empty CLAUDE_CONFIG_DIR instead of passing "" through.
    crate::shell_env::apply_login_env_pairs(&mut cmd, crate::shell_env::user_login_env());
    cmd.current_dir(crate::paths::home_dir()).stdin(Stdio::null());
    cmd
}

/// stdout+stderr of a short probe, or `None` on spawn failure / timeout.
fn output(program: &str, args: &[&str]) -> Option<String> {
    let mut child = command(program).args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait().ok()? {
            Some(_) => break,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let mut text = String::new();
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    let _ = child.stderr.take().map(|mut e| e.read_to_string(&mut text));
    Some(text)
}

fn npm_program() -> String {
    crate::cli_detect::find_executable("npm").unwrap_or_else(|| "npm".into())
}

fn npm_global_bin() -> Option<String> {
    let prefix = output(&npm_program(), &["prefix", "-g"])?;
    Some(format!("{}/bin", prefix.lines().find(|l| !l.trim().is_empty())?.trim()))
}

/// Claude follows the user's `autoUpdatesChannel` ("latest" unless set to "stable"): comparing a
/// stable install against `latest` would show an update that `claude update` never installs.
fn npm_latest(spec: &Spec) -> Option<String> {
    let pkg = spec.npm_package?;
    let tags = output(&npm_program(), &["view", pkg, "dist-tags", "--json"])?;
    let tags: serde_json::Value = serde_json::from_str(tags.trim()).ok()?;
    let channel = if spec.id == "claude" { claude_channel() } else { "latest".into() };
    tags.get(&channel).or_else(|| tags.get("latest"))?.as_str().map(str::to_string)
}

fn claude_channel() -> String {
    let path = crate::paths::home_dir().join(".claude/settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("autoUpdatesChannel")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "latest".into())
}

fn current_version(path: &str) -> Option<String> {
    version_from(&output(path, &["--version"])?)
}

/// Every installed known CLI. Probes run in parallel; each failure degrades to `None`.
pub fn status() -> Vec<CliUpdateStatus> {
    let npm_bin = npm_global_bin();
    std::thread::scope(|s| {
        let handles: Vec<_> = SPECS
            .iter()
            .filter_map(|spec| Some((spec, crate::cli_detect::find_executable(spec.bin)?)))
            .map(|(spec, path)| {
                let npm_bin = npm_bin.as_deref();
                s.spawn(move || {
                    let latest = s.spawn(|| npm_latest(spec));
                    let current = current_version(&path);
                    decide(spec, path, current, latest.join().ok().flatten(), npm_bin)
                })
            })
            .collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
}

static RUNNING: Mutex<Option<String>> = Mutex::new(None);

/// Run one CLI's updater, streaming its output, then verify. One run at a time across Lotus.
pub fn run(id: &str, emit: impl Fn(CliUpdateEvent)) -> Result<(), String> {
    let spec = SPECS.iter().find(|s| s.id == id).ok_or_else(|| format!("Unknown CLI: {id}"))?;
    {
        let mut running = RUNNING.lock().map_err(|e| e.to_string())?;
        if let Some(other) = running.as_ref() {
            return Err(format!("An update is already running ({other})."));
        }
        *running = Some(id.to_string());
    }
    let result = run_locked(spec, &emit);
    *RUNNING.lock().unwrap_or_else(|e| e.into_inner()) = None;
    let (ok, version, message) = match result {
        Ok(v) => (true, v, None),
        Err((v, m)) => (false, v, Some(m)),
    };
    emit(CliUpdateEvent::Done { ok, version, message });
    Ok(())
}

type RunResult = Result<Option<String>, (Option<String>, String)>;

fn run_locked(spec: &Spec, emit: &impl Fn(CliUpdateEvent)) -> RunResult {
    let path = crate::cli_detect::find_executable(spec.bin).ok_or((None, format!("{} is not installed.", spec.bin)))?;
    let before = current_version(&path);
    let latest = npm_latest(spec);
    let npm_bin = npm_global_bin();
    let status = decide(spec, path.clone(), before.clone(), latest.clone(), npm_bin.as_deref());
    let (program, args): (String, Vec<String>) = match pick_action(spec, &real_path(&path), npm_bin.as_deref()) {
        Some(Action::SelfUpdate) => (path.clone(), spec.self_update.as_deref().unwrap_or(&[]).iter().map(|s| s.to_string()).collect()),
        Some(Action::Npm) => (npm_program(), vec!["install".into(), "-g".into(), format!("{}@latest", spec.npm_package.unwrap_or_default())]),
        _ => return Err((before, format!("Update {} in a terminal: {}", spec.name, status.command.unwrap_or_default()))),
    };
    emit(CliUpdateEvent::Output { line: format!("$ {}", status.command.unwrap_or_default()) });

    let mut child = command(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| (before.clone(), format!("Could not start {program}: {e}")))?;
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx_err = tx.clone();
    let err_reader = std::thread::spawn(move || {
        if let Some(e) = stderr {
            BufReader::new(e).lines().map_while(Result::ok).for_each(|l| { let _ = tx_err.send(l); });
        }
    });
    let stdout = child.stdout.take();
    let out_reader = std::thread::spawn(move || {
        if let Some(o) = stdout {
            BufReader::new(o).lines().map_while(Result::ok).for_each(|l| { let _ = tx.send(l); });
        }
    });
    let deadline = Instant::now() + RUN_TIMEOUT;
    let exit = loop {
        while let Ok(line) = rx.try_recv() {
            emit(CliUpdateEvent::Output { line });
        }
        match child.try_wait() {
            Ok(Some(code)) => break Some(code),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break None,
        }
    };
    let _ = (out_reader.join(), err_reader.join());
    while let Ok(line) = rx.try_recv() {
        emit(CliUpdateEvent::Output { line });
    }

    let after = current_version(&path);
    match exit {
        None => Err((after, "The updater did not finish within 10 minutes.".into())),
        Some(code) if !code.success() => Err((after, format!("The updater exited with {code}."))),
        Some(_) => verify(latest, after),
    }
}

/// Exit 0 is not enough: the version must reach `latest`, or at least change when latest is unknown.
fn verify(latest: Option<String>, after: Option<String>) -> RunResult {
    match (&latest, &after) {
        (Some(l), Some(a)) if !newer(l, a) => Ok(after),
        // Latest unknown (Cursor): a changed version is an update, an unchanged one means the
        // updater found nothing newer. Either way exit 0 with a readable version is success.
        (None, Some(_)) => Ok(after),
        _ => Err((after.clone(), format!("The updater finished, but the version is still {}.", after.as_deref().unwrap_or("unknown")))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> &'static Spec {
        SPECS.iter().find(|s| s.id == id).unwrap()
    }

    #[test]
    fn reads_versions_from_real_cli_output() {
        assert_eq!(version_from("2.1.319 (Claude Code)").as_deref(), Some("2.1.319"));
        assert_eq!(version_from("codex-cli 0.166.0").as_deref(), Some("0.166.0"));
        assert_eq!(version_from("2026.10.01-e373342").as_deref(), Some("2026.10.01-e373342"));
        assert_eq!(version_from("v1.4.0\n").as_deref(), Some("1.4.0"));
        assert_eq!(version_from("no version here 1.2"), None);
    }

    #[test]
    fn compares_numerically_and_ranks_prereleases_lower() {
        assert!(newer("0.167.0", "0.166.0"));
        assert!(newer("2.1.10", "2.1.9"));
        assert!(!newer("2.1.319", "2.1.319"));
        assert!(newer("1.0.0", "1.0.0-beta.1"));
        assert!(!newer("2.1.311", "2.1.319"));
    }

    #[test]
    fn built_in_updater_wins_over_npm() {
        let s = decide(spec("codex"), "/Users/a/.local/bin/codex".into(), Some("0.166.0".into()), Some("0.167.0".into()), Some("/opt/npm/bin"));
        assert_eq!(s.state, UpdateState::UpdateAvailable);
        assert_eq!(s.updater.as_deref(), Some("Built-in updater"));
        assert_eq!(s.command.as_deref(), Some("codex update"));
    }

    #[test]
    fn cursor_without_a_published_version_still_offers_its_updater() {
        let s = decide(spec("cursor"), "/x/cursor-agent".into(), Some("2026.10.01-e373342".into()), None, None);
        assert_eq!(s.state, UpdateState::LatestUnknown);
        assert_eq!(s.command.as_deref(), Some("cursor-agent update"));
    }

    #[test]
    fn npm_only_when_the_binary_lives_under_the_npm_prefix() {
        let npm = decide(spec("gemini"), "/opt/npm/bin/gemini".into(), Some("0.18.0".into()), Some("0.19.2".into()), Some("/opt/npm/bin"));
        assert_eq!(npm.state, UpdateState::UpdateAvailable);
        assert_eq!(npm.updater.as_deref(), Some("npm"));

        let brew = decide(spec("gemini"), "/opt/homebrew/bin/gemini".into(), Some("0.18.0".into()), Some("0.19.2".into()), Some("/opt/npm/bin"));
        assert_eq!(brew.state, UpdateState::UpdateManually);
        assert_eq!(brew.command.as_deref(), Some("brew upgrade gemini"));
        assert!(!brew.can_run);

        let brew_codex = decide(spec("codex"), "/opt/homebrew/Cellar/codex/0.166.0/bin/codex".into(), Some("0.166.0".into()), Some("0.167.0".into()), None);
        assert_eq!(brew_codex.state, UpdateState::UpdateManually);
        assert_eq!(brew_codex.command.as_deref(), Some("brew upgrade codex"));
    }

    #[test]
    fn up_to_date_when_current_matches_latest() {
        let s = decide(spec("claude"), "/x/claude".into(), Some("2.1.319".into()), Some("2.1.319".into()), None);
        assert_eq!(s.state, UpdateState::UpToDate);
    }

    #[test]
    fn verification_rejects_an_unchanged_version_below_latest() {
        assert!(verify(Some("0.167.0".into()), Some("0.167.0".into())).is_ok());
        assert!(verify(Some("0.167.0".into()), Some("0.166.0".into())).is_err());
        assert!(verify(None, Some("1.0.1".into())).is_ok());
        assert!(verify(Some("1.1.0".into()), None).is_err());
    }
}
