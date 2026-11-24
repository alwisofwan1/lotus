//! GitHub Issues as a ticket source, on the Tauri side (ADR-0048, plans/github-issues-source
//! slice 02). The model is `notion_host.rs`.
//!
//! The reads and the sync rules are in the crate (`lotus_automation::github_issues`); this file
//! keeps each source's last good copy and what the last sync said. Which account and repo a source
//! reads is taken from `~/.claude/settings.json` — never from the caller. There is no token here:
//! every call acts as the source's `gh` account, as the review automation does.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use lotus_automation::github::{Gh, GhCli};
use lotus_automation::github_issues::sync::{put, sync_issues, IssueCopy, IssueSourceHealth, IssueSyncRequest};
use lotus_automation::github_issues::{split_repo, GitHubIssues, Issue, IssueComment, RepoSummary};
use lotus_automation::{Clock, SystemClock};
use serde::Serialize;

use crate::notion_host::{cache_file, write_json};
use crate::{paths, shell_env};

/// A source after a sync: its issues — the last good copy whenever GitHub could not be read — and
/// the state it is in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSourceSync {
    #[serde(flatten)]
    pub copy: IssueCopy,
    pub health: IssueSourceHealth,
}

/// One issue as its panel shows it. `issue` is `None` when the number is gone or is a pull request.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Option<Issue>,
    pub comments: Vec<IssueComment>,
}

pub struct GitHubIssuesHost {
    issues: Arc<dyn GitHubIssues>,
    /// Per source, when GitHub may be asked again after a rate limit. In memory, as Notion's.
    slowed_until: Mutex<HashMap<String, i64>>,
    /// Per source, held while its kept copy is read, changed and written back.
    copy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl GitHubIssuesHost {
    pub fn new() -> Self {
        let cli = GhCli::new(Gh::new("gh").with_base_env(shell_env::user_login_env().clone()));
        Self { issues: Arc::new(cli), slowed_until: Mutex::default(), copy_locks: Mutex::default() }
    }

    /// Syncs one source (PLAN G12): the issues updated since the last sync, or every issue when the
    /// copy is due a full re-read or `full` asks for one (opened, Refresh). A big repo's full read
    /// takes seconds (`cli/cli`: ~21 s); it runs on the async runtime, never on the UI thread.
    pub async fn sync_source(&self, source_id: &str, full: bool) -> Result<IssueSourceSync, String> {
        let source = github_source_settings(source_id)?;
        let path = cache_file(source_id)?;
        let lock = self.copy_lock(source_id);
        let _held = lock.lock().await;
        let mut request = IssueSyncRequest::at(SystemClock.now_ms());
        if full {
            request = request.full();
        }
        if let Some(&retry_at) = self.slowed().get(source_id) {
            request = request.not_before(retry_at);
        }
        let synced = sync_issues(self.issues.as_ref(), &source.account, &source.repo, kept_copy(source_id), request).await;
        match synced.health {
            IssueSourceHealth::SlowedDown { retry_at_ms } => self.slowed().insert(source_id.to_string(), retry_at_ms),
            _ => self.slowed().remove(source_id),
        };
        if synced.asked {
            // One line per sync, for measuring what polling costs.
            eprintln!(
                "[github-issues] sync {source_id}: {} · {} issue(s) · {:?}",
                if synced.full { "full" } else { "incremental" },
                synced.copy.issues.len(),
                synced.health
            );
        }
        if synced.health == IssueSourceHealth::Healthy {
            if let Err(e) = write_json(&path, &synced.copy) {
                // The issues are good; failing to keep a copy only costs the offline view.
                eprintln!("[github-issues] could not keep a copy of {source_id}: {e}");
            }
        }
        Ok(IssueSourceSync { copy: synced.copy, health: synced.health })
    }

    /// One issue and its comments, read when its panel opens (PLAN G18). What was read also goes
    /// into the kept copy, so the list shows it before the next sync.
    pub async fn read_issue(&self, source_id: &str, number: u64) -> Result<IssueDetail, String> {
        let source = github_source_settings(source_id)?;
        let issue = self.issues.issue(&source.account, &source.repo, number).await.map_err(|e| e.message)?;
        let Some(issue) = issue else { return Ok(IssueDetail { issue: None, comments: vec![] }) };
        let comments = self.issues.issue_comments(&source.account, &source.repo, number).await.map_err(|e| e.message)?;
        let lock = self.copy_lock(source_id);
        let _held = lock.lock().await;
        if let (Ok(path), Some(mut copy)) = (cache_file(source_id), kept_copy(source_id)) {
            if copy.issues.iter().any(|i| i.number == number) {
                put(&mut copy, issue.clone());
                if let Err(e) = write_json(&path, &copy) {
                    eprintln!("[github-issues] could not keep a copy of {source_id}: {e}");
                }
            }
        }
        Ok(IssueDetail { issue: Some(issue), comments })
    }

    /// Repos `account` can see, for the repo picker — before any source exists, so the account
    /// comes from the caller. Only accounts gh is logged in to give a token.
    pub async fn repos(&self, account: &str) -> Result<Vec<RepoSummary>, String> {
        self.issues.repos(account).await.map_err(|e| e.message)
    }

    /// Removes a source's kept copy, when the source itself is removed.
    pub fn forget_source(&self, source_id: &str) -> Result<(), String> {
        self.slowed().remove(source_id);
        match std::fs::remove_file(cache_file(source_id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn copy_lock(&self, source_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.copy_locks.lock().unwrap_or_else(|p| p.into_inner()).entry(source_id.to_string()).or_default().clone()
    }

    fn slowed(&self) -> std::sync::MutexGuard<'_, HashMap<String, i64>> {
        self.slowed_until.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn kept_copy(source_id: &str) -> Option<IssueCopy> {
    serde_json::from_str(&std::fs::read_to_string(cache_file(source_id).ok()?).ok()?).ok()
}

/// A GitHub source as `~/.claude/settings.json` keeps it under `ticketSources` (PLAN G16):
/// `{id, kind: "github", account, repo, name}`.
#[derive(Debug, PartialEq, Eq, serde::Deserialize)]
struct GitHubSourceSettings {
    account: String,
    repo: String,
}

fn github_source_settings(source_id: &str) -> Result<GitHubSourceSettings, String> {
    let path = paths::claude_dir().join("settings.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let settings: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    github_source_in(&settings, source_id)
}

fn github_source_in(settings: &serde_json::Value, source_id: &str) -> Result<GitHubSourceSettings, String> {
    let entry = settings["ticketSources"]
        .as_array()
        .and_then(|sources| sources.iter().find(|s| s["kind"] == "github" && s["id"] == source_id))
        .ok_or_else(|| format!("{source_id} is not a GitHub ticket source"))?;
    let source: GitHubSourceSettings = serde_json::from_value(entry.clone()).map_err(|e| format!("{source_id}: {e}"))?;
    if split_repo(&source.repo).is_none() {
        return Err(format!("{source_id}: {:?} is not an owner/name repo", source.repo));
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> serde_json::Value {
        json!({ "ticketSources": [
            { "id": "notion-x", "kind": "notion", "dataSourceId": "d", "mapping": {} },
            { "id": "github-initech-lotus", "kind": "github", "account": "alwisofwan1", "repo": "initech/lotus", "name": "lotus" },
            { "id": "github-bad", "kind": "github", "account": "alwisofwan1", "repo": "initech/../x", "name": "bad" },
        ]})
    }

    #[test]
    fn a_github_source_is_read_from_settings_by_id() {
        let source = github_source_in(&settings(), "github-initech-lotus").unwrap();
        assert_eq!(source, GitHubSourceSettings { account: "alwisofwan1".into(), repo: "initech/lotus".into() });
    }

    #[test]
    fn an_id_that_is_not_a_github_source_is_refused() {
        assert!(github_source_in(&settings(), "notion-x").unwrap_err().contains("not a GitHub ticket source"));
        assert!(github_source_in(&settings(), "github-nope").is_err());
        assert!(github_source_in(&json!({}), "github-initech-lotus").is_err());
    }

    #[test]
    fn a_repo_that_could_leave_its_api_path_is_refused() {
        assert!(github_source_in(&settings(), "github-bad").unwrap_err().contains("not an owner/name repo"));
    }

    #[test]
    fn the_sync_result_carries_the_copy_flat_and_the_health() {
        let sync = IssueSourceSync { copy: IssueCopy::default(), health: IssueSourceHealth::Healthy };
        let v = serde_json::to_value(sync).unwrap();
        assert_eq!(v["health"], json!({ "state": "healthy" }));
        assert!(v["issues"].is_array());
        assert!(v.get("syncedAtMs").is_some());
    }
}
