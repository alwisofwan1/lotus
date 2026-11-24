//! Smoke test of the GitHub Issues reader against real GitHub (ADR-0048). Read only.
//!
//! ```sh
//! cargo run -p lotus-automation --example list_issues -- <owner/repo> <gh-account> [issue-number]
//! # e.g. ... cli/cli alwisofwan1 1
//! ```
//!
//! Uses the current shell's environment (PATH must find `gh`).

use chrono::{Duration, Utc};
use lotus_automation::github::{Gh, GhCli};
use lotus_automation::github_issues::{GitHubIssues, IssueState, IssueWindow};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(repo), Some(account)) = (args.first(), args.get(1)) else {
        eprintln!("usage: list_issues <owner/repo> <gh-account> [issue-number]");
        std::process::exit(2);
    };
    let cli = GhCli::new(Gh::new("gh").with_base_env(std::env::vars()));
    let now = Utc::now();

    let started = std::time::Instant::now();
    let issues = cli.list_issues(account, repo, IssueWindow::Full, now).await.unwrap_or_else(|e| panic!("{:?}: {e}", e.kind));
    let open = issues.iter().filter(|i| i.state == IssueState::Open).count();
    println!("full read: {} issues ({open} open, {} closed ≤30d) in {:?}", issues.len(), issues.len() - open, started.elapsed());

    let changed = cli.list_issues(account, repo, IssueWindow::ChangedSince(now - Duration::hours(1)), now).await.unwrap();
    println!("changed in the last hour: {}", changed.len());

    let repos = cli.repos(account).await.unwrap();
    println!("repos visible to {account}: {}", repos.len());

    if let Some(n) = args.get(2).and_then(|n| n.parse().ok()) {
        match cli.issue(account, repo, n).await.unwrap() {
            Some(issue) => {
                let comments = cli.issue_comments(account, repo, n).await.unwrap();
                println!("#{n} {:?} {:?} — {} comments read (GitHub says {})", issue.title, issue.state, comments.len(), issue.comments);
            }
            None => println!("#{n} is not an issue (missing or a pull request)"),
        }
    }
}
