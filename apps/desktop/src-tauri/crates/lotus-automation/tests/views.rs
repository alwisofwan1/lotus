mod common;

use std::collections::BTreeSet;

use common::*;
use lotus_automation::pr_review::{new_pr_review_automation, PrReviewForm};
use lotus_automation::views::{AutomationView, DraftView, RunView};
use serde_json::Value;

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().unwrap().keys().cloned().collect()
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn what_the_ui_receives_is_an_explicit_list_of_fields() {
    let w = world(open_pr());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().unwrap();
    let entry = w.store.list_runs(1).unwrap().remove(0);

    let automation = serde_json::to_value(AutomationView::from(&w.automation)).unwrap();
    let run = serde_json::to_value(RunView::from(&entry)).unwrap();
    let draft = serde_json::to_value(DraftView::from(&draft)).unwrap();

    assert_eq!(keys(&automation), set(&["id", "name", "enabled", "triggerKind", "actionKind", "config", "slack", "github", "schedule", "prompt", "createdAtMs", "nextRunMs"]));
    assert_eq!(keys(&automation["config"]), set(&["account", "presetId", "repos", "instructions", "workdir", "workspaceId", "openPane", "mcpTools", "skill", "maxFiles", "timeoutMinutes", "runTests", "autoSend"]));
    assert_eq!(
        keys(&run),
        set(&["id", "automationId", "automationName", "key", "status", "detail", "createdAtMs", "finishedAtMs", "sessionCwd", "failure", "advice"])
    );
    assert_eq!(
        keys(&draft),
        set(&["id", "runId", "automationId", "kind", "subject", "status", "content", "slack", "result", "ask", "sentUrl", "sentAtMs", "slackReply", "slackGroup", "createdAtMs"])
    );
    assert_eq!(
        keys(&draft["content"]),
        set(&["repo", "number", "url", "headSha", "summary", "comments", "droppedComments", "offDiffSeverities", "reply", "previous", "sinceSha"])
    );
    // The world's review has a blocker and no `reply`: the view says what Slack will be told.
    assert_eq!(draft["content"]["reply"]["verdict"], "changes-needed");
    assert_eq!(draft["content"]["reply"]["points"], serde_json::json!(["eval on user input is remote code execution. (L11)"]));
}

fn form() -> PrReviewForm {
    PrReviewForm {
        name: "Review orbit PRs".into(),
        account: "alwisofwan1".into(),
        preset_id: "preset_alwi".into(),
        repos: vec!["initech/orbit-app".into()],
        instructions: "Focus on security.".into(),
        workdir: None,
        workspace_id: None,
        open_pane: false,
        mcp_tools: vec![],
        skill: None,
        max_files: None,
        timeout_minutes: None,
        run_tests: false,
        auto_send: false,
    }
}

#[test]
fn a_valid_form_becomes_a_manual_pr_review_automation_with_a_draft_output() {
    let new = new_pr_review_automation(form()).unwrap();
    assert_eq!(new.trigger.kind, "manual");
    assert_eq!(new.action.kind, "pr_review");
    assert_eq!(new.action.config["repos"], serde_json::json!(["initech/orbit-app"]));
    assert_eq!(new.outputs[0].kind, "draft");
}

#[test]
fn a_form_with_a_bad_field_is_refused_with_the_field_named() {
    let cases: Vec<(&str, PrReviewForm)> = vec![
        ("name", PrReviewForm { name: "  ".into(), ..form() }),
        ("account", PrReviewForm { account: "--hostname=x".into(), ..form() }),
        ("preset", PrReviewForm { preset_id: "".into(), ..form() }),
        ("repos", PrReviewForm { repos: vec![], ..form() }),
        ("repos", PrReviewForm { repos: vec!["https://github.com/a/b".into()], ..form() }),
        ("repos", PrReviewForm { repos: vec!["*/*".into()], ..form() }),
        ("repos", PrReviewForm { repos: vec!["acme/acme-*".into()], ..form() }),
        ("working folder", PrReviewForm { workdir: Some("/no/such/folder/lotus-test".into()), ..form() }),
        ("mcp tools", PrReviewForm { mcp_tools: vec!["Bash".into()], ..form() }),
        ("skill", PrReviewForm { skill: Some("../evil".into()), ..form() }),
        ("skill", PrReviewForm { skill: Some("a b".into()), ..form() }),
        ("max files", PrReviewForm { max_files: Some(0), ..form() }),
        ("max files", PrReviewForm { max_files: Some(3001), ..form() }),
        ("timeout", PrReviewForm { timeout_minutes: Some(121), ..form() }),
    ];
    for (field, f) in cases {
        let err = new_pr_review_automation(f).unwrap_err();
        assert!(err.contains(field), "{field}: {err}");
    }
}

#[test]
fn the_mcp_tools_a_review_may_use_are_saved_and_shown() {
    let new = new_pr_review_automation(PrReviewForm { mcp_tools: vec![" mcp__context7 ".into()], ..form() }).unwrap();
    assert_eq!(new.action.config["mcp_tools"], serde_json::json!(["mcp__context7"]));
    let automation = lotus_automation::Automation {
        id: "a".into(),
        name: new.name,
        trigger: new.trigger,
        action: new.action,
        outputs: new.outputs,
        enabled: false,
        created_at_ms: 1,
    };
    let view = serde_json::to_value(AutomationView::from(&automation)).unwrap();
    assert_eq!(view["config"]["mcpTools"], serde_json::json!(["mcp__context7"]));
}

#[test]
fn a_whole_organization_can_be_watched_with_owner_star() {
    let new = new_pr_review_automation(PrReviewForm { repos: vec!["acme/*".into()], ..form() }).unwrap();
    assert_eq!(new.action.config["repos"], serde_json::json!(["acme/*"]));
}

#[test]
fn a_slack_triggered_automation_and_its_draft_say_where_in_slack_they_listen_and_reply() {
    use lotus_automation::{Draft, DraftStatus, NewAutomation, Spec};
    let automation = lotus_automation::Automation {
        id: "a".into(),
        name: "n".into(),
        trigger: Spec::new("slack", serde_json::json!({ "channels": ["C1"], "team": "S0TEAM" })),
        action: Spec::new("pr_review", serde_json::json!({})),
        outputs: vec![],
        enabled: true,
        created_at_ms: 1,
    };
    let view = serde_json::to_value(AutomationView::from(&automation)).unwrap();
    assert_eq!(view["slack"], serde_json::json!({ "channels": ["C1"], "team": "S0TEAM" }));
    assert_eq!(view["github"], serde_json::Value::Null, "it does not watch GitHub");

    // Watching GitHub too does not hide where it listens in Slack.
    let both = lotus_automation::Automation {
        trigger: Spec::new(
            "slack",
            serde_json::json!({ "channels": ["C1"], "team": null, "sources": { "github": { "team": "o/team" } } }),
        ),
        ..automation.clone()
    };
    let view = serde_json::to_value(AutomationView::from(&both)).unwrap();
    assert_eq!(view["slack"], serde_json::json!({ "channels": ["C1"], "team": null }));
    assert_eq!(view["github"], serde_json::json!({ "team": "o/team" }));

    let draft = Draft {
        id: "d".into(),
        run_id: "r".into(),
        automation_id: "a".into(),
        kind: "pr_review".into(),
        subject: "o/r#1".into(),
        content: serde_json::json!({ "slack": { "channel": "C1", "thread_ts": "1.2", "message_ts": "1.3", "requester": "U1" } }),
        created_at_ms: 1,
        status: DraftStatus::Pending,
        sent_url: None,
        sent_at_ms: None,
    };
    let view = serde_json::to_value(DraftView::from(&draft)).unwrap();
    assert_eq!(view["slack"], serde_json::json!({ "channel": "C1", "threadTs": "1.2", "requester": "U1" }));
    let _ = NewAutomation { name: String::new(), trigger: Spec::new("manual", serde_json::json!({})), action: Spec::new("x", serde_json::json!({})), outputs: vec![] };
}

#[test]
fn a_scheduled_prompt_shows_its_schedule_prompt_and_result() {
    use lotus_automation::agent_prompt::{new_agent_prompt_automation, AgentPromptForm};
    let new = new_agent_prompt_automation(AgentPromptForm {
        name: "".into(),
        prompt: "Summarize my review queue.".into(),
        preset_id: "preset_alwi".into(),
        days: vec!["mon".into(), "fri".into()],
        time: "09:00".into(),
        timezone: "Asia/Jakarta".into(),
        cron: None,
        tools: vec![],
        workdir: None,
        workspace_id: None,
        open_pane: false,
        account: Some("alwisofwan1".into()),
        repos: vec!["acme/*".into()],
        reviewer_team: None,
        include_review_requests: true,
        dm_self: true,
        slack_channel: None,
        google_sheet: None,
        google_drive: None,
    })
    .unwrap();
    assert_eq!(new.name, "Summarize my review queue.", "an empty name becomes the prompt's first line");
    assert_eq!(new.trigger.kind, "schedule");
    assert_eq!(new.trigger.config, serde_json::json!({ "cron": "0 9 * * 1,5", "timezone": "Asia/Jakarta" }));

    let automation = lotus_automation::Automation {
        id: "a".into(),
        name: new.name.clone(),
        trigger: new.trigger.clone(),
        action: new.action.clone(),
        outputs: vec![],
        enabled: true,
        created_at_ms: 1,
    };
    let view = serde_json::to_value(AutomationView::from(&automation)).unwrap();
    assert_eq!(view["schedule"], serde_json::json!({ "cron": "0 9 * * 1,5", "timezone": "Asia/Jakarta" }));
    assert_eq!(view["prompt"]["prompt"], "Summarize my review queue.");
    assert_eq!(view["prompt"]["dmSelf"], true);
}

#[test]
fn a_scheduled_prompt_form_with_a_bad_field_is_refused_with_the_field_named() {
    use lotus_automation::agent_prompt::{new_agent_prompt_automation, AgentPromptForm};
    let form = || AgentPromptForm {
        name: "Brief".into(),
        prompt: "Do it.".into(),
        preset_id: "p".into(),
        days: vec!["mon".into()],
        time: "09:00".into(),
        timezone: "Asia/Jakarta".into(),
        cron: None,
        tools: vec![],
        workdir: None,
        workspace_id: None,
        open_pane: false,
        account: None,
        repos: vec![],
        reviewer_team: None,
        include_review_requests: false,
        dm_self: false,
        slack_channel: None,
        google_sheet: None,
        google_drive: None,
    };
    let cases: Vec<(&str, AgentPromptForm)> = vec![
        ("prompt", AgentPromptForm { prompt: " ".into(), ..form() }),
        ("preset", AgentPromptForm { preset_id: "".into(), ..form() }),
        ("time", AgentPromptForm { time: "9am".into(), ..form() }),
        ("time zone", AgentPromptForm { timezone: "Nowhere/City".into(), ..form() }),
        ("tool", AgentPromptForm { tools: vec!["Bash".into()], ..form() }),
        ("account", AgentPromptForm { include_review_requests: true, ..form() }),
        ("working folder", AgentPromptForm { workdir: Some("notes/vault".into()), ..form() }),
        ("working folder", AgentPromptForm { workdir: Some("/no/such/folder/lotus-test".into()), ..form() }),
    ];
    for (field, f) in cases {
        let err = new_agent_prompt_automation(f).unwrap_err();
        assert!(err.contains(field), "{field}: {err}");
    }
}

#[test]
fn a_working_folder_is_kept_as_a_full_path_with_home_expanded() {
    use lotus_automation::agent_prompt::{new_agent_prompt_automation, AgentPromptForm};
    let home = std::env::var("HOME").unwrap();
    let form = AgentPromptForm {
        name: "".into(),
        prompt: "Write today's note.".into(),
        preset_id: "preset_alwi".into(),
        days: vec!["mon".into()],
        time: "17:00".into(),
        timezone: "Asia/Jakarta".into(),
        cron: None,
        tools: vec![],
        workdir: Some("~".into()),
        workspace_id: None,
        open_pane: false,
        account: None,
        repos: vec![],
        reviewer_team: None,
        include_review_requests: false,
        dm_self: false,
        slack_channel: None,
        google_sheet: None,
        google_drive: None,
    };
    let new = new_agent_prompt_automation(form.clone()).unwrap();
    assert_eq!(new.action.config["workdir"], serde_json::json!(home));
    let none = new_agent_prompt_automation(AgentPromptForm { workdir: Some("  ".into()), ..form }).unwrap();
    assert!(none.action.config["workdir"].is_null());
}

#[test]
fn watching_a_run_in_a_pane_is_a_choice_saved_with_the_automation_and_off_by_default() {
    let off = new_pr_review_automation(form()).unwrap();
    assert_eq!(off.action.config["open_pane"], serde_json::json!(false));
    let on = new_pr_review_automation(PrReviewForm { open_pane: true, ..form() }).unwrap();
    assert_eq!(on.action.config["open_pane"], serde_json::json!(true));

    let saved = lotus_automation::Automation {
        id: "a".into(),
        name: on.name,
        trigger: on.trigger,
        action: on.action,
        outputs: on.outputs,
        enabled: false,
        created_at_ms: 1,
    };
    let view = serde_json::to_value(AutomationView::from(&saved)).unwrap();
    assert_eq!(view["config"]["openPane"], true);
}

#[test]
fn an_ask_shows_its_question_and_choices_and_nothing_else() {
    use lotus_automation::{Draft, DraftStatus};
    let ask = Draft {
        id: "d".into(),
        run_id: "r".into(),
        automation_id: "a".into(),
        kind: "ask".into(),
        subject: "Ticket runner".into(),
        content: serde_json::json!({ "question": "Approve these seams?", "choices": ["Approve", "Reject"], "action_kind": "agent_prompt" }),
        created_at_ms: 1,
        status: DraftStatus::Pending,
        sent_url: None,
        sent_at_ms: None,
    };
    let view = serde_json::to_value(DraftView::from(&ask)).unwrap();
    assert_eq!(
        view["ask"],
        serde_json::json!({ "question": "Approve these seams?", "choices": ["Approve", "Reject"], "actionKind": "agent_prompt", "answer": null, "chain": [], "review": null })
    );
    assert!(view["content"].is_null() && view["result"].is_null());
}

#[test]
fn an_answered_ask_shows_the_answer_and_its_follow_up_run() {
    use lotus_automation::{Draft, DraftStatus};
    let ask = Draft {
        id: "d".into(),
        run_id: "r".into(),
        automation_id: "a".into(),
        kind: "ask".into(),
        subject: "Ticket runner".into(),
        content: serde_json::json!({
            "question": "Approve?", "choices": ["Approve"], "action_kind": "agent_prompt",
            "answer": { "choice": "Approve", "note": "ship it", "answered_at_ms": 9, "follow_up_run_id": "r2" }
        }),
        created_at_ms: 1,
        status: DraftStatus::Sent,
        sent_url: Some("run:r2".into()),
        sent_at_ms: Some(9),
    };
    let view = serde_json::to_value(DraftView::from(&ask)).unwrap();
    assert_eq!(view["ask"]["answer"], serde_json::json!({ "choice": "Approve", "note": "ship it", "answeredAtMs": 9, "followUpRunId": "r2", "failedRunId": null }));
}

#[test]
fn a_review_ask_saved_without_its_pr_names_none() {
    use lotus_automation::{Draft, DraftStatus};
    let ask = Draft {
        id: "d".into(),
        run_id: "r".into(),
        automation_id: "a".into(),
        kind: "ask".into(),
        subject: "o/r#1".into(),
        content: serde_json::json!({ "question": "Which?", "choices": [], "action_kind": "pr_review" }),
        created_at_ms: 1,
        status: DraftStatus::Pending,
        sent_url: None,
        sent_at_ms: None,
    };
    assert!(DraftView::from(&ask).ask.unwrap().review.is_none());
}

#[test]
fn a_review_skill_and_its_limits_are_saved_and_an_empty_skill_means_lotus_method() {
    let new = new_pr_review_automation(PrReviewForm {
        skill: Some(" /mattpocock-skills:code-review ".into()),
        max_files: Some(800),
        timeout_minutes: Some(60),
        ..form()
    })
    .unwrap();
    assert_eq!(new.action.config["skill"], "mattpocock-skills:code-review");
    assert_eq!(new.action.config["max_files"], 800);
    assert_eq!(new.action.config["timeout_minutes"], 60);

    let plain = new_pr_review_automation(PrReviewForm { skill: Some("  ".into()), ..form() }).unwrap();
    assert!(plain.action.config["skill"].is_null());
    assert!(plain.action.config["max_files"].is_null());
}
