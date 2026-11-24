//! What the UI receives. Every field is listed on purpose: nothing reaches
//! the frontend because a model struct happened to grow a field.

use serde::Serialize;


use crate::github::ReviewComment;
use crate::model::{Automation, Draft, DraftStatus, RunStatus};
use crate::pr_review::PrReviewConfig;
use crate::store::RunEntry;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger_kind: String,
    pub action_kind: String,
    /// `pr_review` config; `null` for kinds the UI does not know yet.
    pub config: Option<PrReviewConfigView>,
    /// Where it listens, when the trigger is `slack`.
    pub slack: Option<SlackTriggerView>,
    /// Whether it watches GitHub's review requests (ADR-0041); `None` when it does not.
    pub github: Option<GitHubSourceView>,
    /// When it runs, when the trigger is `schedule`.
    pub schedule: Option<crate::schedule::Schedule>,
    /// What it asks, when the action is `agent_prompt`.
    pub prompt: Option<AgentPromptView>,
    pub created_at_ms: i64,
    /// When it runs next; `None` when it is off or has no schedule. Filled by
    /// [`AutomationView::at`], since a view built without a clock cannot know.
    pub next_run_ms: Option<i64>,
}

/// The next occurrence of an enabled schedule after `now_ms`.
pub fn next_run_ms(a: &Automation, now_ms: i64) -> Option<i64> {
    if !a.enabled || a.trigger.kind != "schedule" {
        return None;
    }
    let s = serde_json::from_value::<crate::schedule::Schedule>(a.trigger.config.clone()).ok()?;
    crate::schedule::Schedule::parse(&s.cron, &s.timezone).ok()?.next_after(now_ms)
}

impl AutomationView {
    /// The view as of `now_ms`, with its next run.
    pub fn at(a: &Automation, now_ms: i64) -> Self {
        Self { next_run_ms: next_run_ms(a, now_ms), ..Self::from(a) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptView {
    pub prompt: String,
    pub preset_id: String,
    pub account: Option<String>,
    pub repos: Vec<String>,
    pub reviewer_team: Option<String>,
    pub tools: Vec<String>,
    /// The folder the agent works in; `None` = the automation's own.
    pub workdir: Option<String>,
    /// The Lotus workspace runs happen in (its folder); `None` = the automation's own.
    pub workspace_id: Option<String>,
    /// Whether each run opens a pane to watch it.
    pub open_pane: bool,
    pub include_review_requests: bool,
    pub dm_self: bool,
    pub slack_channel: Option<String>,
    pub google_sheet: Option<GoogleSheetView>,
    pub google_drive: Option<GoogleDriveView>,
}

/// An automation's Google Sheet output, for the form.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleSheetView {
    pub spreadsheet_id: String,
    pub tab: String,
    pub columns: Vec<String>,
    pub url: String,
}

/// An automation's Google Drive output; `folderId` `root` is My Drive.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDriveView {
    pub folder_id: String,
    pub format: crate::google::output::DriveFormat,
}

/// The text of an `agent_prompt` result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultView {
    pub text: String,
    /// `sent`, `off`, or why the DM did not go.
    pub dm: String,
    pub channel: Option<String>,
    /// Where the Google Sheet and Drive outputs went; `None` without them.
    pub google: Option<GoogleDeliveryView>,
}

/// An `agent_prompt` result's Google outputs (plans/google-connector G12).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleDeliveryView {
    pub sheet: Option<GoogleOutputView>,
    pub drive: Option<GoogleOutputView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleOutputView {
    /// `sent` | `not_sent`
    pub status: String,
    pub url: Option<String>,
    /// "+3 rows", the file name, or why it did not go.
    pub detail: Option<String>,
    /// The sign-in is gone: connect Google again before sending again.
    pub reconnect: bool,
}

impl GoogleDeliveryView {
    fn of(google: &serde_json::Value) -> Option<Self> {
        let part = |v: &serde_json::Value| {
            v["status"].as_str().map(|status| GoogleOutputView {
                status: status.to_string(),
                url: v["url"].as_str().map(str::to_string),
                detail: v["detail"].as_str().map(str::to_string),
                reconnect: v["reconnect"] == true,
            })
        };
        google.is_object().then(|| Self { sheet: part(&google["sheet"]), drive: part(&google["drive"]) })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSourceView {
    /// `org/slug` of a team whose review requests count too.
    pub team: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackTriggerView {
    pub channels: Vec<String>,
    pub team: Option<String>,
}

/// Where a draft's request came from in Slack, so Send can offer to reply there.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSlackView {
    pub channel: String,
    pub thread_ts: String,
    pub requester: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewConfigView {
    pub account: String,
    pub preset_id: String,
    pub repos: Vec<String>,
    pub instructions: String,
    /// The folder the review agent works in; `None` = the automation's own.
    pub workdir: Option<String>,
    /// The Lotus workspace reviews run in; `None` = the automation's own folder.
    pub workspace_id: Option<String>,
    /// Whether each review opens a pane to watch it run.
    pub open_pane: bool,
    /// MCP tools the review may use (ADR-0039).
    pub mcp_tools: Vec<String>,
    /// The skill a review follows; `None` = Lotus's method.
    pub skill: Option<String>,
    /// The automation's own file limit; `None` = the default (300).
    pub max_files: Option<usize>,
    /// The automation's own headless timeout in minutes; `None` = the default (30).
    pub timeout_minutes: Option<u64>,
    /// A headless review may install dependencies and run the PR's tests.
    pub run_tests: bool,
    /// Auto mode: finished reviews are posted without Send.
    pub auto_send: bool,
}

impl From<&Automation> for AutomationView {
    fn from(a: &Automation) -> Self {
        let config = (a.action.kind == "pr_review")
            .then(|| serde_json::from_value::<PrReviewConfig>(a.action.config.clone()).ok())
            .flatten()
            .map(|c| PrReviewConfigView {
                skill: c.skill_name(),
                account: c.account,
                preset_id: c.preset_id,
                repos: c.repos,
                instructions: c.instructions,
                workdir: c.workdir,
                workspace_id: c.workspace_id,
                open_pane: c.open_pane,
                max_files: c.max_files,
                timeout_minutes: c.timeout_minutes,
                run_tests: c.run_tests,
                auto_send: c.auto_send,
                mcp_tools: c.mcp_tools,
            });
        Self {
            id: a.id.clone(),
            name: a.name.clone(),
            enabled: a.enabled,
            trigger_kind: a.trigger.kind.clone(),
            action_kind: a.action.kind.clone(),
            config,
            slack: (a.trigger.kind == "slack")
                .then(|| serde_json::from_value::<crate::slack::SlackTrigger>(a.trigger.config.clone()).ok())
                .flatten()
                .map(|t| SlackTriggerView { channels: t.channels, team: t.team }),
            github: crate::sources::settings(&a.trigger, crate::sources::GitHubRequests::KEY).map(|s| GitHubSourceView {
                team: s.get("team").and_then(|t| t.as_str()).map(str::to_string),
            }),
            schedule: (a.trigger.kind == "schedule")
                .then(|| serde_json::from_value::<crate::schedule::Schedule>(a.trigger.config.clone()).ok())
                .flatten(),
            prompt: (a.action.kind == "agent_prompt")
                .then(|| serde_json::from_value::<crate::agent_prompt::AgentPromptConfig>(a.action.config.clone()).ok())
                .flatten()
                .map(|c| AgentPromptView {
                    prompt: c.prompt,
                    preset_id: c.preset_id,
                    account: c.account,
                    repos: c.repos,
                    reviewer_team: c.reviewer_team,
                    tools: c.tools,
                    workdir: c.workdir,
                    workspace_id: c.workspace_id,
                    open_pane: c.open_pane,
                    include_review_requests: c.include_review_requests,
                    dm_self: c.dm_self,
                    slack_channel: c.slack_channel,
                    google_sheet: c.google_sheet.map(|s| GoogleSheetView {
                        url: format!("https://docs.google.com/spreadsheets/d/{}/edit", s.spreadsheet_id),
                        spreadsheet_id: s.spreadsheet_id,
                        tab: s.tab,
                        columns: s.columns,
                    }),
                    google_drive: c.google_drive.map(|d| GoogleDriveView { folder_id: d.folder_id, format: d.format }),
                }),
            created_at_ms: a.created_at_ms,
            next_run_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: String,
    pub automation_id: String,
    pub automation_name: String,
    /// The unit of work, e.g. `owner/repo#42@<sha>`.
    pub key: String,
    pub status: RunStatus,
    pub detail: Option<String>,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    /// The folder of the agent session this run kept; `None` when it kept
    /// none, and the row cannot open a pane.
    pub session_cwd: Option<String>,
    /// Why a failed run failed, for the one fix the UI offers; `None` unless it failed.
    pub failure: Option<crate::failure::FailureKind>,
    /// What to do about it, in one sentence; `None` when only `detail` says anything.
    pub advice: Option<&'static str>,
}

impl From<&RunEntry> for RunView {
    fn from(e: &RunEntry) -> Self {
        let failure = (e.run.status == RunStatus::Failed).then(|| crate::failure::classify(e.run.detail.as_deref().unwrap_or_default()));
        Self {
            id: e.run.id.clone(),
            automation_id: e.run.automation_id.clone(),
            automation_name: e.automation_name.clone(),
            key: e.run.idempotency_key.clone(),
            status: e.run.status,
            detail: e.run.detail.clone(),
            created_at_ms: e.run.created_at_ms,
            finished_at_ms: e.run.finished_at_ms,
            session_cwd: e.session.as_ref().map(|s| s.cwd.clone()),
            failure,
            advice: failure.and_then(crate::failure::FailureKind::advice),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftView {
    pub id: String,
    pub run_id: String,
    pub automation_id: String,
    pub kind: String,
    pub subject: String,
    pub status: DraftStatus,
    pub content: Option<PrReviewDraftView>,
    pub slack: Option<DraftSlackView>,
    /// Set for `agent_prompt` results.
    pub result: Option<AgentResultView>,
    /// Set for an Automation Ask (kind `ask`).
    pub ask: Option<AskView>,
    pub sent_url: Option<String>,
    pub sent_at_ms: Option<i64>,
    /// What happened to the Slack reply after Send: `"replied"`, a
    /// `"not replied: …"` reason, or `None` when none was asked for.
    pub slack_reply: Option<String>,
    /// Pending PR reviews that share this draft's Slack thread, itself included (0 when the host
    /// did not count): Send all sends them and posts one reply (ADR-0052 §8).
    pub slack_group: usize,
    pub created_at_ms: i64,
}

/// What an Automation Ask shows: the question, the choice labels, and which action kind asked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskView {
    pub question: String,
    pub choices: Vec<String>,
    pub action_kind: String,
    /// The user's Answer, once given.
    pub answer: Option<AnswerView>,
    /// The earlier questions and answers of this Ask's chain, oldest first (PLAN §8 Q15).
    pub chain: Vec<ChainStepView>,
    /// Set when a review asked: the PR its agent was reading, whose author may have put words in
    /// its mouth (ADR-0040 §6).
    pub review: Option<AskReviewView>,
}

/// The pull request a review's Ask came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskReviewView {
    pub repo: String,
    pub number: u64,
    pub url: String,
}

/// One earlier question of a chain, and how the user answered it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainStepView {
    pub question: String,
    /// The label pressed; `None` when the question offered none and the note is the answer.
    pub choice: Option<String>,
    pub note: String,
}

/// An Automation Answer, and the Follow-up Run it started.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerView {
    pub choice: Option<String>,
    pub note: String,
    pub answered_at_ms: i64,
    pub follow_up_run_id: String,
    /// Set when that Follow-up Run failed: the Ask waits again, to be sent again (PLAN §8 Q14).
    pub failed_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewDraftView {
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub head_sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coverage: Option<crate::pr_review::Coverage>,
    pub summary: String,
    pub comments: Vec<ReviewComment>,
    pub dropped_comments: u64,
    /// The severities of the findings moved off the diff: a suggestion there holds nothing back.
    pub off_diff_severities: Vec<crate::github::Severity>,
    /// What the Slack thread is told after Send, verdict already no kinder than the findings.
    pub reply: crate::pr_review::brief::Brief,
    /// A re-review's earlier findings and how each stands; empty for a first review.
    pub previous: Vec<EarlierFindingView>,
    /// The head the earlier review was of, for a re-review.
    pub since_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarlierFindingView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finding_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replies: Vec<crate::github::ThreadReply>,
    pub path: String,
    pub line: u64,
    pub severity: Option<crate::github::Severity>,
    pub body: String,
    /// `fixed`, `answered` or `not-fixed`.
    pub status: String,
    pub note: Option<String>,
    /// Whether it has a GitHub thread a ✅ can be replied on.
    #[serde(default)]
    pub has_thread: bool,
}

impl From<&Draft> for DraftView {
    fn from(d: &Draft) -> Self {
        let c = &d.content;
        let text = |k: &str| c[k].as_str().unwrap_or_default().to_string();
        let content = (d.kind == "pr_review").then(|| PrReviewDraftView {
            repo: text("repo"),
            number: c["number"].as_u64().unwrap_or_default(),
            url: text("url"),
            head_sha: text("head_sha"),
            coverage: serde_json::from_value(c["coverage"].clone()).ok(),
            summary: text("summary"),
            comments: serde_json::from_value(c["comments"].clone()).unwrap_or_default(),
            dropped_comments: c["dropped_comments"].as_u64().unwrap_or_default(),
            off_diff_severities: serde_json::from_value(c["off_diff_severities"].clone()).unwrap_or_default(),
            reply: crate::pr_review::brief::of_draft(c).0,
            previous: c["previous"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| EarlierFindingView {
                    finding_id: p["finding_id"].as_str().map(str::to_string),
                    replies: serde_json::from_value(p["replies"].clone()).unwrap_or_default(),
                    path: p["path"].as_str().unwrap_or_default().to_string(),
                    line: p["line"].as_u64().unwrap_or_default(),
                    severity: serde_json::from_value(p["severity"].clone()).ok(),
                    body: p["body"].as_str().unwrap_or_default().to_string(),
                    status: p["status"].as_str().unwrap_or_default().to_string(),
                    note: p["note"].as_str().map(str::to_string),
                    has_thread: p["comment_id"].is_u64(),
                })
                .collect(),
            since_sha: c["since_sha"].as_str().map(str::to_string),
        });
        Self {
            id: d.id.clone(),
            run_id: d.run_id.clone(),
            automation_id: d.automation_id.clone(),
            kind: d.kind.clone(),
            subject: d.subject.clone(),
            status: d.status,
            content,
            slack: {
                let s = &d.content["slack"];
                match (s["channel"].as_str(), s["thread_ts"].as_str()) {
                    (Some(channel), Some(thread)) => Some(DraftSlackView {
                        channel: channel.to_string(),
                        thread_ts: thread.to_string(),
                        requester: s["requester"].as_str().map(str::to_string),
                    }),
                    _ => None,
                }
            },
            result: (d.kind == "agent_prompt").then(|| AgentResultView {
                text: c["text"].as_str().unwrap_or_default().to_string(),
                dm: c["dm"].as_str().unwrap_or("off").to_string(),
                channel: c["channel"].as_str().map(str::to_string),
                google: GoogleDeliveryView::of(&c["google"]),
            }),
            ask: (d.kind == crate::model::ASK_KIND).then(|| AskView {
                question: text("question"),
                choices: serde_json::from_value(c["choices"].clone()).unwrap_or_default(),
                action_kind: text("action_kind"),
                answer: c["answer"].is_object().then(|| AnswerView {
                    choice: c["answer"]["choice"].as_str().map(str::to_string),
                    note: c["answer"]["note"].as_str().unwrap_or_default().to_string(),
                    answered_at_ms: c["answer"]["answered_at_ms"].as_i64().unwrap_or_default(),
                    follow_up_run_id: c["answer"]["follow_up_run_id"].as_str().unwrap_or_default().to_string(),
                    failed_run_id: c["answer"]["failed_run_id"].as_str().map(str::to_string),
                }),
                chain: c["chain"]
                    .as_array()
                    .map(|steps| {
                        steps
                            .iter()
                            .map(|step| ChainStepView {
                                question: step["question"].as_str().unwrap_or_default().to_string(),
                                choice: step["choice"].as_str().map(str::to_string),
                                note: step["note"].as_str().unwrap_or_default().to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                // Only with the PR it came from: an Ask saved before origins were kept names none.
                review: match (c["action_kind"].as_str(), c["origin"]["repo"].as_str(), c["origin"]["number"].as_u64()) {
                    (Some("pr_review"), Some(repo), Some(number)) => {
                        let pr = crate::pr_review::PrRef { repo: repo.to_string(), number };
                        Some(AskReviewView { url: pr.url(), repo: pr.repo, number: pr.number })
                    }
                    _ => None,
                },
            }),
            sent_url: d.sent_url.clone(),
            sent_at_ms: d.sent_at_ms,
            slack_reply: c["slack_reply"].as_str().map(str::to_string),
            slack_group: 0,
            created_at_ms: d.created_at_ms,
        }
    }
}
