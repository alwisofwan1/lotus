use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A registry kind plus its kind-specific configuration. Used for the
/// trigger, the action and each output of an automation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spec {
    pub kind: String,
    pub config: Value,
}

impl Spec {
    pub fn new(kind: impl Into<String>, config: Value) -> Self {
        Self { kind: kind.into(), config }
    }
}

#[derive(Debug, Clone)]
pub struct NewAutomation {
    pub name: String,
    pub trigger: Spec,
    pub action: Spec,
    pub outputs: Vec<Spec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub trigger: Spec,
    pub action: Spec,
    pub outputs: Vec<Spec>,
    pub enabled: bool,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Skipped,
    /// The process stopped while the run was in flight (quit, crash).
    Interrupted,
    /// The agent stopped to ask the user one question; its Automation Ask waits in the Inbox.
    Asked,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Interrupted => "interrupted",
            Self::Asked => "asked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "skipped" => Self::Skipped,
            "interrupted" => Self::Interrupted,
            "asked" => Self::Asked,
            _ => return None,
        })
    }
}

/// One execution of an automation's action for one unit of work, identified
/// by its idempotency key (e.g. `owner/repo#42@<head sha>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub automation_id: String,
    pub idempotency_key: String,
    pub status: RunStatus,
    pub created_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    /// Why the run ended the way it did: an error, a skip reason, a summary.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClaimOutcome {
    Claimed(Run),
    /// This unit of work already has a run; nothing new was created.
    Duplicate { existing_run_id: String },
}

/// The editable, not-yet-sent result of a run. `content` is kind-specific
/// (for `pr_review`: summary, line comments, head SHA).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub id: String,
    pub run_id: String,
    pub automation_id: String,
    pub kind: String,
    /// Human-readable target, e.g. `owner/repo#42`.
    pub subject: String,
    pub content: Value,
    pub created_at_ms: i64,
    pub status: DraftStatus,
    /// Where the sent result lives (the GitHub review URL).
    pub sent_url: Option<String>,
    /// When it was sent. `None` before, and for drafts sent before this was kept.
    #[serde(default)]
    pub sent_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    Pending,
    /// Claimed by one send; nobody else may send it meanwhile.
    Sending,
    Sent,
    Discarded,
}

impl DraftStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Sent => "sent",
            Self::Discarded => "discarded",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "sending" => Self::Sending,
            "sent" => Self::Sent,
            "discarded" => Self::Discarded,
            _ => return None,
        })
    }
}

/// The draft kind an Automation Ask is kept as, whatever action asked it.
pub const ASK_KIND: &str = "ask";

#[derive(Debug, Clone)]
pub struct NewDraft {
    pub run_id: String,
    pub automation_id: String,
    pub kind: String,
    pub subject: String,
    pub content: Value,
}
