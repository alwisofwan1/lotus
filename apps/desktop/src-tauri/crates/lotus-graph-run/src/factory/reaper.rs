//! Removes Factory worktrees that are done. F2a ticket "reaper" (ac4).

use crate::no_window::NoWindow;
use std::path::Path;
use std::time::{Duration, SystemTime};

use super::{worktree_path, PrState, PullRequests, Sidecar};
use crate::{GraphRunRecord, PrOutcome, RunStore, StoreError};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReapReport {
    pub removed: Vec<String>,
    pub kept: Vec<String>,
    /// Runs whose PR the reaper saw merged or closed, to write onto their records
    /// ([`record_pr_outcome`]). The reaper is the one place that asks GitHub about a finished
    /// run's PR, and it asks once: it removes the worktree it asked for.
    pub ended_prs: Vec<(String, PrOutcome)>,
}

/// Writes how a run's PR ended onto its record. Returns the record when it changed, so the caller
/// can say so; `None` when there is no such record or it already says this.
pub fn record_pr_outcome(store: &dyn RunStore, run_id: &str, outcome: PrOutcome) -> Result<Option<GraphRunRecord>, StoreError> {
    let Some(mut record) = store.get(run_id)? else { return Ok(None) };
    let Some(meta) = record.checkpoint.engine.as_mut() else { return Ok(None) };
    if meta.pr == Some(outcome) {
        return Ok(None);
    }
    meta.pr = Some(outcome);
    store.save(&record)?;
    Ok(Some(record))
}

/// How long a run that ended with no PR keeps its worktree and local branch. Such a run was never
/// pushed (a red Check, an abort), so the worktree is the only copy of the agent's code
/// (decision 3A, 2026-10-06). Measured from the sidecar's last write, i.e. its last attempt.
pub const KEEP_UNPUSHED: Duration = Duration::from_secs(3 * 24 * 3600);

/// [`reap_keeping`] with [`KEEP_UNPUSHED`].
pub async fn reap(root: &Path, prs: &dyn PullRequests, is_live: &(dyn Fn(&str) -> bool + Send + Sync)) -> ReapReport {
    reap_keeping(root, prs, is_live, KEEP_UNPUSHED).await
}

/// Looks at every sidecar under `root`. `is_live(run_id)` is true while the engine still owns
/// the run (running or paused).
///
/// Never removes on doubt: an unreadable sidecar, a `state` error or a failed git command keeps
/// the worktree. Only the LOCAL branch is deleted, never the remote one. A merged or closed PR is
/// removed at once; no PR at all only once the sidecar is older than `keep_unpushed`. While a PR
/// is open, only its newest round's worktree is kept: older rounds (and the run that opened it,
/// once a round exists) are removed.
pub async fn reap_keeping(
    root: &Path,
    prs: &dyn PullRequests,
    is_live: &(dyn Fn(&str) -> bool + Send + Sync),
    keep_unpushed: Duration,
) -> ReapReport {
    let mut report = ReapReport::default();
    let Ok(entries) = std::fs::read_dir(root) else { return report };
    let mut sidecars: Vec<(String, std::path::PathBuf)> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if name.ends_with(".kit") {
            // A turn's kit folder, left by a crash: it holds MCP keys and is remade each turn.
            if !is_live(name.trim_end_matches(".kit")) && !super::execution::retention_required(root, name.trim_end_matches(".kit")) {
                let _ = std::fs::remove_dir_all(&path);
            }
        } else if path.is_dir() {
            dirs.push(name);
        } else if let Some(id) = name.strip_suffix(".json") {
            sidecars.push((id.to_string(), path));
        }
    }
    sidecars.sort();
    dirs.sort();
    let parsed: Vec<Option<Sidecar>> = sidecars.iter().map(|(_, path)| std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok())).collect();
    // Per Factory PR, its newest round (the run that opened it is round 0). Only that one's
    // worktree is kept while the PR is open (ADR-0057).
    let mut newest: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for sidecar in parsed.iter().flatten() {
        let (pr, round) = pr_of(sidecar);
        let best = newest.entry(pr).or_insert(round);
        *best = (*best).max(round);
    }

    for ((run_id, path), sidecar) in sidecars.iter().zip(parsed) {
        let Some(sidecar) = sidecar else {
            report.kept.push(run_id.clone());
            continue;
        };
        if is_live(run_id) {
            report.kept.push(run_id.clone());
            continue;
        }
        let _execution_lease = match super::execution::cleanup_lease(root, run_id) {
            Ok(lease) => lease,
            Err(_) => { report.kept.push(run_id.clone()); continue; }
        };
        let worktree = worktree_path(root, run_id);
        if !worktree.exists() {
            if git(&sidecar.checkout, &["worktree", "prune"]).await {
                let _ = std::fs::remove_file(path);
                report.removed.push(run_id.clone());
            } else {
                report.kept.push(run_id.clone());
            }
            continue;
        }
        let state = prs.state(&sidecar.account, &sidecar.repo, sidecar.pr_branch()).await;
        if matches!(state, Ok(PrState::Missing)) && !older_than(path, keep_unpushed) {
            report.kept.push(run_id.clone());
            continue;
        }
        // How the PR ended is written on the run that opened it, also when a round's worktree saw it.
        let (pr, round) = pr_of(&sidecar);
        match state {
            Ok(PrState::Merged) => report.ended_prs.push((pr.clone(), PrOutcome::Merged)),
            Ok(PrState::Closed) => report.ended_prs.push((pr.clone(), PrOutcome::Closed)),
            _ => {}
        }
        let superseded = newest.get(&pr).is_some_and(|n| *n > round);
        let remove = match state {
            Ok(PrState::Merged | PrState::Closed | PrState::Missing) => true,
            Ok(PrState::Open) => superseded,
            Err(_) => false,
        };
        if remove {
            let wt = worktree.to_string_lossy().to_string();
            let removed = git(&sidecar.checkout, &["worktree", "remove", "--force", &wt]).await;
            if removed {
                git(&sidecar.checkout, &["branch", "-D", &sidecar.branch]).await;
                let _ = std::fs::remove_file(path);
                report.removed.push(run_id.clone());
            } else {
                report.kept.push(run_id.clone());
            }
        } else {
            report.kept.push(run_id.clone());
        }
    }
    // A worktree dir nobody wrote a sidecar for: not ours to judge.
    for dir in dirs {
        if !sidecars.iter().any(|(id, _)| *id == dir) {
            report.kept.push(dir);
        }
    }
    report
}

/// The run that opened the sidecar's Factory PR, and which round the sidecar is (0 = that run).
fn pr_of(sidecar: &Sidecar) -> (String, u32) {
    match &sidecar.round {
        Some(round) => (round.original.clone(), round.round),
        None => (sidecar.graph_run_id.clone(), 0),
    }
}

/// True when `path` was last written more than `age` ago. An unreadable time keeps (false).
fn older_than(path: &Path, age: Duration) -> bool {
    if age.is_zero() {
        return true;
    }
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|elapsed| elapsed > age)
}

async fn git(checkout: &Path, args: &[&str]) -> bool {
    tokio::process::Command::new("git")
        .no_window()
        .arg("-C")
        .arg(checkout)
        .args(args)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}
