//! Automations written by an agent through Lotus's MCP tools (PLAN §2.5).
//!
//! An agent may propose, revise and delete automations. It can never switch
//! one on: whatever it writes is saved OFF, and only the user turns it on in
//! the Automation panel (slice 06, decision "Off + Turn on"). There is no
//! field for it to ask otherwise — `enabled` is an unknown field here.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_prompt::{new_agent_prompt_automation, AgentPromptForm};
use crate::model::{Automation, NewAutomation, Spec};
use crate::pr_review::{new_pr_review_automation, PrReviewForm};
use crate::sources::{self, GitHubRequests};
use crate::store::Store;

/// The action kinds an agent can write, in the order the guide lists them.
pub const KINDS: &[&str] = &["pr_review", "agent_prompt"];

/// One automation as an agent describes it: a kind, that kind's form (the
/// same shape the panel's form fills), and — for `pr_review` — where it is
/// asked for reviews: in Slack, and on GitHub.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Proposal {
    pub kind: String,
    pub form: Value,
    #[serde(default)]
    pub slack: Option<SlackInput>,
    /// `pr_review` only: watch GitHub's review requests (`{ "team"?: "org/slug" }`), or stop
    /// (`false`). Left out: a new automation does not, a revision keeps what it had.
    #[serde(default)]
    pub github: Option<Value>,
}

/// Slack ids, not names: the agent looks them up with the `options` action.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlackInput {
    pub channels: Vec<String>,
    /// A Slack user group id (`S…`), e.g. the one behind `@team-orbit`.
    #[serde(default)]
    pub team: Option<String>,
}

pub fn parse_proposal(value: Value) -> Result<Proposal, String> {
    serde_json::from_value(value).map_err(|e| format!("automation: {e}"))
}

/// Validates a proposal into an automation. Errors start with the field at
/// fault (`kind:`, `form:`, `slack:`, or a form field such as `tools:`).
pub fn build(proposal: Proposal) -> Result<NewAutomation, String> {
    build_over(proposal, None)
}

/// [`build`], for a revision of `existing`: a review keeps where it is asked
/// for reviews unless the proposal says.
fn build_over(proposal: Proposal, existing: Option<&Spec>) -> Result<NewAutomation, String> {
    let Proposal { kind, form, slack, github } = proposal;
    match kind.as_str() {
        "pr_review" => {
            let form: PrReviewForm = serde_json::from_value(form).map_err(|e| format!("form: {e}"))?;
            let mut new = new_pr_review_automation(form)?;
            new.trigger = review_trigger(slack, github, existing)?;
            Ok(new)
        }
        "agent_prompt" => {
            if slack.is_some() {
                return Err("slack: only pr_review listens to Slack; agent_prompt runs on its schedule".into());
            }
            if github.is_some() {
                return Err("github: only pr_review watches GitHub's review requests; agent_prompt runs on its schedule".into());
            }
            let form: AgentPromptForm = serde_json::from_value(form).map_err(|e| format!("form: {e}"))?;
            new_agent_prompt_automation(form)
        }
        other => Err(format!("kind: {other:?} is not an automation kind; use one of {}", KINDS.join(", "))),
    }
}

/// The trigger for a PR review that listens in `channels`; none → manual
/// (Run now only). `team` is a Slack user group id whose mention also counts.
pub fn slack_trigger(channels: Vec<String>, team: Option<String>) -> Result<Spec, String> {
    let valid = |id: &str| !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric());
    if let Some(bad) = channels.iter().find(|c| !valid(c)) {
        return Err(format!("slack: {bad:?} is not a Slack channel id"));
    }
    let team = team.filter(|t| !t.is_empty());
    if let Some(t) = team.as_deref().filter(|t| !valid(t)) {
        return Err(format!("slack: {t:?} is not a Slack user group id"));
    }
    Ok(if channels.is_empty() {
        Spec::new("manual", json!({}))
    } else {
        Spec::new("slack", json!({ "channels": channels, "team": team }))
    })
}

/// Where a review is asked for: Slack as `slack` says (else as it was, else nowhere), and
/// GitHub as `github` says (else as it was).
fn review_trigger(slack: Option<SlackInput>, github: Option<Value>, existing: Option<&Spec>) -> Result<Spec, String> {
    let trigger = match (slack, existing) {
        (Some(slack), existing) => {
            let new = slack_trigger(slack.channels, slack.team)?;
            existing.map_or(new.clone(), |old| sources::keep_sources(new, old))
        }
        (None, Some(old)) => old.clone(),
        (None, None) => Spec::new("manual", json!({})),
    };
    match github {
        None => Ok(trigger),
        Some(Value::Bool(false)) => sources::with_source(&trigger, GitHubRequests::KEY, None),
        Some(settings) => {
            GitHubRequests::check_settings(&settings)?;
            sources::with_source(&trigger, GitHubRequests::KEY, Some(settings))
        }
    }
}

/// Saves the proposal switched OFF.
pub fn propose(store: &Store, proposal: Proposal, now_ms: i64) -> Result<Automation, String> {
    let new = build(proposal)?;
    store.create_automation_off(new, now_ms).map_err(|e| e.to_string())
}

/// Replaces automation `id` with the proposal, which must be of the same
/// kind, and switches it OFF until the user turns it on again.
pub fn revise(store: &Store, id: &str, proposal: Proposal) -> Result<Automation, String> {
    let existing = store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))?;
    if proposal.kind != existing.action.kind {
        return Err(format!(
            "kind: {id:?} is a {} automation; delete it and propose a new one to change its kind",
            existing.action.kind
        ));
    }
    let names_mcp_tools = proposal.form.get("mcpTools").is_some();
    let names_pane = proposal.form.get("openPane").is_some();
    let named: Vec<&str> = ["skill", "maxFiles", "timeoutMinutes"].into_iter().filter(|f| proposal.form.get(*f).is_some()).collect();
    // A review revision that leaves out `slack` or `github` keeps it; `slack` with no channels clears it.
    let mut new = build_over(proposal, Some(&existing.trigger))?;
    // A revision that names no project keeps the one the automation has.
    let keep = |field: &str, new: &mut NewAutomation| {
        if let Some(old) = existing.action.config.get(field).filter(|v| !v.is_null()) {
            new.action.config[field] = old.clone();
        }
    };
    if new.action.config["workspace_id"].is_null() {
        keep("workspace_id", &mut new);
    }
    // Nor does a revision that leaves out a review's MCP tools clear them; naming them, even empty, does.
    if !names_mcp_tools {
        keep("mcp_tools", &mut new);
    }
    // Nor whether its runs open a pane.
    if !names_pane {
        keep("open_pane", &mut new);
    }
    // Nor its skill and limits.
    for (field, config) in [("skill", "skill"), ("maxFiles", "max_files"), ("timeoutMinutes", "timeout_minutes")] {
        if !named.contains(&field) {
            keep(config, &mut new);
        }
    }
    store.replace_automation_off(id, new).map_err(|e| e.to_string())?;
    store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))
}

/// The user's own edit from the panel: same kind, and it stays on or off as
/// it was. A `pr_review` form carries no Slack fields, so without `slack`
/// the automation keeps the trigger it has.
pub fn edit_by_user(store: &Store, id: &str, proposal: Proposal) -> Result<Automation, String> {
    let existing = store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))?;
    if proposal.kind != existing.action.kind {
        return Err(format!("kind: {id:?} is a {} automation and stays one", existing.action.kind));
    }
    let new = build_over(proposal, Some(&existing.trigger))?;
    store.replace_definition(id, new).map_err(|e| e.to_string())?;
    store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))
}

/// Changes which agent runs it: a preset id, optionally with the model, effort and account on top
/// (`agent::parse_agent_ref`). Applies from the next run.
pub fn set_agent(store: &Store, id: &str, reference: &str) -> Result<Automation, String> {
    let mut automation =
        store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))?;
    let reference = reference.trim();
    let (preset, _) = crate::agent::parse_agent_ref(reference)?;
    if preset.trim().is_empty() {
        return Err("agent: choose an agent".into());
    }
    match automation.action.kind.as_str() {
        "agent_prompt" | "pr_review" => {}
        other => return Err(format!("kind: {other} runs no agent")),
    }
    automation.action.config["preset_id"] = Value::String(reference.to_string());
    let new = NewAutomation {
        name: automation.name.clone(),
        trigger: automation.trigger.clone(),
        action: automation.action.clone(),
        outputs: automation.outputs.clone(),
    };
    store.replace_definition(id, new).map_err(|e| e.to_string())?;
    Ok(automation)
}

/// Edits only the words: an `agent_prompt`'s prompt (required) or a
/// `pr_review`'s instructions (optional).
pub fn set_prompt_text(store: &Store, id: &str, text: &str) -> Result<Automation, String> {
    let mut automation =
        store.get_automation(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("id: no automation {id:?}"))?;
    let text = text.trim();
    let field = match automation.action.kind.as_str() {
        "agent_prompt" if text.is_empty() => return Err("prompt: write what the agent should do".into()),
        "agent_prompt" => "prompt",
        "pr_review" => {
            crate::pr_review::reply_style::ReplyStyle::parse(text)?;
            "instructions"
        }
        other => return Err(format!("kind: {other} has no prompt to edit")),
    };
    automation.action.config[field] = Value::String(text.to_string());
    let new = NewAutomation {
        name: automation.name.clone(),
        trigger: automation.trigger.clone(),
        action: automation.action.clone(),
        outputs: automation.outputs.clone(),
    };
    store.replace_definition(id, new).map_err(|e| e.to_string())?;
    Ok(automation)
}
