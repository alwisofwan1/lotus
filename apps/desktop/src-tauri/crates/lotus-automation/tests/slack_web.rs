use lotus_automation::slack::web::{parse_channels, parse_history, parse_usergroups, replies_in_order, SlackReply};
use serde_json::{json, Value};

#[test]
fn a_history_page_gives_messages_oldest_first_and_the_next_cursor() {
    let body = json!({
        "ok": true,
        "messages": [
            { "type": "message", "user": "U2", "text": "newer", "ts": "1790000002.000000" },
            { "type": "message", "user": "U1", "text": "older", "ts": "1790000001.000000", "thread_ts": "1790000001.000000" }
        ],
        "has_more": true,
        "response_metadata": { "next_cursor": "dGVhbTpD" }
    });

    let (messages, next) = parse_history(&body.to_string(), "C1").unwrap();

    assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["older", "newer"]);
    assert_eq!(messages[0].channel, "C1");
    assert_eq!(next.as_deref(), Some("dGVhbTpD"));
}

#[test]
fn a_slack_error_is_reported_by_its_code() {
    let err = parse_history(r#"{"ok":false,"error":"missing_scope","needed":"groups:history"}"#, "C1").unwrap_err();
    assert!(err.contains("missing_scope") && err.contains("groups:history"), "{err}");
}

#[test]
fn channels_and_user_groups_are_listed_for_the_pickers() {
    let channels = parse_channels(
        &json!({ "ok": true, "channels": [
            { "id": "C1", "name": "code-review", "is_private": false, "is_member": true },
            { "id": "G2", "name": "orbit-dev", "is_private": true, "is_member": true },
            { "id": "C3", "name": "random", "is_private": false, "is_member": false }
        ]})
        .to_string(),
    )
    .unwrap();
    assert_eq!(channels.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["code-review", "orbit-dev"], "only channels I am in");

    let groups = parse_usergroups(
        &json!({ "ok": true, "usergroups": [{ "id": "S0TEAM", "handle": "team-orbit", "name": "Team Orbit" }] }).to_string(),
    )
    .unwrap();
    assert_eq!((groups[0].id.as_str(), groups[0].handle.as_str()), ("S0TEAM", "team-orbit"));
}

#[test]
fn a_rate_limited_reply_says_how_long_to_wait() {
    assert_eq!(SlackReply::from_status(429, Some("7")), SlackReply::RetryAfter(7));
    assert_eq!(SlackReply::from_status(429, None), SlackReply::RetryAfter(30));
    assert_eq!(SlackReply::from_status(200, None), SlackReply::Body);
}

#[test]
fn thread_replies_come_back_oldest_first_without_the_parent_or_anything_already_read() {
    let body = json!({ "ok": true, "messages": [
        { "type": "message", "user": "U1", "text": "root", "ts": "100.000001", "thread_ts": "100.000001" },
        { "type": "message", "user": "U2", "text": "old", "ts": "150.000001", "thread_ts": "100.000001" },
        { "type": "message", "user": "U2", "text": "b", "ts": "300.000001", "thread_ts": "100.000001" },
        { "type": "message", "user": "U2", "text": "a", "ts": "200.000001", "thread_ts": "100.000001" },
    ]});
    let (page, _) = parse_history(&body.to_string(), "C1").unwrap();
    let texts: Vec<String> =
        replies_in_order(page, "100.000001", "150.000001").into_iter().map(|m| m.text).collect();
    assert_eq!(texts, ["a", "b"]);
}

#[test]
fn a_thread_page_keeps_the_parent_the_current_text_names_and_file_names() {
    use lotus_automation::slack::web::{parse_thread, parse_user_name};
    let body = r#"{"ok":true,"messages":[
        {"type":"message","user":"U1","text":"please review","ts":"1.000100","thread_ts":"1.000100",
         "user_profile":{"display_name":"","real_name":"Rina Putri"}},
        {"type":"message","user":"U2","text":"now fixed","ts":"2.000100","thread_ts":"1.000100",
         "edited":{"user":"U2","ts":"3.000000"},
         "files":[{"name":"trace.log","title":"trace"},{"title":"no name"}]}
    ],"has_more":true,"response_metadata":{"next_cursor":"bmV4dA=="}}"#;
    let (messages, next) = parse_thread(body).unwrap();
    assert_eq!(next.as_deref(), Some("bmV4dA=="));
    assert_eq!(messages.len(), 2, "the parent is kept");
    assert_eq!(messages[0].name.as_deref(), Some("Rina Putri"), "empty display name falls back to real name");
    assert_eq!(messages[1].name, None, "no profile: looked up later");
    assert!(messages[1].edited && !messages[0].edited);
    assert_eq!(messages[1].files, vec!["trace.log", "no name"]);

    let user = r#"{"ok":true,"user":{"id":"U2","real_name":"Budi S","profile":{"display_name":"budi","real_name":"Budi S"}}}"#;
    assert_eq!(parse_user_name(user).unwrap().as_deref(), Some("budi"));
    let err = parse_user_name(r#"{"ok":false,"error":"missing_scope","needed":"users:read"}"#).unwrap_err();
    assert!(err.contains("users:read"), "{err}");
}

// CoS 12: the thread where a Factory PR's link was shared, from `search.messages`.

fn search_match(channel: Value, ts: &str, permalink: &str) -> Value {
    json!({ "channel": channel, "type": "message", "user": "U1", "ts": ts, "text": "<https://github.com/acme/widgets/pull/9>", "permalink": permalink })
}

fn channel(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "is_channel": true, "is_im": false, "is_mpim": false })
}

#[test]
fn the_oldest_share_in_a_channel_is_the_thread_and_a_reply_points_at_its_root() {
    use lotus_automation::slack::web::parse_search_thread;
    let body = json!({ "ok": true, "messages": { "total": 3, "matches": [
        search_match(channel("C2", "eng"), "1700000500.000100", "https://x.slack.com/archives/C2/p1700000500000100"),
        // A reply in a thread: the thread is its root, not the reply.
        search_match(channel("C1", "reviews"), "1700000200.000300", "https://x.slack.com/archives/C1/p1700000200000300?thread_ts=1700000100.000200&cid=C1"),
        // A DM is never the thread: Lotus never writes into someone's DM.
        search_match(json!({ "id": "D1", "name": "U9", "is_im": true }), "1700000000.000100", "https://x.slack.com/archives/D1/p1700000000000100"),
    ]}})
    .to_string();
    let thread = parse_search_thread(&body).unwrap().expect("a thread");
    assert_eq!((thread.channel.as_str(), thread.channel_name.as_str(), thread.ts.as_str()), ("C1", "reviews", "1700000100.000200"));
    assert_eq!(thread.permalink, "https://x.slack.com/archives/C1/p1700000200000300?thread_ts=1700000100.000200&cid=C1");
}

#[test]
fn no_match_or_only_dms_is_no_thread_and_an_error_says_why() {
    use lotus_automation::slack::web::parse_search_thread;
    let none = json!({ "ok": true, "messages": { "total": 0, "matches": [] } }).to_string();
    assert_eq!(parse_search_thread(&none).unwrap(), None);
    let dm = json!({ "ok": true, "messages": { "matches": [
        search_match(json!({ "id": "G1", "name": "mpdm-a--b", "is_mpim": true }), "1.000001", "p")
    ]}})
    .to_string();
    assert_eq!(parse_search_thread(&dm).unwrap(), None);
    let err = parse_search_thread(&json!({ "ok": false, "error": "missing_scope" }).to_string()).unwrap_err();
    assert!(err.contains("missing_scope"), "{err}");
}

#[test]
fn a_bot_share_of_the_link_is_never_the_thread() {
    use lotus_automation::slack::web::parse_search_thread;
    // The GitHub app posts the link first, in its notification channel: a person shared it later.
    let mut by_bot = search_match(channel("C9", "github-notifications"), "1700000000.000100", "https://x.slack.com/archives/C9/p1700000000000100");
    by_bot["bot_id"] = json!("B01GITHUB");
    let mut bot_subtype = search_match(channel("C8", "deploys"), "1700000001.000100", "https://x.slack.com/archives/C8/p1700000001000100");
    bot_subtype["subtype"] = json!("bot_message");
    let by_person = search_match(channel("C1", "reviews"), "1700000300.000100", "https://x.slack.com/archives/C1/p1700000300000100");
    let body = json!({ "ok": true, "messages": { "matches": [by_bot.clone(), bot_subtype, by_person] } }).to_string();
    assert_eq!(parse_search_thread(&body).unwrap().expect("a thread").channel, "C1");
    let only_bot = json!({ "ok": true, "messages": { "matches": [by_bot] } }).to_string();
    assert_eq!(parse_search_thread(&only_bot).unwrap(), None, "never a reply in a bot's channel");
}

#[test]
fn custom_emoji_follow_alias_chains_and_keep_standard_aliases() {
    use lotus_automation::slack::web::parse_emoji;
    let list = parse_emoji(
        &json!({ "ok": true, "emoji": {
            "shipit": "https://emoji.slack-edge.com/T1/shipit/a.png",
            "ship": "alias:shipit",
            "ship2": "alias:ship",
            "thumb": "alias:thumbsup",
            "loop_a": "alias:loop_b",
            "loop_b": "alias:loop_a"
        }})
        .to_string(),
    )
    .unwrap();
    let url = "https://emoji.slack-edge.com/T1/shipit/a.png";
    let by = |n: &str| list.iter().find(|e| e.name == n).cloned();
    assert_eq!(by("ship").unwrap().url.as_deref(), Some(url));
    assert_eq!(by("ship2").unwrap().url.as_deref(), Some(url), "a chain of two");
    let thumb = by("thumb").unwrap();
    assert_eq!((thumb.url, thumb.alias_of.as_deref()), (None, Some("thumbsup")));
    assert!(by("loop_a").is_none() && by("loop_b").is_none(), "a loop is dropped");
    assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["ship", "ship2", "shipit", "thumb"], "sorted");
}

#[test]
fn a_missing_emoji_scope_is_told_apart() {
    use lotus_automation::slack::web::{is_missing_scope, parse_emoji};
    let err = parse_emoji(r#"{"ok":false,"error":"missing_scope","needed":"emoji:read"}"#).unwrap_err();
    assert!(is_missing_scope(&err), "{err}");
    assert!(!is_missing_scope("Slack refused: ratelimited"));
}
