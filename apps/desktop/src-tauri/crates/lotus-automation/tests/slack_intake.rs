//! The rules that read a thread reply (ADR-0059), on phrases the team really wrote
//! (`review_feedback` and `runs`, 2026-10).

mod common;

use std::sync::{Arc, Mutex};

use common::{FakeAgent, Reply};
use lotus_automation::agent::Access;
use lotus_automation::slack::intake::{by_rules, AgentClassifier, Intake, IntakeInput, Intent, ReplyClassifier, Source};
use serde_json::json;

fn from(author: &str, text: &str) -> IntakeInput {
    IntakeInput {
        text: text.into(),
        reply_author: author.into(),
        root_requester: Some("UREQ".into()),
        mentions_me: true,
        ..Default::default()
    }
}

fn by_requester(text: &str) -> Option<Intake> {
    by_rules(&from("UREQ", text))
}

fn intent(text: &str) -> Option<Intent> {
    by_requester(text).map(|i| i.intent)
}

#[test]
fn real_asks_to_review_again_are_requests() {
    for text in [
        "Resolved! Please review again <@U0REVIEWER1> -san",
        "Please re-review the fix. Thank you.",
        "the suggestion has been implemented. Please check it, ya.",
        "recheck the fix",
        "Guys <!subteam^S0TEAM>, please check the address review :pray:",
        "I've replied to 6 comments on the PR (2 files): 2 fixed, 4 answered. Ready for re-review",
        "<@U0PEERUSER1> -san <@U0REVIEWER1> -san, I've replied to 6 comments on the PR (2 files): 2 fixed, 4 answered. Ready for another look.",
        "updated, <@U0PEERUSER1> <@U0PEERUSER2> please re-review ya, thank you",
        "tolong dicek lagi ya <@U0REVIEWER1>",
        "mohon cek lagi, sudah diperbaiki",
        "Mas, tolong review ulang ya",
        "sudah difix, minta review lagi",
        "PTAL <@U0REVIEWER1>",
        "<@U0REVIEWER1> 確認お願いします :man-bowing:",
        "Could you take a look for a moment, if you have time? :dogeza:",
        "Hi <https://example.slack.com/admin/user_groups|@team-orbit>, could you please review these PR again after the latest sync with `main`? :pray:",
    ] {
        let got = by_requester(text).unwrap_or_else(|| panic!("rules were unsure about {text:?}"));
        assert_eq!(got.intent, Intent::RereviewRequest, "{text:?}: {got:?}");
        assert!(got.starts_review(), "{text:?}");
    }
}

#[test]
fn a_report_that_everything_is_handled_is_a_request_without_an_ask() {
    for text in [
        "thanks for the reviews :pray: All findings are fixed and replied to on both PRs",
        "I've addressed and resolved all the comments",
        "Thanks <https://github.com/x|@Dery>-san. All points are addressed",
        "sudah diperbaiki semua kak",
    ] {
        let got = by_requester(text).unwrap_or_else(|| panic!("rules were unsure about {text:?}"));
        assert_eq!((got.intent, got.starts_review()), (Intent::RereviewRequest, true), "{text:?}");
    }
}

#[test]
fn reports_of_a_review_a_merge_or_thanks_are_not_requests() {
    for (text, want) in [
        ("Reviewed! LGTM <@U0SLACKUSR2>-san", Intent::ReviewDone),
        ("LGTM <@U0REVIEWER1> :dogeza:", Intent::ReviewDone),
        ("LGMT", Intent::ReviewDone),
        ("I've reviewed all 2 PRs. Details are on each PR", Intent::ReviewDone),
        ("<@U0SLACKUSR3>-san, thanks for the fixes! I re-reviewed #143 and approved it.", Intent::ReviewDone),
        ("I reviewed and approved #529", Intent::ReviewDone),
        ("sudah direview ya, aman", Intent::ReviewDone),
        ("Merged <@U0REVIEWER1>", Intent::MergedOrClosed),
        ("Thank you for the review <!subteam^S0TEAM>, Merged !!!", Intent::MergedOrClosed),
        ("Finally merged <!subteam^S09D7F05NQG>, Thank you", Intent::MergedOrClosed),
        ("Merged, thanks everyone! :dogeza2:", Intent::MergedOrClosed),
        ("Terima kasih, Merged", Intent::MergedOrClosed),
        ("Matur nuwun Mas <@U0PEERUSER2> , merged", Intent::MergedOrClosed),
        ("thank you very much! I'll keep it on all envs and merge the PR :pray:", Intent::MergedOrClosed),
        ("<@U0REVIEWER1> -san, thanks for the re-check :pray:  Done: the message now says it exists", Intent::Thanks),
        ("Thank you <@U0REVIEWER1>-san :pray:", Intent::Thanks),
        ("terima kasih kak", Intent::Thanks),
    ] {
        let got = by_requester(text).unwrap_or_else(|| panic!("rules were unsure about {text:?}"));
        assert_eq!(got.intent, want, "{text:?}: {got:?}");
        assert!(!got.starts_review(), "{text:?}");
    }
}

#[test]
fn an_explicit_ask_beats_a_merge_a_thanks_or_a_review_report() {
    for text in [
        "Thanks for the review! Please review again after I merge main",
        "I've reviewed your comments and fixed them. Ready for re-review",
        "Merge conflict resolved, please check again",
    ] {
        assert_eq!(intent(text), Some(Intent::RereviewRequest), "{text:?}");
    }
}

#[test]
fn someone_who_did_not_ask_is_heard_only_when_they_ask_in_plain_words() {
    // A co-author, or the author of a PR a colleague posted: a plain ask counts.
    for text in ["Resolved! Please review again <@U0REVIEWER1>-san", "Please re-review the fix", "tolong cek lagi ya", "Ready for re-review"] {
        let got = by_rules(&from("UCOAUTHOR", text)).unwrap();
        assert_eq!((got.intent, got.starts_review(), got.confidence), (Intent::RereviewRequest, true, 1.0), "{text:?}");
    }
    // A reviewer reporting, even with "please check it", and anything short of a plain ask, does not.
    for text in [
        "Reviewed! I've feedback on acme-api, please check it <@U0REVIEWER1>-san",
        "I've feedback on: acme-api Please check it <@U0REVIEWER1> :dogeza:",
        "<@U0REVIEWER1>-san, thanks for the fixes! I re-reviewed it and approved it. Please merge when ready",
        "Merged, thanks. Please review the follow-up later",
        "Reviewed! LGTM <@U0REVIEWER1>-san",
        "I addressed both of your points in #1232",
        "All findings are fixed and replied to on both PRs",
        "the second endpoint still behaves differently on staging",
    ] {
        let got = by_rules(&from("UREVIEWER", text)).expect("never left to the model");
        assert_eq!((got.intent, got.starts_review()), (Intent::Discussion, false), "{text:?}");
    }
}

#[test]
fn a_reply_without_a_mention_never_asks() {
    let input = IntakeInput { mentions_me: false, ..from("UREQ", "please re-review") };
    assert_eq!(by_rules(&input).unwrap().intent, Intent::Discussion);
}

#[test]
fn an_unknown_requester_leaves_the_decision_to_the_rules() {
    let input = IntakeInput { root_requester: None, ..from("UANY", "please re-review") };
    assert!(by_rules(&input).unwrap().starts_review());
}

#[test]
fn text_the_rules_cannot_place_is_left_to_the_model() {
    for text in [
        "1. File separate ticket for this 2. This is already in progress",
        "the second endpoint still behaves differently on staging",
        "<@U0REVIEWER1> hmm",
    ] {
        assert!(by_requester(text).is_none(), "{text:?}");
    }
}

#[test]
fn words_are_matched_whole_so_re_reviewed_is_not_re_review() {
    assert_eq!(intent("I re-reviewed both"), Some(Intent::ReviewDone));
    assert_eq!(intent("unresolved yet"), None);
}

fn asked_model(reply: Reply) -> (Arc<FakeAgent>, Result<Intake, String>) {
    let agent = Arc::new(FakeAgent { reply, seen: Mutex::new(vec![]) });
    let input = IntakeInput {
        pr_authors: vec!["teammate".into()],
        root_text: Some("<@UME> please review https://github.com/o/r/pull/1".into()),
        last_lotus_reply: Some("Left 2 comments".into()),
        preset_id: "preset_alwi".into(),
        ..from("UREQ", "the second endpoint still behaves differently on staging")
    };
    let got = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
        .block_on(AgentClassifier::new(agent.clone()).classify(input));
    (agent, got)
}

#[test]
fn the_model_is_asked_sealed_without_tools_with_the_thread_around_the_reply() {
    let reply = json!({ "intent": "rereview_request", "confidence": 0.9, "reason": "the author reports a remaining difference" });
    let (agent, got) = asked_model(Reply::Json(reply));
    let got = got.unwrap();
    assert_eq!((got.intent, got.confidence, got.source), (Intent::RereviewRequest, 0.9, Source::Model));
    assert!(got.starts_review());
    let seen = agent.seen.lock().unwrap();
    let request = &seen[0];
    assert_eq!(request.preset_id, "preset_alwi");
    assert!(request.tools.is_empty());
    assert!(matches!(request.access, Access::Sealed));
    assert!(request.session.is_none() && request.workspace.is_none(), "nothing is kept, no pane");
    for want in ["the second endpoint", "teammate", "please review https://github.com/o/r/pull/1", "Left 2 comments", "asked for the review"] {
        assert!(request.prompt.contains(want), "{want:?} missing from the prompt:\n{}", request.prompt);
    }
    assert_eq!(request.schema["required"], json!(["intent", "confidence", "reason"]));
}

#[test]
fn a_model_reply_off_the_schema_is_an_error_not_a_guess() {
    let (_, got) = asked_model(Reply::Json(json!({ "intent": "maybe", "confidence": 1, "reason": "x" })));
    assert!(got.is_err());
}
