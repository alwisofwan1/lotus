//! What the macOS notification says for each way a run ends.

use lotus_automation::{notification_text, RunReport, RunStatus};

fn report(status: RunStatus) -> RunReport {
    RunReport {
        run_id: "r".into(),
        automation_id: "a".into(),
        automation_name: "Morning brief".into(),
        status,
        detail: Some("the agent failed: timeout".into()),
        draft_id: None,
        subject: None,
        paused: false,
        failures_in_a_row: 0,
        quiet: false,
    }
}

#[test]
fn a_pause_says_so_with_the_real_count_and_the_last_error() {
    let r = RunReport { paused: true, failures_in_a_row: 3, ..report(RunStatus::Failed) };
    let (title, body) = notification_text(&r).unwrap();
    assert_eq!(title, "Paused · Morning brief");
    assert_eq!(body, "Failed 3 times in a row, so it is off now. Last error: the agent failed: timeout");

    let r = RunReport { paused: true, failures_in_a_row: 5, ..report(RunStatus::Failed) };
    assert!(notification_text(&r).unwrap().1.starts_with("Failed 5 times"));
}

#[test]
fn a_plain_failure_and_a_skip_name_the_automation() {
    assert_eq!(notification_text(&report(RunStatus::Failed)).unwrap().0, "Failed · Morning brief");
    assert_eq!(notification_text(&report(RunStatus::Skipped)).unwrap().0, "Skipped · Morning brief");
}

#[test]
fn a_draft_and_a_result_read_differently() {
    let draft = RunReport {
        subject: Some("owner/repo#42".into()),
        detail: Some("draft ready: 2 comment(s)".into()),
        ..report(RunStatus::Succeeded)
    };
    assert_eq!(
        notification_text(&draft).unwrap(),
        ("Review draft ready".to_string(), "owner/repo#42: draft ready: 2 comment(s)".to_string())
    );
    let result = RunReport { subject: Some("Morning brief".into()), detail: Some("result sent to your Slack DM".into()), ..report(RunStatus::Succeeded) };
    assert_eq!(notification_text(&result).unwrap(), ("Morning brief".to_string(), "result sent to your Slack DM".to_string()));
}

#[test]
fn nothing_is_shown_for_runs_that_did_not_end_or_left_nothing() {
    assert!(notification_text(&report(RunStatus::Running)).is_none());
    assert!(notification_text(&RunReport { subject: None, ..report(RunStatus::Succeeded) }).is_none());
}

#[test]
fn an_ask_says_it_needs_your_answer_and_shows_the_question() {
    let ask = RunReport {
        subject: Some("Morning brief".into()),
        draft_id: Some("d1".into()),
        detail: Some("asked: Approve these seams?".into()),
        ..report(RunStatus::Asked)
    };
    let (title, body) = notification_text(&ask).unwrap();
    assert_eq!(title, "Needs your answer · Morning brief");
    assert_eq!(body, "Approve these seams? Answer in Lotus.");
}

#[test]
fn an_asks_notification_is_one_short_plain_line() {
    let long = format!("asked: **Approve** these `seams`? {}", "x".repeat(300));
    let ask = RunReport { subject: Some("S".into()), detail: Some(long), ..report(RunStatus::Asked) };
    let (_, body) = notification_text(&ask).unwrap();
    assert!(body.starts_with("Approve these seams? x"), "{body}");
    assert!(body.ends_with("… Answer in Lotus."), "{body}");
    assert!(body.chars().count() <= 140, "{} chars", body.chars().count());
}
