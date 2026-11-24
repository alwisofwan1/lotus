use serde_json::{json, Value};

use super::{scoped, RemoteMap};

fn types(events: &[Value]) -> Vec<&str> {
    events.iter().map(|e| e["type"].as_str().unwrap_or("")).collect()
}

fn part(turn: &str, part: Value) -> Value {
    json!({ "kind": "part", "turnId": turn, "part": part })
}

#[test]
fn a_live_turn_streams_into_items_and_keeps_the_composer_request_id() {
    let mut m = RemoteMap::default();
    m.sending("fix it", "crid-1", &[]);
    let mut out = m.update(&json!({ "kind": "turn", "turn": { "turnId": "t1", "startedAt": 1 } }));
    assert!(out.is_empty(), "turn/started waits for the user's text");
    out.extend(m.update(&part("t1", json!({ "id": "u1", "type": "user_message", "text": "fix it" }))));
    out.extend(m.update(&part("t1", json!({ "id": "a1", "type": "assistant_text", "text": "On", "state": "streaming" }))));
    out.extend(m.update(&json!({ "kind": "text", "turnId": "t1", "partId": "a1", "delta": " it.", "seq": 2 })));
    out.extend(m.update(&part("t1", json!({ "id": "a1", "type": "assistant_text", "text": "On it.", "state": "done" }))));
    out.extend(m.update(&part("t1", json!({ "id": "r1", "type": "result", "isError": false, "usage": { "input": 10, "output": 3 } }))));
    out.extend(m.update(&json!({ "kind": "turn", "turn": { "turnId": "t1", "startedAt": 1, "endedAt": 2, "stopReason": "end_turn" } })));

    assert_eq!(types(&out), ["turn/started", "item/started", "item/delta", "item/completed", "turn/completed"]);
    assert_eq!(out[0]["input"], json!({ "text": "fix it", "clientRequestId": "crid-1" }));
    assert_eq!(out[1]["item"]["status"], "running");
    assert_eq!(out[2]["delta"], " it.");
    assert_eq!(out[3]["item"]["text"], "On it.");
    assert_eq!(out[4]["status"], "completed");
    assert_eq!(out[4]["usage"]["inputTokens"], 10);
}

#[test]
fn tool_calls_map_by_acp_kind_and_settle_with_their_output() {
    let mut m = RemoteMap::default();
    let call = |status: &str| {
        part("t1", json!({
            "id": "c1", "type": "tool_call", "toolCallId": "call-1", "toolName": "Bash",
            "title": "ls", "kind": "execute", "status": status, "locations": [],
            "output": { "text": "a.txt", "truncated": false },
        }))
    };
    let mut out = m.update(&call("in_progress"));
    out.extend(m.update(&call("in_progress")));
    out.extend(m.update(&call("completed")));
    out.extend(m.update(&part("t1", json!({
        "id": "e1", "type": "tool_call", "toolCallId": "call-2", "toolName": "Edit", "title": "src/a.rs",
        "kind": "edit", "status": "completed", "locations": [{ "path": "src/a.rs" }],
        "diff": { "files": [{ "path": "src/a.rs", "op": "add" }] }, "parentToolCallId": "call-1",
    }))));
    assert_eq!(types(&out), ["turn/started", "item/started", "item/completed", "item/started", "item/completed"]);
    assert_eq!(out[2]["item"], json!({ "id": "c1", "kind": "command", "command": "ls", "description": null, "output": "a.txt", "status": "completed" }));
    assert_eq!(out[4]["item"]["kind"], "fileChange");
    assert_eq!(out[4]["item"]["change"], "create");
    assert_eq!(out[4]["item"]["parentId"], "c1");
}

#[test]
fn a_permission_is_asked_once_and_resolved_by_its_option_kind() {
    let mut m = RemoteMap::default();
    let perm = |outcome: Value| {
        let mut p = json!({
            "id": "p1", "type": "permission", "requestId": "perm-0", "title": "Bash",
            "options": [{ "key": "1", "label": "Allow once", "kind": "allow_once" }, { "key": "3", "label": "Deny", "kind": "reject_once" }],
        });
        if !outcome.is_null() {
            p["outcome"] = outcome;
        }
        part("t1", p)
    };
    let mut out = m.update(&perm(Value::Null));
    out.extend(m.update(&perm(Value::Null)));
    out.extend(m.update(&perm(json!({ "selected": "3" }))));
    assert_eq!(types(&out), ["turn/started", "interaction/requested", "interaction/resolved"]);
    assert_eq!(out[1]["interaction"]["kind"], "toolPermission");
    assert_eq!(out[2]["decision"], "denied");
}

#[test]
fn a_question_carries_its_options_and_its_answer() {
    let mut m = RemoteMap::default();
    let q = json!({ "question": "Which?", "header": "Lib", "options": [{ "label": "A", "key": "1" }, { "label": "B", "key": "2" }] });
    let mut out = m.update(&part("t1", json!({ "id": "q1", "type": "question", "requestId": "perm-1", "questions": [q] })));
    out.extend(m.update(&part("t1", json!({ "id": "q1", "type": "question", "requestId": "perm-1", "questions": [q], "answered": { "Which?": ["B"] } }))));
    assert_eq!(types(&out), ["turn/started", "interaction/requested", "interaction/resolved"]);
    assert_eq!(out[1]["interaction"]["questions"][0]["options"][1], json!({ "label": "B", "description": null, "key": "2" }));
    assert_eq!(out[2]["answers"], json!({ "Which?": "B" }));
}

#[test]
fn a_reloaded_page_adds_only_what_the_stream_did_not_already_give() {
    let page: Value = serde_json::from_str(include_str!("../../../../../contract/fixtures/rest-conversation-native.json")).unwrap();
    let mut m = RemoteMap::default();
    let first = m.page(&page);
    assert_eq!(first[0]["type"], "turn/started");
    assert!(first[0]["input"]["text"].as_str().unwrap().starts_with("Run exactly"));
    assert!(m.page(&page).is_empty(), "the same page twice draws nothing new");

    // After a restart the map is rebuilt from what was stored: still nothing new.
    let mut rebuilt = RemoteMap::seeded(&first);
    assert!(rebuilt.page(&page).is_empty());
}

#[test]
fn a_turn_the_host_never_closed_is_closed_when_the_next_one_starts() {
    let mut m = RemoteMap::default();
    let mut out = m.update(&part("t1", json!({ "id": "a1", "type": "assistant_text", "text": "x", "state": "streaming" })));
    out.extend(m.update(&part("t2", json!({ "id": "u2", "type": "user_message", "text": "next" }))));
    assert_eq!(types(&out), ["turn/started", "item/started", "item/completed", "turn/completed", "turn/started"]);
    assert_eq!(out[2]["item"]["status"], "interrupted");
    assert_eq!(out[3]["status"], "interrupted");
}

#[test]
fn the_changes_list_sums_the_hosts_line_counts_per_file() {
    let mut m = RemoteMap::default();
    let edit = |id: &str, op: &str, add: u64, del: u64| {
        part("t1", json!({
            "id": id, "type": "tool_call", "toolCallId": id, "toolName": "Edit", "title": "x", "kind": "edit",
            "status": "completed", "locations": [],
            "diff": { "files": [{ "path": "/srv/app/src/a.rs", "op": op, "additions": add, "deletions": del }] },
        }))
    };
    let mut out = m.update(&edit("e1", "add", 10, 0));
    out.extend(m.update(&edit("e2", "modify", 3, 2)));
    let envelopes: Vec<_> = out
        .into_iter()
        .enumerate()
        .map(|(i, event)| super::super::store::Envelope { thread_id: "t".into(), seq: i as u64 + 1, at: 0, event })
        .collect();
    let listed = super::super::changes::remote("/srv/app", &envelopes);
    assert_eq!(listed.files.len(), 1);
    let file = &listed.files[0];
    assert_eq!((file.path.as_str(), file.status, file.added, file.removed), ("src/a.rs", "added", Some(13), Some(2)));
    assert!(listed.branch.is_none());
}

#[test]
fn a_second_cell_numbering_from_t0_again_still_draws_its_turn() {
    let first = |u: Value| scoped("ss-a", &u);
    let second = |u: Value| scoped("ss-b", &u);
    let mut m = RemoteMap::default();
    let mut stored = m.update(&first(part("t-0", json!({ "id": "u-0", "type": "user_message", "text": "hi" }))));
    stored.extend(m.update(&first(json!({ "kind": "turn", "turn": { "turnId": "t-0", "startedAt": 1, "endedAt": 2 } }))));
    let mut m = RemoteMap::seeded(&stored); // the app restarted in between

    let mut out = m.update(&second(part("t-0", json!({ "id": "u-0", "type": "user_message", "text": "Hi" }))));
    out.extend(m.update(&second(part("t-0", json!({ "id": "text-t-0-1", "type": "assistant_text", "text": "Hello", "state": "streaming" })))));
    out.extend(m.update(&second(json!({ "kind": "text", "turnId": "t-0", "partId": "text-t-0-1", "delta": "!" }))));
    assert_eq!(types(&out), ["turn/started", "item/started", "item/delta"]);
    assert_eq!(out[0]["turnId"], "ss-b:t-0");

    let page = scoped("ss-b", &json!({ "turns": [{ "turnId": "t-0", "parts": [{ "id": "u-0" }] }] }));
    assert_eq!(page["turns"][0]["turnId"], "ss-b:t-0");
    assert_eq!(page["turns"][0]["parts"][0]["id"], "ss-b:u-0");
}

#[test]
fn a_sent_message_shows_what_was_attached_as_on_this_mac() {
    let mut m = RemoteMap::default();
    let shot = json!({ "kind": "image", "path": "/Users/me/shot.png", "name": "shot.png", "mimeType": "image/png", "sizeBytes": 3, "remote": "/h/s/t/ab.png" });
    m.sending("", "crid-1", std::slice::from_ref(&shot));
    m.update(&json!({ "kind": "turn", "turn": { "turnId": "t1", "startedAt": 1 } }));
    let out = m.update(&part("t1", json!({ "id": "u1", "type": "user_message", "text": "" })));
    assert_eq!(out[0]["input"]["attachments"], json!([shot]));
    assert_eq!(out[0]["input"]["clientRequestId"], "crid-1");

    // A steer carries them on its item.
    m.sending("and this", "crid-2", std::slice::from_ref(&shot));
    let steer = m.update(&part("t1", json!({ "id": "u2", "type": "user_message", "text": "and this" })));
    assert_eq!(steer[0]["item"]["attachments"], json!([shot]));
}
