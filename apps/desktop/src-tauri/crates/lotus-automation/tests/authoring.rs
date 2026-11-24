//! Automations written by an agent (slice 06, PLAN §2.5): the MCP path.
//! An agent may propose, revise and delete — never switch one on.

use lotus_automation::authoring::{self, Proposal};
use lotus_automation::Store;
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    (dir, store)
}

fn proposal(value: Value) -> Result<Proposal, String> {
    authoring::parse_proposal(value)
}

fn pr_review() -> Value {
    json!({
        "kind": "pr_review",
        "form": {
            "name": "Orbit reviews",
            "account": "alwisofwan1",
            "presetId": "acme",
            "repos": ["initech/*"],
        },
        "slack": { "channels": ["C0123ABC"], "team": "S0TEAM1" },
    })
}

fn morning_brief() -> Value {
    json!({
        "kind": "agent_prompt",
        "form": {
            "prompt": "Summarise the PRs waiting for me",
            "presetId": "acme",
            "days": ["mon", "tue", "wed", "thu", "fri"],
            "time": "09:00",
            "timezone": "Asia/Jakarta",
            "dmSelf": true,
        },
    })
}

#[test]
fn a_proposed_automation_is_saved_switched_off() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();

    let saved = store.get_automation(&created.id).unwrap().unwrap();
    assert!(!saved.enabled, "an agent's automation must wait for the user to turn it on");
    assert_eq!(saved.action.kind, "agent_prompt");
    assert_eq!(saved.trigger.kind, "schedule");
}

#[test]
fn a_pr_review_proposal_carries_its_slack_trigger() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();

    assert!(!created.enabled);
    assert_eq!(created.trigger.kind, "slack");
    assert_eq!(created.trigger.config, json!({ "channels": ["C0123ABC"], "team": "S0TEAM1" }));
}

#[test]
fn a_pr_review_can_watch_github_with_or_without_slack() {
    let mut both = pr_review();
    both["github"] = json!({ "team": "initech/team-orbit" });
    let new = authoring::build(proposal(both).unwrap()).unwrap();
    assert_eq!(new.trigger.kind, "slack");
    assert_eq!(new.trigger.config["sources"], json!({ "github": { "team": "initech/team-orbit" } }));

    let mut only_github = pr_review();
    only_github.as_object_mut().unwrap().remove("slack");
    only_github["github"] = json!({});
    let new = authoring::build(proposal(only_github).unwrap()).unwrap();
    assert_eq!(new.trigger.kind, "manual");
    assert_eq!(new.trigger.config, json!({ "sources": { "github": {} } }));
}

#[test]
fn github_settings_and_the_old_review_team_are_refused_by_name() {
    let mut bad_team = pr_review();
    bad_team["github"] = json!({ "team": "team-orbit" });
    let err = authoring::build(proposal(bad_team).unwrap()).unwrap_err();
    assert!(err.starts_with("github:"), "{err}");

    let mut prompt = morning_brief();
    prompt["github"] = json!({});
    let err = authoring::build(proposal(prompt).unwrap()).unwrap_err();
    assert!(err.starts_with("github:"), "{err}");

    // A GitHub review request no longer gates a review (ADR-0041): the form has no team.
    let mut old = pr_review();
    old["form"]["reviewerTeam"] = json!("initech/team-orbit");
    let err = authoring::build(proposal(old).unwrap()).unwrap_err();
    assert!(err.contains("reviewerTeam"), "{err}");
}

#[test]
fn a_revision_keeps_watching_github_unless_it_says_otherwise() {
    let (_dir, store) = store();
    let mut watching = pr_review();
    watching["github"] = json!({});
    let created = authoring::propose(&store, proposal(watching).unwrap(), 1_000).unwrap();

    // Moving Slack to another channel, or leaving github out, keeps GitHub on.
    let mut moved = pr_review();
    moved["slack"] = json!({ "channels": ["C0NEW"] });
    let kept = authoring::revise(&store, &created.id, proposal(moved).unwrap()).unwrap();
    assert_eq!(kept.trigger.config["channels"], json!(["C0NEW"]));
    assert_eq!(kept.trigger.config["sources"], json!({ "github": {} }));
    let kept = authoring::edit_by_user(&store, &created.id, proposal(pr_review()).unwrap()).unwrap();
    assert_eq!(kept.trigger.config["sources"], json!({ "github": {} }));

    // `false` stops it.
    let mut stop = pr_review();
    stop["github"] = json!(false);
    let stopped = authoring::revise(&store, &created.id, proposal(stop).unwrap()).unwrap();
    assert!(stopped.trigger.config.get("sources").is_none(), "{}", stopped.trigger.config);
}

#[test]
fn a_pr_review_without_slack_is_manual() {
    let mut value = pr_review();
    value.as_object_mut().unwrap().remove("slack");
    let new = authoring::build(proposal(value).unwrap()).unwrap();
    assert_eq!(new.trigger.kind, "manual");
}

#[test]
fn an_agent_cannot_ask_for_an_automation_to_start_switched_on() {
    let mut value = morning_brief();
    value["enabled"] = json!(true);
    let err = proposal(value).unwrap_err();
    assert!(err.contains("enabled"), "{err}");
}

#[test]
fn an_unknown_kind_is_refused_naming_the_kinds_that_exist() {
    let mut value = morning_brief();
    value["kind"] = json!("deploy");
    let err = authoring::build(proposal(value).unwrap()).unwrap_err();
    assert!(err.contains("\"deploy\""), "{err}");
    assert!(err.contains("pr_review") && err.contains("agent_prompt"), "{err}");
}

#[test]
fn an_unknown_form_field_is_refused_by_name() {
    let mut value = morning_brief();
    value["form"]["runAsRoot"] = json!(true);
    let err = authoring::build(proposal(value).unwrap()).unwrap_err();
    assert!(err.starts_with("form:"), "{err}");
    assert!(err.contains("runAsRoot"), "{err}");
}

#[test]
fn a_form_error_names_the_field() {
    let mut value = morning_brief();
    value["form"]["tools"] = json!(["Bash"]);
    let err = authoring::build(proposal(value).unwrap()).unwrap_err();
    assert!(err.starts_with("tools:"), "{err}");
}

#[test]
fn slack_is_refused_for_kinds_that_do_not_listen_to_it() {
    let mut value = morning_brief();
    value["slack"] = json!({ "channels": ["C0123ABC"] });
    let err = authoring::build(proposal(value).unwrap()).unwrap_err();
    assert!(err.starts_with("slack:"), "{err}");
}

#[test]
fn slack_ids_are_checked() {
    let err = authoring::slack_trigger(vec!["#general".into()], None).unwrap_err();
    assert!(err.contains("#general"), "{err}");
    let err = authoring::slack_trigger(vec!["C1".into()], Some("@team-orbit".into())).unwrap_err();
    assert!(err.contains("@team-orbit"), "{err}");
    assert_eq!(authoring::slack_trigger(vec![], None).unwrap().kind, "manual");
}

#[test]
fn revising_an_automation_switches_it_back_off() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    store.set_enabled(&created.id, true).unwrap();

    let mut changed = morning_brief();
    changed["form"]["time"] = json!("10:30");
    let revised = authoring::revise(&store, &created.id, proposal(changed).unwrap()).unwrap();

    assert_eq!(revised.id, created.id);
    assert!(!revised.enabled, "a changed automation needs the user's OK again");
    assert_eq!(revised.trigger.config["cron"], "30 10 * * 1,2,3,4,5");
    assert_eq!(revised.created_at_ms, 1_000);
}

#[test]
fn revising_cannot_change_the_kind() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    let err = authoring::revise(&store, &created.id, proposal(pr_review()).unwrap()).unwrap_err();
    assert!(err.contains("agent_prompt"), "{err}");
}

#[test]
fn revising_an_unknown_automation_says_so() {
    let (_dir, store) = store();
    let err = authoring::revise(&store, "nope", proposal(morning_brief()).unwrap()).unwrap_err();
    assert!(err.contains("nope"), "{err}");
}

#[test]
fn deleting_removes_the_automation_and_its_history() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    store.claim_run(&created.id, "k", 2_000).unwrap();

    assert!(store.delete_automation(&created.id).unwrap());
    assert!(store.get_automation(&created.id).unwrap().is_none());
    assert!(store.list_runs(10).unwrap().is_empty());
    assert!(!store.delete_automation(&created.id).unwrap(), "second delete finds nothing");
}

#[test]
fn turning_a_schedule_on_starts_its_clock_fresh() {
    // Occurrences missed while it was OFF are not the user's to catch up on.
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    store.set_schedule_cursor(&created.id, 5_000).unwrap();

    store.set_enabled(&created.id, true).unwrap();

    assert_eq!(store.schedule_cursor(&created.id).unwrap(), None);
    assert!(store.get_automation(&created.id).unwrap().unwrap().enabled);
}

#[test]
fn switching_an_unknown_automation_says_so() {
    let (_dir, store) = store();
    assert!(store.set_enabled("nope", true).is_err());
}

// ---------- edits made by the user in the panel (redesign) ----------

#[test]
fn a_user_edit_keeps_the_automation_on_and_its_slack_trigger() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();
    store.set_enabled(&created.id, true).unwrap();

    let mut changed = pr_review();
    changed.as_object_mut().unwrap().remove("slack");
    changed["form"]["instructions"] = json!("Focus on SQL.");
    let edited = authoring::edit_by_user(&store, &created.id, proposal(changed).unwrap()).unwrap();

    assert!(edited.enabled, "the user edited it; it stays as they had it");
    assert_eq!(edited.trigger.kind, "slack", "the form has no Slack fields, so the trigger is kept");
    assert_eq!(edited.action.config["instructions"], "Focus on SQL.");
}

#[test]
fn a_user_edit_cannot_change_the_kind() {
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    assert!(authoring::edit_by_user(&store, &created.id, proposal(pr_review()).unwrap()).is_err());
}

#[test]
fn the_prompt_text_is_edited_in_place_for_either_kind() {
    let (_dir, store) = store();
    let brief = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    let review = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();

    let brief = authoring::set_prompt_text(&store, &brief.id, "  New brief  ").unwrap();
    assert_eq!(brief.action.config["prompt"], "New brief");
    let review = authoring::set_prompt_text(&store, &review.id, "Only security.").unwrap();
    assert_eq!(review.action.config["instructions"], "Only security.");

    let err = authoring::set_prompt_text(&store, &brief.id, "   ").unwrap_err();
    assert!(err.starts_with("prompt:"), "{err}");
    // Review instructions are optional.
    assert_eq!(authoring::set_prompt_text(&store, &review.id, "").unwrap().action.config["instructions"], "");
}

#[test]
fn the_next_run_is_the_next_occurrence_and_none_when_off_or_not_scheduled() {
    let (_dir, store) = store();
    let brief = authoring::propose(&store, proposal(morning_brief()).unwrap(), 1_000).unwrap();
    // 2026-09-25 is a Friday; 09:00 Asia/Jakarta = 02:00 UTC.
    let now = 1_790_294_400_000; // 2026-09-25T00:00:00Z
    assert_eq!(lotus_automation::views::next_run_ms(&brief, now), None, "off: nothing is due");
    store.set_enabled(&brief.id, true).unwrap();
    let on = store.get_automation(&brief.id).unwrap().unwrap();
    assert_eq!(lotus_automation::views::next_run_ms(&on, now), Some(now + 2 * 3_600_000));
    let review = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();
    assert_eq!(lotus_automation::views::next_run_ms(&review, now), None);
}

#[test]
fn an_agent_revision_that_names_no_project_keeps_the_one_the_user_picked() {
    // The skill tells the agent it cannot set the project; a revision must not wipe it.
    let (_dir, store) = store();
    let mut brief = morning_brief();
    brief["form"]["workspaceId"] = json!("ws-notes");
    let created = authoring::propose(&store, proposal(brief).unwrap(), 1_000).unwrap();
    let mut review = pr_review();
    review["form"]["workspaceId"] = json!("ws-orbit");
    let review_created = authoring::propose(&store, proposal(review).unwrap(), 1_000).unwrap();

    let mut changed = morning_brief();
    changed["form"]["time"] = json!("10:30");
    let revised = authoring::revise(&store, &created.id, proposal(changed).unwrap()).unwrap();
    let mut changed_review = pr_review();
    changed_review["form"]["instructions"] = json!("Focus on security.");
    let revised_review = authoring::revise(&store, &review_created.id, proposal(changed_review).unwrap()).unwrap();

    assert_eq!(revised.action.config["workspace_id"], "ws-notes");
    assert_eq!(revised_review.action.config["workspace_id"], "ws-orbit");
    assert_eq!(revised_review.action.config["instructions"], "Focus on security.");
}

#[test]
fn an_agent_revision_that_leaves_out_mcp_tools_keeps_them_and_one_that_names_them_wins() {
    let (_dir, store) = store();
    let mut review = pr_review();
    review["form"]["mcpTools"] = json!(["mcp__context7"]);
    let created = authoring::propose(&store, proposal(review).unwrap(), 1_000).unwrap();

    let kept = authoring::revise(&store, &created.id, proposal(pr_review()).unwrap()).unwrap();
    assert_eq!(kept.action.config["mcp_tools"], json!(["mcp__context7"]));

    let mut cleared = pr_review();
    cleared["form"]["mcpTools"] = json!([]);
    let cleared = authoring::revise(&store, &created.id, proposal(cleared).unwrap()).unwrap();
    assert_eq!(cleared.action.config["mcp_tools"], json!([]), "naming the list, even empty, is the agent's choice");
}

#[test]
fn an_agent_revision_that_does_not_mention_the_pane_keeps_the_users_choice() {
    let (_dir, store) = store();
    let mut review = pr_review();
    review["form"]["openPane"] = json!(true);
    let created = authoring::propose(&store, proposal(review).unwrap(), 1_000).unwrap();

    let kept = authoring::revise(&store, &created.id, proposal(pr_review()).unwrap()).unwrap();
    assert_eq!(kept.action.config["open_pane"], json!(true));

    let mut off = pr_review();
    off["form"]["openPane"] = json!(false);
    let off = authoring::revise(&store, &created.id, proposal(off).unwrap()).unwrap();
    assert_eq!(off.action.config["open_pane"], json!(false));
}

#[test]
fn an_agent_revision_of_a_review_that_leaves_out_slack_keeps_where_it_listens() {
    // C14: an update that only changes the instructions must not turn a Slack review into Run-now only.
    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();

    let mut changed = pr_review();
    changed.as_object_mut().unwrap().remove("slack");
    changed["form"]["instructions"] = json!("Focus on security.");
    let kept = authoring::revise(&store, &created.id, proposal(changed).unwrap()).unwrap();
    assert_eq!(kept.trigger.kind, "slack");
    assert_eq!(kept.trigger.config["channels"], json!(["C0123ABC"]));

    let mut manual = pr_review();
    manual["slack"] = json!({ "channels": [] });
    let manual = authoring::revise(&store, &created.id, proposal(manual).unwrap()).unwrap();
    assert_eq!(manual.trigger.kind, "manual", "naming slack, even empty, is the agent's choice");
}

#[test]
fn a_reply_shape_that_cannot_work_is_refused_where_the_instructions_are_saved() {
    let mut bad = pr_review();
    bad["form"]["instructions"] = json!("```slack-reply\n{mention} {verdit}\n```");
    let err = authoring::build(proposal(bad).unwrap()).unwrap_err();
    assert!(err.starts_with("instructions:") && err.contains("{verdit}"), "{err}");

    let (_dir, store) = store();
    let created = authoring::propose(&store, proposal(pr_review()).unwrap(), 1_000).unwrap();
    let err = authoring::set_prompt_text(&store, &created.id, "```slack-reply\n{pr}").unwrap_err();
    assert!(err.contains("closing"), "{err}");
    let good = "Short.\n```slack-reply\n{mention} {verdict} {pr}\n{points}\n```";
    assert!(authoring::set_prompt_text(&store, &created.id, good).is_ok());
}
