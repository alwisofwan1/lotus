//! Editing a Notion ticket's body from Lotus (plans/ticket-sources PLAN S43–S44, task "Ticket
//! Sources 13"): only the changed pieces are sent, as `update_content` search-and-replace; never
//! `replace_content`, which would drop blocks Lotus cannot show. Against a fake Notion.

#[path = "google_fake/mod.rs"]
mod fake;

use fake::{FakeGoogle as FakeNotion, Reply};
use lotus_automation::notion::api::NotionApi;
use lotus_automation::notion::body::{content_updates, has_unknown_blocks, write_body, BodyBlocked, BodyOutcome, BodyRequest};
use lotus_automation::notion::schema::FieldProblem;
use lotus_automation::notion::sync::SourceHealth;
use lotus_automation::notion::token::NotionToken;
use lotus_automation::notion::write::Permission;
use serde_json::json;

const TOKEN: &str = "ntn_4h3RkQ0000000000000000000000000000000000abcd";
const PAGE: &str = "0a1b2c3d-0000-0000-0000-000000000001";

async fn api(replies: Vec<Reply>) -> (FakeNotion, NotionApi) {
    let notion = FakeNotion::start(replies).await;
    let api = NotionApi::new(reqwest::Client::new(), &notion.base, NotionToken::parse(TOKEN).unwrap());
    (notion, api)
}

/// Applies updates the way Notion does: each `old_str` must match exactly once.
fn apply(text: &str, updates: &[(String, String)]) -> String {
    let mut text = text.to_string();
    for (old, new) in updates {
        let at = (0..text.len()).filter(|&i| text.is_char_boundary(i) && text[i..].starts_with(old.as_str())).count();
        assert_eq!(at, 1, "old_str {old:?} must match once (overlaps counted) in {text:?}");
        text = text.replacen(old.as_str(), new, 1);
    }
    text
}

const PAGE_BODY: &str = "## Description\n\nTag every event with its environment.\n\n<callout icon=\"💡\">Staging and production share one endpoint.</callout>\n\n## Done when\n\n- [ ] Staging events are tagged\n- [ ] Production events are tagged\n";

// ── What is sent ────────────────────────────────────────────────────────────

#[test]
fn one_changed_line_is_one_small_update_and_the_rest_is_untouched() {
    let new = PAGE_BODY.replace("with its environment.", "with its environment and region.");
    let updates = content_updates(PAGE_BODY, &new).unwrap();

    assert_eq!(updates.len(), 1);
    assert_eq!(updates[0].0, "Tag every event with its environment.\n", "only the line that changed");
    assert!(!updates[0].0.contains("<callout"), "a block Lotus did not touch is never in an update");
    assert_eq!(apply(PAGE_BODY, &updates), new);
}

#[test]
fn two_edits_far_apart_are_two_updates() {
    let new = PAGE_BODY.replace("## Description", "## What").replace("Production events", "Prod events");
    let updates = content_updates(PAGE_BODY, &new).unwrap();
    assert_eq!(updates.len(), 2);
    assert_eq!(apply(PAGE_BODY, &updates), new);
}

#[test]
fn a_line_that_appears_twice_is_found_by_the_lines_around_it() {
    let body = "## A\n\n- [ ] check\n\n## B\n\n- [ ] check\n";
    let new = "## A\n\n- [ ] check\n\n## B\n\n- [x] check\n";
    let updates = content_updates(body, new).unwrap();
    assert!(updates[0].0.contains("## B"), "grown until it is unique: {:?}", updates[0].0);
    assert_eq!(apply(body, &updates), new);
}

#[test]
fn an_added_line_is_anchored_on_its_neighbour() {
    let new = PAGE_BODY.replace("- [ ] Production events are tagged\n", "- [ ] Production events are tagged\n- [ ] Alerts are quiet\n");
    let updates = content_updates(PAGE_BODY, &new).unwrap();
    assert!(!updates[0].0.is_empty(), "Notion refuses an empty old_str");
    assert_eq!(apply(PAGE_BODY, &updates), new);
}

#[test]
fn a_removed_line_is_one_update() {
    let new = PAGE_BODY.replace("- [ ] Staging events are tagged\n", "");
    let updates = content_updates(PAGE_BODY, &new).unwrap();
    assert_eq!(updates.len(), 1);
    assert_eq!(apply(PAGE_BODY, &updates), new);
}

#[test]
fn nothing_changed_is_no_update() {
    assert!(content_updates(PAGE_BODY, PAGE_BODY).unwrap().is_empty());
}

// ── Writing it ──────────────────────────────────────────────────────────────

fn markdown(text: &str) -> Reply {
    Reply::json(200, json!({ "object": "page_markdown", "id": PAGE, "markdown": text, "truncated": false, "unknown_block_ids": [] }))
}

fn request<'a>(seen: &'a str, new: &'a str, permission: Permission, health: &'a SourceHealth) -> BodyRequest<'a> {
    BodyRequest { page_id: PAGE, permission, health, seen, markdown: new }
}

#[tokio::test]
async fn saving_reads_the_page_first_then_sends_only_update_content() {
    let new = PAGE_BODY.replace("with its environment.", "with its environment and region.");
    let (notion, api) = api(vec![markdown(PAGE_BODY), markdown(&new)]).await;

    let out = write_body(&api, request(PAGE_BODY, &new, Permission::Manage, &SourceHealth::Healthy)).await;

    assert_eq!(out, Ok(BodyOutcome::Saved { markdown: new.clone() }));
    let seen = notion.seen();
    assert_eq!((seen[0].method.as_str(), seen[0].path()), ("GET", format!("/v1/pages/{PAGE}/markdown").as_str()));
    assert_eq!((seen[1].method.as_str(), seen[1].path()), ("PATCH", format!("/v1/pages/{PAGE}/markdown").as_str()));
    assert_eq!(
        seen[1].json(),
        json!({ "type": "update_content", "update_content": { "content_updates": [
            { "old_str": "Tag every event with its environment.\n", "new_str": "Tag every event with its environment and region.\n" }
        ] } })
    );
    assert!(!seen[1].text().contains("replace_content"), "never replace_content");
}

#[tokio::test]
async fn more_than_a_hundred_updates_go_in_requests_of_a_hundred() {
    let old: String = (0..150).map(|i| format!("line {i}\n\n")).collect();
    let new: String = (0..150).map(|i| format!("line {i} edited\n\n")).collect();
    let (notion, api) = api(vec![markdown(&old), markdown("mid"), markdown(&new)]).await;

    let out = write_body(&api, request(&old, &new, Permission::Manage, &SourceHealth::Healthy)).await;

    assert!(matches!(out, Ok(BodyOutcome::Saved { .. })), "{out:?}");
    let patches: Vec<_> = notion.seen().into_iter().filter(|s| s.method == "PATCH").collect();
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0].json()["update_content"]["content_updates"].as_array().unwrap().len(), 100);
    assert_eq!(patches[1].json()["update_content"]["content_updates"].as_array().unwrap().len(), 50);
}

#[tokio::test]
async fn a_body_someone_else_changed_since_it_was_opened_is_refused_without_a_patch() {
    let theirs = PAGE_BODY.replace("## Done when", "## Done when (updated)");
    let (notion, api) = api(vec![markdown(&theirs)]).await;
    let new = PAGE_BODY.replace("with its environment.", "with its region.");

    let out = write_body(&api, request(PAGE_BODY, &new, Permission::Manage, &SourceHealth::Healthy)).await;

    assert_eq!(out, Ok(BodyOutcome::Conflict { fresh: theirs }));
    assert!(notion.seen().iter().all(|s| s.method == "GET"));
}

#[tokio::test]
async fn a_page_with_blocks_lotus_cannot_show_is_never_edited_here() {
    for reply in [
        json!({ "markdown": PAGE_BODY, "truncated": false, "unknown_block_ids": ["b1"] }),
        json!({ "markdown": PAGE_BODY, "truncated": true, "unknown_block_ids": [] }),
    ] {
        let (notion, api) = api(vec![Reply::json(200, reply)]).await;
        let new = PAGE_BODY.replace("with its environment.", "with its region.");

        let out = write_body(&api, request(PAGE_BODY, &new, Permission::Manage, &SourceHealth::Healthy)).await;

        assert_eq!(out, Err(BodyBlocked::NotEditable));
        assert!(notion.seen().iter().all(|s| s.method == "GET"), "no PATCH");
    }
}

/// A bookmark, an embed or a link preview comes back INSIDE the markdown as `<unknown …/>`, with
/// neither `truncated` nor `unknown_block_ids` set (task "Ticket Sources 16"). Such a page is not
/// edited from here either: an edit next to it would carry the tag in `old_str` / `new_str`.
#[tokio::test]
async fn a_page_with_an_inline_unknown_block_is_never_edited_here() {
    let body = format!("{PAGE_BODY}\n<unknown url=\"https://www.notion.so/x#b1\" alt=\"bookmark\"/>\n");
    let (notion, api) = api(vec![markdown(&body)]).await;
    let new = body.replace("with its environment.", "with its region.");

    let out = write_body(&api, request(&body, &new, Permission::Manage, &SourceHealth::Healthy)).await;

    assert_eq!(out, Err(BodyBlocked::NotEditable));
    assert!(notion.seen().iter().all(|s| s.method == "GET"), "no PATCH");
}

/// One table for both sides: the panel (`cleanNotionMarkdown`'s count, `notion-markdown.test.ts`)
/// and this check must agree on every case, or the page offers an edit that Rust then refuses.
#[test]
fn an_unknown_tag_counts_only_outside_code_as_the_frontend_counts_it() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("fixtures/notion-unknown-blocks.json")).unwrap();
    assert!(cases.len() > 10);
    for case in cases {
        let markdown = case["markdown"].as_str().unwrap();
        assert_eq!(has_unknown_blocks(markdown), case["unknown"].as_bool().unwrap(), "{}: {markdown:?}", case["name"]);
    }
}

#[tokio::test]
async fn read_only_and_fields_changed_refuse_before_any_request() {
    let (notion, api) = api(vec![]).await;
    let new = PAGE_BODY.replace("with its environment.", "with its region.");
    let paused = SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("status")] };

    assert_eq!(write_body(&api, request(PAGE_BODY, &new, Permission::ReadOnly, &SourceHealth::Healthy)).await, Err(BodyBlocked::ReadOnly));
    assert_eq!(write_body(&api, request(PAGE_BODY, &new, Permission::Manage, &paused)).await, Err(BodyBlocked::FieldsChanged));
    assert!(notion.seen().is_empty());
}

#[tokio::test]
async fn a_503_is_never_repeated_the_page_says_whether_it_landed() {
    let new = PAGE_BODY.replace("with its environment.", "with its region.");
    let (notion, api) = api(vec![
        markdown(PAGE_BODY),
        Reply::json(503, json!({ "object": "error", "status": 503, "code": "service_unavailable", "message": "The change was saved, but the response could not be built in time." })),
        markdown(&new),
    ])
    .await;

    let out = write_body(&api, request(PAGE_BODY, &new, Permission::Manage, &SourceHealth::Healthy)).await;

    assert_eq!(out, Ok(BodyOutcome::Saved { markdown: new.clone() }));
    assert_eq!(notion.seen().iter().filter(|s| s.method == "PATCH").count(), 1);
}

#[tokio::test]
async fn an_empty_body_is_not_written_from_here() {
    // update_content needs an old_str to find; there is none in an empty page.
    let (notion, api) = api(vec![markdown("")]).await;
    let out = write_body(&api, request("", "First line\n", Permission::Manage, &SourceHealth::Healthy)).await;
    assert_eq!(out, Err(BodyBlocked::Empty));
    assert!(notion.seen().iter().all(|s| s.method == "GET"));
}

#[test]
fn a_piece_inside_a_run_of_identical_lines_matches_exactly_once_counting_overlaps() {
    // "x\nx\n" occurs at two overlapping places in "x\nx\nx\n"; Notion would see it twice.
    let body = "x\nx\nx\ny\n";
    let new = "x\nX\nx\ny\n";
    let updates = content_updates(body, new).unwrap();
    for (old, _) in &updates {
        let at: Vec<_> = (0..body.len()).filter(|&i| body[i..].starts_with(old.as_str())).collect();
        assert_eq!(at.len(), 1, "{old:?} matches at {at:?}");
    }
    assert_eq!(apply(body, &updates), new);
}

#[test]
fn a_very_long_page_rewritten_whole_is_still_one_checked_piece_not_a_huge_table() {
    let old: String = (0..6000).map(|i| format!("old line {i}\n")).collect();
    let new: String = (0..6000).map(|i| format!("new line {i}\n")).collect();
    let started = std::time::Instant::now();
    let updates = content_updates(&old, &new).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    assert_eq!(apply(&old, &updates), new);
}
