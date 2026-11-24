use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::model::Automation;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// Everything an action needs to do one run's work.
#[derive(Debug, Clone)]
pub struct ActionContext {
    pub automation: Automation,
    pub run_id: String,
    /// What the trigger handed over (e.g. the PR URL and Slack message).
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActionResult {
    Succeeded { detail: Option<String> },
    /// Succeeded and produced a draft for a human to review before anything
    /// is sent. The engine stores it under the automation's action kind.
    /// `delivered`: already handed to its only (self) destination, so it is
    /// kept as a result and does not wait for Send.
    Drafted { subject: String, content: Value, detail: String, delivered: bool },
    /// The work was deliberately not done (not for this user, draft PR, ...).
    Skipped { reason: String },
    /// The agent stopped to ask the user one question (an Automation Ask, PLAN §8). The engine
    /// keeps it as a pending draft of kind `ask`, whatever the action kind, so it waits in the
    /// Inbox; a run ends with an Ask or a result, never both. `choices`: 0–4 plain labels.
    /// `origin`: what the run worked on (a review: its PR), kept with the Ask for its Follow-up Run
    /// to go on with; `null` when the automation alone says it.
    Asked { subject: String, question: String, choices: Vec<String>, origin: Value },
    /// The agent looked and found nothing worth telling the user (PLAN §7 G6). Recorded as a
    /// skipped run with `reason`; nothing is delivered and nobody is notified.
    NothingToReport { reason: String },
    Failed { error: String },
    /// Failed in a way a retry would only repeat — the agent ran in a pane and
    /// did not finish. The engine records it as failed without retrying, so the
    /// user is not handed a second pane.
    FailedFinal { error: String },
}

/// One kind of work an automation can do (`pr_review`, `agent_prompt`, ...).
/// Adding a kind means implementing this trait and registering it; the
/// engine never matches on kind names.
pub trait ActionKind: Send + Sync {
    fn kind(&self) -> &str;
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult>;
    /// Runs that return the same lane run one at a time, in the order they were submitted. A run
    /// waits for its lane before it takes a concurrency slot, so the wait never blocks other work.
    fn lane(&self, _automation: &crate::model::Automation, _payload: &serde_json::Value) -> Option<String> {
        None
    }
}

#[derive(Default, Clone)]
pub struct Registry {
    actions: HashMap<String, Arc<dyn ActionKind>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_action(mut self, action: impl ActionKind + 'static) -> Self {
        self.actions.insert(action.kind().to_string(), Arc::new(action));
        self
    }

    pub(crate) fn action(&self, kind: &str) -> Option<Arc<dyn ActionKind>> {
        self.actions.get(kind).cloned()
    }
}
