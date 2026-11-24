//! Explicit check trials: a pinned detached worktree, never an agent or a PR run.
use crate::no_window::NoWindow;
use super::check_trial_process::{cancelled, run};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

pub const TRIAL_TIMEOUT: Duration = Duration::from_secs(40 * 60);
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialPreview {
    pub id: String,
    pub repo: String,
    pub checkout: String,
    pub base: String,
    pub revision: String,
    pub command: String,
    pub shell: bool,
    pub worktree: String,
    pub timeout_seconds: u64,
}
#[derive(Clone)]
pub struct TrialPlan {
    pub preview: TrialPreview,
    pub(super) root: PathBuf,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrialStatus {
    Running,
    Passed,
    Failed,
    Cancelled,
    TimedOut,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialResult {
    pub status: TrialStatus,
    pub exit_code: Option<i32>,
    pub message: String,
}
impl TrialResult {
    pub(super) fn failed(message: &str) -> Self {
        Self {
            status: TrialStatus::Failed,
            exit_code: None,
            message: message.into(),
        }
    }
}

// No fetch, hooks, fsmonitor or raw git error output. Preview only inspects cached local refs.
async fn git(
    checkout: &Path,
    args: &[&str],
    env: &HashMap<String, String>,
    cancel: Option<watch::Receiver<bool>>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new("git").no_window();
    command
        .arg("-C")
        .arg(checkout)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .envs(env)
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
    ] {
        command.env_remove(key);
    }
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|_| "Cannot start git for the check trial")?;
    let group = super::runner::KillGroup(child.id());
    let mut cancel = cancel.unwrap_or_else(|| watch::channel(false).1);
    let result = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => Err("Check trial cancelled".into()),
        out = child.wait_with_output() => out.map_err(|_| "Cannot read git result for check trial".into()),
        _ = tokio::time::sleep(Duration::from_secs(15)) => Err("Git operation for check trial timed out".into()),
    };
    group.kill();
    result
}
pub async fn shell_mode(
    checkout: &Path,
    base: &str,
    env: &HashMap<String, String>,
) -> Result<bool, String> {
    match std::fs::symlink_metadata(checkout.join(super::FACTORY_FILE)) {
        Ok(_) => return Ok(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Cannot determine Factory check execution mode".into()),
    }
    let sha = revision(checkout, base, env).await?;
    let out = git(
        checkout,
        &["ls-tree", "--name-only", &sha, "--", super::FACTORY_FILE],
        env,
        None,
    )
    .await?;
    if !out.status.success() {
        return Err("Cannot determine Factory check execution mode".into());
    }
    Ok(out.stdout.is_empty())
}
pub async fn revision(
    checkout: &Path,
    base: &str,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    let reference = format!("refs/remotes/origin/{base}^{{commit}}");
    let out = git(checkout, &["rev-parse", "--verify", &reference], env, None).await?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success()
        || ![40, 64].contains(&sha.len())
        || !sha.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("The cached origin base revision is unavailable. Refresh the repository before trying checks.".into());
    }
    Ok(sha)
}
pub async fn prepare(
    checkout: &Path,
    repo: &str,
    base: &str,
    command: &str,
    shell: bool,
    root: &Path,
    env: &HashMap<String, String>,
) -> Result<TrialPlan, String> {
    if !cfg!(unix) {
        return Err("Try checks currently requires macOS or Linux process-group support".into());
    }
    let command = super::settings::validate_gate(command)?.to_string();
    if !shell
        && (Path::new(&command).is_absolute()
            || !Path::new(&command)
                .components()
                .all(|c| matches!(c, Component::Normal(_))))
    {
        return Err("Use a repository-relative check script path without parent traversal".into());
    }
    if base.is_empty()
        || base.len() > 255
        || base.starts_with('-')
        || !git(checkout, &["check-ref-format", "--branch", base], env, None)
            .await?
            .status
            .success()
    {
        return Err("Choose a valid origin base branch before trying checks".into());
    }
    let checkout =
        std::fs::canonicalize(checkout).map_err(|_| "Repository checkout is unavailable")?;
    let top = git(&checkout, &["rev-parse", "--show-toplevel"], env, None).await?;
    let top = String::from_utf8_lossy(&top.stdout);
    if std::fs::canonicalize(top.trim_end_matches(['\r', '\n']))
        .ok()
        .as_ref()
        != Some(&checkout)
    {
        return Err(
            "Open the repository root, rather than a nested module directory, before trying checks"
                .into(),
        );
    }
    let revision = revision(&checkout, base, env).await?;
    let id = uuid::Uuid::new_v4().to_string();
    super::settings::checked_path(root, &root.join(&id))?;
    let ancestor = root
        .ancestors()
        .find(|path| path.exists())
        .ok_or("Check trial storage is unavailable")?;
    let root = std::fs::canonicalize(ancestor)
        .map_err(|_| "Check trial storage is unavailable")?
        .join(
            root.strip_prefix(ancestor)
                .map_err(|_| "Invalid check trial storage")?,
        );
    let worktree = root.join(&id);
    Ok(TrialPlan {
        preview: TrialPreview {
            id,
            repo: repo.into(),
            checkout: checkout.to_string_lossy().into_owned(),
            base: base.into(),
            revision,
            command,
            shell,
            worktree: worktree.to_string_lossy().into_owned(),
            timeout_seconds: TRIAL_TIMEOUT.as_secs(),
        },
        root,
    })
}

pub async fn execute(
    plan: &TrialPlan,
    env: &HashMap<String, String>,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
    output: Arc<Mutex<Vec<u8>>>,
) -> TrialResult {
    let p = &plan.preview;
    if *cancel.borrow() {
        return TrialResult {
            status: TrialStatus::Cancelled,
            exit_code: None,
            message: "Check trial cancelled before execution".into(),
        };
    }
    if revision(Path::new(&p.checkout), &p.base, env)
        .await
        .ok()
        .as_deref()
        != Some(&p.revision)
    {
        return TrialResult::failed(
            "The origin base revision changed. Review a new preview before running checks.",
        );
    }
    if Path::new(&p.worktree) != plan.root.join(&p.id)
        || super::settings::checked_path(&plan.root, Path::new(&p.worktree)).is_err()
        || Path::new(&p.worktree).exists()
    {
        return TrialResult::failed("Check trial storage is unsafe or already exists");
    }
    if std::fs::create_dir_all(&plan.root).is_err() {
        return TrialResult::failed("Cannot create check trial storage");
    }
    let added = git(
        Path::new(&p.checkout),
        &[
            "worktree",
            "add",
            "--detach",
            "--",
            &p.worktree,
            &p.revision,
        ],
        env,
        Some(cancel.clone()),
    )
    .await;
    let mut result = match added {
        Ok(out) if out.status.success() => {
            if *cancel.borrow_and_update() {
                TrialResult {
                    status: TrialStatus::Cancelled,
                    exit_code: None,
                    message: "Check trial cancelled during preparation".into(),
                }
            } else {
                run(plan, env, timeout, cancel.clone(), output).await
            }
        }
        _ if *cancel.borrow() => TrialResult {
            status: TrialStatus::Cancelled,
            exit_code: None,
            message: "Check trial cancelled during preparation".into(),
        },
        _ => TrialResult::failed("Cannot prepare a fresh detached worktree for the check trial"),
    };
    if result.status == TrialStatus::Passed {
        let head = git(Path::new(&p.worktree), &["rev-parse", "HEAD"], env, None).await;
        let clean = git(
            Path::new(&p.worktree),
            &["diff", "--quiet", "HEAD", "--"],
            env,
            None,
        )
        .await;
        if !head.is_ok_and(|o| {
            o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == p.revision
        }) || !clean.is_ok_and(|o| o.status.success())
        {
            result = TrialResult::failed("Checks changed tracked source files or the tested revision. This result cannot verify the pinned revision.");
        }
    }
    if Path::new(&p.worktree).exists() {
        let removed = git(
            Path::new(&p.checkout),
            &["worktree", "remove", "--force", "--", &p.worktree],
            env,
            None,
        )
        .await;
        if !removed.is_ok_and(|o| o.status.success()) {
            result.status = TrialStatus::Failed;
            result.message.push_str(" Trial worktree cleanup failed; its displayed path is retained for manual inspection.");
        }
    }
    result
}

#[cfg(test)]
#[path = "check_trial_tests.rs"]
pub(super) mod tests;
