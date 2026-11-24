use serde::Deserialize;
use serde_json::json;

use super::parse_pr_url;
use crate::github::is_account;
use crate::model::{NewAutomation, Spec};

/// The "new PR review automation" form, until automations are created by
/// prompt (slice 06). Also the shape the prompt path will fill.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrReviewForm {
    pub name: String,
    pub account: String,
    pub preset_id: String,
    pub repos: Vec<String>,
    #[serde(default)]
    pub instructions: String,
    /// The folder the review agent works in, e.g. a clone of the repo; `~` is
    /// the home folder. Empty: its own.
    #[serde(default)]
    pub workdir: Option<String>,
    /// The Lotus workspace (project) reviews run in (its checkout of the repo).
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Open a pane to watch each review as it runs. Off: headless.
    #[serde(default)]
    pub open_pane: bool,
    /// MCP tools (`mcp__server__tool`) or servers (`mcp__server`) the review
    /// may use; everything else stays off (ADR-0039). Empty: no MCP.
    #[serde(default)]
    pub mcp_tools: Vec<String>,
    /// The user's skill a review follows (`review` or `plugin:review`). Empty: Lotus's method.
    #[serde(default)]
    pub skill: Option<String>,
    /// Most files a reviewed PR may change. Empty: 300.
    #[serde(default)]
    pub max_files: Option<usize>,
    /// Minutes a headless review may take. Empty: 30.
    #[serde(default)]
    pub timeout_minutes: Option<u64>,
    /// Let a headless review install dependencies and run the PR's tests. Default off.
    #[serde(default)]
    pub run_tests: bool,
    /// Auto mode: post each finished review and its Slack reply without Send. Default off.
    #[serde(default)]
    pub auto_send: bool,
}

/// Highest file limit the form takes: a review that big needs a person, not a bigger number.
pub const MAX_FILES_CEILING: usize = 3_000;
/// Longest a headless review may run.
pub const TIMEOUT_CEILING_MINUTES: u64 = 120;

/// Validates the form and builds a manual-trigger `pr_review` automation
/// with a draft output. Errors name the offending field.
pub fn new_pr_review_automation(form: PrReviewForm) -> Result<NewAutomation, String> {
    let name = form.name.trim();
    if name.is_empty() {
        return Err("name: give the automation a name".into());
    }
    if !is_account(form.account.trim()) {
        return Err(format!("account: {:?} is not a GitHub account name", form.account));
    }
    if form.preset_id.trim().is_empty() {
        return Err("preset: choose a delegation preset".into());
    }
    let repos: Vec<String> = form.repos.iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
    if repos.is_empty() {
        return Err("repos: list at least one owner/name repository".into());
    }
    for repo in &repos {
        let whole_org = repo.strip_suffix("/*").is_some_and(is_account);
        if !whole_org && !is_owner_slash_name(repo) {
            return Err(format!("repos: {repo:?} is not owner/name or owner/*"));
        }
    }
    super::reply_style::ReplyStyle::parse(&form.instructions)?;
    let workdir = crate::session::checked_workdir(form.workdir.as_deref())?;
    let mcp_tools: Vec<String> = form.mcp_tools.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    for tool in &mcp_tools {
        crate::agent::check_mcp_tool(tool).map_err(|e| format!("mcp tools: {e}"))?;
    }
    let skill = form.skill.as_deref().map(super::skill::normalize).filter(|s| !s.is_empty());
    if let Some(skill) = &skill {
        let ok = skill.split(':').count() <= 2
            && skill.split(':').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
            && !skill.contains("..");
        if !ok {
            return Err(format!("skill: {skill:?} is not a skill name like review or plugin:review"));
        }
    }
    if let Some(n) = form.max_files.filter(|n| !(1..=MAX_FILES_CEILING).contains(n)) {
        return Err(format!("max files: {n} is outside 1 to {MAX_FILES_CEILING}"));
    }
    if let Some(m) = form.timeout_minutes.filter(|m| !(1..=TIMEOUT_CEILING_MINUTES).contains(m)) {
        return Err(format!("timeout: {m} minutes is outside 1 to {TIMEOUT_CEILING_MINUTES}"));
    }
    Ok(NewAutomation {
        name: name.to_string(),
        trigger: Spec::new("manual", json!({})),
        action: Spec::new(
            "pr_review",
            json!({
                "account": form.account.trim(),
                "preset_id": form.preset_id.trim(),
                "repos": repos,
                "instructions": form.instructions.trim(),
                "workdir": workdir,
                "workspace_id": form.workspace_id.map(|w| w.trim().to_string()).filter(|w| !w.is_empty()),
                "open_pane": form.open_pane,
                "mcp_tools": mcp_tools,
                "skill": skill,
                "max_files": form.max_files,
                "timeout_minutes": form.timeout_minutes,
                "run_tests": form.run_tests,
                "auto_send": form.auto_send,
            }),
        ),
        outputs: vec![Spec::new("draft", json!({}))],
    })
}

/// `owner/name`, checked with the same rules as a PR URL's repo part.
pub(crate) fn is_owner_slash_name(value: &str) -> bool {
    value.matches('/').count() == 1
        && parse_pr_url(&format!("https://github.com/{value}/pull/1")).is_some_and(|pr| pr.repo == value)
}
