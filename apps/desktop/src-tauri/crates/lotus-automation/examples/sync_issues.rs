//! Smoke test of a GitHub Issues source's sync against real GitHub (ADR-0048, slice 02). Read only.
//!
//! ```sh
//! cargo run -p lotus-automation --example sync_issues -- <owner/repo> <gh-account>
//! # e.g. ... cli/cli alwisofwan1
//! ```
//!
//! Syncs the way Tasks does: a first (full) read, a minute-later (incremental) one on that copy,
//! and one that is due a full re-read. Uses the current shell's environment (PATH must find `gh`).

use lotus_automation::github::{Gh, GhCli};
use lotus_automation::github_issues::sync::{sync_issues, IssueSyncRequest, RECONCILE_EVERY_MS};
use lotus_automation::{Clock, SystemClock};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(repo), Some(account)) = (args.first(), args.get(1)) else {
        eprintln!("usage: sync_issues <owner/repo> <gh-account>");
        std::process::exit(2);
    };
    let cli = GhCli::new(Gh::new("gh").with_base_env(std::env::vars()));
    let now = SystemClock.now_ms();

    let report = |what: &str, started: std::time::Instant, out: &lotus_automation::github_issues::sync::IssuesSynced| {
        println!(
            "{what}: {} · {} issue(s) · {:?} · {:?}",
            if out.full { "full" } else { "incremental" },
            out.copy.issues.len(),
            out.health,
            started.elapsed()
        );
    };

    let started = std::time::Instant::now();
    let first = sync_issues(&cli, account, repo, None, IssueSyncRequest::at(now)).await;
    report("first sync", started, &first);

    let started = std::time::Instant::now();
    let next = sync_issues(&cli, account, repo, Some(first.copy.clone()), IssueSyncRequest::at(now + 60_000)).await;
    report("a minute later", started, &next);
    assert_eq!(next.copy.issues.len(), first.copy.issues.len(), "an incremental read keeps every kept issue");

    let started = std::time::Instant::now();
    let due = sync_issues(&cli, account, repo, Some(next.copy), IssueSyncRequest::at(now + RECONCILE_EVERY_MS)).await;
    report("15 minutes later", started, &due);
}
