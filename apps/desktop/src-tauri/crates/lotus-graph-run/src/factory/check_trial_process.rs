//! Bounded pipe capture and process-group ownership for explicitly approved trials.
use crate::no_window::NoWindow;
use super::check_trial::{TrialPlan, TrialResult, TrialStatus};
use super::runner::KillGroup;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::watch,
};

pub(super) async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow() {
            return;
        }
        if cancel.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}
fn collect(
    pipe: impl AsyncRead + Unpin + Send + 'static,
    output: Arc<Mutex<Vec<u8>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut pipe = pipe;
        let mut chunk = [0u8; 4096];
        while let Ok(count) = pipe.read(&mut chunk).await {
            if count == 0 {
                break;
            }
            let mut tail = output.lock().unwrap_or_else(|p| p.into_inner());
            tail.extend_from_slice(&chunk[..count]);
            let remove = tail.len().saturating_sub(16_384);
            tail.drain(..remove);
        }
    })
}
pub(super) async fn run(
    plan: &TrialPlan,
    env: &HashMap<String, String>,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
    output: Arc<Mutex<Vec<u8>>>,
) -> TrialResult {
    let p = &plan.preview;
    let worktree = std::path::Path::new(&p.worktree);
    let program = if p.shell {
        "/bin/sh".into()
    } else {
        worktree.join(&p.command)
    };
    if !p.shell
        && std::fs::canonicalize(&program)
            .ok()
            .filter(|path| path.starts_with(worktree))
            .is_none()
    {
        return TrialResult::failed(
            "The check script must exist inside the tested revision; commit and push it first",
        );
    }
    let mut command = Command::new(program).no_window();
    if p.shell {
        command.arg("-c").arg(&p.command);
    }
    command
        .current_dir(worktree)
        .envs(env)
        .env("CARGO_TARGET_DIR", worktree.join("target"))
        .env("GATES_BASE", format!("origin/{}", p.base))
        .env(
            "MISE_TRUSTED_CONFIG_PATHS",
            super::mise_trusted_paths(
                env.get("MISE_TRUSTED_CONFIG_PATHS").map(String::as_str),
                &plan.root,
            ),
        )
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() { Ok(c) => c, Err(_) => return TrialResult::failed("Cannot start checks. Ensure the required tools and dependencies are available in a fresh worktree") };
    let group = KillGroup(child.id());
    let mut readers = [
        collect(child.stdout.take().expect("piped"), output.clone()),
        collect(child.stderr.take().expect("piped"), output),
    ];
    let result = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => TrialResult { status: TrialStatus::Cancelled, exit_code: None, message: "Checks cancelled. Their process group was stopped.".into() },
        status = child.wait() => match status {
            Ok(code) => TrialResult { status: if code.success() { TrialStatus::Passed } else { TrialStatus::Failed }, exit_code: code.code(), message: if code.success() { "Checks exited successfully on the tested revision.".into() } else { "Checks failed. Inspect the output; missing dependencies are not installed automatically.".into() } },
            Err(_) => TrialResult::failed("Cannot determine check exit status"),
        },
        _ = tokio::time::sleep(timeout) => TrialResult { status: TrialStatus::TimedOut, exit_code: None, message: "Checks reached their time limit and were stopped.".into() },
    };
    group.kill();
    let _ = child.kill().await;
    let _ = child.wait().await;
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        for reader in &mut readers {
            let _ = reader.await;
        }
    })
    .await;
    for reader in readers {
        reader.abort();
    }
    result
}
