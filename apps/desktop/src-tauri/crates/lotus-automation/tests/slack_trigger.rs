use lotus_automation::pr_review::PrRef;
use lotus_automation::slack::{decide, decide_reacted, parse_event, Decision, SlackEvent, SlackTrigger};
use serde_json::json;

const ME: &str = "U0REVIEWER1";
const TEAM: &str = "S0TEAM";
const CHANNEL: &str = "C0CHANNEL01";

fn trigger() -> SlackTrigger {
    SlackTrigger { channels: vec![CHANNEL.into()], team: Some(TEAM.into()), sources: None }
}

fn message(text: &str) -> serde_json::Value {
    json!({ "type": "message", "channel": CHANNEL, "user": "U0SLACKUSR1", "text": text, "ts": "1790243979.339269" })
}

const TWO_PRS: &str = "<https://github.com/acme/acme-web/pull/1> <https://github.com/acme/acme-api/pull/2>";

#[test]
fn a_request_that_mentions_me_starts_one_review_per_pull_request() {
    let event = parse_event(&message(&format!("<@{ME}> please review {TWO_PRS}")));
    let Decision::Review(request) = decide(&event, &trigger(), ME) else { panic!("{event:?}") };

    assert_eq!(
        request.pull_requests,
        vec![
            PrRef { repo: "acme/acme-web".into(), number: 1 },
            PrRef { repo: "acme/acme-api".into(), number: 2 }
        ]
    );
    assert_eq!(request.requester.as_deref(), Some("U0SLACKUSR1"));
    assert_eq!(request.channel, CHANNEL);
    assert_eq!(request.thread_ts, "1790243979.339269", "a top-level message is its own thread root");
}

#[test]
fn a_request_to_my_team_counts_too() {
    let event = parse_event(&message(&format!("<!subteam^{TEAM}|@team-orbit> {TWO_PRS}")));
    assert!(matches!(decide(&event, &trigger(), ME), Decision::Review(_)));
}

#[test]
fn a_reply_in_a_thread_answers_in_that_same_thread() {
    let mut raw = message(&format!("<@{ME}> {TWO_PRS}"));
    raw["thread_ts"] = json!("1789090098.198639");
    let Decision::Review(request) = decide(&parse_event(&raw), &trigger(), ME) else { panic!() };
    assert_eq!(request.thread_ts, "1789090098.198639");
}

#[test]
fn messages_that_are_not_review_requests_for_me_are_ignored_with_a_reason() {
    let mut bot = message(&format!("<@{ME}> {TWO_PRS}"));
    bot["subtype"] = json!("bot_message");
    let mut edited = message(&format!("<@{ME}> {TWO_PRS}"));
    edited["subtype"] = json!("message_changed");
    let mut elsewhere = message(&format!("<@{ME}> {TWO_PRS}"));
    elsewhere["channel"] = json!("C0OTHER");
    let mut mine = message(&format!("<@{ME}> {TWO_PRS}"));
    mine["user"] = json!(ME);

    let cases = [
        ("bot", bot),
        ("changed", edited),
        ("not watched", elsewhere),
        ("your own", mine),
        ("no pull request", message(&format!("<@{ME}> lunch?"))),
        ("not mention", message(TWO_PRS)),
        ("not mention", message(&format!("<@U0SOMEONE> {TWO_PRS}"))),
    ];
    for (why, raw) in cases {
        match decide(&parse_event(&raw), &trigger(), ME) {
            Decision::Ignore(reason) => assert!(reason.contains(why), "{why:?} not in {reason:?}"),
            other => panic!("{why}: expected Ignore, got {other:?}"),
        }
    }
}

#[test]
fn my_eyes_reaction_asks_to_look_up_that_message_and_others_are_ignored() {
    let reaction = |user: &str, name: &str| {
        json!({ "type": "reaction_added", "user": user, "reaction": name,
                "item": { "type": "message", "channel": CHANNEL, "ts": "1789464001.495699" } })
    };

    assert_eq!(
        decide(&parse_event(&reaction(ME, "eyes")), &trigger(), ME),
        Decision::LookUp { channel: CHANNEL.into(), ts: "1789464001.495699".into() }
    );
    assert!(matches!(decide(&parse_event(&reaction("U0SOMEONE", "eyes")), &trigger(), ME), Decision::Ignore(_)));
    assert!(matches!(decide(&parse_event(&reaction(ME, "thumbsup")), &trigger(), ME), Decision::Ignore(_)));
}

#[test]
fn a_message_i_reacted_to_is_reviewed_without_needing_a_mention() {
    let SlackEvent::Message(reacted) = parse_event(&message(TWO_PRS)) else { panic!() };
    let Decision::Review(request) = decide_reacted(&reacted, &trigger(), ME) else { panic!() };
    assert_eq!(request.pull_requests.len(), 2);
}

#[test]
fn unknown_events_are_ignored() {
    let event = parse_event(&json!({ "type": "channel_created", "channel": { "id": "C1" } }));
    assert!(matches!(decide(&event, &trigger(), ME), Decision::Ignore(_)));
}
