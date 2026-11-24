use lotus_automation::slack::{ReactionSettings, StatusReactions};
use lotus_automation::RunStatus;

#[test]
fn the_defaults_are_what_lotus_always_showed() {
    let r = StatusReactions::default();
    assert_eq!(r.taken, "eyes");
    assert_eq!(r.queued, "hourglass_flowing_sand");
    assert_eq!(r.skipped, "black_right_pointing_double_triangle_with_vertical_bar");
    assert_eq!((r.running.as_str(), r.done.as_str(), r.failed.as_str(), r.asked.as_str()), ("", "", "", ""));
}

#[test]
fn names_lose_colons_spaces_and_capitals() {
    let r = StatusReactions { done: " :White_Check_Mark: ".into(), ..Default::default() }.normalized().unwrap();
    assert_eq!(r.done, "white_check_mark");
}

#[test]
fn a_skin_tone_name_is_kept() {
    let r = StatusReactions { done: "thumbsup::skin-tone-2".into(), ..Default::default() }.normalized().unwrap();
    assert_eq!(r.done, "thumbsup::skin-tone-2");
}

#[test]
fn taken_cannot_be_empty() {
    let err = StatusReactions { taken: " ".into(), ..Default::default() }.normalized().unwrap_err();
    assert!(err.contains("cannot be empty"), "{err}");
}

#[test]
fn two_states_cannot_share_an_emoji() {
    let err = StatusReactions { running: ":eyes:".into(), ..Default::default() }.normalized().unwrap_err();
    assert!(err.contains("both \"taken\" and \"running\""), "{err}");
}

#[test]
fn a_glyph_or_odd_text_is_not_a_name() {
    assert!(StatusReactions { done: "✅".into(), ..Default::default() }.normalized().is_err());
    assert!(StatusReactions { done: "white check".into(), ..Default::default() }.normalized().is_err());
}

#[test]
fn an_unknown_field_in_saved_json_is_ignored_and_a_missing_one_is_its_default() {
    let r: StatusReactions = serde_json::from_str(r#"{"done":"tada","later":"x"}"#).unwrap();
    assert_eq!((r.done.as_str(), r.taken.as_str()), ("tada", "eyes"));
}

#[test]
fn each_end_has_its_reaction() {
    let r = StatusReactions {
        done: "d".into(),
        failed: "f".into(),
        asked: "a".into(),
        skipped: "s".into(),
        ..Default::default()
    };
    assert_eq!(r.for_finish(RunStatus::Succeeded, false), "d");
    assert_eq!(r.for_finish(RunStatus::Skipped, true), "d", "nothing to report is done, not skipped");
    assert_eq!(r.for_finish(RunStatus::Skipped, false), "s");
    assert_eq!(r.for_finish(RunStatus::Failed, false), "f");
    assert_eq!(r.for_finish(RunStatus::Interrupted, false), "f");
    assert_eq!(r.for_finish(RunStatus::Asked, false), "a");
}

#[test]
fn slack_refusing_a_name_is_kept_until_the_reactions_change() {
    let s = ReactionSettings::default();
    s.note_error("add", "tada2", "invalid_name");
    assert_eq!(s.last_error().as_deref(), Some("Slack does not know :tada2:. Check the name in Slack's emoji picker."));
    s.set(StatusReactions::default());
    assert_eq!(s.last_error(), None);
}

use lotus_automation::pr_review::brief::Verdict;
use lotus_automation::slack::SentReactions;

fn sent(looks_good: &[&str], questions: &[&str], changes_needed: &[&str]) -> StatusReactions {
    let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
    StatusReactions { sent: SentReactions { looks_good: v(looks_good), questions: v(questions), changes_needed: v(changes_needed) }, ..Default::default() }
}

#[test]
fn sent_reactions_are_off_by_default_and_an_old_file_still_reads() {
    let old: StatusReactions = serde_json::from_str(r#"{"taken":"eyes","done":"white_check_mark"}"#).unwrap();
    assert_eq!(old.sent, SentReactions::default());
    for v in Verdict::ALL {
        assert!(StatusReactions::default().for_sent(v).is_empty());
    }
}

#[test]
fn sent_names_are_cleaned_deduplicated_and_blank_ones_dropped() {
    let r = sent(&[":Terima-Kasih:", "terima-kasih", " "], &[], &["eyes", "man-bowing"]).normalized().unwrap();
    assert_eq!(r.sent.looks_good, vec!["terima-kasih"]);
    assert_eq!(r.sent.changes_needed, vec!["eyes", "man-bowing"]);
}

#[test]
fn a_sent_emoji_may_repeat_a_state_emoji() {
    assert!(sent(&["white_check_mark"], &[], &[]).normalized().is_ok(), "done and looks good may share ✅");
}

#[test]
fn a_verdict_takes_at_most_five_and_only_real_names() {
    let err = sent(&["a", "b", "c", "d", "e", "f"], &[], &[]).normalized().unwrap_err();
    assert!(err.contains("at most 5"), "{err}");
    assert!(sent(&[], &["✅"], &[]).normalized().is_err());
}

#[test]
fn for_sent_picks_the_verdicts_list_and_never_adds_the_taken_emoji() {
    let r = sent(&["terima-kasih"], &["thinking_face"], &["eyes", "man-bowing"]).normalized().unwrap();
    assert_eq!(r.for_sent(Verdict::LooksGood), vec!["terima-kasih"]);
    assert_eq!(r.for_sent(Verdict::Questions), vec!["thinking_face"]);
    // 👀 is already on the message; adding it again would read as a new request.
    assert_eq!(r.for_sent(Verdict::ChangesNeeded), vec!["man-bowing"]);
}
